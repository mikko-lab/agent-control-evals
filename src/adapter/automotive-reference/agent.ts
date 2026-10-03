/**
 * Deterministic automotive reference agent (auto-reference-agent-0.1.0): a synthetic
 * SUT used to test the harness end to end. It is not part of the oracle.
 *
 * It sees only the adapter view of a case (no probes, planted values or expected
 * truth), uses the trusted structured scenario data as its declared data source,
 * applies every inventory event before later turns and acknowledges it as delivered,
 * and answers every user turn with exact structured observations for every listing:
 * all vehicle facts, current status and current price, references and status
 * presentations. No randomness, wall clock, network, oracle or corpus generation.
 *
 * It lives in src/adapter/automotive-reference/ rather than src/adapter/automotive/ because the
 * merged PR C contract test pins the protocol directory to the protocol and client modules only.
 */
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, AUTOMOTIVE_REFERENCE_AGENT_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCaseForAdapter, InventoryStatus, TrustedListing } from "../../corpus/automotive/types";
import type { AutomotiveEventAcknowledgement, AutomotiveHelloResponse, AutomotiveObservations, AutomotiveObservedClaim, AutomotiveTurnObservation } from "../automotive/protocol";

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

interface ListingState {
  readonly listing: TrustedListing;
  status: InventoryStatus;
  price_minor: number;
}

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
    });
  });
  return { turns, event_acknowledgements };
}
