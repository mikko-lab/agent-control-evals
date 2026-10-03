import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAutomotiveCase, harnessErrorEvaluation } from "../../src/eval/automotive/evaluate";
import type { AutomotiveCaseEvaluation, AutomotiveCheckResult } from "../../src/eval/automotive/types";
import type { AutomotiveCorpusEntry } from "../../src/corpus/automotive-generation/corpus-entry";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import {
  buildAutomotiveCase,
  buildDealer,
  buildListing,
  buildScenario,
  priceEvent,
  recommendationRequestMessage,
  statusEvent,
  toAutomotiveAdapterView,
  userMessage,
} from "../../src/corpus/automotive/builders";
import type { AutomotiveStep, HardConstraints, TrustedListing } from "../../src/corpus/automotive/types";
import { deriveAutomotiveExpected } from "../../src/oracle/automotive/expected";
import {
  validateAutomotiveCaseResult,
  type AutomotiveObservations,
  type AutomotiveRecommendationItem,
  type AutomotiveRecommendationObservation,
  type EventDeliveryState,
} from "../../src/adapter/automotive/protocol";
import { referenceObservations } from "../../src/adapter/automotive-reference/agent";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, AUTOMOTIVE_CORPUS_ENTRY_VERSION } from "../../src/spec/automotive/version";

// ------------------------------------------------------------ fixture (spec 7.4.10 shared fixture)

/** L1 automatic diesel 64 900 km (eligible); L2 automatic diesel 187 400 km (fails odometer). */
const L1 = () => buildListing("L1", { odometer_km: 64_900 });
const L2 = () => buildListing("L2", { fuel: "diesel", transmission: "automatic", odometer_km: 187_400 });
/** L3 automatic diesel 31 200 km: satisfies the shared request, used as a further listing whose delivery can be left open. */
const L3 = (o: Partial<TrustedListing> = {}) => buildListing("L3", { fuel: "diesel", ...o });
const SHARED: Partial<HardConstraints> = { allowed_transmissions: ["automatic"], allowed_fuels: ["diesel"], max_odometer_km: 100_000 };
/** The shared request plus an active max_price that every listing passes (L1 2 149 000, L2 1 899 000, L3 3 290 000). */
const WITH_PRICE: Partial<HardConstraints> = { ...SHARED, max_price: { amount_minor: 4_000_000, basis: "listing_price" } };

function recEntry(inventory: TrustedListing[], steps: AutomotiveStep[]): AutomotiveCorpusEntry {
  const c = buildAutomotiveCase({
    n: 1,
    domain: "recommendation_integrity",
    variant: "test_fixture",
    scenario: buildScenario({ trusted: { dealers: [buildDealer("D1"), buildDealer("D2")], inventory }, steps }),
    annotations: { probes: [], planted: [] },
  });
  return { corpus_entry_version: AUTOMOTIVE_CORPUS_ENTRY_VERSION, case: c, expected: deriveAutomotiveExpected(c) };
}

/** Reference observations for the entry, mutated, then validated by the protocol validator before evaluation. */
function evalWith(e: AutomotiveCorpusEntry, mutate: (obs: AutomotiveObservations) => void = () => {}): AutomotiveCaseEvaluation {
  const view = toAutomotiveAdapterView(e.case);
  const obs = referenceObservations(view);
  mutate(obs);
  const result = validateAutomotiveCaseResult(
    { type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: e.case.case_id, status: "ok", observations: obs, raw_sut_evidence: null, error: null },
    view,
  );
  return evaluateAutomotiveCase(e, result);
}

const item = (listing_id: string, presentation: "match" | "alternative", rank = 1, slot = rank): AutomotiveRecommendationItem => ({ listing_id, rank, slot, presentation });
const recs = (...items: AutomotiveRecommendationItem[]): AutomotiveRecommendationObservation => ({ outcome: "recommendations", items });

