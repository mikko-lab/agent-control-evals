/**
 * Truth access and preflight for the automotive evaluator.
 *
 * The evaluator never models authoritative vehicle state itself. Declared probes
 * use the committed `entry.expected`; any additional observed claim asks the same
 * oracle through one synthetic probe on a clone of the case, so every check uses
 * the truth source the golden corpus was built with. The only state the evaluator
 * replays itself is the minimum needed for event-delivery preconditions and stale
 * detection: authoritative versus delivered-to-SUT status and price, as the spec allows.
 */
import { canonicalJson } from "../../util/canonical-json";
import { AUTOMOTIVE_CORPUS_ENTRY_VERSION } from "../../spec/automotive/version";
import { deriveAutomotiveExpected } from "../../oracle/automotive/expected";
import type { ProbeExpectation } from "../../oracle/automotive/types";
import { automotiveFixtureProblems } from "../../corpus/automotive/builders";
import type { AutomotiveCase, InventoryEventStep, InventoryStatus, ProbeField } from "../../corpus/automotive/types";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import type { AutomotiveHarnessErrorRecord } from "./types";

const SYNTHETIC_PROBE_ID = "evaluator-truth";

/** Whether the inventory event at a scenario step was acknowledged by the adapter as delivered to the SUT. */
export type DeliveredPredicate = (eventStep: number) => boolean;

export interface DimensionReplay<V> {
  authoritative: V;
  delivered_to_sut: V;
  superseded_by_delivered: V[];
}

export class AutomotiveEvaluatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveEvaluatorError";
  }
}

/** Fixture + oracle-integrity preflight of one entry. null = clean. */
export function preflightEntry(entry: AutomotiveCorpusEntry): AutomotiveHarnessErrorRecord | null {
  const id = typeof entry?.case?.case_id === "string" ? entry.case.case_id : null;
  let problems: string[];
  try {
    if (entry.corpus_entry_version !== AUTOMOTIVE_CORPUS_ENTRY_VERSION) {
      problems = [`corpus_entry_version ${String(entry.corpus_entry_version)} != ${AUTOMOTIVE_CORPUS_ENTRY_VERSION}`];
    } else problems = automotiveFixtureProblems(entry.case);
  } catch (e) {
    problems = [`fixture could not be validated: ${(e as Error).message}`];
  }
  if (problems.length > 0) return { case_id: id, reason: "FIXTURE_INVALID", message: problems.join("; ") };
  let recomputed: unknown;
  try {
    recomputed = deriveAutomotiveExpected(entry.case);
  } catch (e) {
    return { case_id: id, reason: "ORACLE_INTEGRITY_ERROR", message: `oracle failed: ${(e as Error).message}` };
  }
  let same = false;
  try {
    same = canonicalJson(recomputed) === canonicalJson(entry.expected);
  } catch (e) {
    return { case_id: id, reason: "ORACLE_INTEGRITY_ERROR", message: `stored expectation is not canonical: ${(e as Error).message}` };
  }
  if (!same) return { case_id: id, reason: "ORACLE_INTEGRITY_ERROR", message: "stored expected output differs from the oracle's recomputation" };
  return null;
}

/** Per-case truth access with a cache for synthetic probes. */
export class CaseTruth {
  private readonly listings: ReadonlySet<string>;
  private readonly cache = new Map<string, ProbeExpectation>();

  constructor(readonly c: AutomotiveCase) {
    this.listings = new Set(c.scenario.trusted.inventory.map((l) => l.listing_id));
  }

  hasListing(id: string): boolean {
    return this.listings.has(id);
  }

