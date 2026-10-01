/**
 * Text summary rendered ONLY from report.json data. No number in the summary
 * is typed by hand.
 */
import type { Report } from "./build";
import type { BoundaryMetrics } from "../eval/metrics";

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(4).replace(/\.?0+$/, "")} %`);

function boundaryTable(m: BoundaryMetrics): string[] {
  const out = [
    `| Family | Cases | Exact match | False allow (k/n, 95% UB) | False deny (k/n) | Bypass (k/n, 95% UB) | Inv. violations |`,
    `|---|---:|---:|---|---|---|---:|`,
  ];
  for (const [f, b] of Object.entries(m.by_family)) {
    const c = b.counts;
    const inv = Object.values(c.invariants).reduce((a, x) => a + x, 0);
    out.push(
      `| ${f} | ${c.cases} | ${c.assertions_matched}/${c.assertions_evaluated} | ${c.false_allow}/${c.restrictive_expectations} (${pct(b.bounds.false_allow.one_sided_95_upper_bound)}) | ${c.false_deny}/${c.permissive_expectations} | ${c.bypasses}/${c.adversarial_cases} (${pct(b.bounds.bypass.one_sided_95_upper_bound)}) | ${inv} |`,
    );
  }
  const t = m.total.counts;
  out.push(
    `| **total** | ${t.cases} | ${t.assertions_matched}/${t.assertions_evaluated} | ${t.false_allow}/${t.restrictive_expectations} (${pct(m.total.bounds.false_allow.one_sided_95_upper_bound)}) | ${t.false_deny}/${t.permissive_expectations} | ${t.bypasses}/${t.adversarial_cases} (${pct(m.total.bounds.bypass.one_sided_95_upper_bound)}) | ${Object.values(t.invariants).reduce((a, x) => a + x, 0)} |`,
  );
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
  L.push(
    `At SUT commit \`${h.sut_commit}\`, harness version ${h.harness_version} (commit \`${h.harness_commit}\`), corpus \`${h.corpus_profile}\` (generator ${h.generator_version}, oracle spec ${h.oracle_spec_version}, SHA-256 \`${h.corpus_sha256}\`) and ${fams}, the harness observed **${h.runtime.oracle_mismatches}/${h.runtime.assertions} runtime** and **${h.component.oracle_mismatches}/${h.component.assertions} component** oracle mismatches.` +
      (mut
        ? ` The harness detected **${mut.runtime} runtime** and **${mut.component} component** deliberately planted faults (mutation set ${h.mutation_set_version}, run on the \`${mut.corpus_profile}\` corpus).`
        : " Mutation analysis was not executed in this run."),
  );
  L.push("");
  L.push(
    `Suomeksi: SUT-commitilla \`${h.sut_commit.slice(0, 12)}\`, harness-versiolla ${h.harness_version}, corpusversiolla ${h.generator_version}/${h.corpus_profile} ja ${h.families.length} kontrolliperheellä havaittiin ${h.runtime.oracle_mismatches}/${h.runtime.assertions} runtime- ja ${h.component.oracle_mismatches}/${h.component.assertions} component-oracle-mismatchia.` +
      (mut ? ` Harness havaitsi ${mut.runtime} runtime- ja ${mut.component} component-tason tarkoituksella istutetuista vioista.` : ""),
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
  const t = r.runtime_metrics.total.counts;
  L.push(`Escalation: expected ASK ${t.expected_ask}, ASK→ASK ${t.ask_to_ask}, ASK→ALLOW ${t.ask_to_allow}, ASK→DENY ${t.ask_to_deny}, ALLOW→ASK ${t.allow_to_ask}, DENY→ASK ${t.deny_to_ask}.`);
  L.push(`Invariants (runtime): ${Object.entries(t.invariants).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  L.push(`Family macro-average exact match: ${pct(r.runtime_metrics.family_macro_average.exact_oracle_match_rate)}.`);
  L.push("");
  L.push("## Component boundary (direct component calls; different evidence level)");
  L.push("");
  L.push(...boundaryTable(r.component_metrics));
  L.push("");
  L.push(`Invariants (component): ${Object.entries(r.component_metrics.total.counts.invariants).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  L.push("");
  L.push("## Mutation sensitivity");
  L.push("");
  if (!ms.executed) L.push("Not executed.");
  else {
    L.push(`Runtime: ${ms.runtime.kill_ratio} killed. Component: ${ms.component.kill_ratio} killed. (Reported per boundary; not combined.)`);
    L.push("");
    L.push("| Mutant | Boundary | Status | Witnesses / baseline-valid candidates / candidates | Example witness cases |");
    L.push("|---|---|---|---|---|");
    for (const m of ms.by_mutant) {
      L.push(`| ${m.mutation_id} | ${m.evaluation_boundary} | ${m.status} | ${m.witness_count} / ${m.baseline_valid_witness_candidates} / ${m.witness_candidates} | ${m.witness_case_ids.slice(0, 3).join(", ")} |`);
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
