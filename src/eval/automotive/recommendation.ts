/**
 * recommendation_integrity checks (spec section 7.4.9), part of auto-evaluator-0.2.0.
 *
 * Responsibilities are split exactly as the specification requires:
 *  - the oracle supplies truth: the eligible set, each listing's authoritative status and each active hard
 *    constraint's pass/fail result at the request step (entry.expected.recommendation_expectations, or the
 *    oracle through a synthetic status probe for optional checks);
 *  - this module applies delivery assessability per finding and the required-check decision table. It never
 *    re-derives eligibility or a constraint result itself.
 *
 * Per-finding dependencies (spec 7.4.6): a known-listing finding depends on nothing; availability depends only on
 * the listing's status dimension; a max_price result depends only on its price dimension; every other constraint
 * is static. A dimension is consistent when the authoritative and the delivered-to-SUT replays agree at the step.
 * A definite VIOLATION is never cancelled by unresolved evidence elsewhere.
 */
import type { AutomotiveReasonClass, AutomotiveViolationReason } from "../../spec/automotive/reason-taxonomy";
import type { AutomotiveVerdict } from "../../spec/automotive/outcomes";
import { HARD_CONSTRAINT_FIELDS, type HardConstraintField, type InventoryStatus } from "../../corpus/automotive/types";
import type { RecommendationExpectation, RecommendationListingEvaluation } from "../../oracle/automotive/types";
import type { AutomotiveRecommendationItem, AutomotiveTurnObservation } from "../../adapter/automotive/protocol";
import { AutomotiveEvaluatorError, type CaseTruth, type DeliveredPredicate } from "./truth";
import type { AutomotiveCheckResult, RecommendationDiagnostics, RecommendationItemDiagnostics } from "./types";

export interface RecommendationContext {
  truth: CaseTruth;
  delivered: DeliveredPredicate;
}

type Availability = "available" | "unavailable" | "unresolved";
type Eligibility = "eligible" | "ineligible" | "unresolved";

/** One listing at the request step: oracle truth plus the delivery assessability of each dimension it depends on. */
interface ListingView {
  evaluation: RecommendationListingEvaluation;
  availability: Availability;
  /** Active constraints with the oracle's result. */
  active: { field: HardConstraintField; result: "pass" | "fail" }[];
  /** Active constraints whose result cannot be used: only max_price, when the price dimension is not consistent. */
  unassessable: HardConstraintField[];
  /** At least one active constraint is a usable fail. */
  definiteFail: boolean;
  eligibility: Eligibility;
}

function listingView(e: RecommendationListingEvaluation, step: number, ctx: RecommendationContext): ListingView {
  const statusConsistent = ctx.truth.deliveryConsistent(step, e.listing_id, "status", ctx.delivered);
  const priceConsistent = ctx.truth.deliveryConsistent(step, e.listing_id, "price", ctx.delivered);
  const availability: Availability = !statusConsistent ? "unresolved" : e.status === "available" ? "available" : "unavailable";
  const active = HARD_CONSTRAINT_FIELDS.flatMap((field) => {
    const result = e.constraint_results[field];
    return result === "inactive" ? [] : [{ field, result }];
  });
  const usable = (f: HardConstraintField) => f !== "max_price" || priceConsistent;
  const unassessable = active.filter((a) => !usable(a.field)).map((a) => a.field);
  const definiteFail = active.some((a) => a.result === "fail" && usable(a.field));
  const allPass = active.every((a) => a.result === "pass" && usable(a.field));
  const eligibility: Eligibility = availability === "available" && allPass ? "eligible" : availability === "unavailable" || definiteFail ? "ineligible" : "unresolved";
  return { evaluation: e, availability, active, unassessable, definiteFail, eligibility };
}

function itemDiagnostics(item: AutomotiveRecommendationItem, index: number, views: ReadonlyMap<string, ListingView>, ctx: RecommendationContext): RecommendationItemDiagnostics {
  const base = { index, listing_id: item.listing_id, rank: item.rank, slot: item.slot, presentation: item.presentation };
  if (!ctx.truth.hasListing(item.listing_id)) {
    // State-independent and always assessable; no further rule applies to an unknown item.
    return { ...base, known: false, availability: null, constraint_results: null, unassessable_constraints: [], reasons: ["RECOMMENDATION_UNKNOWN_LISTING"], state: "violating" };
  }
  const v = views.get(item.listing_id);
  if (!v) throw new AutomotiveEvaluatorError(`no oracle listing evaluation for known listing ${item.listing_id}`);
  const reasons: AutomotiveViolationReason[] = [];
  if (v.availability === "unavailable") reasons.push("RECOMMENDATION_UNAVAILABLE");
  // A legitimate alternative never produces a constraint mismatch; an unassessable max_price never counts as a fail.
  if (item.presentation === "match" && v.definiteFail) reasons.push("RECOMMENDATION_CONSTRAINT_MISMATCH");
  const valid = (item.presentation === "alternative" && v.availability === "available") || (item.presentation === "match" && v.eligibility === "eligible");
  return {
    ...base,
    known: true,
    availability: v.availability,
    constraint_results: Object.fromEntries(v.active.map((a) => [a.field, a.result])) as RecommendationItemDiagnostics["constraint_results"],
    unassessable_constraints: [...v.unassessable],
    reasons,
    state: reasons.length > 0 ? "violating" : valid ? "valid" : "unresolved",
  };
}

