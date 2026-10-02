/**
 * ACS runtime-boundary adapter: materialises a runtime scenario into calls on
 * the pinned GuardedExecutor public API (process, resolveApproval,
 * clearSession) and normalises what the SUT did into observations.
 *
 * This module contains integration logic only. It never decides what SHOULD
 * happen. Outcomes about execution are effect-based (observed through the
 * harness tool doubles); the SUT's own report is kept separately when the two
 * disagree. Unknown/unclassifiable SUT behaviour WITHOUT an observed execution
 * becomes an AdapterError, never a DENY/REJECT/WITHHOLD; an observed execution
 * is never turned into an AdapterError.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { ReasonClass } from "../../spec/reason-taxonomy";
import type { EffectRecord, ObservedAssertion, Observations, ResultControlDecision, SutDecision, SutReport } from "../protocol";
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

/** Last audit event of the given type for the given SUT request id (audit is per case). */
function lastAudit(ctx: Ctx, type: string, requestId?: string): { metadata?: Record<string, unknown> } | undefined {
  const events: { event_type: string; request_id: string; metadata?: Record<string, unknown> }[] = ctx.audit.getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event_type === type && (requestId === undefined || events[i].request_id === requestId)) return events[i];
  }
  return undefined;
}

/** Errors that can only arise after the tool ran (internal result path). */
function postExecutionReason(ctx: Ctx, e: unknown): { reason: ReasonClass; code: string } | null {
  const i = errInfo(e);
  if (e instanceof ctx.sut.CorrelationError) return { reason: "CORRELATION_FAILURE", code: `${i.name}` };
  if (e instanceof ctx.sut.ReplayGuardError) return { reason: "RESULT_PATH_REJECTED", code: `${i.name}:${i.code}` };
  return null;
}

function classifyRequestRejection(ctx: Ctx, e: unknown, requestId: string): { reason: ReasonClass; stage: string; code: string } {
  const i = errInfo(e);
  if (e instanceof ctx.sut.SignatureInvalidError) return { reason: "REQUEST_SIGNATURE_INVALID", stage: "request_signature", code: `${i.name}` };
  if (e instanceof ctx.sut.ReplayGuardError) {
    if (i.code === "REPLAY_DETECTED") return { reason: "REPLAY_DETECTED", stage: "replay_guard", code: `${i.name}:${i.code}` };
    if (i.code === "TIMESTAMP_OUT_OF_WINDOW" || i.code === "TIMESTAMP_INVALID") return { reason: "TIMESTAMP_OUT_OF_WINDOW", stage: "replay_guard", code: `${i.name}:${i.code}` };
  }
  if (e instanceof ctx.sut.AddressableSchemaError || e instanceof ctx.sut.SchemaValidationError) {
    return { reason: "REQUEST_SCHEMA_INVALID", stage: "schema", code: `${i.name}` };
  }
  if (i.message === "Missing capability") return { reason: "CAPABILITY_MISSING", stage: "capability", code: "missing_capability" };
  if (i.message.startsWith("Capability rejected: ")) {
    const ev = lastAudit(ctx, "capability_rejected", requestId);
    const auditReason = typeof ev?.metadata?.reason === "string" ? (ev.metadata.reason as string) : "";
    const reason = CAPABILITY_AUDIT_REASON[auditReason];
    if (reason) return { reason, stage: "capability", code: auditReason };
  }
  if (i.message.startsWith("Execution blocked (deny)")) {
    const ev = lastAudit(ctx, "guardian_decision", requestId);
    if (ev?.metadata?.decision === "deny") return { reason: "POLICY_DENY", stage: "guardian", code: "guardian:deny" };
  }
  throw new AdapterError(`unclassified SUT exception on process(): ${i.name}: ${i.message}`);
}

function classifyApprovalRejection(ctx: Ctx, e: unknown): { reason: ReasonClass; stage: string; code: string } {
  const i = errInfo(e);
  if (e instanceof ctx.sut.ApprovalVerificationError) {
    const reason = APPROVAL_CODE_REASON[i.code];
    if (reason) return { reason, stage: "approval_verifier", code: `${i.name}:${i.code}` };
  }
  if (i.message.startsWith("No pending action found")) return { reason: "PENDING_ACTION_NOT_FOUND", stage: "approval_lookup", code: "pending_action_not_found" };
  if (i.message === "Approval grant rejected: issued_at is before ASK creation") return { reason: "APPROVAL_BEFORE_ASK", stage: "approval_freshness", code: "issued_at_before_ask" };
  if (i.message === "Approval grant rejected: issued_at is unreasonably in the future") return { reason: "APPROVAL_FUTURE_SKEW", stage: "approval_freshness", code: "issued_at_future" };
  if (i.message === "Approval grant rejected: pending action has expired") return { reason: "APPROVAL_EXPIRED", stage: "approval_expiry", code: "approval_expired" };
  throw new AdapterError(`unclassified SUT exception on resolveApproval(): ${i.name}: ${i.message}`);
}

