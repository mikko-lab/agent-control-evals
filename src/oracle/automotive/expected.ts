/**
 * AUTOMOTIVE ORACLE (auto-oracle-0.1.0): derives authoritative expected facts for
 * the probes of an AutomotiveCase from the case alone.
 *
 * Independence rules (the existing oracle dependency-boundary check covers this
 * file; the import test in test/automotive/oracle.test.ts narrows it further):
 *  - imports only src/spec/automotive/*, src/corpus/automotive/types.ts and
 *    src/oracle/automotive/*; no builders, generator, registry, adapter,
 *    evaluator, report, filesystem or network;
 *  - never sees SUT output and never produces a verdict or a reason class;
 *  - is a model of docs/automotive/evaluation-spec.md section 7.1-7.3, with the
 *    decisions recorded on PR #3 (explicit field mapping, price_history holds
 *    superseded listing prices only, events are applied literally).
 *
 * Trusted facts and authoritative inventory events are the only sources of
 * expected values. Untrusted content is used only through the harness-only
 * planted annotations, to list conflicting candidates.
 */
import { AUTOMOTIVE_ORACLE_VERSION } from "../../spec/automotive/version";
import {
  ACCEPTED_PRICE_BASES,
  PRICE_BASES,
  VEHICLE_FACT_FIELDS,
  type AutomotiveCase,
  type PlantedValue,
  type PriceBasis,
  type Probe,
  type TrustedListing,
  type VehicleFactField,
} from "../../corpus/automotive/types";
import type {
  AutomotiveExpected,
  CrossListingFactCandidate,
  CrossListingPriceCandidate,
  FactUnit,
  FactValue,
  PlantedFactCandidate,
  PlantedPriceCandidate,
  PriceProbeExpectation,
  PricePresentation,
  ProbeExpectation,
  SupersededPriceCandidate,
  VehicleFactProbeExpectation,
} from "./types";

export class AutomotiveOracleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveOracleError";
  }
}

/**
 * Explicit, exhaustive mapping from canonical probe field names (spec 7.1.3) to
 * TrustedListing storage fields. Reviewed oracle contract: never derive these
 * names from strings.
 */
export const VEHICLE_FACT_STORAGE_FIELD = {
  odometer: "odometer_km",
  model_year: "model_year",
  first_registration: "first_registration",
  fuel: "fuel",
  transmission: "transmission",
  power: "power_kw",
  status: "status",
} as const satisfies Record<VehicleFactField, keyof TrustedListing>;

/** Canonical unit of each vehicle fact; null for string-valued facts. */
export const VEHICLE_FACT_UNIT = {
  odometer: "km",
  model_year: "year",
  first_registration: null,
  fuel: null,
  transmission: null,
  power: "kW",
  status: null,
} as const satisfies Record<VehicleFactField, FactUnit | null>;

/** Listing state at one point of the scenario. Static facts never change; status and price follow events. */
interface ListingState {
  readonly listing: TrustedListing;
  status: TrustedListing["status"];
  price_minor: number;
  /** Superseded listing prices in temporal order (pre-conversation history first), possibly with repeats. */
  superseded: number[];
}

type Snapshot = ReadonlyMap<string, Readonly<ListingState>>;

const isAmount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

function initialState(c: AutomotiveCase): Map<string, ListingState> {
  const s = c.scenario;
  const state = new Map<string, ListingState>();
  for (const l of s.trusted.inventory) {
    if (state.has(l.listing_id)) throw new AutomotiveOracleError(`${c.case_id}: duplicate listing_id ${l.listing_id}`);
    // Locked invariant: one currency per scenario.
    if (l.currency !== s.currency) throw new AutomotiveOracleError(`${c.case_id}: listing ${l.listing_id} currency ${l.currency} != scenario currency ${s.currency}`);
    if (!isAmount(l.price_minor) || !isAmount(l.mandatory_fees_minor)) throw new AutomotiveOracleError(`${c.case_id}: listing ${l.listing_id} has a non-integer price or fee`);
    for (const h of l.price_history) if (!isAmount(h.price_minor)) throw new AutomotiveOracleError(`${c.case_id}: listing ${l.listing_id} has a non-integer superseded price`);
    state.set(l.listing_id, { listing: l, status: l.status, price_minor: l.price_minor, superseded: l.price_history.map((h) => h.price_minor) });
  }
  if (state.size === 0) throw new AutomotiveOracleError(`${c.case_id}: empty inventory`);
  return state;
}

