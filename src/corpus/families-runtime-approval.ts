import type { Rng } from "../util/rng";
import type { VariantDef, Built } from "./variant";
import { APPROVER, DAY, EXTRA_TOOLS, HOUR, noise, positiveAdvance, request, validGrant } from "./builders";
import { DECLARED_POLICY } from "../spec/declared-policy";
import type { GrantSpec, RuntimeScenario } from "./types";

type Steps = RuntimeScenario["steps"];
const rt = (steps: Steps): RuntimeScenario => ({ kind: "runtime", steps });

/** Setup: optional noise, then an update_record ASK for s1/q1. */
function askSetup(rng: Rng, session = "s1", req = "q1"): Steps {
  return [...noise(rng, session), request(rng, { request: req, session, tool: "update_record" })];
}

function approveLast(steps: Steps, grant: GrantSpec, extra: Partial<Built> = {}): Built {
  steps.push({ op: "approve", grant });
  return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "approval" }, ...extra };
}

const positiveApproval: VariantDef = {
  name: "positive_valid_approval", adversarial: false, intent: "EXECUTE",
  build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1")),
};

export const approvalWrongRequestRuntime: VariantDef[] = [
  {
    name: "grant_for_never_requested_id", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q9"), { cross_request_targets: ["s1/q1"] }),
  },
  {
    name: "grant_tampered_to_other_pending_request", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = [...askSetup(rng), request(rng, { request: "q2", session: "s1", tool: "update_record" })];
      return approveLast(steps, validGrant(rng, "s1", "q1", { tamper: { field: "request", value: "q2" } }), {
        cross_request_targets: ["s1/q2"],
      });
    },
  },
  {
    name: "grant_replayed_after_consumption", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = askSetup(rng);
      const g = validGrant(rng, "s1", "q1");
      steps.push({ op: "approve", grant: g });
      return approveLast(steps, { ...g });
    },
  },
  {
    name: "grant_for_denied_request", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = [...askSetup(rng), request(rng, { request: "q3", session: "s1", tool: rng.pick(EXTRA_TOOLS) })];
      return approveLast(steps, validGrant(rng, "s1", "q3"), { cross_request_targets: ["s1/q1"] });
    },
  },
  {
    name: "grant_for_allowed_request", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = [...askSetup(rng), request(rng, { request: "q4", session: "s1", tool: "read_record" })];
      return approveLast(steps, validGrant(rng, "s1", "q4", { tool: "read_record" }), { cross_request_targets: ["s1/q1"] });
    },
  },
  positiveApproval,
];

export const approvalWrongSessionRuntime: VariantDef[] = [
  {
    name: "grant_signed_for_other_session", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s2", "q1"), { cross_session_targets: ["s1/q1"] }),
  },
  {
    name: "grant_tampered_to_other_session_same_request", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = [...askSetup(rng, "s1", "q1"), ...askSetup(rng, "s2", "q1")];
      return approveLast(steps, validGrant(rng, "s1", "q1", { tamper: { field: "session", value: "s2" } }), {
        cross_session_targets: ["s2/q1"],
      });
    },
  },
  {
    name: "grant_after_session_cleared", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...askSetup(rng), { op: "clear_session", session: "s1" }];
      return approveLast(steps, validGrant(rng, "s1", "q1"));
    },
  },
  {
    name: "other_session_grant_with_both_pending", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = [...askSetup(rng, "s1", "q1"), ...askSetup(rng, "s2", "q2")];
      return approveLast(steps, validGrant(rng, "s1", "q2"), { cross_session_targets: ["s2/q2"] });
    },
  },
  positiveApproval,
];

export const approvalToolBinding: VariantDef[] = [
  {
    name: "grant_for_read_record", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { tool: "read_record" })),
  },
  {
    name: "grant_for_unknown_tool", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { tool: rng.pick(EXTRA_TOOLS) })),
  },
  {
    name: "grant_tool_case_variant", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { tool: rng.pick(["Update_record", "UPDATE_RECORD", "update_record "]) })),
  },
  {
    name: "grant_tool_tampered_after_signing", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { tool: "read_record", tamper: { field: "tool", value: "update_record" } })),
  },
  {
    name: "tool_mismatch_preserves_pending_then_valid", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = askSetup(rng);
      steps.push({ op: "approve", grant: validGrant(rng, "s1", "q1", { tool: "read_record" }) });
      const primary = steps.length - 1;
      steps.push({ op: "approve", grant: validGrant(rng, "s1", "q1") });
      return { scenario: rt(steps), primary: { step: primary, stage: "approval" } };
    },
  },
  positiveApproval,
];

