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
import type { DecisionEffectMismatch, ObservedAssertion, Observations } from "../protocol";
import type { CapabilitySpec, CaseForAdapter, GrantSpec, RequestStep, RuntimeScenario } from "../../corpus/types";
import { DECLARED_POLICY } from "../../spec/declared-policy";
import type { SutModules } from "./sut";
import { makeTrace, ToolDoubles, TRACE_ARG, traceKey } from "./tool-doubles";

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
  mismatches: DecisionEffectMismatch[];
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

function resultObservation(_ctx: Ctx, step: number, attempt: number | undefined, result: { exit_status?: string; request_id_ref?: string }): ObservedAssertion {
  const a = (outcome: string, reason: ReasonClass, code: string): ObservedAssertion => {
    const o: ObservedAssertion = { step, stage: "result", outcome, reason_class: reason, sut_reason_code: code, enforcement_stage: "result_guardian" };
    if (attempt !== undefined) o.attempt = attempt;
    return o;
  };
  if (!result || typeof result !== "object") throw new AdapterError("SUT returned a non-object tool result");
  if (result.exit_status === "blocked") {
    // The pinned SUT's withheld representation: exit_status "blocked" and a single policy error output.
    const outs = (result as { outputs?: { value?: { error?: unknown } }[] }).outputs;
    if (!Array.isArray(outs) || outs.length !== 1 || outs[0]?.value?.error !== "Output withheld by policy.") {
      throw new AdapterError("blocked result without the SUT's withheld representation");
    }
    return a("WITHHOLD", "RESULT_POLICY_WITHHOLD", "result_guardian:deny");
  }
  if (result.exit_status === "success" || result.exit_status === "failure" || result.exit_status === "timeout") {
    return a("DELIVER", "RESULT_POLICY_DELIVER", `result_guardian:allow:${result.exit_status}`);
  }
  throw new AdapterError(`unknown exit_status ${String(result.exit_status)}`);
}

function push(ctx: Ctx, o: ObservedAssertion) {
  ctx.obs.push(o);
}

/**
 * Request attempt. The OUTCOME is effect-based: ALLOW iff the harness tool double observed this
 * attempt's execution (or, for tools outside the harness registry, the SUT's fallback-tool counter
 * moved during the attempt). The SUT's own report is kept separately in `sut_decision` whenever it
 * disagrees with that effect, and the disagreement is recorded in `decision_effect_mismatches`.
 * An observed execution is never turned into an AdapterError.
 */
