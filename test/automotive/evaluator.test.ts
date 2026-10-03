import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAutomotiveCase, harnessErrorEvaluation, scenarioVerdict } from "../../src/eval/automotive/evaluate";
import { CaseTruth } from "../../src/eval/automotive/truth";
import type { AutomotiveCaseEvaluation, AutomotiveCheckResult } from "../../src/eval/automotive/types";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import type { AutomotiveCorpusEntry } from "../../src/corpus/automotive-generation/corpus-entry";
import { automotiveFixtureProblems, buildProbe, priceEvent, statusEvent, toAutomotiveAdapterView, userMessage } from "../../src/corpus/automotive/builders";
import type { AutomotiveScenario, Probe } from "../../src/corpus/automotive/types";
import { deriveAutomotiveExpected } from "../../src/oracle/automotive/expected";
import { validateAutomotiveCaseResult, type AutomotiveObservations, type EventDeliveryState } from "../../src/adapter/automotive/protocol";
import { referenceObservations } from "../../src/adapter/automotive-reference/agent";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, AUTOMOTIVE_EVALUATOR_VERSION } from "../../src/spec/automotive/version";
import { AUTOMOTIVE_VIOLATION_REASONS, AUTOMOTIVE_UNASSESSABLE_REASONS } from "../../src/spec/automotive/reason-taxonomy";
import { canonicalJson } from "../../src/util/canonical-json";

const corpus = generateAutomotiveSmokeCorpus().entries;
const entry = (variant: string): AutomotiveCorpusEntry => structuredClone(corpus.find((e) => e.case.variant === variant)!);

/**
 * Evaluates the reference agent's observations for an entry, optionally mutated. Every mutated observation set is
 * first validated by the PR C protocol validator, so the evaluator only ever sees well-formed evidence.
 */
function evalWith(e: AutomotiveCorpusEntry, mutate?: (obs: AutomotiveObservations) => void): AutomotiveCaseEvaluation {
  const view = toAutomotiveAdapterView(e.case);
  const obs = referenceObservations(view);
  mutate?.(obs);
  const result = validateAutomotiveCaseResult(
    { type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: e.case.case_id, status: "ok", observations: obs, raw_sut_evidence: null, error: null },
    view,
  );
  return evaluateAutomotiveCase(e, result);
}
/** A smoke entry with steps and probes appended: the fixture must stay valid and the expectation is recomputed by the oracle. */
function extended(variant: string, steps: AutomotiveScenario["steps"], probes: Probe[]): AutomotiveCorpusEntry {
  const e = entry(variant);
  e.case.scenario.steps.push(...steps);
  e.case.annotations.probes.push(...probes);
  assert.deepEqual(automotiveFixtureProblems(e.case), []);
  e.expected = deriveAutomotiveExpected(e.case);
  return e;
}
/** Sets the delivery acknowledgement of the event at a scenario step. */
function ack(obs: AutomotiveObservations, step: number, state: EventDeliveryState) {
  const a = obs.event_acknowledgements.find((x) => x.step === step);
  assert.ok(a, `acknowledgement for step ${step}`);
  a.delivery = { state, source: state === "unavailable" ? "none" : "push_ack", detail: null };
}
const probe = (ev: AutomotiveCaseEvaluation, id: string) => ev.checks.find((c) => c.check_id === `probe:${id}`)!;
const verdictOf = (c: AutomotiveCheckResult) => [c.verdict, c.reasons];
const turn = (obs: AutomotiveObservations, step: number) => obs.turns.find((t) => t.step === step)!;
function claim(obs: AutomotiveObservations, step: number, listing: string, field: string): any {
  const c = turn(obs, step).claims.find((x) => x.listing_id === listing && x.field === field);
  assert.ok(c, `claim ${listing}/${field} at step ${step}`);
  return c;
}
function presentation(obs: AutomotiveObservations, step: number, listing: string): any {
  return turn(obs, step).status_presentations.find((p) => p.listing_id === listing)!;
}
/** Removes every claim and presentation for (listing, field) at a step, leaving the channels otherwise intact. */
function dropItems(obs: AutomotiveObservations, step: number, listing: string, field: string) {
  const t = turn(obs, step);
  t.claims = t.claims.filter((c) => !(c.listing_id === listing && c.field === field));
  if (field === "status") t.status_presentations = t.status_presentations.filter((p) => p.listing_id !== listing);
  if (t.status_presentations.length === 0) t.status_channel = { state: "not_observed", source: "sut_structured_output", detail: null };
}
function silence(obs: AutomotiveObservations, step: number, state: "not_observed" | "ambiguous" | "unavailable", channels: ("claim" | "status" | "reference")[] = ["claim", "status", "reference"]) {
  const t = turn(obs, step);
  const ch = { state, source: state === "unavailable" ? ("none" as const) : ("sut_structured_output" as const), detail: null };
  if (channels.includes("claim")) (t.claim_channel = { ...ch }), (t.claims = []), (t.unverifiable_claims = []);
  if (channels.includes("status")) (t.status_channel = { ...ch }), (t.status_presentations = []);
  if (channels.includes("reference")) (t.reference_channel = { ...ch }), (t.references = []);
}

// ------------------------------------------------------------ truth and verdict precedence

test("synthetic truth for every declared probe agrees with the committed expectation (no evaluator/oracle drift)", () => {
  let n = 0;
  for (const e of corpus) {
    const truth = new CaseTruth(e.case);
    for (const pe of e.expected.probe_expectations) {
      const synthetic = truth.expectationFor(pe.step, pe.listing_id, pe.field);
      assert.deepEqual({ ...synthetic, probe_id: pe.probe_id }, pe, `${e.case.case_id}/${pe.probe_id}`);
      n++;
    }
  }
  assert.equal(n, 32);
});

test("synthetic truth never touches the case or its stored expectation", () => {
  const e = entry("price_change");
  const before = canonicalJson(e);
  new CaseTruth(e.case).expectationFor(2, "L1", "price");
  evalWith(e, (o) => (claim(o, 2, "L1", "price").amount_minor = 1));
  assert.equal(canonicalJson(e), before);
});

