/**
 * ACS runtime-boundary adapter: materialises a runtime scenario into calls on
 * the pinned GuardedExecutor public API (process, resolveApproval,
 * clearSession) and normalises what the SUT did into observations.
 *
 * This module contains integration logic only. It never decides what SHOULD
 * happen. The SUT's authority decisions are taken only from SUT authority
 * evidence (its audit events attributed to the call, or a classified
 * rejection); a return value, an exit_status or an exception class alone never
 * grants ALLOW / EXECUTE / DELIVER. Effects are observed separately (harness
 * tool doubles, the SUT fallback-tool counter when attributable, and a raw
 * output scan of returned values), each with an explicit observation state.
 * Normalised outcomes for the oracle comparison are effect-based. A decision
 * that cannot be observed WITHOUT any observed effect becomes an AdapterError,
 * never a DENY/REJECT/WITHHOLD; an observed effect is never turned into an
 * AdapterError.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { ReasonClass } from "../../spec/reason-taxonomy";
import type { ChannelObservation, DecisionSource, EffectRecord, ObservedAssertion, Observations, ResultControlDecision, ResultControlState, SutDecision, SutReport } from "../protocol";
import type { CapabilitySpec, CaseForAdapter, GrantSpec, RequestStep, RuntimeScenario } from "../../corpus/types";
import { DECLARED_POLICY } from "../../spec/declared-policy";
import type { SutModules } from "./sut";
import { containsValue, makeTrace, ToolDoubles, TRACE_ARG, traceKey } from "./tool-doubles";

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export const HARNESS_TOOLS = ["read_record", "update_record"] as const;
const APPROVER_KEY_ID = "ace-approver-1";
const CAPABILITY_KEY_ID = "ace-cap-1";
const REQUEST_KEY_ID = "ace-req-1";
const REQUEST_ROOT_SECRET = "ace-eval-request-root-secret";

export interface AdapterKeys {
  approver: { publicKey: KeyObject; privateKey: KeyObject };
  capability: { publicKey: KeyObject; privateKey: KeyObject };
}

export function makeKeys(): AdapterKeys {
  return { approver: generateKeyPairSync("ed25519"), capability: generateKeyPairSync("ed25519") };
}

/** Deterministic RFC 4122-shaped (version 4, variant 10xx) UUID for a scenario label. */
export function uuidFor(caseId: string, ns: string, label: string): string {
  const h = createHash("sha256").update(`${caseId}|${ns}|${label}`).digest("hex");
  const variant = "89ab"[parseInt(h[16], 16) & 3];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function errInfo(e: unknown): { name: string; code: string; message: string } {
  if (e instanceof Error) {
    const anyE = e as Error & { code?: unknown; reason_code?: unknown };
    const code = typeof anyE.reason_code === "string" ? anyE.reason_code : anyE.code !== undefined ? String(anyE.code) : "";
    return { name: e.name, code, message: e.message };
  }
  return { name: typeof e, code: "", message: String(e) };
}

interface Ctx {
  c: CaseForAdapter;
  sut: SutModules;
  keys: AdapterKeys;
  clock: { base: number; offset: number };
  executor: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  audit: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  signer: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  doubles: ToolDoubles;
  outputs: Map<string, unknown>;
  capQueue: Map<string, unknown[]>;
  obs: ObservedAssertion[];
  evidence: unknown[];
  records: EffectRecord[];
  /** SUT result request id -> (session id, request_id_ref), observed when the SUT signs its own result request. */
  resultLinks: Map<string, { session: string; ref: string }>;
  /** Session-qualified request label -> tool of its latest materialised request. */
  toolByKey: Map<string, string>;
}

const now = (ctx: Ctx) => ctx.clock.base + ctx.clock.offset;
const iso = (ms: number) => new Date(ms).toISOString();
const sid = (ctx: Ctx, label: string) => uuidFor(ctx.c.case_id, "session", label);
/** request_id UUIDs depend only on the request label, so the same label in two sessions is the same request_id (as in the scenarios). */
const rid = (ctx: Ctx, label: string) => uuidFor(ctx.c.case_id, "request", label);

function signEd25519(sut: SutModules, privateKey: KeyObject, unsigned: Record<string, unknown>): string {
  return sign(null, Buffer.from(sut.canonicalize(unsigned)), privateKey).toString("base64");
}

function materialiseCapability(ctx: Ctx, cap: CapabilitySpec, stepIdx: number, attempt: number): unknown {
  if (!cap.present) return undefined;
  const t = now(ctx);
  const body: Record<string, unknown> = {
    version: 1,
    capability_id: uuidFor(ctx.c.case_id, "capability", `${stepIdx}.${attempt}`),
    agent_id: cap.agent,
    session_id: sid(ctx, cap.session!),
    allowed_tools: [...(cap.allowed_tools ?? [])],
    issued_at: iso(t + (cap.issued_offset_ms ?? 0)),
    expires_at: iso(t + (cap.expires_offset_ms ?? 0)),
  };
  const value = signEd25519(ctx.sut, ctx.keys.capability.privateKey, body);
  const signed: Record<string, unknown> = { ...body, signature: { algorithm: "Ed25519", key_id: CAPABILITY_KEY_ID, value } };
  if (cap.signature === "tampered") signed.capability_id = `${String(body.capability_id).slice(0, -1)}${String(body.capability_id).endsWith("0") ? "1" : "0"}`;
  return signed;
}

function materialiseRequest(ctx: Ctx, r: Omit<RequestStep, "op">, stepIdx: number, attempt: number): { envelope: unknown; trace: string } {
  const key = `${r.session}/${r.request}`;
  const trace = makeTrace(key, stepIdx, attempt);
  const sessionId = sid(ctx, r.session);
  const requestId = rid(ctx, r.request);
  const envelope = {
    jsonrpc: "2.0",
    method: "steps/toolCallRequest",
    id: uuidFor(ctx.c.case_id, "rpc", trace),
    params: {
      acs_version: "0.1.0",
      request_id: requestId,
      timestamp: iso(now(ctx) + r.timestamp_offset_ms),
      metadata: { agent_id: r.agent, session_id: sessionId },
      payload: { tool: { name: r.tool }, arguments: { [TRACE_ARG]: { value: trace } } },
    },
  };
  const signed = ctx.signer.signRequest(envelope);
  if (r.signature === "tampered") {
    signed.params = { ...signed.params, payload: { ...signed.params.payload, arguments: { ...signed.params.payload.arguments, ace_tamper: { value: true } } } };
  }
  ctx.outputs.set(trace, r.tool_output);
  const queueKey = `${sessionId}:${requestId}`;
  const q = ctx.capQueue.get(queueKey) ?? [];
  q.push(materialiseCapability(ctx, r.capability, stepIdx, attempt));
  ctx.capQueue.set(queueKey, q);
  return { envelope: signed, trace };
}

function materialiseGrant(ctx: Ctx, g: GrantSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    version: 2,
    decision: g.decision,
    session_id: sid(ctx, g.session),
    request_id: rid(ctx, g.request),
    tool: g.tool,
    approver: { type: "human", id: g.approver_id },
    issued_at: iso(now(ctx) + g.issued_offset_ms),
  };
  const value = signEd25519(ctx.sut, ctx.keys.approver.privateKey, body);
  const signed: Record<string, unknown> = { ...body, signature: { algorithm: "Ed25519", key_id: APPROVER_KEY_ID, value } };
  if (g.tamper) {
    const f = g.tamper.field;
    if (f === "session") signed.session_id = sid(ctx, g.tamper.value);
    if (f === "request") signed.request_id = rid(ctx, g.tamper.value);
    if (f === "tool") signed.tool = g.tamper.value;
    if (f === "approver_id") signed.approver = { type: "human", id: g.tamper.value };
  }
  return signed;
}