/** Map an audit result-guardian decision to the result-control vocabulary. */
function controlFromGuardian(decision: unknown): ResultControlDecision {
  return decision === "deny" ? "WITHHOLD" : decision === "allow" ? "DELIVER" : "UNKNOWN";
}

function controlFromExitStatus(v: unknown): ResultControlDecision | null {
  if (!v || typeof v !== "object") return null;
  const es = (v as { exit_status?: unknown }).exit_status;
  if (es === "blocked") return "WITHHOLD";
  if (es === "success" || es === "failure" || es === "timeout") return "DELIVER";
  return "UNKNOWN";
}

/** Audit events appended since `from` (exclusive window [from, to)). */
function auditWindow(ctx: Ctx, from: number, to: number): { event_type: string; request_id: string; metadata?: Record<string, unknown> }[] {
  return (ctx.audit.getEvents() as { event_type: string; request_id: string; metadata?: Record<string, unknown> }[]).slice(from, to);
}

/**
 * The SUT's result-control decisions for one call. Exact calls (no other call in flight) use the Result
 * Guardian's own audit decisions recorded during the call; concurrent calls fall back to the exit_status of
 * the value the call returned.
 */
function resultControlFor(ctx: Ctx, exact: boolean, auditFrom: number, auditTo: number, returned: unknown): ResultControlDecision[] {
  if (exact) {
    const ev = auditWindow(ctx, auditFrom, auditTo).filter((e) => e.event_type === "result_guardian_decision");
    if (ev.length > 0) return ev.map((e) => controlFromGuardian(e.metadata?.decision));
  }
  const c = controlFromExitStatus(returned);
  return c ? [c] : [];
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

interface RequestDecision {
  decision: SutDecision;
  reason: ReasonClass;
  code: string;
  stage: string;
  /** Set when a rejection came from the SUT's internal result path (the request itself was authorised). */
  postExecution?: { reason: ReasonClass; code: string };
}

/** SUT decision for process(), from its report and its own audit trail only (never from observed effects). */
function requestDecision(ctx: Ctx, o: PromiseSettledResult<unknown>, requestId: string): RequestDecision {
  if (o.status === "fulfilled") {
    const st = (o.value as { status?: unknown } | undefined)?.status;
    if (st === "pending") return { decision: "ASK", reason: "POLICY_ASK", code: "guardian:ask", stage: "guardian" };
    if (st === "executed") return { decision: "ALLOW", reason: "POLICY_ALLOW", code: "guardian:allow", stage: "guardian" };
    return { decision: "UNCLASSIFIED", reason: "DECISION_EFFECT_MISMATCH", code: `unknown_status:${JSON.stringify(st)}`, stage: "unclassified" };
  }
  const e = o.reason;
  const i = errInfo(e);
  if (e instanceof ctx.sut.CorrelationError) {
    return { decision: "ALLOW", reason: "POLICY_ALLOW", code: "guardian:allow", stage: "guardian", postExecution: { reason: "CORRELATION_FAILURE", code: i.name } };
  }
  if (e instanceof ctx.sut.ReplayGuardError) {
    // Request-level iff the SUT's replay/timestamp audit event names THIS request id; otherwise the SUT
    // rejected its internally generated result request, i.e. after authorising the request.
    const own = lastAudit(ctx, "replay_rejected", requestId) ?? lastAudit(ctx, "timestamp_rejected", requestId);
    if (!own) return { decision: "ALLOW", reason: "POLICY_ALLOW", code: "guardian:allow", stage: "guardian", postExecution: { reason: "RESULT_PATH_REJECTED", code: `${i.name}:${i.code}` } };
  }
  try {
    const c = classifyRequestRejection(ctx, e, requestId);
    return { decision: "DENY", ...c };
  } catch (ce) {
    if (!(ce instanceof AdapterError)) throw ce;
    return { decision: "UNCLASSIFIED", reason: "DECISION_EFFECT_MISMATCH", code: `unclassified:${i.name}:${i.message}`, stage: "unclassified" };
  }
}

/**
 * Request attempt. Records the SUT's decision and the observed effects separately (EffectRecord), and emits
 * effect-based normalised assertions for the oracle comparison. An observed execution or delivery is never
 * turned into an AdapterError; an unclassifiable SUT report WITHOUT any observed effect is (the decision
 * channel could not produce a reliable observation).
 */
async function runRequest(ctx: Ctx, step: number, attempt: number | undefined, r: Omit<RequestStep, "op">, exact: boolean): Promise<void> {
  const { envelope, trace } = materialiseRequest(ctx, r, step, attempt ?? 0);
  const requestId = (envelope as { params: { request_id: string } }).params.request_id;
  const key = `${r.session}/${r.request}`;
  const harnessTool = (HARNESS_TOOLS as readonly string[]).includes(r.tool);
  const unknownBefore = ctx.sut.executionCounters.unknown_tool ?? 0;
  const logFrom = ctx.doubles.log.length;
  const auditFrom = ctx.audit.getEvents().length;
  let settled: PromiseSettledResult<unknown>;
  try {
    settled = { status: "fulfilled", value: await ctx.executor.process(envelope) };
  } catch (e) {
    settled = { status: "rejected", reason: e };
  }
  const auditTo = ctx.audit.getEvents().length;
  const report = sutReport(settled, (v) => String((v as { status?: unknown } | undefined)?.status));
  ctx.evidence.push({ step, attempt, call: "process", report });

  const observedExec =
    ctx.doubles.log.slice(logFrom).filter((x) => x.trace === trace).length +
    (!harnessTool ? Math.max(0, (ctx.sut.executionCounters.unknown_tool ?? 0) - unknownBefore) : 0);
  const d = requestDecision(ctx, settled, requestId);
  const returned = settled.status === "fulfilled" ? (settled.value as { result?: unknown } | undefined)?.result : undefined;
  const controls = d.decision === "ALLOW" && !d.postExecution ? resultControlFor(ctx, exact, auditFrom, auditTo, returned) : [];
  const rawDelivered = deliveredRaw(returned, rawOutputs(ctx, logFrom, (t) => t === trace));
  const authorizedExec = d.decision === "ALLOW" ? 1 : 0;
  const authorizedDelivery = d.decision === "ALLOW" && controls.includes("DELIVER") ? 1 : 0;
  ctx.records.push({
    step, ...(attempt !== undefined ? { attempt } : {}), stage: "request", key, attribution: "attempt",
    sut_reports: [report], sut_decisions: [d.decision], result_control_decisions: controls,
    authorized_executions: authorizedExec, observed_executions: observedExec,
    authorized_deliveries: authorizedDelivery, observed_raw_deliveries: rawDelivered ? 1 : 0, delivery_observed: true,
  });

  if (d.decision === "UNCLASSIFIED" && observedExec === 0 && !rawDelivered) {
    throw new AdapterError(`unclassified SUT report on process() without an observed effect: ${d.code}`);
  }
  const a = (stage: "request" | "result", outcome: string, reason: ReasonClass, code: string, enf: string, sutDecision?: string): ObservedAssertion => {
    const o: ObservedAssertion = { step, stage, outcome, reason_class: reason, sut_reason_code: code, enforcement_stage: enf };
    if (attempt !== undefined) o.attempt = attempt;
    if (sutDecision !== undefined) {
      o.sut_decision = sutDecision;
      o.decision_effect_mismatch = true;
    }
    return o;
  };
  // Normalised request outcome: an observed execution is ALLOW whatever the SUT reported.
  if (observedExec > 0) {
    push(ctx, d.decision === "ALLOW" ? a("request", "ALLOW", d.reason, d.code, d.stage) : a("request", "ALLOW", "DECISION_EFFECT_MISMATCH", d.code, "effect", d.decision));
  } else if (d.decision === "ALLOW") {
    // Authorised and (claimed) executed, but no execution observed: keep the decision, flag the missing effect.
    push(ctx, a("request", "ALLOW", "DECISION_EFFECT_MISMATCH", "executed_without_observed_execution", "effect", "ALLOW"));
  } else {
    push(ctx, a("request", d.decision === "ASK" ? "ASK" : "DENY", d.reason, d.code, d.stage));
    if (!rawDelivered) return;
  }
  // Normalised result outcome: DELIVER iff a raw tool output was found in what the call returned.
  const resultOutcome = rawDelivered ? "DELIVER" : "WITHHOLD";
  if (d.postExecution && !rawDelivered) {
    push(ctx, a("result", "WITHHOLD", d.postExecution.reason, d.postExecution.code, "result_path"));
    return;
  }
  const control = controls.length === 1 ? controls[0] : controls.length === 0 ? null : controls.join(",");
  const consistent = d.decision === "ALLOW" && observedExec > 0 && control !== null && control === resultOutcome;
  if (consistent) {
    push(ctx, a("result", resultOutcome, resultOutcome === "DELIVER" ? "RESULT_POLICY_DELIVER" : "RESULT_POLICY_WITHHOLD", `result_guardian:${control === "DELIVER" ? "allow" : "deny"}`, "result_guardian"));
  } else {
    push(ctx, a("result", resultOutcome, "DECISION_EFFECT_MISMATCH", `exit_status:${report.exit_status ?? "none"}`, "effect", control === null ? "NONE" : control));
  }
}

interface ApprovalAttempt {
  attempt: number | undefined;
  key: string;
  report: SutReport;
  decision: SutDecision;
  reason: ReasonClass;
  code: string;
  stage: string;
  returned: unknown;
  postExecution?: { reason: ReasonClass; code: string };
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

/** SUT decision for resolveApproval(), from its report and audit only. */
function approvalDecision(ctx: Ctx, g: GrantSpec, o: PromiseSettledResult<unknown>): Omit<ApprovalAttempt, "attempt" | "key" | "report" | "returned"> {
  if (o.status === "rejected") {
    const e = o.reason;
    const i = errInfo(e);
    // resolveApproval() runs the replay guard and correlation only on its internal result request,
    // i.e. after it authorised and started the execution.
    const post = postExecutionReason(ctx, e);
    if (post) return { decision: "EXECUTE", reason: "APPROVAL_GRANTED", code: "human_approval", stage: "human", postExecution: post };
    try {
      const c = classifyApprovalRejection(ctx, e);
      return { decision: "REJECT", ...c };
    } catch (ce) {
      if (!(ce instanceof AdapterError)) throw ce;
      return { decision: "UNCLASSIFIED", reason: "DECISION_EFFECT_MISMATCH", code: `unclassified:${i.name}:${i.message}`, stage: "unclassified" };
    }
  }
  const value = o.value;
  if (value === undefined) {
    const ev = lastAudit(ctx, "human_rejection", rid(ctx, g.request));
    if (ev) return { decision: "REJECT", reason: "HUMAN_REJECTED", code: "human_rejection", stage: "human" };
    return { decision: "UNCLASSIFIED", reason: "DECISION_EFFECT_MISMATCH", code: "returned_without_result_or_rejection_evidence", stage: "unclassified" };
  }
  return { decision: "EXECUTE", reason: "APPROVAL_GRANTED", code: "human_approval", stage: "human" };
}

/**
 * One approval step (single or concurrent). Effects are attributed per target request key: exactly for a
 * single approval, aggregated over the step's attempts on that key for a concurrent step. Normalised
 * approval outcomes follow the observed executions (surplus executions turn REJECT/UNCLASSIFIED decisions
 * into EXECUTE; claimed executions without an effect become REJECT, preferring claims that were inferred from
 * exceptions). Executions of keys no attempt targeted, and fallback-tool executions, become records without
 * any authorising decision.
 */
async function runApprovalStep(ctx: Ctx, step: number, grants: GrantSpec[], concurrent: boolean): Promise<void> {
  const logFrom = ctx.doubles.log.length;
  const auditFrom = ctx.audit.getEvents().length;
  const unknownBefore = ctx.sut.executionCounters.unknown_tool ?? 0;
  const materialised = grants.map((g) => materialiseGrant(ctx, g));
  let settled: PromiseSettledResult<unknown>[];
  if (concurrent) {
    // Start all calls in array order without awaiting in between.
    settled = await Promise.allSettled(materialised.map((g) => ctx.executor.resolveApproval(g)));
  } else {
    try {
      settled = [{ status: "fulfilled", value: await ctx.executor.resolveApproval(materialised[0]) }];
    } catch (e) {
      settled = [{ status: "rejected", reason: e }];
    }
  }
  const auditTo = ctx.audit.getEvents().length;
  const attempts: ApprovalAttempt[] = settled.map((o, j) => {
    const report = sutReport(o, (v) => (v === undefined ? "undefined" : "result"));
    ctx.evidence.push({ step, attempt: concurrent ? j : undefined, call: "resolveApproval", report });
    return { attempt: concurrent ? j : undefined, key: effectiveGrantKey(grants[j]), report, returned: o.status === "fulfilled" ? o.value : undefined, ...approvalDecision(ctx, grants[j], o) };
  });

  const observedByKey = new Map<string | null, number>();
  for (const rec of ctx.doubles.log.slice(logFrom)) {
    const k = rec.trace === null ? null : traceKey(rec.trace);
    observedByKey.set(k, (observedByKey.get(k) ?? 0) + 1);
  }
  const unknownDelta = Math.max(0, (ctx.sut.executionCounters.unknown_tool ?? 0) - unknownBefore);
  if (unknownDelta > 0) observedByKey.set(null, (observedByKey.get(null) ?? 0) + unknownDelta);

  const keys = new Set<string | null>([...attempts.map((x) => x.key), ...observedByKey.keys()]);
  for (const key of keys) {
    const as = attempts.filter((x) => x.key === key);
    const observed = observedByKey.get(key) ?? 0;
    const outputs = rawOutputs(ctx, logFrom, (t) => t !== null && traceKey(t) === key);
    const authorized = as.filter((x) => x.decision === "EXECUTE").length;
    const controls: ResultControlDecision[] = [];
    let authorizedDeliveries = 0;
    let rawDeliveries = 0;
    for (const x of as) {
      const c = x.decision === "EXECUTE" && !x.postExecution ? resultControlFor(ctx, !concurrent, auditFrom, auditTo, x.returned) : [];
      controls.push(...c);
      if (x.decision === "EXECUTE" && c.includes("DELIVER")) authorizedDeliveries++;
      if (deliveredRaw(x.returned, outputs)) rawDeliveries++;
    }
    ctx.records.push({
      step, ...(!concurrent && as.length === 1 && as[0].attempt !== undefined ? { attempt: as[0].attempt } : {}),
      stage: "approval", key, attribution: concurrent ? "step_key" : "attempt",
      sut_reports: as.map((x) => x.report), sut_decisions: as.map((x) => x.decision), result_control_decisions: controls,
      authorized_executions: authorized, observed_executions: observed,
      authorized_deliveries: authorizedDeliveries, observed_raw_deliveries: rawDeliveries, delivery_observed: true,
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
      if (x.decision === "UNCLASSIFIED" && x.outcome === "REJECT" && !deliveredRaw(x.returned, outputs)) {
        throw new AdapterError(`unclassified SUT report on resolveApproval() without an observed effect: ${x.code}`);
      }
    }
  }

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
    push(ctx, outcome === decidedOutcome && x.decision !== "UNCLASSIFIED" ? a("approval", outcome, x.reason, x.code, x.stage) : a("approval", outcome, "DECISION_EFFECT_MISMATCH", x.code, "effect", x.decision));
    if (outcome !== "EXECUTE") continue;
    const outputs = rawOutputs(ctx, logFrom, (t) => t !== null && traceKey(t) === x.key);
    const rawDelivered = deliveredRaw(x.returned, outputs);
    const resultOutcome = rawDelivered ? "DELIVER" : "WITHHOLD";
    if (x.postExecution && !rawDelivered) {
      push(ctx, a("result", "WITHHOLD", x.postExecution.reason, x.postExecution.code, "result_path"));
      continue;
    }
    const c = x.decision === "EXECUTE" ? resultControlFor(ctx, !concurrent, auditFrom, auditTo, x.returned) : [];
    const control = c.length === 1 ? c[0] : c.length === 0 ? null : c.join(",");
    if (x.decision === "EXECUTE" && control === resultOutcome) {
      push(ctx, a("result", resultOutcome, resultOutcome === "DELIVER" ? "RESULT_POLICY_DELIVER" : "RESULT_POLICY_WITHHOLD", `result_guardian:${control === "DELIVER" ? "allow" : "deny"}`, "result_guardian"));
    } else {
      push(ctx, a("result", resultOutcome, "DECISION_EFFECT_MISMATCH", `exit_status:${x.report.exit_status ?? "none"}`, "effect", control === null ? "NONE" : control));
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
  const ctx: Ctx = { c, sut, keys, clock, executor, audit, signer, doubles, outputs, capQueue, obs: [], evidence: [], records: [] };
  const unknownBefore = sut.executionCounters.unknown_tool ?? 0;
  doubles.install();
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      switch (step.op) {
        case "request":
          await runRequest(ctx, i, undefined, step, true);
          break;
        case "concurrent_request":
          // Start all calls in array order without awaiting in between.
          await Promise.all(step.requests.map((r, j) => runRequest(ctx, i, j, r, false)));
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
