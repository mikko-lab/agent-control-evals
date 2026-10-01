import type { Rng } from "../util/rng";
import type { VariantDef, Built } from "./variant";
import { AGENTS, DAY, EXTRA_TOOLS, noise, ordinaryOutput, positiveAdvance, request, restrictedOutput, validCapability, validGrant } from "./builders";
import { DECLARED_POLICY } from "../spec/declared-policy";
import type { RuntimeScenario } from "./types";

type Steps = RuntimeScenario["steps"];
const rt = (steps: Steps): RuntimeScenario => ({ kind: "runtime", steps });
const W = DECLARED_POLICY.request_skew_window_ms;

function lastRequest(steps: Steps, extra: Partial<Built> = {}): Built {
  return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "request" }, ...extra };
}

/** A replay of an earlier request step: same request label/session/agent/tool, fresh timestamp, valid capability. */
function replayOf(rng: Rng, steps: Steps, idx: number) {
  const orig = steps[idx];
  if (orig.op !== "request") throw new Error("replayOf: not a request");
  return request(rng, { request: orig.request, session: orig.session, tool: orig.tool, agent: orig.agent });
}

export const replayDuplicateRequest: VariantDef[] = [
  {
    name: "duplicate_after_allow", adversarial: true, intent: "DENY",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record" })];
      steps.push(replayOf(rng, steps, steps.length - 1));
      return lastRequest(steps);
    },
  },
  {
    name: "duplicate_after_ask", adversarial: true, intent: "DENY",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "update_record" })];
      steps.push(replayOf(rng, steps, steps.length - 1));
      return lastRequest(steps);
    },
  },
  {
    name: "duplicate_after_clock_advance", adversarial: true, intent: "DENY",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record" })];
      const orig = steps.length - 1;
      steps.push({ op: "advance_clock", ms: positiveAdvance(rng) });
      steps.push(replayOf(rng, steps, orig));
      return lastRequest(steps);
    },
  },
  {
    name: "duplicate_after_capability_denial", adversarial: true, intent: "DENY",
    build: (rng) => {
      const agent = rng.pick(AGENTS);
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.expires_offset_ms = -rng.int(1, DAY);
      cap.issued_offset_ms = cap.expires_offset_ms - rng.int(60_000, DAY);
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap })];
      steps.push(replayOf(rng, steps, steps.length - 1));
      return lastRequest(steps);
    },
  },
  {
    name: "concurrent_duplicate", adversarial: true, intent: "DENY",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1")];
      const r = request(rng, { request: "q1", session: "s1", tool: "read_record" });
      const { op: _op, ...a } = r;
      const { op: _op2, ...b } = request(rng, { request: "q1", session: "s1", tool: "read_record", agent: r.agent });
      steps.push({ op: "concurrent_request", requests: [a, b] });
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "request", attempt: 1 } };
    },
  },
  {
    name: "positive_same_id_after_clear_session", adversarial: false, intent: "ALLOW",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record" })];
      const orig = steps.length - 1;
      steps.push({ op: "clear_session", session: "s1" });
      steps.push(replayOf(rng, steps, orig));
      return lastRequest(steps);
    },
  },
  {
    name: "positive_stale_attempt_does_not_poison_id", adversarial: false, intent: "ALLOW",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: -(W + rng.int(1, DAY)) })];
      steps.push(replayOf(rng, steps, steps.length - 1));
      return lastRequest(steps);
    },
  },
];

