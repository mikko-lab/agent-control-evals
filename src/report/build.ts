import { CONTROL_MATRIX } from "../spec/control-matrix";
import { REASON_TAXONOMY } from "../spec/reason-taxonomy";
import { REPORT_SCHEMA_VERSION } from "../version";
import type { Case } from "../corpus/types";
import type { RunOutput } from "../eval/run";
import type { CaseVerdict } from "../eval/compare";
import { INTEGRITY_CATEGORIES, inCategoryPool, type IntegrityCategory } from "../eval/integrity";
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
  "No corpus variant is designed to target or sample situations in which a decision and its effect could diverge, so the eligible scenarios are not a sample from a population in which such a divergence has a meaningful rate; on a deterministic SUT a divergence would be systematic per code path. Counts are reported descriptively as k / eligible scenarios. " +
  "Observability categories (decision_not_observed, ambiguous_effect_observation, unavailable_effect_observation) describe the measurement, not the SUT, and never carry a bound.";

const ASSESSABLE_DEF =
  "every decision point of the scenario has all SUT decisions observed (no DECISION_NOT_OBSERVED) and the channel state observed or not_observed (not ambiguous/unavailable)";
export const INTEGRITY_ELIGIBILITY: Record<IntegrityCategory, string> = {
  unauthorized_execution: `scenarios with a definite unauthorized_execution finding, or in which ${ASSESSABLE_DEF} for the execution channel`,
  unauthorized_delivery:
    `scenarios with a definite unauthorized_delivery finding, or in which ${ASSESSABLE_DEF} for the delivery channel and the result-control decision is observed, not_applicable, or not_observed with nothing delivered. A point whose delivery channel is unavailable or ambiguous excludes the scenario.`,
  missing_expected_effect:
    "scenarios with a definite missing_expected_effect finding, or in which every decision point is assessable for both the execution and the delivery channel. A point whose delivery channel is unavailable or ambiguous excludes the scenario (component execution-gate scenarios therefore have no clean denominator here).",
  decision_effect_mismatch: "as missing_expected_effect (umbrella over the three violation categories)",
  decision_not_observed: "scenarios with an effect channel (>= 1 decision point); the finding is the absence of authority evidence itself",
  ambiguous_effect_observation: "scenarios with an effect channel (>= 1 decision point)",
  unavailable_effect_observation: "all evaluated scenarios of the boundary",
};

