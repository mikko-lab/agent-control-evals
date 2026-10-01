/**
 * ORACLE: derives the expected behaviour of a case from the case's scenario
 * structure and the declared evaluation specification only.
 *
 * Independence rules (enforced statically by scripts/check-oracle-boundary.ts):
 *  - imports only from ../spec/*, ../corpus/types and ./ (no adapter, no SUT,
 *    no node:fs / node:child_process / network);
 *  - never sees SUT or adapter output;
 *  - is a model of the declared specification (docs/evaluation-spec.md), not a
 *    port of the SUT's Guardian or verifiers.
 *
 * Where several independent controls each forbid the same action, every
 * violated control's reason class is acceptable (outcome first, reason second).
 */
import { DECLARED_POLICY } from "../spec/declared-policy";
import type { ReasonClass } from "../spec/reason-taxonomy";
import type {
  Assertion,
  CapabilitySpec,
  ExpectedInvariants,
  GrantSpec,
  Json,
  PermitScenario,
  RequestStep,
  RuntimeScenario,
  Scenario,
  VerifierScenario,
} from "../corpus/types";

export class OracleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleError";
  }
}

export interface OracleResult {
  assertions: Assertion[];
  invariants: ExpectedInvariants;
  unordered_steps: number[];
}

/** Session-qualified request key used in invariants. */
export const reqKey = (session: string, request: string) => `${session}/${request}`;

/** Declared result rule. */
export function isWithheldOutput(v: Json): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, Json>)["classification"] === DECLARED_POLICY.result_withhold_classification
  );
}

interface Pending {
  tool: string;
  createdAt: number;
  output: Json;
  /** "unknown" = the spec does not pin down whether a prior attempt consumed it. */
  state: "pending" | "unknown";
}

interface RuntimeModel {
  clock: number;
  seen: Map<string, Set<string>>;
  pending: Map<string, Pending>;
  executions: Map<string, number>;
}

function capabilityViolations(cap: CapabilitySpec, req: Omit<RequestStep, "op">): ReasonClass[] {
  if (!cap.present) return ["CAPABILITY_MISSING"];
  const v: ReasonClass[] = [];
  if (cap.signature === "tampered") v.push("CAPABILITY_INVALID_SIGNATURE");
  const tools = cap.allowed_tools ?? [];
  if (tools.some((t) => t.includes("*"))) v.push("CAPABILITY_UNSUPPORTED_SCOPE");
  // Offsets are relative to the evaluation clock at the time of the step (now = 0).
  const issued = cap.issued_offset_ms ?? 0;
  const expires = cap.expires_offset_ms ?? 0;
  if (expires <= issued) v.push("CAPABILITY_MALFORMED");
  // Declared validity window: issued_at <= now < expires_at.
  if (0 < issued) v.push("CAPABILITY_NOT_YET_VALID");
  if (0 >= expires) v.push("CAPABILITY_EXPIRED");
  if (cap.agent !== req.agent) v.push("CAPABILITY_AGENT_MISMATCH");
  if (cap.session !== req.session) v.push("CAPABILITY_SESSION_MISMATCH");
  if (!tools.includes(req.tool)) v.push("CAPABILITY_TOOL_MISMATCH");
  return v;
}

function evalRequest(m: RuntimeModel, stepIdx: number, req: Omit<RequestStep, "op">, attempt: number | undefined, out: Assertion[]): void {
  const now = m.clock;
  const key = reqKey(req.session, req.request);
  // timestamp_offset_ms is the request timestamp relative to the clock at this step.
  const preCapability: ReasonClass[] = [];
  // Declared pipeline (pinned SUT README, ACS v0.1.0 section 10.3): authentication,
  // then freshness + session-scoped duplicate detection; a request_id is
  // recorded only once authentication and freshness pass, so a stale
  // request cannot poison its id.
  const authFail = req.signature === "tampered";
  if (authFail) preCapability.push("REQUEST_SIGNATURE_INVALID");
  const stale = Math.abs(req.timestamp_offset_ms) > DECLARED_POLICY.request_skew_window_ms;
  if (stale) preCapability.push("TIMESTAMP_OUT_OF_WINDOW");
  const seen = m.seen.get(req.session) ?? new Set<string>();
  const duplicate = seen.has(req.request);
  if (duplicate) preCapability.push("REPLAY_DETECTED");
  if (!authFail && !stale && !duplicate) {
    seen.add(req.request);
    m.seen.set(req.session, seen);
  }
  const capV = preCapability.length === 0 ? capabilityViolations(req.capability, req) : [];
  const all = [...preCapability, ...capV];
  const a = (stage: Assertion["stage"], outcome: string, reasons?: ReasonClass[]): Assertion => {
    const r: Assertion = { step: stepIdx, stage, outcome };
    if (attempt !== undefined) r.attempt = attempt;
    if (reasons) r.acceptable_reason_classes = [...reasons].sort();
    return r;
  };
  if (all.length > 0) {
    out.push(a("request", "DENY", all));
    return;
  }
  const policy = DECLARED_POLICY.request_policy[req.tool];
  if (policy === undefined) {
    out.push(a("request", "DENY", ["POLICY_DENY"]));
    return;
  }
  if (policy === "ASK") {
    m.pending.set(key, { tool: req.tool, createdAt: now, output: req.tool_output, state: "pending" });
    out.push(a("request", "ASK", ["POLICY_ASK"]));
    return;
  }
  out.push(a("request", "ALLOW", ["POLICY_ALLOW"]));
  m.executions.set(key, (m.executions.get(key) ?? 0) + 1);
  out.push(
    isWithheldOutput(req.tool_output)
      ? a("result", "WITHHOLD", ["RESULT_POLICY_WITHHOLD"])
      : a("result", "DELIVER", ["RESULT_POLICY_DELIVER"]),
  );
}

