import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSESSED_CATEGORIES, classifyIntegrity, scenarioEligible } from "../src/eval/integrity";
import type { EffectRecord, Observations } from "../src/adapter/protocol";
import { containsValue, stableStringify } from "../src/adapter/acs/tool-doubles";

const OBS = { state: "observed", source: "harness_tool_trace" } as const;
const NOT = { state: "not_observed", source: "harness_tool_trace" } as const;
const DOBS = { state: "observed", source: "return_value_scan" } as const;
const DNOT = { state: "not_observed", source: "return_value_scan" } as const;

const rec = (o: Partial<EffectRecord>): EffectRecord => ({
  step: 0, stage: "request", key: "s1/q1", attribution: "attempt", sut_reports: [], sut_decisions: [], decision_sources: [],
  result_control_decisions: [], result_control_state: "not_applicable",
  authorized_executions: 0, observed_executions: 0, execution_observation: NOT,
  authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observation: DNOT, ...o,
  ...(o.sut_decisions && !o.decision_sources ? { decision_sources: o.sut_decisions.map((d) => (d === "DECISION_NOT_OBSERVED" ? "none" : "audit_event")) } : {}),
});
const obs = (records: EffectRecord[] | undefined): Observations => ({ assertions: [], executions: {}, unattributed_executions: 0, ...(records ? { effect_records: records } : {}) });
const VIOLATIONS = ["unauthorized_execution", "unauthorized_delivery", "missing_expected_effect"] as const;

test("classification table (assessable decision points)", () => {
  const cases: [string, Partial<EffectRecord>, string[]][] = [
    ["consistent allow+deliver", { sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_decisions: ["DELIVER"], result_control_state: "observed", authorized_deliveries: 1, observed_raw_deliveries: 1, delivery_observation: DOBS }, []],
    ["consistent deny", { sut_decisions: ["DENY"] }, []],
    ["DENY + execution", { sut_decisions: ["DENY"], observed_executions: 1, execution_observation: OBS }, ["unauthorized_execution"]],
    ["ASK + execution", { sut_decisions: ["ASK"], observed_executions: 1, execution_observation: OBS }, ["unauthorized_execution"]],
    ["approval REJECT + execution", { stage: "approval", sut_decisions: ["REJECT"], observed_executions: 1, execution_observation: OBS }, ["unauthorized_execution"]],
    ["WITHHOLD + raw delivery", { sut_decisions: ["ALLOW"], result_control_decisions: ["WITHHOLD"], result_control_state: "observed", authorized_executions: 1, observed_executions: 1, execution_observation: OBS, observed_raw_deliveries: 1, delivery_observation: DOBS }, ["unauthorized_delivery"]],
    ["DENY + execution + raw delivery", { sut_decisions: ["DENY"], observed_executions: 1, execution_observation: OBS, result_control_decisions: ["DELIVER"], result_control_state: "observed", observed_raw_deliveries: 1, delivery_observation: DOBS }, ["unauthorized_execution", "unauthorized_delivery"]],
    ["ALLOW + no execution", { sut_decisions: ["ALLOW"], authorized_executions: 1, result_control_state: "not_observed" }, ["missing_expected_effect"]],
    ["DELIVER decided, not delivered", { sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_decisions: ["DELIVER"], result_control_state: "observed", authorized_deliveries: 1 }, ["missing_expected_effect"]],
    ["untargeted execution", { key: "s1/q9", attribution: "step_key", observed_executions: 1, execution_observation: OBS }, ["unauthorized_execution"]],
    ["M14: two granted executions on one key are not unauthorized", { stage: "approval", attribution: "step_key", sut_decisions: ["EXECUTE", "EXECUTE"], authorized_executions: 2, observed_executions: 2, execution_observation: OBS, result_control_decisions: ["DELIVER", "DELIVER"], result_control_state: "observed", authorized_deliveries: 2, observed_raw_deliveries: 2, delivery_observation: DOBS }, []],
    ["result path failed before the Result Guardian, nothing delivered", { sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_state: "not_observed" }, []],
  ];
  for (const [name, r, want] of cases) {
    const got = classifyIntegrity(obs([rec(r)]));
    assert.deepEqual(VIOLATIONS.filter((c) => got.categories[c]), want, name);
    assert.equal(got.categories.decision_effect_mismatch, want.length > 0, name);
    assert.equal(got.categories.decision_not_observed, false, name);
    assert.equal(got.categories.ambiguous_effect_observation, false, name);
    for (const c of ASSESSED_CATEGORIES) assert.equal(scenarioEligible(got, c), true, `${name}: eligible for ${c}`);
  }
});