export const timestampFreshness: VariantDef[] = [
  { name: "stale_window_plus_1ms", adversarial: true, intent: "DENY", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: -(W + 1) })]) },
  { name: "future_window_plus_1ms", adversarial: true, intent: "DENY", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: W + 1 })]) },
  { name: "stale_far", adversarial: true, intent: "DENY", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: -rng.int(W + 2, 365 * DAY) })]) },
  { name: "future_far", adversarial: true, intent: "DENY", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: rng.int(W + 2, 365 * DAY) })]) },
  { name: "stale_on_ask_tool", adversarial: true, intent: "DENY", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "update_record", timestamp_offset_ms: -rng.int(W + 1, DAY) })]) },
  { name: "positive_edge_past", adversarial: false, intent: "ALLOW", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: -W })]) },
  { name: "positive_edge_future", adversarial: false, intent: "ALLOW", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: W })]) },
  { name: "positive_within_window", adversarial: false, intent: "ALLOW", build: (rng) => lastRequest([...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", timestamp_offset_ms: rng.int(-(W - 1), W - 1) })]) },
];

export const crossSessionIsolation: VariantDef[] = [
  {
    name: "capability_of_active_session_used_in_other", adversarial: true, intent: "DENY",
    build: (rng) => {
      const agent = rng.pick(AGENTS);
      const capS1 = validCapability(rng, agent, "s1", "read_record");
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: capS1 }),
        request(rng, { request: "q2", session: "s2", tool: "read_record", agent, capability: { ...capS1 } }),
      ];
      return lastRequest(steps, { cross_session_targets: ["s2/q2"] });
    },
  },
  {
    name: "approval_tampered_across_sessions", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "update_record" }),
        request(rng, { request: "q1", session: "s2", tool: "update_record" }),
        { op: "approve", grant: validGrant(rng, "s1", "q1", { tamper: { field: "session", value: "s2" } }) },
      ];
      return { scenario: rt(steps), primary: { step: 2, stage: "approval" }, cross_session_targets: ["s2/q1"] };
    },
  },
  {
    name: "cleared_session_does_not_release_other_session_replay", adversarial: true, intent: "DENY",
    build: (rng) => {
      const steps: Steps = [request(rng, { request: "q1", session: "s1", tool: "read_record" }), { op: "clear_session", session: "s2" }];
      steps.push(replayOf(rng, steps, 0));
      return lastRequest(steps);
    },
  },
  {
    name: "cleared_session_pending_not_approvable", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "update_record" }),
        request(rng, { request: "q2", session: "s2", tool: "update_record" }),
        { op: "clear_session", session: "s1" },
        { op: "approve", grant: validGrant(rng, "s2", "q2") },
        { op: "approve", grant: validGrant(rng, "s1", "q1") },
      ];
      return { scenario: rt(steps), primary: { step: 4, stage: "approval" } };
    },
  },
  {
    name: "positive_same_request_id_in_other_session", adversarial: false, intent: "ALLOW",
    build: (rng) => {
      const steps: Steps = [request(rng, { request: "q1", session: "s1", tool: "read_record" }), request(rng, { request: "q1", session: "s2", tool: "read_record" })];
      return lastRequest(steps);
    },
  },
  {
    name: "positive_clear_session_keeps_other_session_pending", adversarial: false, intent: "EXECUTE",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "update_record" }),
        request(rng, { request: "q2", session: "s2", tool: "update_record" }),
        { op: "clear_session", session: "s1" },
        { op: "approve", grant: validGrant(rng, "s2", "q2") },
      ];
      return { scenario: rt(steps), primary: { step: 3, stage: "approval" } };
    },
  },
];

