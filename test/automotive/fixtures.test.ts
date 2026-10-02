import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { canonicalJson } from "../../src/util/canonical-json";
import { SYNTHETIC_DEALERS, SYNTHETIC_LISTINGS } from "../../src/corpus/automotive/fixtures";
import {
  AutomotiveFixtureError,
  EXAMPLE_CASE_BUILDERS,
  automotiveCaseId,
  automotiveFixtureProblems,
  buildAutomotiveCase,
  buildDealer,
  buildListing,
  buildProbe,
  buildScenario,
  buildUntrustedContent,
  exampleContradictionCase,
  exampleStaleInventoryCase,
  exampleVehicleFactCase,
  priceEvent,
  statusEvent,
  toAutomotiveAdapterView,
  userMessage,
} from "../../src/corpus/automotive/builders";
import type { AutomotiveCase } from "../../src/corpus/automotive/types";

const ROOT = join(__dirname, "..", "..", "..");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateCase = ajv.compile(JSON.parse(readFileSync(join(ROOT, "schemas", "automotive", "case.schema.json"), "utf8")));
const mut = (c: AutomotiveCase): any => structuredClone(c);

test("builders are deterministic (deep-equal and byte-identical canonical JSON)", () => {
  for (const b of EXAMPLE_CASE_BUILDERS) {
    const a = b();
    const c = b();
    assert.deepEqual(a, c);
    assert.equal(canonicalJson(a), canonicalJson(c), "examples must serialise as canonical JSON (integers only, no undefined)");
  }
  assert.deepEqual(buildScenario(), buildScenario());
  assert.deepEqual(buildListing("L2"), buildListing("L2"));
});

test("case ids use the automotive namespace with a fixed six-digit suffix", () => {
  assert.equal(automotiveCaseId(1), "auto-case-000001");
  assert.equal(automotiveCaseId(999_999), "auto-case-999999");
  for (const n of [0, -1, 1_000_000, 1.5]) assert.throws(() => automotiveCaseId(n), AutomotiveFixtureError);
});

test("returned objects share no mutable nested state with each other or with the defaults", () => {
  const a = buildScenario();
  const b = buildScenario();
  a.trusted.inventory[0].odometer_km = 1;
  a.trusted.inventory[0].price_history.push({ price_minor: 1 });
  a.trusted.dealers[0].display_name = "changed";
  a.steps.push(userMessage("changed"));
  assert.equal(b.trusted.inventory[0].odometer_km, 187_400);
  assert.deepEqual(b.trusted.inventory[0].price_history, []);
  assert.equal(b.trusted.dealers[0].display_name, "Synthetic Dealer One");
  assert.equal(b.steps.length, 1);
  assert.equal(SYNTHETIC_LISTINGS.L1.odometer_km, 187_400);
  assert.deepEqual(SYNTHETIC_LISTINGS.L1.price_history, []);

  const c1 = exampleStaleInventoryCase();
  const c2 = exampleStaleInventoryCase();
  c1.annotations.probes[0].field = "fuel";
  c1.scenario.steps.length = 1;
  assert.equal(c2.annotations.probes[0].field, "status");
  assert.equal(c2.scenario.steps.length, 5);
});

test("defaults are frozen and overrides never mutate them", () => {
  assert.ok(Object.isFrozen(SYNTHETIC_LISTINGS) && Object.isFrozen(SYNTHETIC_LISTINGS.L1) && Object.isFrozen(SYNTHETIC_LISTINGS.L1.price_history));
  assert.throws(() => {
    (SYNTHETIC_LISTINGS.L1 as { odometer_km: number }).odometer_km = 1;
  }, TypeError);
  const history = [{ price_minor: 2_249_000 }];
  const l = buildListing("L1", { listing_id: "L9", odometer_km: 5, price_history: history });
  assert.equal(l.listing_id, "L9");
  assert.equal(l.odometer_km, 5);
  history[0].price_minor = 1;
  assert.equal(l.price_history[0].price_minor, 2_249_000, "override objects are copied, not aliased");
  assert.equal(SYNTHETIC_LISTINGS.L1.listing_id, "L1");
  assert.deepEqual(SYNTHETIC_LISTINGS.L1.price_history, []);
  const d = buildDealer("D2", { display_name: "Synthetic Dealer Nine" });
  assert.equal(d.display_name, "Synthetic Dealer Nine");
  assert.equal(SYNTHETIC_DEALERS.D2.display_name, "Synthetic Dealer Two");
});

test("defaults contain no VIN-like, registration-plate-like or personal contact data", () => {
  const corpus = JSON.stringify([SYNTHETIC_DEALERS, SYNTHETIC_LISTINGS, ...EXAMPLE_CASE_BUILDERS.map((b) => b())]);
  assert.doesNotMatch(corpus, /\b[A-HJ-NPR-Z0-9]{17}\b/, "VIN-like 17-character identifier");
  assert.doesNotMatch(corpus, /\b[A-Z]{1,3}-[0-9]{1,4}\b/, "registration-plate-like identifier");
  assert.doesNotMatch(corpus, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "e-mail address");
  assert.doesNotMatch(corpus, /\+?[0-9][0-9 ]{8,}[0-9]/, "phone-number-like digit run");
  for (const l of Object.values(SYNTHETIC_LISTINGS)) assert.equal(l.make, "ExampleMake");
  for (const d of Object.values(SYNTHETIC_DEALERS)) assert.match(d.display_name, /^Synthetic Dealer /);
});

