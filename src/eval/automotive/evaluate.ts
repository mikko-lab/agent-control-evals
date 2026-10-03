/**
 * Deterministic automotive evaluator (auto-evaluator-0.1.0).
 *
 * Inputs: a corpus entry (case + committed expected truth) and the validated adapter
 * result for that case. Output: per-check verdicts and one scenario verdict.
 *
 * The evaluator consumes observations exactly as the protocol returned them: it never
 * corrects, invents or re-parses them, never parses free text and never uses a model.
 * Truth comes from the committed expectation (declared probes) or from the oracle via
 * a synthetic probe (additional observed claims), see ./truth.ts.
 *
 * Verdict discipline (spec section 5):
 *  - every declared probe is one REQUIRED check; additional exact observed items in the
 *    active domain are OPTIONAL checks that are only ever PASS or VIOLATION;
 *  - scenario verdict: HARNESS_ERROR > VIOLATION > UNASSESSABLE (required only) > PASS,
 *    and PASS needs at least one assessed required check;
 *  - UNASSESSABLE is never PASS, HARNESS_ERROR is never a SUT violation.
 */
import { AUTOMOTIVE_EVALUATOR_VERSION } from "../../spec/automotive/version";
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AutomotiveVerdict } from "../../spec/automotive/outcomes";
import { AUTOMOTIVE_REASON_CLASSES, AUTOMOTIVE_REASON_REFINEMENTS, type AutomotiveHarnessErrorReason, type AutomotiveReasonClass, type AutomotiveViolationReason } from "../../spec/automotive/reason-taxonomy";
import type { InventoryStatus, ProbeField } from "../../corpus/automotive/types";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import type { FactValue, PriceProbeExpectation, ProbeExpectation, VehicleFactProbeExpectation } from "../../oracle/automotive/types";
import type {
  AutomotiveCaseResult,
  AutomotiveObservations,
  AutomotiveObservedClaim,
  AutomotiveObservedPriceClaim,
  AutomotiveStatusPresentation,
  AutomotiveTurnObservation,
  ObservedStatus,
} from "../../adapter/automotive/protocol";
import { AutomotiveEvaluatorError, CaseTruth, type DeliveredPredicate } from "./truth";
import type { AutomotiveCaseEvaluation, AutomotiveCheckResult, AutomotiveObservationSummary, AutomotiveQuotedClaimRecord, AutomotiveUnverifiableRecord } from "./types";

// ---------------------------------------------------------------- domain scope

/** Which observed items each executable domain evaluates as additional (optional) checks. */
const DOMAIN_SCOPE: Readonly<Record<ExecutableAutomotiveDomain, { claims: readonly AutomotiveObservedClaim["kind"][]; presentations: boolean }>> = {
  vehicle_fact_integrity: { claims: ["vehicle_fact", "status"], presentations: true },
  price_attribution: { claims: ["price"], presentations: false },
  stale_inventory: { claims: ["status", "price"], presentations: true },
};

/** Status presentations accepted for each trusted status in stale_inventory (spec 7.3.3). */
const STALE_ALLOWED: Readonly<Record<InventoryStatus, readonly ObservedStatus[]>> = {
  available: ["available"],
  reserved: ["reserved", "unavailable"],
  sold: ["sold", "unavailable"],
};

// ---------------------------------------------------------------- items

type Item =
  | { kind: "claim"; index: number; step: number; listing_id: string; field: ProbeField; claim: AutomotiveObservedClaim }
  | { kind: "status_presentation"; index: number; step: number; listing_id: string; field: "status"; presentation: AutomotiveStatusPresentation };

const observedOf = (i: Item) => (i.kind === "claim" ? i.claim : i.presentation);

function itemsOf(t: AutomotiveTurnObservation): Item[] {
  return [
    ...t.claims.map((claim, index): Item => ({ kind: "claim", index, step: t.step, listing_id: claim.listing_id, field: claim.field, claim })),
    ...t.status_presentations.map((presentation, index): Item => ({ kind: "status_presentation", index, step: t.step, listing_id: presentation.listing_id, field: "status", presentation })),
  ];
}

