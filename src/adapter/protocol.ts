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
   * The SUT's authority decision for this stage (see SutDecision / ResultControlDecision, or NONE /
   * DECISION_NOT_OBSERVED), recorded only when it disagrees with the observed effect or could not be observed.
   * When set, `outcome` is the effect-based outcome and `decision_effect_mismatch` is true.
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

/**
 * The SUT's own authority decision for an attempt (adapter >= 0.4.0). Derived only from SUT authority evidence
 * (its audit events, or a classified rejection), never from a return value alone, an exit_status or an observed
 * effect. DECISION_NOT_OBSERVED = no authority evidence attributable to this attempt.
 */
export type SutDecision = "ALLOW" | "ASK" | "DENY" | "EXECUTE" | "REJECT" | "DECISION_NOT_OBSERVED";
export const SUT_DECISIONS: readonly SutDecision[] = ["ALLOW", "ASK", "DENY", "EXECUTE", "REJECT", "DECISION_NOT_OBSERVED"];
/** The SUT's result-control decision: only a Result Guardian audit decision attributed to the call. */
export type ResultControlDecision = "DELIVER" | "WITHHOLD";
/**
 * Where a decision came from. audit_event: a SUT audit event attributed to the attempt (guardian_decision,
 * human_approval, human_rejection, capability_rejected, replay/timestamp_rejected, approval_verification_failed,
 * approval_expired, tool_execution_started, result_guardian_decision). sut_exception: a rejection the SUT reports
 * only by exception class/message (no audit event exists for it, e.g. request signature or schema failures).
 * none: DECISION_NOT_OBSERVED.
 */
export type DecisionSource = "audit_event" | "sut_exception" | "none";
export const DECISION_SOURCES: readonly DecisionSource[] = ["audit_event", "sut_exception", "none"];
/**
 * State of one observation channel for one decision point:
 *  - observed:     the channel is available and attributable, and the effect was seen;
 *  - not_observed: the channel is available and attributable, and the effect was NOT seen (a negative observation);
 *  - ambiguous:    something was (or may have been) seen but cannot be attributed to this decision point;
 *  - unavailable:  the boundary has no such channel.
 * Only observed / not_observed decision points enter clean integrity denominators.
 */
export type ObservationState = "observed" | "not_observed" | "ambiguous" | "unavailable";
export const OBSERVATION_STATES: readonly ObservationState[] = ["observed", "not_observed", "ambiguous", "unavailable"];
/**
 * harness_tool_trace: harness-owned tool double log, attributed by the per-attempt trace argument.
 * sut_counter: the SUT's fallback-tool execution counter (tools outside the harness doubles); attributable only
 *   when a single call could have caused the delta.
 * return_value_scan: exact raw tool output searched (structurally, inside wrappers) in the value the call returned.
 * none: no channel.
 */
export type ObservationSource = "harness_tool_trace" | "sut_counter" | "return_value_scan" | "none";
export const OBSERVATION_SOURCES: readonly ObservationSource[] = ["harness_tool_trace", "sut_counter", "return_value_scan", "none"];
export interface ChannelObservation {
  state: ObservationState;
  source: ObservationSource;
  /** Short machine-readable note on why a channel is ambiguous/unavailable. */
  detail?: string;
}
/**
 * State of the result-control (delivery authority) decision for a decision point:
 *  - observed:       >= 1 Result Guardian decision attributed to the point (result_control_decisions);
 *  - not_observed:   the point had execution authority or an observed execution, but no Result Guardian
 *                    decision is attributable to it (e.g. the result path failed before the Result Guardian);
 *  - ambiguous:      Result Guardian decisions exist but cannot be attributed to individual attempts;
 *  - not_applicable: no execution was authorised or observed, so there is nothing to control.
 */
export type ResultControlState = "observed" | "not_observed" | "ambiguous" | "not_applicable";
export const RESULT_CONTROL_STATES: readonly ResultControlState[] = ["observed", "not_observed", "ambiguous", "not_applicable"];