const CAPABILITY_AUDIT_REASON: Record<string, ReasonClass> = {
  capability_authentication_failed: "CAPABILITY_INVALID_SIGNATURE",
  capability_agent_mismatch: "CAPABILITY_AGENT_MISMATCH",
  capability_session_mismatch: "CAPABILITY_SESSION_MISMATCH",
  capability_scope_mismatch: "CAPABILITY_TOOL_MISMATCH",
  capability_expired: "CAPABILITY_EXPIRED",
  capability_not_yet_valid: "CAPABILITY_NOT_YET_VALID",
  capability_malformed: "CAPABILITY_MALFORMED",
  capability_unsupported_scope: "CAPABILITY_UNSUPPORTED_SCOPE",
  missing_capability: "CAPABILITY_MISSING",
};

const APPROVAL_CODE_REASON: Record<string, ReasonClass> = {
  V1_REJECTED: "APPROVAL_VERSION_REJECTED",
  TOOL_BINDING_MISMATCH: "APPROVAL_TOOL_MISMATCH",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  WRONG_APPROVER_IDENTITY: "APPROVER_MISMATCH",
  MALFORMED_GRANT: "APPROVAL_MALFORMED",
  SESSION_MISMATCH: "APPROVAL_SESSION_MISMATCH",
  REQUEST_MISMATCH: "APPROVAL_REQUEST_MISMATCH",
};

interface AuditEvent {
  event_type: string;
  request_id: string;
  metadata?: Record<string, unknown>;
}
/** Half-open audit index window [from, to) attributed to one call (or one step). */
type AuditWin = readonly [number, number];

const auditEvents = (ctx: Ctx): AuditEvent[] => ctx.audit.getEvents();
const auditLen = (ctx: Ctx): number => auditEvents(ctx).length;

/** Last audit event of `type` (for `requestId`, when given) inside the window. Never looks outside it. */
function findAudit(ctx: Ctx, win: AuditWin, type: string, requestId?: string): AuditEvent | undefined {
  const events = auditEvents(ctx).slice(win[0], win[1]);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event_type === type && (requestId === undefined || events[i].request_id === requestId)) return events[i];
  }
  return undefined;
}

/**
 * A started SUT call. `from`..`prefixTo` is the audit written by the call's synchronous prefix: everything the
 * call records before its first await (for the pinned GuardedExecutor: all request/approval authority events and
 * the execution start). For a call with no other call in flight the whole call window is attributable.
 */
interface StartedCall {
  from: number;
  prefixTo: number;
  settled: Promise<PromiseSettledResult<unknown>>;
}

function invoke(ctx: Ctx, fn: () => Promise<unknown>): StartedCall {
  const from = auditLen(ctx);
  let p: Promise<unknown>;
  try {
    p = fn();
  } catch (e) {
    p = Promise.reject(e);
  }
  const prefixTo = auditLen(ctx);
  return { from, prefixTo, settled: p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })) };
}

/** Errors that can only arise after the tool ran (internal result path). */
function postExecutionReason(ctx: Ctx, e: unknown): { reason: ReasonClass; code: string } {
  const i = errInfo(e);
  if (e instanceof ctx.sut.CorrelationError) return { reason: "CORRELATION_FAILURE", code: `${i.name}` };
  if (e instanceof ctx.sut.ReplayGuardError) return { reason: "RESULT_PATH_REJECTED", code: `${i.name}:${i.code}` };
  return { reason: "RESULT_PATH_REJECTED", code: `${i.name}:${i.code}` };
}

interface Classified {
  reason: ReasonClass;
  stage: string;
  code: string;
  source: DecisionSource;
}

