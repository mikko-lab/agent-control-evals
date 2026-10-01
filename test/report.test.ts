import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildReport } from "../src/report/build";
import { renderSummary } from "../src/report/summary";
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
  assert.deepEqual(r.na_controls.map((n) => n.control).sort(), ["production_latency_throughput", "tenant_isolation"]);
  const metricsText = JSON.stringify([r.runtime_metrics, r.component_metrics, r.statistical_bounds, r.mutation_sensitivity]);
  assert.equal(metricsText.includes("tenant"), false);
  assert.equal(metricsText.includes("latency"), false);
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
  tweaked.headline.runtime.oracle_mismatches = 4242;
  const s2 = renderSummary(tweaked);
  assert.ok(!s1.includes("4242/") && s2.includes("**4242/"));
});

test("a report missing the disclaimer or mixing N/A into metrics fails schema validation", () => {
  const r = JSON.parse(JSON.stringify(mk()));
  r.statistical_bounds.disclaimer = "bounds are production failure rates";
  assert.equal(validateReport(r, ROOT).ok, false);
  const r2 = JSON.parse(JSON.stringify(mk()));
  r2.na_controls[0].status = "pass";
  assert.equal(validateReport(r2, ROOT).ok, false);
});