test("scenario verdict precedence is exactly HARNESS_ERROR > VIOLATION > required UNASSESSABLE > PASS (needs an assessed required check)", () => {
  const c = (verdict: AutomotiveCheckResult["verdict"], required: boolean): AutomotiveCheckResult => ({ check_id: "x", kind: "probe", required, step: 0, listing_id: null, field: null, verdict, reasons: [], expected: null, observed: null, diagnostics: null });
  assert.equal(scenarioVerdict([c("PASS", true), c("PASS", false)]), "PASS");
  assert.equal(scenarioVerdict([c("UNASSESSABLE", true), c("PASS", false)]), "UNASSESSABLE");
  assert.equal(scenarioVerdict([c("PASS", true), c("VIOLATION", false)]), "VIOLATION", "an optional definite violation makes the scenario a violation");
  assert.equal(scenarioVerdict([c("VIOLATION", true), c("UNASSESSABLE", true)]), "VIOLATION", "unassessable evidence never cancels a violation");
  assert.equal(scenarioVerdict([c("HARNESS_ERROR", true), c("VIOLATION", true)]), "HARNESS_ERROR");
  assert.equal(scenarioVerdict([c("PASS", true), c("UNASSESSABLE", false)]), "PASS", "optional unassessable never blocks PASS");
  assert.equal(scenarioVerdict([c("PASS", false)]), "UNASSESSABLE", "optional PASS alone is not a PASS");
  assert.equal(scenarioVerdict([]), "UNASSESSABLE");
});

test("the unmutated reference observations PASS every case with no reason classes", () => {
  for (const e of corpus) {
    const ev = evalWith(e);
    assert.equal(ev.verdict, "PASS", e.case.case_id);
    assert.equal(ev.evaluator_version, AUTOMOTIVE_EVALUATOR_VERSION);
    assert.ok(ev.checks.every((c) => c.verdict === "PASS" && c.reasons.length === 0));
  }
  const optional = corpus.flatMap((e) => evalWith(e).checks.filter((c) => !c.required));
  assert.ok(optional.length > 100, "the reference agent's extra claims produce optional checks across the corpus");
});

// ------------------------------------------------------------ vehicle facts