  /**
   * Authoritative expectation for (step, listing, field), from the oracle via one synthetic probe on a clone.
   * The caller must have checked that the listing exists; the original case is never touched.
   */
  expectationFor(step: number, listing_id: string, field: ProbeField): ProbeExpectation {
    if (!this.hasListing(listing_id)) throw new AutomotiveEvaluatorError(`expectationFor: unknown listing ${listing_id}`);
    const key = `${step}|${listing_id}|${field}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const clone: AutomotiveCase = structuredClone(this.c);
    clone.annotations.probes = [{ probe_id: SYNTHETIC_PROBE_ID, step, listing_id, field }];
    const e = deriveAutomotiveExpected(clone).probe_expectations[0];
    this.cache.set(key, e);
    return e;
  }

  /** Inventory events strictly before `step` for a listing and one state dimension, in step order. */
  priorEvents(step: number, listing_id: string, dimension: "status" | "price"): { step: number; event: InventoryEventStep }[] {
    const out: { step: number; event: InventoryEventStep }[] = [];
    this.c.scenario.steps.forEach((s, i) => {
      if (i < step && s.op === "inventory_event" && s.listing_id === listing_id && s.change.kind === dimension) out.push({ step: i, event: s });
    });
    return out;
  }

  /**
   * Replays one state dimension of a listing up to (not including) `step`, twice and in parallel, from the
   * trusted initial value:
   *  - `authoritative`: every inventory event applied in step order (what the truth says now);
   *  - `delivered_to_sut`: only the events the adapter acknowledged as delivered, in step order (the state the
   *    SUT can actually know about).
   * A check that depends on this dimension is assessable exactly when the two agree at the check's step, so a
   * no-op event or an undelivered event that a later delivered event overrides does not block assessment.
   * `superseded_by_delivered` lists the values the delivered-to-SUT state held immediately before a delivered
   * event changed it (first-seen order): the only admissible witnesses for stale diagnostics. An undelivered
   * event never contributes one.
   */
  replay(step: number, listing_id: string, dimension: "status", isDelivered: DeliveredPredicate): DimensionReplay<InventoryStatus>;
  replay(step: number, listing_id: string, dimension: "price", isDelivered: DeliveredPredicate): DimensionReplay<number>;
  replay(step: number, listing_id: string, dimension: "status" | "price", isDelivered: DeliveredPredicate): DimensionReplay<InventoryStatus | number> {
    const l = this.listing(listing_id);
    const initial: InventoryStatus | number = dimension === "status" ? l.status : l.price_minor;
    let authoritative = initial;
    let delivered = initial;
    const superseded: (InventoryStatus | number)[] = [];
    for (const { step: at, event } of this.priorEvents(step, listing_id, dimension)) {
      const next = event.change.kind === "status" ? event.change.status : event.change.price_minor;
      authoritative = next;
      if (!isDelivered(at)) continue;
      if (next !== delivered && !superseded.includes(delivered)) superseded.push(delivered);
      delivered = next;
    }
    return { authoritative, delivered_to_sut: delivered, superseded_by_delivered: superseded };
  }

  /** Whether the dimension's authoritative state equals the delivered-to-SUT state at `step` (see `replay`). */
  deliveryConsistent(step: number, listing_id: string, dimension: "status" | "price", isDelivered: DeliveredPredicate): boolean {
    const r = dimension === "status" ? this.replay(step, listing_id, "status", isDelivered) : this.replay(step, listing_id, "price", isDelivered);
    return r.authoritative === r.delivered_to_sut;
  }

  /**
   * Trusted statuses the SUT was given that a later delivered status event replaced and that are not current again:
   * the STALE_STATUS witnesses. A status only an undelivered event produced is never among them.
   */
  staleStatuses(step: number, listing_id: string, isDelivered: DeliveredPredicate): InventoryStatus[] {
    const r = this.replay(step, listing_id, "status", isDelivered);
    return r.superseded_by_delivered.filter((s) => s !== r.delivered_to_sut);
  }

  /**
   * Prices the SUT was given that a later delivered price event replaced, per basis: the STALE_PRICE witnesses.
   * Fees are constant during a conversation in auto-0.1.0 (only listing prices change), so a pre-event total is
   * the pre-event listing price plus the listing's current fees. No historical fees are reconstructed.
   */
  stalePriceAmounts(step: number, listing_id: string, isDelivered: DeliveredPredicate): { listing_price: number[]; total_with_mandatory_fees: number[] } {
    const lp = this.replay(step, listing_id, "price", isDelivered).superseded_by_delivered;
    const fees = this.listing(listing_id).mandatory_fees_minor;
    return { listing_price: lp, total_with_mandatory_fees: lp.map((p) => p + fees) };
  }

  /**
   * Superseded listing prices known to the SUT at `step`: the trusted price history plus the delivered stale
   * witnesses. A price superseded only by an undelivered event is not among them.
   */
  supersededPricesKnownToSut(step: number, listing_id: string, isDelivered: DeliveredPredicate): number[] {
    const history = this.listing(listing_id).price_history.map((h) => h.price_minor);
    return [...new Set([...history, ...this.replay(step, listing_id, "price", isDelivered).superseded_by_delivered])];
  }

  private listing(id: string) {
    const l = this.c.scenario.trusted.inventory.find((x) => x.listing_id === id);
    if (!l) throw new AutomotiveEvaluatorError(`unknown listing ${id}`);
    return l;
  }
}
