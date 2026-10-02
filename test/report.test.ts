import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildReport } from "../src/report/build";
import { NO_ELIGIBLE, renderSummary } from "../src/report/summary";
import { classifyIntegrity } from "../src/eval/integrity";
import { integrityByBoundary } from "../src/mutation/runner";
import { validateReport } from "../src/report/validate";
import { buildCorpusManifest } from "../src/report/manifest";
import { generateCorpus } from "../src/corpus/generate";
import { loadSutLock } from "../src/sut/lock";
import { compareCase } from "../src/eval/compare";
import { ORACLE_LIMITATION } from "../src/report/limitations";
import { STATISTICS_DISCLAIMER } from "../src/eval/stats";
import type { RunOutput } from "../src/eval/run";
import type { Case } from "../src/corpus/types";

const ROOT = join(__dirname, "..", "..");

/** Observations that echo the oracle exactly (synthetic; exercises the report path only). */
function perfect(c: Case) {
  const exec: Record<string, number> = { ...c.expected.invariants.executions };
  return compareCase(c, {
    assertions: c.expected.assertions.map((a) => ({ ...a, reason_class: (a.acceptable_reason_classes ?? ["POLICY_ALLOW"])[0], sut_reason_code: "x", enforcement_stage: "x" })),
    executions: exec,
    unattributed_executions: 0,
    permit_reuses_accepted: 0,
  } as never);
}

function mk(full = false) {
  const g = generateCorpus("report-test", 60);
  const manifest = buildCorpusManifest("smoke", "report-test", g, loadSutLock(ROOT), { harness_commit: "0".repeat(40), harness_worktree_clean: true });
  const baseline: RunOutput = { hello: null, verdicts: g.cases.map(perfect), adapter_errors: [], harness_errors: [], results: [] };
  return buildReport({
    profile: "smoke",
    full_benchmark_executed: full,
    manifest,
    cases: g.cases,
    baseline,
    validity: {
      corpus_determinism: { generated_twice_identical: true, sha256_first: g.sha256, sha256_second: g.sha256 },
      golden: { checked: false, expected_sha256: null, matches: null, committed_file_identical: null },
      sut_checkout: { pinned_commit: manifest.sut_commit, head: manifest.sut_commit, worktree_clean: true, verified: true },
      sut_self_verification: { ran: false, ok: null, summary: null },
      observation_determinism: { checked: false, identical: null, sha256_first: null, sha256_second: null },
    },
    oracle_boundary: { ok: true, roots: [], closure: [], violations: [], allowed_modules: [] },
    oracle_integrity_errors: 0,
    reachability: [],
    mutation: { executed: false, corpus_profile: null, results: [] },
  });
}

test("report validates against the versioned schema; runtime and component trees are separate", () => {
  const r = mk();
  const v = validateReport(JSON.parse(JSON.stringify(r)), ROOT);
  assert.deepEqual(v.errors, []);
  assert.equal(r.runtime_metrics.boundary, "runtime");
  assert.equal(r.component_metrics.boundary, "component");
  assert.equal("security_score" in r, false);
  for (const f of Object.keys(r.runtime_metrics.by_family)) assert.equal(f in r.component_metrics.by_family, false);
});

test("N/A controls appear as N/A and nowhere in metrics, bounds or mutation results", () => {
  const r = mk();
  const na = ["credential_isolation", "filesystem_isolation", "internet_egress_controls", "network_sandboxing", "production_latency_throughput", "tenant_isolation"];
  assert.deepEqual(r.na_controls.map((n) => n.control).sort(), na);
  const metricsText = JSON.stringify([r.runtime_metrics, r.component_metrics, r.statistical_bounds, r.mutation_sensitivity, r.decision_effect_integrity]);
  for (const c of na) assert.equal(metricsText.includes(c), false, c);
});

test("claims discipline: limitation and statistics disclaimer are present verbatim in report and summary", () => {
  const r = mk();
  const s = renderSummary(r);
  assert.equal(r.oracle_limitation, ORACLE_LIMITATION);
  assert.equal(r.statistical_bounds.disclaimer, STATISTICS_DISCLAIMER);
  assert.ok(s.includes(ORACLE_LIMITATION));
  assert.ok(s.includes(STATISTICS_DISCLAIMER));
  assert.ok(s.includes("Full 10k benchmark executed in this run: **no**"));
  assert.ok(s.includes("Mutation gate passed: **not executed**"));
});