/** A process() rejection that happened before the Guardian. null = not classifiable from SUT evidence. */
function classifyRequestRejection(ctx: Ctx, e: unknown, requestId: string, win: AuditWin): Classified | null {
  const i = errInfo(e);
  if (e instanceof ctx.sut.SignatureInvalidError) return { reason: "REQUEST_SIGNATURE_INVALID", stage: "request_signature", code: `${i.name}`, source: "sut_exception" };
  if (e instanceof ctx.sut.ReplayGuardError) {
    // Request-level only if the replay/timestamp audit event of THIS call names THIS request id.
    const own = findAudit(ctx, win, "replay_rejected", requestId) ?? findAudit(ctx, win, "timestamp_rejected", requestId);
    if (!own) return null;
    if (i.code === "REPLAY_DETECTED") return { reason: "REPLAY_DETECTED", stage: "replay_guard", code: `${i.name}:${i.code}`, source: "audit_event" };
    if (i.code === "TIMESTAMP_OUT_OF_WINDOW" || i.code === "TIMESTAMP_INVALID") return { reason: "TIMESTAMP_OUT_OF_WINDOW", stage: "replay_guard", code: `${i.name}:${i.code}`, source: "audit_event" };
    return null;
  }
  if (e instanceof ctx.sut.AddressableSchemaError || e instanceof ctx.sut.SchemaValidationError) {
    return { reason: "REQUEST_SCHEMA_INVALID", stage: "schema", code: `${i.name}`, source: "sut_exception" };
  }
  if (i.message === "Missing capability" || i.message.startsWith("Capability rejected: ")) {
    const ev = findAudit(ctx, win, "capability_rejected", requestId);
    const auditReason = typeof ev?.metadata?.reason === "string" ? (ev.metadata.reason as string) : "";
    const reason = CAPABILITY_AUDIT_REASON[auditReason];
    if (reason) return { reason, stage: "capability", code: auditReason, source: "audit_event" };
  }
  return null;
}

/** A resolveApproval() rejection. null = not classifiable from SUT evidence. */
function classifyApprovalRejection(ctx: Ctx, e: unknown, requestId: string, win: AuditWin): Classified | null {
  const i = errInfo(e);
  const failed = findAudit(ctx, win, "approval_verification_failed", requestId);
  if (e instanceof ctx.sut.ApprovalVerificationError) {
    const reason = APPROVAL_CODE_REASON[i.code];
    if (reason) return { reason, stage: "approval_verifier", code: `${i.name}:${i.code}`, source: failed ? "audit_event" : "sut_exception" };
  }
  if (i.message.startsWith("No pending action found")) {
    return { reason: "PENDING_ACTION_NOT_FOUND", stage: "approval_lookup", code: "pending_action_not_found", source: failed?.metadata?.reason === "pending_action_not_found" ? "audit_event" : "sut_exception" };
  }
  if (i.message === "Approval grant rejected: issued_at is before ASK creation") return { reason: "APPROVAL_BEFORE_ASK", stage: "approval_freshness", code: "issued_at_before_ask", source: "sut_exception" };
  if (i.message === "Approval grant rejected: issued_at is unreasonably in the future") return { reason: "APPROVAL_FUTURE_SKEW", stage: "approval_freshness", code: "issued_at_future", source: "sut_exception" };
  if (i.message === "Approval grant rejected: pending action has expired") {
    return { reason: "APPROVAL_EXPIRED", stage: "approval_expiry", code: "approval_expired", source: findAudit(ctx, win, "approval_expired", requestId) ? "audit_event" : "sut_exception" };
  }
  return null;
}

/** Map a Result Guardian audit decision to the result-control vocabulary (null = not a recognised decision). */
function controlFromGuardian(decision: unknown): ResultControlDecision | null {
  return decision === "deny" ? "WITHHOLD" : decision === "allow" ? "DELIVER" : null;
}

/** Result Guardian decisions recorded in a window, with the call they are linked to (if any). */
function rgEvents(ctx: Ctx, win: AuditWin): { control: ResultControlDecision | null; link: { session: string; ref: string } | undefined }[] {
  return auditEvents(ctx)
    .slice(win[0], win[1])
    .filter((e) => e.event_type === "result_guardian_decision")
    .map((e) => ({ control: controlFromGuardian(e.metadata?.decision), link: ctx.resultLinks.get(e.request_id) }));
}

interface ResultControl {
  decisions: ResultControlDecision[];
  state: ResultControlState;
}

/**
 * Result control for one decision point. Never picks a winner: an unrecognised Result Guardian decision, or both
 * DELIVER and WITHHOLD attributed to the same point, make the point ambiguous (no authority decision).
 */
function resultControl(decisions: (ResultControlDecision | null)[], need: boolean, ambiguous: boolean): ResultControl {
  if (ambiguous) return { decisions: [], state: "ambiguous" };
  if (decisions.some((d) => d === null)) return { decisions: [], state: "ambiguous" };
  if (new Set(decisions).size > 1) return { decisions: [], state: "ambiguous" };
  const ds = decisions as ResultControlDecision[];
  if (ds.length > 0) return { decisions: ds, state: "observed" };
  return { decisions: [], state: need ? "not_observed" : "not_applicable" };
}

function sutReport(o: PromiseSettledResult<unknown>, fulfilledStatus: (v: unknown) => string): SutReport {
  if (o.status === "rejected") {
    const i = errInfo(o.reason);
    return { kind: "threw", exception: { name: i.name, code: i.code, message: i.message } };
  }
  const v = o.value as { exit_status?: unknown; result?: { exit_status?: unknown } } | undefined;
  const r: SutReport = { kind: "returned", status: fulfilledStatus(o.value) };
  const es = v && typeof v === "object" ? (v.result?.exit_status ?? v.exit_status) : undefined;
  if (typeof es === "string") r.exit_status = es;
  return r;
}

function push(ctx: Ctx, o: ObservedAssertion) {
  ctx.obs.push(o);
}

/** Raw outputs (stable serialisation) of the executions in `log` matching `pred`. */
function rawOutputs(ctx: Ctx, from: number, pred: (trace: string | null) => boolean): string[] {
  return ctx.doubles.log.slice(from).filter((x) => pred(x.trace)).map((x) => x.output);
}

function deliveredRaw(returned: unknown, outputs: string[]): boolean {
  return returned !== undefined && outputs.some((o) => containsValue(returned, o));
}

