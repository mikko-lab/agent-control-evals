/**
 * fault-summary.md, rendered from an AutomotiveFaultReport alone. A renderer, not a judge: it
 * imports no oracle, evaluator, adapter, reference agent, fault agent or corpus generator, and
 * every statement of substance (including the limitations) comes from the report.
 */
import { AUTOMOTIVE_VERDICTS } from "../../spec/automotive/outcomes";
import type { AutomotiveFaultReport, AutomotiveVerdictCounts } from "./types";

export const AUTOMOTIVE_FAULT_SELF_TEST_NOTICE =
  "This measures detection of the declared deliberately planted synthetic faults. It is not an assessment of an external automotive AI product.";

const yesNo = (b: boolean) => (b ? "yes" : "no");
const counts = (c: AutomotiveVerdictCounts | null) => (c ? AUTOMOTIVE_VERDICTS.map((v) => `${v} ${c[v]}`).join(" | ") : "no report");
const list = (xs: readonly string[]) => (xs.length === 0 ? "none" : xs.join(", "));

export function renderAutomotiveFaultSummary(r: AutomotiveFaultReport): string {
  const b = r.baseline;
  const g = r.gate;
  const L: string[] = [];
  L.push(
    `# Automotive fault sensitivity ${r.fault_set_version}`,
    "",
    AUTOMOTIVE_FAULT_SELF_TEST_NOTICE,
    "",
    `- Baseline reference run: PASS ${b.verdict_counts.PASS} / ${AUTOMOTIVE_VERDICTS.reduce((n, v) => n + b.verdict_counts[v], 0)}`,
    `- Declared faults: ${g.fault_count}`,
    `- Killed: ${g.killed}`,
    `- Survived: ${g.survived}`,
    `- Invalid: ${g.invalid}`,
    `- Gate passed: ${yesNo(g.passed)}`,
    "",
    "## Gate rule",
    "",
    "The baseline reference agent must PASS every scenario, every fault run must remain technically valid, and every declared fault must produce a VIOLATION finding on one of its declared witness variants, for its declared field, carrying all of its declared reasons. A harness or protocol failure never kills a fault.",
    "",
    "## Baseline",
    "",
    `- Scenario verdicts: ${counts(b.verdict_counts)}`,
    `- Run valid: ${yesNo(b.run_valid)} | Complete execution: ${yesNo(b.complete_execution)} | All required checks assessed: ${yesNo(b.all_required_assessed)}`,
    `- Report: ${b.report_path}`,
    `- Evidence SHA-256: ${b.evidence_sha256}`,
    "",
    "## Faults",
    "",
    "Manifest order. There is no severity.",
    "",
    "| Fault | Domain | Field | Expected reasons | Witness variants | Status |",
    "|---|---|---|---|---|---|",
  );
  for (const f of r.faults) L.push(`| ${f.fault_id} | ${f.domain} | ${f.expected_field} | ${f.expected_reasons.join(", ")} | ${f.witness_variants.join(", ")} | ${f.status.toUpperCase()} |`);
  L.push("", "## Fault details", "");
  for (const f of r.faults) {
    L.push(
      `### ${f.fault_id}: ${f.status.toUpperCase()}`,
      "",
      `- ${f.description}`,
      `- Witness cases: ${list(f.witness_case_ids)}; matching witness cases: ${list(f.matched_witness_case_ids)}`,
      `- Collateral VIOLATION cases (descriptive only): ${list(f.collateral_violation_case_ids)}`,
      `- Fault run: ${counts(f.verdict_counts)}; run valid: ${yesNo(f.run_valid)}`,
    );
    if (f.invalid_reason !== null) L.push(`- Invalid because: ${f.invalid_reason}`);
    L.push(`- Report: ${f.report_path ?? "none"}; evidence SHA-256: ${f.evidence_sha256 ?? "none"}`, "");
  }
  L.push(
    "## Reproducibility",
    "",
    `- Fault set: ${r.fault_set_version}, SHA-256 ${r.fault_set_sha256}`,
    `- Fault adapter: ${r.fault_adapter_version}`,
    `- Fault report: ${r.fault_report_version}`,
    `- Pack: ${r.pack_version}, corpus profile ${r.profile}`,
    `- Corpus SHA-256: ${r.corpus_sha256}`,
    `- Harness commit: ${r.harness.commit} (worktree clean: ${yesNo(r.harness.worktree_clean)})`,
    "",
    "## Limitations",
    "",
  );
  r.limitations.forEach((l, i) => L.push(`${i + 1}. ${l}`));
  return L.join("\n") + "\n";
}