async function runRequest(ctx: Ctx, step: number, attempt: number | undefined, r: Omit<RequestStep, "op">): Promise<void> {
  const { envelope, trace } = materialiseRequest(ctx, r, step, attempt ?? 0);
  const requestId = (envelope as { params: { request_id: string } }).params.request_id;
  const key = `${r.session}/${r.request}`;
  const base = (outcome: string, reason: ReasonClass, code: string, stage: string): ObservedAssertion => {
    const o: ObservedAssertion = { step, stage: "request", outcome, reason_class: reason, sut_reason_code: code, enforcement_stage: stage };
    if (attempt !== undefined) o.attempt = attempt;
    return o;
  };
  const resultAssertion = (outcome: string, reason: ReasonClass, code: string, stage: string): ObservedAssertion => ({ ...base(outcome, reason, code, stage), stage: "result" });
  const harnessTool = (HARNESS_TOOLS as readonly string[]).includes(r.tool);
  const unknownBefore = ctx.sut.executionCounters.unknown_tool ?? 0;
  const executedThisAttempt = () =>
    ctx.doubles.log.some((x) => x.trace === trace) || (!harnessTool && (ctx.sut.executionCounters.unknown_tool ?? 0) > unknownBefore);
  /** SUT decision restrictive (or absent), but the tool ran: report the execution, keep the decision. */
  const unauthorisedExecution = (sutDecision: string, code: string) => {
    push(ctx, { ...base("ALLOW", "DECISION_EFFECT_MISMATCH", code, "effect"), sut_decision: sutDecision, decision_effect_mismatch: true });
    // The call did not return the tool output to the caller.
    push(ctx, { ...resultAssertion("WITHHOLD", "DECISION_EFFECT_MISMATCH", code, "effect"), sut_decision: sutDecision, decision_effect_mismatch: true });
    ctx.mismatches.push({ step, ...(attempt !== undefined ? { attempt } : {}), stage: "request", key, sut_decision: sutDecision, decided_executions: 0, observed_executions: 1 });
  };
  let res: { status: string; result?: { exit_status?: string } };
  try {
    res = await ctx.executor.process(envelope);
  } catch (e) {
    const i = errInfo(e);
    ctx.evidence.push({ step, attempt, call: "process", thrown: { name: i.name, code: i.code, message: i.message } });
    if (executedThisAttempt()) {
      const post = postExecutionReason(ctx, e);
      if (post) {
        push(ctx, base("ALLOW", "POLICY_ALLOW", "guardian:allow", "guardian"));
        push(ctx, resultAssertion("WITHHOLD", post.reason, post.code, "result_path"));
        return;
      }
      let decision: string;
      try {
        const c = classifyRequestRejection(ctx, e, requestId);
        decision = `DENY:${c.reason}`;
      } catch (ce) {
        if (!(ce instanceof AdapterError)) throw ce;
        decision = `unclassified:${i.name}`;
      }
      unauthorisedExecution(decision, `${i.name}:${i.code || i.message}`);
      return;
    }
    const c = classifyRequestRejection(ctx, e, requestId);
    push(ctx, base("DENY", c.reason, c.code, c.stage));
    return;
  }
  ctx.evidence.push({ step, attempt, call: "process", returned: { status: res?.status, exit_status: res?.result?.exit_status } });
  if (res?.status === "pending") {
    if (executedThisAttempt()) {
      unauthorisedExecution("ASK", "pending_but_executed");
      return;
    }
    push(ctx, base("ASK", "POLICY_ASK", "guardian:ask", "guardian"));
    return;
  }
  if (res?.status === "executed") {
    if (!executedThisAttempt()) {
      // The SUT reports an execution and returns a result, but no execution was observed. The result
      // reached the caller, so the outcome stays permissive (ALLOW/DELIVER); the disagreement is recorded.
      push(ctx, { ...base("ALLOW", "DECISION_EFFECT_MISMATCH", "executed_without_observed_execution", "effect"), sut_decision: "ALLOW", decision_effect_mismatch: true });
      push(ctx, resultObservation(ctx, step, attempt, res.result!));
      ctx.mismatches.push({ step, ...(attempt !== undefined ? { attempt } : {}), stage: "request", key, sut_decision: "ALLOW", decided_executions: 1, observed_executions: 0 });
      return;
    }
    push(ctx, base("ALLOW", "POLICY_ALLOW", "guardian:allow", "guardian"));
    push(ctx, resultObservation(ctx, step, attempt, res.result!));
    return;
  }
  throw new AdapterError(`unknown process() status ${JSON.stringify(res)}`);
}

/** The SUT's reported decision for one approval attempt, before reconciliation with observed effects. */
interface ApprovalDecision {
  attempt: number | undefined;
  key: string;
  decision: "EXECUTE" | "REJECT";
  reason: ReasonClass;
  code: string;
  stage: string;
  /** Result assertion implied by the SUT's report (only for EXECUTE). */
  result: ObservedAssertion | null;
  /** True when EXECUTE was inferred from a post-execution exception rather than from a returned result. */
  inferredFromException: boolean;
  /** Set during reconciliation when the observed effect overrides the SUT's report: the SUT's report. */
  flagged?: string;
}

function effectiveGrantKey(g: GrantSpec): string {
  let session = g.session;
  let request = g.request;
  if (g.tamper?.field === "session") session = g.tamper.value;
  if (g.tamper?.field === "request") request = g.tamper.value;
  return `${session}/${request}`;
}