test("execution without authority evidence: decision_not_observed finding, effect kept, not in clean denominators", () => {
  const got = classifyIntegrity(obs([rec({ sut_decisions: ["DECISION_NOT_OBSERVED"], observed_executions: 1, execution_observation: OBS })]));
  assert.equal(got.categories.decision_not_observed, true);
  assert.equal(got.categories.unauthorized_execution, false, "no authority decision was observed, so none was contradicted");
  assert.equal(got.observability[0].detail, "execution_without_authority_evidence");
  assert.equal(got.observability[0].observed_executions, 1);
  for (const c of ASSESSED_CATEGORIES) assert.equal(scenarioEligible(got, c), false, c);
});

test("raw delivery after authorised execution without an attributable Result Guardian decision is decision_not_observed, never DELIVER", () => {
  const got = classifyIntegrity(obs([rec({ sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_state: "not_observed", observed_raw_deliveries: 1, delivery_observation: DOBS })]));
  assert.equal(got.categories.decision_not_observed, true);
  assert.equal(got.categories.unauthorized_delivery, false);
  assert.equal(got.observability.find((f) => f.channel === "result_control")?.detail, "raw_delivery_without_result_guardian_decision");
  assert.equal(scenarioEligible(got, "unauthorized_delivery"), false);
  assert.equal(scenarioEligible(got, "unauthorized_execution"), true, "the execution channel stays assessable");
});

test("observation states: observed / not_observed are assessable; ambiguous / unavailable never grow a clean denominator", () => {
  const exec = (state: "observed" | "not_observed" | "ambiguous" | "unavailable") =>
    classifyIntegrity(obs([rec({ sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: state === "observed" ? 1 : 0, execution_observation: { state, source: "harness_tool_trace" }, result_control_state: "not_observed" })]));
  assert.equal(scenarioEligible(exec("observed"), "unauthorized_execution"), true);
  assert.equal(scenarioEligible(exec("not_observed"), "unauthorized_execution"), true, "a negative observation is evidence");
  assert.equal(exec("not_observed").categories.missing_expected_effect, true);
  for (const s of ["ambiguous", "unavailable"] as const) {
    const g = exec(s);
    for (const c of ["unauthorized_execution", "missing_expected_effect", "decision_effect_mismatch"] as const) assert.equal(scenarioEligible(g, c), false, `${s}: ${c}`);
    assert.equal(g.categories.missing_expected_effect, false, `${s}: no finding from an unusable channel`);
    assert.equal(g.categories[s === "ambiguous" ? "ambiguous_effect_observation" : "unavailable_effect_observation"], true);
  }
  // One ambiguous point excludes the whole scenario from the clean denominator ...
  const mixed = classifyIntegrity(obs([rec({ sut_decisions: ["DENY"] }), rec({ key: null, attribution: "unattributed", observed_executions: 1, execution_observation: { state: "ambiguous", source: "harness_tool_trace", detail: "execution_without_trace" } })]));
  assert.equal(scenarioEligible(mixed, "unauthorized_execution"), false);
  // ... but a definite violation elsewhere in the scenario still counts (k stays inside n).
  const definite = classifyIntegrity(obs([rec({ sut_decisions: ["DENY"], observed_executions: 1, execution_observation: OBS }), rec({ key: null, attribution: "unattributed", execution_observation: { state: "ambiguous", source: "sut_counter" } })]));
  assert.equal(definite.categories.unauthorized_execution, true);
  assert.equal(scenarioEligible(definite, "unauthorized_execution"), true);
});

test("ambiguous result-control attribution excludes the delivery channel only", () => {
  const got = classifyIntegrity(obs([rec({ sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_state: "ambiguous", observed_raw_deliveries: 1, delivery_observation: DOBS })]));
  assert.equal(got.categories.ambiguous_effect_observation, true);
  assert.equal(got.categories.unauthorized_delivery, false);
  assert.equal(scenarioEligible(got, "unauthorized_delivery"), false);
  assert.equal(scenarioEligible(got, "unauthorized_execution"), true);
});

