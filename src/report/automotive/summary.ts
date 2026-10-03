/**
 * Human-readable summary.md, rendered from an AutomotiveReport alone.
 *
 * This is a renderer, not an evaluator: every number and sentence of substance comes
 * from the report (including its limitations); this module only knows headings and
 * formatting. It imports no oracle, evaluator, corpus generator, adapter or run
 * engine. Iteration order is fixed by the shared vocabularies and by case ids, so a
 * report and its parsed report.json render to identical bytes.
 */
import { EXECUTABLE_AUTOMOTIVE_DOMAINS } from "../../spec/automotive/domains";
import { AUTOMOTIVE_VERDICTS } from "../../spec/automotive/outcomes";
import { AUTOMOTIVE_HARNESS_ERROR_REASONS, AUTOMOTIVE_UNASSESSABLE_REASONS, AUTOMOTIVE_VIOLATION_REASONS } from "../../spec/automotive/reason-taxonomy";
import { AUTOMOTIVE_REFERENCE_AGENT_VERSION } from "../../spec/automotive/version";
import { automotiveJson } from "./json";
import type { AutomotiveReport, AutomotiveScenarioCounts, AutomotiveVariantCounts } from "./types";

/** The in-repo reference agent's hello identity (src/adapter/automotive-reference). Only this exact identity gets the self-test notice. */
export const AUTOMOTIVE_REFERENCE_IDENTITY = {
  adapter: { name: "automotive-reference-adapter", version: AUTOMOTIVE_REFERENCE_AGENT_VERSION },
  sut: { name: "automotive-reference-agent", version: AUTOMOTIVE_REFERENCE_AGENT_VERSION, revision: null },
} as const;

export const REFERENCE_AGENT_NOTICE =
  "> **Reference-agent self-test:** this run validates the harness path against the in-repo deterministic synthetic agent. It is not an assessment of an external automotive AI product.";

export function isReferenceAgentRun(r: AutomotiveReport): boolean {
  const { adapter, sut } = r.manifest;
  const ref = AUTOMOTIVE_REFERENCE_IDENTITY;
  return adapter !== null && sut !== null && adapter.name === ref.adapter.name && adapter.version === ref.adapter.version && sut.name === ref.sut.name && sut.version === ref.sut.version && sut.revision === ref.sut.revision;
}

const yesNo = (b: boolean) => (b ? "yes" : "no");