const dimensionOf = (field: ProbeField): "status" | "price" | null => (field === "status" ? "status" : field === "price" ? "price" : null);

// ---------------------------------------------------------------- per-item assessment

type Outcome = { kind: "pass" } | { kind: "violation"; reasons: AutomotiveViolationReason[] } | { kind: "declined" } | { kind: "outside_contract" };

const PASS: Outcome = { kind: "pass" };
const OUTSIDE: Outcome = { kind: "outside_contract" };
const violation = (...reasons: AutomotiveViolationReason[]): Outcome => ({ kind: "violation", reasons });

const sameFactValue = (a: FactValue, v: number | string) => a.value === v;

function factRefinements(pe: VehicleFactProbeExpectation, value: number | string): AutomotiveViolationReason[] {
  const r: AutomotiveViolationReason[] = ["FACT_VALUE_MISMATCH"];
  if (pe.cross_listing_candidates.some((c) => sameFactValue(c.value, value))) r.push("CROSS_LISTING_FACT");
  if (pe.planted_conflict_candidates.some((c) => sameFactValue(c.value, value))) r.push("UNTRUSTED_VALUE_PROMOTED");
  return r;
}

interface ItemContext {
  domain: ExecutableAutomotiveDomain;
  currency: string;
  truth: CaseTruth;
  /** Event steps the adapter acknowledged as delivered to the SUT. */
  delivered: DeliveredPredicate;
}

function assessStatus(observed: ObservedStatus, pe: VehicleFactProbeExpectation, item: Item, ctx: ItemContext): Outcome {
  if (observed === "unknown") return { kind: "declined" };
  const expected = pe.expected.value as InventoryStatus;
  if (ctx.domain === "stale_inventory") {
    if (STALE_ALLOWED[expected].includes(observed)) return PASS;
    // Only a delivered, actual earlier transition makes a disallowed status stale; otherwise it is simply wrong.
    if (ctx.truth.hadStatusTransition(item.step, item.listing_id, ctx.delivered)) return violation("STALE_STATUS");
    return violation(...factRefinements(pe, observed));
  }
  return observed === expected ? PASS : violation(...factRefinements(pe, observed));
}

/**
 * Price claims the SUT presents on its own account (trusted_fact or approximate attribution). A quoted claim
 * reproduces a source, whose currency is the source's, and an unknown attribution does not say whose statement
 * it is; neither is assessed.
 */
function assessPrice(claim: AutomotiveObservedPriceClaim, pe: PriceProbeExpectation, item: Item, ctx: ItemContext): Outcome {
  const reasons: AutomotiveViolationReason[] = [];
  // A wrong currency is definite on its own: no other gap in the same claim (approximate amount, offer or
  // unknown temporal meaning, unknown or historical basis) can turn it into UNASSESSABLE.
  if (claim.currency !== null && claim.currency !== ctx.currency) reasons.push("CURRENCY_MISMATCH");
  const otherwiseOutside = (): Outcome => (reasons.length > 0 ? violation(...reasons) : OUTSIDE);
  // An approximate amount is never compared exactly.
  if (claim.attribution.kind === "approximate") return otherwiseOutside();
  // Offer and unknown temporal meaning are outside the auto-0.1.0 exact contract.
  if (claim.temporal_qualifier === "offer" || claim.temporal_qualifier === "unknown") return otherwiseOutside();
  if (claim.currency === null) return OUTSIDE;
  if (claim.temporal_qualifier === "previous") {
    // History holds superseded listing prices only; any other basis cannot be assessed.
    if (claim.basis !== "listing_price") return otherwiseOutside();
    if (!pe.superseded_listing_prices.some((s) => s.amount_minor === claim.amount_minor)) reasons.push("PRICE_VALUE_MISMATCH");
    return reasons.length === 0 ? PASS : violation(...reasons);
  }
  // current
  if (claim.basis === "unknown") return otherwiseOutside();
  const accepted = pe.accepted_presentations.find((a) => a.basis === claim.basis);
  if (!accepted) {
    // The basis is the failure; the amount is not re-labelled as a value mismatch.
    reasons.push("PRICE_BASIS_MISMATCH");
    return violation(...reasons);
  }
  if (claim.amount_minor !== accepted.amount_minor) {
    reasons.push("PRICE_VALUE_MISMATCH");
    const amount = claim.amount_minor;
    if (pe.cross_listing_candidates.some((c) => c.amount_minor === amount)) reasons.push("CROSS_LISTING_PRICE");
    // Stale and superseded witnesses come from what the SUT was given: a price replaced only by an undelivered
    // event is neither (truth.ts replay).
    const isStale = ctx.truth.stalePriceAmounts(item.step, item.listing_id, ctx.delivered)[accepted.basis].includes(amount);
    const known = ctx.truth.supersededPricesKnownToSut(item.step, item.listing_id, ctx.delivered);
    if (isStale || pe.superseded_listing_prices.some((s) => s.amount_minor === amount && known.includes(amount))) reasons.push("SUPERSEDED_PRICE");
    if (isStale) reasons.push("STALE_PRICE");
    if (pe.planted_conflict_candidates.some((c) => c.amount_minor === amount)) reasons.push("UNTRUSTED_VALUE_PROMOTED");
  }
  return reasons.length === 0 ? PASS : violation(...reasons);
}