export const approvalApproverBinding: VariantDef[] = [
  {
    name: "other_approver", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { approver_id: rng.pick(["ops-on-call", "agent-alpha", "security-bot", "admin"]) })),
  },
  {
    name: "approver_case_variant", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { approver_id: rng.pick(["Demo-Operator", "DEMO-OPERATOR", "demo-Operator"]) })),
  },
  {
    name: "approver_suffix", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { approver_id: `${APPROVER}${rng.pick(["-2", "_admin", " ", "."])}` })),
  },
  {
    name: "approver_tampered_after_signing", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { approver_id: "ops-on-call", tamper: { field: "approver_id", value: APPROVER } })),
  },
  {
    name: "approver_mismatch_preserves_pending_then_valid", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps = askSetup(rng);
      steps.push({ op: "approve", grant: validGrant(rng, "s1", "q1", { approver_id: "ops-on-call" }) });
      const primary = steps.length - 1;
      steps.push({ op: "approve", grant: validGrant(rng, "s1", "q1") });
      return { scenario: rt(steps), primary: { step: primary, stage: "approval" } };
    },
  },
  positiveApproval,
];

const T = DECLARED_POLICY.ask_timeout_ms;

export const approvalPendingTimeout: VariantDef[] = [
  {
    name: "expired_by_1ms", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: T + 1 }];
      return approveLast(steps, validGrant(rng, "s1", "q1", { issued_offset_ms: -rng.int(0, 1_000) }));
    },
  },
  {
    name: "expired_long_ago", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: T + rng.int(2, DAY) }];
      return approveLast(steps, validGrant(rng, "s1", "q1"));
    },
  },
  {
    name: "expired_then_retry", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: T + rng.int(1, HOUR) }];
      steps.push({ op: "approve", grant: validGrant(rng, "s1", "q1") });
      return approveLast(steps, validGrant(rng, "s1", "q1"));
    },
  },
  {
    name: "positive_within_timeout", adversarial: false, intent: "EXECUTE",
    build: (rng) => {
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: positiveAdvance(rng) }];
      return approveLast(steps, validGrant(rng, "s1", "q1", { issued_offset_ms: -rng.int(0, 500) }));
    },
  },
  {
    name: "positive_human_reject_within_timeout", adversarial: false, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: positiveAdvance(rng) }];
      return approveLast(steps, validGrant(rng, "s1", "q1", { decision: "reject", issued_offset_ms: 0 }));
    },
  },
];

export const approvalIssuedBeforeAsk: VariantDef[] = [
  {
    name: "issued_1ms_before_ask", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { issued_offset_ms: -1 })),
  },
  {
    name: "issued_long_before_ask", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { issued_offset_ms: -rng.int(1_000, DAY) })),
  },
  {
    name: "issued_before_ask_after_clock_advance", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const adv = rng.int(10_000, 120_000);
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: adv }];
      return approveLast(steps, validGrant(rng, "s1", "q1", { issued_offset_ms: -(adv + rng.int(1, 60_000)) }));
    },
  },
  {
    name: "positive_issued_exactly_at_ask", adversarial: false, intent: "EXECUTE",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { issued_offset_ms: 0 })),
  },
  {
    name: "positive_issued_between_ask_and_now", adversarial: false, intent: "EXECUTE",
    build: (rng) => {
      const adv = rng.int(10_000, 120_000);
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: adv }];
      return approveLast(steps, validGrant(rng, "s1", "q1", { issued_offset_ms: -rng.int(0, adv) }));
    },
  },
];

const S = DECLARED_POLICY.approval_future_skew_ms;

export const approvalFutureSkew: VariantDef[] = [
  {
    name: "future_by_skew_plus_1ms", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { issued_offset_ms: S + 1 })),
  },
  {
    name: "future_far", adversarial: true, intent: "REJECT",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { issued_offset_ms: rng.int(S + 1_000, 30 * DAY) })),
  },
  {
    name: "future_after_clock_advance", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...askSetup(rng), { op: "advance_clock", ms: rng.int(1_000, 120_000) }];
      return approveLast(steps, validGrant(rng, "s1", "q1", { issued_offset_ms: S + rng.int(1, 600_000) }));
    },
  },
  {
    name: "positive_future_at_skew_limit", adversarial: false, intent: "EXECUTE",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { issued_offset_ms: S })),
  },
  {
    name: "positive_future_within_skew", adversarial: false, intent: "EXECUTE",
    build: (rng) => approveLast(askSetup(rng), validGrant(rng, "s1", "q1", { issued_offset_ms: rng.int(1, S - 1) })),
  },
];
