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
import type { Observations } from "../protocol";
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
  doubles.install();
  let settled: PromiseSettledResult<unknown>[];
  try {
    if (s.concurrent) {
      settled = await Promise.allSettled(envelopes.map((env) => gate.execute(env, permit)));
    } else {
      settled = [];
      for (const env of envelopes) {
        try {
          settled.push({ status: "fulfilled", value: await gate.execute(env, permit) });
        } catch (e) {
          settled.push({ status: "rejected", reason: e });
        }
      }
    }
  } finally {
    doubles.restore();
  }
  const evidence = settled.map((r) =>
    r.status === "fulfilled" ? { returned: (r.value as { exit_status?: string })?.exit_status ?? null } : { thrown: (r.reason as Error)?.message ?? String(r.reason) },
  );
  const rejectionReasons: { reason: ReasonClass; code: string }[] = [];
  let fulfilled = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") {
      fulfilled++;
      continue;
    }
    const msg = (r.reason as Error)?.message ?? "";
    if (msg === "Execution blocked: valid execution permit required") {
      rejectionReasons.push({ reason: p.forged ? "PERMIT_INVALID" : "PERMIT_REUSE_BLOCKED", code: "permit_required" });
    } else if (/^Execution blocked: permit (session|request|tool) mismatch$/.test(msg)) {
      rejectionReasons.push({ reason: "PERMIT_BINDING_MISMATCH", code: msg.replace("Execution blocked: ", "").replace(/ /g, "_") });
    } else {
      throw new AdapterError(`unclassified ExecutionGate exception: ${msg}`);
    }
  }
  const executions: Record<string, number> = {};
  for (const at of s.attempts) executions[`${at.session}/${at.request}`] = 0;
  let unattributed = 0;
  for (const rec of doubles.log) {
    if (rec.trace === null) unattributed++;
    else executions[traceKey(rec.trace)] = (executions[traceKey(rec.trace)] ?? 0) + 1;
  }
  unattributed += (sut.executionCounters.unknown_tool ?? 0) - unknownBefore;
  const totalExec = Object.values(executions).reduce((a, b) => a + b, 0) + unattributed;
  if (totalExec !== fulfilled) throw new AdapterError(`gate fulfilled ${fulfilled} executions but tool doubles observed ${totalExec}`);
  let outcome: string;
  let reason: ReasonClass;
  let code: string;
  if (fulfilled === 0) {
    outcome = "REJECT";
    reason = rejectionReasons[0].reason;
    code = rejectionReasons[0].code;
  } else if (fulfilled === 1 && s.attempts.length === 1) {
    outcome = "EXECUTE_ONCE";
    reason = "PERMIT_ACCEPTED";
    code = "executed";
  } else if (fulfilled === 1) {
    outcome = "REUSE_BLOCKED";
    reason = "PERMIT_REUSE_BLOCKED";
    code = rejectionReasons[0]?.code ?? "permit_required";
  } else {
    outcome = "REUSE_ACCEPTED";
    reason = "PERMIT_ACCEPTED";
    code = `executed_x${fulfilled}`;
  }
  return {
    observations: {
      assertions: [{ step: 0, stage: "permit", outcome, reason_class: reason, sut_reason_code: code, enforcement_stage: "execution_gate" }],
      executions,
      unattributed_executions: unattributed,
      permit_reuses_accepted: Math.max(0, fulfilled - 1),
    },
    evidence: { attempts: evidence },
  };
}