function effectiveGrant(g: GrantSpec): { session: string; request: string; tool: string; approver_id: string; tampered: boolean } {
  const eff = { session: g.session, request: g.request, tool: g.tool, approver_id: g.approver_id, tampered: false };
  if (g.tamper) {
    if (eff[g.tamper.field] === g.tamper.value) throw new OracleError("tamper must change the signed value");
    eff[g.tamper.field] = g.tamper.value;
    eff.tampered = true;
  }
  return eff;
}

/** Reasons acceptable for a post-signature rewrite of a bound grant field. */
function tamperReasonsFor(g: GrantSpec): ReasonClass[] {
  if (!g.tamper) return [];
  const byField: Record<NonNullable<GrantSpec["tamper"]>["field"], ReasonClass> = {
    request: "APPROVAL_REQUEST_MISMATCH",
    session: "APPROVAL_SESSION_MISMATCH",
    tool: "APPROVAL_TOOL_MISMATCH",
    approver_id: "APPROVER_MISMATCH",
  };
  return ["INVALID_SIGNATURE", byField[g.tamper.field]];
}

function evalApproval(m: RuntimeModel, stepIdx: number, g: GrantSpec, attempt: number | undefined, out: Assertion[]): void {
  const now = m.clock;
  const eff = effectiveGrant(g);
  const key = reqKey(eff.session, eff.request);
  const pending = m.pending.get(key);
  const a = (stage: Assertion["stage"], outcome: string, reasons?: ReasonClass[]): Assertion => {
    const r: Assertion = { step: stepIdx, stage, outcome };
    if (attempt !== undefined) r.attempt = attempt;
    if (reasons) r.acceptable_reason_classes = [...reasons].sort();
    return r;
  };
  const tamperReasons = tamperReasonsFor(g);
  if (!pending) {
    out.push(a("approval", "REJECT", ["PENDING_ACTION_NOT_FOUND", ...tamperReasons]));
    return;
  }
  if (pending.state === "unknown") {
    throw new OracleError(`step ${stepIdx}: approval presented against a pending action whose state the declared spec does not determine`);
  }
  // Authentication / binding failures: declared to preserve pending state.
  const binding: ReasonClass[] = [...tamperReasons];
  if (eff.tool !== pending.tool) binding.push("APPROVAL_TOOL_MISMATCH");
  if (eff.approver_id !== DECLARED_POLICY.ask_approver_id) binding.push("APPROVER_MISMATCH");
  // Freshness / lifetime.
  const freshness: ReasonClass[] = [];
  // issued_offset_ms is relative to the clock at this step.
  const issuedAbs = now + g.issued_offset_ms;
  if (issuedAbs < pending.createdAt) freshness.push("APPROVAL_BEFORE_ASK");
  if (g.issued_offset_ms > DECLARED_POLICY.approval_future_skew_ms) freshness.push("APPROVAL_FUTURE_SKEW");
  const expired = now - pending.createdAt > DECLARED_POLICY.ask_timeout_ms;
  if (expired) freshness.push("APPROVAL_EXPIRED");
  const reasons = [...new Set([...binding, ...freshness])];
  if (reasons.length > 0) {
    out.push(a("approval", "REJECT", reasons));
    if (binding.length > 0 && freshness.length === 0) {
      // pending preserved (declared: authentication/binding failures do not consume)
    } else if (binding.length === 0 && expired && freshness.length === 1) {
      m.pending.delete(key); // declared: expiry consumes the pending action
    } else {
      pending.state = "unknown";
    }
    return;
  }
  m.pending.delete(key);
  if (g.decision === "reject") {
    out.push(a("approval", "REJECT", ["HUMAN_REJECTED"]));
    return;
  }
  out.push(a("approval", "EXECUTE", ["APPROVAL_GRANTED"]));
  m.executions.set(key, (m.executions.get(key) ?? 0) + 1);
  out.push(
    isWithheldOutput(pending.output)
      ? a("result", "WITHHOLD", ["RESULT_POLICY_WITHHOLD"])
      : a("result", "DELIVER", ["RESULT_POLICY_DELIVER"]),
  );
}

