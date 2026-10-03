/**
 * Fault judge and fault-sensitivity report builder (auto-fault-report-0.1.0). Pure: it receives
 * the validated fault set, the baseline D2 report, one run outcome per fault and the harness
 * identity. It runs no SUT and reads no Git, filesystem or clock.
 *
 * Kill discipline: a fault is killed only from evaluator findings in a technically valid run.
 * A harness or protocol failure never kills a fault; the adapter's own `activated` flag is never
 * consulted. Counts and a gate boolean only: no score, rate or severity.
 */
import { AUTOMOTIVE_FAULT_ADAPTER_VERSION, AUTOMOTIVE_FAULT_REPORT_VERSION, AUTOMOTIVE_FAULT_SET_VERSION } from "../../spec/automotive/version";
import type { AutomotiveHarnessIdentity, AutomotiveReport } from "../../report/automotive/types";
import { AUTOMOTIVE_FAULT_REPORT_LIMITATIONS } from "./limitations";
import { AutomotiveFaultGateError, type AutomotiveFaultDefinition, type AutomotiveFaultReport, type AutomotiveFaultResult, type AutomotiveFaultRunOutcome, type AutomotiveFaultSet } from "./types";

/** Problems that make a baseline reference run unusable for the gate (empty = usable). */
export function automotiveBaselineProblems(r: AutomotiveReport): string[] {
  const p: string[] = [];
  const v = r.scenario_summary.verdict_counts;
  if (!r.run_valid) p.push("baseline run_valid is false");
  if (!r.complete_execution) p.push("baseline execution is incomplete");
  if (!r.all_required_assessed) p.push("baseline has required checks that were not assessed");
  if (r.scenario_summary.not_run_scenarios > 0) p.push(`baseline has ${r.scenario_summary.not_run_scenarios} not-run scenarios`);
  if (v.PASS !== r.scenario_summary.planned_scenarios) p.push(`baseline PASS ${v.PASS} != planned ${r.scenario_summary.planned_scenarios}`);
  for (const k of ["VIOLATION", "UNASSESSABLE", "HARNESS_ERROR"] as const) if (v[k] > 0) p.push(`baseline has ${v[k]} ${k} scenarios`);
  return p;
}

/** Case ids of a fault's declared witness variants, in corpus order; every witness must PASS in the baseline. */
export function witnessCaseIds(fault: AutomotiveFaultDefinition, baseline: AutomotiveReport): string[] {
  const ids: string[] = [];
  for (const w of fault.witness_variants) {
    const evs = baseline.case_evaluations.filter((e) => e.variant === w);
    if (evs.length === 0) throw new AutomotiveFaultGateError(`${fault.fault_id}: witness variant ${w} has no baseline case`);
    for (const e of evs) {
      if (e.domain !== fault.domain) throw new AutomotiveFaultGateError(`${fault.fault_id}: witness variant ${w} belongs to ${e.domain}, not ${fault.domain}`);
      if (e.verdict !== "PASS") throw new AutomotiveFaultGateError(`${fault.fault_id}: witness ${e.case_id} (${w}) is ${e.verdict} in the baseline; a broken baseline cannot be a witness`);
    }
  }
  const set = new Set(fault.witness_variants);
  for (const e of baseline.case_evaluations) if (set.has(e.variant)) ids.push(e.case_id);
  return ids;
}

/** The identity a valid run of `fault_id` must declare (see src/adapter/automotive-faults/agent.ts). */
const FAULT_SUT = { adapter: "automotive-fault-adapter", sut: "automotive-synthetic-fault-agent", version: AUTOMOTIVE_FAULT_ADAPTER_VERSION };

function invalidReason(fault: AutomotiveFaultDefinition, o: AutomotiveFaultRunOutcome): string | null {
  if (!o.report) return o.failure ?? "no report was produced";
  const r = o.report;
  if (!r.run_valid) return "fault run is not valid (run_valid false)";
  if (!r.complete_execution) return `fault run is incomplete (${r.scenario_summary.not_run_scenarios} not run)`;
  if (r.scenario_summary.verdict_counts.HARNESS_ERROR > 0) return `fault run has ${r.scenario_summary.verdict_counts.HARNESS_ERROR} HARNESS_ERROR scenarios`;
  const { adapter, sut } = r.manifest;
  if (!adapter || !sut || adapter.name !== FAULT_SUT.adapter || adapter.version !== FAULT_SUT.version || sut.name !== FAULT_SUT.sut || sut.version !== FAULT_SUT.version || sut.revision !== fault.fault_id) {
    return `fault run identity is not the synthetic fault agent running ${fault.fault_id}`;
  }
  return null;
}

