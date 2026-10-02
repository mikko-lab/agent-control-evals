/**
 * Text summary rendered ONLY from report.json data. No number in the summary
 * is typed by hand.
 */
import type { Report } from "./build";
import type { BoundaryMetrics, MetricBlock, VariantCoverage } from "../eval/metrics";

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(4).replace(/\.?0+$/, "")} %`);

function boundaryTable(m: BoundaryMetrics): string[] {
  const out = [
    `| Family | Variants (adv.) | Variants failing | Scenarios | Scenario mismatches | False allow (scenarios k/n, 95% UB) | False deny (k/n) | Bypass (k/n, 95% UB) | Inv. violations |`,
    `|---|---:|---:|---:|---:|---|---|---|---:|`,
  ];
  const row = (name: string, b: MetricBlock, cov: VariantCoverage) => {
    const s = b.scenario_counts;
    const inv = Object.values(b.invariants).reduce((a, x) => a + x, 0);
    return `| ${name} | ${cov.variants} (${cov.adversarial_variants}) | ${cov.variants_with_outcome_failure} | ${s.cases} | ${s.cases - s.cases_outcome_match}/${s.cases} | ${s.false_allow_cases}/${s.cases_with_restrictive_expectation} (${pct(b.scenario_bounds.false_allow.one_sided_95_upper_bound)}) | ${s.false_deny_cases}/${s.cases_with_permissive_primary} | ${s.bypass_cases}/${s.adversarial_cases} (${pct(b.scenario_bounds.bypass.one_sided_95_upper_bound)}) | ${inv} |`;
  };
  for (const [f, b] of Object.entries(m.by_family)) out.push(row(f, b, b.variant_coverage));
  out.push(row("**total**", m.total, m.variant_coverage));
  return out;
}

export function renderSummary(r: Report): string {
  const h = r.headline;
  const ms = r.mutation_sensitivity;
  const L: string[] = [];
  L.push(`# agent-control-evals ${h.harness_version}: ${r.profile} evaluation summary`);
  L.push("");
  L.push(`> Generated from \`report.json\` (report schema ${r.report_schema_version}). Do not edit by hand.`);
  L.push("");
  L.push("## Headline");
  L.push("");
  const fams = `${h.families.length} control families`;
  const mut = h.mutation;
  const hl = (x: typeof h.runtime) =>
    `${x.scenario_mismatches}/${x.scenarios} scenarios with an outcome or invariant mismatch, across ${x.variants} designed variants (${x.adversarial_variants} adversarial; ${x.variants_with_outcome_failure} with any failure)`;
  L.push(
    `At SUT commit \`${h.sut_commit}\`, harness version ${h.harness_version} (commit \`${h.harness_commit}\`), corpus \`${h.corpus_profile}\` (generator ${h.generator_version}, oracle spec ${h.oracle_spec_version}, SHA-256 \`${h.corpus_sha256}\`) and ${fams}, the harness observed: **runtime** ${hl(h.runtime)}; **component** ${hl(h.component)}.` +
      (mut
        ? ` The harness detected **${mut.runtime} runtime** and **${mut.component} component** deliberately planted faults (mutation set ${h.mutation_set_version}, run on the \`${mut.corpus_profile}\` corpus).`
        : " Mutation analysis was not executed in this run."),
  );
  L.push("");
  L.push(
    `Suomeksi: SUT-commitilla \`${h.sut_commit.slice(0, 12)}\`, harness-versiolla ${h.harness_version}, corpusversiolla ${h.generator_version}/${h.corpus_profile} ja ${h.families.length} kontrolliperheellä havaittiin runtime-tasolla ${h.runtime.scenario_mismatches}/${h.runtime.scenarios} ja component-tasolla ${h.component.scenario_mismatches}/${h.component.scenarios} skenaariota, joissa outcome tai invariantti poikkesi oraclesta. Varianttikattavuus: runtime ${h.runtime.variants} ja component ${h.component.variants} suunniteltua varianttia.` +
      (mut ? ` Harness havaitsi ${mut.runtime} runtime- ja ${mut.component} component-tason tarkoituksella istutetuista vioista.` : ""),
  );
  L.push("");
  L.push(
    `Statistical unit: **scenario** (one case). Confidence bounds are computed only on scenario proportions where k counts members of n. Assertion counts (runtime ${h.runtime.assertion_mismatches_descriptive}/${h.runtime.assertions_descriptive}, component ${h.component.assertion_mismatches_descriptive}/${h.component.assertions_descriptive} mismatching assertions) are descriptive only. Breadth of evidence is the number of designed variants, not the number of cases.`,
  );
  L.push("");
  L.push(`Full 10k benchmark executed in this run: **${r.full_benchmark_executed ? "yes" : "no"}**.`);
  L.push("");
  L.push("## Gates");
  L.push("");
  L.push(`- Harness valid: **${r.gates.harness_valid}**${r.gates.harness_validity_problems.length ? ` (${r.gates.harness_validity_problems.join("; ")})` : ""}`);
  L.push(`- Mutation gate passed: **${r.gates.mutation_gate_passed === null ? "not executed" : r.gates.mutation_gate_passed}**${r.gates.mutation_gate_failures.length ? ` (${r.gates.mutation_gate_failures.join("; ")})` : ""}`);
  L.push(`- Baseline findings (oracle mismatches on the real SUT): **${r.gates.baseline_findings}**`);
  L.push(`- Adapter errors: ${r.adapter_errors.length}; harness errors: ${r.harness_errors.length}`);
  L.push(`- Oracle independence: static boundary ${r.oracle_independence_check.static_dependency_check.ok ? "ok" : "VIOLATED"}, stored-expectation integrity errors ${r.oracle_independence_check.stored_expectation_integrity_errors}`);
  L.push("");
  L.push("## Runtime boundary (GuardedExecutor public API)");
  L.push("");
  L.push(...boundaryTable(r.runtime_metrics));
  L.push("");
  const t = r.runtime_metrics.total.descriptive_assertion_counts;
  L.push(`Escalation (assertion counts, descriptive): expected ASK ${t.expected_ask}, ASK→ASK ${t.ask_to_ask}, ASK→ALLOW ${t.ask_to_allow}, ASK→DENY ${t.ask_to_deny}, ALLOW→ASK ${t.allow_to_ask}, DENY→ASK ${t.deny_to_ask}.`);
  L.push(`Invariants (runtime): ${Object.entries(r.runtime_metrics.total.invariants).map(([k, v]) => `${k} ${v}`).join(", ")}. Decision/effect disagreements: ${r.runtime_metrics.total.scenario_counts.decision_effect_mismatch_cases} scenarios.`);
  L.push(`Family macro-average scenario outcome match: ${pct(r.runtime_metrics.family_macro_average.scenario_outcome_match_rate)}.`);
  L.push("");
  L.push("## Component boundary (direct component calls; different evidence level)");
  L.push("");
  L.push(...boundaryTable(r.component_metrics));
  L.push("");
  L.push(`Invariants (component): ${Object.entries(r.component_metrics.total.invariants).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  L.push("");
  L.push("## Decision/effect integrity (separate from oracle metrics; no confidence bounds)");
  L.push("");
  L.push("A control decision and an observed side effect are separate evidence. These counts compare the SUT's own decisions with what the harness observation channel saw (tool executions, raw-output deliveries). They do not use the oracle and are not combined with false allow / false deny.");
  L.push("");
  L.push("| Boundary | Eligible scenarios | Unauthorized execution | Unauthorized delivery (k/delivery-eligible) | Missing expected effect | Any mismatch | Not observed |");
  L.push("|---|---:|---|---|---|---|---:|");
  for (const b of [r.decision_effect_integrity.runtime, r.decision_effect_integrity.component]) {
    const ids = (c: { count: number; case_ids: string[] }) => (c.count === 0 ? "0" : `${c.count} (${c.case_ids.slice(0, 5).join(", ")}${c.case_ids.length > 5 ? ", ..." : ""})`);
    L.push(`| ${b.boundary} | ${b.eligible_scenarios} | ${ids(b.unauthorized_execution)} / ${b.eligible_scenarios} | ${ids(b.unauthorized_delivery)} / ${b.delivery_eligible_scenarios} | ${ids(b.missing_expected_effect)} / ${b.eligible_scenarios} | ${ids(b.decision_effect_mismatch)} / ${b.eligible_scenarios} | ${b.not_observed_scenarios} |`);
  }
  L.push("");
  L.push(`Confidence bound: not applicable. ${r.decision_effect_integrity.confidence_bound_reason.replace(/^not_applicable: /, "")}`);
  L.push("");
  L.push("## Mutation sensitivity");
  L.push("");
  if (!ms.executed) L.push("Not executed.");
  else {
    L.push(`Runtime: ${ms.runtime.kill_ratio} killed. Component: ${ms.component.kill_ratio} killed. (Reported per boundary; not combined.)`);
    L.push("");
    L.push("| Mutant | Boundary | Status | Witnesses / baseline-valid candidates / candidates | Integrity scenarios (exec / delivery / missing) | Example witness cases |");
    L.push("|---|---|---|---|---|---|");
    for (const m of ms.by_mutant) {
      L.push(`| ${m.mutation_id} | ${m.evaluation_boundary} | ${m.status} | ${m.witness_count} / ${m.baseline_valid_witness_candidates} / ${m.witness_candidates} | ${m.integrity_scenarios.unauthorized_execution} / ${m.integrity_scenarios.unauthorized_delivery} / ${m.integrity_scenarios.missing_expected_effect} | ${m.witness_case_ids.slice(0, 3).join(", ")} |`);
    }
  }
  L.push("");
  L.push("## N/A controls");
  L.push("");
  for (const n of r.na_controls) L.push(`- ${n.control}: N/A (${n.reason})`);
  L.push("");
  L.push("## Limitations");
  L.push("");
  for (const l of r.limitations) L.push(`- ${l}`);
  L.push("");
  return L.join("\n");
}