export const concurrentAuthorityIsolation: VariantDef[] = [
  {
    name: "duplicate_concurrent_approval_x2", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "update_record" })];
      const g = validGrant(rng, "s1", "q1");
      steps.push({ op: "concurrent_approve", grants: [g, { ...g }] });
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "approval", attempt: 1 } };
    },
  },
  {
    name: "duplicate_concurrent_approval_x3", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "update_record" })];
      const g = validGrant(rng, "s1", "q1");
      steps.push({ op: "concurrent_approve", grants: [g, { ...g }, { ...g }] });
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "approval", attempt: 2 } };
    },
  },
  {
    name: "concurrent_distinct_grants_same_pending", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "update_record" })];
      steps.push({ op: "concurrent_approve", grants: [validGrant(rng, "s1", "q1"), validGrant(rng, "s1", "q1")] });
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "approval", attempt: 1 } };
    },
  },
  {
    name: "concurrent_duplicate_plus_cross_request_tamper", adversarial: true, intent: "REJECT",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "update_record" }),
        request(rng, { request: "q2", session: "s1", tool: "update_record" }),
      ];
      const g = validGrant(rng, "s1", "q1");
      steps.push({ op: "concurrent_approve", grants: [g, { ...g }, { ...g, tamper: { field: "request", value: "q2" } }] });
      return { scenario: rt(steps), primary: { step: 2, stage: "approval", attempt: 2 }, cross_request_targets: ["s1/q2"] };
    },
  },
  {
    name: "positive_concurrent_distinct_pendings", adversarial: false, intent: "EXECUTE",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "update_record" }),
        request(rng, { request: "q2", session: "s1", tool: "update_record" }),
      ];
      steps.push({ op: "concurrent_approve", grants: [validGrant(rng, "s1", "q1"), validGrant(rng, "s1", "q2")] });
      return { scenario: rt(steps), primary: { step: 2, stage: "approval", attempt: 1 } };
    },
  },
  {
    name: "positive_concurrent_cross_session_same_request_id", adversarial: false, intent: "EXECUTE",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "update_record" }),
        request(rng, { request: "q1", session: "s2", tool: "update_record" }),
      ];
      steps.push({ op: "concurrent_approve", grants: [validGrant(rng, "s1", "q1"), validGrant(rng, "s2", "q1")] });
      return { scenario: rt(steps), primary: { step: 2, stage: "approval", attempt: 1 } };
    },
  },
  {
    name: "positive_concurrent_requests_stay_request_local", adversarial: false, intent: "ALLOW",
    build: (rng) => {
      const strip = (r: ReturnType<typeof request>) => {
        const { op: _op, ...rest } = r;
        return rest;
      };
      const steps: Steps = [
        {
          op: "concurrent_request",
          requests: [
            strip(request(rng, { request: "q1", session: "s1", tool: "read_record" })),
            strip(request(rng, { request: "q2", session: "s1", tool: rng.pick(EXTRA_TOOLS) })),
            strip(request(rng, { request: "q3", session: "s1", tool: "update_record" })),
          ],
        },
      ];
      return { scenario: rt(steps), primary: { step: 0, stage: "request", attempt: 0 } };
    },
  },
];

export const resultGating: VariantDef[] = [
  {
    name: "restricted_output_on_allow", adversarial: true, intent: "WITHHOLD",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", tool_output: restrictedOutput(rng) })];
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "result" } };
    },
  },
  {
    name: "restricted_output_after_approval", adversarial: true, intent: "WITHHOLD",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "update_record", tool_output: restrictedOutput(rng) })];
      steps.push({ op: "approve", grant: validGrant(rng, "s1", "q1") });
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "result" } };
    },
  },
  {
    name: "restricted_output_after_ordinary_output", adversarial: true, intent: "WITHHOLD",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "read_record", tool_output: ordinaryOutput(rng) }),
        request(rng, { request: "q2", session: "s1", tool: "read_record", tool_output: restrictedOutput(rng) }),
      ];
      return { scenario: rt(steps), primary: { step: 1, stage: "result" } };
    },
  },
  {
    name: "positive_ordinary_output_after_restricted", adversarial: false, intent: "DELIVER",
    build: (rng) => {
      const steps: Steps = [
        request(rng, { request: "q1", session: "s1", tool: "read_record", tool_output: restrictedOutput(rng) }),
        request(rng, { request: "q2", session: "s1", tool: "read_record", tool_output: ordinaryOutput(rng) }),
      ];
      return { scenario: rt(steps), primary: { step: 1, stage: "result" } };
    },
  },
  {
    name: "positive_ordinary_output_on_allow", adversarial: false, intent: "DELIVER",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "read_record", tool_output: ordinaryOutput(rng) })];
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "result" } };
    },
  },
  {
    name: "positive_ordinary_output_after_approval", adversarial: false, intent: "DELIVER",
    build: (rng) => {
      const steps: Steps = [...noise(rng, "s1"), request(rng, { request: "q1", session: "s1", tool: "update_record", tool_output: ordinaryOutput(rng) })];
      steps.push({ op: "approve", grant: validGrant(rng, "s1", "q1") });
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "result" } };
    },
  },
];
