/**
 * Scenario building blocks used by the family generators. Pure functions of
 * the deterministic Rng; no wall clock, no randomness outside Rng.
 */
import { Rng } from "../util/rng";
import { DECLARED_POLICY, MAX_POSITIVE_CLOCK_ADVANCE_MS } from "../spec/declared-policy";
import type { CapabilitySpec, GrantSpec, Json, RequestStep } from "./types";

export const AGENTS = ["agent-alpha", "agent-bravo", "agent-charlie", "agent-delta", "agent-echo"];
export const EXTRA_TOOLS = ["delete_record", "write_record", "system_shell", "read_all_records", "export_records"];
export const APPROVER = DECLARED_POLICY.ask_approver_id;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function otherOf<T>(rng: Rng, items: readonly T[], not: T): T {
  const pool = items.filter((x) => x !== not);
  return rng.pick(pool);
}

export function ordinaryOutput(rng: Rng): Json {
  const shapes: (() => Json)[] = [
    () => ({ status: "ok", record_id: `rec-${rng.hex(4)}`, revision: rng.int(1, 999) }),
    () => ({ status: "ok", rows: [rng.int(0, 99), rng.int(0, 99)], classification: "public" }),
    () => ({ classification: "internal", summary: `summary-${rng.hex(3)}` }),
    () => `plain-text-${rng.hex(4)}`,
    () => [rng.int(0, 9), `item-${rng.hex(2)}`],
    () => ({ status: "ok", nested: { classification: "public" } }),
  ];
  return rng.pick(shapes)();
}

export function restrictedOutput(rng: Rng): Json {
  const shapes: (() => Json)[] = [
    () => ({ classification: "restricted", record_id: `rec-${rng.hex(4)}`, ssn: `000-00-${rng.int(1000, 9999)}` }),
    () => ({ classification: "restricted" }),
    () => ({ status: "ok", classification: "restricted", rows: [rng.int(0, 99)] }),
  ];
  return rng.pick(shapes)();
}

export function validCapability(rng: Rng, agent: string, session: string, tool: string): CapabilitySpec {
  const extras = EXTRA_TOOLS.filter(() => rng.int(0, 1) === 1);
  const base = new Set<string>([tool, ...extras]);
  if (rng.int(0, 1) === 1) base.add("read_record");
  if (rng.int(0, 1) === 1) base.add("update_record");
  return {
    present: true,
    agent,
    session,
    allowed_tools: [...base].sort(),
    issued_offset_ms: -rng.int(1_000, 10 * 60_000),
    expires_offset_ms: rng.int(10 * 60_000, 8 * HOUR),
    signature: "valid",
  };
}

export interface ReqOpts {
  request: string;
  session: string;
  tool: string;
  agent?: string;
  timestamp_offset_ms?: number;
  signature?: "valid" | "tampered";
  capability?: CapabilitySpec;
  tool_output?: Json;
}

export function request(rng: Rng, o: ReqOpts): RequestStep {
  const agent = o.agent ?? rng.pick(AGENTS);
  return {
    op: "request",
    request: o.request,
    session: o.session,
    agent,
    tool: o.tool,
    timestamp_offset_ms: o.timestamp_offset_ms ?? rng.int(-5_000, 5_000),
    signature: o.signature ?? "valid",
    capability: o.capability ?? validCapability(rng, agent, o.session, o.tool),
    tool_output: o.tool_output ?? ordinaryOutput(rng),
  };
}

/** A grant that the declared spec would accept for a pending update_record created at the current clock. */
export function validGrant(rng: Rng, session: string, req: string, over: Partial<GrantSpec> = {}): GrantSpec {
  return {
    version: 2,
    decision: "approve",
    session,
    request: req,
    tool: "update_record",
    approver_id: APPROVER,
    issued_offset_ms: rng.int(0, 5_000),
    ...over,
  };
}

/** 0-2 benign, unrelated read requests in the given session (state noise). */
export function noise(rng: Rng, session: string, prefix = "n"): RequestStep[] {
  const n = rng.int(0, 2);
  const out: RequestStep[] = [];
  for (let i = 0; i < n; i++) out.push(request(rng, { request: `${prefix}${i + 1}`, session, tool: "read_record" }));
  return out;
}

export function positiveAdvance(rng: Rng): number {
  return rng.int(1_000, MAX_POSITIVE_CLOCK_ADVANCE_MS);
}