function decideApproval(ctx: Ctx, step: number, attempt: number | undefined, g: GrantSpec, outcome: PromiseSettledResult<unknown>): ApprovalDecision {
  const key = effectiveGrantKey(g);
  const d = (decision: "EXECUTE" | "REJECT", reason: ReasonClass, code: string, stage: string, result: ObservedAssertion | null, inferred = false): ApprovalDecision => ({
    attempt, key, decision, reason, code, stage, result, inferredFromException: inferred,
  });
  if (outcome.status === "rejected") {
    const e = outcome.reason;
    const i = errInfo(e);
    ctx.evidence.push({ step, attempt, call: "resolveApproval", thrown: { name: i.name, code: i.code, message: i.message } });
    const post = postExecutionReason(ctx, e);
    if (post) {
      const r: ObservedAssertion = { step, stage: "result", outcome: "WITHHOLD", reason_class: post.reason, sut_reason_code: post.code, enforcement_stage: "result_path" };
      if (attempt !== undefined) r.attempt = attempt;
      return d("EXECUTE", "APPROVAL_GRANTED", "human_approval", "human", r, true);
    }
    try {
      const c = classifyApprovalRejection(ctx, e);
      return d("REJECT", c.reason, c.code, c.stage, null);
    } catch (ce) {
      if (!(ce instanceof AdapterError)) throw ce;
      // Unclassifiable: only acceptable if reconciliation shows no execution happened (see reconcileApprovals).
      return d("REJECT", "DECISION_EFFECT_MISMATCH", `unclassified:${i.name}:${i.message}`, "unclassified", null);
    }
  }
  const value = outcome.value as { exit_status?: string } | undefined;
  ctx.evidence.push({ step, attempt, call: "resolveApproval", returned: value === undefined ? null : { exit_status: value.exit_status } });
  if (value === undefined) {
    const ev = lastAudit(ctx, "human_rejection", rid(ctx, g.request));
    if (!ev) return d("REJECT", "DECISION_EFFECT_MISMATCH", "returned_without_result_or_rejection_evidence", "unclassified", null);
    return d("REJECT", "HUMAN_REJECTED", "human_rejection", "human", null);
  }
  return d("EXECUTE", "APPROVAL_GRANTED", "human_approval", "human", resultObservation(ctx, step, attempt, value));
}

/**
 * Reconcile the SUT-reported approval decisions of one step with the executions the tool doubles
 * observed during that step, per target request key:
 *  - observed == decided: decisions stand;
 *  - observed > decided: the surplus executions are unauthorised effects. REJECT-decided attempts on
 *    that key become EXECUTE (sut_decision kept, flagged); any surplus beyond that is recorded as an
 *    unattributed decision/effect mismatch (the executions invariant then fails);
 *  - observed < decided: EXECUTE claims without an execution become REJECT (flagged), preferring claims
 *    inferred from exceptions. This keeps a random post-execution-looking exception from being scored
 *    as an execution (and therefore as a mutation kill).
 * Executions of keys no attempt targeted are recorded as mismatches with decided_executions 0.
 * Unclassifiable rejections are AdapterErrors only when their key shows no unexplained execution.
 */
