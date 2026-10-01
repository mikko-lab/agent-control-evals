/**
 * Adapter protocol v1 (process boundary, JSON Lines over stdin/stdout).
 * See docs/adapter-protocol-v1.md. Shared by the harness client and adapters;
 * contains types and structural validation only (no oracle, no SUT logic).
 */
import { ADAPTER_PROTOCOL_VERSION } from "../version";
import { isReasonClass, type ReasonClass } from "../spec/reason-taxonomy";
import { STAGE_OUTCOMES, type Stage } from "../spec/outcomes";
import type { CaseForAdapter } from "../corpus/types";

export const PROTOCOL_VERSION = ADAPTER_PROTOCOL_VERSION;

export type HarnessToAdapter =
  | { type: "hello"; protocol_version: number }
  | { type: "case"; protocol_version: number; case: CaseForAdapter }
  | { type: "shutdown"; protocol_version: number };

export interface HelloResponse {
  type: "hello";
  protocol_version: number;
  adapter: string;
  adapter_version: string;
  sut: { name: string; commit: string; version: string; worktree_clean: boolean };
}

export interface ObservedAssertion {
  step: number;
  attempt?: number;
  stage: Stage;
  outcome: string;
  reason_class: ReasonClass;
  sut_reason_code: string;
  enforcement_stage: string;
  /**
   * What the SUT itself reported for this stage (return value / thrown error), recorded only when it
   * disagrees with the effect observed through the harness tool doubles. When set, `outcome` is the
   * effect-based outcome and `decision_effect_mismatch` is true.
   */
  sut_decision?: string;
  decision_effect_mismatch?: boolean;
}

/** A disagreement between the SUT's reported decision and the observed tool-execution effect. */
export interface DecisionEffectMismatch {
  step: number;
  attempt?: number;
  stage: "request" | "approval";
  /** Session-qualified request label whose execution count disagrees, or null for unattributable executions. */
  key: string | null;
  sut_decision: string;
  decided_executions: number;
  observed_executions: number;
}

export interface Observations {
  assertions: ObservedAssertion[];
  /** Executions observed through harness-owned tool doubles, keyed by session-qualified request label. */
  executions: Record<string, number>;
  /** Executions the adapter could not attribute to a scenario request (e.g. SUT fallback tools). */
  unattributed_executions: number;
  /** Component permit cases: observed number of accepted permit reuses. */
  permit_reuses_accepted?: number;
  /** Decision/effect disagreements (adapter >= 0.2.0). The effect, not the decision, determines `outcome`. */
  decision_effect_mismatches?: DecisionEffectMismatch[];
}

export interface CaseResult {
  type: "case_result";
  case_id: string;
  protocol_version: number;
  evaluation_boundary: "runtime" | "component";
  status: "ok" | "adapter_error";
  observations: Observations | null;
  raw_sut_evidence: unknown;
  error?: { message: string };
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function validateHello(x: unknown): HelloResponse {
  if (!isObj(x) || x.type !== "hello") throw new ProtocolError("expected hello response");
  if (x.protocol_version !== PROTOCOL_VERSION) throw new ProtocolError(`adapter protocol_version ${String(x.protocol_version)} != ${PROTOCOL_VERSION}`);
  if (typeof x.adapter !== "string" || typeof x.adapter_version !== "string") throw new ProtocolError("hello: adapter/adapter_version required");
  const sut = x.sut;
  if (!isObj(sut) || typeof sut.commit !== "string" || typeof sut.version !== "string" || typeof sut.name !== "string" || typeof sut.worktree_clean !== "boolean") {
    throw new ProtocolError("hello: sut {name, commit, version, worktree_clean} required");
  }
  return x as unknown as HelloResponse;
}

/**
 * Strict structural validation of one case result. Anything malformed is a
 * protocol error (harness-invalid run), never a safety outcome.
 */
export function validateCaseResult(x: unknown, expectedCaseId: string, expectedBoundary: string): CaseResult {
  if (!isObj(x)) throw new ProtocolError("case result is not an object");
  if (x.type !== "case_result") throw new ProtocolError("case result: type must be case_result");
  if (x.protocol_version !== PROTOCOL_VERSION) throw new ProtocolError("case result: protocol_version mismatch");
  if (x.case_id !== expectedCaseId) throw new ProtocolError(`case result: case_id ${String(x.case_id)} != ${expectedCaseId}`);
  if (x.evaluation_boundary !== expectedBoundary) throw new ProtocolError("case result: evaluation_boundary mismatch");
  if (x.status !== "ok" && x.status !== "adapter_error") throw new ProtocolError("case result: invalid status");
  if (!("raw_sut_evidence" in x)) throw new ProtocolError("case result: raw_sut_evidence required");
  if (x.status === "adapter_error") {
    if (!isObj(x.error) || typeof x.error.message !== "string") throw new ProtocolError("adapter_error requires error.message");
    return x as unknown as CaseResult;
  }
  const o = x.observations;
  if (!isObj(o)) throw new ProtocolError("case result: observations required when status ok");
  if (!Array.isArray(o.assertions)) throw new ProtocolError("observations.assertions must be an array");
  for (const a of o.assertions) {
    if (!isObj(a)) throw new ProtocolError("observed assertion must be an object");
    if (!Number.isSafeInteger(a.step)) throw new ProtocolError("observed assertion: step must be an integer");
    if (a.attempt !== undefined && !Number.isSafeInteger(a.attempt)) throw new ProtocolError("observed assertion: attempt must be an integer");
    const stage = a.stage as Stage;
    if (!(stage in STAGE_OUTCOMES)) throw new ProtocolError(`observed assertion: unknown stage ${String(a.stage)}`);
    if (!STAGE_OUTCOMES[stage].includes(a.outcome as string)) throw new ProtocolError(`observed assertion: outcome ${String(a.outcome)} invalid for stage ${stage}`);
    if (!isReasonClass(a.reason_class)) throw new ProtocolError(`observed assertion: unknown reason_class ${String(a.reason_class)}`);
    if (typeof a.sut_reason_code !== "string" || typeof a.enforcement_stage !== "string") throw new ProtocolError("observed assertion: sut_reason_code/enforcement_stage required");
    if (a.sut_decision !== undefined && typeof a.sut_decision !== "string") throw new ProtocolError("observed assertion: sut_decision must be a string");
    if (a.decision_effect_mismatch !== undefined && typeof a.decision_effect_mismatch !== "boolean") throw new ProtocolError("observed assertion: decision_effect_mismatch must be boolean");
  }
  if (o.decision_effect_mismatches !== undefined) {
    if (!Array.isArray(o.decision_effect_mismatches)) throw new ProtocolError("decision_effect_mismatches must be an array");
    for (const m of o.decision_effect_mismatches) {
      if (!isObj(m) || !Number.isSafeInteger(m.step) || (m.stage !== "request" && m.stage !== "approval") || typeof m.sut_decision !== "string" ||
        !Number.isSafeInteger(m.decided_executions) || !Number.isSafeInteger(m.observed_executions) || (m.key !== null && typeof m.key !== "string")) {
        throw new ProtocolError("malformed decision_effect_mismatches entry");
      }
    }
  }
  if (!isObj(o.executions)) throw new ProtocolError("observations.executions must be an object");
  for (const v of Object.values(o.executions)) if (!Number.isSafeInteger(v) || (v as number) < 0) throw new ProtocolError("executions values must be non-negative integers");
  if (!Number.isSafeInteger(o.unattributed_executions) || (o.unattributed_executions as number) < 0) throw new ProtocolError("unattributed_executions must be a non-negative integer");
  return x as unknown as CaseResult;
}
