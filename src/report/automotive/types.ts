/**
 * Automotive evidence bundle contracts (auto-evidence-0.1.0, auto-manifest-0.1.0,
 * auto-report-0.1.0).
 *
 * This is a presentation and evidence layer over the D1 evaluator output: it adds
 * identity, hashes and counts, never verdicts. Nothing here is a score, grade,
 * maturity level or assurance level, and nothing is a statistical estimate.
 */
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AutomotiveVerdict } from "../../spec/automotive/outcomes";
import type { AutomotiveHarnessErrorReason, AutomotiveReasonClass, AutomotiveUnassessableReason, AutomotiveViolationReason } from "../../spec/automotive/reason-taxonomy";
import type {
  AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION,
  AUTOMOTIVE_CASE_SCHEMA_VERSION,
  AUTOMOTIVE_CORPUS_ENTRY_VERSION,
  AUTOMOTIVE_EVALUATOR_VERSION,
  AUTOMOTIVE_EVIDENCE_VERSION,
  AUTOMOTIVE_GENERATOR_VERSION,
  AUTOMOTIVE_MANIFEST_VERSION,
  AUTOMOTIVE_ORACLE_VERSION,
  AUTOMOTIVE_PACK_VERSION,
  AUTOMOTIVE_REASON_TAXONOMY_VERSION,
  AUTOMOTIVE_REPORT_SCHEMA_VERSION,
} from "../../spec/automotive/version";
import type { AutomotiveCaseResult } from "../../adapter/automotive/protocol";
import type { AutomotiveAdapterErrorRecord, AutomotiveCaseEvaluation, AutomotiveCheckResult, AutomotiveHarnessErrorRecord } from "../../eval/automotive/types";

// ---------------------------------------------------------------- evidence

/** Per-case evidence status. not_run is not a verdict. */
export const AUTOMOTIVE_EVIDENCE_STATUSES = ["evaluated", "harness_error", "not_run"] as const;
export type AutomotiveEvidenceStatus = (typeof AUTOMOTIVE_EVIDENCE_STATUSES)[number];

/** One line of evidence.jsonl. Exactly one per corpus entry, in corpus order. */
export interface AutomotiveEvidenceRecord {
  evidence_version: typeof AUTOMOTIVE_EVIDENCE_VERSION;
  case_id: string;
  domain: ExecutableAutomotiveDomain;
  variant: string;
  status: AutomotiveEvidenceStatus;
  /** The validated adapter result exactly as the protocol returned it (raw_sut_evidence included), or null when none exists. */
  adapter_result: AutomotiveCaseResult | null;
  /** The D1 case evaluation, unchanged, or null for a case that was never run. */
  evaluation: AutomotiveCaseEvaluation | null;
}

export const AUTOMOTIVE_EVIDENCE_RECORD_FORMAT = "canonical JSON Lines; recursively sorted keys; UTF-8; LF; one record per corpus case";
export const AUTOMOTIVE_EVIDENCE_ORDER = "corpus order";

// ---------------------------------------------------------------- manifest

/** Repository identity of the harness, injected by the caller (the pure builders never read Git). */
export interface AutomotiveHarnessIdentity {
  /** 40-hex commit, or "unknown" when it could not be read. */
  commit: string;
  /** false whenever cleanliness could not be established. */
  worktree_clean: boolean;
}

export const AUTOMOTIVE_IDENTITY_SOURCE = "adapter_hello_self_declared";

export type AutomotiveScenarioVerdictCounts = Record<AutomotiveVerdict, number>;

export interface AutomotiveManifest {
  manifest_version: typeof AUTOMOTIVE_MANIFEST_VERSION;
  pack: {
    pack_version: typeof AUTOMOTIVE_PACK_VERSION;
    case_schema_version: typeof AUTOMOTIVE_CASE_SCHEMA_VERSION;
    reason_taxonomy_version: typeof AUTOMOTIVE_REASON_TAXONOMY_VERSION;
    oracle_version: typeof AUTOMOTIVE_ORACLE_VERSION;
    generator_version: typeof AUTOMOTIVE_GENERATOR_VERSION;
    corpus_entry_version: typeof AUTOMOTIVE_CORPUS_ENTRY_VERSION;
    adapter_protocol_version: typeof AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION;
    evaluator_version: typeof AUTOMOTIVE_EVALUATOR_VERSION;
    report_schema_version: typeof AUTOMOTIVE_REPORT_SCHEMA_VERSION;
  };
  corpus: {
    profile: string;
    pack_version: string;
    case_schema_version: string;
    oracle_version: string;
    generator_version: string;
    corpus_entry_version: string;
    sha256: string;
    bytes: number;
    cases: number;
    variants: number;
    cases_per_domain: Record<ExecutableAutomotiveDomain, number>;
  };
  evaluation: {
    evaluator_version: typeof AUTOMOTIVE_EVALUATOR_VERSION;
    /** Exactly D1's run_valid. */
    run_valid: boolean;
    case_statuses: Record<AutomotiveEvidenceStatus, number>;
  };
  evidence: {
    evidence_version: typeof AUTOMOTIVE_EVIDENCE_VERSION;
    sha256: string;
    bytes: number;
    records: number;
    record_format: typeof AUTOMOTIVE_EVIDENCE_RECORD_FORMAT;
    order: typeof AUTOMOTIVE_EVIDENCE_ORDER;
  };
  harness: AutomotiveHarnessIdentity;
  /** From the adapter hello only; null when the handshake did not succeed. */
  adapter: { name: string; version: string; protocol_version: string; identity_source: typeof AUTOMOTIVE_IDENTITY_SOURCE } | null;
  sut: { name: string; version: string; revision: string | null; identity_source: typeof AUTOMOTIVE_IDENTITY_SOURCE } | null;
}