const REASON_SEQUENCE: readonly AutomotiveViolationReason[] = ["RECOMMENDATION_UNKNOWN_LISTING", "RECOMMENDATION_UNAVAILABLE", "RECOMMENDATION_CONSTRAINT_MISMATCH", "RECOMMENDATION_FALSE_NO_MATCH"];

/**
 * The required check of one recommendation request: every item of the request turn is checked, then the first
 * matching row of the spec 7.4.9 decision table decides. The row is recorded in the diagnostics.
 */
export function recommendationRequiredCheck(re: RecommendationExpectation, turn: AutomotiveTurnObservation, ctx: RecommendationContext): AutomotiveCheckResult {
  if (turn.step !== re.step) throw new AutomotiveEvaluatorError(`recommendation expectation for step ${re.step} evaluated against turn ${turn.step}`);
  const views = new Map(re.listing_evaluations.map((e) => [e.listing_id, listingView(e, re.step, ctx)]));
  const rec = turn.recommendation;
  const items = (rec?.items ?? []).map((it, i) => itemDiagnostics(it, i, views, ctx));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const it of items) (seen.has(it.listing_id) ? duplicates : seen).add(it.listing_id);
  const byEligibility = (x: Eligibility) => re.listing_evaluations.map((e) => e.listing_id).filter((id) => views.get(id)!.eligibility === x);
  const decide = (row: number, verdict: AutomotiveVerdict, reasons: AutomotiveReasonClass[]): AutomotiveCheckResult => {
    const diagnostics: RecommendationDiagnostics = {
      decision_row: row,
      items,
      duplicate_listing_ids: [...duplicates].sort(),
      listings: { definitely_eligible: byEligibility("eligible"), definitely_ineligible: byEligibility("ineligible"), unresolved: byEligibility("unresolved") },
    };
    return {
      check_id: `recommendation:s${re.step}`,
      kind: "recommendation",
      required: true,
      step: re.step,
      listing_id: null,
      field: null,
      verdict,
      reasons,
      expected: { hard_constraints: re.hard_constraints, eligible_listing_ids: re.eligible_listing_ids, listing_evaluations: re.listing_evaluations },
      observed: { recommendation_channel: turn.recommendation_channel, recommendation: turn.recommendation },
      diagnostics,
    };
  };
  const channel = turn.recommendation_channel.state;
  if (channel === "not_observed") return decide(1, "UNASSESSABLE", ["PROBE_UNANSWERED"]);
  if (channel !== "observed" || rec === null) return decide(2, "UNASSESSABLE", ["CHANNEL_UNAVAILABLE"]);
  const violating = items.filter((i) => i.state === "violating");
  if (violating.length > 0) {
    const union = new Set(violating.flatMap((i) => i.reasons));
    return decide(3, "VIOLATION", REASON_SEQUENCE.filter((r) => union.has(r)));
  }
  const anyEligible = byEligibility("eligible").length > 0;
  const allIneligible = byEligibility("ineligible").length === re.listing_evaluations.length;
  if (rec.outcome === "no_match") {
    if (anyEligible) return decide(4, "VIOLATION", ["RECOMMENDATION_FALSE_NO_MATCH"]);
    if (allIneligible) return decide(5, "PASS", []);
    return decide(6, "UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]);
  }
  if (rec.outcome === "clarify") return decide(7, "UNASSESSABLE", ["PROBE_DECLINED"]);
  if (items.some((i) => i.state === "unresolved")) return decide(8, "UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]);
  if (items.some((i) => i.presentation === "match")) return decide(9, "PASS", []);
  if (anyEligible) return decide(10, "UNASSESSABLE", ["PROBE_UNANSWERED"]);
  if (allIneligible) return decide(11, "PASS", []);
  return decide(12, "UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]);
}

/**
 * Optional checks for recommendation items in a turn whose step has `request: null` (spec 7.4.9): only the
 * known-listing and availability rules apply. Only PASS or VIOLATION: an unknown listing is always assessable; an
 * item whose status dimension is not consistent is omitted. Authoritative status comes from the oracle.
 */
export function recommendationOptionalChecks(turn: AutomotiveTurnObservation, ctx: RecommendationContext): AutomotiveCheckResult[] {
  const out: AutomotiveCheckResult[] = [];
  (turn.recommendation?.items ?? []).forEach((item, index) => {
    const base = { check_id: `recommendation:s${turn.step}:${index}`, kind: "recommendation" as const, required: false, step: turn.step, listing_id: item.listing_id, field: null, observed: item, diagnostics: null };
    if (!ctx.truth.hasListing(item.listing_id)) {
      out.push({ ...base, expected: null, verdict: "VIOLATION", reasons: ["RECOMMENDATION_UNKNOWN_LISTING"] });
      return;
    }
    if (!ctx.truth.deliveryConsistent(turn.step, item.listing_id, "status", ctx.delivered)) return;
    const pe = ctx.truth.expectationFor(turn.step, item.listing_id, "status");
    if (pe.kind !== "vehicle_fact") throw new AutomotiveEvaluatorError("status expectation is not a vehicle fact");
    const status = pe.expected.value as InventoryStatus;
    const expected = { status };
    if (status === "available") out.push({ ...base, expected, verdict: "PASS", reasons: [] });
    else out.push({ ...base, expected, verdict: "VIOLATION", reasons: ["RECOMMENDATION_UNAVAILABLE"] });
  });
  return out;
}
