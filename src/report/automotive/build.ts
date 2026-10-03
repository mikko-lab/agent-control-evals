/**
 * Pure automotive bundle builder (auto-report-0.1.0).
 *
 *   entries + exact corpus bytes + D1 run output + injected harness identity
 *     -> evidence bytes, manifest, report, summary (all in memory)
 *
 * It does not execute Git, run a SUT, touch the filesystem, read the clock or
 * regenerate evaluator results. D1 case evaluations are embedded unchanged; the
 * report only counts and flattens them. An internally inconsistent input is a
 * report-build error and no bundle is produced. There is no score, grade, rate,
 * confidence bound or severity anywhere in the output.
 */
import { canonicalJsonLines } from "../../util/canonical-json";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS, type ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import { AUTOMOTIVE_VERDICTS } from "../../spec/automotive/outcomes";
import {
  AUTOMOTIVE_HARNESS_ERROR_REASONS,
  AUTOMOTIVE_REASONS_BY_VERDICT,
  AUTOMOTIVE_UNASSESSABLE_REASONS,
  AUTOMOTIVE_VIOLATION_REASONS,
} from "../../spec/automotive/reason-taxonomy";
import { AUTOMOTIVE_PACK_VERSION, AUTOMOTIVE_REPORT_SCHEMA_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import { AUTOMOTIVE_OBSERVATION_STATES, CLAIM_ATTRIBUTION_KINDS, EVENT_DELIVERY_STATES, UNVERIFIABLE_CLASSIFICATIONS } from "../../adapter/automotive/protocol";
import type { AutomotiveCaseEvaluation, AutomotiveRunOutput } from "../../eval/automotive/types";
import { buildEvidenceRecords, evidenceBytes } from "./evidence";
import { AUTOMOTIVE_REPORT_LIMITATIONS } from "./limitations";
import { buildAutomotiveManifest } from "./manifest";
import { renderAutomotiveSummary } from "./summary";
import {
  AutomotiveReportBuildError,
  type AutomotiveBundle,
  type AutomotiveCheckSummary,
  type AutomotiveEvidenceRecord,
  type AutomotiveHarnessIdentity,
  type AutomotiveObservationEvidence,
  type AutomotiveReasonCounts,
  type AutomotiveReport,
  type AutomotiveReportFinding,
  type AutomotiveScenarioCounts,
  type AutomotiveVariantCounts,
} from "./types";

export interface AutomotiveBundleInput {
  entries: readonly AutomotiveCorpusEntry[];
  /** The exact corpus.jsonl bytes; must be the canonical serialisation of `entries`. */
  corpusBytes: string;
  run: AutomotiveRunOutput;
  harnessIdentity: AutomotiveHarnessIdentity;
}

const fail = (m: string): never => {
  throw new AutomotiveReportBuildError(m);
};

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

function scenarioCounts(records: readonly AutomotiveEvidenceRecord[]): AutomotiveScenarioCounts {
  const verdicts = zeros(AUTOMOTIVE_VERDICTS);
  for (const r of records) if (r.evaluation) verdicts[r.evaluation.verdict]++;
  const evaluated = records.filter((r) => r.evaluation !== null).length;
  return {
    planned_scenarios: records.length,
    evaluated_scenarios: evaluated,
    not_run_scenarios: records.filter((r) => r.status === "not_run").length,
    verdict_counts: verdicts,
    assessed_scenarios: verdicts.PASS + verdicts.VIOLATION,
    violation_count: verdicts.VIOLATION,
  };
}

/** Every check must carry reasons of its own verdict class only (PASS: none). Anything else is an inconsistent run. */
function checkReasons(ev: AutomotiveCaseEvaluation): void {
  for (const c of ev.checks) {
    if (c.verdict === "PASS") {
      if (c.reasons.length > 0) fail(`case ${ev.case_id}: PASS check ${c.check_id} carries reasons`);
      continue;
    }
    const allowed = AUTOMOTIVE_REASONS_BY_VERDICT[c.verdict] as readonly string[];
    if (c.reasons.length === 0) fail(`case ${ev.case_id}: ${c.verdict} check ${c.check_id} carries no reason`);
    for (const r of c.reasons) if (!allowed.includes(r)) fail(`case ${ev.case_id}: check ${c.check_id} carries ${r}, not a ${c.verdict} reason`);
  }
}

function checkSummary(evs: readonly AutomotiveCaseEvaluation[]): AutomotiveCheckSummary {
  const s: AutomotiveCheckSummary = { required: { total: 0, PASS: 0, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0, assessed: 0 }, optional: { total: 0, PASS: 0, VIOLATION: 0 } };
  for (const c of evs.flatMap((e) => e.checks)) {
    if (c.required) {
      s.required.total++;
      s.required[c.verdict]++;
    } else {
      s.optional.total++;
      if (c.verdict === "PASS") s.optional.PASS++;
      else if (c.verdict === "VIOLATION") s.optional.VIOLATION++;
      else fail(`optional check ${c.check_id} has verdict ${c.verdict}`);
    }
  }
  s.required.assessed = s.required.PASS + s.required.VIOLATION;
  return s;
}

function reasonCounts(evs: readonly AutomotiveCaseEvaluation[]): AutomotiveReasonCounts {
  const rc: AutomotiveReasonCounts = { VIOLATION: zeros(AUTOMOTIVE_VIOLATION_REASONS), UNASSESSABLE: zeros(AUTOMOTIVE_UNASSESSABLE_REASONS), HARNESS_ERROR: zeros(AUTOMOTIVE_HARNESS_ERROR_REASONS) };
  for (const c of evs.flatMap((e) => e.checks)) {
    if (c.verdict === "PASS") continue;
    const block = rc[c.verdict] as Record<string, number>;
    for (const r of c.reasons) block[r]++;
  }
  return rc;
}

function findings(records: readonly AutomotiveEvidenceRecord[]): AutomotiveReportFinding[] {
  return records.flatMap((r) =>
    (r.evaluation?.checks ?? []).flatMap((c): AutomotiveReportFinding[] =>
      c.verdict === "PASS"
        ? []
        : [
            {
              case_id: r.case_id,
              domain: r.domain,
              variant: r.variant,
              check_id: c.check_id,
              kind: c.kind,
              required: c.required,
              step: c.step,
              listing_id: c.listing_id,
              field: c.field,
              verdict: c.verdict,
              reasons: [...c.reasons],
              expected: structuredClone(c.expected),
              observed: structuredClone(c.observed),
            },
          ],
    ),
  );
}

function addAll(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

function observationEvidence(evs: readonly AutomotiveCaseEvaluation[]): AutomotiveObservationEvidence {
  const quoted = evs.flatMap((e) => e.quoted_claims.claims);
  const unverifiable = evs.flatMap((e) => e.unverifiable_claims.claims);
  const byClass: Record<string, number> = zeros(UNVERIFIABLE_CLASSIFICATIONS);
  for (const u of unverifiable) byClass[u.classification] = (byClass[u.classification] ?? 0) + 1;
  const attribution: Record<string, number> = zeros(CLAIM_ATTRIBUTION_KINDS);
  const channels = { claim: zeros(AUTOMOTIVE_OBSERVATION_STATES) as Record<string, number>, reference: zeros(AUTOMOTIVE_OBSERVATION_STATES) as Record<string, number>, status: zeros(AUTOMOTIVE_OBSERVATION_STATES) as Record<string, number> };
  const delivery: Record<string, number> = zeros(EVENT_DELIVERY_STATES);
  const unknownIds = new Set<string>();
  for (const e of evs) {
    const s = e.observation_summary;
    if (!s) continue;
    addAll(attribution, s.attribution_counts);
    addAll(channels.claim, s.channel_states.claim);
    addAll(channels.reference, s.channel_states.reference);
    addAll(channels.status, s.channel_states.status);
    for (const a of s.event_acknowledgements) delivery[a.delivery] = (delivery[a.delivery] ?? 0) + 1;
    for (const id of s.unknown_reference_listing_ids) unknownIds.add(id);
  }
  const quotedCount = evs.reduce((n, e) => n + e.quoted_claims.count, 0);
  if (quotedCount !== quoted.length) fail(`quoted claim counts (${quotedCount}) disagree with quoted claim records (${quoted.length})`);
  const unverifiableCount = evs.reduce((n, e) => n + e.unverifiable_claims.count, 0);
  if (unverifiableCount !== unverifiable.length) fail(`unverifiable claim counts (${unverifiableCount}) disagree with unverifiable claim records (${unverifiable.length})`);
  return {
    quoted_claims: { total: quoted.length, source_exists_count: quoted.filter((q) => q.content_exists).length, missing_source_count: quoted.filter((q) => !q.content_exists).length },
    unverifiable_claims: { total: unverifiable.length, by_classification: byClass },
    attribution_counts: attribution,
    channel_states: channels,
    event_delivery_states: delivery,
    unknown_reference_listing_ids: [...unknownIds].sort(),
  };
}

export function buildAutomotiveReport(entries: readonly AutomotiveCorpusEntry[], records: readonly AutomotiveEvidenceRecord[], run: AutomotiveRunOutput, manifest: AutomotiveReport["manifest"]): AutomotiveReport {
  const evaluations = records.flatMap((r) => (r.evaluation ? [r.evaluation] : []));
  for (const ev of evaluations) checkReasons(ev);
  const notRun = records.filter((r) => r.status === "not_run").length;
  const requiredChecks = evaluations.flatMap((e) => e.checks.filter((c) => c.required));
  const byDomain = Object.fromEntries(EXECUTABLE_AUTOMOTIVE_DOMAINS.map((d) => [d, scenarioCounts(records.filter((r) => r.domain === d))])) as Record<ExecutableAutomotiveDomain, AutomotiveScenarioCounts>;
  const byVariant: Record<string, AutomotiveVariantCounts> = {};
  for (const e of entries) {
    const key = `${e.case.domain}/${e.case.variant}`;
    if (byVariant[key]) continue;
    const rs = records.filter((r) => r.domain === e.case.domain && r.variant === e.case.variant);
    byVariant[key] = { domain: e.case.domain, variant: e.case.variant, case_ids: rs.map((r) => r.case_id), ...scenarioCounts(rs) };
  }
  return {
    report_schema_version: AUTOMOTIVE_REPORT_SCHEMA_VERSION,
    pack_version: AUTOMOTIVE_PACK_VERSION,
    profile: manifest.corpus.profile,
    manifest,
    run_valid: run.run_valid,
    complete_execution: records.length === entries.length && notRun === 0,
    all_required_assessed: notRun === 0 && requiredChecks.every((c) => c.verdict === "PASS" || c.verdict === "VIOLATION"),
    scenario_summary: scenarioCounts(records),
    check_summary: checkSummary(evaluations),
    reason_counts: reasonCounts(evaluations),
    observation_evidence: observationEvidence(evaluations),
    by_domain: byDomain,
    by_variant: byVariant,
    findings: findings(records),
    case_evaluations: structuredClone(evaluations),
    harness_errors: structuredClone(run.harness_errors),
    adapter_errors: structuredClone(run.adapter_errors),
    not_run_case_ids: [...run.not_run_case_ids],
    limitations: [...AUTOMOTIVE_REPORT_LIMITATIONS],
  };
}

/** The whole bundle, in memory. Throws AutomotiveReportBuildError on any inconsistency; never returns a partial bundle. */
export function buildAutomotiveBundle(input: AutomotiveBundleInput): AutomotiveBundle {
  const { entries, corpusBytes, run, harnessIdentity } = input;
  if (entries.length === 0) fail("empty corpus");
  if (canonicalJsonLines(entries) !== corpusBytes) fail("corpus bytes are not the canonical serialisation of the corpus entries");
  const records = buildEvidenceRecords(entries, run);
  const evidence = evidenceBytes(records);
  const manifest = buildAutomotiveManifest({ entries, corpusBytes, evidenceBytes: evidence, records, runValid: run.run_valid, hello: run.hello, harnessIdentity });
  const report = buildAutomotiveReport(entries, records, run, manifest);
  return { evidenceBytes: evidence, manifest, report, summary: renderAutomotiveSummary(report) };
}

