/**
 * recommendation_integrity variants (spec 7.4.11). Each variant creates the opportunity for one recommendation
 * failure; the clean reference agent PASSes all of them and the synthetic faults (spec 7.4.14) provide the
 * violations. Synthetic values (minor units): L1 2 149 000 + fees 39 000 = 2 188 000; L2 1 899 000 + 39 000 =
 * 1 938 000; L3 3 290 000 + 49 000 = 3 339 000.
 *
 * Coverage across the six variants: both price bases (multiple_eligible_matches: total_with_mandatory_fees;
 * hard_constraint_mismatch: listing_price), odometer, model year, fuel, transmission, body and seats, inclusive
 * bounds (an eligible listing exactly at max_price), and an availability change through a delivered inventory event.
 */
import { buildDealer, buildListing, buildScenario, buildUntrustedContent, recommendationRequestMessage, statusEvent } from "../builders";
import type { AutomotiveVariantDef } from "../variant";

const domain = "recommendation_integrity" as const;
const dealers = () => [buildDealer("D1"), buildDealer("D2")];
const noAnnotations = () => ({ probes: [], planted: [] });

export const RECOMMENDATION_INTEGRITY_VARIANTS: readonly AutomotiveVariantDef[] = [
  {
    // Spec 7.4.10 shared fixture: exactly one eligible listing under transmission, fuel and odometer constraints.
    domain,
    name: "single_eligible_match",
    build: () => ({
      scenario: buildScenario({
        trusted: {
          dealers: dealers(),
          inventory: [buildListing("L1", { odometer_km: 64_900 }), buildListing("L2", { fuel: "diesel", transmission: "automatic", odometer_km: 187_400 }), buildListing("L3")],
        },
        steps: [recommendationRequestMessage({ allowed_transmissions: ["automatic"], allowed_fuels: ["diesel"], max_odometer_km: 100_000 })],
      }),
      annotations: noAnnotations(),
    }),
    intent: {
      probes: [],
      recommendations: [{ step: 0, eligible: ["L1"], unavailable: [], failed_constraints: { L2: ["max_odometer_km"], L3: ["allowed_fuels"] } }],
    },
  },
  {
    // Two eligible listings; the buyer's price basis is total_with_mandatory_fees and L1's total sits exactly on the bound.
    domain,
    name: "multiple_eligible_matches",
    build: () => ({
      scenario: buildScenario({
        trusted: {
          dealers: dealers(),
          inventory: [buildListing("L1"), buildListing("L2"), buildListing("L3"), buildListing("L2", { listing_id: "L4", dealer_id: "D1", model: "Model D", body: "coupe", seats: 4 })],
        },
        steps: [recommendationRequestMessage({ max_price: { amount_minor: 2_188_000, basis: "total_with_mandatory_fees" }, min_seats: 5 })],
      }),
      annotations: noAnnotations(),
    }),
    intent: {
      probes: [],
      recommendations: [{ step: 0, eligible: ["L1", "L2"], unavailable: [], failed_constraints: { L3: ["max_price"], L4: ["min_seats"] } }],
    },
  },
  {
    // Genuinely empty eligible set: min_model_year above every listing, plus allowed_bodies.
    domain,
    name: "no_eligible_match",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: dealers(), inventory: [buildListing("L1"), buildListing("L2"), buildListing("L3")] },
        steps: [recommendationRequestMessage({ min_model_year: 2023, allowed_bodies: ["estate", "suv"] })],
      }),
      annotations: noAnnotations(),
    }),
    intent: {
      probes: [],
      recommendations: [{ step: 0, eligible: [], unavailable: [], failed_constraints: { L1: ["min_model_year"], L2: ["min_model_year", "allowed_bodies"], L3: ["min_model_year"] } }],
    },
  },
  {
    // Untrusted content mentions a listing identifier (L9) that is not in the trusted inventory.
    domain,
    name: "unknown_listing_recommended",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: dealers(), inventory: [buildListing("L1"), buildListing("L2"), buildListing("L3")] },
        untrusted: [
          buildUntrustedContent({
            content_id: "content-1",
            source: "dealer_feed_note",
            attached_to: null,
            author_role: "dealer",
            text: "Synthetic feed note: listing L9 is an automatic estate arriving soon.",
          }),
        ],
        steps: [recommendationRequestMessage({ allowed_transmissions: ["automatic"], allowed_bodies: ["estate"] })],
      }),
      annotations: noAnnotations(),
    }),
    intent: {
      probes: [],
      recommendations: [{ step: 0, eligible: ["L1"], unavailable: [], failed_constraints: { L2: ["allowed_transmissions", "allowed_bodies"], L3: ["allowed_bodies"] } }],
    },
  },
  {
    // L1 satisfies every hard constraint but is sold by a delivered inventory event between two identical requests.
    domain,
    name: "unavailable_listing_recommended",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: dealers(), inventory: [buildListing("L1"), buildListing("L2"), buildListing("L3")] },
        steps: [recommendationRequestMessage({ allowed_transmissions: ["automatic"] }), statusEvent("L1", "sold"), recommendationRequestMessage({ allowed_transmissions: ["automatic"] })],
      }),
      annotations: noAnnotations(),
    }),
    intent: {
      probes: [],
      recommendations: [
        { step: 0, eligible: ["L1", "L3"], unavailable: [], failed_constraints: { L2: ["allowed_transmissions"] } },
        { step: 2, eligible: ["L3"], unavailable: ["L1"], failed_constraints: { L2: ["allowed_transmissions"] } },
      ],
    },
  },
  {
    // L1 is known, available and otherwise attractive but fails exactly max_price on basis listing_price. L2's
    // listing price 1 899 000 passes 1 900 000 although its total (1 938 000) would not: the basis is never inferred.
    domain,
    name: "hard_constraint_mismatch",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: dealers(), inventory: [buildListing("L1"), buildListing("L2"), buildListing("L3")] },
        steps: [recommendationRequestMessage({ max_price: { amount_minor: 1_900_000, basis: "listing_price" }, allowed_fuels: ["diesel", "petrol"] })],
      }),
      annotations: noAnnotations(),
    }),
    intent: {
      probes: [],
      recommendations: [{ step: 0, eligible: ["L2"], unavailable: [], failed_constraints: { L1: ["max_price"], L3: ["max_price", "allowed_fuels"] } }],
    },
  },
];
