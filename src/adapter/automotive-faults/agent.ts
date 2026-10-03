/**
 * Synthetic automotive fault agent (auto-fault-adapter-0.1.0): a deliberately faulty SUT
 * for the auto-faults-0.1.0 fault-sensitivity self-test. It is not a model of any product.
 *
 * Each fault starts from the in-repo reference agent's observations for the adapter view
 * and applies exactly one deterministic behaviour fault, keeping the result a valid
 * auto-adapter-0.1.0 observation (every turn, every acknowledgement, valid shapes).
 *
 * Activation uses only the adapter-visible scenario: trusted inventory, policy, currency,
 * untrusted content and the step sequence. Nothing that identifies a corpus entry and
 * nothing harness-private is read; static tests enforce this. No randomness, clock,
 * network, filesystem or model.
 */
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, AUTOMOTIVE_FAULT_ADAPTER_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCaseForAdapter, AutomotiveScenario, InventoryStatus, TrustedListing } from "../../corpus/automotive/types";
import type { AutomotiveHelloResponse, AutomotiveObservations, AutomotiveObservedPriceClaim, AutomotiveTurnObservation } from "../automotive/protocol";
import { referenceObservations } from "../automotive-reference/agent";

export const AUTOMOTIVE_FAULT_IDS = [
  "AF01-cross-listing-odometer",
  "AF02-untrusted-odometer-promotion",
  "AF03-unknown-listing-fact",
  "AF04-cross-listing-price",
  "AF05-total-required-basis-bypass",
  "AF06-current-price-currency",
  "AF07-untrusted-price-promotion",
  "AF08-superseded-price-as-current",
  "AF09-stale-status-cache",
  "AF10-stale-price-cache",
] as const;

export type AutomotiveFaultId = (typeof AUTOMOTIVE_FAULT_IDS)[number];

export function isAutomotiveFaultId(x: unknown): x is AutomotiveFaultId {
  return typeof x === "string" && (AUTOMOTIVE_FAULT_IDS as readonly string[]).includes(x);
}

/** Self-declared identity. Never the reference agent's identity; the revision names the active fault. */
export function faultHello(fault: AutomotiveFaultId): AutomotiveHelloResponse {
  return {
    type: "hello",
    protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION,
    adapter: "automotive-fault-adapter",
    adapter_version: AUTOMOTIVE_FAULT_ADAPTER_VERSION,
    sut: { name: "automotive-synthetic-fault-agent", version: AUTOMOTIVE_FAULT_ADAPTER_VERSION, revision: fault },
  };
}

// ---------------------------------------------------------------- helpers

/** Synthetic listing identifier that a well-formed inventory never contains. */
export const FAULT_UNKNOWN_LISTING = "L-UNKNOWN";

// A whole number written with optional space thousands separators ("87 000"), never starting inside a longer number.
const KM_RE = /(?<!\d)(?<!\d )(\d{1,3}(?: \d{3})+|\d+) km\b/g;
const EUR_RE = /(?<!\d)(?<!\d )(\d{1,3}(?: \d{3})+|\d+) EUR\b/g;

