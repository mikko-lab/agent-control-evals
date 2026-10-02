import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { computeBoundaryMetrics, scenarioIndicators } from "../src/eval/metrics";
import { compareCase } from "../src/eval/compare";
import { bound } from "../src/eval/stats";
import { validateReport } from "../src/report/validate";
import { generateCorpus } from "../src/corpus/generate";
import type { Case } from "../src/corpus/types";
import type { Observations } from "../src/adapter/protocol";

const ROOT = join(__dirname, "..", "..");
const cases = generateCorpus("metrics-test", 200).cases.filter((c) => c.evaluation_boundary === "runtime");

/** Observations that echo the oracle exactly. */
function perfect(c: Case): Observations {
  return {
    assertions: c.expected.assertions.map((a) => ({ ...a, reason_class: (a.acceptable_reason_classes ?? ["POLICY_ALLOW"])[0], sut_reason_code: "x", enforcement_stage: "x" })),
    executions: { ...c.expected.invariants.executions },
    unattributed_executions: 0,
  } as Observations;
}

/** Flip every restrictive expectation to its permissive counterpart (a SUT that allows everything). */
function allowAll(c: Case): Observations {
  const flip: Record<string, string> = { DENY: "ALLOW", REJECT: "EXECUTE", WITHHOLD: "DELIVER" };
  const o = perfect(c);
  o.assertions = o.assertions.map((a) => (flip[a.outcome] ? { ...a, outcome: flip[a.outcome] } : a));
  const ex: Record<string, number> = {};
  for (const k of Object.keys(c.expected.invariants.executions)) ex[k] = Math.max(1, c.expected.invariants.executions[k]);
  o.executions = ex;
  return o;
}

test("B1: bounds are scenario-level, k counts members of n, and a multi-assertion failure counts once", () => {
  const verdicts = cases.map((c) => compareCase(c, allowAll(c)));
  const m = computeBoundaryMetrics("runtime", cases, verdicts);
  const s = m.total.scenario_counts;
  for (const b of Object.values(m.total.scenario_bounds)) {
    assert.equal(b.unit, "scenario");
    assert.ok(b.k <= b.n);
  }
  assert.equal(m.total.scenario_bounds.false_allow.n, s.cases_with_restrictive_expectation);
  assert.ok(s.false_allow_cases <= s.cases_with_restrictive_expectation);
  assert.ok(m.total.descriptive_assertion_counts.false_allow_mismatches > s.false_allow_cases, "several assertions of one scenario must not become several trials");
  for (const fam of Object.values(m.by_family)) for (const vb of Object.values(fam.by_variant)) for (const b of Object.values(vb.scenario_bounds)) assert.ok(b.k <= b.n);
});

test("B1: a permissive deviation in a scenario without restrictive expectations is counted outside the false_allow denominator", () => {
  const c = cases.find((x) => !x.expected.assertions.some((a) => ["DENY", "REJECT", "WITHHOLD"].includes(a.outcome)))!;
  const o = perfect(c);
  o.executions = { ...o.executions, "s9/q9": 1 };
  const v = compareCase(c, o);
  const ind = scenarioIndicators(c, v);
  assert.equal(ind.falseAllow, false);
  assert.equal(ind.permissiveOutside, true);
  const m = computeBoundaryMetrics("runtime", [c], [v]);
  assert.equal(m.total.scenario_counts.false_allow_cases, 0);
  assert.equal(m.total.scenario_counts.permissive_deviation_outside_denominator, 1);
});

test("B1: bound() refuses a numerator outside its denominator instead of crashing later", () => {
  assert.throws(() => bound(3, 2), /k must count members of n/);
  assert.throws(() => bound(-1, 2));
  assert.equal(bound(0, 0).one_sided_95_upper_bound, null);
});

test("B2: variant coverage reports designed variants and replication, with no bound attached", () => {
  const verdicts = cases.map((c) => compareCase(c, perfect(c)));
  const m = computeBoundaryMetrics("runtime", cases, verdicts);
  const variants = new Set(cases.map((c) => `${c.family}/${c.variant}`)).size;
  assert.equal(m.variant_coverage.variants, variants);
  assert.equal(m.variant_coverage.variants_with_outcome_failure, 0);
  assert.ok(m.variant_coverage.mean_cases_per_variant! >= 1);
  assert.equal("one_sided_95_upper_bound" in m.variant_coverage, false);
  const bad = cases.map((c) => compareCase(c, c.variant === cases[0].variant && c.family === cases[0].family ? allowAll(c) : perfect(c)));
  const m2 = computeBoundaryMetrics("runtime", cases, bad);
  assert.equal(m2.variant_coverage.variants_with_outcome_failure, 1, "all replicates of one failing variant are one variant");
});

test("historical v0.1 reports still validate against report schema 0.1.0", () => {
  for (const p of ["reports/v0.1/smoke/report.json", "reports/v0.1/full/report.json"]) {
    const r = JSON.parse(readFileSync(join(ROOT, p), "utf8"));
    assert.equal(r.report_schema_version, "0.1.0");
    assert.deepEqual(validateReport(r, ROOT).errors, [], p);
  }
});
