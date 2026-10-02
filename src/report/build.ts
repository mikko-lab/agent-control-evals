import { CONTROL_MATRIX } from "../spec/control-matrix";
import { REASON_TAXONOMY } from "../spec/reason-taxonomy";
import { REPORT_SCHEMA_VERSION } from "../version";
import type { Case } from "../corpus/types";
import type { RunOutput } from "../eval/run";
import type { CaseVerdict } from "../eval/compare";
import { INTEGRITY_CATEGORIES, type IntegrityCategory } from "../eval/integrity";
import { computeBoundaryMetrics, type BoundaryMetrics } from "../eval/metrics";
import { STATISTICS_DISCLAIMER } from "../eval/stats";
import type { BoundaryCheckResult } from "../oracle/boundary-check";
import type { ReachabilityResult } from "../mutation/reachability";
import type { MutantResult } from "../mutation/runner";
import type { CorpusManifest } from "./manifest";
import { LIMITATIONS, ORACLE_LIMITATION } from "./limitations";

export interface HarnessValidityInput {
  corpus_determinism: { generated_twice_identical: boolean; sha256_first: string; sha256_second: string };
  golden: { checked: boolean; expected_sha256: string | null; matches: boolean | null; committed_file_identical: boolean | null };
  sut_checkout: { pinned_commit: string; head: string; worktree_clean: boolean; verified: boolean };
  sut_self_verification: { ran: boolean; ok: boolean | null; summary: string | null };
  observation_determinism: { checked: boolean; identical: boolean | null; sha256_first: string | null; sha256_second: string | null };
}

export interface ReportInput {
  profile: string;
  full_benchmark_executed: boolean;
  manifest: CorpusManifest;
  cases: Case[];
  baseline: RunOutput;
  validity: HarnessValidityInput;
  oracle_boundary: BoundaryCheckResult;
  oracle_integrity_errors: number;
  reachability: ReachabilityResult[];
  mutation: { executed: boolean; corpus_profile: string | null; results: MutantResult[] };
}

function boundStatsList(m: BoundaryMetrics) {
  const out: unknown[] = [];
  const push = (scope: string, family: string | null, variant: string | null, b: BoundaryMetrics["total"]) => {
    for (const [metric, v] of Object.entries(b.scenario_bounds)) out.push({ boundary: m.boundary, scope, family, variant, metric, ...v });
  };
  push("boundary", null, null, m.total);
  for (const [f, fb] of Object.entries(m.by_family)) {
    push("family", f, null, fb);
    for (const [vn, vb] of Object.entries(fb.by_variant)) push("variant", f, vn, vb);
  }
  return out;
}

const INTEGRITY_BOUND_REASON =
  "not_applicable: decision/effect integrity violations are properties of the SUT's enforcement code paths, not of the sampled scenario parameters. " +
  "No corpus variant is designed to target or sample situations in which a decision and its effect could diverge, so the eligible scenarios are not a sample from a population in which such a divergence has a meaningful rate; on a deterministic SUT a divergence would be systematic per code path. Counts are reported descriptively as k / eligible scenarios.";