function runtimeOracle(s: RuntimeScenario): OracleResult {
  const m: RuntimeModel = { clock: 0, seen: new Map(), pending: new Map(), executions: new Map() };
  const assertions: Assertion[] = [];
  const unordered: number[] = [];
  const mentioned = new Set<string>();
  s.steps.forEach((step, i) => {
    switch (step.op) {
      case "request":
        mentioned.add(reqKey(step.session, step.request));
        evalRequest(m, i, step, undefined, assertions);
        break;
      case "concurrent_request":
        unordered.push(i);
        step.requests.forEach((r, j) => {
          mentioned.add(reqKey(r.session, r.request));
          evalRequest(m, i, r, j, assertions);
        });
        break;
      case "approve":
        evalApproval(m, i, step.grant, undefined, assertions);
        break;
      case "concurrent_approve":
        unordered.push(i);
        step.grants.forEach((g, j) => evalApproval(m, i, g, j, assertions));
        break;
      case "advance_clock":
        if (!Number.isSafeInteger(step.ms) || step.ms < 0) throw new OracleError("clock only moves forward");
        m.clock += step.ms;
        break;
      case "clear_session":
        m.seen.delete(step.session);
        for (const k of [...m.pending.keys()]) if (k.startsWith(`${step.session}/`)) m.pending.delete(k);
        break;
      default:
        throw new OracleError(`unknown op ${(step as { op: string }).op}`);
    }
  });
  const executions: Record<string, number> = {};
  for (const k of [...mentioned].sort()) executions[k] = m.executions.get(k) ?? 0;
  return { assertions, invariants: { executions }, unordered_steps: unordered };
}

function verifierOracle(s: VerifierScenario): OracleResult {
  const eff = effectiveGrant(s.grant);
  // Same rule as the runtime approval path: a post-signature rewrite of a
  // bound field is a signature failure AND, because the authenticated value
  // differs from the expected context, a binding mismatch of that field.
  const reasons: ReasonClass[] = [...tamperReasonsFor(s.grant)];
  if (eff.session !== s.context.session) reasons.push("APPROVAL_SESSION_MISMATCH");
  if (eff.request !== s.context.request) reasons.push("APPROVAL_REQUEST_MISMATCH");
  if (eff.tool !== s.context.tool) reasons.push("APPROVAL_TOOL_MISMATCH");
  if (eff.approver_id !== s.context.approver_id) reasons.push("APPROVER_MISMATCH");
  const uniq = [...new Set(reasons)];
  const assertion: Assertion =
    uniq.length > 0
      ? { step: 0, stage: "verifier", outcome: "REJECT", acceptable_reason_classes: uniq.sort() }
      : { step: 0, stage: "verifier", outcome: "ACCEPT", acceptable_reason_classes: ["APPROVAL_VERIFIED"] };
  return { assertions: [assertion], invariants: { executions: {} }, unordered_steps: [] };
}

function permitOracle(s: PermitScenario): OracleResult {
  if (s.attempts.length === 0) throw new OracleError("permit scenario needs at least one attempt");
  // Declared invariant: a permit authorises at most one execution, and only of
  // the exact (session, request, tool) it was minted for; a forged permit
  // authorises nothing.
  const p = s.permit;
  const first = s.attempts[0];
  const firstMatches = first.session === p.session && first.request === p.request && first.tool === p.tool;
  let outcome: string;
  let reasons: ReasonClass[];
  const executions: Record<string, number> = {};
  for (const at of s.attempts) executions[reqKey(at.session, at.request)] = 0;
  if (p.forged) {
    outcome = "REJECT";
    reasons = ["PERMIT_INVALID"];
  } else if (s.attempts.some((at) => !(at.session === p.session && at.request === p.request && at.tool === p.tool))) {
    if (s.attempts.length !== 1) throw new OracleError("v0.1 spec only declares single-attempt binding mismatches");
    outcome = "REJECT";
    reasons = ["PERMIT_BINDING_MISMATCH"];
  } else {
    if (!firstMatches) throw new OracleError("unreachable");
    executions[reqKey(p.session, p.request)] = 1;
    if (s.attempts.length === 1) {
      outcome = "EXECUTE_ONCE";
      reasons = ["PERMIT_ACCEPTED"];
    } else {
      outcome = "REUSE_BLOCKED";
      reasons = ["PERMIT_REUSE_BLOCKED"];
    }
  }
  return {
    assertions: [{ step: 0, stage: "permit", outcome, acceptable_reason_classes: reasons }],
    invariants: { executions, permit_reuses_accepted: 0 },
    unordered_steps: [],
  };
}

export function deriveExpected(s: Scenario): OracleResult {
  if (s.kind === "runtime") return runtimeOracle(s);
  if (s.component === "approval_grant_verifier") return verifierOracle(s);
  if (s.component === "execution_gate") return permitOracle(s);
  throw new OracleError("unknown scenario kind");
}