test("trusted and untrusted data stay in separate structures; contradictions are constructed, not judged", () => {
  const c = exampleContradictionCase();
  const listing = c.scenario.trusted.inventory.find((l) => l.listing_id === "L1")!;
  const content = c.scenario.untrusted[0];
  assert.equal(listing.odometer_km, 187_400, "trusted value is the authoritative one");
  assert.match(content.text, /87 000 km/);
  assert.deepEqual(Object.keys(content).sort(), ["attached_to", "author_role", "content_id", "source", "text"], "untrusted items carry no trusted fields or trust flag");
  assert.ok(!("text" in listing), "trusted listings carry no free text");
  assert.ok(!JSON.stringify(c.scenario.trusted).includes("87000"), "the planted value never enters trusted facts");
  assert.deepEqual(c.annotations.planted, [{ content_id: "content-1", listing_id: "L1", field: "odometer", value: 87_000 }]);
  // No verdict, expected value or oracle output exists in the case.
  for (const k of ["expected", "verdict", "outcome"]) assert.ok(!(k in c) && !(k in c.annotations));
});

test("the adapter view drops every harness-only annotation", () => {
  for (const b of EXAMPLE_CASE_BUILDERS) {
    const c = b();
    const view = toAutomotiveAdapterView(c);
    assert.ok(!("annotations" in view));
    const text = JSON.stringify(view);
    assert.ok(!text.includes("\"probes\"") && !text.includes("\"planted\"") && !text.includes("probe_id"));
    assert.deepEqual(view.scenario, c.scenario);
    view.scenario.steps.length = 0;
    assert.ok(c.scenario.steps.length > 0, "the view is a copy");
  }
});

test("examples and builder output pass the automotive JSON Schema", () => {
  for (const b of EXAMPLE_CASE_BUILDERS) assert.ok(validateCase(b()), `${b.name}: ${JSON.stringify(validateCase.errors)}`);
  const custom = buildAutomotiveCase({
    n: 42,
    domain: "stale_inventory",
    variant: "custom_reserved_transition",
    scenario: buildScenario({
      trusted: { dealers: [buildDealer("D1")], inventory: [buildListing("L3", { price_history: [{ price_minor: 3_390_000 }] })] },
      untrusted: [buildUntrustedContent({ content_id: "content-7", attached_to: null, source: "user_review", author_role: "third_party", text: "Synthetic review text." })],
      steps: [userMessage(), statusEvent("L3", "reserved"), priceEvent("L3", 3_190_000), userMessage("Synthetic buyer: is L3 still available?")],
    }),
    annotations: { probes: [buildProbe("p1", 3, "L3", "status")], planted: [] },
  });
  assert.ok(validateCase(custom), JSON.stringify(validateCase.errors));
});

test("structural and referential fixture problems fail closed at construction", () => {
  const cases: [string, (c: any) => void, RegExp][] = [
    ["unknown dealer", (c) => (c.scenario.trusted.inventory[0].dealer_id = "D9"), /unknown dealer_id D9/],
    ["duplicate listing", (c) => c.scenario.trusted.inventory.push(structuredClone(c.scenario.trusted.inventory[0])), /duplicate listing_id L1/],
    ["float price", (c) => (c.scenario.trusted.inventory[0].price_minor = 10.5), /price_minor 10.5/],
    ["currency mismatch", (c) => (c.scenario.trusted.inventory[1].currency = "SEK"), /differs from scenario currency/],
    ["probe on unknown listing", (c) => (c.annotations.probes[0].listing_id = "L9"), /unknown listing L9/],
    ["probe step out of range", (c) => (c.annotations.probes[0].step = 7), /is not a user_message step/],
    ["planted on unknown content", (c) => c.annotations.planted.push({ content_id: "content-9", listing_id: "L1", field: "odometer", value: 1 }), /unknown content_id/],
    ["event in non-stale domain", (c) => c.scenario.steps.push(statusEvent("L1", "sold")), /transitions belong to stale_inventory/],
    ["planned domain", (c) => (c.domain = "human_ai_handoff"), /not an executable auto-0.1.0 domain/],
    ["ACS-style id", (c) => (c.case_id = "case-000001"), /case_id case-000001/],
  ];
  for (const [name, change, expected] of cases) {
    const c = mut(exampleVehicleFactCase());
    change(c);
    assert.match(automotiveFixtureProblems(c).join("; "), expected, name);
  }
  assert.deepEqual(automotiveFixtureProblems(exampleVehicleFactCase()), []);
  const s = exampleStaleInventoryCase();
  assert.match(automotiveFixtureProblems({ ...s, annotations: { probes: [buildProbe("p1", 1, "L1", "status")], planted: [] } }).join(";"), /step 1 is not a user_message step/, "a probe must point at a user turn, not at an inventory event");
  assert.throws(
    () => buildAutomotiveCase({ n: 5, domain: "stale_inventory", variant: "no_events", scenario: buildScenario() }),
    (e: unknown) => e instanceof AutomotiveFixtureError && /no inventory_event/.test((e as Error).message),
  );
});
