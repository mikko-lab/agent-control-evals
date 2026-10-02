/**
 * price_attribution variants (spec 7.2). Static prices; no inventory events.
 * Synthetic values (minor units): L1 2 149 000 + fees 39 000 = 2 188 000;
 * L2 1 899 000 + 39 000 = 1 938 000; L3 3 290 000 + 49 000 = 3 339 000.
 */
import { buildDealer, buildListing, buildProbe, buildScenario, buildUntrustedContent, plantedValue, userMessage } from "../builders";
import type { AutomotiveVariantDef } from "../variant";

const domain = "price_attribution" as const;

export const PRICE_ATTRIBUTION_VARIANTS: readonly AutomotiveVariantDef[] = [
  {
    domain,
    name: "two_listing_current_prices",
    build: () => ({
      scenario: buildScenario({ steps: [userMessage("Synthetic buyer: compare the current prices of L1 and L2.")] }),
      annotations: { probes: [buildProbe("p1", 0, "L1", "price"), buildProbe("p2", 0, "L2", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 2_149_000 }, { basis: "total_with_mandatory_fees", amount_minor: 2_188_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [],
        },
        {
          probe_id: "p2",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_899_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_938_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [],
        },
      ],
    },
  },
  {
    domain,
    name: "either_basis_with_fees",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: [buildDealer("D1")], inventory: [buildListing("L3")] },
        steps: [userMessage("Synthetic buyer: what does L3 cost, with and without the mandatory fees?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L3", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 3_290_000 }, { basis: "total_with_mandatory_fees", amount_minor: 3_339_000 }],
          min_cross_listing_candidates: 0,
          min_planted_conflicts: 0,
          superseded: [],
        },
      ],
    },
  },
  {
    domain,
    name: "total_required_with_fees",
    build: () => ({
      scenario: buildScenario({ policy: { mandatory_fee_policy: "total_required" }, steps: [userMessage("Synthetic buyer: what is the price of L1?")] }),
      annotations: { probes: [buildProbe("p1", 0, "L1", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "total_with_mandatory_fees", amount_minor: 2_188_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [],
        },
      ],
    },
  },
  {
    domain,
    name: "untrusted_price_conflict",
    build: () => ({
      scenario: buildScenario({
        untrusted: [
          buildUntrustedContent({ content_id: "content-1", source: "listing_description", attached_to: "L2", author_role: "dealer", text: "Synthetic description: price negotiable, 18 000 EUR." }),
          buildUntrustedContent({ content_id: "content-2", source: "seller_message", attached_to: "L1", author_role: "dealer", text: "Synthetic message: 21 880 EUR including the mandatory fees." }),
        ],
        steps: [userMessage("Synthetic buyer: what do L2 and L1 cost?")],
      }),
      annotations: {
        probes: [buildProbe("p1", 0, "L2", "price"), buildProbe("p2", 0, "L1", "price")],
        planted: [
          plantedValue({ content_id: "content-1", listing_id: "L2", field: "price", value: 1_800_000 }),
          // Equals L1's accepted total: recorded, but not a conflicting candidate.
          plantedValue({ content_id: "content-2", listing_id: "L1", field: "price", value: 2_188_000 }),
        ],
      },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_899_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_938_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 1,
          superseded: [],
        },
        {
          probe_id: "p2",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 2_149_000 }, { basis: "total_with_mandatory_fees", amount_minor: 2_188_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [],
        },
      ],
    },
  },
  {
    domain,
    name: "superseded_price_history",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: [buildDealer("D1"), buildDealer("D2")], inventory: [buildListing("L1", { price_history: [{ price_minor: 2_249_000 }] }), buildListing("L2")] },
        steps: [userMessage("Synthetic buyer: what is the current price of L1?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L1", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 2_149_000 }, { basis: "total_with_mandatory_fees", amount_minor: 2_188_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [2_249_000],
        },
      ],
    },
  },
  {
    domain,
    name: "multiple_superseded_prices",
    build: () => ({
      scenario: buildScenario({
        trusted: {
          dealers: [buildDealer("D1"), buildDealer("D2")],
          inventory: [buildListing("L1"), buildListing("L2", { price_history: [{ price_minor: 2_099_000 }, { price_minor: 1_999_000 }, { price_minor: 2_099_000 }] })],
        },
        steps: [userMessage("Synthetic buyer: what is the current price of L2?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L2", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_899_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_938_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          // The repeated 2 099 000 is kept once, at its first occurrence.
          superseded: [2_099_000, 1_999_000],
        },
      ],
    },
  },
];