/** Judges one fault run against its declared witness rule. */
export function judgeAutomotiveFault(fault: AutomotiveFaultDefinition, outcome: AutomotiveFaultRunOutcome, witnessIds: readonly string[]): AutomotiveFaultResult {
  const base = {
    fault_id: fault.fault_id,
    domain: fault.domain,
    description: fault.description,
    expected_field: fault.expected_field,
    expected_reasons: [...fault.expected_reasons],
    witness_variants: [...fault.witness_variants],
    witness_case_ids: [...witnessIds],
  };
  const r = outcome.report;
  const invalid = invalidReason(fault, outcome);
  const facts = {
    run_valid: r?.run_valid ?? false,
    verdict_counts: r ? { ...r.scenario_summary.verdict_counts } : null,
    report_path: outcome.report_path,
    evidence_sha256: r?.manifest.evidence.sha256 ?? null,
  };
  const witnessSet = new Set(fault.witness_variants);
  const collateral = r ? r.case_evaluations.filter((e) => e.verdict === "VIOLATION" && !(e.domain === fault.domain && witnessSet.has(e.variant))).map((e) => e.case_id) : [];
  if (invalid !== null) return { ...base, status: "invalid", invalid_reason: invalid, matched_witness_case_ids: [], collateral_violation_case_ids: collateral, ...facts };
  const matching = new Set(
    r!.findings
      .filter((f) => f.verdict === "VIOLATION" && f.domain === fault.domain && witnessSet.has(f.variant) && f.field === fault.expected_field && fault.expected_reasons.every((x) => f.reasons.includes(x)))
      .map((f) => f.case_id),
  );
  const matched = r!.case_evaluations.map((e) => e.case_id).filter((id) => matching.has(id) && witnessIds.includes(id));
  return { ...base, status: matched.length > 0 ? "killed" : "survived", invalid_reason: null, matched_witness_case_ids: matched, collateral_violation_case_ids: collateral, ...facts };
}

export interface AutomotiveFaultReportInput {
  faultSet: AutomotiveFaultSet;
  faultSetSha256: string;
  baseline: AutomotiveReport;
  baselineReportPath: string;
  /** One outcome per declared fault, in manifest order. */
  outcomes: readonly AutomotiveFaultRunOutcome[];
  harnessIdentity: AutomotiveHarnessIdentity;
}

export function buildAutomotiveFaultReport(i: AutomotiveFaultReportInput): AutomotiveFaultReport {
  if (i.faultSet.fault_set_version !== AUTOMOTIVE_FAULT_SET_VERSION) throw new AutomotiveFaultGateError(`unsupported fault set ${String(i.faultSet.fault_set_version)}`);
  if (!/^[0-9a-f]{64}$/.test(i.faultSetSha256)) throw new AutomotiveFaultGateError("fault set SHA-256 must be 64 lowercase hex characters");
  const problems = automotiveBaselineProblems(i.baseline);
  if (problems.length > 0) throw new AutomotiveFaultGateError(`baseline is not a clean reference run: ${problems.join("; ")}`);
  if (i.outcomes.length !== i.faultSet.faults.length) throw new AutomotiveFaultGateError(`${i.outcomes.length} fault outcomes for ${i.faultSet.faults.length} declared faults`);
  for (const o of i.outcomes) {
    if (o.report && o.report.manifest.corpus.sha256 !== i.baseline.manifest.corpus.sha256) throw new AutomotiveFaultGateError("a fault run used a different corpus than the baseline");
  }
  const faults = i.faultSet.faults.map((f, k) => judgeAutomotiveFault(f, i.outcomes[k], witnessCaseIds(f, i.baseline)));
  const count = (s: AutomotiveFaultResult["status"]) => faults.filter((f) => f.status === s).length;
  const b = i.baseline;
  return {
    fault_report_version: AUTOMOTIVE_FAULT_REPORT_VERSION,
    fault_set_version: i.faultSet.fault_set_version,
    fault_set_sha256: i.faultSetSha256,
    fault_adapter_version: AUTOMOTIVE_FAULT_ADAPTER_VERSION,
    pack_version: b.pack_version,
    profile: b.profile,
    corpus_sha256: b.manifest.corpus.sha256,
    harness: { commit: i.harnessIdentity.commit, worktree_clean: i.harnessIdentity.worktree_clean },
    baseline: {
      report_path: i.baselineReportPath,
      evidence_sha256: b.manifest.evidence.sha256,
      run_valid: b.run_valid,
      complete_execution: b.complete_execution,
      all_required_assessed: b.all_required_assessed,
      verdict_counts: { ...b.scenario_summary.verdict_counts },
    },
    gate: { passed: count("killed") === faults.length, fault_count: faults.length, killed: count("killed"), survived: count("survived"), invalid: count("invalid") },
    faults,
    limitations: [...AUTOMOTIVE_FAULT_REPORT_LIMITATIONS],
  };
}