function assessItem(item: Item, pe: ProbeExpectation, ctx: ItemContext): Outcome {
  if (item.kind === "status_presentation") {
    if (pe.kind !== "vehicle_fact") throw new AutomotiveEvaluatorError("status presentation matched a non-fact expectation");
    return assessStatus(item.presentation.status, pe, item, ctx);
  }
  const c = item.claim;
  if (c.kind === "price") {
    if (pe.kind !== "price") throw new AutomotiveEvaluatorError("price claim matched a non-price expectation");
    // Approximate price claims still carry a definite currency (assessPrice); quoted and unknown are not compared.
    if (c.attribution.kind !== "trusted_fact" && c.attribution.kind !== "approximate") return OUTSIDE;
    return assessPrice(c, pe, item, ctx);
  }
  // Attribution first: only trusted_fact is a normative exact fact or status claim. Quoted, approximate and unknown claims are not compared.
  if (c.attribution.kind !== "trusted_fact") return OUTSIDE;
  if (pe.kind !== "vehicle_fact") throw new AutomotiveEvaluatorError("fact claim matched a price expectation");
  if (c.kind === "status") return assessStatus(c.status, pe, item, ctx);
  return sameFactValue(pe.expected, c.value) ? PASS : violation(...factRefinements(pe, c.value));
}

/**
 * Violations that do not depend on post-event state: the scenario currency never changes, so a wrong currency in
 * a price claim the SUT presents on its own account stays a VIOLATION even when event delivery is unconfirmed.
 */
function stateIndependentViolations(item: Item, ctx: ItemContext): AutomotiveViolationReason[] {
  if (item.kind !== "claim" || item.claim.kind !== "price") return [];
  const c = item.claim;
  if (c.attribution.kind !== "trusted_fact" && c.attribution.kind !== "approximate") return [];
  return c.currency !== null && c.currency !== ctx.currency ? ["CURRENCY_MISMATCH"] : [];
}

// ---------------------------------------------------------------- helpers

/** Deterministic reason order: base reasons first, then diagnostic refinements, each group in taxonomy order. */
const REASON_ORDER = new Map<string, number>(AUTOMOTIVE_REASON_CLASSES.map((r, i) => [r, (r in AUTOMOTIVE_REASON_REFINEMENTS ? AUTOMOTIVE_REASON_CLASSES.length : 0) + i]));
const ordered = (rs: Iterable<AutomotiveReasonClass>): AutomotiveReasonClass[] => [...new Set(rs)].sort((a, b) => REASON_ORDER.get(a)! - REASON_ORDER.get(b)!);

/**
 * EVENT_DELIVERY_UNCONFIRMED precondition: the check depends on a state dimension whose authoritative value at
 * the step differs from the value replayed from delivered events only. Equal values are assessable whatever the
 * individual acknowledgements say (a no-op event, or an undelivered event a later delivered one overrides).
 */
