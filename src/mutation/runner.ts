/**
 * Mutation sensitivity runner.
 *
 * A mutant is KILLED only if there is at least one witness case such that:
 *  1. the baseline ran the case technically validly (status ok);
 *  2. the baseline satisfied the case's primary outcome assertion AND the
 *     baseline's observed primary reason is one of the mutant's
 *     exposed_reason_classes (the baseline blocked it through the mutated
 *     control);
 *  3. the mutant ran the same case technically validly (status ok, protocol ok);
 *  4. the mutant violated the primary outcome assertion or an authority
 *     invariant (a reason-only change does not count).
 * Patch/build/startup/protocol failures make the mutant INVALID, never killed.
 */
import type { Case } from "../corpus/types";
import { INTEGRITY_CATEGORIES, type IntegrityCategory } from "../eval/integrity";
import type { RunOutput } from "../eval/run";
import { runCases } from "../eval/run";
import type { CaseVerdict } from "../eval/compare";
import type { SutLock } from "../sut/lock";
import { disposeEnv, prepareMutant, type PrepareOptions } from "../sut/environment";
import { patchPath, type MutantSpec } from "./manifest";

export type MutantStatus = "killed" | "survived" | "invalid";

export interface MutantResult {
  mutation_id: string;
  family: string;
  evaluation_boundary: "runtime" | "component";
  status: MutantStatus;
  invalid_reason: string | null;
  witness_candidates: number;
  baseline_valid_witness_candidates: number;
  witness_case_ids: string[];
  witness_count: number;
  mutant_adapter_errors: number;
  mutant_harness_errors: number;
  /** Outcome/invariant mismatches the mutant caused per boundary across the whole evaluated corpus (collateral evidence). */
  outcome_mismatches_by_boundary: { runtime: number; component: number };
  /** Component mutants only: true if any runtime case changed outcome (would contradict the runtime-unreachability claim). */
  boundary_violation: boolean;
  /** Descriptive: scenarios of the mutant run per decision/effect integrity category (not a kill criterion). */
  integrity_scenarios: Record<IntegrityCategory, number>;
}

const verdictMap = (r: RunOutput) => new Map<string, CaseVerdict>(r.verdicts.map((v) => [v.case_id, v]));

export function isWitnessCandidate(c: Case, m: MutantSpec): boolean {
  return (
    m.witness_families.includes(c.family) &&
    c.evaluation_boundary === m.evaluation_boundary &&
    c.expected.adversarial &&
    (c.expected.acceptable_reason_classes ?? []).some((r) => m.exposed_reason_classes.includes(r))
  );
}

function primaryOk(v: CaseVerdict): boolean {
  return v.checks.filter((c) => c.primary).every((c) => c.outcome_match) && v.checks.some((c) => c.primary);
}

function safetyViolation(v: CaseVerdict): boolean {
  return !primaryOk(v) || v.mismatches.some((m) => m.kind === "invariant_violation");
}

export function zeroIntegrity(): Record<IntegrityCategory, number> {
  return Object.fromEntries(INTEGRITY_CATEGORIES.map((c) => [c, 0])) as Record<IntegrityCategory, number>;
}

function integrityCounts(r: RunOutput) {
  const c = zeroIntegrity();
  for (const v of r.verdicts) for (const k of INTEGRITY_CATEGORIES) if (v.integrity.categories[k]) c[k]++;
  return c;
}

export function judgeMutant(m: MutantSpec, cases: Case[], baseline: RunOutput, mutant: RunOutput): Omit<MutantResult, "status" | "invalid_reason"> & { killed: boolean } {
  const b = verdictMap(baseline);
  const mu = verdictMap(mutant);
  const candidates = cases.filter((c) => isWitnessCandidate(c, m));
  const witnesses: string[] = [];
  let baselineValid = 0;
  for (const c of candidates) {
    const bv = b.get(c.case_id);
    if (!bv || !primaryOk(bv) || bv.mismatches.some((x) => x.kind === "invariant_violation")) continue;
    const reasons = (bv.primary.reason_class ?? "").split(",");
    if (!reasons.some((r) => m.exposed_reason_classes.includes(r as never))) continue;
    baselineValid++;
    const mv = mu.get(c.case_id);
    if (!mv) continue; // adapter error or not run: technically invalid, cannot witness
    if (safetyViolation(mv)) witnesses.push(c.case_id);
  }
  const mismatchesBy = { runtime: 0, component: 0 };
  for (const v of mutant.verdicts) if (!v.outcome_match) mismatchesBy[v.boundary]++;
  return {
    mutation_id: m.mutation_id,
    family: m.family,
    evaluation_boundary: m.evaluation_boundary,
    witness_candidates: candidates.length,
    baseline_valid_witness_candidates: baselineValid,
    witness_case_ids: witnesses.slice(0, 25),
    witness_count: witnesses.length,
    mutant_adapter_errors: mutant.adapter_errors.length,
    mutant_harness_errors: mutant.harness_errors.length,
    outcome_mismatches_by_boundary: mismatchesBy,
    boundary_violation: m.evaluation_boundary === "component" && mismatchesBy.runtime > 0,
    integrity_scenarios: integrityCounts(mutant),
    killed: witnesses.length > 0,
  };
}

export async function runMutant(
  lock: SutLock,
  o: PrepareOptions & { harnessRoot: string; keepEnvs?: boolean },
  m: MutantSpec,
  cases: Case[],
  baseline: RunOutput,
): Promise<MutantResult> {
  const empty = {
    mutation_id: m.mutation_id,
    family: m.family,
    evaluation_boundary: m.evaluation_boundary,
    witness_candidates: cases.filter((c) => isWitnessCandidate(c, m)).length,
    baseline_valid_witness_candidates: 0,
    witness_case_ids: [],
    witness_count: 0,
    mutant_adapter_errors: 0,
    mutant_harness_errors: 0,
    outcome_mismatches_by_boundary: { runtime: 0, component: 0 },
    boundary_violation: false,
    integrity_scenarios: zeroIntegrity(),
  };
  let env;
  try {
    env = prepareMutant(lock, o, m.mutation_id, patchPath(o.harnessRoot, m.mutation_id), m.target_file);
  } catch (e) {
    return { ...empty, status: "invalid", invalid_reason: `${(e as Error).name}: ${(e as Error).message}` };
  }
  try {
    const out = await runCases(cases, env.adapter, lock.sut_commit, { expectCleanWorktree: false });
    if (out.harness_errors.length > 0) {
      return { ...empty, mutant_harness_errors: out.harness_errors.length, status: "invalid", invalid_reason: `harness/protocol error: ${out.harness_errors[0].message}` };
    }
    const j = judgeMutant(m, cases, baseline, out);
    const { killed, ...rest } = j;
    let status: MutantStatus = killed ? "killed" : "survived";
    let invalid: string | null = null;
    if (!killed && out.adapter_errors.length > 0) {
      status = "invalid";
      invalid = `mutant produced ${out.adapter_errors.length} adapter errors and no valid witness (infrastructure failure instead of a witness)`;
    }
    if (j.boundary_violation) {
      status = "invalid";
      invalid = `component mutant changed ${j.outcome_mismatches_by_boundary.runtime} runtime outcomes: boundary classification contradicted`;
    }
    return { ...rest, status, invalid_reason: invalid };
  } finally {
    if (!o.keepEnvs) disposeEnv(env, o.workDir);
  }
}