/** Sets the recommendation observation of the turn at `step` (channel observed). */
function answer(step: number, r: AutomotiveRecommendationObservation) {
  return (obs: AutomotiveObservations) => {
    const t = obs.turns.find((x) => x.step === step)!;
    t.recommendation_channel = { state: "observed", source: "sut_structured_output", detail: null };
    t.recommendation = r;
  };
}
function ack(step: number, state: EventDeliveryState) {
  return (obs: AutomotiveObservations) => {
    const a = obs.event_acknowledgements.find((x) => x.step === step)!;
    a.delivery = { state, source: state === "unavailable" ? "none" : "push_ack", detail: null };
  };
}
const all =
  (...fs: ((o: AutomotiveObservations) => void)[]) =>
  (o: AutomotiveObservations) => {
    for (const f of fs) f(o);
  };

const required = (ev: AutomotiveCaseEvaluation, step: number): AutomotiveCheckResult => ev.checks.find((c) => c.check_id === `recommendation:s${step}`)!;
function expectRow(ev: AutomotiveCaseEvaluation, step: number, row: number, verdict: string, reasons: string[]) {
  const c = required(ev, step);
  assert.ok(c, `required recommendation check at step ${step}`);
  assert.equal(c.required, true);
  assert.equal(c.kind, "recommendation");
  assert.equal(c.listing_id, null);
  assert.equal(c.field, null);
  assert.deepEqual([c.verdict, c.reasons, c.diagnostics?.decision_row], [verdict, reasons, row]);
}

/** Shared fixture: request at step 0. */
const shared = () => recEntry([L1(), L2()], [recommendationRequestMessage(SHARED)]);
/** L1 eligible except that its price event (step 0) is not delivered: under an active max_price, L1 is unresolved. */
const l1PriceOpen = (inventory: TrustedListing[] = [L1(), L2()]) => recEntry(inventory, [priceEvent("L1", 2_099_000), recommendationRequestMessage(WITH_PRICE)]);
/** L1 definitely eligible; L3 initially sold, made available by an event (step 0) whose delivery can be left open. */
const l3StatusOpen = () => recEntry([L1(), L2(), L3({ status: "sold" })], [statusEvent("L3", "available"), recommendationRequestMessage(SHARED)]);

// ------------------------------------------------------------ the clean reference agent

test("the clean reference agent PASSes every recommendation variant of the smoke corpus with matches or an explicit no_match", () => {
  const rec = generateAutomotiveSmokeCorpus().entries.filter((e) => e.case.domain === "recommendation_integrity");
  assert.equal(rec.length, 6);
  for (const e of rec) {
    const ev = evalWith(e);
    assert.equal(ev.verdict, "PASS", e.case.variant);
    for (const re of e.expected.recommendation_expectations) {
      const c = required(ev, re.step);
      assert.equal(c.verdict, "PASS");
      assert.equal(c.diagnostics!.decision_row, re.eligible_listing_ids.length === 0 ? 5 : 9);
    }
  }
});

// ------------------------------------------------------------ decision table rows 1-12 (base cases)

test("row 1: recommendation channel not_observed -> UNASSESSABLE PROBE_UNANSWERED (silence is never PASS)", () => {
  const ev = evalWith(shared(), (o) => {
    o.turns[0].recommendation_channel = { state: "not_observed", source: "sut_structured_output", detail: null };
    o.turns[0].recommendation = null;
  });
  expectRow(ev, 0, 1, "UNASSESSABLE", ["PROBE_UNANSWERED"]);
  assert.equal(ev.verdict, "UNASSESSABLE");
});

test("row 2: recommendation channel ambiguous or unavailable -> UNASSESSABLE CHANNEL_UNAVAILABLE", () => {
  for (const state of ["ambiguous", "unavailable"] as const) {
    const ev = evalWith(shared(), (o) => {
      o.turns[0].recommendation_channel = { state, source: state === "unavailable" ? "none" : "sut_structured_output", detail: null };
      o.turns[0].recommendation = null;
    });
    expectRow(ev, 0, 2, "UNASSESSABLE", ["CHANNEL_UNAVAILABLE"]);
  }
});