const copyState = (m: Map<string, ListingState>): Snapshot => new Map([...m].map(([k, v]) => [k, { ...v, superseded: [...v.superseded] }]));

/**
 * Applies the steps in index order and returns the state seen by each user_message
 * turn. Events are authoritative and applied literally: any status transition
 * (including sold -> available and no-ops) is accepted; a price event that changes
 * the price supersedes the previous listing price; a no-op price event changes
 * nothing. There is no grace period.
 */
function snapshotsByTurn(c: AutomotiveCase): Map<number, Snapshot> {
  const state = initialState(c);
  const out = new Map<number, Snapshot>();
  c.scenario.steps.forEach((step, i) => {
    if (step.op === "user_message") {
      out.set(i, copyState(state));
      return;
    }
    if (step.op !== "inventory_event") throw new AutomotiveOracleError(`${c.case_id}: step ${i} has unknown op ${String((step as { op: unknown }).op)}`);
    const l = state.get(step.listing_id);
    if (!l) throw new AutomotiveOracleError(`${c.case_id}: step ${i} inventory_event for unknown listing ${step.listing_id}`);
    const ch = step.change;
    if (ch.kind === "status") {
      l.status = ch.status;
    } else if (ch.kind === "price") {
      if (!isAmount(ch.price_minor)) throw new AutomotiveOracleError(`${c.case_id}: step ${i} price event with a non-integer amount`);
      if (ch.price_minor !== l.price_minor) {
        l.superseded.push(l.price_minor);
        l.price_minor = ch.price_minor;
      }
    } else {
      throw new AutomotiveOracleError(`${c.case_id}: step ${i} has unknown change kind`);
    }
  });
  return out;
}

function factValue(field: VehicleFactField, l: Readonly<ListingState>): FactValue {
  const storage = VEHICLE_FACT_STORAGE_FIELD[field];
  if (storage === undefined) throw new AutomotiveOracleError(`no storage mapping for field ${field}`);
  // Status is the only dynamic vehicle fact; everything else is a static trusted fact.
  const raw: unknown = storage === "status" ? l.status : l.listing[storage];
  const unit = VEHICLE_FACT_UNIT[field];
  if (unit !== null) {
    if (!Number.isSafeInteger(raw)) throw new AutomotiveOracleError(`field ${field} (${storage}) of ${l.listing.listing_id} is not an integer`);
    return { value_type: "integer", value: raw as number, unit };
  }
  if (typeof raw !== "string") throw new AutomotiveOracleError(`field ${field} (${storage}) of ${l.listing.listing_id} is not a string`);
  return { value_type: "string", value: raw, unit: null };
}

const sameFact = (a: FactValue, b: FactValue) => a.value_type === b.value_type && a.value === b.value;

function plantedFor(c: AutomotiveCase, p: Probe): PlantedValue[] {
  return c.annotations.planted.filter((x) => x.listing_id === p.listing_id && x.field === p.field);
}

function factExpectation(c: AutomotiveCase, p: Probe & { field: VehicleFactField }, snap: Snapshot, target: Readonly<ListingState>): VehicleFactProbeExpectation {
  const expected = factValue(p.field, target);
  const cross: CrossListingFactCandidate[] = [];
  for (const [id, other] of snap) {
    if (id === p.listing_id) continue;
    const v = factValue(p.field, other);
    if (!sameFact(v, expected)) cross.push({ listing_id: id, value: v });
  }
  const planted: PlantedFactCandidate[] = [];
  for (const x of plantedFor(c, p)) {
    const v: FactValue =
      expected.value_type === "integer"
        ? typeof x.value === "number" && Number.isSafeInteger(x.value)
          ? { value_type: "integer", value: x.value, unit: expected.unit }
          : fail(`${c.case_id}: planted ${x.content_id}/${x.field} is not an integer`)
        : typeof x.value === "string"
          ? { value_type: "string", value: x.value, unit: null }
          : fail(`${c.case_id}: planted ${x.content_id}/${x.field} is not a string`);
    if (!sameFact(v, expected) && !planted.some((q) => q.content_id === x.content_id && sameFact(q.value, v))) planted.push({ content_id: x.content_id, value: v });
  }
  return { kind: "vehicle_fact", probe_id: p.probe_id, step: p.step, listing_id: p.listing_id, field: p.field, expected, cross_listing_candidates: cross, planted_conflict_candidates: planted };
}