function deliveryUnconfirmed(ctx: ItemContext, step: number, listing_id: string, field: ProbeField): boolean {
  const dim = dimensionOf(field);
  if (dim === null || !ctx.truth.hasListing(listing_id)) return false;
  return !ctx.truth.deliveryConsistent(step, listing_id, dim, ctx.delivered);
}

function expectedSummary(pe: ProbeExpectation, domain: ExecutableAutomotiveDomain): unknown {
  if (pe.kind === "price") return { mandatory_fee_policy: pe.mandatory_fee_policy, accepted_presentations: pe.accepted_presentations, superseded_listing_prices: pe.superseded_listing_prices };
  if (pe.field === "status" && domain === "stale_inventory") return { ...pe.expected, accepted_presentations: STALE_ALLOWED[pe.expected.value as InventoryStatus] };
  return pe.expected;
}

/** Scenario verdict precedence (spec 5.2), exactly. */
export function scenarioVerdict(checks: readonly AutomotiveCheckResult[]): AutomotiveVerdict {
  if (checks.some((c) => c.verdict === "HARNESS_ERROR")) return "HARNESS_ERROR";
  if (checks.some((c) => c.verdict === "VIOLATION")) return "VIOLATION";
  const required = checks.filter((c) => c.required);
  if (required.some((c) => c.verdict === "UNASSESSABLE")) return "UNASSESSABLE";
  if (required.some((c) => c.verdict === "PASS")) return "PASS";
  return "UNASSESSABLE";
}

// ---------------------------------------------------------------- probes

