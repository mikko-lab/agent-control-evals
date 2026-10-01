import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveExpected, OracleError } from "../src/oracle/expected";
import { checkOracleBoundary } from "../src/oracle/boundary-check";
import type { CapabilitySpec, GrantSpec, RequestStep, RuntimeScenario } from "../src/corpus/types";

const ROOT = join(__dirname, "..", "..");
const cap = (o: Partial<CapabilitySpec> = {}): CapabilitySpec => ({ present: true, agent: "a", session: "s1", allowed_tools: ["read_record", "update_record"], issued_offset_ms: -1000, expires_offset_ms: 60_000, signature: "valid", ...o });
const req = (o: Partial<RequestStep> = {}): RequestStep => ({ op: "request", request: "q1", session: "s1", agent: "a", tool: "read_record", timestamp_offset_ms: 0, signature: "valid", capability: cap(), tool_output: { ok: 1 }, ...o });
const grant = (o: Partial<GrantSpec> = {}): GrantSpec => ({ version: 2, decision: "approve", session: "s1", request: "q1", tool: "update_record", approver_id: "demo-operator", issued_offset_ms: 0, ...o });
const rt = (steps: RuntimeScenario["steps"]): RuntimeScenario => ({ kind: "runtime", steps });

test("several independent violations: outcome DENY, every violated control is an acceptable reason", () => {
  const o = deriveExpected(rt([req({ capability: cap({ agent: "b", expires_offset_ms: -1, issued_offset_ms: -5000 }) })]));
  assert.equal(o.assertions[0].outcome, "DENY");
  assert.deepEqual(o.assertions[0].acceptable_reason_classes, ["CAPABILITY_AGENT_MISMATCH", "CAPABILITY_EXPIRED"]);
});

test("capability validity window is issued_at <= now < expires_at", () => {
  assert.equal(deriveExpected(rt([req({ capability: cap({ expires_offset_ms: 0 }) })])).assertions[0].outcome, "DENY");
  assert.equal(deriveExpected(rt([req({ capability: cap({ expires_offset_ms: 1 }) })])).assertions[0].outcome, "ALLOW");
  assert.equal(deriveExpected(rt([req({ capability: cap({ issued_offset_ms: 0 }) })])).assertions[0].outcome, "ALLOW");
  assert.equal(deriveExpected(rt([req({ capability: cap({ issued_offset_ms: 1, expires_offset_ms: 9_000 }) })])).assertions[0].outcome, "DENY");
});

test("freshness window is inclusive at +/-300000 ms and a stale attempt does not poison the request id", () => {
  assert.equal(deriveExpected(rt([req({ timestamp_offset_ms: 300_000 })])).assertions[0].outcome, "ALLOW");
  assert.equal(deriveExpected(rt([req({ timestamp_offset_ms: -300_001 })])).assertions[0].outcome, "DENY");
  const o = deriveExpected(rt([req({ timestamp_offset_ms: -400_000 }), req()]));
  assert.deepEqual(o.assertions.map((a) => a.outcome), ["DENY", "ALLOW", "DELIVER"]);
});

test("a request id that passed the replay stage is consumed even when capability later denies it", () => {
  const o = deriveExpected(rt([req({ capability: cap({ expires_offset_ms: -1, issued_offset_ms: -9_000 }) }), req()]));
  assert.deepEqual(o.assertions[1].acceptable_reason_classes, ["REPLAY_DETECTED"]);
});

test("ASK -> approve executes once; a replayed grant is PENDING_ACTION_NOT_FOUND", () => {
  const o = deriveExpected(rt([req({ tool: "update_record" }), { op: "approve", grant: grant() }, { op: "approve", grant: grant() }]));
  assert.deepEqual(o.assertions.map((a) => `${a.stage}:${a.outcome}`), ["request:ASK", "approval:EXECUTE", "result:DELIVER", "approval:REJECT"]);
  assert.deepEqual(o.invariants.executions, { "s1/q1": 1 });
});

