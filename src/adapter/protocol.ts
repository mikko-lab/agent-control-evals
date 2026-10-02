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

/** What the SUT itself reported for one call. */
export interface SutReport {
  kind: "returned" | "threw";
  /** process(): "pending" | "executed" | other; resolveApproval(): "result" | "undefined"; gate: "result". */
  status?: string;
  exit_status?: string;
  exception?: { name: string; code: string; message: string };
}

/** The SUT's own control decision for an attempt (derived from its report, never from observed effects). */
export type SutDecision = "ALLOW" | "ASK" | "DENY" | "EXECUTE" | "REJECT" | "UNCLASSIFIED";
/** The SUT's result-control decision (Result Guardian audit decision, else the returned exit_status). */
export type ResultControlDecision = "DELIVER" | "WITHHOLD" | "UNKNOWN";

/**
 * Decision/effect evidence for one decision point (adapter >= 0.3.0). Decisions come only from what the SUT
 * reported; effects come only from the harness observation channel (tool doubles / fallback-tool counter for
 * executions, a search for the raw tool output in the returned value for deliveries).
 */
export interface EffectRecord {
  step: number;
  /** Present when the record describes exactly one attempt. */
  attempt?: number;
  stage: "request" | "approval" | "permit";
  /** Session-qualified request label the effects belong to; null = execution not attributable to a request. */
  key: string | null;
  /** "attempt": effects attributed to this attempt exactly; "step_key": aggregated over a concurrent step's attempts on `key`. */
  attribution: "attempt" | "step_key";
  sut_reports: SutReport[];
  sut_decisions: SutDecision[];
  result_control_decisions: ResultControlDecision[];
  /** Attempts whose SUT decision granted execution authority (request ALLOW, approval EXECUTE, permit EXECUTE). */
  authorized_executions: number;
  observed_executions: number;
  /** Attempts with execution authority whose SUT result control allowed delivery. */
  authorized_deliveries: number;
  /** Returned values in which a raw tool output of this record's executions was found. */
  observed_raw_deliveries: number;
  /** false for decision points with no delivery channel (component execution gate). */
  delivery_observed: boolean;
}

export interface Observations {
  assertions: ObservedAssertion[];
  /** Executions observed through harness-owned tool doubles, keyed by session-qualified request label. */
  executions: Record<string, number>;
  /** Executions the adapter could not attribute to a scenario request (e.g. SUT fallback tools). */
  unattributed_executions: number;
  /** Component permit cases: observed number of accepted permit reuses. */
  permit_reuses_accepted?: number;
  /**
   * Decision/effect evidence per decision point (adapter >= 0.3.0). Absent = the adapter has no effect
   * channel for this case (reported as "not observed", never as zero violations).
   */
  effect_records?: EffectRecord[];
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
  if (o.effect_records !== undefined) {
    if (!Array.isArray(o.effect_records)) throw new ProtocolError("effect_records must be an array");
    const int = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
    for (const r of o.effect_records) {
      if (
        !isObj(r) || !Number.isSafeInteger(r.step) || !["request", "approval", "permit"].includes(r.stage as string) ||
        (r.key !== null && typeof r.key !== "string") || (r.attribution !== "attempt" && r.attribution !== "step_key") ||
        !Array.isArray(r.sut_reports) || !Array.isArray(r.sut_decisions) || !Array.isArray(r.result_control_decisions) ||
        !int(r.authorized_executions) || !int(r.observed_executions) || !int(r.authorized_deliveries) || !int(r.observed_raw_deliveries) ||
        typeof r.delivery_observed !== "boolean"
      ) {
        throw new ProtocolError("malformed effect_records entry");
      }
      for (const d of r.sut_decisions as unknown[]) if (!["ALLOW", "ASK", "DENY", "EXECUTE", "REJECT", "UNCLASSIFIED"].includes(d as string)) throw new ProtocolError(`unknown sut_decision ${String(d)}`);
      for (const d of r.result_control_decisions as unknown[]) if (!["DELIVER", "WITHHOLD", "UNKNOWN"].includes(d as string)) throw new ProtocolError(`unknown result_control_decision ${String(d)}`);
    }
  }
  if (!isObj(o.executions)) throw new ProtocolError("observations.executions must be an object");
  for (const v of Object.values(o.executions)) if (!Number.isSafeInteger(v) || (v as number) < 0) throw new ProtocolError("executions values must be non-negative integers");
  if (!Number.isSafeInteger(o.unattributed_executions) || (o.unattributed_executions as number) < 0) throw new ProtocolError("unattributed_executions must be a non-negative integer");
  return x as unknown as CaseResult;
}
