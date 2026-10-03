/**
 * Expected-truth model of the automotive oracle (auto-oracle-0.2.0).
 *
 * The oracle states what exact structured claim would be authoritative for each
 * probe at the probe's step, plus deterministic diagnostic candidates that a later
 * evaluator can consult without re-simulating scenario state. For each
 * recommendation request it states the step-aware eligible set and the
 * per-listing hard-constraint results (spec section 7.4.8). It contains no
 * verdict, reason class, severity or score: those need observed SUT evidence
 * (PR C/D). Optional data is an empty array or `null`, never an absent member.
 */
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AUTOMOTIVE_ORACLE_VERSION } from "../../spec/automotive/version";
import type { HardConstraintField, HardConstraints, InventoryStatus, MandatoryFeePolicy, PriceBasis, VehicleFactField } from "../../corpus/automotive/types";

/** Canonical unit of an integer-valued vehicle fact. String-valued facts have no unit. */
export type FactUnit = "km" | "year" | "kW";

/** An authoritative vehicle-fact value in canonical form. */
export type FactValue = { value_type: "integer"; value: number; unit: FactUnit } | { value_type: "string"; value: string; unit: null };

export interface CrossListingFactCandidate {
  listing_id: string;
  value: FactValue;
}

/** A value planted in untrusted content for the probed listing and field that differs from the authoritative value. */
export interface PlantedFactCandidate {
  content_id: string;
  value: FactValue;
}

export interface VehicleFactProbeExpectation {
  kind: "vehicle_fact";
  probe_id: string;
  step: number;
  listing_id: string;
  field: VehicleFactField;
  expected: FactValue;
  /** Other listings at the probe step whose value of the same field differs from the target's. */
  cross_listing_candidates: CrossListingFactCandidate[];
  planted_conflict_candidates: PlantedFactCandidate[];
}

/** An exact price presentation: basis, integer amount in minor units, currency. */
export interface PricePresentation {
  basis: PriceBasis;
  amount_minor: number;
  currency: string;
}

export interface CrossListingPriceCandidate {
  listing_id: string;
  basis: PriceBasis;
  amount_minor: number;
  currency: string;
}

export interface PlantedPriceCandidate {
  content_id: string;
  amount_minor: number;
  currency: string;
}

/** A superseded listing price of the target. Always basis listing_price: historical fees are never reconstructed. */
export interface SupersededPriceCandidate {
  basis: "listing_price";
  amount_minor: number;
  currency: string;
}

export interface PriceProbeExpectation {
  kind: "price";
  probe_id: string;
  step: number;
  listing_id: string;
  field: "price";
  mandatory_fee_policy: MandatoryFeePolicy;
  /** Current-price presentations accepted under the declared policy, in PRICE_BASES order. */
  accepted_presentations: PricePresentation[];
  /** Both bases of every other listing at the probe step. */
  cross_listing_candidates: CrossListingPriceCandidate[];
  planted_conflict_candidates: PlantedPriceCandidate[];
  /** Superseded listing prices of the target at the probe step, oldest first, de-duplicated, excluding the current price. */
  superseded_listing_prices: SupersededPriceCandidate[];
}

export type ProbeExpectation = VehicleFactProbeExpectation | PriceProbeExpectation;

/** Result of one hard-constraint field for one listing at the request step (spec 7.4.8). */
export type ConstraintResult = "pass" | "fail" | "inactive";

export interface RecommendationListingEvaluation {
  listing_id: string;
  /** Authoritative status at the request step (every inventory event strictly before it applied). */
  status: InventoryStatus;
  /** Every hard-constraint field: pass or fail when active, inactive otherwise. */
  constraint_results: Record<HardConstraintField, ConstraintResult>;
}

/**
 * Expected truth for one recommendation request (spec 7.4.8). A listing is eligible exactly when its
 * authoritative status is available and every active constraint passes. No ranking, winner or score.
 */
export interface RecommendationExpectation {
  kind: "recommendation";
  /** The request's user_message step. */
  step: number;
  /** A copy of the request's hard constraints. */
  hard_constraints: HardConstraints;
  /** In trusted inventory order. */
  eligible_listing_ids: string[];
  /** One per trusted listing, in inventory order. */
  listing_evaluations: RecommendationListingEvaluation[];
}

export interface AutomotiveExpected {
  oracle_version: typeof AUTOMOTIVE_ORACLE_VERSION;
  case_id: string;
  domain: ExecutableAutomotiveDomain;
  /** One expectation per declared probe, in declaration order. */
  probe_expectations: ProbeExpectation[];
  /** One expectation per recommendation request, in step order (empty outside recommendation_integrity). */
  recommendation_expectations: RecommendationExpectation[];
}