test("binding failures preserve the pending action; expiry consumes it", () => {
  const keep = deriveExpected(rt([req({ tool: "update_record" }), { op: "approve", grant: grant({ tool: "read_record" }) }, { op: "approve", grant: grant() }]));
  assert.deepEqual(keep.assertions.map((a) => a.outcome), ["ASK", "REJECT", "EXECUTE", "DELIVER"]);
  const gone = deriveExpected(rt([req({ tool: "update_record" }), { op: "advance_clock", ms: 300_001 }, { op: "approve", grant: grant() }, { op: "approve", grant: grant() }]));
  assert.deepEqual(gone.assertions.map((a) => a.acceptable_reason_classes), [["POLICY_ASK"], ["APPROVAL_EXPIRED"], ["PENDING_ACTION_NOT_FOUND"]]);
});

test("the oracle refuses to guess pending state the declared spec does not determine", () => {
  assert.throws(() => deriveExpected(rt([req({ tool: "update_record" }), { op: "approve", grant: grant({ issued_offset_ms: -1 }) }, { op: "approve", grant: grant() }])), OracleError);
});

test("post-signature tampering: INVALID_SIGNATURE and the field's mismatch are both acceptable", () => {
  const o = deriveExpected(rt([req({ tool: "update_record" }), req({ tool: "update_record", request: "q2" }), { op: "approve", grant: grant({ tamper: { field: "request", value: "q2" } }) }]));
  assert.deepEqual(o.assertions[2].acceptable_reason_classes, ["APPROVAL_REQUEST_MISMATCH", "INVALID_SIGNATURE"]);
});

test("concurrent duplicate approvals: one EXECUTE, the rest REJECT, the step is order-agnostic", () => {
  const o = deriveExpected(rt([req({ tool: "update_record" }), { op: "concurrent_approve", grants: [grant(), grant(), grant()] }]));
  assert.deepEqual(o.unordered_steps, [1]);
  assert.deepEqual(o.assertions.filter((a) => a.stage === "approval").map((a) => a.outcome).sort(), ["EXECUTE", "REJECT", "REJECT"]);
  assert.deepEqual(o.invariants.executions, { "s1/q1": 1 });
});

test("result withholding follows the declared top-level classification rule", () => {
  const w = deriveExpected(rt([req({ tool_output: { classification: "restricted" } })]));
  assert.equal(w.assertions[1].outcome, "WITHHOLD");
  const d = deriveExpected(rt([req({ tool_output: { nested: { classification: "public" } } })]));
  assert.equal(d.assertions[1].outcome, "DELIVER");
});

test("verifier and permit components have their own outcome vocabularies", () => {
  const v = deriveExpected({ kind: "component", component: "approval_grant_verifier", grant: grant({ request: "q2" }), context: { session: "s1", request: "q1", tool: "update_record", approver_id: "demo-operator" } });
  assert.equal(v.assertions[0].stage, "verifier");
  assert.equal(v.assertions[0].outcome, "REJECT");
  const p = deriveExpected({ kind: "component", component: "execution_gate", permit: { session: "s1", request: "q1", tool: "read_record", forged: false }, attempts: [{ session: "s1", request: "q1", tool: "read_record" }, { session: "s1", request: "q1", tool: "read_record" }], concurrent: true, tool_output: null });
  assert.equal(p.assertions[0].outcome, "REUSE_BLOCKED");
  assert.equal(p.invariants.permit_reuses_accepted, 0);
});

test("static oracle boundary: clean tree passes, an injected adapter/SUT/fs dependency fails", () => {
  assert.equal(checkOracleBoundary(ROOT).ok, true);
  for (const inject of ['import "../adapter/protocol";', 'import "../sut/checkout";', 'import "node:fs";', 'import "../eval/compare";', 'const x = require(process.env.X as string);']) {
    const tmp = mkdtempSync(join(tmpdir(), "ace-oracle-"));
    cpSync(join(ROOT, "src"), join(tmp, "src"), { recursive: true });
    const f = join(tmp, "src", "oracle", "expected.ts");
    writeFileSync(f, `${inject}\n${readFileSync(f, "utf8")}`);
    assert.equal(checkOracleBoundary(tmp).ok, false, inject);
  }
});