const isHarnessTool = (tool: string | undefined) => tool !== undefined && (HARNESS_TOOLS as readonly string[]).includes(tool);

interface Decided {
  decision: SutDecision;
  source: DecisionSource;
  reason: ReasonClass;
  code: string;
  stage: string;
  /** Set when the call failed on the SUT's internal result path after the authority decision granted execution. */
  postExecution?: { reason: ReasonClass; code: string };
}

const notObserved = (code: string): Decided => ({ decision: "DECISION_NOT_OBSERVED", source: "none", reason: "DECISION_EFFECT_MISMATCH", code, stage: "unclassified" });

/**
 * SUT authority decision for process(). ALLOW / ASK / DENY by the Guardian come only from the call's own
 * guardian_decision audit event; pre-Guardian rejections from the classified rejection (with its audit event where
 * the SUT writes one). The return status ("executed"/"pending") and exception classes alone never grant ALLOW.
 */
function requestDecision(ctx: Ctx, o: PromiseSettledResult<unknown>, requestId: string, win: AuditWin): Decided {
  const g = findAudit(ctx, win, "guardian_decision", requestId)?.metadata?.decision;
  if (g === "allow") {
    const d: Decided = { decision: "ALLOW", source: "audit_event", reason: "POLICY_ALLOW", code: "guardian:allow", stage: "guardian" };
    if (o.status === "rejected") d.postExecution = postExecutionReason(ctx, o.reason);
    return d;
  }
  if (g === "deny") return { decision: "DENY", source: "audit_event", reason: "POLICY_DENY", code: "guardian:deny", stage: "guardian" };
  if (g === "ask") return { decision: "ASK", source: "audit_event", reason: "POLICY_ASK", code: o.status === "fulfilled" ? "guardian:ask" : "guardian:ask;blocked", stage: "guardian" };
  if (o.status === "rejected") {
    const c = classifyRequestRejection(ctx, o.reason, requestId, win);
    if (c) return { decision: "DENY", ...c };
    const i = errInfo(o.reason);
    return notObserved(`no_authority_evidence:threw:${i.name}:${i.message}`);
  }
  return notObserved(`no_authority_evidence:status=${String((o.value as { status?: unknown } | undefined)?.status)}`);
}

/**
 * SUT authority decision for resolveApproval(). EXECUTE only from the call's own human_approval audit event;
 * REJECT from human_rejection or a classified rejection. A returned value alone never grants EXECUTE.
 */
function approvalDecision(ctx: Ctx, grantRequestId: string, o: PromiseSettledResult<unknown>, win: AuditWin): Decided {
  if (findAudit(ctx, win, "human_approval", grantRequestId)) {
    const d: Decided = { decision: "EXECUTE", source: "audit_event", reason: "APPROVAL_GRANTED", code: "human_approval", stage: "human" };
    if (o.status === "rejected") d.postExecution = postExecutionReason(ctx, o.reason);
    return d;
  }
  if (findAudit(ctx, win, "human_rejection", grantRequestId)) return { decision: "REJECT", source: "audit_event", reason: "HUMAN_REJECTED", code: "human_rejection", stage: "human" };
  if (o.status === "rejected") {
    const c = classifyApprovalRejection(ctx, o.reason, grantRequestId, win);
    if (c) return { decision: "REJECT", ...c };
    const i = errInfo(o.reason);
    return notObserved(`no_authority_evidence:threw:${i.name}:${i.message}`);
  }
  return notObserved(`no_authority_evidence:returned:${o.value === undefined ? "undefined" : "value"}`);
}

const DELIVERY_SCAN: ChannelObservation = { state: "not_observed", source: "return_value_scan" };

/** Records for executions in a step that no attempt of the step can be attributed to. */
function strayRecords(ctx: Ctx, step: number, logFrom: number, known: Set<string>, returnedValues: unknown[]): EffectRecord[] {
  const out: EffectRecord[] = [];
  const recs = ctx.doubles.log.slice(logFrom);
  const untraced = recs.filter((x) => x.trace === null).length;
  if (untraced > 0) {
    out.push({
      step, stage: "request", key: null, attribution: "unattributed", sut_reports: [], sut_decisions: [], decision_sources: [],
      result_control_decisions: [], result_control_state: "not_applicable",
      authorized_executions: 0, observed_executions: untraced, execution_observation: { state: "ambiguous", source: "harness_tool_trace", detail: "execution_without_trace" },
      authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observation: { state: "ambiguous", source: "return_value_scan", detail: "execution_without_trace" },
    });
  }
  const byKey = new Map<string, string[]>();
  for (const x of recs) if (x.trace !== null && !known.has(x.trace)) byKey.set(traceKey(x.trace), [...(byKey.get(traceKey(x.trace)) ?? []), x.output]);
  for (const [key, outputs] of byKey) {
    const delivered = returnedValues.filter((v) => deliveredRaw(v, outputs)).length;
    out.push({
      step, stage: "request", key, attribution: "step_key", sut_reports: [], sut_decisions: [], decision_sources: [],
      result_control_decisions: [], result_control_state: "not_applicable",
      authorized_executions: 0, observed_executions: outputs.length, execution_observation: { state: "observed", source: "harness_tool_trace", detail: "no_decision_point_in_step" },
      authorized_deliveries: 0, observed_raw_deliveries: delivered, delivery_observation: { state: delivered > 0 ? "observed" : "not_observed", source: "return_value_scan" },
    });
  }
  return out;
}

interface RequestAttempt {
  attempt: number | undefined;
  r: Omit<RequestStep, "op">;
  key: string;
  trace: string;
  sessionId: string;
  requestId: string;
  call: StartedCall;
}

function startRequest(ctx: Ctx, step: number, attempt: number | undefined, r: Omit<RequestStep, "op">): RequestAttempt {
  const { envelope, trace } = materialiseRequest(ctx, r, step, attempt ?? 0);
  const params = (envelope as { params: { request_id: string; metadata: { session_id: string } } }).params;
  const key = `${r.session}/${r.request}`;
  ctx.toolByKey.set(key, r.tool);
  return { attempt, r, key, trace, sessionId: params.metadata.session_id, requestId: params.request_id, call: invoke(ctx, () => ctx.executor.process(envelope)) };
}

