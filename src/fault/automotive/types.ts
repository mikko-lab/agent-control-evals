/**
 * Automotive fault-sensitivity contracts (auto-faults-0.2.0, auto-fault-report-0.2.0).
 *
 * A fault is a deliberately planted synthetic SUT behaviour, not a source mutant. The
 * gate reports counts and a boolean only: no score, rate, percentage or severity.
 */
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AutomotiveVerdict } from "../../spec/automotive/outcomes";
import type { AutomotiveViolationReason } from "../../spec/automotive/reason-taxonomy";
import type { AUTOMOTIVE_FAULT_ADAPTER_VERSION, AUTOMOTIVE_FAULT_REPORT_VERSION, AUTOMOTIVE_FAULT_SET_VERSION } from "../../spec/automotive/version";
import type { ProbeField } from "../../corpus/automotive/types";
import type { AutomotiveHarnessIdentity, AutomotiveReport } from "../../report/automotive/types";

export const AUTOMOTIVE_FAULT_STATUSES = ["killed", "survived", "invalid"] as const;
export type AutomotiveFaultStatus = (typeof AUTOMOTIVE_FAULT_STATUSES)[number];

export interface AutomotiveFaultDefinition {
  fault_id: string;
  domain: ExecutableAutomotiveDomain;
  description: string;
  target_behavior: string;
  /** The witness finding's field; null for recommendation_integrity, whose checks carry no field. */
  expected_field: ProbeField | null;
  /** All must be carried by one witness VIOLATION finding; extra diagnostic reasons are allowed. */
  expected_reasons: AutomotiveViolationReason[];
  /** Smoke variant names of the declared domain. */
  witness_variants: string[];
}

export interface AutomotiveFaultSet {
  fault_set_version: typeof AUTOMOTIVE_FAULT_SET_VERSION;
  faults: AutomotiveFaultDefinition[];
}

export type AutomotiveVerdictCounts = Record<AutomotiveVerdict, number>;

export interface AutomotiveFaultResult {
  fault_id: string;
  domain: ExecutableAutomotiveDomain;
  description: string;
  expected_field: ProbeField | null;
  expected_reasons: AutomotiveViolationReason[];
  witness_variants: string[];
  status: AutomotiveFaultStatus;
  /** Why the run was not technically usable; null unless status is invalid. */
  invalid_reason: string | null;
  /** Case ids of the declared witness variants, in corpus order. */
  witness_case_ids: string[];
  /** Witness case ids holding a matching VIOLATION finding, in corpus order (empty unless killed). */
  matched_witness_case_ids: string[];
  /** VIOLATION scenarios outside the declared witnesses, in corpus order. Descriptive only. */
  collateral_violation_case_ids: string[];
  run_valid: boolean;
  /** Scenario verdict counts of the fault run, or null when no report could be built. */
  verdict_counts: AutomotiveVerdictCounts | null;
  /** Relative to the fault output directory; null when no report was written. */
  report_path: string | null;
  evidence_sha256: string | null;
}

export interface AutomotiveFaultReport {
  fault_report_version: typeof AUTOMOTIVE_FAULT_REPORT_VERSION;
  fault_set_version: typeof AUTOMOTIVE_FAULT_SET_VERSION;
  /** SHA-256 of the exact fault-set.json bytes in the output directory. */
  fault_set_sha256: string;
  fault_adapter_version: typeof AUTOMOTIVE_FAULT_ADAPTER_VERSION;
  pack_version: string;
  profile: string;
  corpus_sha256: string;
  harness: AutomotiveHarnessIdentity;
  baseline: {
    report_path: string;
    evidence_sha256: string;
    run_valid: boolean;
    complete_execution: boolean;
    all_required_assessed: boolean;
    verdict_counts: AutomotiveVerdictCounts;
  };
  gate: { passed: boolean; fault_count: number; killed: number; survived: number; invalid: number };
  /** Manifest order. */
  faults: AutomotiveFaultResult[];
  limitations: string[];
}

/** One fault run as the runner saw it: a validated D2 report, or the reason none exists. */
export interface AutomotiveFaultRunOutcome {
  report: AutomotiveReport | null;
  report_path: string | null;
  failure: string | null;
}

/** A broken fault-gate precondition or inconsistency: a harness failure, never a fault verdict. */
export class AutomotiveFaultGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveFaultGateError";
  }
}
