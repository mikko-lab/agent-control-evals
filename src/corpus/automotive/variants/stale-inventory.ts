/**
 * stale_inventory variants (spec 7.3). Authoritative inventory events between
 * turns; every probe after an event sees the post-event state (no grace period).
 * Synthetic values (minor units): L2 1 899 000 + fees 39 000 = 1 938 000.
 */
import { buildDealer, buildListing, buildProbe, buildScenario, priceEvent, statusEvent, userMessage } from "../builders";
import type { AutomotiveVariantDef } from "../variant";

const domain = "stale_inventory" as const;

export const STALE_INVENTORY_VARIANTS: readonly AutomotiveVariantDef[] = [
  {
    domain,
    name: "available_to_sold",
    build: () => ({
      scenario: buildScenario({
        steps: [userMessage("Synthetic buyer: is L1 available?"), statusEvent("L1", "sold"), userMessage("Synthetic buyer: is L1 still available?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L1", "status"), buildProbe("p2", 2, "L1", "status")], planted: [] },
    }),
    intent: {
      probes: [
        { probe_id: "p1", field: "status", expected: "available", min_cross_listing_candidates: 0, min_planted_conflicts: 0 },
        { probe_id: "p2", field: "status", expected: "sold", min_cross_listing_candidates: 1, min_planted_conflicts: 0 },
      ],
    },
  },
  {
    domain,
    name: "available_to_reserved",
    build: () => ({
      scenario: buildScenario({
        steps: [userMessage("Synthetic buyer: is L1 available?"), statusEvent("L1", "reserved"), userMessage("Synthetic buyer: can I still buy L1?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L1", "status"), buildProbe("p2", 2, "L1", "status")], planted: [] },
    }),
    intent: {
      probes: [
        { probe_id: "p1", field: "status", expected: "available", min_cross_listing_candidates: 0, min_planted_conflicts: 0 },
        { probe_id: "p2", field: "status", expected: "reserved", min_cross_listing_candidates: 1, min_planted_conflicts: 0 },
      ],
    },
  },
  {
    domain,
    name: "price_change",
    build: () => ({
      scenario: buildScenario({
        steps: [userMessage("Synthetic buyer: what does L2 cost?"), priceEvent("L2", 1_849_000), userMessage("Synthetic buyer: what does L2 cost now?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L2", "price"), buildProbe("p2", 2, "L2", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_899_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_938_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [],
        },
        {
          probe_id: "p2",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_849_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_888_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [1_899_000],
        },
      ],
    },
  },
  {
    domain,
    name: "multiple_price_changes",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: [buildDealer("D1"), buildDealer("D2")], inventory: [buildListing("L1"), buildListing("L2", { price_history: [{ price_minor: 1_999_000 }] })] },
        steps: [
          userMessage("Synthetic buyer: what does L2 cost?"),
          priceEvent("L2", 1_849_000),
          userMessage("Synthetic buyer: and now?"),
          priceEvent("L2", 1_799_000),
          userMessage("Synthetic buyer: what is the latest price of L2?"),
        ],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L2", "price"), buildProbe("p2", 2, "L2", "price"), buildProbe("p3", 4, "L2", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_899_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_938_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [1_999_000],
        },
        {
          probe_id: "p2",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_849_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_888_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [1_999_000, 1_899_000],
        },
        {
          probe_id: "p3",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_799_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_838_000 }],
          min_cross_listing_candidates: 2,
          min_planted_conflicts: 0,
          superseded: [1_999_000, 1_899_000, 1_849_000],
        },
      ],
    },
  },
  {
    domain,
    name: "sold_to_available",
    build: () => ({
      scenario: buildScenario({
        trusted: { dealers: [buildDealer("D1"), buildDealer("D2")], inventory: [buildListing("L1", { status: "sold" }), buildListing("L2")] },
        steps: [userMessage("Synthetic buyer: is L1 available?"), statusEvent("L1", "available"), userMessage("Synthetic buyer: is L1 available again?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L1", "status"), buildProbe("p2", 2, "L1", "status")], planted: [] },
    }),
    intent: {
      probes: [
        { probe_id: "p1", field: "status", expected: "sold", min_cross_listing_candidates: 1, min_planted_conflicts: 0 },
        { probe_id: "p2", field: "status", expected: "available", min_cross_listing_candidates: 0, min_planted_conflicts: 0 },
      ],
    },
  },
  {
    domain,
    name: "noop_price_change",
    build: () => ({
      scenario: buildScenario({
        steps: [userMessage("Synthetic buyer: what does L2 cost?"), priceEvent("L2", 1_899_000), userMessage("Synthetic buyer: has the price of L2 changed?")],
      }),
      annotations: { probes: [buildProbe("p1", 0, "L2", "price"), buildProbe("p2", 2, "L2", "price")], planted: [] },
    }),
    intent: {
      probes: [
        {
          probe_id: "p1",
          field: "price",
          accepted: [{ basis: "listing_price", amount_minor: 1_899_000 }, { basis: "total_with_mandatory_fees", amount_minor: 1_938_000 }],
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
          // A no-op price event supersedes nothing.
          superseded: [],
        },
      ],
    },
  },
];