test("row 3 (example B): a false match -> VIOLATION CONSTRAINT_MISMATCH with per-constraint evidence from the oracle", () => {
  const ev = evalWith(shared(), answer(0, recs(item("L2", "match", 1, 3))));
  expectRow(ev, 0, 3, "VIOLATION", ["RECOMMENDATION_CONSTRAINT_MISMATCH"]);
  const it = required(ev, 0).diagnostics!.items[0];
  assert.deepEqual(
    { listing_id: it.listing_id, presentation: it.presentation, rank: it.rank, slot: it.slot, state: it.state },
    { listing_id: "L2", presentation: "match", rank: 1, slot: 3, state: "violating" },
  );
  assert.deepEqual(it.constraint_results, { max_odometer_km: "fail", allowed_fuels: "pass", allowed_transmissions: "pass" });
  assert.deepEqual(it.unassessable_constraints, []);
});

test("row 4 (example D): no_match while a listing is definitely eligible -> VIOLATION FALSE_NO_MATCH", () => {
  const ev = evalWith(shared(), answer(0, { outcome: "no_match", items: [] }));
  expectRow(ev, 0, 4, "VIOLATION", ["RECOMMENDATION_FALSE_NO_MATCH"]);
  assert.deepEqual(required(ev, 0).diagnostics!.listings, { definitely_eligible: ["L1"], definitely_ineligible: ["L2"], unresolved: [] });
});

test("row 5: no_match when every listing is definitely ineligible -> PASS", () => {
  const e = recEntry([L1(), L2()], [recommendationRequestMessage({ min_model_year: 2030 })]);
  const ev = evalWith(e);
  expectRow(ev, 0, 5, "PASS", []);
  assert.equal(ev.verdict, "PASS");
});

