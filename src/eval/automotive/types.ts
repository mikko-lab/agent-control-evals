/**
 * Internal evaluator results (auto-evaluator-0.1.0). Consumed by the D2 report
 * builder; this is not the report schema. Everything is JSON-serialisable and
 * deterministic: no timestamps, no randomness, no scores or severities.
 */
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AutomotiveVerdict } from "../../spec/automotive/outcomes";
import type { AutomotiveHarnessErrorReason, AutomotiveReasonClass } from "../../spec/automotive/reason-taxonomy";
import type { AUTOMOTIVE_EVALUATOR_VERSION } from "../../spec/automotive/version";
import type { ProbeField } from "../../corpus/automotive/types";
import type { AutomotiveCaseResult, AutomotiveHelloResponse, EventDeliveryState, UnverifiableClassification } from "../../adapter/automotive/protocol";

/**
 * One deterministic check. `required` = a harness-declared probe; optional checks come from additional exact
 * observed items and are only ever PASS or VIOLATION. PASS carries no reason; every other verdict carries at
 * least one reason class, in taxonomy order (reasons are secondary evidence, the verdict comes first).
 */
export interface AutomotiveCheckResult {
  check_id: string;
  kind: "probe" | "claim" | "status_presentation";
  required: boolean;
  step: number;
  listing_id: string | null;
  field: ProbeField | null;
  verdict: AutomotiveVerdict;
  reasons: AutomotiveReasonClass[];
  /** Authoritative expectation the check compared against (from the oracle), or null when none applies. */
  expected: unknown | null;
  /** The observed item(s) exactly as the adapter reported them, or null when nothing was observed. */
  observed: unknown | null;
}

/** A claim the SUT attributed to untrusted content. Informational in auto-0.1.0. */
export interface AutomotiveQuotedClaimRecord {
  step: number;
  listing_id: string;
  field: ProbeField;
  content_id: string;
  /** Whether the cited content id exists in scenario.untrusted. A missing source is informational only. */
  content_exists: boolean;
}

export interface AutomotiveUnverifiableRecord {
  step: number;
  listing_id: string | null;
  field: ProbeField | null;
  classification: UnverifiableClassification;
  text: string;
}

export interface AutomotiveObservationSummary {
  turns: number;
  claims: number;
  status_presentations: number;
  references: number;
  /** Per channel: state -> number of turns. */
  channel_states: { claim: Record<string, number>; reference: Record<string, number>; status: Record<string, number> };
  /** Claims by attribution kind. */
  attribution_counts: Record<string, number>;
  /** Listing ids referenced (references only) that are not in the trusted inventory. Informational. */
  unknown_reference_listing_ids: string[];
  event_acknowledgements: { step: number; listing_id: string; delivery: EventDeliveryState }[];
}

export interface AutomotiveCaseEvaluation {
  evaluator_version: typeof AUTOMOTIVE_EVALUATOR_VERSION;
  case_id: string;
  domain: ExecutableAutomotiveDomain;
  variant: string;
  verdict: AutomotiveVerdict;
  checks: AutomotiveCheckResult[];
  quoted_claims: { count: number; claims: AutomotiveQuotedClaimRecord[] };
  unverifiable_claims: { count: number; by_classification: Record<string, number>; claims: AutomotiveUnverifiableRecord[] };
  /** null when the case produced no observations (harness error). */
  observation_summary: AutomotiveObservationSummary | null;
}

export interface AutomotiveHarnessErrorRecord {
  case_id: string | null;
  reason: AutomotiveHarnessErrorReason;
  message: string;
}

export interface AutomotiveAdapterErrorRecord {
  case_id: string;
  message: string;
}

export interface AutomotiveRunOutput {
  evaluator_version: typeof AUTOMOTIVE_EVALUATOR_VERSION;
  /** false when preflight failed, the handshake failed, a case hit a protocol/client failure, or a case is not run. */
  run_valid: boolean;
  hello: AutomotiveHelloResponse | null;
  case_evaluations: AutomotiveCaseEvaluation[];
  harness_errors: AutomotiveHarnessErrorRecord[];
  adapter_errors: AutomotiveAdapterErrorRecord[];
  not_run_case_ids: string[];
  /** Validated adapter results, kept so D2 can build evidence without re-running the SUT. */
  case_results: AutomotiveCaseResult[];
}