/**
 * One request step (single or concurrent). For each attempt the SUT's authority decision (requestDecision), the
 * Result Guardian decision(s) attributed to it and the observed effects are recorded separately (EffectRecord).
 * Result Guardian events are attributed by the call's own audit window when the call ran alone, otherwise through
 * the SUT's own signed result request (request_id_ref) observed at the harness-owned SignatureService instance;
 * when several attempts share one request id and their result decisions differ, the attribution is ambiguous.
 * Normalised assertions for the oracle comparison are effect-based. An observed execution or delivery is never
 * turned into an AdapterError; an unobservable decision WITHOUT any observed effect is.
 */
async function runRequestStep(ctx: Ctx, step: number, rs: Omit<RequestStep, "op">[], concurrent: boolean): Promise<void> {
  const logFrom = ctx.doubles.log.length;
  const auditFrom = auditLen(ctx);
  const unknownBefore = ctx.sut.executionCounters.unknown_tool ?? 0;
  const atts = rs.map((r, j) => startRequest(ctx, step, concurrent ? j : undefined, r));
  const settled: PromiseSettledResult<unknown>[] = [];
  for (const a of atts) settled.push(await a.call.settled);
  const auditTo = auditLen(ctx);
  const unknownDelta = Math.max(0, (ctx.sut.executionCounters.unknown_tool ?? 0) - unknownBefore);
  const fallbackAttempts = atts.filter((a) => !isHarnessTool(a.r.tool)).length;

  const per = atts.map((a, j) => {
    const o = settled[j];
    const report = sutReport(o, (v) => String((v as { status?: unknown } | undefined)?.status));
    ctx.evidence.push({ step, attempt: a.attempt, call: "process", report });
    const win: AuditWin = concurrent ? [a.call.from, a.call.prefixTo] : [a.call.from, auditTo];
    const d = requestDecision(ctx, o, a.requestId, win);
    let observedExec: number;
    let execution: ChannelObservation;
    if (isHarnessTool(a.r.tool)) {
      observedExec = ctx.doubles.log.slice(logFrom).filter((x) => x.trace === a.trace).length;
      execution = { state: observedExec > 0 ? "observed" : "not_observed", source: "harness_tool_trace" };
    } else {
      observedExec = unknownDelta;
      execution =
        unknownDelta === 0 ? { state: "not_observed", source: "sut_counter" }
        : fallbackAttempts === 1 ? { state: "observed", source: "sut_counter" }
        : { state: "ambiguous", source: "sut_counter", detail: "fallback_counter_delta_shared_by_concurrent_calls" };
    }
    const returned = o.status === "fulfilled" ? (o.value as { result?: unknown } | undefined)?.result : undefined;
    const rawDelivered = deliveredRaw(returned, rawOutputs(ctx, logFrom, (t) => t === a.trace));
    const delivery: ChannelObservation =
      !isHarnessTool(a.r.tool) && observedExec > 0 ? { state: "unavailable", source: "none", detail: "no_raw_output_for_sut_fallback_tool" }
      : { state: rawDelivered ? "observed" : "not_observed", source: "return_value_scan" };
    return { a, o, report, d, observedExec, execution, returned, rawDelivered, delivery };
  });

  // Result Guardian decisions per attempt.
  const rg = rgEvents(ctx, [auditFrom, auditTo]);
  const controls = per.map((p) => {
    const need = p.d.decision === "ALLOW" || p.observedExec > 0;
    if (!concurrent) return resultControl(rgEvents(ctx, [p.a.call.from, auditTo]).map((e) => e.control), need, false);
    if (!need) return resultControl([], false, false);
    const linked = rg.filter((e) => e.link !== undefined && e.link.session === p.a.sessionId && e.link.ref === p.a.requestId).map((e) => e.control);
    const unlinked = rg.some((e) => e.link === undefined);
    const group = per.filter((q) => q.a.sessionId === p.a.sessionId && q.a.requestId === p.a.requestId && (q.d.decision === "ALLOW" || q.observedExec > 0));
    if (group.length <= 1) return resultControl(linked, need, need && linked.length === 0 && unlinked);
    const uniform = linked.length === group.length && linked.every((c) => c !== null && c === linked[0]);
    return uniform ? resultControl([linked[0]], true, false) : resultControl([], true, true);
  });

  const errors: string[] = [];
  per.forEach((p, j) => {
    const { a, d, report, observedExec, rawDelivered } = p;
    const rc = controls[j];
    const authorizedExec = d.decision === "ALLOW" ? 1 : 0;
    ctx.records.push({
      step, ...(a.attempt !== undefined ? { attempt: a.attempt } : {}), stage: "request", key: a.key, attribution: "attempt",
      sut_reports: [report], sut_decisions: [d.decision], decision_sources: [d.source],
      result_control_decisions: rc.decisions, result_control_state: rc.state,
      authorized_executions: authorizedExec, observed_executions: observedExec, execution_observation: p.execution,
      authorized_deliveries: rc.state === "observed" ? Math.min(rc.decisions.filter((c) => c === "DELIVER").length, authorizedExec) : 0,
      observed_raw_deliveries: rawDelivered ? 1 : 0, delivery_observation: p.delivery,
    });

    if (d.decision === "DECISION_NOT_OBSERVED" && observedExec === 0 && !rawDelivered) {
      errors.push(`no SUT authority evidence for process() and no observed effect: ${d.code}`);
      return;
    }
    const as = (stage: "request" | "result", outcome: string, reason: ReasonClass, code: string, enf: string, sutDecision?: string): ObservedAssertion => {
      const o: ObservedAssertion = { step, stage, outcome, reason_class: reason, sut_reason_code: code, enforcement_stage: enf };
      if (a.attempt !== undefined) o.attempt = a.attempt;
      if (sutDecision !== undefined) {
        o.sut_decision = sutDecision;
        o.decision_effect_mismatch = true;
      }
      return o;
    };
    // Normalised request outcome: an observed execution is ALLOW whatever the SUT decided.
    if (observedExec > 0) {
      push(ctx, d.decision === "ALLOW" ? as("request", "ALLOW", d.reason, d.code, d.stage) : as("request", "ALLOW", "DECISION_EFFECT_MISMATCH", d.code, "effect", d.decision));
    } else if (d.decision === "ALLOW") {
      // Authorised, but no execution observed: keep the decision, flag the missing effect.
      push(ctx, as("request", "ALLOW", "DECISION_EFFECT_MISMATCH", "allowed_without_observed_execution", "effect", "ALLOW"));
    } else {
      push(ctx, as("request", d.decision === "ASK" ? "ASK" : "DENY", d.reason, d.code, d.stage));
      if (!rawDelivered) return;
    }
    // Normalised result outcome: DELIVER iff a raw tool output was found in what the call returned.
    const resultOutcome = rawDelivered ? "DELIVER" : "WITHHOLD";
    if (d.postExecution && !rawDelivered) {
      push(ctx, as("result", "WITHHOLD", d.postExecution.reason, d.postExecution.code, "result_path"));
      return;
    }
    const control = rc.state === "observed" ? rc.decisions.join(",") : null;
    if (d.decision === "ALLOW" && observedExec > 0 && control === resultOutcome) {
      push(ctx, as("result", resultOutcome, resultOutcome === "DELIVER" ? "RESULT_POLICY_DELIVER" : "RESULT_POLICY_WITHHOLD", `result_guardian:${control === "DELIVER" ? "allow" : "deny"}`, "result_guardian"));
    } else {
      push(ctx, as("result", resultOutcome, "DECISION_EFFECT_MISMATCH", `result_control:${rc.state}`, "effect", control ?? (rc.state === "observed" ? "NONE" : "DECISION_NOT_OBSERVED")));
    }
  });
  ctx.records.push(...strayRecords(ctx, step, logFrom, new Set(atts.map((a) => a.trace)), per.map((p) => p.returned)));
  if (errors.length > 0) throw new AdapterError(errors[0]);
}

