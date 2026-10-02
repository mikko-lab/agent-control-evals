/**
 * ACS component-boundary adapter paths. These exercise a single pinned
 * component directly because its invariant is not purposefully reachable
 * through the public GuardedExecutor API (see docs/mutation-reachability.md):
 *  - ApprovalGrantVerifier.verifyV2 with a trusted context that differs from
 *    the grant (request/session binding);
 *  - ExecutionGate permits (minted and consumed only inside GuardedExecutor).
 */
import { sign } from "node:crypto";
import type { ReasonClass } from "../../spec/reason-taxonomy";
import type { CaseForAdapter, PermitScenario, VerifierScenario } from "../../corpus/types";
import type { DecisionSource, EffectRecord, Observations, SutDecision, SutReport } from "../protocol";
import type { SutModules } from "./sut";
import { AdapterError, HARNESS_TOOLS, uuidFor, type AdapterKeys } from "./runtime";
import { makeTrace, ToolDoubles, TRACE_ARG, traceKey } from "./tool-doubles";

const APPROVER_KEY_ID = "ace-approver-1";

const VERIFIER_CODE_REASON: Record<string, ReasonClass> = {
  V1_REJECTED: "APPROVAL_VERSION_REJECTED",
  TOOL_BINDING_MISMATCH: "APPROVAL_TOOL_MISMATCH",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  WRONG_APPROVER_IDENTITY: "APPROVER_MISMATCH",
  MALFORMED_GRANT: "APPROVAL_MALFORMED",
  SESSION_MISMATCH: "APPROVAL_SESSION_MISMATCH",
  REQUEST_MISMATCH: "APPROVAL_REQUEST_MISMATCH",
};

export function runVerifierCase(c: CaseForAdapter, sut: SutModules, keys: AdapterKeys): { observations: Observations; evidence: unknown } {
  const s = c.scenario as VerifierScenario;
  const id = (ns: string, l: string) => uuidFor(c.case_id, ns, l);
  const body: Record<string, unknown> = {
    version: 2,
    decision: s.grant.decision,
    session_id: id("session", s.grant.session),
    request_id: id("request", s.grant.request),
    tool: s.grant.tool,
    approver: { type: "human", id: s.grant.approver_id },
    issued_at: new Date(Date.UTC(2026, 0, 1) + s.grant.issued_offset_ms).toISOString(),
  };
  const value = sign(null, Buffer.from(sut.canonicalize(body)), keys.approver.privateKey).toString("base64");
  const grant: Record<string, unknown> = { ...body, signature: { algorithm: "Ed25519", key_id: APPROVER_KEY_ID, value } };
  if (s.grant.tamper) {
    const t = s.grant.tamper;
    if (t.field === "session") grant.session_id = id("session", t.value);
    if (t.field === "request") grant.request_id = id("request", t.value);
    if (t.field === "tool") grant.tool = t.value;
    if (t.field === "approver_id") grant.approver = { type: "human", id: t.value };
  }
  const verifier = new sut.ApprovalGrantVerifier(keys.approver.publicKey, APPROVER_KEY_ID);
  const ctx = {
    expectedSessionId: id("session", s.context.session),
    expectedRequestId: id("request", s.context.request),
    expectedTool: s.context.tool,
    expectedApproverType: "human",
    expectedApproverId: s.context.approver_id,
  };
  try {
    verifier.verifyV2(grant, ctx);
    return {
      observations: { assertions: [{ step: 0, stage: "verifier", outcome: "ACCEPT", reason_class: "APPROVAL_VERIFIED", sut_reason_code: "verified", enforcement_stage: "approval_verifier" }], executions: {}, unattributed_executions: 0 },
      evidence: { returned: "verified" },
    };
  } catch (e) {
    const err = e as Error & { code?: string };
    if (!(e instanceof sut.ApprovalVerificationError) || !VERIFIER_CODE_REASON[err.code ?? ""]) {
      throw new AdapterError(`unclassified verifier exception: ${err?.name}: ${err?.message}`);
    }
    return {
      observations: {
        assertions: [{ step: 0, stage: "verifier", outcome: "REJECT", reason_class: VERIFIER_CODE_REASON[err.code!], sut_reason_code: `${err.name}:${err.code}`, enforcement_stage: "approval_verifier" }],
        executions: {},
        unattributed_executions: 0,
      },
      evidence: { thrown: { name: err.name, code: err.code, message: err.message } },
    };
  }
}

