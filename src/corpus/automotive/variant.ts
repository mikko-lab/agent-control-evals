/**
 * Automotive variant definition and its declarative intent.
 *
 * A variant builds one scenario with its probes. Its intent is written by hand,
 * independently of the oracle, and the generator checks the oracle output against
 * it (double entry). An intent states expected truth only: exact values, exact
 * accepted price presentations, exact superseded prices, minimum candidate
 * counts and, for recommendation requests, the exact eligible set, the exact
 * unavailable listings and the exact failing constraints per listing. It never
 * states a verdict.
 */
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AutomotiveScenario, HardConstraintField, HarnessAnnotations, PriceBasis, VehicleFactField } from "./types";

export interface FactProbeIntent {
  probe_id: string;
  field: VehicleFactField;
  /** Exact authoritative canonical value (integer for km/year/kW fields, string otherwise). */
  expected: number | string;
  min_cross_listing_candidates: number;
  min_planted_conflicts: number;
}

export interface PriceProbeIntent {
  probe_id: string;
  field: "price";
  /** Exact accepted current-price presentations, in basis order (currency is the scenario currency). */
  accepted: { basis: PriceBasis; amount_minor: number }[];
  min_cross_listing_candidates: number;
  min_planted_conflicts: number;
  /** Exact superseded listing prices, oldest first. */
  superseded: number[];
}

export type ProbeIntent = FactProbeIntent | PriceProbeIntent;

/** Hand-written expected truth for one recommendation request (spec 7.4.8), checked against the oracle. */
export interface RecommendationIntent {
  /** The request's user_message step. */
  step: number;
  /** Exact eligible listing ids, in trusted inventory order. */
  eligible: string[];
  /** Exact listing ids whose authoritative status at the step is not available, in inventory order. */
  unavailable: string[];
  /** Exact failing active constraints per listing (HARD_CONSTRAINT_FIELDS order); a listing not named fails none. */
  failed_constraints: Record<string, HardConstraintField[]>;
}

export interface VariantIntent {
  /** One entry per declared probe; the generator requires an exact match of probe ids. */
  probes: ProbeIntent[];
  /** One entry per recommendation request, in step order; absent = none. */
  recommendations?: RecommendationIntent[];
}

export interface AutomotiveVariantDef {
  domain: ExecutableAutomotiveDomain;
  name: string;
  build: () => { scenario: AutomotiveScenario; annotations: HarnessAnnotations };
  intent: VariantIntent;
}