interface ApprovalAttempt extends Decided {
  attempt: number | undefined;
  key: string;
  report: SutReport;
  returned: unknown;
  /** Normalised outcome after reconciliation with observed effects. */
  outcome?: "EXECUTE" | "REJECT";
}

function effectiveGrantKey(g: GrantSpec): string {
  let session = g.session;
  let request = g.request;
  if (g.tamper?.field === "session") session = g.tamper.value;
  if (g.tamper?.field === "request") request = g.tamper.value;
  return `${session}/${request}`;
}

/**
 * One approval step (single or concurrent). Effects are attributed per target request key: exactly for a
 * single approval, aggregated over the step's attempts on that key for a concurrent step (the executions of one
 * pending request are fungible, so aggregate counts are exact; per-attempt Result Guardian attribution is not,
 * and mixed result decisions on one key are reported as ambiguous). Normalised approval outcomes follow the
 * observed executions (surplus executions turn REJECT/not-observed decisions into EXECUTE; authorised executions
 * without an effect become REJECT, preferring the ones that failed on the result path). Executions of keys no
 * attempt targeted become records without any authorising decision; untraced or fallback-counter executions that
 * cannot be attributed become ambiguous records.
 */
async function runApprovalStep(ctx: Ctx, step: number, grants: GrantSpec[], concurrent: boolean): Promise<void> {
  const logFrom = ctx.doubles.log.length;
  const auditFrom = auditLen(ctx);
  const unknownBefore = ctx.sut.executionCounters.unknown_tool ?? 0;
  const materialised = grants.map((g) => materialiseGrant(ctx, g));
  // Start all calls in array order without awaiting in between (a single call for a non-concurrent step).
  const calls = materialised.map((g) => invoke(ctx, () => ctx.executor.resolveApproval(g)));
  const settled: PromiseSettledResult<unknown>[] = [];
  for (const c of calls) settled.push(await c.settled);
  const auditTo = auditLen(ctx);
  const attempts: ApprovalAttempt[] = settled.map((o, j) => {
    const report = sutReport(o, (v) => (v === undefined ? "undefined" : "result"));
    const attempt = concurrent ? j : undefined;
    ctx.evidence.push({ step, attempt, call: "resolveApproval", report });
    const win: AuditWin = concurrent ? [calls[j].from, calls[j].prefixTo] : [calls[j].from, auditTo];
    return { attempt, key: effectiveGrantKey(grants[j]), report, returned: o.status === "fulfilled" ? o.value : undefined, ...approvalDecision(ctx, String(materialised[j].request_id), o, win) };
  });

  const observedByKey = new Map<string | null, number>();
  for (const rec of ctx.doubles.log.slice(logFrom)) {
    const k = rec.trace === null ? null : traceKey(rec.trace);
    observedByKey.set(k, (observedByKey.get(k) ?? 0) + 1);
  }
  // SUT fallback-tool executions: attributable only to the single attempt of a non-concurrent step whose pending
  // request used a non-harness tool.
  const unknownDelta = Math.max(0, (ctx.sut.executionCounters.unknown_tool ?? 0) - unknownBefore);
  let counterKey: string | null = null;
  let counterAmbiguous = 0;
  if (unknownDelta > 0) {
    if (!concurrent && ctx.toolByKey.has(attempts[0].key) && !isHarnessTool(ctx.toolByKey.get(attempts[0].key))) counterKey = attempts[0].key;
    else counterAmbiguous = unknownDelta;
  }
  if (counterKey !== null) observedByKey.set(counterKey, (observedByKey.get(counterKey) ?? 0) + unknownDelta);

  const rg = rgEvents(ctx, [auditFrom, auditTo]);
  const errors: string[] = [];
  const controlByKey = new Map<string, ResultControl>();
  const keys = new Set<string | null>([...attempts.map((x) => x.key), ...observedByKey.keys()]);
  for (const key of keys) {
    const as = attempts.filter((x) => x.key === key);
    const observed = observedByKey.get(key) ?? 0;
    const outputs = rawOutputs(ctx, logFrom, (t) => t !== null && traceKey(t) === key);
    const authorized = as.filter((x) => x.decision === "EXECUTE").length;
    const rawDeliveries = as.filter((x) => deliveredRaw(x.returned, outputs)).length;
    const need = authorized > 0 || observed > 0;
    let rc: ResultControl;
    if (key === null) rc = { decisions: [], state: "not_applicable" };
    else if (!concurrent) rc = resultControl(rgEvents(ctx, [calls[0].from, auditTo]).map((e) => e.control), need, false);
    else {
      const [sLabel, rLabel] = key.split("/");
      const linked = rg.filter((e) => e.link !== undefined && e.link.session === sid(ctx, sLabel) && e.link.ref === rid(ctx, rLabel)).map((e) => e.control);
      rc = resultControl(linked, need, need && linked.length === 0 && rg.some((e) => e.link === undefined));
    }
    if (key !== null) controlByKey.set(key, rc);
    const viaCounter = key !== null && key === counterKey;
    ctx.records.push({
      step, ...(!concurrent && as.length === 1 && as[0].attempt !== undefined ? { attempt: as[0].attempt } : {}),
      stage: "approval", key, attribution: key === null ? "unattributed" : concurrent ? "step_key" : "attempt",
      sut_reports: as.map((x) => x.report), sut_decisions: as.map((x) => x.decision), decision_sources: as.map((x) => x.source),
      result_control_decisions: rc.decisions, result_control_state: rc.state,
      authorized_executions: authorized, observed_executions: observed,
      execution_observation:
        key === null ? { state: "ambiguous", source: "harness_tool_trace", detail: "execution_without_trace" }
        : { state: observed > 0 ? "observed" : "not_observed", source: viaCounter ? "sut_counter" : "harness_tool_trace" },
      authorized_deliveries: rc.state === "observed" ? Math.min(rc.decisions.filter((c) => c === "DELIVER").length, authorized) : 0,
      observed_raw_deliveries: rawDeliveries,
      delivery_observation:
        key === null ? { state: "ambiguous", source: "return_value_scan", detail: "execution_without_trace" }
        : viaCounter ? { state: "unavailable", source: "none", detail: "no_raw_output_for_sut_fallback_tool" }
        : { state: rawDeliveries > 0 ? "observed" : "not_observed", source: "return_value_scan" },
    });
    // Reconcile normalised outcomes with the observed effect for this key.
    for (const x of as) x.outcome = x.decision === "EXECUTE" ? "EXECUTE" : "REJECT";
    let surplus = observed - authorized;
    for (const x of as) {
      if (surplus <= 0) break;
      if (x.outcome === "REJECT") {
        x.outcome = "EXECUTE";
        surplus--;
      }
    }
    let missing = authorized - observed;
    const claims = [...as.filter((x) => x.outcome === "EXECUTE" && x.decision === "EXECUTE" && x.postExecution), ...as.filter((x) => x.outcome === "EXECUTE" && x.decision === "EXECUTE" && !x.postExecution)];
    for (const x of claims) {
      if (missing <= 0) break;
      x.outcome = "REJECT";
      missing--;
    }
    for (const x of as) {
      if (x.decision === "DECISION_NOT_OBSERVED" && x.outcome === "REJECT" && !deliveredRaw(x.returned, outputs)) {
        errors.push(`no SUT authority evidence for resolveApproval() and no observed effect: ${x.code}`);
      }
    }
  }
  if (counterAmbiguous > 0) {
    ctx.records.push({
      step, stage: "approval", key: null, attribution: "unattributed", sut_reports: [], sut_decisions: [], decision_sources: [],
      result_control_decisions: [], result_control_state: "not_applicable",
      authorized_executions: 0, observed_executions: counterAmbiguous, execution_observation: { state: "ambiguous", source: "sut_counter", detail: "fallback_counter_delta_not_attributable" },
      authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observation: { state: "ambiguous", source: "none", detail: "fallback_counter_delta_not_attributable" },
    });
  }
  if (errors.length > 0) throw new AdapterError(errors[0]);

  for (const x of attempts) {
    const a = (stage: "approval" | "result", outcome: string, reason: ReasonClass, code: string, enf: string, sutDecision?: string): ObservedAssertion => {
      const o: ObservedAssertion = { step, stage, outcome, reason_class: reason, sut_reason_code: code, enforcement_stage: enf };
      if (x.attempt !== undefined) o.attempt = x.attempt;
      if (sutDecision !== undefined) {
        o.sut_decision = sutDecision;
        o.decision_effect_mismatch = true;
      }
      return o;
    };
    const outcome = x.outcome!;
    const decidedOutcome = x.decision === "EXECUTE" ? "EXECUTE" : "REJECT";
    push(ctx, outcome === decidedOutcome && x.decision !== "DECISION_NOT_OBSERVED" ? a("approval", outcome, x.reason, x.code, x.stage) : a("approval", outcome, "DECISION_EFFECT_MISMATCH", x.code, "effect", x.decision));
    if (outcome !== "EXECUTE") continue;
    const outputs = rawOutputs(ctx, logFrom, (t) => t !== null && traceKey(t) === x.key);
    const rawDelivered = deliveredRaw(x.returned, outputs);
    const resultOutcome = rawDelivered ? "DELIVER" : "WITHHOLD";
    if (x.postExecution && !rawDelivered) {
      push(ctx, a("result", "WITHHOLD", x.postExecution.reason, x.postExecution.code, "result_path"));
      continue;
    }
    const rc = controlByKey.get(x.key) ?? { decisions: [], state: "not_observed" as const };
    // Per-attempt control: exact for a single approval; for a concurrent step only when the key's decisions are uniform.
    const control = rc.state === "observed" && new Set(rc.decisions).size === 1 ? rc.decisions[0] : null;
    if (x.decision === "EXECUTE" && control === resultOutcome) {
      push(ctx, a("result", resultOutcome, resultOutcome === "DELIVER" ? "RESULT_POLICY_DELIVER" : "RESULT_POLICY_WITHHOLD", `result_guardian:${control === "DELIVER" ? "allow" : "deny"}`, "result_guardian"));
    } else {
      push(ctx, a("result", resultOutcome, "DECISION_EFFECT_MISMATCH", `result_control:${rc.state}`, "effect", control ?? (rc.state === "observed" ? rc.decisions.join(",") : "DECISION_NOT_OBSERVED")));
    }
  }
}