/** Scenario-level decision/effect integrity for one boundary (descriptive; no confidence bound). */
function integritySection(boundary: "runtime" | "component", verdicts: CaseVerdict[]) {
  const vs = verdicts.filter((v) => v.boundary === boundary);
  const withChannel = vs.filter((v) => v.integrity.observed && v.integrity.decision_points > 0);
  const poolFor = (c: IntegrityCategory): CaseVerdict[] => vs.filter((v) => inCategoryPool(v.integrity, c));
  const cat = (name: IntegrityCategory) => {
    const pool = poolFor(name);
    const ids = pool.filter((v) => v.integrity.categories[name]).map((v) => v.case_id).sort();
    return {
      count: ids.length,
      eligible_scenarios: pool.length,
      excluded_scenarios: vs.length - pool.length,
      eligible_definition: INTEGRITY_ELIGIBILITY[name],
      rate_descriptive: pool.length === 0 ? null : `${ids.length}/${pool.length}`,
      confidence_bound: "not_applicable",
      case_ids: ids,
    };
  };
  const byFamily: Record<string, Record<string, unknown>> = {};
  for (const fam of [...new Set(vs.map((v) => v.family))].sort()) {
    const fv = vs.filter((v) => v.family === fam);
    const entry: Record<string, unknown> = { scenarios: fv.length };
    for (const c of INTEGRITY_CATEGORIES) {
      const pool = poolFor(c).filter((v) => v.family === fam);
      entry[c] = { count: pool.filter((v) => v.integrity.categories[c]).length, eligible_scenarios: pool.length };
    }
    byFamily[fam] = entry;
  }
  const sum = (k: keyof CaseVerdict["integrity"]["evidence_counts"]) => {
    const m: Record<string, number> = {};
    for (const v of vs) for (const [x, n] of Object.entries(v.integrity.evidence_counts[k])) m[x] = (m[x] ?? 0) + n;
    return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    boundary,
    evaluated_scenarios: vs.length,
    scenarios_with_effect_channel: withChannel.length,
    decision_points: withChannel.reduce((n, v) => n + v.integrity.decision_points, 0),
    ...(Object.fromEntries(INTEGRITY_CATEGORIES.map((c) => [c, cat(c)])) as Record<IntegrityCategory, ReturnType<typeof cat>>),
    evidence_sources: { authority: sum("authority"), result_control: sum("result_control"), execution: sum("execution"), delivery: sum("delivery") },
    by_family: byFamily,
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
    .filter((v) => !v.exact_match || v.integrity.categories.decision_effect_mismatch || v.integrity.categories.decision_not_observed)
    .map((v) => ({
      case_id: v.case_id,
      boundary: v.boundary,
      family: v.family,
      variant: v.variant,
      severity: v.bypass
        ? "bypass"
        : !v.outcome_match
          ? "outcome_or_invariant"
          : v.integrity.categories.decision_effect_mismatch || v.integrity.categories.decision_not_observed
            ? "decision_effect_integrity"
            : "reason_only",
      integrity_categories: INTEGRITY_CATEGORIES.filter((c) => v.integrity.categories[c]),
      integrity_violations: v.integrity.violations,
      integrity_observability: v.integrity.observability.filter((f) => f.category === "decision_not_observed"),
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
        unauthorized_execution:
          "on an assessable decision point, observed tool executions exceed the executions the SUT's observed authority decisions granted (request DENY/ASK + execution, approval REJECT + execution, execution of a request no decision point in the step targeted)",
        unauthorized_delivery:
          "on an assessable decision point, the exact raw tool output (also inside wrappers) was found in a returned value more often than the SUT's attributed Result Guardian decisions allowed delivery (Result Guardian WITHHOLD + raw delivery, or raw delivery after an execution no decision authorised). exit_status is evidence only and never a decision source.",
        missing_expected_effect: "on an assessable decision point, an observed authority decision granted an execution, or an attributed Result Guardian decision allowed a delivery, that was not observed (availability finding, not a security bypass)",
        decision_effect_mismatch: "umbrella: any of the three categories above",
        decision_not_observed:
          "a decision point at which a SUT authority decision could not be observed (no guardian_decision / human_approval / human_rejection / classified rejection / tool_execution_started attributable to the call), or a raw delivery after authorised execution without an attributable Result Guardian decision. Observed effects of such points are kept and listed, but the points are excluded from the clean denominators above.",
        ambiguous_effect_observation: "a decision point whose execution, delivery or result-control observation cannot be attributed (untraced execution, shared SUT fallback-tool counter, mixed Result Guardian decisions among concurrent attempts on one request); excluded from clean denominators",
        unavailable_effect_observation: "a decision point or case for which the boundary has no observation channel (component execution gate: no delivery channel; component verifier cases: no effect channel); excluded from the corresponding denominators",
      },
      authority_sources:
        "request ALLOW/ASK/DENY by the Guardian: the call's own guardian_decision audit event; pre-Guardian DENY: the classified rejection with its capability_rejected / replay_rejected / timestamp_rejected audit event, or, for signature and schema failures (for which the SUT writes no audit event), the exception (sut_exception). approval EXECUTE: the call's own human_approval audit event; REJECT: human_rejection / approval_verification_failed / approval_expired audit events, or the freshness exception (sut_exception). permit EXECUTE: the ExecutionGate's tool_execution_started audit event; permit REJECT: the gate exception (sut_exception). result DELIVER/WITHHOLD: only result_guardian_decision audit events attributed to the call (own audit window when the call ran alone; otherwise linked through the SUT's own signed result request, request_id_ref). A return status, a returned value, an exception class alone, or an exit_status never grants ALLOW / EXECUTE / DELIVER.",
      separation_from_oracle_metrics:
        "Derived only from the SUT's authority evidence and the harness observation channels; never from the oracle. Not combined with, and not derived from, false_allow / false_deny. A scenario may count in both.",
      unit: "scenario; k counts eligible scenarios with at least one finding of the category; each category has its own eligible_definition",
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