/**
 * Decision/effect evidence for one decision point (adapter >= 0.4.0). Decisions come only from SUT authority
 * evidence (sut_decisions + decision_sources, result_control_decisions); effects come only from the observation
 * channels (execution_observation, delivery_observation). The raw SUT reports (return status, exit_status,
 * exception) are kept as evidence and are never a decision source.
 */
export interface EffectRecord {
  step: number;
  /** Present when the record describes exactly one attempt. */
  attempt?: number;
  stage: "request" | "approval" | "permit";
  /** Session-qualified request label the effects belong to; null = execution not attributable to a request. */
  key: string | null;
  /**
   * "attempt": decisions and effects of exactly this attempt; "step_key": aggregated over a concurrent step's
   * attempts on `key` (their executions are of the same pending request and are fungible); "unattributed":
   * effects that no decision point can be attributed to.
   */
  attribution: "attempt" | "step_key" | "unattributed";
  sut_reports: SutReport[];
  sut_decisions: SutDecision[];
  /** Parallel to sut_decisions. */
  decision_sources: DecisionSource[];
  result_control_decisions: ResultControlDecision[];
  result_control_state: ResultControlState;
  /** Attempts whose observed SUT authority decision granted execution (request ALLOW, approval EXECUTE, permit EXECUTE). */
  authorized_executions: number;
  observed_executions: number;
  execution_observation: ChannelObservation;
  /** min(Result Guardian DELIVER decisions, authorized_executions). */
  authorized_deliveries: number;
  /** Returned values in which an exact raw tool output of this record's executions was found. */
  observed_raw_deliveries: number;
  delivery_observation: ChannelObservation;
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
   * Decision/effect evidence per decision point (adapter >= 0.4.0). Absent = the adapter has no effect
   * channel for this case (reported as "unavailable", never as zero violations).
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
    const chan = (c: unknown) =>
      isObj(c) && OBSERVATION_STATES.includes(c.state as ObservationState) && OBSERVATION_SOURCES.includes(c.source as ObservationSource) && (c.detail === undefined || typeof c.detail === "string");
    for (const r of o.effect_records) {
      if (
        !isObj(r) || !Number.isSafeInteger(r.step) || !["request", "approval", "permit"].includes(r.stage as string) ||
        (r.key !== null && typeof r.key !== "string") || !["attempt", "step_key", "unattributed"].includes(r.attribution as string) ||
        !Array.isArray(r.sut_reports) || !Array.isArray(r.sut_decisions) || !Array.isArray(r.decision_sources) || !Array.isArray(r.result_control_decisions) ||
        !RESULT_CONTROL_STATES.includes(r.result_control_state as ResultControlState) ||
        !int(r.authorized_executions) || !int(r.observed_executions) || !int(r.authorized_deliveries) || !int(r.observed_raw_deliveries) ||
        !chan(r.execution_observation) || !chan(r.delivery_observation)
      ) {
        throw new ProtocolError("malformed effect_records entry");
      }
      if ((r.decision_sources as unknown[]).length !== (r.sut_decisions as unknown[]).length) throw new ProtocolError("effect_records: decision_sources must parallel sut_decisions");
      for (const d of r.sut_decisions as unknown[]) if (!SUT_DECISIONS.includes(d as SutDecision)) throw new ProtocolError(`unknown sut_decision ${String(d)}`);
      for (const d of r.decision_sources as unknown[]) if (!DECISION_SOURCES.includes(d as DecisionSource)) throw new ProtocolError(`unknown decision_source ${String(d)}`);
      for (const d of r.result_control_decisions as unknown[]) if (d !== "DELIVER" && d !== "WITHHOLD") throw new ProtocolError(`unknown result_control_decision ${String(d)}`);
    }
  }
  if (!isObj(o.executions)) throw new ProtocolError("observations.executions must be an object");
  for (const v of Object.values(o.executions)) if (!Number.isSafeInteger(v) || (v as number) < 0) throw new ProtocolError("executions values must be non-negative integers");
  if (!Number.isSafeInteger(o.unattributed_executions) || (o.unattributed_executions as number) < 0) throw new ProtocolError("unattributed_executions must be a non-negative integer");
  return x as unknown as CaseResult;
}