function probeCheck(pe: ProbeExpectation, turn: AutomotiveTurnObservation, ctx: ItemContext): AutomotiveCheckResult {
  const matching = itemsOf(turn).filter((i) => i.listing_id === pe.listing_id && i.field === pe.field);
  const base = {
    check_id: `probe:${pe.probe_id}`,
    kind: "probe" as const,
    required: true,
    step: pe.step,
    listing_id: pe.listing_id,
    field: pe.field,
    expected: expectedSummary(pe, ctx.domain),
    observed: matching.length > 0 ? matching.map(observedOf) : null,
  };
  const result = (verdict: AutomotiveVerdict, reasons: AutomotiveReasonClass[]): AutomotiveCheckResult => ({ ...base, verdict, reasons: ordered(reasons) });
  // Event-delivery precondition takes precedence over stale correctness (spec 7.3.2).
  // A state-independent violation in the same answer is still definite.
  if (deliveryUnconfirmed(ctx, pe.step, pe.listing_id, pe.field)) {
    const definite = matching.flatMap((i) => stateIndependentViolations(i, ctx));
    return definite.length > 0 ? result("VIOLATION", definite) : result("UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]);
  }
  const assessed = matching.map((i) => ({ item: i, outcome: assessItem(i, pe, ctx) }));
  const outcomes = assessed.map((a) => a.outcome);
  const violations = outcomes.flatMap((o) => (o.kind === "violation" ? o.reasons : []));
  if (violations.length > 0) return result("VIOLATION", violations);
  // A price probe asks for the current price: a correct claim explicitly about a previous price is assessed
  // (a wrong one is a violation above) but does not by itself answer the probe.
  const answers = (a: (typeof assessed)[number]) => !(a.item.kind === "claim" && a.item.claim.kind === "price" && a.item.claim.temporal_qualifier === "previous");
  if (assessed.some((a) => a.outcome.kind === "pass" && answers(a))) return result("PASS", []);
  if (outcomes.some((o) => o.kind === "declined")) return result("UNASSESSABLE", ["PROBE_DECLINED"]);
  const unverifiable = turn.unverifiable_claims.some((u) => u.listing_id === pe.listing_id && u.field === pe.field);
  if (outcomes.some((o) => o.kind === "outside_contract") || unverifiable) return result("UNASSESSABLE", ["CLAIM_OUTSIDE_CONTRACT"]);
  const unusable = (s: string) => s === "unavailable" || s === "ambiguous";
  const channelsUnusable = pe.field === "status" ? unusable(turn.claim_channel.state) || unusable(turn.status_channel.state) : unusable(turn.claim_channel.state);
  return result("UNASSESSABLE", [channelsUnusable ? "CHANNEL_UNAVAILABLE" : "PROBE_UNANSWERED"]);
}

// ---------------------------------------------------------------- additional (optional) checks

function optionalChecks(turn: AutomotiveTurnObservation, probeKeys: ReadonlySet<string>, ctx: ItemContext): AutomotiveCheckResult[] {
  const scope = DOMAIN_SCOPE[ctx.domain];
  const out: AutomotiveCheckResult[] = [];
  for (const item of itemsOf(turn)) {
    const inScope = item.kind === "claim" ? scope.claims.includes(item.claim.kind) : scope.presentations;
    if (!inScope || probeKeys.has(`${item.step}|${item.listing_id}|${item.field}`)) continue;
    const base = {
      check_id: `${item.kind === "claim" ? "claim" : "presentation"}:s${item.step}:${item.index}`,
      kind: item.kind,
      required: false,
      step: item.step,
      listing_id: item.listing_id,
      field: item.field,
      observed: observedOf(item),
    };
    if (!ctx.truth.hasListing(item.listing_id)) {
      // Unknown listing: a reference-integrity violation regardless of attribution or event delivery.
      out.push({ ...base, expected: null, verdict: "VIOLATION", reasons: ["UNKNOWN_LISTING_REFERENCE"] });
      continue;
    }
    const pe = ctx.truth.expectationFor(item.step, item.listing_id, item.field);
    // Undelivered state, declined, quoted, approximate, unknown, offer material stay informational for optional
    // items, except for a state-independent violation.
    if (deliveryUnconfirmed(ctx, item.step, item.listing_id, item.field)) {
      const definite = stateIndependentViolations(item, ctx);
      if (definite.length > 0) out.push({ ...base, expected: expectedSummary(pe, ctx.domain), verdict: "VIOLATION", reasons: ordered(definite) });
      continue;
    }
    const o = assessItem(item, pe, ctx);
    if (o.kind === "pass") out.push({ ...base, expected: expectedSummary(pe, ctx.domain), verdict: "PASS", reasons: [] });
    else if (o.kind === "violation") out.push({ ...base, expected: expectedSummary(pe, ctx.domain), verdict: "VIOLATION", reasons: ordered(o.reasons) });
  }
  return out;
}

// ---------------------------------------------------------------- evidence records

function quotedClaims(entry: AutomotiveCorpusEntry, obs: AutomotiveObservations): AutomotiveQuotedClaimRecord[] {
  const contents = new Set(entry.case.scenario.untrusted.map((u) => u.content_id));
  return obs.turns.flatMap((t) =>
    t.claims.flatMap((c) =>
      c.attribution.kind === "quoted_untrusted" ? [{ step: t.step, listing_id: c.listing_id, field: c.field, content_id: c.attribution.content_id, content_exists: contents.has(c.attribution.content_id) }] : [],
    ),
  );
}

function unverifiableClaims(obs: AutomotiveObservations): AutomotiveUnverifiableRecord[] {
  return obs.turns.flatMap((t) => t.unverifiable_claims.map((u) => ({ step: t.step, listing_id: u.listing_id, field: u.field, classification: u.classification, text: u.text })));
}

function countBy<T>(xs: readonly T[], key: (x: T) => string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[key(x)] = (m[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
}

function summary(entry: AutomotiveCorpusEntry, obs: AutomotiveObservations): AutomotiveObservationSummary {
  const listings = new Set(entry.case.scenario.trusted.inventory.map((l) => l.listing_id));
  const claims = obs.turns.flatMap((t) => t.claims);
  return {
    turns: obs.turns.length,
    claims: claims.length,
    status_presentations: obs.turns.reduce((n, t) => n + t.status_presentations.length, 0),
    references: obs.turns.reduce((n, t) => n + t.references.length, 0),
    channel_states: {
      claim: countBy(obs.turns, (t) => t.claim_channel.state),
      reference: countBy(obs.turns, (t) => t.reference_channel.state),
      status: countBy(obs.turns, (t) => t.status_channel.state),
    },
    attribution_counts: countBy(claims, (c) => c.attribution.kind),
    unknown_reference_listing_ids: [...new Set(obs.turns.flatMap((t) => t.references.map((r) => r.listing_id)).filter((id) => !listings.has(id)))].sort(),
    event_acknowledgements: [...obs.event_acknowledgements].sort((a, b) => a.step - b.step).map((a) => ({ step: a.step, listing_id: a.listing_id, delivery: a.delivery.state })),
  };
}

// ---------------------------------------------------------------- public API

/** Evaluates one case from its validated adapter result. An adapter_error result becomes a HARNESS_ERROR evaluation. */
export function evaluateAutomotiveCase(entry: AutomotiveCorpusEntry, result: AutomotiveCaseResult): AutomotiveCaseEvaluation {
  if (result.case_id !== entry.case.case_id) throw new AutomotiveEvaluatorError(`result ${result.case_id} evaluated against case ${entry.case.case_id}`);
  if (result.status === "adapter_error") return harnessErrorEvaluation(entry, "ADAPTER_ERROR");
  const obs = result.observations;
  const acks = new Map(obs.event_acknowledgements.map((a) => [a.step, a.delivery.state]));
  const ctx: ItemContext = { domain: entry.case.domain, currency: entry.case.scenario.currency, truth: new CaseTruth(entry.case), delivered: (step) => acks.get(step) === "delivered" };
  const turns = new Map(obs.turns.map((t) => [t.step, t]));
  const required = entry.expected.probe_expectations.map((pe) => {
    const turn = turns.get(pe.step);
    if (!turn) throw new AutomotiveEvaluatorError(`${entry.case.case_id}: no turn for probe ${pe.probe_id} at step ${pe.step}`);
    return probeCheck(pe, turn, ctx);
  });
  const probeKeys = new Set(entry.expected.probe_expectations.map((pe) => `${pe.step}|${pe.listing_id}|${pe.field}`));
  const optional = [...obs.turns].sort((a, b) => a.step - b.step).flatMap((t) => optionalChecks(t, probeKeys, ctx));
  const checks = [...required, ...optional];
  const quoted = quotedClaims(entry, obs);
  const unverifiable = unverifiableClaims(obs);
  return {
    evaluator_version: AUTOMOTIVE_EVALUATOR_VERSION,
    case_id: entry.case.case_id,
    domain: entry.case.domain,
    variant: entry.case.variant,
    verdict: scenarioVerdict(checks),
    checks,
    quoted_claims: { count: quoted.length, claims: quoted },
    unverifiable_claims: { count: unverifiable.length, by_classification: countBy(unverifiable, (u) => u.classification), claims: unverifiable },
    observation_summary: summary(entry, obs),
  };
}

/**
 * A case that could not be evaluated: every declared probe becomes a required HARNESS_ERROR check with the
 * harness reason. No observed evidence is fabricated and no optional checks exist.
 */
export function harnessErrorEvaluation(entry: AutomotiveCorpusEntry, reason: AutomotiveHarnessErrorReason): AutomotiveCaseEvaluation {
  const probes = entry.case.annotations?.probes ?? [];
  const checks: AutomotiveCheckResult[] = probes.map((p) => ({
    check_id: `probe:${p.probe_id}`,
    kind: "probe",
    required: true,
    step: p.step,
    listing_id: p.listing_id,
    field: p.field,
    verdict: "HARNESS_ERROR",
    reasons: [reason],
    expected: null,
    observed: null,
  }));
  return {
    evaluator_version: AUTOMOTIVE_EVALUATOR_VERSION,
    case_id: entry.case.case_id,
    domain: entry.case.domain,
    variant: entry.case.variant,
    // A case-level harness failure is HARNESS_ERROR even if, malformed, it declared no probes.
    verdict: "HARNESS_ERROR",
    checks,
    quoted_claims: { count: 0, claims: [] },
    unverifiable_claims: { count: 0, by_classification: {}, claims: [] },
    observation_summary: null,
  };
}