function countExecutions(log: readonly { trace: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rec of log) if (rec.trace !== null) out[traceKey(rec.trace)] = (out[traceKey(rec.trace)] ?? 0) + 1;
  return out;
}

/** Stateless SUT components may be shared across cases; all stateful ones are created per case. */
let sharedSchemaValidator: unknown = null;

export async function runRuntimeCase(c: CaseForAdapter, sut: SutModules, keys: AdapterKeys): Promise<{ observations: Observations; evidence: unknown }> {
  sharedSchemaValidator ??= new sut.SchemaValidator();
  const scenario = c.scenario as RuntimeScenario;
  const clock = { base: Date.now(), offset: 0 };
  const evalClock = { nowMs: () => clock.base + clock.offset };
  const audit = new sut.AuditCollector();
  const signer = new sut.SignatureService(REQUEST_ROOT_SECRET, REQUEST_KEY_ID);
  // Observe (pass-through) the SUT's own result requests to link each Result Guardian audit event (keyed by the
  // result request id) to the request it belongs to (request_id_ref). Nothing is changed or decided here.
  const resultLinks = new Map<string, { session: string; ref: string }>();
  const signRequest = signer.signRequest.bind(signer);
  signer.signRequest = (req: { method?: unknown; params?: { request_id?: unknown; metadata?: { session_id?: unknown }; payload?: { request_id_ref?: unknown } } }) => {
    const p = req?.params;
    if (req?.method === "steps/toolCallResult" && typeof p?.request_id === "string" && typeof p.payload?.request_id_ref === "string" && typeof p.metadata?.session_id === "string") {
      resultLinks.set(p.request_id, { session: p.metadata.session_id, ref: p.payload.request_id_ref });
    }
    return signRequest(req);
  };
  const capQueue = new Map<string, unknown[]>();
  const provider = {
    resolve(lc: { session_id: string; request_id: string }) {
      const q = capQueue.get(`${lc.session_id}:${lc.request_id}`);
      if (!q || q.length === 0) throw new AdapterError("capability provider: no capability queued for request");
      return q.shift();
    },
  };
  const executor = new sut.GuardedExecutor(
    sharedSchemaValidator,
    signer,
    new sut.ReplayGuard({ skewWindowMs: DECLARED_POLICY.request_skew_window_ms, clock: evalClock, audit }),
    new sut.Guardian(),
    audit,
    new sut.ExecutionCorrelationStore(),
    new sut.ApprovalGrantVerifier(keys.approver.publicKey, APPROVER_KEY_ID),
    evalClock,
    DECLARED_POLICY.approval_future_skew_ms,
    provider,
    new sut.CapabilityGrantVerifier(keys.capability.publicKey, CAPABILITY_KEY_ID, evalClock),
  );
  const outputs = new Map<string, unknown>();
  const doubles = new ToolDoubles(sut.tools, outputs, HARNESS_TOOLS);
  const ctx: Ctx = { c, sut, keys, clock, executor, audit, signer, doubles, outputs, capQueue, obs: [], evidence: [], records: [], resultLinks, toolByKey: new Map() };
  const unknownBefore = sut.executionCounters.unknown_tool ?? 0;
  doubles.install();
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      switch (step.op) {
        case "request":
          await runRequestStep(ctx, i, [step], false);
          break;
        case "concurrent_request":
          // Starts all calls in array order without awaiting in between.
          await runRequestStep(ctx, i, step.requests, true);
          break;
        case "approve":
          await runApprovalStep(ctx, i, [step.grant], false);
          break;
        case "concurrent_approve":
          await runApprovalStep(ctx, i, step.grants, true);
          break;
        case "advance_clock":
          clock.offset += step.ms;
          break;
        case "clear_session":
          executor.clearSession(sid(ctx, step.session));
          ctx.evidence.push({ step: i, call: "clearSession" });
          break;
        default:
          throw new AdapterError(`unknown op ${(step as { op: string }).op}`);
      }
    }
  } catch (e) {
    if (e instanceof AdapterError) {
      // Keep everything observed so far (decisions and effects) next to the error.
      (e as AdapterError & { partial?: unknown }).partial = {
        assertions: ctx.obs,
        executions: countExecutions(doubles.log),
        unattributed_executions: doubles.log.filter((x) => x.trace === null).length + ((sut.executionCounters.unknown_tool ?? 0) - unknownBefore),
        effect_records: ctx.records,
        calls: ctx.evidence,
      };
    }
    throw e;
  } finally {
    doubles.restore();
  }
  const executions = countExecutions(doubles.log);
  const unattributed = doubles.log.filter((x) => x.trace === null).length + ((sut.executionCounters.unknown_tool ?? 0) - unknownBefore);
  const auditTypes = (audit.getEvents() as { event_type: string; metadata?: Record<string, unknown> }[]).map((e) =>
    typeof e.metadata?.reason === "string" ? `${e.event_type}:${e.metadata.reason}` : e.event_type,
  );
  return {
    observations: { assertions: ctx.obs, executions, unattributed_executions: unattributed, effect_records: ctx.records },
    evidence: { calls: ctx.evidence, audit_event_types: auditTypes, audit_integrity: audit.verifyIntegrity().valid ?? null },
  };
}