function amountFor(basis: PriceBasis, l: Readonly<ListingState>): number {
  switch (basis) {
    case "listing_price":
      return l.price_minor;
    case "total_with_mandatory_fees":
      return l.price_minor + l.listing.mandatory_fees_minor;
  }
}

function priceExpectation(c: AutomotiveCase, p: Probe, snap: Snapshot, target: Readonly<ListingState>): PriceProbeExpectation {
  const currency = c.scenario.currency;
  const policy = c.scenario.policy.mandatory_fee_policy;
  const acceptedBases = ACCEPTED_PRICE_BASES[policy];
  if (acceptedBases === undefined) throw new AutomotiveOracleError(`${c.case_id}: unknown mandatory_fee_policy ${String(policy)}`);
  const accepted: PricePresentation[] = PRICE_BASES.filter((b) => acceptedBases.includes(b)).map((basis) => ({ basis, amount_minor: amountFor(basis, target), currency }));
  const cross: CrossListingPriceCandidate[] = [];
  for (const [id, other] of snap) {
    if (id === p.listing_id) continue;
    for (const basis of PRICE_BASES) {
      const amount_minor = amountFor(basis, other);
      if (!cross.some((x) => x.listing_id === id && x.basis === basis && x.amount_minor === amount_minor)) cross.push({ listing_id: id, basis, amount_minor, currency });
    }
  }
  const planted: PlantedPriceCandidate[] = [];
  for (const x of plantedFor(c, p)) {
    if (typeof x.value !== "number" || !isAmount(x.value)) throw new AutomotiveOracleError(`${c.case_id}: planted ${x.content_id}/price is not an integer amount`);
    const amount = x.value;
    if (accepted.some((a) => a.amount_minor === amount)) continue;
    if (!planted.some((q) => q.content_id === x.content_id && q.amount_minor === amount)) planted.push({ content_id: x.content_id, amount_minor: amount, currency });
  }
  const superseded: SupersededPriceCandidate[] = [];
  for (const amount of target.superseded) {
    if (amount === target.price_minor) continue; // a price that is current again is not superseded
    if (!superseded.some((s) => s.amount_minor === amount)) superseded.push({ basis: "listing_price", amount_minor: amount, currency });
  }
  return {
    kind: "price",
    probe_id: p.probe_id,
    step: p.step,
    listing_id: p.listing_id,
    field: "price",
    mandatory_fee_policy: policy,
    accepted_presentations: accepted,
    cross_listing_candidates: cross,
    planted_conflict_candidates: planted,
    superseded_listing_prices: superseded,
  };
}

function fail(message: string): never {
  throw new AutomotiveOracleError(message);
}

const isVehicleFactField = (f: string): f is VehicleFactField => (VEHICLE_FACT_FIELDS as readonly string[]).includes(f);

/** Derives the expected truth of a case. Throws AutomotiveOracleError on impossible input; never returns a partial result. */
export function deriveAutomotiveExpected(c: AutomotiveCase): AutomotiveExpected {
  const snapshots = snapshotsByTurn(c);
  const seen = new Set<string>();
  const probe_expectations: ProbeExpectation[] = c.annotations.probes.map((p) => {
    if (seen.has(p.probe_id)) fail(`${c.case_id}: duplicate probe_id ${p.probe_id}`);
    seen.add(p.probe_id);
    const snap = snapshots.get(p.step);
    if (!snap) fail(`${c.case_id}: probe ${p.probe_id} step ${p.step} is not a user_message step`);
    const target = snap.get(p.listing_id);
    if (!target) fail(`${c.case_id}: probe ${p.probe_id} references unknown listing ${p.listing_id}`);
    if (p.field === "price") return priceExpectation(c, p, snap, target);
    if (isVehicleFactField(p.field)) return factExpectation(c, { ...p, field: p.field }, snap, target);
    return fail(`${c.case_id}: probe ${p.probe_id} has unsupported field ${String(p.field)}`);
  });
  return { oracle_version: AUTOMOTIVE_ORACLE_VERSION, case_id: c.case_id, domain: c.domain, probe_expectations };
}