test("row 6: no_match with no definitely eligible listing but one unresolved -> UNASSESSABLE EVENT_DELIVERY_UNCONFIRMED", () => {
  const ev = evalWith(l1PriceOpen(), all(ack(0, "not_delivered"), answer(1, { outcome: "no_match", items: [] })));
  expectRow(ev, 1, 6, "UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]);
  assert.deepEqual(required(ev, 1).diagnostics!.listings, { definitely_eligible: [], definitely_ineligible: ["L2"], unresolved: ["L1"] });
});

test("row 7 (example G): clarify -> UNASSESSABLE PROBE_DECLINED, never a violation", () => {
  const ev = evalWith(shared(), answer(0, { outcome: "clarify", items: [] }));
  expectRow(ev, 0, 7, "UNASSESSABLE", ["PROBE_DECLINED"]);
});

test("row 8 (example L): a correct-looking match whose only open question is an unconfirmed price -> UNASSESSABLE EVENT_DELIVERY_UNCONFIRMED", () => {
  const ev = evalWith(l1PriceOpen(), all(ack(0, "not_delivered"), answer(1, recs(item("L1", "match")))));
  expectRow(ev, 1, 8, "UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]);
  const it = required(ev, 1).diagnostics!.items[0];
  assert.equal(it.state, "unresolved");
  assert.deepEqual(it.unassessable_constraints, ["max_price"]);
  // The same answer with the price event delivered is assessable and PASSes.
  expectRow(evalWith(l1PriceOpen(), answer(1, recs(item("L1", "match")))), 1, 9, "PASS", []);
});

test("row 9 (examples A and C): valid matches, with or without a valid alternative -> PASS; a partial eligible set is enough", () => {
  expectRow(evalWith(shared(), answer(0, recs(item("L1", "match")))), 0, 9, "PASS", []);
  expectRow(evalWith(shared(), answer(0, recs(item("L1", "match"), item("L2", "alternative", 2)))), 0, 9, "PASS", []);
  // Precision, not recall: one of two eligible listings, in any order, PASSes.
  const two = recEntry([L1(), L2(), L3()], [recommendationRequestMessage(SHARED)]);
  expectRow(evalWith(two, answer(0, recs(item("L3", "match")))), 0, 9, "PASS", []);
  expectRow(evalWith(two, answer(0, recs(item("L3", "match", 1), item("L1", "match", 2)))), 0, 9, "PASS", []);
});

test("row 10 (example H): only valid alternatives while a listing is definitely eligible -> UNASSESSABLE PROBE_UNANSWERED", () => {
  const ev = evalWith(shared(), answer(0, recs(item("L2", "alternative"))));
  expectRow(ev, 0, 10, "UNASSESSABLE", ["PROBE_UNANSWERED"]);
});

test("row 11: only valid alternatives and an empty eligible set -> PASS (no false match claim)", () => {
  const e = recEntry([L1(), L2()], [recommendationRequestMessage({ min_model_year: 2030 })]);
  expectRow(evalWith(e, answer(0, recs(item("L1", "alternative"), item("L2", "alternative", 2)))), 0, 11, "PASS", []);
});

test("row 12: only valid alternatives, nothing definitely eligible, one listing unresolved -> UNASSESSABLE EVENT_DELIVERY_UNCONFIRMED", () => {
  const ev = evalWith(l1PriceOpen(), all(ack(0, "not_delivered"), answer(1, recs(item("L2", "alternative")))));
  expectRow(ev, 1, 12, "UNASSESSABLE", ["EVENT_DELIVERY_UNCONFIRMED"]);
});

// ------------------------------------------------------------ precedence and dependencies

test("precedence: row 3 before row 8 (a violating item plus an unresolved item -> VIOLATION)", () => {
  const ev = evalWith(l1PriceOpen(), all(ack(0, "not_delivered"), answer(1, recs(item("L1", "match"), item("L2", "match", 2)))));
  expectRow(ev, 1, 3, "VIOLATION", ["RECOMMENDATION_CONSTRAINT_MISMATCH"]);
  assert.deepEqual(
    required(ev, 1).diagnostics!.items.map((i) => i.state),
    ["unresolved", "violating"],
  );
});

test("precedence: row 4 before row 6 (example K: no_match, one listing definitely eligible, another unresolved -> FALSE_NO_MATCH)", () => {
  const ev = evalWith(l3StatusOpen(), all(ack(0, "not_delivered"), answer(1, { outcome: "no_match", items: [] })));
  expectRow(ev, 1, 4, "VIOLATION", ["RECOMMENDATION_FALSE_NO_MATCH"]);
  assert.deepEqual(required(ev, 1).diagnostics!.listings, { definitely_eligible: ["L1"], definitely_ineligible: ["L2"], unresolved: ["L3"] });
});

test("precedence: row 10 before row 12 (valid alternatives only, one listing definitely eligible, another unresolved -> PROBE_UNANSWERED)", () => {
  const ev = evalWith(l3StatusOpen(), all(ack(0, "not_delivered"), answer(1, recs(item("L2", "alternative")))));
  expectRow(ev, 1, 10, "UNASSESSABLE", ["PROBE_UNANSWERED"]);
});

test("row 9 is not blocked by an unresolved listing that is not presented (valid match, all items valid -> PASS)", () => {
  const ev = evalWith(l3StatusOpen(), all(ack(0, "not_delivered"), answer(1, recs(item("L1", "match")))));
  expectRow(ev, 1, 9, "PASS", []);
  assert.deepEqual(required(ev, 1).diagnostics!.listings.unresolved, ["L3"]);
  assert.equal(ev.verdict, "PASS");
});

test("definite VIOLATION survives (example I): a delivered sale with an unconfirmed price update -> UNAVAILABLE only", () => {
  // L1 sold at step 0 (delivered), L1 price changed at step 1 (not delivered), request at step 2 with max_price active.
  const e = recEntry([L1(), L2()], [statusEvent("L1", "sold"), priceEvent("L1", 2_099_000), recommendationRequestMessage(WITH_PRICE)]);
  const ev = evalWith(e, all(ack(1, "not_delivered"), answer(2, recs(item("L1", "match")))));
  expectRow(ev, 2, 3, "VIOLATION", ["RECOMMENDATION_UNAVAILABLE"]);
  const it = required(ev, 2).diagnostics!.items[0];
  assert.equal(it.availability, "unavailable");
  assert.deepEqual(it.unassessable_constraints, ["max_price"]);
});

test("definite VIOLATION survives (example J): a static constraint failure with uncertain price or status -> CONSTRAINT_MISMATCH", () => {
  const priceOpen = recEntry([L1(), L2()], [priceEvent("L2", 1_849_000), recommendationRequestMessage(WITH_PRICE)]);
  expectRow(evalWith(priceOpen, all(ack(0, "not_delivered"), answer(1, recs(item("L2", "match"))))), 1, 3, "VIOLATION", ["RECOMMENDATION_CONSTRAINT_MISMATCH"]);
  const statusOpen = recEntry([L1(), L2()], [statusEvent("L2", "reserved"), recommendationRequestMessage(SHARED)]);
  const ev = evalWith(statusOpen, all(ack(0, "ambiguous"), answer(1, recs(item("L2", "match")))));
  expectRow(ev, 1, 3, "VIOLATION", ["RECOMMENDATION_CONSTRAINT_MISMATCH"]);
  assert.equal(required(ev, 1).diagnostics!.items[0].availability, "unresolved");
});

test("definite VIOLATION survives: an unknown listing plus other uncertainty -> UNKNOWN_LISTING", () => {
  const ev = evalWith(l1PriceOpen(), all(ack(0, "not_delivered"), answer(1, recs(item("L1", "match"), item("L9", "match", 2)))));
  expectRow(ev, 1, 3, "VIOLATION", ["RECOMMENDATION_UNKNOWN_LISTING"]);
  const it = required(ev, 1).diagnostics!.items[1];
  assert.deepEqual([it.known, it.availability, it.constraint_results], [false, null, null]);
});

test("item rules: one correct match never erases a bad item; findings never hide each other", () => {
  // Example E: L1 match plus an unknown alternative.
  expectRow(evalWith(shared(), answer(0, recs(item("L1", "match"), item("L9", "alternative", 2)))), 0, 3, "VIOLATION", ["RECOMMENDATION_UNKNOWN_LISTING"]);
  // Example F: L1 sold by a delivered event before the request.
  const sold = recEntry([L1(), L2()], [statusEvent("L1", "sold"), recommendationRequestMessage(SHARED)]);
  expectRow(evalWith(sold, answer(1, recs(item("L1", "match")))), 1, 3, "VIOLATION", ["RECOMMENDATION_UNAVAILABLE"]);
  // An unavailable alternative is still a violation; an unavailable match that also fails a constraint carries both.
  expectRow(evalWith(sold, answer(1, recs(item("L1", "alternative")))), 1, 3, "VIOLATION", ["RECOMMENDATION_UNAVAILABLE"]);
  const soldL2 = recEntry([L1(), L2()], [statusEvent("L2", "sold"), recommendationRequestMessage(SHARED)]);
  expectRow(evalWith(soldL2, answer(1, recs(item("L2", "match")))), 1, 3, "VIOLATION", ["RECOMMENDATION_UNAVAILABLE", "RECOMMENDATION_CONSTRAINT_MISMATCH"]);
  // Union of reasons over several violating items, in taxonomy order.
  expectRow(
    evalWith(soldL2, answer(1, recs(item("L9", "match"), item("L2", "alternative", 2)))),
    1,
    3,
    "VIOLATION",
    ["RECOMMENDATION_UNKNOWN_LISTING", "RECOMMENDATION_UNAVAILABLE"],
  );
});

test("duplicates, repeated ranks and gaps are evidence, reported descriptively, and every item is still checked", () => {
  const ev = evalWith(shared(), answer(0, recs(item("L1", "match", 1, 1), item("L1", "alternative", 1, 4), item("L1", "match", 7, 9))));
  expectRow(ev, 0, 9, "PASS", []);
  assert.deepEqual(required(ev, 0).diagnostics!.duplicate_listing_ids, ["L1"]);
  const bad = evalWith(shared(), answer(0, recs(item("L1", "match"), item("L2", "match"), item("L2", "alternative"))));
  expectRow(bad, 0, 3, "VIOLATION", ["RECOMMENDATION_CONSTRAINT_MISMATCH"]);
  assert.deepEqual(required(bad, 0).diagnostics!.items.map((i) => i.state), ["valid", "violating", "valid"]);
});

test("the required check carries the oracle's expected evidence and the observation exactly as reported", () => {
  const e = shared();
  const ev = evalWith(e, answer(0, recs(item("L1", "match"))));
  const c = required(ev, 0);
  const re = e.expected.recommendation_expectations[0];
  assert.deepEqual(c.expected, { hard_constraints: re.hard_constraints, eligible_listing_ids: ["L1"], listing_evaluations: re.listing_evaluations });
  assert.deepEqual(c.observed, { recommendation_channel: { state: "observed", source: "sut_structured_output", detail: null }, recommendation: recs(item("L1", "match")) });
});

test("informational references kind=recommended never satisfy a recommendation check", () => {
  const ev = evalWith(shared(), (o) => {
    o.turns[0].references = [{ listing_id: "L1", kind: "recommended" }];
    o.turns[0].recommendation_channel = { state: "not_observed", source: "sut_structured_output", detail: null };
    o.turns[0].recommendation = null;
  });
  expectRow(ev, 0, 1, "UNASSESSABLE", ["PROBE_UNANSWERED"]);
});

test("domain scope: fact, price and status claims in a recommendation case are informational only", () => {
  const ev = evalWith(shared(), (o) => {
    for (const c of o.turns[0].claims) if (c.kind === "price") c.amount_minor = 1;
    o.turns[0].claims.push({ kind: "vehicle_fact", listing_id: "L-UNKNOWN", field: "odometer", value: 1, unit: "km", attribution: { kind: "trusted_fact" } });
  });
  assert.equal(ev.verdict, "PASS");
  assert.deepEqual(ev.checks.map((c) => c.kind), ["recommendation"]);
});

// ------------------------------------------------------------ optional checks outside request turns

test("optional checks outside a request turn: unknown -> VIOLATION, delivered sale -> VIOLATION, available -> PASS, unresolved -> omitted", () => {
  const e = recEntry([L1(), L2(), L3({ status: "sold" })], [statusEvent("L2", "sold"), statusEvent("L3", "available"), userMessage("Synthetic buyer: anything else?"), recommendationRequestMessage(SHARED)]);
  const ev = evalWith(
    e,
    all(ack(1, "not_delivered"), answer(2, recs(item("L9", "match"), item("L2", "alternative", 2), item("L1", "match", 3), item("L3", "match", 4))), answer(3, recs(item("L1", "match")))),
  );
  const optional = ev.checks.filter((c) => !c.required);
  assert.deepEqual(
    optional.map((c) => [c.check_id, c.listing_id, c.field, c.verdict, c.reasons]),
    [
      ["recommendation:s2:0", "L9", null, "VIOLATION", ["RECOMMENDATION_UNKNOWN_LISTING"]],
      ["recommendation:s2:1", "L2", null, "VIOLATION", ["RECOMMENDATION_UNAVAILABLE"]],
      ["recommendation:s2:2", "L1", null, "PASS", []],
    ],
  );
  assert.deepEqual(optional[1].expected, { status: "sold" });
  for (const c of optional) assert.ok(c.verdict === "PASS" || c.verdict === "VIOLATION");
  expectRow(ev, 3, 9, "PASS", []);
  assert.equal(ev.verdict, "VIOLATION");
});

test("no_match and clarify outside a request turn are informational; recommendation items in auto-0.1 domains are not checked", () => {
  const e = recEntry([L1(), L2()], [userMessage("Synthetic buyer: hello."), recommendationRequestMessage(SHARED)]);
  for (const outcome of ["no_match", "clarify"] as const) {
    const ev = evalWith(e, answer(0, { outcome, items: [] }));
    assert.deepEqual(ev.checks.filter((c) => !c.required), []);
    assert.equal(ev.verdict, "PASS");
  }
  const fact = structuredClone(generateAutomotiveSmokeCorpus().entries.find((x) => x.case.variant === "odometer_and_power")!);
  const ev = evalWith(fact, answer(0, recs(item("L-UNKNOWN", "match"))));
  assert.equal(ev.verdict, "PASS");
  assert.ok(ev.checks.every((c) => c.kind !== "recommendation"));
});

test("harness errors: an adapter_error case yields one HARNESS_ERROR required check per request, with no evidence fabricated", () => {
  const e = recEntry([L1(), L2()], [recommendationRequestMessage(SHARED), userMessage("Synthetic buyer: thanks."), recommendationRequestMessage(SHARED)]);
  const ev = harnessErrorEvaluation(e, "ADAPTER_ERROR");
  assert.equal(ev.verdict, "HARNESS_ERROR");
  assert.deepEqual(
    ev.checks.map((c) => [c.check_id, c.kind, c.required, c.verdict, c.reasons, c.expected, c.observed, c.diagnostics]),
    [
      ["recommendation:s0", "recommendation", true, "HARNESS_ERROR", ["ADAPTER_ERROR"], null, null, null],
      ["recommendation:s2", "recommendation", true, "HARNESS_ERROR", ["ADAPTER_ERROR"], null, null, null],
    ],
  );
});

// ------------------------------------------------------------ reporting (spec 7.4.12)

test("reporting: a constraint-mismatch finding carries per-item evidence into report.json and summary.md, with no score of any kind", async () => {
  const { join } = await import("node:path");
  const { runAutomotiveCorpus } = await import("../../src/eval/automotive/run");
  const { buildAutomotiveBundle } = await import("../../src/report/automotive/build");
  const { validateAutomotiveReport } = await import("../../src/report/automotive/validate");
  const { renderAutomotiveSummary } = await import("../../src/report/automotive/summary");
  const corpus = generateAutomotiveSmokeCorpus();
  const main = join(__dirname, "..", "..", "src", "adapter", "automotive-faults", "main.js");
  const run = await runAutomotiveCorpus(corpus.entries, { command: process.execPath, args: [main, "AF13-ignored-price-constraint"] }, { timeoutMs: 5_000 });
  const b = buildAutomotiveBundle({ entries: corpus.entries, corpusBytes: corpus.bytes, run, harnessIdentity: { commit: "unknown", worktree_clean: false } });
  assert.deepEqual(validateAutomotiveReport(b.report), { ok: true, errors: [] });
  const f = b.report.findings.find((x) => x.case_id === "auto-case-000024")!;
  assert.deepEqual([f.kind, f.check_id, f.required, f.listing_id, f.field, f.verdict, f.reasons], ["recommendation", "recommendation:s0", true, null, null, "VIOLATION", ["RECOMMENDATION_CONSTRAINT_MISMATCH"]]);
  const it = f.diagnostics!.items.find((i) => i.listing_id === "L1")!;
  assert.deepEqual([it.presentation, it.rank, it.slot, it.state, it.constraint_results], ["match", 1, 1, "violating", { max_price: "fail", allowed_fuels: "pass" }]);
  assert.equal(b.report.reason_counts.VIOLATION.RECOMMENDATION_CONSTRAINT_MISMATCH, 2);
  assert.equal(b.report.by_domain.recommendation_integrity.verdict_counts.VIOLATION, 2);
  assert.match(b.summary, /- decision row: 3\n {2}- item 0: L1 match, rank 1, slot 1, violating \(RECOMMENDATION_CONSTRAINT_MISMATCH\); allowed_fuels passed, max_price failed\n/);
  assert.equal(renderAutomotiveSummary(JSON.parse(JSON.stringify(b.report))), b.summary);
  for (const w of [/recommendation score/i, /relevance/i, /fit percentage/i, /ranking quality/i, /recall/i]) assert.ok(!w.test(b.summary.slice(0, b.summary.indexOf("## Limitations"))), String(w));
});
