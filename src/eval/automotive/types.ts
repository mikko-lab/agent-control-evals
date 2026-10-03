/**
 * Internal evaluator results (auto-evaluator-0.2.0). Consumed by the D2 report
 * builder; this is not the report schema. Everything is JSON-serialisable and
 * deterministic: no timestamps, no randomness, no scores or severities.
 */
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AutomotiveVerdict } from "../../spec/automotive/outcomes";
import type { AutomotiveHarnessErrorReason, AutomotiveReasonClass } from "../../spec/automotive/reason-taxonomy";
import type { AUTOMOTIVE_EVALUATOR_VERSION } from "../../spec/automotive/version";
import type { HardConstraintField, ProbeField } from "../../corpus/automotive/types";
import type { AutomotiveCaseResult, AutomotiveHelloResponse, EventDeliveryState, RecommendationPresentation, UnverifiableClassification } from "../../adapter/automotive/protocol";

/** One recommendation item as the required check assessed it (spec 7.4.9). Descriptive evidence, never a score. */
export interface RecommendationItemDiagnostics {
  index: number;
  listing_id: string;
  rank: number;
  slot: number;
  presentation: RecommendationPresentation;
  known: boolean;
  /** From the listing's status dimension; null for an unknown listing. */
  availability: "available" | "unavailable" | "unresolved" | null;
  /** The oracle's pass/fail result of each active hard constraint; null for an unknown listing. */
  constraint_results: Partial<Record<HardConstraintField, "pass" | "fail">> | null;
  /** Active constraints whose oracle result is not assessable from delivered evidence (max_price only). */
  unassessable_constraints: HardConstraintField[];
  reasons: AutomotiveReasonClass[];
  state: "violating" | "valid" | "unresolved";
}

/** Diagnostics of one required recommendation check: the decision-table row that decided it and the evidence behind it. */
export interface RecommendationDiagnostics {
  /** Row 1-12 of the spec 7.4.9 decision table. */
  decision_row: number;
  items: RecommendationItemDiagnostics[];
  /** Listing ids presented more than once in the turn. Descriptive only. */
  duplicate_listing_ids: string[];
  /** Every trusted listing at the request step, in inventory order, by its spec 7.4.6 eligibility term. */
  listings: { definitely_eligible: string[]; definitely_ineligible: string[]; unresolved: string[] };
}

/**
 * One deterministic check. `required` = a harness-declared probe or recommendation request; optional checks come
 * from additional exact observed items and are only ever PASS or VIOLATION. PASS carries no reason; every other verdict carries at
 * least one reason class, in taxonomy order (reasons are secondary evidence, the verdict comes first).
 */
export interface AutomotiveCheckResult {
  check_id: string;
  kind: "probe" | "claim" | "status_presentation" | "recommendation";
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
  /** Required recommendation checks only: how the decision was reached. null for every other check. */
  diagnostics: RecommendationDiagnostics | null;
}

/** A claim the SUT attributed to untrusted content. Informational. */
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
  /** Items on the recommendation channel, over all turns. */
  recommendation_items: number;
  /** Per channel: state -> number of turns. */
  channel_states: { claim: Record<string, number>; reference: Record<string, number>; status: Record<string, number>; recommendation: Record<string, number> };
  /** Observed recommendation outcomes: outcome -> number of turns. */
  recommendation_outcomes: Record<string, number>;
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