// ---------------------------------------------------------------- report

/**
 * Scenario counts for one block (overall, domain or variant). evaluated = scenarios with a case evaluation
 * (any verdict, HARNESS_ERROR included); assessed = PASS + VIOLATION. UNASSESSABLE, HARNESS_ERROR and not-run
 * scenarios are never in the assessed denominator. There is deliberately no rate field.
 */
export interface AutomotiveScenarioCounts {
  planned_scenarios: number;
  evaluated_scenarios: number;
  not_run_scenarios: number;
  verdict_counts: AutomotiveScenarioVerdictCounts;
  assessed_scenarios: number;
  violation_count: number;
}

export interface AutomotiveVariantCounts extends AutomotiveScenarioCounts {
  domain: ExecutableAutomotiveDomain;
  variant: string;
  case_ids: string[];
}

export interface AutomotiveCheckSummary {
  required: { total: number; PASS: number; VIOLATION: number; UNASSESSABLE: number; HARNESS_ERROR: number; assessed: number };
  optional: { total: number; PASS: number; VIOLATION: number };
}

/** Number of checks (required and optional) carrying each reason, per verdict class. Every current reason is present. */
export interface AutomotiveReasonCounts {
  VIOLATION: Record<AutomotiveViolationReason, number>;
  UNASSESSABLE: Record<AutomotiveUnassessableReason, number>;
  HARNESS_ERROR: Record<AutomotiveHarnessErrorReason, number>;
}

/** Informational observation evidence aggregated from D1 case evaluations. Never part of any verdict count. */
export interface AutomotiveObservationEvidence {
  quoted_claims: { total: number; source_exists_count: number; missing_source_count: number };
  unverifiable_claims: { total: number; by_classification: Record<string, number> };
  attribution_counts: Record<string, number>;
  /** Per channel: observation state -> number of turns. */
  channel_states: { claim: Record<string, number>; reference: Record<string, number>; status: Record<string, number> };
  event_delivery_states: Record<string, number>;
  unknown_reference_listing_ids: string[];
}

export type AutomotiveFindingVerdict = Exclude<AutomotiveVerdict, "PASS">;

/** One non-PASS check, flattened. Corpus order, then D1 check order. There is no severity. */
export interface AutomotiveReportFinding {
  case_id: string;
  domain: ExecutableAutomotiveDomain;
  variant: string;
  check_id: string;
  kind: AutomotiveCheckResult["kind"];
  required: boolean;
  step: number;
  listing_id: string | null;
  field: AutomotiveCheckResult["field"];
  verdict: AutomotiveFindingVerdict;
  reasons: AutomotiveReasonClass[];
  expected: unknown | null;
  observed: unknown | null;
}

export interface AutomotiveReport {
  report_schema_version: typeof AUTOMOTIVE_REPORT_SCHEMA_VERSION;
  pack_version: typeof AUTOMOTIVE_PACK_VERSION;
  profile: string;
  manifest: AutomotiveManifest;
  /** Exactly D1's run_valid. */
  run_valid: boolean;
  /** One evidence record per planned case and none not run. Says nothing about correctness. */
  complete_execution: boolean;
  /** No case not run and every required check PASS or VIOLATION. A completeness indicator, not a score. */
  all_required_assessed: boolean;
  scenario_summary: AutomotiveScenarioCounts;
  check_summary: AutomotiveCheckSummary;
  reason_counts: AutomotiveReasonCounts;
  observation_evidence: AutomotiveObservationEvidence;
  by_domain: Record<ExecutableAutomotiveDomain, AutomotiveScenarioCounts>;
  /** Keyed "domain/variant". */
  by_variant: Record<string, AutomotiveVariantCounts>;
  findings: AutomotiveReportFinding[];
  /** D1 case evaluations, unchanged, in corpus order. */
  case_evaluations: AutomotiveCaseEvaluation[];
  harness_errors: AutomotiveHarnessErrorRecord[];
  adapter_errors: AutomotiveAdapterErrorRecord[];
  not_run_case_ids: string[];
  limitations: string[];
}

/** Everything the pure bundle builder returns. The CLI owns writing it. */
export interface AutomotiveBundle {
  evidenceBytes: string;
  manifest: AutomotiveManifest;
  report: AutomotiveReport;
  summary: string;
}

/** An internally inconsistent run object or input. A report-build error, never a SUT finding. */
export class AutomotiveReportBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveReportBuildError";
  }
}