/** Inline code span that survives backticks inside the content. */
function code(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

const json = (v: unknown) => code(automotiveJson(v));

function sortedEntries(m: Record<string, number>): [string, number][] {
  return Object.keys(m)
    .sort()
    .map((k) => [k, m[k]]);
}

const countList = (m: Record<string, number>) => sortedEntries(m).map(([k, v]) => `${k} ${v}`).join(" | ") || "none";

function variantVerdict(v: AutomotiveVariantCounts): string {
  const parts = AUTOMOTIVE_VERDICTS.filter((x) => v.verdict_counts[x] > 0).map((x) => (v.planned_scenarios === 1 ? x : `${x} ${v.verdict_counts[x]}`));
  if (v.not_run_scenarios > 0) parts.push(v.planned_scenarios === 1 ? "NOT_RUN" : `NOT_RUN ${v.not_run_scenarios}`);
  return parts.join(", ");
}

const countsRow = (label: string, c: AutomotiveScenarioCounts) =>
  `| ${label} | ${c.planned_scenarios} | ${AUTOMOTIVE_VERDICTS.map((v) => c.verdict_counts[v]).join(" | ")} | ${c.not_run_scenarios} | ${c.assessed_scenarios} |`;

export function renderAutomotiveSummary(r: AutomotiveReport): string {
  const m = r.manifest;
  const s = r.scenario_summary;
  const req = r.check_summary.required;
  const opt = r.check_summary.optional;
  const L: string[] = [];
  const push = (...xs: string[]) => L.push(...xs);

  // Headline
  push(`# Automotive Agent Assurance ${r.pack_version}`, "");
  if (isReferenceAgentRun(r)) push(REFERENCE_AGENT_NOTICE, "");
  push(
    `- Corpus: ${r.profile}`,
    `- Planned scenarios: ${s.planned_scenarios}`,
    `- Scenario verdicts: ${AUTOMOTIVE_VERDICTS.map((v) => `${v} ${s.verdict_counts[v]}`).join(" | ")}`,
    `- Not run: ${s.not_run_scenarios}`,
    `- Required checks assessed: ${req.assessed} / ${req.total}`,
    `- Run valid: ${yesNo(r.run_valid)} | Complete execution: ${yesNo(r.complete_execution)} | All required checks assessed: ${yesNo(r.all_required_assessed)}`,
    "",
  );

  // Run identity
  push("## Run identity", "");
  push(
    m.adapter ? `- Adapter (self-declared via adapter hello): ${m.adapter.name} ${m.adapter.version}, protocol ${m.adapter.protocol_version}` : "- Adapter: none (the adapter handshake did not succeed)",
    m.sut ? `- SUT (self-declared via adapter hello): ${m.sut.name} ${m.sut.version}, revision ${m.sut.revision ?? "not declared"}` : "- SUT: none (the adapter handshake did not succeed)",
    `- Harness commit: ${m.harness.commit} (worktree clean: ${yesNo(m.harness.worktree_clean)})`,
    "",
  );

  // Scenario verdicts
  push("## Scenario verdicts", "", "| Verdict | Scenarios |", "|---|---|");
  for (const v of AUTOMOTIVE_VERDICTS) push(`| ${v} | ${s.verdict_counts[v]} |`);
  push(
    `| not run (no verdict) | ${s.not_run_scenarios} |`,
    "",
    `Evaluated scenarios: ${s.evaluated_scenarios} of ${s.planned_scenarios}. Assessed scenarios (PASS + VIOLATION): ${s.assessed_scenarios}; VIOLATION scenarios: ${s.violation_count}. UNASSESSABLE, HARNESS_ERROR and not-run scenarios are not in the assessed denominator.`,
    "",
  );

  // Results by domain
  push("## Results by domain", "", `| Domain | Planned | ${AUTOMOTIVE_VERDICTS.join(" | ")} | Not run | Assessed |`, `|---|---|${AUTOMOTIVE_VERDICTS.map(() => "---|").join("")}---|---|`);
  for (const d of EXECUTABLE_AUTOMOTIVE_DOMAINS) push(countsRow(d, r.by_domain[d]));
  push("");

  // Results by variant (corpus order via case ids; NOT_RUN is display text, not a verdict)
  push("## Results by variant", "", "| Domain / Variant | Case | Verdict |", "|---|---|---|");
  const variants = Object.values(r.by_variant).sort((a, b) => (a.case_ids[0] ?? "").localeCompare(b.case_ids[0] ?? ""));
  for (const v of variants) push(`| ${v.domain} / ${v.variant} | ${v.case_ids.join(", ")} | ${variantVerdict(v)} |`);
  push("");

  // Required / optional checks
  push(
    "## Required / optional checks",
    "",
    "| Checks | Total | PASS | VIOLATION | UNASSESSABLE | HARNESS_ERROR | Assessed |",
    "|---|---|---|---|---|---|---|",
    `| required | ${req.total} | ${req.PASS} | ${req.VIOLATION} | ${req.UNASSESSABLE} | ${req.HARNESS_ERROR} | ${req.assessed} |`,
    `| optional | ${opt.total} | ${opt.PASS} | ${opt.VIOLATION} | n/a | n/a | n/a |`,
    "",
    "Required checks are the declared probes and recommendation requests. Optional checks are additional exact observed items and are only ever PASS or VIOLATION.",
    "",
  );

  // Findings
  push("## Findings", "");
  const violations = r.findings.filter((f) => f.verdict === "VIOLATION");
  if (violations.length === 0) push("No VIOLATION checks were observed in this evaluated corpus.", "");
  if (r.findings.length === 0) push("No UNASSESSABLE or HARNESS_ERROR checks were recorded either.", "");
  else {
    push(`${r.findings.length} non-PASS checks, in corpus order and check order (there is no severity):`, "");
    for (const f of r.findings) {
      push(
        `- ${f.case_id} | ${f.domain} / ${f.variant} | ${f.check_id} (${f.required ? "required" : "optional"}) | **${f.verdict}** ${f.reasons.join(", ")}`,
        `  - listing ${f.listing_id ?? "none"}, field ${f.field ?? "none"}, step ${f.step}`,
        `  - expected: ${json(f.expected)}`,
        `  - observed: ${json(f.observed)}`,
      );
      if (f.diagnostics !== null) {
        push(`  - decision row: ${f.diagnostics.decision_row}`);
        for (const it of f.diagnostics.items) {
          const results = it.constraint_results;
          const constraints =
            results === null
              ? "unknown listing"
              : Object.keys(results)
                  .sort()
                  .map((k) => `${k} ${results[k as keyof typeof results] === "pass" ? "passed" : "failed"}`)
                  .join(", ") || "no active constraint";
          const unassessable = it.unassessable_constraints.length > 0 ? `; not assessable: ${it.unassessable_constraints.join(", ")}` : "";
          push(`  - item ${it.index}: ${it.listing_id} ${it.presentation}, rank ${it.rank}, slot ${it.slot}, ${it.state}${it.reasons.length > 0 ? ` (${it.reasons.join(", ")})` : ""}; ${constraints}${unassessable}`);
        }
        if (f.diagnostics.duplicate_listing_ids.length > 0) push(`  - duplicate listing ids: ${f.diagnostics.duplicate_listing_ids.join(", ")}`);
      }
    }
    push("");
  }
  push("Reason counts (checks carrying each reason):", "");
  const reasonLine = (label: string, keys: readonly string[], counts: Record<string, number>) => {
    const nonZero = keys.filter((k) => counts[k] > 0).map((k) => `${k} ${counts[k]}`);
    push(`- ${label}: ${nonZero.join(" | ") || "none"}`);
  };
  reasonLine("VIOLATION", AUTOMOTIVE_VIOLATION_REASONS, r.reason_counts.VIOLATION);
  reasonLine("UNASSESSABLE", AUTOMOTIVE_UNASSESSABLE_REASONS, r.reason_counts.UNASSESSABLE);
  reasonLine("HARNESS_ERROR", AUTOMOTIVE_HARNESS_ERROR_REASONS, r.reason_counts.HARNESS_ERROR);
  push("");

  // Unassessable evidence
  push("## Unassessable evidence", "");
  push(
    `- Required UNASSESSABLE checks: ${req.UNASSESSABLE}. They are never counted as PASS and never enter the assessed denominator.`,
    `- UNASSESSABLE scenarios: ${s.verdict_counts.UNASSESSABLE}`,
    `- HARNESS_ERROR scenarios: ${s.verdict_counts.HARNESS_ERROR}. Harness failures are never SUT findings.`,
    `- Harness errors: ${r.harness_errors.length === 0 ? "none" : r.harness_errors.length}`,
  );
  for (const h of r.harness_errors) push(`  - ${h.case_id ?? "run"}: ${h.reason}: ${json(h.message)}`);
  push(`- Adapter errors: ${r.adapter_errors.length === 0 ? "none" : r.adapter_errors.length}`);
  for (const a of r.adapter_errors) push(`  - ${a.case_id}: ${json(a.message)}`);
  push(`- Not-run cases: ${r.not_run_case_ids.length === 0 ? "none" : r.not_run_case_ids.join(", ")}`, "");

  // Quoted / unverifiable evidence
  const o = r.observation_evidence;
  push(
    "## Quoted / unverifiable evidence",
    "",
    "Informational only: none of these counts is a verdict.",
    "",
    `- Quoted claims: ${o.quoted_claims.total} (cited source exists: ${o.quoted_claims.source_exists_count}; cited source missing: ${o.quoted_claims.missing_source_count})`,
    `- Unverifiable claims: ${o.unverifiable_claims.total} (${countList(o.unverifiable_claims.by_classification)})`,
    `- Claim attribution: ${countList(o.attribution_counts)}`,
    `- Claim channel (turns): ${countList(o.channel_states.claim)}`,
    `- Reference channel (turns): ${countList(o.channel_states.reference)}`,
    `- Status channel (turns): ${countList(o.channel_states.status)}`,
    `- Recommendation channel (turns): ${countList(o.channel_states.recommendation)}`,
    `- Recommendation outcomes (turns): ${countList(o.recommendation_outcomes)}`,
    `- Event delivery acknowledgements: ${countList(o.event_delivery_states)}`,
    `- Unknown listing ids in references: ${o.unknown_reference_listing_ids.length === 0 ? "none" : o.unknown_reference_listing_ids.join(", ")}`,
    "",
  );

  // Reproducibility
  push(
    "## Reproducibility",
    "",
    `- Pack version: ${m.pack.pack_version}`,
    `- Corpus profile: ${m.corpus.profile} (${m.corpus.cases} cases, ${m.corpus.variants} variants)`,
    `- Corpus SHA-256: ${m.corpus.sha256}`,
    `- Evidence SHA-256: ${m.evidence.sha256} (${m.evidence.records} records, ${m.evidence.evidence_version})`,
    `- Oracle version: ${m.pack.oracle_version}`,
    `- Adapter protocol version: ${m.pack.adapter_protocol_version}`,
    `- Evaluator version: ${m.pack.evaluator_version}`,
    `- Reason taxonomy version: ${m.pack.reason_taxonomy_version}`,
    `- Report schema version: ${r.report_schema_version}`,
    `- Manifest version: ${m.manifest_version}`,
    `- Harness commit: ${m.harness.commit}`,
    `- Harness worktree clean: ${yesNo(m.harness.worktree_clean)}`,
    `- Adapter identity (self-declared via adapter hello): ${m.adapter ? `${m.adapter.name} ${m.adapter.version}` : "none"}`,
    `- SUT identity (self-declared via adapter hello): ${m.sut ? `${m.sut.name} ${m.sut.version}, revision ${m.sut.revision ?? "not declared"}` : "none"}`,
    "",
  );

  // Limitations (the report's own list)
  push("## Limitations", "");
  r.limitations.forEach((l, i) => push(`${i + 1}. ${l}`));
  return L.join("\n").replace(/\n+$/, "") + "\n";
}