export async function runPermitCase(c: CaseForAdapter, sut: SutModules): Promise<{ observations: Observations; evidence: unknown }> {
  const s = c.scenario as PermitScenario;
  const id = (ns: string, l: string) => uuidFor(c.case_id, ns, l);
  const audit = new sut.AuditCollector();
  const authority = Symbol("ace-harness-permit-authority");
  const gate = new sut.ExecutionGate(audit, authority);
  const p = s.permit;
  const permit = p.forged
    ? { sessionId: id("session", p.session), requestId: id("request", p.request), toolName: p.tool }
    : gate.mintPermit(authority, id("session", p.session), id("request", p.request), p.tool);
  const outputs = new Map<string, unknown>();
  const doubles = new ToolDoubles(sut.tools, outputs, HARNESS_TOOLS);
  const envelopes = s.attempts.map((at, j) => {
    const trace = makeTrace(`${at.session}/${at.request}`, 0, j);
    outputs.set(trace, s.tool_output);
    return {
      jsonrpc: "2.0",
      method: "steps/toolCallRequest",
      id: id("rpc", trace),
      params: {
        acs_version: "0.1.0",
        request_id: id("request", at.request),
        timestamp: "2026-01-01T00:00:00.000Z",
        metadata: { agent_id: "agent-alpha", session_id: id("session", at.session) },
        payload: { tool: { name: at.tool }, arguments: { [TRACE_ARG]: { value: trace } } },
      },
    };
  });
  const unknownBefore = sut.executionCounters.unknown_tool ?? 0;
  const auditLen = () => (audit.getEvents() as unknown[]).length;
  // Audit window per attempt: the synchronous prefix of gate.execute() for concurrent attempts (everything up to
  // the tool invocation, including tool_execution_started), the whole call otherwise.
  const windows: [number, number][] = [];
  doubles.install();
  let settled: PromiseSettledResult<unknown>[];
  try {
    const settle = (p: Promise<unknown>) => p.then((value): PromiseSettledResult<unknown> => ({ status: "fulfilled", value }), (reason): PromiseSettledResult<unknown> => ({ status: "rejected", reason }));
    if (s.concurrent) {
      const started = envelopes.map((env) => {
        const from = auditLen();
        const pr = settle(gate.execute(env, permit));
        windows.push([from, auditLen()]);
        return pr;
      });
      settled = await Promise.all(started);
    } else {
      settled = [];
      for (const env of envelopes) {
        const from = auditLen();
        settled.push(await settle(gate.execute(env, permit)));
        windows.push([from, auditLen()]);
      }
    }
  } finally {
    doubles.restore();
  }
  const evidence = settled.map((r) =>
    r.status === "fulfilled" ? { returned: (r.value as { exit_status?: string })?.exit_status ?? null } : { thrown: (r.reason as Error)?.message ?? String(r.reason) },
  );
  // Decision (the gate's own authority evidence) and effect (what the tool doubles observed) per attempt. Each
  // attempt has its own trace, so execution attribution is exact even for concurrent attempts. EXECUTE comes only
  // from the gate's tool_execution_started audit event in the attempt's window (the gate records it after the
  // permit and binding checks pass); a returned value alone never grants EXECUTE. Rejections are reported by the
  // gate only as exceptions (it writes no audit event for them).
  const records: EffectRecord[] = [];
  const rejectionReasons: { reason: ReasonClass; code: string }[] = [];
  let executedAttempts = 0;
  settled.forEach((r, j) => {
    const at = s.attempts[j];
    const trace = makeTrace(`${at.session}/${at.request}`, 0, j);
    const observed = doubles.log.filter((x) => x.trace === trace).length;
    const harnessTool = (HARNESS_TOOLS as readonly string[]).includes(at.tool);
    const started = (audit.getEvents() as { event_type: string; request_id: string }[])
      .slice(windows[j][0], windows[j][1])
      .some((e) => e.event_type === "tool_execution_started" && e.request_id === id("request", at.request));
    let decision: SutDecision = "DECISION_NOT_OBSERVED";
    let source: DecisionSource = "none";
    let report: SutReport;
    if (started) {
      decision = "EXECUTE";
      source = "audit_event";
    }
    if (r.status === "fulfilled") {
      report = { kind: "returned", status: "result", ...(typeof (r.value as { exit_status?: unknown })?.exit_status === "string" ? { exit_status: (r.value as { exit_status: string }).exit_status } : {}) };
    } else {
      const err = r.reason as Error & { code?: unknown };
      const msg = err?.message ?? "";
      report = { kind: "threw", exception: { name: err?.name ?? "Error", code: err?.code !== undefined ? String(err.code) : "", message: msg } };
      if (!started && msg === "Execution blocked: valid execution permit required") {
        decision = "REJECT";
        source = "sut_exception";
        rejectionReasons.push({ reason: p.forged ? "PERMIT_INVALID" : "PERMIT_REUSE_BLOCKED", code: "permit_required" });
      } else if (!started && /^Execution blocked: permit (session|request|tool) mismatch$/.test(msg)) {
        decision = "REJECT";
        source = "sut_exception";
        rejectionReasons.push({ reason: "PERMIT_BINDING_MISMATCH", code: msg.replace("Execution blocked: ", "").replace(/ /g, "_") });
      }
    }
    if (decision === "DECISION_NOT_OBSERVED" && observed === 0) {
      throw new AdapterError(`no ExecutionGate authority evidence and no observed execution: ${report.exception?.message ?? report.status ?? ""}`);
    }
    if (observed > 0) executedAttempts++;
    records.push({
      step: 0, attempt: j, stage: "permit", key: `${at.session}/${at.request}`, attribution: "attempt",
      sut_reports: [report], sut_decisions: [decision], decision_sources: [source], result_control_decisions: [], result_control_state: "not_applicable",
      authorized_executions: decision === "EXECUTE" ? 1 : 0, observed_executions: observed,
      execution_observation: harnessTool ? { state: observed > 0 ? "observed" : "not_observed", source: "harness_tool_trace" } : { state: "ambiguous", source: "harness_tool_trace", detail: "non_harness_tool_see_fallback_record" },
      authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observation: { state: "unavailable", source: "none", detail: "execution_gate_has_no_delivery_channel" },
    });
  });
  const executions: Record<string, number> = {};
  for (const at of s.attempts) executions[`${at.session}/${at.request}`] = 0;
  let unattributed = 0;
  for (const rec of doubles.log) {
    if (rec.trace === null) unattributed++;
    else executions[traceKey(rec.trace)] = (executions[traceKey(rec.trace)] ?? 0) + 1;
  }
  const fallback = (sut.executionCounters.unknown_tool ?? 0) - unknownBefore;
  unattributed += fallback;
  if (fallback > 0) {
    // The SUT fallback-tool counter cannot be attributed to an attempt (and it is SUT-owned): ambiguous.
    records.push({
      step: 0, stage: "permit", key: null, attribution: "unattributed", sut_reports: [], sut_decisions: [], decision_sources: [],
      result_control_decisions: [], result_control_state: "not_applicable",
      authorized_executions: 0, observed_executions: fallback, execution_observation: { state: "ambiguous", source: "sut_counter", detail: "fallback_counter_delta_not_attributable" },
      authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observation: { state: "unavailable", source: "none", detail: "execution_gate_has_no_delivery_channel" },
    });
  }
  // Normalised outcome follows the observed effect: how many attempts with this permit executed.
  let outcome: string;
  let reason: ReasonClass;
  let code: string;
  if (executedAttempts === 0) {
    outcome = "REJECT";
    reason = rejectionReasons[0]?.reason ?? "DECISION_EFFECT_MISMATCH";
    code = rejectionReasons[0]?.code ?? "no_observed_execution";
  } else if (executedAttempts === 1 && s.attempts.length === 1) {
    outcome = "EXECUTE_ONCE";
    reason = "PERMIT_ACCEPTED";
    code = "executed";
  } else if (executedAttempts === 1) {
    outcome = "REUSE_BLOCKED";
    reason = "PERMIT_REUSE_BLOCKED";
    code = rejectionReasons[0]?.code ?? "permit_required";
  } else {
    outcome = "REUSE_ACCEPTED";
    reason = "PERMIT_ACCEPTED";
    code = `executed_x${executedAttempts}`;
  }
  const fulfilled = executedAttempts;
  return {
    observations: {
      assertions: [{ step: 0, stage: "permit", outcome, reason_class: reason, sut_reason_code: code, enforcement_stage: "execution_gate" }],
      executions,
      unattributed_executions: unattributed,
      permit_reuses_accepted: Math.max(0, fulfilled - 1),
      effect_records: records,
    },
    evidence: { attempts: evidence },
  };
}
