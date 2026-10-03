import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import {
  AutomotiveFixtureError,
  automotiveFixtureProblems,
  buildAutomotiveCase,
  buildDealer,
  buildListing,
  buildProbe,
  buildScenario,
  hardConstraints,
  priceEvent,
  recommendationRequestMessage,
  statusEvent,
  toAutomotiveAdapterView,
  userMessage,
} from "../../src/corpus/automotive/builders";
import { activeConstraintFields, recommendationRequestProblems, renderRecommendationRequest } from "../../src/corpus/automotive/request";
import { HARD_CONSTRAINT_FIELDS, type AutomotiveCase, type AutomotiveCaseForAdapter, type AutomotiveStep, type HardConstraints, type TrustedListing } from "../../src/corpus/automotive/types";
import { AutomotiveOracleError, deriveAutomotiveExpected } from "../../src/oracle/automotive/expected";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import { AutomotiveProtocolError, validateAutomotiveCaseResult } from "../../src/adapter/automotive/protocol";
import { referenceObservations } from "../../src/adapter/automotive-reference/agent";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION } from "../../src/spec/automotive/version";

const ROOT = join(__dirname, "..", "..", "..");
const load = (f: string) => JSON.parse(readFileSync(join(ROOT, "schemas", "automotive", f), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(load("case.schema.json"), "auto-case");
ajv.addSchema(load("adapter-protocol.schema.json"), "auto-proto");
const caseSchema = ajv.getSchema("auto-case")!;
const resultSchema = ajv.getSchema("auto-proto#/$defs/caseResult")!;

function recCase(inventory: TrustedListing[], steps: AutomotiveStep[]): AutomotiveCase {
  return buildAutomotiveCase({
    n: 1,
    domain: "recommendation_integrity",
    variant: "contract_fixture",
    scenario: buildScenario({ trusted: { dealers: [buildDealer("D1"), buildDealer("D2")], inventory }, steps }),
    annotations: { probes: [], planted: [] },
  });
}
const L = () => [buildListing("L1"), buildListing("L2"), buildListing("L3")];
/** Oracle result for one request on the default three listings (L1 2019 diesel automatic estate 187 400 km 2 149 000 + 39 000; L2 2021 petrol manual hatchback 64 900 km 1 899 000 + 39 000; L3 2022 electric automatic suv 31 200 km 3 290 000 + 49 000; 5 seats each). */
const oracle = (hc: Partial<HardConstraints>, inventory = L()) => deriveAutomotiveExpected(recCase(inventory, [recommendationRequestMessage(hc)])).recommendation_expectations[0];
const resultOf = (hc: Partial<HardConstraints>, id: string, inventory = L()) => oracle(hc, inventory).listing_evaluations.find((e) => e.listing_id === id)!.constraint_results;

// ------------------------------------------------------------ oracle: eligibility function (spec 7.4.5-7.4.8)

test("oracle: every constraint field passes exactly at its inclusive bound and fails one unit beyond it", () => {
  const at = (hc: Partial<HardConstraints>, field: (typeof HARD_CONSTRAINT_FIELDS)[number]) => resultOf(hc, "L1")[field];
  assert.equal(at({ max_price: { amount_minor: 2_149_000, basis: "listing_price" } }, "max_price"), "pass");
  assert.equal(at({ max_price: { amount_minor: 2_148_999, basis: "listing_price" } }, "max_price"), "fail");
  assert.equal(at({ max_price: { amount_minor: 2_188_000, basis: "total_with_mandatory_fees" } }, "max_price"), "pass");
  assert.equal(at({ max_price: { amount_minor: 2_187_999, basis: "total_with_mandatory_fees" } }, "max_price"), "fail");
  assert.equal(at({ max_odometer_km: 187_400 }, "max_odometer_km"), "pass");
  assert.equal(at({ max_odometer_km: 187_399 }, "max_odometer_km"), "fail");
  assert.equal(at({ min_model_year: 2019 }, "min_model_year"), "pass");
  assert.equal(at({ min_model_year: 2020 }, "min_model_year"), "fail");
  assert.equal(at({ min_seats: 5 }, "min_seats"), "pass");
  assert.equal(at({ min_seats: 6 }, "min_seats"), "fail");
  assert.equal(at({ allowed_fuels: ["petrol", "diesel"] }, "allowed_fuels"), "pass");
  assert.equal(at({ allowed_fuels: ["petrol"] }, "allowed_fuels"), "fail");
  assert.equal(at({ allowed_transmissions: ["automatic"] }, "allowed_transmissions"), "pass");
  assert.equal(at({ allowed_transmissions: ["manual"] }, "allowed_transmissions"), "fail");
  assert.equal(at({ allowed_bodies: ["estate"] }, "allowed_bodies"), "pass");
  // Bodies are exact, case-sensitive strings.
  assert.equal(at({ allowed_bodies: ["Estate"] }, "allowed_bodies"), "fail");
});

test("oracle: the buyer's price basis is explicit and never inferred; the presentation policy does not reinterpret it", () => {
  // L2: listing 1 899 000, total 1 938 000.
  const hc = (basis: "listing_price" | "total_with_mandatory_fees") => ({ max_price: { amount_minor: 1_900_000, basis } });
  assert.equal(resultOf(hc("listing_price"), "L2").max_price, "pass");
  assert.equal(resultOf(hc("total_with_mandatory_fees"), "L2").max_price, "fail");
  const c = recCase(L(), [recommendationRequestMessage(hc("listing_price"))]);
  c.scenario.policy.mandatory_fee_policy = "total_required";
  assert.equal(deriveAutomotiveExpected(c).recommendation_expectations[0].listing_evaluations[1].constraint_results.max_price, "pass");
});

test("oracle: inactive fields are marked inactive and never constrain; a request with no active field makes every available listing eligible", () => {
  const e = oracle({ max_odometer_km: 100_000 });
  for (const l of e.listing_evaluations) {
    for (const f of HARD_CONSTRAINT_FIELDS) if (f !== "max_odometer_km") assert.equal(l.constraint_results[f], "inactive");
  }
  assert.deepEqual(e.eligible_listing_ids, ["L2", "L3"]);
  const none = oracle({}, [buildListing("L1"), buildListing("L2", { status: "reserved" }), buildListing("L3")]);
  assert.deepEqual(none.eligible_listing_ids, ["L1", "L3"]);
  assert.deepEqual(none.hard_constraints, hardConstraints());
  assert.deepEqual(activeConstraintFields(hardConstraints()), []);
});

test("oracle: eligibility is step-aware; status and price apply every event strictly before the request step", () => {
  const c = recCase(L(), [
    recommendationRequestMessage({ max_price: { amount_minor: 2_000_000, basis: "listing_price" } }),
    statusEvent("L2", "sold"),
    priceEvent("L1", 1_999_000),
    recommendationRequestMessage({ max_price: { amount_minor: 2_000_000, basis: "listing_price" } }),
    statusEvent("L2", "available"),
    recommendationRequestMessage({ max_price: { amount_minor: 2_000_000, basis: "listing_price" } }),
  ]);
  const [a, b, d] = deriveAutomotiveExpected(c).recommendation_expectations;
  assert.deepEqual([a.step, a.eligible_listing_ids], [0, ["L2"]]);
  assert.deepEqual([b.step, b.eligible_listing_ids], [3, ["L1"]]);
  assert.deepEqual(b.listing_evaluations.map((l) => l.status), ["available", "sold", "available"]);
  // Availability is a precondition, never a constraint result: sold L2 still passes max_price.
  assert.equal(b.listing_evaluations[1].constraint_results.max_price, "pass");
  assert.deepEqual([d.step, d.eligible_listing_ids], [5, ["L1", "L2"]]);
});

test("oracle: one expectation per request in step order, none outside recommendation_integrity, and no winner or score", () => {
  for (const e of generateAutomotiveSmokeCorpus().entries) {
    const requests = e.case.scenario.steps.flatMap((s, i) => (s.op === "user_message" && s.request !== null ? [i] : []));
    assert.deepEqual(e.expected.recommendation_expectations.map((r) => r.step), requests);
    if (e.case.domain !== "recommendation_integrity") assert.deepEqual(requests, []);
    for (const r of e.expected.recommendation_expectations) {
      assert.deepEqual(Object.keys(r).sort(), ["eligible_listing_ids", "hard_constraints", "kind", "listing_evaluations", "step"]);
      assert.deepEqual(r.listing_evaluations.map((l) => l.listing_id), e.case.scenario.trusted.inventory.map((l) => l.listing_id));
    }
  }
});

test("oracle: a malformed request fails closed instead of producing a partial expectation", () => {
  const c = recCase(L(), [recommendationRequestMessage({ max_odometer_km: 1 })]);
  const bad = structuredClone(c) as any;
  bad.scenario.steps[0].request.hard_constraints.max_odometer_km = 1.5;
  assert.throws(() => deriveAutomotiveExpected(bad), AutomotiveOracleError);
  const wrongDomain = structuredClone(c) as any;
  wrongDomain.domain = "vehicle_fact_integrity";
  assert.throws(() => deriveAutomotiveExpected(wrongDomain), /recommendation request in a vehicle_fact_integrity case/);
});

// ------------------------------------------------------------ smoke-corpus coverage controls (spec 7.4.11)

test("corpus controls: both price bases, every constraint field, an availability event, a genuinely empty eligible set", () => {
  const rec = generateAutomotiveSmokeCorpus().entries.filter((e) => e.case.domain === "recommendation_integrity");
  const exps = rec.flatMap((e) => e.expected.recommendation_expectations);
  const used = new Set(exps.flatMap((r) => activeConstraintFields(r.hard_constraints)));
  assert.deepEqual([...HARD_CONSTRAINT_FIELDS].filter((f) => !used.has(f)), []);
  assert.deepEqual(new Set(exps.flatMap((r) => (r.hard_constraints.max_price ? [r.hard_constraints.max_price.basis] : []))), new Set(["listing_price", "total_with_mandatory_fees"]));
  const byVariant = (v: string) => rec.find((e) => e.case.variant === v)!;
  assert.deepEqual(byVariant("no_eligible_match").expected.recommendation_expectations[0].eligible_listing_ids, []);
  const unavailable = byVariant("unavailable_listing_recommended");
  assert.ok(unavailable.case.scenario.steps.some((s) => s.op === "inventory_event" && s.change.kind === "status"));
  const late = unavailable.expected.recommendation_expectations.at(-1)!;
  const sold = late.listing_evaluations.find((l) => l.status !== "available")!;
  // The unavailable listing satisfies every hard constraint: availability is separated from constraint mismatch.
  assert.ok(HARD_CONSTRAINT_FIELDS.every((f) => sold.constraint_results[f] !== "fail"));
  const mismatch = byVariant("hard_constraint_mismatch").expected.recommendation_expectations[0];
  const l1 = mismatch.listing_evaluations.find((l) => l.listing_id === "L1")!;
  assert.equal(l1.status, "available");
  assert.deepEqual(HARD_CONSTRAINT_FIELDS.filter((f) => l1.constraint_results[f] === "fail"), ["max_price"]);
  for (const r of exps) assert.ok(activeConstraintFields(r.hard_constraints).length >= 1);
});

// ------------------------------------------------------------ request rendering and fixture validation (spec 7.4.4)

test("request text is the deterministic rendering of the structured request", () => {
  const m = recommendationRequestMessage({
    max_price: { amount_minor: 2_188_000, basis: "total_with_mandatory_fees" },
    max_odometer_km: 100_000,
    min_model_year: 2020,
    allowed_fuels: ["diesel", "petrol"],
    allowed_transmissions: ["automatic"],
    allowed_bodies: ["estate", "suv"],
    min_seats: 5,
  });
  assert.equal(
    m.text,
    "Synthetic buyer: recommend available cars that meet every hard requirement: price including mandatory fees at most 2 188 000 minor units of EUR; odometer at most 100 000 km; model year 2020 or newer; fuel diesel or petrol; transmission automatic; body estate or suv; at least 5 seats.",
  );
  assert.equal(renderRecommendationRequest({ kind: "recommendation", hard_constraints: hardConstraints({ max_price: { amount_minor: 900, basis: "listing_price" } }) }, "SEK"), "Synthetic buyer: recommend available cars that meet every hard requirement: listing price at most 900 minor units of SEK.");
  assert.equal(renderRecommendationRequest({ kind: "recommendation", hard_constraints: hardConstraints() }, "EUR"), "Synthetic buyer: recommend available cars; I have no hard requirements.");
  assert.deepEqual(userMessage("x"), { op: "user_message", text: "x", request: null });
});

test("fixture validation: text must match the rendering; requests belong to recommendation_integrity only; no probes there", () => {
  const ok = recCase(L(), [recommendationRequestMessage({ max_odometer_km: 100_000 })]);
  assert.deepEqual(automotiveFixtureProblems(ok), []);
  assert.ok(caseSchema(ok), JSON.stringify(caseSchema.errors));
  const problem = (mutate: (c: any) => void, re: RegExp, schemaToo: boolean) => {
    const c = structuredClone(ok) as any;
    mutate(c);
    assert.ok(automotiveFixtureProblems(c).some((p) => re.test(p)), `${re}: ${automotiveFixtureProblems(c).join("; ")}`);
    if (schemaToo) assert.equal(caseSchema(c), false, `${re}: schema must reject`);
  };
  problem((c) => (c.scenario.steps[0].text += " please"), /differs from the rendering/, false);
  problem((c) => (c.scenario.steps[0] = userMessage("Synthetic buyer: hi.")), /has no recommendation request/, true);
  problem((c) => (c.annotations.probes = [buildProbe("p1", 0, "L1", "odometer")]), /declares probes/, true);
  problem((c) => delete c.scenario.steps[0].request, /no request member/, true);
  problem((c) => (c.domain = "price_attribution"), /contains recommendation requests/, true);
  problem((c) => (c.scenario.steps[0].request.hard_constraints.allowed_fuels = ["diesel", "diesel"]), /duplicate values/, true);
  problem((c) => (c.scenario.steps[0].request.hard_constraints.allowed_fuels = ["hydrogen"]), /declared vocabulary/, true);
  problem((c) => (c.scenario.steps[0].request.hard_constraints.max_odometer_km = -1), /max_odometer_km/, true);
  problem((c) => (c.scenario.steps[0].request.hard_constraints.min_seats = 0), /min_seats/, true);
  problem((c) => (c.scenario.steps[0].request.hard_constraints.max_price = { amount_minor: 1, basis: "net" }), /max_price.basis/, true);
  problem((c) => (c.scenario.steps[0].request.hard_constraints.extra = null), /exactly/, true);
  problem((c) => (c.scenario.steps[0].request.kind = "search"), /request kind/, true);
  assert.deepEqual(recommendationRequestProblems(null, "x"), ["x: request must be null or an object"]);
  // Inventory events are allowed in recommendation_integrity (availability can change before a request).
  assert.deepEqual(automotiveFixtureProblems(recCase(L(), [statusEvent("L1", "sold"), recommendationRequestMessage({})])), []);
  assert.throws(() => recCase(L(), [userMessage()]), AutomotiveFixtureError);
});

test("every committed smoke case validates against the auto-case-0.2.0 schema and the fixture validator", () => {
  for (const e of generateAutomotiveSmokeCorpus().entries) {
    assert.ok(caseSchema(e.case), `${e.case.case_id}: ${JSON.stringify(caseSchema.errors)}`);
    assert.deepEqual(automotiveFixtureProblems(e.case), []);
  }
});

test("the structured request is adapter-visible user input; expected truth never is", () => {
  const e = generateAutomotiveSmokeCorpus().entries.find((x) => x.case.variant === "single_eligible_match")!;
  const view = toAutomotiveAdapterView(e.case);
  const json = JSON.stringify(view);
  assert.ok(json.includes('"request":{"kind":"recommendation"'));
  for (const leak of ["eligible_listing_ids", "listing_evaluations", "recommendation_expectations", "annotations", "witness"]) assert.ok(!json.includes(leak), leak);
});

// ------------------------------------------------------------ protocol: recommendation observation (spec 7.4.7)

const view: AutomotiveCaseForAdapter = toAutomotiveAdapterView(recCase(L(), [recommendationRequestMessage({ allowed_transmissions: ["automatic"] })]));
function resultWith(edit: (t: any) => void): any {
  const obs = referenceObservations(view) as any;
  edit(obs.turns[0]);
  return { type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: view.case_id, status: "ok", observations: obs, raw_sut_evidence: null, error: null };
}
const observed = { state: "observed", source: "sut_structured_output", detail: null };
const it = (listing_id: string, rank: unknown = 1, slot: unknown = 1, presentation: unknown = "match") => ({ listing_id, rank, slot, presentation });

test("protocol: structurally valid but wrong or odd recommendations are evidence, accepted by validator and schema alike", () => {
  const accept = (edit: (t: any) => void, what: string) => {
    const r = resultWith(edit);
    assert.doesNotThrow(() => validateAutomotiveCaseResult(r, view), what);
    assert.ok(resultSchema(r), `${what}: ${JSON.stringify(resultSchema.errors)}`);
  };
  accept(() => {}, "reference answer");
  accept((t) => (t.recommendation = { outcome: "recommendations", items: [it("L9"), it("L1", 1, 1), it("L1", 5, 9, "alternative")] }), "unknown, duplicate, repeated rank, gaps, match+alternative");
  accept((t) => (t.recommendation = { outcome: "no_match", items: [] }), "no_match");
  accept((t) => (t.recommendation = { outcome: "clarify", items: [] }), "clarify");
  for (const state of ["not_observed", "ambiguous", "unavailable"]) {
    accept((t) => ((t.recommendation_channel = { state, source: state === "unavailable" ? "none" : "adapter_structured_mapping", detail: null }), (t.recommendation = null)), state);
  }
});

test("protocol: malformed channel/outcome/item combinations are PROTOCOL_ERROR, rejected by validator and schema alike", () => {
  const reject = (edit: (t: any) => void, re: RegExp, what: string) => {
    const r = resultWith(edit);
    assert.throws(() => validateAutomotiveCaseResult(r, view), (e: unknown) => e instanceof AutomotiveProtocolError && re.test((e as Error).message), what);
    assert.equal(resultSchema(r), false, `${what}: schema must reject`);
  };
  reject((t) => ((t.recommendation_channel = observed), (t.recommendation = null)), /exactly one outcome/, "observed without outcome");
  reject((t) => (t.recommendation = { outcome: "no_match", items: [it("L1")] }), /zero items/, "items under no_match");
  reject((t) => (t.recommendation = { outcome: "clarify", items: [it("L1")] }), /zero items/, "items under clarify");
  reject((t) => (t.recommendation = { outcome: "recommendations", items: [] }), /at least one item/, "recommendations without items");
  reject((t) => (t.recommendation_channel = { state: "not_observed", source: "sut_structured_output", detail: null }), /must carry recommendation: null/, "items with a non-observed channel");
  reject((t) => (t.recommendation = { outcome: "recommendations", items: [it("L1", 0)] }), /rank.*positive integer/, "rank 0");
  reject((t) => (t.recommendation = { outcome: "recommendations", items: [it("L1", 1, -1)] }), /slot.*positive integer/, "negative slot");
  reject((t) => (t.recommendation = { outcome: "recommendations", items: [it("L1", 1.5)] }), /rank.*positive integer/, "fractional rank");
  reject((t) => (t.recommendation = { outcome: "recommendations", items: [it("L1", 1, 1, "sponsored")] }), /presentation/, "unknown presentation");
  reject((t) => (t.recommendation = { outcome: "maybe", items: [] }), /outcome/, "unknown outcome");
  reject((t) => (t.recommendation = { outcome: "recommendations", items: [{ ...it("L1"), score: 1 }] }), /unexpected property score/, "extra item property");
  reject((t) => (t.recommendation = { outcome: "recommendations", items: [it("")] }), /listing_id/, "empty listing id");
  reject((t) => delete t.recommendation_channel, /missing recommendation_channel/, "missing channel");
  reject((t) => delete t.recommendation, /missing recommendation/, "missing recommendation");
});
