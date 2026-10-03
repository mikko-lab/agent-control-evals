/**
 * Deterministic automotive reference agent (auto-reference-agent-0.2.0): a synthetic
 * SUT used to test the harness end to end. It is not part of the oracle.
 *
 * It sees only the adapter view of a case (no probes, planted values or expected
 * truth), uses the trusted structured scenario data as its declared data source,
 * applies every inventory event before later turns and acknowledges it as delivered,
 * and answers every user turn with exact structured observations for every listing:
 * all vehicle facts, current status and current price, references and status
 * presentations. A turn that carries a structured recommendation request is also
 * answered on the recommendation channel: every listing it currently holds as
 * available and satisfying every active hard constraint, as a match, in inventory
 * order; an explicit no_match when there is none. Turns without a request leave the
 * recommendation channel not_observed. No randomness, wall clock, network, oracle or
 * corpus generation: this is the agent's own rule, not the oracle's eligibility.
 *
 * It lives in src/adapter/automotive-reference/ rather than src/adapter/automotive/ because the
 * merged PR C contract test pins the protocol directory to the protocol and client modules only.
 */
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, AUTOMOTIVE_REFERENCE_AGENT_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCaseForAdapter, HardConstraints, InventoryStatus, TrustedListing } from "../../corpus/automotive/types";
import type {
  AutomotiveEventAcknowledgement,
  AutomotiveHelloResponse,
  AutomotiveObservations,
  AutomotiveObservedClaim,
  AutomotiveRecommendationObservation,
  AutomotiveTurnObservation,
} from "../automotive/protocol";

export function referenceHello(): AutomotiveHelloResponse {
  return {
    type: "hello",
    protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION,
    adapter: "automotive-reference-adapter",
    adapter_version: AUTOMOTIVE_REFERENCE_AGENT_VERSION,
    // Self-declared identity; not Git-pinned, so no revision is claimed.
    sut: { name: "automotive-reference-agent", version: AUTOMOTIVE_REFERENCE_AGENT_VERSION, revision: null },
  };
}

export interface ReferenceListingState {
  readonly listing: TrustedListing;
  status: InventoryStatus;
  price_minor: number;
}
type ListingState = ReferenceListingState;

const TRUSTED = { kind: "trusted_fact" } as const;
const OBSERVED_BY_SUT = { state: "observed", source: "sut_structured_output", detail: null } as const;

function claimsFor(s: ListingState, view: AutomotiveCaseForAdapter): AutomotiveObservedClaim[] {
  const l = s.listing;
  const totalRequired = view.scenario.policy.mandatory_fee_policy === "total_required";
  return [
    { kind: "vehicle_fact", listing_id: l.listing_id, field: "odometer", value: l.odometer_km, unit: "km", attribution: TRUSTED },
    { kind: "vehicle_fact", listing_id: l.listing_id, field: "model_year", value: l.model_year, unit: "year", attribution: TRUSTED },
    { kind: "vehicle_fact", listing_id: l.listing_id, field: "first_registration", value: l.first_registration, unit: null, attribution: TRUSTED },
    { kind: "vehicle_fact", listing_id: l.listing_id, field: "fuel", value: l.fuel, unit: null, attribution: TRUSTED },
    { kind: "vehicle_fact", listing_id: l.listing_id, field: "transmission", value: l.transmission, unit: null, attribution: TRUSTED },
    { kind: "vehicle_fact", listing_id: l.listing_id, field: "power", value: l.power_kw, unit: "kW", attribution: TRUSTED },
    { kind: "status", listing_id: l.listing_id, field: "status", status: s.status, attribution: TRUSTED },
    {
      kind: "price",
      listing_id: l.listing_id,
      field: "price",
      amount_minor: totalRequired ? s.price_minor + l.mandatory_fees_minor : s.price_minor,
      currency: view.scenario.currency,
      basis: totalRequired ? "total_with_mandatory_fees" : "listing_price",
      temporal_qualifier: "current",
      attribution: TRUSTED,
    },
  ];
}

/** Whether the agent's current view of a listing meets every active hard constraint (exact, inclusive comparisons). */
export function meetsHardConstraints(s: ReferenceListingState, hc: HardConstraints): boolean {
  const l = s.listing;
  if (hc.max_price !== null) {
    const amount = hc.max_price.basis === "listing_price" ? s.price_minor : s.price_minor + l.mandatory_fees_minor;
    if (amount > hc.max_price.amount_minor) return false;
  }
  if (hc.max_odometer_km !== null && l.odometer_km > hc.max_odometer_km) return false;
  if (hc.min_model_year !== null && l.model_year < hc.min_model_year) return false;
  if (hc.allowed_fuels.length > 0 && !hc.allowed_fuels.includes(l.fuel)) return false;
  if (hc.allowed_transmissions.length > 0 && !hc.allowed_transmissions.includes(l.transmission)) return false;
  if (hc.allowed_bodies.length > 0 && !hc.allowed_bodies.includes(l.body)) return false;
  if (hc.min_seats !== null && l.seats < hc.min_seats) return false;
  return true;
}

/** The agent's answer to a request from its current listing states (inventory order): matches, or an explicit no_match. */
export function referenceRecommendation(states: readonly ReferenceListingState[], hc: HardConstraints): AutomotiveRecommendationObservation {
  const matches = states.filter((s) => s.status === "available" && meetsHardConstraints(s, hc));
  if (matches.length === 0) return { outcome: "no_match", items: [] };
  return { outcome: "recommendations", items: matches.map((s, i) => ({ listing_id: s.listing.listing_id, rank: i + 1, slot: i + 1, presentation: "match" as const })) };
}

/** Observations for one case, derived only from the adapter view. */
export function referenceObservations(view: AutomotiveCaseForAdapter): AutomotiveObservations {
  const state = new Map<string, ListingState>(view.scenario.trusted.inventory.map((l) => [l.listing_id, { listing: l, status: l.status, price_minor: l.price_minor }]));
  const turns: AutomotiveTurnObservation[] = [];
  const event_acknowledgements: AutomotiveEventAcknowledgement[] = [];
  view.scenario.steps.forEach((step, i) => {
    if (step.op === "inventory_event") {
      // Apply the update to the same state later claims use, then acknowledge it.
      const s = state.get(step.listing_id);
      if (s) {
        if (step.change.kind === "status") s.status = step.change.status;
        else s.price_minor = step.change.price_minor;
      }
      event_acknowledgements.push({ step: i, listing_id: step.listing_id, change: structuredClone(step.change), delivery: { state: "delivered", source: "push_ack", detail: null } });
      return;
    }
    const all = [...state.values()];
    turns.push({
      step: i,
      claim_channel: { ...OBSERVED_BY_SUT },
      claims: all.flatMap((s) => claimsFor(s, view)),
      unverifiable_claims: [],
      reference_channel: { ...OBSERVED_BY_SUT },
      references: all.map((s) => ({ listing_id: s.listing.listing_id, kind: "mentioned" as const })),
      status_channel: { ...OBSERVED_BY_SUT },
      status_presentations: all.map((s) => ({ listing_id: s.listing.listing_id, status: s.status })),
      recommendation_channel: step.request === null ? { state: "not_observed", source: "sut_structured_output", detail: null } : { ...OBSERVED_BY_SUT },
      recommendation: step.request === null ? null : referenceRecommendation(all, step.request.hard_constraints),
    });
  });
  return { turns, event_acknowledgements };
}
