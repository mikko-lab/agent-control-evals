/**
 * Runs cases through an adapter and compares against precomputed oracle
 * expectations. Order of operations per run:
 *   1. oracle integrity: every case's stored `expected` must equal what the
 *      oracle derives from the scenario alone (before any SUT call);
 *   2. adapter hello: protocol version + SUT commit must match the lock;
 *   3. cases are sent WITHOUT `expected`, one at a time;
 *   4. results are validated structurally, then compared.
 * Any adapter/protocol/harness failure is recorded as an error and makes the
 * run invalid; it is never converted into a DENY/REJECT/WITHHOLD.
 */
import { canonicalJson } from "../util/canonical-json";
import { deriveExpected } from "../oracle/expected";
import type { Case, CaseForAdapter } from "../corpus/types";
import type { CaseResult, HelloResponse } from "../adapter/protocol";
import { AdapterClient, HarnessError, type AdapterCommand } from "./client";
import { compareCase, type CaseVerdict } from "./compare";

export interface ErrorRecord {
  case_id: string | null;
  kind: "adapter_error" | "harness_error" | "protocol_error";
  message: string;
  /** adapter_error only: tool executions the adapter observed before failing (never discarded). */
  observed_executions?: number;
}

export interface RunOutput {
  hello: HelloResponse | null;
  verdicts: CaseVerdict[];
  adapter_errors: ErrorRecord[];
  harness_errors: ErrorRecord[];
  results: CaseResult[];
}

export function checkOracleIntegrity(cases: Case[]): ErrorRecord[] {
  const errors: ErrorRecord[] = [];
  for (const c of cases) {
    try {
      const o = deriveExpected(c.scenario);
      const same =
        canonicalJson(o.assertions) === canonicalJson(c.expected.assertions) &&
        canonicalJson(o.invariants.executions) === canonicalJson(c.expected.invariants.executions) &&
        canonicalJson(o.unordered_steps) === canonicalJson(c.expected.unordered_steps ?? []);
      if (!same) errors.push({ case_id: c.case_id, kind: "harness_error", message: "stored expected differs from oracle derivation" });
    } catch (e) {
      errors.push({ case_id: c.case_id, kind: "harness_error", message: `oracle error: ${(e as Error).message}` });
    }
  }
  return errors;
}

export function forAdapter(c: Case): CaseForAdapter {
  const { expected: _expected, ...rest } = c;
  return rest;
}

export async function runCases(
  cases: Case[],
  cmd: AdapterCommand,
  expectedSutCommit: string,
  opts: { timeoutMs?: number; expectCleanWorktree?: boolean } = {},
): Promise<RunOutput> {
  const out: RunOutput = { hello: null, verdicts: [], adapter_errors: [], harness_errors: [], results: [] };
  out.harness_errors.push(...checkOracleIntegrity(cases));
  if (out.harness_errors.length > 0) return out;
  const client = new AdapterClient(cmd, opts.timeoutMs ?? 60_000);
  try {
    out.hello = await client.hello();
    if (out.hello.sut.commit !== expectedSutCommit) {
      out.harness_errors.push({ case_id: null, kind: "harness_error", message: `adapter loaded SUT ${out.hello.sut.commit}, expected ${expectedSutCommit}` });
      return out;
    }
    const wantClean = opts.expectCleanWorktree ?? true;
    if (out.hello.sut.worktree_clean !== wantClean) {
      out.harness_errors.push({ case_id: null, kind: "harness_error", message: `adapter SUT worktree_clean=${out.hello.sut.worktree_clean}, expected ${wantClean}` });
      return out;
    }
    for (const c of cases) {
      let r: CaseResult;
      try {
        r = await client.runCase(forAdapter(c));
      } catch (e) {
        const err = e as Error;
        out.harness_errors.push({ case_id: c.case_id, kind: err.name === "ProtocolError" ? "protocol_error" : "harness_error", message: err.message });
        break; // the adapter channel is no longer trustworthy
      }
      out.results.push(r);
      if (r.status === "adapter_error") {
        const partial = (r.raw_sut_evidence as { partial?: { executions?: Record<string, number>; unattributed_executions?: number } | null } | null)?.partial;
        const observed = partial ? Object.values(partial.executions ?? {}).reduce((a, b) => a + b, 0) + (partial.unattributed_executions ?? 0) : undefined;
        out.adapter_errors.push({ case_id: c.case_id, kind: "adapter_error", message: r.error?.message ?? "", ...(observed !== undefined ? { observed_executions: observed } : {}) });
        continue;
      }
      out.verdicts.push(compareCase(c, r.observations!));
    }
  } catch (e) {
    const err = e as Error;
    out.harness_errors.push({ case_id: null, kind: err instanceof HarnessError ? "harness_error" : "protocol_error", message: err.message });
  } finally {
    await client.close();
  }
  return out;
}
