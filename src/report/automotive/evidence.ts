/**
 * evidence.jsonl (auto-evidence-0.1.0): one record per corpus entry, in corpus order,
 * built from the D1 run output without inventing anything.
 *
 * Before any record is produced the D1 run object is checked for internal
 * consistency against the corpus; an inconsistent run is a report-build error and
 * no evidence is emitted.
 */
import { canonicalJsonLines } from "../../util/canonical-json";
import { AUTOMOTIVE_EVALUATOR_VERSION, AUTOMOTIVE_EVIDENCE_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import type { AutomotiveCaseEvaluation, AutomotiveRunOutput } from "../../eval/automotive/types";
import { AutomotiveReportBuildError, type AutomotiveEvidenceRecord } from "./types";

const fail = (m: string): never => {
  throw new AutomotiveReportBuildError(m);
};

function uniqueIndex<T>(items: readonly T[], key: (x: T) => string, what: string, known: ReadonlySet<string>): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of items) {
    const k = key(x);
    if (m.has(k)) fail(`duplicate ${what} for case ${k}`);
    if (!known.has(k)) fail(`${what} for case ${k}, which is not in the corpus`);
    m.set(k, x);
  }
  return m;
}

/**
 * Checks the D1 run object against the corpus and returns one evidence record per entry. Throws
 * AutomotiveReportBuildError on: duplicate evaluation / adapter result / not-run id; a case id unknown to
 * the corpus; a case both evaluated and not run; an evaluation whose domain, variant or evaluator version
 * differs; an optional check with UNASSESSABLE or HARNESS_ERROR; an adapter result without an evaluation;
 * a status that contradicts the evaluation; a corpus case with no evidence status.
 */
export function buildEvidenceRecords(entries: readonly AutomotiveCorpusEntry[], run: AutomotiveRunOutput): AutomotiveEvidenceRecord[] {
  const corpusIds = new Set<string>();
  for (const e of entries) {
    if (corpusIds.has(e.case.case_id)) fail(`duplicate corpus case ${e.case.case_id}`);
    corpusIds.add(e.case.case_id);
  }
  if (run.evaluator_version !== AUTOMOTIVE_EVALUATOR_VERSION) fail(`run evaluator_version ${String(run.evaluator_version)} != ${AUTOMOTIVE_EVALUATOR_VERSION}`);
  const evaluations = uniqueIndex(run.case_evaluations, (e) => e.case_id, "case evaluation", corpusIds);
  const results = uniqueIndex(run.case_results, (r) => r.case_id, "adapter result", corpusIds);
  const notRun = uniqueIndex(run.not_run_case_ids, (id) => id, "not-run id", corpusIds);
  for (const h of run.harness_errors) if (h.case_id !== null && !corpusIds.has(h.case_id)) fail(`harness error for case ${h.case_id}, which is not in the corpus`);
  for (const a of run.adapter_errors) if (!corpusIds.has(a.case_id)) fail(`adapter error for case ${a.case_id}, which is not in the corpus`);

  const records = entries.map((entry): AutomotiveEvidenceRecord => {
    const id = entry.case.case_id;
    const evaluation = evaluations.get(id) ?? null;
    const result = results.get(id) ?? null;
    const base = { evidence_version: AUTOMOTIVE_EVIDENCE_VERSION as typeof AUTOMOTIVE_EVIDENCE_VERSION, case_id: id, domain: entry.case.domain, variant: entry.case.variant };
    if (notRun.has(id)) {
      if (evaluation || result) fail(`case ${id} is listed as not run but has ${evaluation ? "an evaluation" : "an adapter result"}`);
      return { ...base, status: "not_run", adapter_result: null, evaluation: null };
    }
    if (!evaluation) return fail(result ? `case ${id} has an adapter result but no evaluation` : `case ${id} has no evidence status (neither evaluated nor not run)`);
    checkEvaluation(entry, evaluation);
    if (result === null) {
      // Preflight or protocol/client failure on this case: no adapter result exists and none is invented.
      if (evaluation.verdict !== "HARNESS_ERROR") fail(`case ${id} has no adapter result but its verdict is ${evaluation.verdict}`);
      return { ...base, status: "harness_error", adapter_result: null, evaluation };
    }
    if (result.status === "adapter_error") {
      if (evaluation.verdict !== "HARNESS_ERROR") fail(`case ${id} has an adapter_error result but its verdict is ${evaluation.verdict}`);
      return { ...base, status: "harness_error", adapter_result: result, evaluation };
    }
    if (evaluation.verdict === "HARNESS_ERROR") fail(`case ${id} has an ok adapter result but a HARNESS_ERROR verdict`);
    return { ...base, status: "evaluated", adapter_result: result, evaluation };
  });
  if (records.length !== entries.length) fail(`evidence record count ${records.length} != corpus case count ${entries.length}`);
  return records;
}

function checkEvaluation(entry: AutomotiveCorpusEntry, ev: AutomotiveCaseEvaluation): void {
  const id = entry.case.case_id;
  if (ev.evaluator_version !== AUTOMOTIVE_EVALUATOR_VERSION) fail(`case ${id}: evaluation version ${String(ev.evaluator_version)} != ${AUTOMOTIVE_EVALUATOR_VERSION}`);
  if (ev.domain !== entry.case.domain) fail(`case ${id}: evaluation domain ${ev.domain} != corpus domain ${entry.case.domain}`);
  if (ev.variant !== entry.case.variant) fail(`case ${id}: evaluation variant ${ev.variant} != corpus variant ${entry.case.variant}`);
  for (const c of ev.checks) {
    if (!c.required && c.verdict !== "PASS" && c.verdict !== "VIOLATION") fail(`case ${id}: optional check ${c.check_id} has verdict ${c.verdict}; optional checks are only PASS or VIOLATION`);
  }
}

/**
 * Exact evidence.jsonl bytes. Canonical JSON rejects non-integer numbers, so a raw_sut_evidence value holding
 * one cannot be written exactly; that is a report-build error rather than a silent normalisation.
 */
export function evidenceBytes(records: readonly AutomotiveEvidenceRecord[]): string {
  try {
    return canonicalJsonLines(records);
  } catch (e) {
    return fail(`evidence cannot be encoded as canonical JSON (raw_sut_evidence is kept verbatim and must contain integers only): ${(e as Error).message}`);
  }
}