/** Scenario-level decision/effect integrity for one boundary (descriptive; no confidence bound). */
function integritySection(boundary: "runtime" | "component", verdicts: CaseVerdict[]) {
  const vs = verdicts.filter((v) => v.boundary === boundary);
  const eligible = vs.filter((v) => v.integrity.observed && v.integrity.decision_points > 0);
  const deliveryEligible = eligible.filter((v) => v.integrity.delivery_points > 0);
  const cat = (name: IntegrityCategory, pool: CaseVerdict[]) => {
    const ids = pool.filter((v) => v.integrity.categories[name]).map((v) => v.case_id).sort();
    return { count: ids.length, eligible_scenarios: pool.length, rate_descriptive: pool.length === 0 ? null : `${ids.length}/${pool.length}`, confidence_bound: "not_applicable", case_ids: ids };
  };
  const byFamily: Record<string, Record<string, number>> = {};
  for (const v of eligible) {
    const f = (byFamily[v.family] ??= { eligible_scenarios: 0, unauthorized_execution: 0, unauthorized_delivery: 0, missing_expected_effect: 0, decision_effect_mismatch: 0 });
    f.eligible_scenarios++;
    for (const c of INTEGRITY_CATEGORIES) if (v.integrity.categories[c]) f[c]++;
  }
  return {
    boundary,
    evaluated_scenarios: vs.length,
    eligible_scenarios: eligible.length,
    eligible_definition: "scenarios for which the adapter supplied at least one decision/effect record (effect channel present)",
    delivery_eligible_scenarios: deliveryEligible.length,
    delivery_eligible_definition: "eligible scenarios with at least one decision point that carries a delivery observation",
    not_observed_scenarios: vs.filter((v) => !v.integrity.observed || v.integrity.decision_points === 0).length,
    decision_points: eligible.reduce((n, v) => n + v.integrity.decision_points, 0),
    unauthorized_execution: cat("unauthorized_execution", eligible),
    unauthorized_delivery: cat("unauthorized_delivery", deliveryEligible),
    missing_expected_effect: cat("missing_expected_effect", eligible),
    decision_effect_mismatch: cat("decision_effect_mismatch", eligible),
    by_family: Object.fromEntries(Object.entries(byFamily).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function mutationBlock(results: MutantResult[], boundary: "runtime" | "component") {
  const rs = results.filter((r) => r.evaluation_boundary === boundary);
  const killed = rs.filter((r) => r.status === "killed").length;
  return {
    mutants: rs.length,
    killed,
    survived: rs.filter((r) => r.status === "survived").map((r) => r.mutation_id),
    invalid: rs.filter((r) => r.status === "invalid").map((r) => r.mutation_id),
    kill_ratio: rs.length === 0 ? null : `${killed}/${rs.length}`,
  };
}

export function buildReport(i: ReportInput) {
  const runtime = computeBoundaryMetrics("runtime", i.cases, i.baseline.verdicts);
  const component = computeBoundaryMetrics("component", i.cases, i.baseline.verdicts);
  const findings = i.baseline.verdicts
    .filter((v) => !v.exact_match || v.integrity.categories.decision_effect_mismatch)
    .map((v) => ({
      case_id: v.case_id,
      boundary: v.boundary,
      family: v.family,
      variant: v.variant,
      severity: v.bypass
        ? "bypass"
        : !v.outcome_match
          ? "outcome_or_invariant"
          : v.integrity.categories.decision_effect_mismatch
            ? "decision_effect_integrity"
            : "reason_only",
      integrity_categories: INTEGRITY_CATEGORIES.filter((c) => v.integrity.categories[c]),
      integrity_violations: v.integrity.violations,
      mismatches: v.mismatches,
    }));
  const reachOk = i.reachability.every((r) => r.ok);
  const mutationGateFailures: string[] = [];
  for (const r of i.mutation.results) {
    if (r.status !== "killed") mutationGateFailures.push(`${r.mutation_id}: ${r.status}${r.invalid_reason ? ` (${r.invalid_reason})` : ""}`);
  }
  for (const r of i.reachability) if (!r.ok) mutationGateFailures.push(`${r.mutation_id}: reachability ${r.problems.join("; ")}`);

  const v = i.validity;
  const validityProblems: string[] = [];
  if (!v.corpus_determinism.generated_twice_identical) validityProblems.push("corpus generation is not deterministic");
  if (v.golden.checked && v.golden.matches === false) validityProblems.push("smoke corpus SHA does not match golden");
  if (v.golden.checked && v.golden.committed_file_identical === false) validityProblems.push("committed smoke corpus differs from regenerated bytes");
  if (!v.sut_checkout.verified) validityProblems.push("SUT checkout verification failed");
  if (v.sut_self_verification.ran && v.sut_self_verification.ok === false) validityProblems.push("SUT's own npm run verify failed");
  if (v.observation_determinism.checked && v.observation_determinism.identical === false) validityProblems.push("baseline observations differ between two runs");
  if (!i.oracle_boundary.ok) validityProblems.push("oracle dependency boundary violated");
  if (i.oracle_integrity_errors > 0) validityProblems.push("stored expectations differ from oracle derivation");
  if (i.baseline.adapter_errors.length > 0) validityProblems.push(`${i.baseline.adapter_errors.length} adapter errors`);
  if (i.baseline.harness_errors.length > 0) validityProblems.push(`${i.baseline.harness_errors.length} harness/protocol errors`);
  const evaluated = i.baseline.verdicts.length;
  if (evaluated !== i.cases.length) validityProblems.push(`only ${evaluated}/${i.cases.length} cases evaluated`);

  const harnessValid = validityProblems.length === 0;
  // null = mutation analysis not executed in this run (not a pass).
  const mutationGatePassed: boolean | null = i.mutation.executed ? mutationGateFailures.length === 0 : reachOk ? null : false;
  const famList = [...new Set(i.cases.map((c) => c.family))].sort();
  const headlineFor = (m: BoundaryMetrics) => ({
    // Primary unit: scenarios (cases) with an outcome or invariant mismatch.
    scenario_mismatches: m.total.scenario_counts.cases - m.total.scenario_counts.cases_outcome_match,
    scenarios: m.evaluated_cases,
    // Breadth: designed variants, and how many showed any outcome failure (no bound).
    variants: m.variant_coverage.variants,
    adversarial_variants: m.variant_coverage.adversarial_variants,
    variants_with_outcome_failure: m.variant_coverage.variants_with_outcome_failure,
    // Descriptive only (dependent within a scenario).
    assertion_mismatches_descriptive: m.total.descriptive_assertion_counts.assertions_evaluated - m.total.descriptive_assertion_counts.assertions_matched,
    assertions_descriptive: m.total.descriptive_assertion_counts.assertions_evaluated,
  });
  const mRuntime = mutationBlock(i.mutation.results, "runtime");
  const mComponent = mutationBlock(i.mutation.results, "component");

  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    profile: i.profile,
    full_benchmark_executed: i.full_benchmark_executed,
    headline: {
      sut_commit: i.manifest.sut_commit,
      harness_version: i.manifest.harness_version,
      harness_commit: i.manifest.harness_commit,
      corpus_profile: i.profile,
      corpus_sha256: i.manifest.corpus_sha256,
      generator_version: i.manifest.generator_version,
      oracle_spec_version: i.manifest.oracle_spec_version,
      mutation_set_version: i.manifest.mutation_set_version,
      families: famList,
      runtime: headlineFor(runtime),
      component: headlineFor(component),
      mutation: i.mutation.executed ? { runtime: mRuntime.kill_ratio, component: mComponent.kill_ratio, corpus_profile: i.mutation.corpus_profile } : null,
    },
    gates: {
      harness_valid: harnessValid,
      harness_validity_problems: validityProblems,
      mutation_gate_passed: mutationGatePassed,
      mutation_gate_failures: mutationGateFailures,
      baseline_findings: findings.length,
    },
    manifest: i.manifest,
    control_matrix: CONTROL_MATRIX,
    na_controls: CONTROL_MATRIX.filter((c) => c.status === "N/A").map((c) => ({ control: c.control, evaluation_boundary: "N/A", status: "N/A", reason: c.reason })),
    reason_taxonomy: REASON_TAXONOMY,
    harness_validity: { valid: harnessValid, problems: validityProblems, ...v },
    oracle_independence_check: {
      ok: i.oracle_boundary.ok && i.oracle_integrity_errors === 0,
      static_dependency_check: { ok: i.oracle_boundary.ok, closure: i.oracle_boundary.closure, violations: i.oracle_boundary.violations },
      expectations_precomputed_before_sut_run: true,
      expected_never_sent_to_adapter: true,
      stored_expectation_integrity_errors: i.oracle_integrity_errors,
    },
    adapter_validation: {
      hello: i.baseline.hello,
      cases_sent: i.cases.length,
      results_received: i.baseline.results.length,
      results_structurally_valid: i.baseline.results.length,
      adapter_errors: i.baseline.adapter_errors.length,
      harness_errors: i.baseline.harness_errors.length,
      contract_tests: "test/adapter-contract.test.ts (run in CI)",
    },
    mutation_reachability: { all_ok: reachOk, mutants: i.reachability },
    runtime_metrics: runtime,
    component_metrics: component,
    statistical_bounds: {
      disclaimer: STATISTICS_DISCLAIMER,
      method: "exact binomial (Clopper-Pearson), one-sided 95% upper bound; rule of three (3/n) also reported when k = 0",
      unit: "scenario (one case). k always counts members of n. Assertion-level counts are descriptive only and carry no bound.",
      sampling_model:
        "Within a variant, cases are seeded pseudo-random draws of that variant's parameters; allocation is fixed and equal per family, then per variant. A bound therefore refers to a scenario drawn from this declared, equally weighted variant mixture only.",
      breadth_caveat:
        "Cases within one variant are replicates of one designed structure, so a defect typically affects all or none of them. Breadth of evidence is the number of designed variants (see variant_coverage), not the number of cases; bounds say nothing about situations outside the designed variants.",
      entries: [...boundStatsList(runtime), ...boundStatsList(component)],
    },
    decision_effect_integrity: {
      definitions: {
        unauthorized_execution: "observed tool executions exceed the executions the SUT's own decisions authorised at that decision point (e.g. request DENY/ASK + execution, approval REJECT + execution, execution of an untargeted request, fallback-tool execution)",
        unauthorized_delivery: "a raw tool output was found in a returned value although the SUT's result control (Result Guardian decision, else exit_status) did not allow delivery or no decision authorised execution",
        missing_expected_effect: "the SUT's decision authorised an execution or a delivery that was not observed (diagnostic/availability finding, not a security bypass)",
        decision_effect_mismatch: "umbrella: any of the above",
      },
      separation_from_oracle_metrics:
        "Derived only from the SUT's reported decisions and the harness observation channel; never from the oracle. Not combined with, and not derived from, false_allow / false_deny. A scenario may count in both.",
      unit: "scenario; k counts eligible scenarios with at least one violation of the category",
      confidence_bound: "not_applicable",
      confidence_bound_reason: INTEGRITY_BOUND_REASON,
      runtime: integritySection("runtime", i.baseline.verdicts),
      component: integritySection("component", i.baseline.verdicts),
    },
    mutation_sensitivity: {
      executed: i.mutation.executed,
      corpus_profile: i.mutation.corpus_profile,
      runtime: mRuntime,
      component: mComponent,
      aggregate_descriptive_only: i.mutation.executed
        ? { note: "descriptive only; not a headline metric", killed: mRuntime.killed + mComponent.killed, mutants: mRuntime.mutants + mComponent.mutants }
        : null,
      by_mutant: i.mutation.results,
      by_family: Object.fromEntries(
        [...new Set(i.mutation.results.map((r) => r.family))].sort().map((f) => {
          const rs = i.mutation.results.filter((r) => r.family === f);
          return [f, { boundary: rs[0].evaluation_boundary, mutants: rs.length, killed: rs.filter((r) => r.status === "killed").length }];
        }),
      ),
      witness_cases: Object.fromEntries(i.mutation.results.map((r) => [r.mutation_id, r.witness_case_ids])),
    },
    findings,
    adapter_errors: i.baseline.adapter_errors,
    harness_errors: i.baseline.harness_errors,
    oracle_limitation: ORACLE_LIMITATION,
    limitations: LIMITATIONS,
  };
}
export type Report = ReturnType<typeof buildReport>;
