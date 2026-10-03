/**
 * Truth access and preflight for the automotive evaluator.
 *
 * The evaluator never models authoritative vehicle state itself. Declared probes
 * use the committed `entry.expected`; any additional observed claim asks the same
 * oracle through one synthetic probe on a clone of the case, so every check uses
 * the truth source the golden corpus was built with. The only state the evaluator
 * replays itself is the minimum needed for event-delivery preconditions and stale
 * detection (which earlier events changed status or price), as the spec allows.
 */
import { canonicalJson } from "../../util/canonical-json";
import { AUTOMOTIVE_CORPUS_ENTRY_VERSION } from "../../spec/automotive/version";
import { deriveAutomotiveExpected } from "../../oracle/automotive/expected";
import type { ProbeExpectation } from "../../oracle/automotive/types";
import { automotiveFixtureProblems } from "../../corpus/automotive/builders";
import type { AutomotiveCase, InventoryEventStep, ProbeField } from "../../corpus/automotive/types";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import type { AutomotiveHarnessErrorRecord } from "./types";

const SYNTHETIC_PROBE_ID = "evaluator-truth";

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

  /** Whether an earlier status event for the listing actually changed its status (replayed from the trusted initial status). */
  hadStatusTransition(step: number, listing_id: string): boolean {
    let prev = this.listing(listing_id).status;
    for (const { event } of this.priorEvents(step, listing_id, "status")) {
      if (event.change.kind !== "status") continue;
      if (event.change.status !== prev) return true;
      prev = event.change.status;
    }
    return false;
  }

  /**
   * Prices that were current immediately before an earlier price event changed them, per basis. Fees are
   * constant during a conversation in auto-0.1.0 (only listing prices change), so a pre-event total is the
   * pre-event listing price plus the listing's current fees. No historical fees are reconstructed.
   */
  stalePriceAmounts(step: number, listing_id: string): { listing_price: number[]; total_with_mandatory_fees: number[] } {
    const l = this.listing(listing_id);
    let prev = l.price_minor;
    const lp: number[] = [];
    for (const { event } of this.priorEvents(step, listing_id, "price")) {
      if (event.change.kind !== "price") continue;
      if (event.change.price_minor !== prev) {
        if (!lp.includes(prev)) lp.push(prev);
        prev = event.change.price_minor;
      }
    }
    return { listing_price: lp, total_with_mandatory_fees: lp.map((p) => p + l.mandatory_fees_minor) };
  }

  private listing(id: string) {
    const l = this.c.scenario.trusted.inventory.find((x) => x.listing_id === id);
    if (!l) throw new AutomotiveEvaluatorError(`unknown listing ${id}`);
    return l;
  }
}
