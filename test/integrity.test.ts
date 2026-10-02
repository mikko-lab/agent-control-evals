import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntegrity } from "../src/eval/integrity";
import type { EffectRecord, Observations } from "../src/adapter/protocol";
import { containsValue, stableStringify } from "../src/adapter/acs/tool-doubles";

const rec = (o: Partial<EffectRecord>): EffectRecord => ({
  step: 0, stage: "request", key: "s1/q1", attribution: "attempt", sut_reports: [], sut_decisions: [], result_control_decisions: [],
  authorized_executions: 0, observed_executions: 0, authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observed: true, ...o,
});
const obs = (records: EffectRecord[] | undefined): Observations => ({ assertions: [], executions: {}, unattributed_executions: 0, ...(records ? { effect_records: records } : {}) });

test("classification table", () => {
  const cases: [string, Partial<EffectRecord>, string[]][] = [
    ["consistent allow+deliver", { sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, authorized_deliveries: 1, observed_raw_deliveries: 1 }, []],
    ["consistent deny", { sut_decisions: ["DENY"] }, []],
    ["deny + execution", { sut_decisions: ["DENY"], observed_executions: 1 }, ["unauthorized_execution"]],
    ["ask + execution", { sut_decisions: ["ASK"], observed_executions: 1 }, ["unauthorized_execution"]],
    ["withhold + delivery", { sut_decisions: ["ALLOW"], result_control_decisions: ["WITHHOLD"], authorized_executions: 1, observed_executions: 1, observed_raw_deliveries: 1 }, ["unauthorized_delivery"]],
    ["allow + no execution", { sut_decisions: ["ALLOW"], authorized_executions: 1 }, ["missing_expected_effect"]],
    ["deliver authorised, not observed", { sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, authorized_deliveries: 1 }, ["missing_expected_effect"]],
    ["untargeted execution", { key: "s1/q9", observed_executions: 1 }, ["unauthorized_execution"]],
    ["permit (no delivery channel)", { stage: "permit", delivery_observed: false, observed_raw_deliveries: 1 }, []],
  ];
  for (const [name, r, want] of cases) {
    const got = classifyIntegrity(obs([rec(r)]));
    const cats = (["unauthorized_execution", "unauthorized_delivery", "missing_expected_effect"] as const).filter((c) => got.categories[c]);
    assert.deepEqual(cats, want, name);
    assert.equal(got.categories.decision_effect_mismatch, want.length > 0, name);
  }
});

test("absent effect channel is reported as not observed", () => {
  const r = classifyIntegrity(obs(undefined));
  assert.equal(r.observed, false);
  assert.equal(r.decision_points, 0);
});

test("raw-output delivery observation is structural, not decision-based", () => {
  const raw = { classification: "restricted", ssn: "000-00-1234" };
  const needle = stableStringify(raw);
  assert.equal(containsValue({ exit_status: "blocked", outputs: [{ value: { error: "Output withheld by policy." } }] }, needle), false);
  assert.equal(containsValue({ exit_status: "blocked", outputs: [{ value: { ssn: "000-00-1234", classification: "restricted" } }] }, needle), true, "key order must not matter");
  assert.equal(containsValue({ outputs: [{ value: { wrapped: [raw] } }] }, needle), true);
});