function reconcileApprovals(ctx: Ctx, step: number, decisions: ApprovalDecision[], logFrom: number): void {
  const observed = new Map<string, number>();
  for (const rec of ctx.doubles.log.slice(logFrom)) {
    const k = rec.trace === null ? "<unattributed>" : traceKey(rec.trace);
    observed.set(k, (observed.get(k) ?? 0) + 1);
  }
  const keys = new Set([...decisions.map((d) => d.key), ...observed.keys()]);
  for (const key of keys) {
    const ds = decisions.filter((d) => d.key === key);
    const obsN = observed.get(key) ?? 0;
    const decidedN = ds.filter((d) => d.decision === "EXECUTE").length;
    if (ds.length === 0) {
      ctx.mismatches.push({ step, stage: "approval", key: key === "<unattributed>" ? null : key, sut_decision: "none", decided_executions: 0, observed_executions: obsN });
      continue;
    }
    if (obsN > decidedN) {
      let surplus = obsN - decidedN;
      for (const d of ds) {
        if (surplus === 0) break;
        if (d.decision !== "REJECT") continue;
        const sutDecision = `REJECT:${d.reason}`;
        d.decision = "EXECUTE";
        d.flagged = sutDecision;
        const r: ObservedAssertion = { step, stage: "result", outcome: "WITHHOLD", reason_class: "DECISION_EFFECT_MISMATCH", sut_reason_code: d.code, enforcement_stage: "effect", sut_decision: sutDecision, decision_effect_mismatch: true };
        if (d.attempt !== undefined) r.attempt = d.attempt;
        d.result = r;
        surplus--;
      }
      ctx.mismatches.push({ step, stage: "approval", key, sut_decision: ds.map((d) => d.flagged ?? d.decision).join(","), decided_executions: decidedN, observed_executions: obsN });
    } else if (obsN < decidedN) {
      let missing = decidedN - obsN;
      const order = [...ds.filter((d) => d.decision === "EXECUTE" && d.inferredFromException), ...ds.filter((d) => d.decision === "EXECUTE" && !d.inferredFromException)];
      for (const d of order) {
        if (missing === 0) break;
        d.flagged = `EXECUTE:${d.code}`;
        d.decision = "REJECT";
        d.reason = "DECISION_EFFECT_MISMATCH";
        d.result = null;
        missing--;
      }
      ctx.mismatches.push({ step, stage: "approval", key, sut_decision: "EXECUTE", decided_executions: decidedN, observed_executions: obsN });
    }
    for (const d of ds) {
      if (d.stage === "unclassified" && !d.flagged) {
        throw new AdapterError(`unclassified SUT behaviour on resolveApproval() without an observed execution: ${d.code}`);
      }
    }
  }
  for (const d of decisions) {
    const flagged = d.flagged;
    const o: ObservedAssertion = { step, stage: "approval", outcome: d.decision, reason_class: flagged ? "DECISION_EFFECT_MISMATCH" : d.reason, sut_reason_code: d.code, enforcement_stage: flagged ? "effect" : d.stage };
    if (d.attempt !== undefined) o.attempt = d.attempt;
    if (flagged) {
      o.sut_decision = flagged;
      o.decision_effect_mismatch = true;
    }
    push(ctx, o);
    if (d.decision === "EXECUTE" && d.result) push(ctx, d.result);
  }
}

async function runApprovalStep(ctx: Ctx, step: number, grants: GrantSpec[], concurrent: boolean): Promise<void> {
  const logFrom = ctx.doubles.log.length;
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
  const decisions = settled.map((o, j) => decideApproval(ctx, step, concurrent ? j : undefined, grants[j], o));
  reconcileApprovals(ctx, step, decisions, logFrom);
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
  const ctx: Ctx = { c, sut, keys, clock, executor, audit, signer, doubles, outputs, capQueue, obs: [], evidence: [], mismatches: [] };
  const unknownBefore = sut.executionCounters.unknown_tool ?? 0;
  doubles.install();
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const unknownStepBefore = sut.executionCounters.unknown_tool ?? 0;
      switch (step.op) {
        case "request":
          await runRequest(ctx, i, undefined, step);
          break;
        case "concurrent_request":
          // Start all calls in array order without awaiting in between.
          await Promise.all(step.requests.map((r, j) => runRequest(ctx, i, j, r)));
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
          ctx.evidence.push({ step, call: "clearSession" });
          break;
        default:
          throw new AdapterError(`unknown op ${(step as { op: string }).op}`);
      }
      // Executions through the SUT's fallback tool cannot be attributed to a request by the doubles.
      // They are reported (unattributed_executions + a mismatch record), never turned into an error.
      const unknownDelta = (sut.executionCounters.unknown_tool ?? 0) - unknownStepBefore;
      if (unknownDelta > 0 && step.op !== "request" && step.op !== "concurrent_request") {
        ctx.mismatches.push({ step: i, stage: "approval", key: null, sut_decision: "unattributed", decided_executions: 0, observed_executions: unknownDelta });
      }
    }
  } catch (e) {
    if (e instanceof AdapterError) {
      // Keep everything observed so far (decisions and effects) next to the error.
      (e as AdapterError & { partial?: unknown }).partial = {
        assertions: ctx.obs,
        executions: countExecutions(doubles.log),
        unattributed_executions: doubles.log.filter((x) => x.trace === null).length + ((sut.executionCounters.unknown_tool ?? 0) - unknownBefore),
        decision_effect_mismatches: ctx.mismatches,
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
    observations: { assertions: ctx.obs, executions, unattributed_executions: unattributed, decision_effect_mismatches: ctx.mismatches },
    evidence: { calls: ctx.evidence, audit_event_types: auditTypes, audit_integrity: audit.verifyIntegrity().valid ?? null },
  };
}
