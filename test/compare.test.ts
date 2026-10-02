import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCase } from "../src/eval/compare";
import type { Case } from "../src/corpus/types";
import type { ObservedAssertion, Observations } from "../src/adapter/protocol";

function mkCase(over: Partial<Case["expected"]>, boundary: "runtime" | "component" = "runtime"): Case {
  return {
    case_schema_version: "0.1.0",
    case_id: "case-x",
    family: "capability_agent_binding",
    variant: "v",
    evaluation_boundary: boundary,
    scenario: { kind: "runtime", steps: [] },
    expected: {
      step: 0,
      stage: "request",
      outcome: "DENY",
      acceptable_reason_classes: ["CAPABILITY_AGENT_MISMATCH", "CAPABILITY_EXPIRED"],
      adversarial: true,
      assertions: [{ step: 0, stage: "request", outcome: "DENY", acceptable_reason_classes: ["CAPABILITY_AGENT_MISMATCH", "CAPABILITY_EXPIRED"] }],
      invariants: { executions: { "s1/q1": 0 } },
      ...over,
    },
  };
}
const obs = (a: Partial<ObservedAssertion>[], executions: Record<string, number> = {}): Observations => ({
  assertions: a.map((x) => ({ step: 0, stage: "request", outcome: "DENY", reason_class: "CAPABILITY_AGENT_MISMATCH", sut_reason_code: "", enforcement_stage: "", ...x }) as ObservedAssertion),
  executions,
  unattributed_executions: 0,
});

test("any acceptable reason matches; a reason outside the set is a reason-only mismatch, not an outcome failure", () => {
  assert.equal(compareCase(mkCase({}), obs([{ reason_class: "CAPABILITY_EXPIRED" }])).exact_match, true);
  const v = compareCase(mkCase({}), obs([{ reason_class: "REPLAY_DETECTED" }]));
  assert.equal(v.outcome_match, true);
  assert.equal(v.exact_match, false);
  assert.equal(v.bypass, false);
  assert.deepEqual(v.mismatches.map((m) => m.kind), ["reason_mismatch"]);
});

test("expected DENY -> actual ALLOW is a false allow and a bypass", () => {
  const v = compareCase(mkCase({}), obs([{ outcome: "ALLOW", reason_class: "POLICY_ALLOW" }, { stage: "result", outcome: "DELIVER", reason_class: "RESULT_POLICY_DELIVER" }], { "s1/q1": 1 }));
  assert.ok(v.mismatches.some((m) => m.kind === "false_allow"));
  assert.ok(v.mismatches.some((m) => m.kind === "invariant_violation"));
  assert.equal(v.bypass, true);
  assert.equal(v.invariants.unexpected_delivery_count, 1);
});

test("expected DENY -> actual ASK is an unexpected escalation, not a false allow", () => {
  const v = compareCase(mkCase({}), obs([{ outcome: "ASK", reason_class: "POLICY_ASK" }]));
  assert.deepEqual(v.mismatches.map((m) => m.kind), ["unexpected_escalation"]);
  assert.equal(v.bypass, false);
});

test("expected ASK -> actual ALLOW is a missed escalation", () => {
  const c = mkCase({ outcome: "ASK", adversarial: false, acceptable_reason_classes: ["POLICY_ASK"], assertions: [{ step: 0, stage: "request", outcome: "ASK", acceptable_reason_classes: ["POLICY_ASK"] }] });
  assert.equal(compareCase(c, obs([{ outcome: "ALLOW", reason_class: "POLICY_ALLOW" }])).mismatches[0].kind, "missed_escalation");
});

test("expected ALLOW -> actual DENY is a false deny", () => {
  const c = mkCase({ outcome: "ALLOW", adversarial: false, acceptable_reason_classes: undefined, assertions: [{ step: 0, stage: "request", outcome: "ALLOW" }] });
  assert.equal(compareCase(c, obs([{ outcome: "DENY" }])).mismatches[0].kind, "false_deny");
});

test("a missing observation is a mismatch, never a pass", () => {
  const v = compareCase(mkCase({}), obs([]));
  assert.equal(v.outcome_match, false);
  assert.equal(v.mismatches[0].kind, "missing_observation");
});