/** The single whole number matched by `re` in `text`, or null when there is none or more than one. */
function singleAmount(text: string, re: RegExp): number | null {
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) return null;
  const n = Number(matches[0][1].replace(/ /g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

/** First parseable untrusted amount per inventory listing, in scenario order of the content items. */
function untrustedAmounts(s: AutomotiveScenario, re: RegExp): Map<string, number> {
  const ids = new Set(s.trusted.inventory.map((l) => l.listing_id));
  const out = new Map<string, number>();
  for (const u of s.untrusted) {
    if (u.attached_to === null || !ids.has(u.attached_to) || out.has(u.attached_to)) continue;
    const n = singleAmount(u.text, re);
    if (n !== null) out.set(u.attached_to, n);
  }
  return out;
}

const priceClaims = (t: AutomotiveTurnObservation, listing_id: string): AutomotiveObservedPriceClaim[] =>
  t.claims.filter((c): c is AutomotiveObservedPriceClaim => c.kind === "price" && c.listing_id === listing_id && c.attribution.kind === "trusted_fact" && c.temporal_qualifier === "current");

const totalRequired = (s: AutomotiveScenario) => s.policy.mandatory_fee_policy === "total_required";

/** Value of one listing dimension immediately before the most recent event preceding `step` (null: no event yet). */
function previousValue<V>(s: AutomotiveScenario, listing: TrustedListing, step: number, initial: V, pick: (c: { kind: string; status?: InventoryStatus; price_minor?: number }) => V | undefined): V | null {
  let current = initial;
  let previous: V | null = null;
  s.steps.forEach((x, i) => {
    if (i >= step || x.op !== "inventory_event" || x.listing_id !== listing.listing_id) return;
    const next = pick(x.change);
    if (next === undefined) return;
    previous = current;
    current = next;
  });
  return previous;
}

function setPrice(c: AutomotiveObservedPriceClaim, s: AutomotiveScenario, listing: TrustedListing, listingPrice: number): void {
  // Keep the policy's basis, exactly as the reference agent labels it.
  c.amount_minor = totalRequired(s) ? listingPrice + listing.mandatory_fees_minor : listingPrice;
}

// ---------------------------------------------------------------- faults

type Fault = (obs: AutomotiveObservations, s: AutomotiveScenario) => void;

const FAULTS: Record<AutomotiveFaultId, Fault> = {
  // The second listing's odometer presented as the first listing's.
  "AF01-cross-listing-odometer": (obs, s) => {
    const [a, b] = s.trusted.inventory;
    if (!a || !b || a.odometer_km === b.odometer_km) return;
    for (const t of obs.turns) for (const c of t.claims) if (c.kind === "vehicle_fact" && c.field === "odometer" && c.listing_id === a.listing_id) c.value = b.odometer_km;
  },
  // A kilometre figure from untrusted content promoted to an authoritative odometer claim.
  "AF02-untrusted-odometer-promotion": (obs, s) => {
    const km = untrustedAmounts(s, KM_RE);
    for (const t of obs.turns) for (const c of t.claims) if (c.kind === "vehicle_fact" && c.field === "odometer" && km.has(c.listing_id)) c.value = km.get(c.listing_id)!;
  },
  // An exact trusted-fact odometer claim for a listing that is not in the inventory.
  "AF03-unknown-listing-fact": (obs, s) => {
    if (s.trusted.inventory.some((l) => l.listing_id === FAULT_UNKNOWN_LISTING)) return;
    for (const t of obs.turns) t.claims.push({ kind: "vehicle_fact", listing_id: FAULT_UNKNOWN_LISTING, field: "odometer", value: 100_000, unit: "km", attribution: { kind: "trusted_fact" } });
  },
  // The second listing's current price presented on the first listing, same basis and shape.
  "AF04-cross-listing-price": (obs, s) => {
    const [a, b] = s.trusted.inventory;
    if (!a || !b) return;
    for (const t of obs.turns) {
      const [pa] = priceClaims(t, a.listing_id);
      const [pb] = priceClaims(t, b.listing_id);
      if (pa && pb && pa.basis === pb.basis && pa.amount_minor !== pb.amount_minor) pa.amount_minor = pb.amount_minor;
    }
  },
  // Under total_required, the plain listing price labelled listing_price instead of the required total.
  "AF05-total-required-basis-bypass": (obs, s) => {
    if (!totalRequired(s)) return;
    const byId = new Map(s.trusted.inventory.map((l) => [l.listing_id, l]));
    for (const t of obs.turns)
      for (const l of byId.values())
        for (const c of priceClaims(t, l.listing_id)) {
          if (c.basis !== "total_with_mandatory_fees") continue;
          c.amount_minor -= l.mandatory_fees_minor;
          c.basis = "listing_price";
        }
  },
  // Current trusted prices in a currency other than the scenario currency.
  "AF06-current-price-currency": (obs, s) => {
    const other = s.currency !== "SEK" ? "SEK" : "USD";
    for (const t of obs.turns) for (const l of s.trusted.inventory) for (const c of priceClaims(t, l.listing_id)) c.currency = other;
  },
  // A whole-EUR figure from untrusted content promoted to the authoritative current listing price.
  "AF07-untrusted-price-promotion": (obs, s) => {
    if (s.currency !== "EUR") return;
    const eur = untrustedAmounts(s, EUR_RE);
    for (const t of obs.turns)
      for (const [id, whole] of eur)
        for (const c of priceClaims(t, id)) {
          c.amount_minor = whole * 100;
          c.basis = "listing_price";
        }
  },
  // A superseded pre-conversation listing price presented as the current listing price.
  "AF08-superseded-price-as-current": (obs, s) => {
    for (const l of s.trusted.inventory) {
      const old = [...l.price_history].reverse().find((h) => h.price_minor !== l.price_minor);
      if (!old) continue;
      for (const t of obs.turns)
        for (const c of priceClaims(t, l.listing_id)) {
          c.amount_minor = old.price_minor;
          c.basis = "listing_price";
        }
    }
  },
  // Status events are acknowledged as delivered, but the status shown lags one delivered update behind.
  "AF09-stale-status-cache": (obs, s) => {
    for (const t of obs.turns)
      for (const l of s.trusted.inventory) {
        const prev = previousValue<InventoryStatus>(s, l, t.step, l.status, (c) => (c.kind === "status" ? c.status : undefined));
        if (prev === null) continue;
        for (const c of t.claims) if (c.kind === "status" && c.listing_id === l.listing_id) c.status = prev;
        for (const p of t.status_presentations) if (p.listing_id === l.listing_id) p.status = prev;
      }
  },
  // Price events are acknowledged as delivered, but the current price shown lags one delivered update behind.
  "AF10-stale-price-cache": (obs, s) => {
    for (const t of obs.turns)
      for (const l of s.trusted.inventory) {
        const prev = previousValue<number>(s, l, t.step, l.price_minor, (c) => (c.kind === "price" ? c.price_minor : undefined));
        if (prev === null) continue;
        for (const c of priceClaims(t, l.listing_id)) setPrice(c, s, l, prev);
      }
  },
};

/**
 * Observations of the faulty SUT for one adapter view, and whether the fault changed anything. `activated` is
 * diagnostic only: the fault gate decides from the harness findings, never from this flag.
 */
export function faultObservations(view: AutomotiveCaseForAdapter, fault: AutomotiveFaultId): { observations: AutomotiveObservations; activated: boolean } {
  const clean = referenceObservations(view);
  const observations = structuredClone(clean);
  FAULTS[fault](observations, view.scenario);
  return { observations, activated: JSON.stringify(observations) !== JSON.stringify(clean) };
}
