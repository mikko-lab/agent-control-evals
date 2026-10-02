import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCorpus } from "../src/corpus/generate";
import { PROFILES } from "../src/corpus/profiles";
import { selectCases, type BoundarySelection } from "../src/eval/select";
import { classifyIntegrity } from "../src/eval/integrity";
import { integrityByBoundary } from "../src/mutation/runner";
import type { CaseVerdict } from "../src/eval/compare";
import type { Case } from "../src/corpus/types";

const smoke = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases).cases;

/**
 * Synthetic mutant-run verdicts with the integrity shape each boundary really has: runtime scenarios carry an
 * assessable decision point; component scenarios have no delivery channel (permit) or no effect channel at all
 * (verifier), i.e. they are unavailable for delivery.
 */
function verdictsFor(cases: Case[]): CaseVerdict[] {
  return cases.map((c) => {
    const records =
      c.evaluation_boundary === "runtime"
        ? [{ step: 0, stage: "request" as const, key: "s1/q1", attribution: "attempt" as const, sut_reports: [], sut_decisions: ["DENY" as const], decision_sources: ["audit_event" as const], result_control_decisions: [], result_control_state: "not_applicable" as const, authorized_executions: 0, observed_executions: 0, execution_observation: { state: "not_observed" as const, source: "harness_tool_trace" as const }, authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observation: { state: "not_observed" as const, source: "return_value_scan" as const } }]
        : (c.scenario as { component?: string }).component === "execution_gate"
          ? [{ step: 0, stage: "permit" as const, key: "s1/q1", attribution: "attempt" as const, sut_reports: [], sut_decisions: ["REJECT" as const], decision_sources: ["sut_exception" as const], result_control_decisions: [], result_control_state: "not_applicable" as const, authorized_executions: 0, observed_executions: 0, execution_observation: { state: "not_observed" as const, source: "harness_tool_trace" as const }, authorized_deliveries: 0, observed_raw_deliveries: 0, delivery_observation: { state: "unavailable" as const, source: "none" as const } }]
          : undefined;
    const integrity = classifyIntegrity({ assertions: [], executions: {}, unattributed_executions: 0, ...(records ? { effect_records: records } : {}) });
    return { case_id: c.case_id, boundary: c.evaluation_boundary, family: c.family, integrity } as unknown as CaseVerdict;
  });
}
const run = (b: BoundarySelection, primary: "runtime" | "component") => integrityByBoundary(verdictsFor(selectCases(smoke, b)), primary);
const nRuntime = smoke.filter((c) => c.evaluation_boundary === "runtime").length;
const nComponent = smoke.filter((c) => c.evaluation_boundary === "component").length;

test("--boundary runtime: only runtime scenarios are tallied; no component unavailability or denominators", () => {
  const t = run("runtime", "runtime");
  assert.equal(t.primary_boundary, "runtime");
  assert.equal(t.by_boundary.runtime.scenarios, nRuntime);
  assert.equal(t.by_boundary.runtime.categories.unauthorized_execution.eligible_scenarios, nRuntime);
  assert.equal(t.by_boundary.runtime.categories.unavailable_effect_observation.count, 0);
  assert.equal(t.by_boundary.component.scenarios, 0);
  assert.equal(t.by_boundary.component.categories.unavailable_effect_observation.eligible_scenarios, 0);
});

test("--boundary component: only component scenarios are tallied; delivery categories have no clean denominator", () => {
  const t = run("component", "component");
  assert.equal(t.primary_boundary, "component");
  assert.equal(t.by_boundary.runtime.scenarios, 0);
  assert.equal(t.by_boundary.component.scenarios, nComponent);
  assert.equal(t.by_boundary.component.categories.unavailable_effect_observation.count, nComponent);
  for (const c of ["unauthorized_delivery", "missing_expected_effect", "decision_effect_mismatch"] as const) {
    assert.equal(t.by_boundary.component.categories[c].eligible_scenarios, 0, c);
  }
});

test("--boundary all keeps two separate boundary tallies, each identical to its single-boundary run (never pooled)", () => {
  for (const primary of ["runtime", "component"] as const) {
    const all = run("all", primary);
    assert.equal(all.primary_boundary, primary);
    assert.deepEqual(all.by_boundary.runtime, run("runtime", "runtime").by_boundary.runtime);
    assert.deepEqual(all.by_boundary.component, run("component", "component").by_boundary.component);
    assert.equal(all.by_boundary.runtime.scenarios + all.by_boundary.component.scenarios, smoke.length);
    assert.equal(all.by_boundary.runtime.categories.unavailable_effect_observation.count, 0, "component unavailability is not in the runtime tally");
  }
});