test("concurrent steps are compared as multisets; duplicate execution is an invariant violation", () => {
  const c = mkCase({
    step: 1,
    stage: "approval",
    outcome: "REJECT",
    attempt: 1,
    acceptable_reason_classes: ["PENDING_ACTION_NOT_FOUND"],
    unordered_steps: [1],
    assertions: [
      { step: 1, attempt: 0, stage: "approval", outcome: "EXECUTE", acceptable_reason_classes: ["APPROVAL_GRANTED"] },
      { step: 1, attempt: 0, stage: "result", outcome: "DELIVER", acceptable_reason_classes: ["RESULT_POLICY_DELIVER"] },
      { step: 1, attempt: 1, stage: "approval", outcome: "REJECT", acceptable_reason_classes: ["PENDING_ACTION_NOT_FOUND"] },
    ],
    invariants: { executions: { "s1/q1": 1 } },
  });
  const swapped = obs(
    [
      { step: 1, attempt: 0, stage: "approval", outcome: "REJECT", reason_class: "PENDING_ACTION_NOT_FOUND" },
      { step: 1, attempt: 1, stage: "approval", outcome: "EXECUTE", reason_class: "APPROVAL_GRANTED" },
      { step: 1, attempt: 1, stage: "result", outcome: "DELIVER", reason_class: "RESULT_POLICY_DELIVER" },
    ],
    { "s1/q1": 1 },
  );
  assert.equal(compareCase(c, swapped).exact_match, true);
  const doubled = obs(
    [
      { step: 1, attempt: 0, stage: "approval", outcome: "EXECUTE", reason_class: "APPROVAL_GRANTED" },
      { step: 1, attempt: 0, stage: "result", outcome: "DELIVER", reason_class: "RESULT_POLICY_DELIVER" },
      { step: 1, attempt: 1, stage: "approval", outcome: "EXECUTE", reason_class: "APPROVAL_GRANTED" },
      { step: 1, attempt: 1, stage: "result", outcome: "WITHHOLD", reason_class: "CORRELATION_FAILURE" },
    ],
    { "s1/q1": 2 },
  );
  const v = compareCase(c, doubled);
  assert.equal(v.bypass, true);
  assert.equal(v.invariants.duplicate_execution_count, 1);
  assert.ok(v.mismatches.some((m) => m.kind === "false_allow"));
});

const rec = (o: Partial<import("../src/adapter/protocol").EffectRecord>): import("../src/adapter/protocol").EffectRecord => ({
  step: 0, stage: "request", key: "s1/q1", attribution: "attempt", sut_reports: [], sut_decisions: [], result_control_decisions: [],
  authorized_executions: 0, observed_executions: 0, authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observed: true, ...o,
});

test("integrity: an effect-based ALLOW contradicting the SUT's DENY is a false allow (oracle) AND an unauthorized execution (integrity), counted separately", () => {
  const v = compareCase(mkCase({}), {
    assertions: [
      { step: 0, stage: "request", outcome: "ALLOW", reason_class: "DECISION_EFFECT_MISMATCH", sut_reason_code: "x", enforcement_stage: "effect", sut_decision: "DENY", decision_effect_mismatch: true },
      { step: 0, stage: "result", outcome: "WITHHOLD", reason_class: "DECISION_EFFECT_MISMATCH", sut_reason_code: "x", enforcement_stage: "effect", sut_decision: "NONE", decision_effect_mismatch: true },
    ],
    executions: { "s1/q1": 1 },
    unattributed_executions: 0,
    effect_records: [rec({ sut_decisions: ["DENY"], observed_executions: 1 })],
  });
  const kinds = v.mismatches.map((m) => m.kind);
  assert.ok(kinds.includes("false_allow"));
  assert.ok(kinds.includes("decision_effect_mismatch"));
  assert.equal(v.bypass, true);
  assert.equal(v.integrity.categories.unauthorized_execution, true);
  assert.equal(v.integrity.categories.unauthorized_delivery, false);
});

test("integrity: a missing expected effect is evidence only (outcome still matches, no bypass)", () => {
  const c = mkCase({ stage: "approval", outcome: "REJECT", acceptable_reason_classes: ["APPROVAL_TOOL_MISMATCH"], assertions: [{ step: 0, stage: "approval", outcome: "REJECT", acceptable_reason_classes: ["APPROVAL_TOOL_MISMATCH"] }] });
  const v = compareCase(c, {
    assertions: [{ step: 0, stage: "approval", outcome: "REJECT", reason_class: "DECISION_EFFECT_MISMATCH", sut_reason_code: "x", enforcement_stage: "effect", sut_decision: "EXECUTE", decision_effect_mismatch: true }],
    executions: { "s1/q1": 0 },
    unattributed_executions: 0,
    effect_records: [rec({ stage: "approval", sut_decisions: ["EXECUTE"], authorized_executions: 1 })],
  });
  assert.equal(v.outcome_match, true);
  assert.equal(v.exact_match, false);
  assert.equal(v.bypass, false);
  assert.equal(v.integrity.categories.missing_expected_effect, true);
  assert.equal(v.integrity.categories.unauthorized_execution, false);
});

test("integrity: no effect channel is 'not observed', never zero violations", () => {
  const v = compareCase(mkCase({}), { assertions: [{ step: 0, stage: "request", outcome: "DENY", reason_class: "CAPABILITY_AGENT_MISMATCH", sut_reason_code: "x", enforcement_stage: "x" }], executions: {}, unattributed_executions: 0 });
  assert.equal(v.integrity.observed, false);
  assert.equal(v.integrity.decision_points, 0);
});