test("component permit points: no delivery channel (unavailable) -> execution assessable, every delivery-related denominator excluded", () => {
  const got = classifyIntegrity(obs([rec({ stage: "permit", sut_decisions: ["EXECUTE"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, delivery_observation: { state: "unavailable", source: "none" } })]));
  assert.equal(got.categories.unavailable_effect_observation, true);
  assert.equal(scenarioEligible(got, "unauthorized_execution"), true);
  for (const c of ["unauthorized_delivery", "missing_expected_effect", "decision_effect_mismatch"] as const) assert.equal(scenarioEligible(got, c), false, c);
  // A definite finding from the execution channel is still kept (and stays inside its denominator).
  const missing = classifyIntegrity(obs([rec({ stage: "permit", sut_decisions: ["EXECUTE"], authorized_executions: 1, delivery_observation: { state: "unavailable", source: "none" } })]));
  assert.equal(missing.categories.missing_expected_effect, true);
  assert.equal(scenarioEligible(missing, "missing_expected_effect"), true);
});

const DELIVERY_RELATED = ["unauthorized_delivery", "missing_expected_effect", "decision_effect_mismatch"] as const;
const cleanAllow = (key: string): Partial<EffectRecord> => ({ key, sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_decisions: ["DELIVER"], result_control_state: "observed", authorized_deliveries: 1, observed_raw_deliveries: 1, delivery_observation: DOBS });

test("MEDIUM-2: decision observed + delivery unavailable -> excluded from every delivery-related clean denominator, not a clean zero", () => {
  // Second point: an observed decision whose execution was observed through the SUT fallback counter; its delivery channel is unavailable.
  const got = classifyIntegrity(obs([rec(cleanAllow("s1/q1")), rec({ key: "s1/q2", sut_decisions: ["DENY"], execution_observation: { state: "not_observed", source: "sut_counter" }, delivery_observation: { state: "unavailable", source: "none", detail: "no_raw_output_for_sut_fallback_tool" } })]));
  assert.equal(got.categories.unavailable_effect_observation, true);
  for (const c of DELIVERY_RELATED) {
    assert.equal(got.categories[c], false, c);
    assert.equal(scenarioEligible(got, c), false, `${c}: unavailable must not count as clean`);
  }
  assert.equal(scenarioEligible(got, "unauthorized_execution"), true, "the execution channel is still assessable");
});

test("MEDIUM-2: decision observed + delivery ambiguous -> excluded from every delivery-related clean denominator", () => {
  const got = classifyIntegrity(obs([rec(cleanAllow("s1/q1")), rec({ ...cleanAllow("s1/q2"), delivery_observation: { state: "ambiguous", source: "return_value_scan" } })]));
  assert.equal(got.categories.ambiguous_effect_observation, true);
  for (const c of DELIVERY_RELATED) assert.equal(scenarioEligible(got, c), false, c);
  assert.equal(scenarioEligible(got, "unauthorized_execution"), true);
});

test("MEDIUM-2: a definite unauthorized_delivery is kept even when another point is ambiguous or unavailable", () => {
  const leak: Partial<EffectRecord> = { key: "s1/q1", sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_decisions: ["WITHHOLD"], result_control_state: "observed", observed_raw_deliveries: 1, delivery_observation: DOBS };
  for (const other of [{ state: "ambiguous", source: "return_value_scan" }, { state: "unavailable", source: "none" }] as const) {
    const got = classifyIntegrity(obs([rec(leak), rec({ ...cleanAllow("s1/q2"), delivery_observation: other })]));
    assert.equal(got.categories.unauthorized_delivery, true, other.state);
    assert.equal(scenarioEligible(got, "unauthorized_delivery"), true, `${other.state}: k stays inside n`);
    assert.equal(got.categories.decision_effect_mismatch, true);
  }
});

test("absent effect channel is reported as unavailable, never as zero violations", () => {
  const r = classifyIntegrity(obs(undefined));
  assert.equal(r.observed, false);
  assert.equal(r.decision_points, 0);
  assert.equal(r.categories.unavailable_effect_observation, true);
  for (const c of ASSESSED_CATEGORIES) assert.equal(scenarioEligible(r, c), false);
});

test("evidence counts record where each decision and observation came from", () => {
  const r = classifyIntegrity(obs([rec({ sut_decisions: ["ALLOW"], authorized_executions: 1, observed_executions: 1, execution_observation: OBS, result_control_decisions: ["DELIVER"], result_control_state: "observed", authorized_deliveries: 1, observed_raw_deliveries: 1, delivery_observation: DOBS })]));
  assert.deepEqual(r.evidence_counts.authority, { "request:ALLOW:audit_event": 1 });
  assert.deepEqual(r.evidence_counts.result_control, { "request:observed": 1, "request:DELIVER": 1 });
  assert.deepEqual(r.evidence_counts.execution, { "harness_tool_trace:observed": 1 });
  assert.deepEqual(r.evidence_counts.delivery, { "return_value_scan:observed": 1 });
});

test("raw-output delivery observation is structural, not decision-based", () => {
  const raw = { classification: "restricted", ssn: "000-00-1234" };
  const needle = stableStringify(raw);
  assert.equal(containsValue({ exit_status: "blocked", outputs: [{ value: { error: "Output withheld by policy." } }] }, needle), false);
  assert.equal(containsValue({ exit_status: "blocked", outputs: [{ value: { ssn: "000-00-1234", classification: "restricted" } }] }, needle), true, "key order must not matter");
  assert.equal(containsValue({ outputs: [{ value: { wrapped: [raw] } }] }, needle), true);
  assert.equal(containsValue({ outputs: [{ value: { ssn: "000-00-1234" } }] }, needle), false, "partial disclosure is not detected (documented limitation)");
});