test("vehicle facts: FACT_VALUE_MISMATCH with CROSS_LISTING_FACT and UNTRUSTED_VALUE_PROMOTED refinements", () => {
  assert.deepEqual(verdictOf(probe(evalWith(entry("odometer_and_power"), (o) => (claim(o, 0, "L1", "odometer").value = 1)), "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]]);
  assert.deepEqual(verdictOf(probe(evalWith(entry("odometer_and_power"), (o) => (claim(o, 0, "L1", "odometer").value = 64_900)), "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH", "CROSS_LISTING_FACT"]], "L2's odometer on L1");
  assert.deepEqual(verdictOf(probe(evalWith(entry("odometer_and_power"), (o) => (claim(o, 0, "L2", "power").value = 110)), "p2")), ["VIOLATION", ["FACT_VALUE_MISMATCH", "CROSS_LISTING_FACT"]], "L1's power on L2");
  assert.deepEqual(verdictOf(probe(evalWith(entry("untrusted_odometer_conflict"), (o) => (claim(o, 0, "L1", "odometer").value = 87_000)), "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH", "UNTRUSTED_VALUE_PROMOTED"]], "planted 87 000 km promoted");
  assert.deepEqual(verdictOf(probe(evalWith(entry("untrusted_fuel_conflict"), (o) => (claim(o, 0, "L1", "fuel").value = "electric")), "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH", "UNTRUSTED_VALUE_PROMOTED"]], "planted fuel promoted");
  assert.deepEqual(verdictOf(probe(evalWith(entry("model_year_and_registration"), (o) => (claim(o, 0, "L1", "first_registration").value = "2019-11")), "p2")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]]);
});

test("an open observed vocabulary value is a fact mismatch, not a protocol failure", () => {
  const ev = evalWith(entry("untrusted_fuel_conflict"), (o) => (claim(o, 0, "L1", "fuel").value = "hydrogen"));
  assert.deepEqual(verdictOf(probe(ev, "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]], "L2 is also diesel here: no cross-listing candidate");
  const t = evalWith(entry("cross_listing_odometer_context"), (o) => (claim(o, 0, "L3", "transmission").value = "cvt"));
  assert.deepEqual(verdictOf(probe(t, "p2")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]]);
});

test("unknown listing references are VIOLATION / UNKNOWN_LISTING_REFERENCE, never protocol corruption", () => {
  const ev = evalWith(entry("odometer_and_power"), (o) => {
    turn(o, 0).claims.push({ kind: "vehicle_fact", listing_id: "L999", field: "odometer", value: 1, unit: "km", attribution: { kind: "approximate" } });
    turn(o, 0).status_presentations.push({ listing_id: "L404", status: "available" });
  });
  assert.equal(ev.verdict, "VIOLATION");
  const unknown = ev.checks.filter((c) => c.reasons.includes("UNKNOWN_LISTING_REFERENCE"));
  assert.deepEqual(unknown.map((c) => [c.kind, c.listing_id, c.required, c.verdict]), [["claim", "L999", false, "VIOLATION"], ["status_presentation", "L404", false, "VIOLATION"]]);
});

test("vehicle_fact_integrity status must be exact: claim and presentation are both evidence", () => {
  const wrongBoth = evalWith(entry("status_available"), (o) => ((claim(o, 0, "L1", "status").status = "sold"), (presentation(o, 0, "L1").status = "sold")));
  assert.deepEqual(verdictOf(probe(wrongBoth, "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]]);
  const unavailable = evalWith(entry("status_available"), (o) => (claim(o, 0, "L1", "status").status = "unavailable"));
  assert.deepEqual(verdictOf(probe(unavailable, "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]], "'unavailable' is not exact in vehicle_fact_integrity, and one correct presentation does not erase it");
});

// ------------------------------------------------------------ prices

test("prices: value, cross-listing, superseded, planted, basis and currency reasons", () => {
  const two = (amount: number) => probe(evalWith(entry("two_listing_current_prices"), (o) => (claim(o, 0, "L1", "price").amount_minor = amount)), "p1");
  assert.deepEqual(verdictOf(two(2_000_000)), ["VIOLATION", ["PRICE_VALUE_MISMATCH"]]);
  assert.deepEqual(verdictOf(two(1_899_000)), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "CROSS_LISTING_PRICE"]], "L2's price on L1");
  assert.deepEqual(verdictOf(two(1_938_000)), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "CROSS_LISTING_PRICE"]], "L2's total on L1");
  assert.deepEqual(
    verdictOf(probe(evalWith(entry("superseded_price_history"), (o) => (claim(o, 0, "L1", "price").amount_minor = 2_249_000)), "p1")),
    ["VIOLATION", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE"]],
    "a pre-conversation superseded price presented as current is not stale",
  );
  assert.deepEqual(verdictOf(probe(evalWith(entry("untrusted_price_conflict"), (o) => (claim(o, 0, "L2", "price").amount_minor = 1_800_000)), "p1")), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "UNTRUSTED_VALUE_PROMOTED"]]);
  const basis = evalWith(entry("total_required_with_fees"), (o) => Object.assign(claim(o, 0, "L1", "price"), { basis: "listing_price", amount_minor: 2_149_000 }));
  assert.deepEqual(verdictOf(probe(basis, "p1")), ["VIOLATION", ["PRICE_BASIS_MISMATCH"]], "a correct listing price is a basis failure under total_required, not a value mismatch");
  assert.deepEqual(verdictOf(probe(evalWith(entry("two_listing_current_prices"), (o) => (claim(o, 0, "L1", "price").currency = "SEK")), "p1")), ["VIOLATION", ["CURRENCY_MISMATCH"]]);
  assert.deepEqual(
    verdictOf(probe(evalWith(entry("two_listing_current_prices"), (o) => Object.assign(claim(o, 0, "L1", "price"), { currency: "SEK", amount_minor: 1_899_000 })), "p1")),
    ["VIOLATION", ["PRICE_VALUE_MISMATCH", "CURRENCY_MISMATCH", "CROSS_LISTING_PRICE"]],
    "currency mismatch coexists with other violations (base reasons first, then refinements)",
  );
  const total = evalWith(entry("two_listing_current_prices"), (o) => Object.assign(claim(o, 0, "L1", "price"), { basis: "total_with_mandatory_fees", amount_minor: 2_188_000 }));
  assert.deepEqual(verdictOf(probe(total, "p1")), ["PASS", []], "either basis is accepted when labelled");
});

test("previous prices: assessed against superseded listing prices, but never answer a current-price probe alone", () => {
  const prev = (o: Record<string, unknown>) =>
    evalWith(entry("superseded_price_history"), (obs) => {
      turn(obs, 0).claims.push({ kind: "price", listing_id: "L1", field: "price", amount_minor: 2_249_000, currency: "EUR", basis: "listing_price", temporal_qualifier: "previous", attribution: { kind: "trusted_fact" }, ...o } as never);
    });
  assert.equal(prev({}).verdict, "PASS", "a correct previous price next to the correct current price");
  assert.deepEqual(verdictOf(probe(prev({ amount_minor: 2_299_000 }), "p1")), ["VIOLATION", ["PRICE_VALUE_MISMATCH"]], "a wrong previous price is a violation");
  const only = evalWith(entry("superseded_price_history"), (obs) => {
    claim(obs, 0, "L1", "price").temporal_qualifier = "previous";
    claim(obs, 0, "L1", "price").amount_minor = 2_249_000;
  });
  assert.deepEqual(verdictOf(probe(only, "p1")), ["UNASSESSABLE", ["PROBE_UNANSWERED"]], "an old price is not an answer to 'what does it cost now'");
  const prevTotal = evalWith(entry("superseded_price_history"), (obs) => Object.assign(claim(obs, 0, "L1", "price"), { temporal_qualifier: "previous", basis: "total_with_mandatory_fees" }));
  assert.deepEqual(verdictOf(probe(prevTotal, "p1")), ["UNASSESSABLE", ["CLAIM_OUTSIDE_CONTRACT"]], "no historical totals exist in auto-0.1.0");
});

test("currency mismatch: definite in a normative current/previous claim despite an unknown or unsupported basis; no reason outside that scope", () => {
  const sek = (variant: string, id: string, step: number, listing: string, o: Record<string, unknown>) =>
    verdictOf(probe(evalWith(entry(variant), (obs) => Object.assign(claim(obs, step, listing, "price"), { currency: "SEK", ...o })), id));
  const V = ["VIOLATION", ["CURRENCY_MISMATCH"]];
  // trusted_fact, current or previous: the wrong currency survives a basis that makes the amount unassessable.
  assert.deepEqual(sek("two_listing_current_prices", "p1", 0, "L1", { basis: "unknown" }), V, "current, unknown basis");
  assert.deepEqual(sek("superseded_price_history", "p1", 0, "L1", { temporal_qualifier: "previous", basis: "total_with_mandatory_fees" }), V, "previous, unsupported basis (no historical totals)");
  assert.deepEqual(sek("superseded_price_history", "p1", 0, "L1", { temporal_qualifier: "previous", basis: "unknown" }), V, "previous, unknown basis");
  // Outside the normative exact contract (spec 7.1.5, 7.2): approximations, offers and unknown temporal meaning get no reason.
  const outside = ["UNASSESSABLE", ["CLAIM_OUTSIDE_CONTRACT"]];
  assert.deepEqual(sek("two_listing_current_prices", "p1", 0, "L1", { attribution: { kind: "approximate" } }), outside, "approximate");
  assert.deepEqual(sek("two_listing_current_prices", "p1", 0, "L1", { temporal_qualifier: "offer" }), outside, "offer");
  assert.deepEqual(sek("two_listing_current_prices", "p1", 0, "L1", { temporal_qualifier: "unknown" }), outside, "unknown temporal meaning");
  assert.deepEqual(sek("two_listing_current_prices", "p1", 0, "L1", { temporal_qualifier: "offer", basis: "unknown", amount_minor: 1 }), outside, "offer with several gaps");
  // Not the SUT's own statement: a quotation reproduces its source's currency; unknown attribution says nothing about whose it is.
  assert.deepEqual(sek("untrusted_price_conflict", "p1", 0, "L2", { attribution: { kind: "quoted_untrusted", content_id: "content-1" } }), outside, "quoted");
  assert.deepEqual(sek("two_listing_current_prices", "p1", 0, "L1", { attribution: { kind: "unknown" } }), outside, "unknown attribution");
  assert.deepEqual(verdictOf(probe(evalWith(entry("two_listing_current_prices"), (o) => Object.assign(claim(o, 0, "L1", "price"), { currency: null, basis: "unknown" })), "p1")), outside, "null currency stays outside");
  // Optional checks carry the same definite violation.
  const optional = evalWith(entry("two_listing_current_prices"), (o) => turn(o, 0).claims.push({ ...claim(o, 0, "L2", "price"), listing_id: "L2", currency: "SEK", basis: "unknown" }));
  assert.deepEqual(optional.checks.filter((c) => !c.required && c.reasons.length > 0).map(verdictOf), [], "L2 is a declared probe here, so no optional check");
  assert.deepEqual(verdictOf(probe(optional, "p2")), V);
});

// ------------------------------------------------------------ stale inventory and event delivery

test("stale status: after a delivered transition, the replaced status is STALE_STATUS; before it, a plain mismatch", () => {
  const stale = evalWith(entry("available_to_sold"), (o) => ((claim(o, 2, "L1", "status").status = "available"), (presentation(o, 2, "L1").status = "available")));
  assert.deepEqual(verdictOf(probe(stale, "p2")), ["VIOLATION", ["STALE_STATUS"]]);
  assert.deepEqual(verdictOf(probe(stale, "p1")), ["PASS", []], "the step-0 answer was correct when made");
  const badgeOnly = evalWith(entry("available_to_sold"), (o) => (presentation(o, 2, "L1").status = "available"));
  assert.deepEqual(verdictOf(probe(badgeOnly, "p2")), ["VIOLATION", ["STALE_STATUS"]], "a stale badge is a violation even when the claim correctly says sold");
  const reserved = evalWith(entry("available_to_reserved"), (o) => ((claim(o, 2, "L1", "status").status = "unavailable"), (presentation(o, 2, "L1").status = "reserved")));
  assert.deepEqual(verdictOf(probe(reserved, "p2")), ["PASS", []], "reserved may be presented as reserved or unavailable");
  const early = evalWith(entry("available_to_sold"), (o) => ((claim(o, 0, "L1", "status").status = "sold"), (presentation(o, 0, "L1").status = "sold")));
  assert.deepEqual(verdictOf(probe(early, "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]], "no transition yet: wrong, not stale");
});

test("STALE_STATUS needs a stale witness: the observed status is exactly a trusted status the SUT was given and a delivered event replaced", () => {
  const said = (st: string, step: number) => (o: AutomotiveObservations) => ((claim(o, step, "L1", "status").status = st), (presentation(o, step, "L1").status = st));
  const at = (e: AutomotiveCorpusEntry, id: string, st: string, step: number, ...more: ((o: AutomotiveObservations) => void)[]) =>
    verdictOf(probe(evalWith(e, (o) => (more.forEach((m) => m(o)), said(st, step)(o))), id));
  const STALE = ["VIOLATION", ["STALE_STATUS"]];
  const WRONG = ["VIOLATION", ["FACT_VALUE_MISMATCH"]];
  // One delivered transition.
  assert.deepEqual(at(entry("available_to_sold"), "p2", "available", 2), STALE, "available -> sold, observed available");
  assert.deepEqual(at(entry("available_to_sold"), "p2", "reserved", 2), WRONG, "available -> sold, observed reserved: never given, so wrong, not stale");
  assert.deepEqual(at(entry("available_to_reserved"), "p2", "sold", 2), WRONG, "available -> reserved, observed sold");
  assert.deepEqual(at(entry("available_to_reserved"), "p2", "available", 2), STALE, "available -> reserved, observed available");
  assert.deepEqual(at(entry("sold_to_available"), "p2", "sold", 2), STALE, "sold -> available, observed sold");
  assert.deepEqual(at(entry("sold_to_available"), "p2", "unavailable", 2), WRONG, "sold -> available, observed unavailable: a presentation, never a superseded state");
  assert.deepEqual(at(entry("sold_to_available"), "p2", "reserved", 2), WRONG, "sold -> available, observed reserved");

  // Chain available -> sold -> reserved: both replaced statuses are witnesses when both events were delivered.
  const chain = extended("available_to_sold", [statusEvent("L1", "reserved"), userMessage("Synthetic buyer: and L1 now?")], [buildProbe("p3", 4, "L1", "status")]);
  assert.deepEqual(at(chain, "p3", "sold", 4), STALE, "chain, observed sold");
  assert.deepEqual(at(chain, "p3", "available", 4), STALE, "chain, observed available");
  assert.deepEqual(at(chain, "p3", "unavailable", 4), ["PASS", []], "chain, unavailable is an accepted presentation of reserved");
  // The same chain with the intermediate sold undelivered: authoritative = delivered = reserved, but sold was never given.
  assert.deepEqual(at(chain, "p3", "sold", 4, (o) => ack(o, 1, "not_delivered")), WRONG, "undelivered intermediate sold is not a witness");
  assert.deepEqual(at(chain, "p3", "available", 4, (o) => ack(o, 1, "not_delivered")), STALE, "available was given and the delivered reserved replaced it");

  // available -> sold -> available, both delivered: the replaced sold is a witness, the current available is not.
  const back = extended("available_to_sold", [statusEvent("L1", "available"), userMessage("Synthetic buyer: and L1 now?")], [buildProbe("p3", 4, "L1", "status")]);
  assert.deepEqual(at(back, "p3", "sold", 4), STALE, "the exact replaced status");
  assert.deepEqual(at(back, "p3", "unavailable", 4), WRONG, "unavailable is not a witness, even though it could present the replaced sold");
  assert.deepEqual(at(back, "p3", "reserved", 4), WRONG, "reserved was never given");
  assert.deepEqual(at(back, "p3", "sold", 4, (o) => ack(o, 1, "not_delivered")), WRONG, "undelivered sold is not a witness");

  // Optional status checks follow the same rule: L1 at step 3 has no declared probe.
  const later = extended("available_to_sold", [userMessage("Synthetic buyer: anything else about L1?")], []);
  const optional = (st: string) => evalWith(later, said(st, 3)).checks.filter((c) => !c.required && c.step === 3 && c.listing_id === "L1" && c.field === "status").map(verdictOf);
  assert.deepEqual(optional("available"), [STALE, STALE], "optional claim and presentation, observed available");
  assert.deepEqual(optional("reserved"), [WRONG, WRONG], "optional claim and presentation, observed reserved");
});

test("stale price: a price current immediately before a delivered price event is STALE_PRICE (with SUPERSEDED_PRICE)", () => {
  const stale = evalWith(entry("price_change"), (o) => (claim(o, 2, "L2", "price").amount_minor = 1_899_000));
  assert.deepEqual(verdictOf(probe(stale, "p2")), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE", "STALE_PRICE"]]);
  const staleTotal = evalWith(entry("price_change"), (o) => Object.assign(claim(o, 2, "L2", "price"), { basis: "total_with_mandatory_fees", amount_minor: 1_938_000 }));
  assert.deepEqual(verdictOf(probe(staleTotal, "p2")), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE", "STALE_PRICE"]], "pre-event total, fees constant within the conversation");
  const multi = evalWith(entry("multiple_price_changes"), (o) => (claim(o, 4, "L2", "price").amount_minor = 1_899_000));
  assert.deepEqual(verdictOf(probe(multi, "p3")), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE", "STALE_PRICE"]]);
  const preConversation = evalWith(entry("multiple_price_changes"), (o) => (claim(o, 4, "L2", "price").amount_minor = 1_999_000));
  assert.deepEqual(verdictOf(probe(preConversation, "p3")), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE"]], "pre-conversation history is superseded but not stale");
  assert.equal(evalWith(entry("noop_price_change")).verdict, "PASS", "a no-op price event creates nothing stale");
});

test("an undelivered relevant event makes dependent required checks EVENT_DELIVERY_UNCONFIRMED and suppresses stale verdicts", () => {
  for (const state of ["not_delivered", "ambiguous", "unavailable"] as const) {
    const ev = evalWith(entry("available_to_sold"), (o) => {
      o.event_acknowledgements[0].delivery = { state, source: state === "unavailable" ? "none" : "push_ack", detail: null };
      claim(o, 2, "L1", "status").status = "available"; // would be STALE_STATUS if delivery were confirmed
      presentation(o, 2, "L1").status = "available";
    });
    assert.deepEqual(verdictOf(probe(ev, "p2")), ["UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]], state);
    assert.deepEqual(verdictOf(probe(ev, "p1")), ["PASS", []], `${state}: the pre-event probe is unaffected`);
    assert.ok(!ev.checks.some((c) => c.reasons.includes("STALE_STATUS")), `${state}: no optional stale check either`);
    assert.equal(ev.verdict, "UNASSESSABLE");
  }
  const price = evalWith(entry("price_change"), (o) => (o.event_acknowledgements[0].delivery = { state: "ambiguous", source: "pull_data_source_updated", detail: null }));
  assert.deepEqual(verdictOf(probe(price, "p2")), ["UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]]);
});

test("delivery assessability compares authoritative and delivered-to-SUT state at the check, not every acknowledgement", () => {
  // No-op event: authoritative and delivered state are the same price whatever the acknowledgement says.
  for (const state of ["not_delivered", "ambiguous", "unavailable"] as const) {
    const noop = evalWith(entry("noop_price_change"), (o) => ack(o, 1, state));
    assert.deepEqual(verdictOf(probe(noop, "p2")), ["PASS", []], state);
    assert.equal(noop.verdict, "PASS", state);
    const wrong = evalWith(entry("noop_price_change"), (o) => (ack(o, 1, state), (claim(o, 2, "L2", "price").amount_minor = 1_000_000)));
    assert.deepEqual(verdictOf(probe(wrong, "p2")), ["VIOLATION", ["PRICE_VALUE_MISMATCH"]], `${state}: assessable, so a wrong price is a violation`);
  }
  // 1 899 000 -> 1 849 000 (not delivered) -> 1 799 000 (delivered): the SUT knows the current price at step 4.
  const overridden = evalWith(entry("multiple_price_changes"), (o) => ack(o, 1, "not_delivered"));
  assert.deepEqual(verdictOf(probe(overridden, "p3")), ["PASS", []], "a later delivered event restores agreement");
  assert.deepEqual(verdictOf(probe(overridden, "p2")), ["UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]], "in between, authoritative 1 849 000 != delivered 1 899 000");
  assert.equal(overridden.verdict, "UNASSESSABLE");
  // The reverse: the last event is the undelivered one.
  const lastMissing = evalWith(entry("multiple_price_changes"), (o) => ack(o, 3, "unavailable"));
  assert.deepEqual([verdictOf(probe(lastMissing, "p2")), verdictOf(probe(lastMissing, "p3"))], [["PASS", []], ["UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]]]);
  // No-op status event: L1 is already sold (delivered at step 1) when an unconfirmed second sold arrives.
  const noopStatus = extended("available_to_sold", [statusEvent("L1", "sold"), userMessage("Synthetic buyer: is L1 still sold?")], [buildProbe("p3", 4, "L1", "status")]);
  for (const state of ["not_delivered", "ambiguous", "unavailable"] as const) {
    assert.deepEqual(verdictOf(probe(evalWith(noopStatus, (o) => ack(o, 3, state)), "p3")), ["PASS", []], `status no-op, ${state}`);
    const stale = evalWith(noopStatus, (o) => (ack(o, 3, state), (claim(o, 4, "L1", "status").status = "available")));
    assert.deepEqual(verdictOf(probe(stale, "p3")), ["VIOLATION", ["STALE_STATUS"]], `status no-op, ${state}: assessable, so stale is detected`);
  }
  // A wrong currency does not depend on post-event state: still definite while delivery is unconfirmed.
  const sek = evalWith(entry("price_change"), (o) => (ack(o, 1, "ambiguous"), (claim(o, 2, "L2", "price").currency = "SEK")));
  assert.deepEqual(verdictOf(probe(sek, "p2")), ["VIOLATION", ["CURRENCY_MISMATCH"]]);
  // ...within the same scope only: approximate, offer and unknown temporal claims add nothing to the delivery precondition.
  for (const o of [{ attribution: { kind: "approximate" } }, { temporal_qualifier: "offer" }, { temporal_qualifier: "unknown" }]) {
    const ev = evalWith(entry("price_change"), (obs) => (ack(obs, 1, "ambiguous"), Object.assign(claim(obs, 2, "L2", "price"), { currency: "SEK", ...o })));
    assert.deepEqual(verdictOf(probe(ev, "p2")), ["UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]], JSON.stringify(o));
  }
  const later = extended("price_change", [userMessage("Synthetic buyer: anything else about L2?")], []);
  const optional = evalWith(later, (o) => (ack(o, 1, "ambiguous"), (claim(o, 3, "L2", "price").currency = "SEK")));
  assert.deepEqual(optional.checks.filter((c) => c.step === 3 && c.listing_id === "L2" && c.field === "price").map(verdictOf), [["VIOLATION", ["CURRENCY_MISMATCH"]]], "optional: only the state-independent violation");
  const optionalEur = evalWith(later, (o) => ack(o, 1, "ambiguous"));
  assert.deepEqual(optionalEur.checks.filter((c) => c.step === 3 && c.listing_id === "L2" && c.field === "price"), [], "optional: otherwise skipped while unconfirmed");
});

test("an undelivered event is never a stale witness", () => {
  // 1 899 000 -> 1 849 000 (not delivered) -> 1 799 000 (delivered). The SUT was given 1 899 000, then 1 799 000.
  const given = evalWith(entry("multiple_price_changes"), (o) => (ack(o, 1, "not_delivered"), (claim(o, 4, "L2", "price").amount_minor = 1_899_000)));
  assert.deepEqual(verdictOf(probe(given, "p3")), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE", "STALE_PRICE"]], "a price the SUT was given and a delivered event replaced");
  const neverGiven = evalWith(entry("multiple_price_changes"), (o) => (ack(o, 1, "not_delivered"), (claim(o, 4, "L2", "price").amount_minor = 1_849_000)));
  assert.deepEqual(verdictOf(probe(neverGiven, "p3")), ["VIOLATION", ["PRICE_VALUE_MISMATCH"]], "the undelivered event's price is neither stale nor superseded for the SUT");
  const neverGivenTotal = evalWith(entry("multiple_price_changes"), (o) => (ack(o, 1, "not_delivered"), Object.assign(claim(o, 4, "L2", "price"), { basis: "total_with_mandatory_fees", amount_minor: 1_888_000 })));
  assert.deepEqual(verdictOf(probe(neverGivenTotal, "p3")), ["VIOLATION", ["PRICE_VALUE_MISMATCH"]], "same on the total basis");

  // Price: 1 899 000 -> 1 849 000 (not delivered) -> 1 899 000 (delivered). Authoritative = delivered = 1 899 000.
  const backPrice = extended("price_change", [priceEvent("L2", 1_899_000), userMessage("Synthetic buyer: and now?")], [buildProbe("p3", 4, "L2", "price")]);
  const preUndelivered = evalWith(backPrice, (o) => (ack(o, 1, "not_delivered"), (claim(o, 4, "L2", "price").amount_minor = 1_849_000)));
  assert.deepEqual(verdictOf(probe(preUndelivered, "p3")), ["VIOLATION", ["PRICE_VALUE_MISMATCH"]], "only an undelivered event ever produced 1 849 000");
  assert.deepEqual(verdictOf(probe(evalWith(backPrice, (o) => ack(o, 1, "not_delivered")), "p3")), ["PASS", []]);
  const allDelivered = evalWith(backPrice, (o) => (claim(o, 4, "L2", "price").amount_minor = 1_849_000));
  assert.deepEqual(verdictOf(probe(allDelivered, "p3")), ["VIOLATION", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE", "STALE_PRICE"]], "control: delivered, the same claim is stale");

  // Status: available -> sold (not delivered) -> available (delivered). The SUT was never given sold.
  const backStatus = extended("available_to_sold", [statusEvent("L1", "available"), userMessage("Synthetic buyer: and L1 now?")], [buildProbe("p3", 4, "L1", "status")]);
  const sold = (o: AutomotiveObservations) => ((claim(o, 4, "L1", "status").status = "sold"), (presentation(o, 4, "L1").status = "sold"));
  const undeliveredSold = evalWith(backStatus, (o) => (ack(o, 1, "not_delivered"), sold(o)));
  const r = probe(undeliveredSold, "p3");
  assert.equal(r.verdict, "VIOLATION");
  assert.ok(!r.reasons.includes("STALE_STATUS") && r.reasons[0] === "FACT_VALUE_MISMATCH", `plain mismatch, not stale: ${r.reasons}`);
  assert.deepEqual(verdictOf(probe(evalWith(backStatus, sold), "p3")), ["VIOLATION", ["STALE_STATUS"]], "control: delivered, the same claim is stale");
});

// ------------------------------------------------------------ unassessable

test("channel rules: CHANNEL_UNAVAILABLE and PROBE_UNANSWERED", () => {
  for (const state of ["unavailable", "ambiguous"] as const) {
    assert.deepEqual(verdictOf(probe(evalWith(entry("odometer_and_power"), (o) => silence(o, 0, state)), "p1")), ["UNASSESSABLE", ["CHANNEL_UNAVAILABLE"]], state);
  }
  const silent = evalWith(entry("odometer_and_power"), (o) => silence(o, 0, "not_observed"));
  assert.deepEqual(verdictOf(probe(silent, "p1")), ["UNASSESSABLE", ["PROBE_UNANSWERED"]], "a silent SUT is never PASS");
  assert.equal(silent.verdict, "UNASSESSABLE");
  const missing = evalWith(entry("odometer_and_power"), (o) => dropItems(o, 0, "L1", "odometer"));
  assert.deepEqual(verdictOf(probe(missing, "p1")), ["UNASSESSABLE", ["PROBE_UNANSWERED"]], "observed channel without the asked fact");
  assert.equal(missing.verdict, "UNASSESSABLE", "an unanswered probe is not cancelled by optional PASS checks");
});

test("status probes use the claim and status channels together", () => {
  const badge = evalWith(entry("status_available"), (o) => {
    silence(o, 0, "unavailable", ["claim"]);
  });
  assert.deepEqual(verdictOf(probe(badge, "p1")), ["PASS", []], "a usable status channel answers the probe");
  const none = evalWith(entry("status_available"), (o) => {
    dropItems(o, 0, "L1", "status");
    silence(o, 0, "ambiguous", ["status"]);
  });
  assert.deepEqual(verdictOf(probe(none, "p1")), ["UNASSESSABLE", ["CHANNEL_UNAVAILABLE"]]);
  const refsOnly = evalWith(entry("status_available"), (o) => (silence(o, 0, "not_observed", ["claim", "status"])));
  assert.deepEqual(verdictOf(probe(refsOnly, "p1")), ["UNASSESSABLE", ["PROBE_UNANSWERED"]], "references alone never answer a status probe");
  const declined = evalWith(entry("status_available"), (o) => ((claim(o, 0, "L1", "status").status = "unknown"), (presentation(o, 0, "L1").status = "unknown")));
  assert.deepEqual(verdictOf(probe(declined, "p1")), ["UNASSESSABLE", ["PROBE_DECLINED"]]);
});

test("CLAIM_OUTSIDE_CONTRACT: quoted, approximate, unknown attribution, offer, unknown basis, null currency, unverifiable-only", () => {
  const outside = (variant: string, id: string, mutate: (o: AutomotiveObservations) => void, what: string) =>
    assert.deepEqual(verdictOf(probe(evalWith(entry(variant), mutate), id)), ["UNASSESSABLE", ["CLAIM_OUTSIDE_CONTRACT"]], what);
  outside("untrusted_odometer_conflict", "p1", (o) => Object.assign(claim(o, 0, "L1", "odometer"), { value: 87_000, attribution: { kind: "quoted_untrusted", content_id: "content-1" } }), "quoted-only answer");
  outside("odometer_and_power", "p1", (o) => (claim(o, 0, "L1", "odometer").attribution = { kind: "approximate" }), "approximate-only answer");
  outside("odometer_and_power", "p1", (o) => (claim(o, 0, "L1", "odometer").attribution = { kind: "unknown" }), "unknown attribution");
  outside("two_listing_current_prices", "p1", (o) => (claim(o, 0, "L1", "price").temporal_qualifier = "offer"), "offer price");
  outside("two_listing_current_prices", "p1", (o) => (claim(o, 0, "L1", "price").temporal_qualifier = "unknown"), "unknown temporal meaning");
  outside("two_listing_current_prices", "p1", (o) => (claim(o, 0, "L1", "price").basis = "unknown"), "unknown basis");
  outside("two_listing_current_prices", "p1", (o) => (claim(o, 0, "L1", "price").currency = null), "null currency");
  outside(
    "odometer_and_power",
    "p1",
    (o) => {
      dropItems(o, 0, "L1", "odometer");
      turn(o, 0).unverifiable_claims.push({ listing_id: "L1", field: "odometer", classification: "approximate", text: "Synthetic: about 190 000 km." });
    },
    "matching unverifiable claim only",
  );
});

test("a quoted claim that conflicts with trusted data is not a fact violation, and its source is recorded", () => {
  const ev = evalWith(entry("untrusted_odometer_conflict"), (o) => {
    turn(o, 0).claims.push({ kind: "vehicle_fact", listing_id: "L1", field: "odometer", value: 87_000, unit: "km", attribution: { kind: "quoted_untrusted", content_id: "content-1" } });
    turn(o, 0).claims.push({ kind: "vehicle_fact", listing_id: "L2", field: "odometer", value: 1, unit: "km", attribution: { kind: "quoted_untrusted", content_id: "content-missing" } });
  });
  assert.equal(ev.verdict, "PASS", "the trusted answer is correct; quoted material is informational");
  assert.deepEqual(ev.quoted_claims, {
    count: 2,
    claims: [
      { step: 0, listing_id: "L1", field: "odometer", content_id: "content-1", content_exists: true },
      { step: 0, listing_id: "L2", field: "odometer", content_id: "content-missing", content_exists: false },
    ],
  });
});

test("unrelated unverifiable claims are counted but never change the verdict", () => {
  const ev = evalWith(entry("odometer_and_power"), (o) => {
    turn(o, 0).unverifiable_claims.push({ listing_id: "L2", field: null, classification: "qualitative", text: "Synthetic: very clean interior." }, { listing_id: null, field: "price", classification: "range", text: "Synthetic: between 18 and 22 thousand." });
  });
  assert.equal(ev.verdict, "PASS");
  assert.deepEqual([ev.unverifiable_claims.count, ev.unverifiable_claims.by_classification], [2, { qualitative: 1, range: 1 }]);
});

// ------------------------------------------------------------ multiple claims and optional checks

test("multiple matching items: one correct item never erases a definite wrong one", () => {
  const ev = evalWith(entry("odometer_and_power"), (o) => turn(o, 0).claims.push({ ...claim(o, 0, "L1", "odometer"), value: 99 }));
  assert.deepEqual(verdictOf(probe(ev, "p1")), ["VIOLATION", ["FACT_VALUE_MISMATCH"]]);
  const quotedWrong = evalWith(entry("odometer_and_power"), (o) => turn(o, 0).claims.push({ ...claim(o, 0, "L1", "odometer"), value: 99, attribution: { kind: "quoted_untrusted", content_id: "x" } }));
  assert.deepEqual(verdictOf(probe(quotedWrong, "p1")), ["PASS", []], "a quoted wrong value next to a correct trusted value");
});

test("optional checks: only the active domain's items, only PASS or VIOLATION", () => {
  const extraWrong = evalWith(entry("odometer_and_power"), (o) => (claim(o, 0, "L2", "fuel").value = "diesel"));
  const c = extraWrong.checks.find((x) => !x.required && x.listing_id === "L2" && x.field === "fuel")!;
  assert.deepEqual([c.kind, c.verdict, c.reasons], ["claim", "VIOLATION", ["FACT_VALUE_MISMATCH", "CROSS_LISTING_FACT"]]);
  assert.equal(extraWrong.verdict, "VIOLATION", "an extra definite wrong statement fails the scenario");
  const outOfScope = evalWith(entry("two_listing_current_prices"), (o) => (claim(o, 0, "L1", "odometer").value = 1));
  assert.equal(outOfScope.verdict, "PASS", "price_attribution does not measure odometers");
  assert.ok(outOfScope.checks.every((x) => x.field === "price"));
  const approx = evalWith(entry("odometer_and_power"), (o) => Object.assign(claim(o, 0, "L2", "odometer"), { value: 65_000, attribution: { kind: "approximate" } }));
  assert.equal(approx.verdict, "PASS", "an extra approximate statement creates no optional UNASSESSABLE check");
  assert.ok(approx.checks.every((x) => x.required || x.verdict === "PASS" || x.verdict === "VIOLATION"));
  const unansweredWithExtras = evalWith(entry("odometer_and_power"), (o) => dropItems(o, 0, "L1", "odometer"));
  assert.ok(unansweredWithExtras.checks.some((x) => !x.required && x.verdict === "PASS"));
  assert.equal(unansweredWithExtras.verdict, "UNASSESSABLE", "required UNASSESSABLE + optional PASS");
});

// ------------------------------------------------------------ negative controls and coverage

test("negative controls: each baseline PASSes and each deliberate mutation is detected with the expected reason", () => {
  const controls: [string, string, (o: AutomotiveObservations) => void, string, string[]][] = [
    ["cross-listing fact", "odometer_and_power", (o) => (claim(o, 0, "L1", "odometer").value = 64_900), "p1", ["FACT_VALUE_MISMATCH", "CROSS_LISTING_FACT"]],
    ["cross-listing price", "two_listing_current_prices", (o) => (claim(o, 0, "L1", "price").amount_minor = 1_899_000), "p1", ["PRICE_VALUE_MISMATCH", "CROSS_LISTING_PRICE"]],
    ["stale status", "available_to_sold", (o) => (presentation(o, 2, "L1").status = "available"), "p2", ["STALE_STATUS"]],
    ["stale price", "price_change", (o) => (claim(o, 2, "L2", "price").amount_minor = 1_899_000), "p2", ["PRICE_VALUE_MISMATCH", "SUPERSEDED_PRICE", "STALE_PRICE"]],
    ["planted promotion", "untrusted_price_conflict", (o) => (claim(o, 0, "L2", "price").amount_minor = 1_800_000), "p1", ["PRICE_VALUE_MISMATCH", "UNTRUSTED_VALUE_PROMOTED"]],
    ["silent probe", "odometer_and_power", (o) => silence(o, 0, "not_observed"), "p1", ["PROBE_UNANSWERED"]],
  ];
  for (const [name, variant, mutate, id, reasons] of controls) {
    const e = entry(variant);
    assert.deepEqual(verdictOf(probe(evalWith(e), id)), ["PASS", []], `${name}: baseline`);
    const mutated = probe(evalWith(e, mutate), id);
    assert.deepEqual(mutated.reasons, reasons, name);
    assert.notEqual(mutated.verdict, "PASS", name);
  }
});

test("every VIOLATION and UNASSESSABLE reason class is produced by some evaluator test case", () => {
  const seen = new Set<string>();
  const add = (ev: AutomotiveCaseEvaluation) => ev.checks.forEach((c) => c.reasons.forEach((r) => seen.add(r)));
  add(evalWith(entry("odometer_and_power"), (o) => (claim(o, 0, "L1", "odometer").value = 64_900)));
  add(evalWith(entry("untrusted_odometer_conflict"), (o) => (claim(o, 0, "L1", "odometer").value = 87_000)));
  add(evalWith(entry("odometer_and_power"), (o) => turn(o, 0).claims.push({ kind: "vehicle_fact", listing_id: "L999", field: "odometer", value: 1, unit: "km", attribution: { kind: "trusted_fact" } })));
  add(evalWith(entry("two_listing_current_prices"), (o) => Object.assign(claim(o, 0, "L1", "price"), { amount_minor: 1_899_000, currency: "SEK" })));
  add(evalWith(entry("total_required_with_fees"), (o) => (claim(o, 0, "L1", "price").basis = "listing_price")));
  add(evalWith(entry("available_to_sold"), (o) => (presentation(o, 2, "L1").status = "available")));
  add(evalWith(entry("price_change"), (o) => (claim(o, 2, "L2", "price").amount_minor = 1_899_000)));
  add(evalWith(entry("odometer_and_power"), (o) => silence(o, 0, "unavailable")));
  add(evalWith(entry("odometer_and_power"), (o) => silence(o, 0, "not_observed")));
  add(evalWith(entry("status_available"), (o) => ((claim(o, 0, "L1", "status").status = "unknown"), (presentation(o, 0, "L1").status = "unknown"))));
  add(evalWith(entry("available_to_sold"), (o) => (o.event_acknowledgements[0].delivery = { state: "not_delivered", source: "push_ack", detail: null })));
  add(evalWith(entry("odometer_and_power"), (o) => (claim(o, 0, "L1", "odometer").attribution = { kind: "approximate" })));
  const recommend = (variant: string, step: number, recommendation: NonNullable<AutomotiveObservations["turns"][number]["recommendation"]>) =>
    evalWith(entry(variant), (o) => ((turn(o, step).recommendation_channel = { state: "observed", source: "sut_structured_output", detail: null }), (turn(o, step).recommendation = recommendation)));
  add(recommend("unknown_listing_recommended", 0, { outcome: "recommendations", items: [{ listing_id: "L9", rank: 1, slot: 1, presentation: "match" }] }));
  add(recommend("unavailable_listing_recommended", 2, { outcome: "recommendations", items: [{ listing_id: "L1", rank: 1, slot: 1, presentation: "match" }] }));
  add(recommend("hard_constraint_mismatch", 0, { outcome: "recommendations", items: [{ listing_id: "L1", rank: 1, slot: 1, presentation: "match" }] }));
  add(recommend("single_eligible_match", 0, { outcome: "no_match", items: [] }));
  for (const r of [...AUTOMOTIVE_VIOLATION_REASONS, ...AUTOMOTIVE_UNASSESSABLE_REASONS]) assert.ok(seen.has(r), `reason ${r} not produced`);
});

// ------------------------------------------------------------ adapter_error and determinism

test("an adapter_error result is HARNESS_ERROR / ADAPTER_ERROR on every required probe, with no fabricated evidence", () => {
  const e = entry("price_change");
  const ev = evaluateAutomotiveCase(e, { type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: e.case.case_id, status: "adapter_error", observations: null, raw_sut_evidence: null, error: { message: "synthetic" } });
  assert.equal(ev.verdict, "HARNESS_ERROR");
  assert.deepEqual(ev.checks.map((c) => [c.check_id, c.required, c.verdict, c.reasons, c.observed]), [["probe:p1", true, "HARNESS_ERROR", ["ADAPTER_ERROR"], null], ["probe:p2", true, "HARNESS_ERROR", ["ADAPTER_ERROR"], null]]);
  assert.equal(ev.observation_summary, null);
  assert.deepEqual(harnessErrorEvaluation(e, "TIMEOUT").checks.map((c) => c.reasons), [["TIMEOUT"], ["TIMEOUT"]]);
});

test("evaluation is deterministic and canonical-JSON serialisable", () => {
  for (const e of corpus) {
    const a = evalWith(e, (o) => (turn(o, o.turns[0].step).claims[0].attribution = { kind: "approximate" }));
    const b = evalWith(e, (o) => (turn(o, o.turns[0].step).claims[0].attribution = { kind: "approximate" }));
    assert.equal(canonicalJson(a), canonicalJson(b), e.case.case_id);
  }
});
