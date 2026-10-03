/**
 * Automotive run engine (auto-evaluator-0.2.0).
 *
 * Order: fixture preflight -> oracle-integrity preflight -> (only if clean) spawn
 * adapter -> hello -> cases strictly in order -> graceful shutdown.
 *
 *  - An explicit adapter_error result makes that case HARNESS_ERROR / ADAPTER_ERROR and the
 *    run continues: the protocol channel is still valid.
 *  - A protocol or client failure makes the current case HARNESS_ERROR (PROTOCOL_ERROR,
 *    TIMEOUT or ADAPTER_ERROR) and stops the run: the channel is poisoned. Remaining cases are
 *    listed as not run, never evaluated.
 *  - Harness failures are never converted into SUT violations.
 */
import { AUTOMOTIVE_EVALUATOR_VERSION } from "../../spec/automotive/version";
import type { AutomotiveHarnessErrorReason } from "../../spec/automotive/reason-taxonomy";
import { toAutomotiveAdapterView } from "../../corpus/automotive/builders";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import { AutomotiveProtocolError, type AutomotiveCaseResult } from "../../adapter/automotive/protocol";
import { AutomotiveAdapterClient, AutomotiveClientError, type AutomotiveAdapterCommand } from "../../adapter/automotive/jsonl-client";
import { evaluateAutomotiveCase, harnessErrorEvaluation } from "./evaluate";
import { preflightEntry } from "./truth";
import type { AutomotiveRunOutput } from "./types";

export interface AutomotiveRunOptions {
  /** Per-request adapter timeout (ms). */
  timeoutMs?: number;
}

/** Maps a client/protocol failure to a harness reason without parsing messages. */
export function classifyHarnessFailure(e: unknown): AutomotiveHarnessErrorReason {
  if (e instanceof AutomotiveProtocolError) return "PROTOCOL_ERROR";
  if (e instanceof AutomotiveClientError) return e.kind === "timeout" ? "TIMEOUT" : "ADAPTER_ERROR";
  return "ADAPTER_ERROR";
}

const messageOf = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function runAutomotiveCorpus(entries: readonly AutomotiveCorpusEntry[], adapter: AutomotiveAdapterCommand, opts: AutomotiveRunOptions = {}): Promise<AutomotiveRunOutput> {
  const out: AutomotiveRunOutput = {
    evaluator_version: AUTOMOTIVE_EVALUATOR_VERSION,
    run_valid: false,
    hello: null,
    case_evaluations: [],
    harness_errors: [],
    adapter_errors: [],
    not_run_case_ids: [],
    case_results: [],
  };

  // 1-2. Preflight: no SUT process is started unless every entry is a valid fixture with intact expected truth.
  const preflight = entries.map((e) => ({ entry: e, error: preflightEntry(e) }));
  if (preflight.some((p) => p.error !== null)) {
    for (const { entry, error } of preflight) {
      if (error) {
        out.harness_errors.push(error);
        out.case_evaluations.push(harnessErrorEvaluation(entry, error.reason));
      } else out.not_run_case_ids.push(entry.case.case_id);
    }
    return out;
  }

  // 3-4. Spawn and handshake.
  const client = new AutomotiveAdapterClient(adapter, opts.timeoutMs ?? 10_000);
  try {
    try {
      out.hello = await client.helloHandshake();
    } catch (e) {
      out.harness_errors.push({ case_id: null, reason: classifyHarnessFailure(e), message: `hello: ${messageOf(e)}` });
      out.not_run_case_ids.push(...entries.map((e) => e.case.case_id));
      return out;
    }

    // 5-7. Cases in order.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let result: AutomotiveCaseResult;
      try {
        result = await client.runCase(toAutomotiveAdapterView(entry.case));
      } catch (e) {
        const reason = classifyHarnessFailure(e);
        out.harness_errors.push({ case_id: entry.case.case_id, reason, message: messageOf(e) });
        out.case_evaluations.push(harnessErrorEvaluation(entry, reason));
        out.not_run_case_ids.push(...entries.slice(i + 1).map((x) => x.case.case_id));
        return out;
      }
      out.case_results.push(result);
      if (result.status === "adapter_error") {
        out.adapter_errors.push({ case_id: entry.case.case_id, message: result.error.message });
        out.harness_errors.push({ case_id: entry.case.case_id, reason: "ADAPTER_ERROR", message: result.error.message });
      }
      out.case_evaluations.push(evaluateAutomotiveCase(entry, result));
    }
    out.run_valid = out.harness_errors.length === 0 && out.not_run_case_ids.length === 0;
    return out;
  } finally {
    // 8. Graceful shutdown (kills the process if it does not exit in time).
    await client.shutdown();
  }
}
