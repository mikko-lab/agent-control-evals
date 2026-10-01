import type { VariantDef } from "./variant";
import { AGENTS, DAY, HOUR, EXTRA_TOOLS, noise, otherOf, request, validCapability } from "./builders";
import type { RuntimeScenario } from "./types";

const rt = (steps: RuntimeScenario["steps"]): RuntimeScenario => ({ kind: "runtime", steps });

/** Builds [noise..., target] in session s1 and returns the target index. */
function single(rng: import("../util/rng").Rng, mk: (agent: string) => RuntimeScenario["steps"][number]) {
  const steps: RuntimeScenario["steps"] = [...noise(rng, "s1")];
  steps.push(mk(rng.pick(AGENTS)));
  return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "request" as const } };
}

export const capabilityAgentBinding: VariantDef[] = [
  {
    name: "agent_mismatch_other_agent", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const tool = "read_record";
      const cap = validCapability(rng, otherOf(rng, AGENTS, agent), "s1", tool);
      return request(rng, { request: "q1", session: "s1", tool, agent, capability: cap });
    }),
  },
  {
    name: "agent_mismatch_case_variant", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent.toUpperCase(), "s1", "read_record");
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "agent_mismatch_suffix", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, `${agent}-${rng.int(2, 9)}`, "s1", "read_record");
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "agent_mismatch_on_ask_tool", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, otherOf(rng, AGENTS, agent), "s1", "update_record");
      return request(rng, { request: "q1", session: "s1", tool: "update_record", agent, capability: cap });
    }),
  },
  {
    name: "agent_mismatch_and_expired", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, otherOf(rng, AGENTS, agent), "s1", "read_record");
      cap.issued_offset_ms = -rng.int(2 * HOUR, 4 * HOUR);
      cap.expires_offset_ms = -rng.int(1, HOUR);
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "positive_agent_match_allow", adversarial: false, intent: "ALLOW",
    build: (rng) => single(rng, (agent) => request(rng, { request: "q1", session: "s1", tool: "read_record", agent })),
  },
  {
    name: "positive_agent_match_ask", adversarial: false, intent: "ASK",
    build: (rng) => single(rng, (agent) => request(rng, { request: "q1", session: "s1", tool: "update_record", agent })),
  },
];

export const capabilitySessionBinding: VariantDef[] = [
  {
    name: "session_mismatch_other_session", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s2", "read_record");
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "session_mismatch_on_ask_tool", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s2", "update_record");
      return request(rng, { request: "q1", session: "s1", tool: "update_record", agent, capability: cap });
    }),
  },
  {
    name: "session_capability_stolen_from_active_session", adversarial: true, intent: "DENY",
    build: (rng) => {
      const agent = rng.pick(AGENTS);
      const victimCap = validCapability(rng, agent, "s2", "update_record");
      const steps: RuntimeScenario["steps"] = [
        request(rng, { request: "v1", session: "s2", tool: "read_record", agent }),
        ...noise(rng, "s1"),
        request(rng, { request: "q1", session: "s1", tool: "update_record", agent, capability: victimCap }),
      ];
      return { scenario: rt(steps), primary: { step: steps.length - 1, stage: "request" } };
    },
  },
  {
    name: "session_and_tool_mismatch", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s2", rng.pick(EXTRA_TOOLS));
      cap.allowed_tools = cap.allowed_tools!.filter((t) => t !== "read_record");
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "positive_session_match", adversarial: false, intent: "ALLOW",
    build: (rng) => single(rng, (agent) => request(rng, { request: "q1", session: "s1", tool: "read_record", agent })),
  },
];

export const capabilityToolScope: VariantDef[] = [
  {
    name: "read_not_in_scope", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", rng.pick(EXTRA_TOOLS));
      cap.allowed_tools = cap.allowed_tools!.filter((t) => t !== "read_record");
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "update_not_in_scope", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.allowed_tools = cap.allowed_tools!.filter((t) => t !== "update_record");
      return request(rng, { request: "q1", session: "s1", tool: "update_record", agent, capability: cap });
    }),
  },
  {
    name: "near_name_scope", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", rng.pick(["read_records", "Read_record", "read_record ", "readrecord", "read-record"]));
      cap.allowed_tools = cap.allowed_tools!.filter((t) => t !== "read_record");
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "wildcard_scope", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.allowed_tools = [rng.pick(["*", "read_*", "*_record"])];
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "in_scope_unknown_tool_policy_deny", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const tool = rng.pick(EXTRA_TOOLS);
      return request(rng, { request: "q1", session: "s1", tool, agent });
    }),
  },
  {
    name: "positive_exact_scope_allow", adversarial: false, intent: "ALLOW",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.allowed_tools = ["read_record"];
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "positive_exact_scope_ask", adversarial: false, intent: "ASK",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "update_record");
      cap.allowed_tools = ["update_record"];
      return request(rng, { request: "q1", session: "s1", tool: "update_record", agent, capability: cap });
    }),
  },
];

export const capabilityExpired: VariantDef[] = [
  {
    name: "expired_1ms_ago", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.expires_offset_ms = -1;
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "expires_exactly_now", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.expires_offset_ms = 0;
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "expired_long_ago", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.expires_offset_ms = -rng.int(HOUR, 30 * DAY);
      cap.issued_offset_ms = cap.expires_offset_ms - rng.int(60_000, DAY);
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "expired_on_ask_tool", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "update_record");
      cap.expires_offset_ms = -rng.int(1, HOUR);
      cap.issued_offset_ms = cap.expires_offset_ms - rng.int(60_000, DAY);
      return request(rng, { request: "q1", session: "s1", tool: "update_record", agent, capability: cap });
    }),
  },
  {
    name: "positive_expires_in_1ms", adversarial: false, intent: "ALLOW",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.expires_offset_ms = 1;
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "positive_expires_later", adversarial: false, intent: "ALLOW",
    build: (rng) => single(rng, (agent) => request(rng, { request: "q1", session: "s1", tool: "read_record", agent })),
  },
];

export const capabilityNotYetValid: VariantDef[] = [
  {
    name: "issued_in_1ms", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.issued_offset_ms = 1;
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "issued_far_future", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.issued_offset_ms = rng.int(60_000, 30 * DAY);
      cap.expires_offset_ms = cap.issued_offset_ms + rng.int(60_000, DAY);
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "not_yet_valid_on_ask_tool", adversarial: true, intent: "DENY",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "update_record");
      cap.issued_offset_ms = rng.int(1, HOUR);
      cap.expires_offset_ms = cap.issued_offset_ms + rng.int(60_000, DAY);
      return request(rng, { request: "q1", session: "s1", tool: "update_record", agent, capability: cap });
    }),
  },
  {
    name: "positive_issued_exactly_now", adversarial: false, intent: "ALLOW",
    build: (rng) => single(rng, (agent) => {
      const cap = validCapability(rng, agent, "s1", "read_record");
      cap.issued_offset_ms = 0;
      return request(rng, { request: "q1", session: "s1", tool: "read_record", agent, capability: cap });
    }),
  },
  {
    name: "positive_issued_in_past", adversarial: false, intent: "ALLOW",
    build: (rng) => single(rng, (agent) => request(rng, { request: "q1", session: "s1", tool: "read_record", agent })),
  },
];