test("summary numbers are rendered from report data, not typed by hand", () => {
  const r = mk();
  const s1 = renderSummary(r);
  const tweaked = JSON.parse(JSON.stringify(r));
  tweaked.headline.runtime.scenario_mismatches = 4242;
  const s2 = renderSummary(tweaked);
  assert.ok(!s1.includes("4242/") && s2.includes("4242/"));
});

test("a report missing the disclaimer or mixing N/A into metrics fails schema validation", () => {
  const r = JSON.parse(JSON.stringify(mk()));
  r.statistical_bounds.disclaimer = "bounds are production failure rates";
  assert.equal(validateReport(r, ROOT).ok, false);
  const r2 = JSON.parse(JSON.stringify(mk()));
  r2.na_controls[0].status = "pass";
  assert.equal(validateReport(r2, ROOT).ok, false);
});

test("0/0: a category without eligible scenarios is null in JSON and N/A in the summary, never 0 % or a success", () => {
  const r = mk(); // synthetic observations without an effect channel: nothing is eligible anywhere
  for (const b of [r.decision_effect_integrity.runtime, r.decision_effect_integrity.component]) {
    for (const c of ["unauthorized_execution", "unauthorized_delivery", "missing_expected_effect", "decision_effect_mismatch"] as const) {
      assert.equal(b[c].eligible_scenarios, 0, `${b.boundary} ${c}`);
      assert.equal(b[c].rate_descriptive, null, `${b.boundary} ${c}`);
    }
  }
  const s = renderSummary(r);
  const section = s.slice(s.indexOf("## Decision/effect integrity"), s.indexOf("## Mutation sensitivity"));
  assert.ok(section.includes(NO_ELIGIBLE));
  assert.equal(/\b0 \/ 0\b/.test(section), false, "no 0 / 0 rendered as a ratio");
});

test("mutant integrity is reported per boundary in the schema and the summary shows only the mutant's own boundary", () => {
  const base = mk();
  const runtimeCi = classifyIntegrity({ assertions: [], executions: {}, unattributed_executions: 0, effect_records: [] });
  const compCi = classifyIntegrity({ assertions: [], executions: {}, unattributed_executions: 0 });
  const mi = integrityByBoundary(
    [{ boundary: "runtime", integrity: runtimeCi }, { boundary: "component", integrity: compCi }, { boundary: "component", integrity: compCi }] as never,
    "runtime",
  );
  assert.deepEqual([mi.by_boundary.runtime.scenarios, mi.by_boundary.component.scenarios], [1, 2]);
  assert.equal(mi.by_boundary.runtime.categories.unavailable_effect_observation.count, 0, "component unavailability never leaks into the runtime tally");
  assert.equal(mi.by_boundary.component.categories.unavailable_effect_observation.count, 2);
  const r = JSON.parse(JSON.stringify(base));
  r.mutation_sensitivity.executed = true;
  r.mutation_sensitivity.by_mutant = [{
    mutation_id: "MX", family: "fam", evaluation_boundary: "runtime", status: "killed", invalid_reason: null, witness_candidates: 1, baseline_valid_witness_candidates: 1,
    witness_case_ids: ["case-1"], witness_count: 1, mutant_adapter_errors: 0, mutant_harness_errors: 0, outcome_mismatches_by_boundary: { runtime: 1, component: 0 }, boundary_violation: false,
    integrity_scenarios: mi,
  }];
  assert.deepEqual(validateReport(r, ROOT).errors.filter((e: string) => e.includes("integrity_scenarios")), []);
  const bad = JSON.parse(JSON.stringify(r));
  bad.mutation_sensitivity.by_mutant[0].integrity_scenarios = { unavailable_effect_observation: 3 };
  assert.ok(validateReport(bad, ROOT).errors.some((e: string) => e.includes("integrity_scenarios")), "a pooled tally does not validate");
  const row = renderSummary(r).split("\n").find((l) => l.startsWith("| MX |"))!;
  assert.ok(row.includes(NO_ELIGIBLE) && !row.includes("/ 2"), row);
});
