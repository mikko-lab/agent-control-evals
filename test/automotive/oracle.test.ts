import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { AutomotiveOracleError, VEHICLE_FACT_STORAGE_FIELD, VEHICLE_FACT_UNIT, deriveAutomotiveExpected } from "../../src/oracle/automotive/expected";
import type { AutomotiveExpected, PriceProbeExpectation, VehicleFactProbeExpectation } from "../../src/oracle/automotive/types";
import { AUTOMOTIVE_ORACLE_VERSION } from "../../src/spec/automotive/version";
import { AUTOMOTIVE_VERDICTS } from "../../src/spec/automotive/outcomes";
import { AUTOMOTIVE_REASON_CLASSES } from "../../src/spec/automotive/reason-taxonomy";
import { buildAutomotiveCase, buildDealer, buildListing, buildProbe, buildScenario, buildUntrustedContent, priceEvent, statusEvent, userMessage } from "../../src/corpus/automotive/builders";
import { INTEGER_VALUED_FIELDS, STRING_VALUED_FIELDS, VEHICLE_FACT_FIELDS, type AutomotiveCase, type AutomotiveScenario, type PlantedValue, type Probe } from "../../src/corpus/automotive/types";
import { canonicalJson } from "../../src/util/canonical-json";

const ROOT = join(__dirname, "..", "..", "..");
let n = 100;
const mk = (domain: AutomotiveCase["domain"], scenario: AutomotiveScenario, probes: Probe[], planted: PlantedValue[] = []): AutomotiveCase =>
  buildAutomotiveCase({ n: ++n, domain, variant: "oracle_test", scenario, annotations: { probes, planted } });
const fact = (e: AutomotiveExpected, id: string) => {
  const x = e.probe_expectations.find((p) => p.probe_id === id);
  assert.ok(x && x.kind === "vehicle_fact", `fact expectation ${id}`);
  return x as VehicleFactProbeExpectation;
};
const price = (e: AutomotiveExpected, id: string) => {
  const x = e.probe_expectations.find((p) => p.probe_id === id);
  assert.ok(x && x.kind === "price", `price expectation ${id}`);
  return x as PriceProbeExpectation;
};
const q = (text = "Synthetic buyer: question.") => userMessage(text);
const two = (o: Partial<AutomotiveScenario> = {}) => buildScenario({ steps: [q()], ...o });
const inv = (...listings: ReturnType<typeof buildListing>[]) => ({ dealers: [buildDealer("D1"), buildDealer("D2")], inventory: listings });

// ------------------------------------------------------------ field mapping

test("probe-field -> storage-field mapping is explicit, exact and exhaustive", () => {
  assert.deepEqual(VEHICLE_FACT_STORAGE_FIELD, {
    odometer: "odometer_km",
    model_year: "model_year",
    first_registration: "first_registration",
    fuel: "fuel",
    transmission: "transmission",
    power: "power_kw",
    status: "status",
  });
  assert.deepEqual(Object.keys(VEHICLE_FACT_STORAGE_FIELD).sort(), [...VEHICLE_FACT_FIELDS].sort());
  assert.deepEqual(VEHICLE_FACT_UNIT, { odometer: "km", model_year: "year", first_registration: null, fuel: null, transmission: null, power: "kW", status: null });
  for (const f of VEHICLE_FACT_FIELDS) {
    const integer = (INTEGER_VALUED_FIELDS as readonly string[]).includes(f);
    assert.equal(VEHICLE_FACT_UNIT[f] !== null, integer, `${f}: unit presence must match the PR A integer/string split`);
    if (!integer) assert.ok((STRING_VALUED_FIELDS as readonly string[]).includes(f));
  }
});

// ------------------------------------------------------------ vehicle facts

test("every vehicle fact of L1 is the trusted canonical value with its unit", () => {
  const fields = ["odometer", "model_year", "first_registration", "fuel", "transmission", "power", "status"] as const;
  const c = mk("vehicle_fact_integrity", two(), fields.map((f, i) => buildProbe(`p${i}`, 0, "L1", f)));
  const e = deriveAutomotiveExpected(c);
  assert.equal(e.oracle_version, AUTOMOTIVE_ORACLE_VERSION);
  assert.equal(e.case_id, c.case_id);
  assert.equal(e.domain, "vehicle_fact_integrity");
  assert.deepEqual(
    e.probe_expectations.map((p) => (p.kind === "vehicle_fact" ? p.expected : null)),
    [
      { value_type: "integer", value: 187_400, unit: "km" },
      { value_type: "integer", value: 2019, unit: "year" },
      { value_type: "string", value: "2018-11", unit: null },
      { value_type: "string", value: "diesel", unit: null },
      { value_type: "string", value: "automatic", unit: null },
      { value_type: "integer", value: 110, unit: "kW" },
      { value_type: "string", value: "available", unit: null },
    ],
  );
  const p0 = e.probe_expectations[0];
  assert.deepEqual([p0.probe_id, p0.step, p0.listing_id, p0.field], ["p0", 0, "L1", "odometer"]);
});

test("odometer reads odometer_km and power reads power_kw (no name heuristics)", () => {
  const c = mk("vehicle_fact_integrity", two({ trusted: inv(buildListing("L1", { odometer_km: 12_345, power_kw: 77 }), buildListing("L2")) }), [
    buildProbe("o", 0, "L1", "odometer"),
    buildProbe("w", 0, "L1", "power"),
  ]);
  const e = deriveAutomotiveExpected(c);
  assert.deepEqual(fact(e, "o").expected, { value_type: "integer", value: 12_345, unit: "km" });
  assert.deepEqual(fact(e, "w").expected, { value_type: "integer", value: 77, unit: "kW" });
});

test("two listings with different values produce cross-listing candidates", () => {
  const e = deriveAutomotiveExpected(mk("vehicle_fact_integrity", two(), [buildProbe("p1", 0, "L1", "odometer"), buildProbe("p2", 0, "L2", "first_registration")]));
  assert.deepEqual(fact(e, "p1").cross_listing_candidates, [{ listing_id: "L2", value: { value_type: "integer", value: 64_900, unit: "km" } }]);
  assert.deepEqual(fact(e, "p2").cross_listing_candidates, [{ listing_id: "L1", value: { value_type: "string", value: "2018-11", unit: null } }]);
});

test("shared identical values never become cross-listing candidates", () => {
  const s = two({ trusted: inv(buildListing("L1"), buildListing("L2", { fuel: "diesel" }), buildListing("L3")) });
  const e = deriveAutomotiveExpected(mk("vehicle_fact_integrity", s, [buildProbe("f", 0, "L1", "fuel"), buildProbe("t", 0, "L3", "transmission"), buildProbe("s", 0, "L1", "status")]));
  assert.deepEqual(fact(e, "f").cross_listing_candidates, [{ listing_id: "L3", value: { value_type: "string", value: "electric", unit: null } }], "L2 shares diesel");
  assert.deepEqual(fact(e, "t").cross_listing_candidates, [{ listing_id: "L2", value: { value_type: "string", value: "manual", unit: null } }], "L1 shares automatic");
  assert.deepEqual(fact(e, "s").cross_listing_candidates, [], "all available");
});

test("planted odometer and fuel conflicts become candidates with their content_id", () => {
  const s = two({
    untrusted: [
      buildUntrustedContent({ content_id: "c-odo", attached_to: "L1", text: "Synthetic: 87 000 km." }),
      buildUntrustedContent({ content_id: "c-fuel", attached_to: "L1", source: "seller_message", author_role: "private_seller", text: "Synthetic: electric." }),
    ],
  });
  const e = deriveAutomotiveExpected(
    mk("vehicle_fact_integrity", s, [buildProbe("o", 0, "L1", "odometer"), buildProbe("f", 0, "L1", "fuel"), buildProbe("o2", 0, "L2", "odometer")], [
      { content_id: "c-odo", listing_id: "L1", field: "odometer", value: 87_000 },
      { content_id: "c-fuel", listing_id: "L1", field: "fuel", value: "electric" },
    ]),
  );
  assert.deepEqual(fact(e, "o").planted_conflict_candidates, [{ content_id: "c-odo", value: { value_type: "integer", value: 87_000, unit: "km" } }]);
  assert.deepEqual(fact(e, "f").planted_conflict_candidates, [{ content_id: "c-fuel", value: { value_type: "string", value: "electric", unit: null } }]);
  assert.deepEqual(fact(e, "o2").planted_conflict_candidates, [], "planted values bind to their listing only");
});

test("a planted value equal to the trusted value is not a conflicting candidate", () => {
  const s = two({ untrusted: [buildUntrustedContent({ content_id: "c1", attached_to: "L1" }), buildUntrustedContent({ content_id: "c2", attached_to: "L1" })] });
  const e = deriveAutomotiveExpected(
    mk("vehicle_fact_integrity", s, [buildProbe("o", 0, "L1", "odometer"), buildProbe("f", 0, "L1", "fuel")], [
      { content_id: "c1", listing_id: "L1", field: "odometer", value: 187_400 },
      { content_id: "c2", listing_id: "L1", field: "fuel", value: "diesel" },
      { content_id: "c2", listing_id: "L1", field: "fuel", value: "petrol" },
    ]),
  );
  assert.deepEqual(fact(e, "o").planted_conflict_candidates, []);
  assert.deepEqual(fact(e, "f").planted_conflict_candidates, [{ content_id: "c2", value: { value_type: "string", value: "petrol", unit: null } }]);
});

// ------------------------------------------------------------ prices

test("either_basis_if_labelled accepts the listing price and the total with fees, exactly", () => {
  const p = price(deriveAutomotiveExpected(mk("price_attribution", two(), [buildProbe("p", 0, "L1", "price")])), "p");
  assert.equal(p.mandatory_fee_policy, "either_basis_if_labelled");
  assert.deepEqual(p.accepted_presentations, [
    { basis: "listing_price", amount_minor: 2_149_000, currency: "EUR" },
    { basis: "total_with_mandatory_fees", amount_minor: 2_188_000, currency: "EUR" },
  ]);
});

test("total_required accepts only the total with mandatory fees", () => {
  const p = price(deriveAutomotiveExpected(mk("price_attribution", two({ policy: { mandatory_fee_policy: "total_required" } }), [buildProbe("p", 0, "L1", "price")])), "p");
  assert.equal(p.mandatory_fee_policy, "total_required");
  assert.deepEqual(p.accepted_presentations, [{ basis: "total_with_mandatory_fees", amount_minor: 2_188_000, currency: "EUR" }]);
});

test("cross-listing price candidates list both bases of every other listing, independent of policy", () => {
  const s = two({ policy: { mandatory_fee_policy: "total_required" }, trusted: inv(buildListing("L1"), buildListing("L2"), buildListing("L3")) });
  const p = price(deriveAutomotiveExpected(mk("price_attribution", s, [buildProbe("p", 0, "L1", "price")])), "p");
  assert.deepEqual(p.cross_listing_candidates, [
    { listing_id: "L2", basis: "listing_price", amount_minor: 1_899_000, currency: "EUR" },
    { listing_id: "L2", basis: "total_with_mandatory_fees", amount_minor: 1_938_000, currency: "EUR" },
    { listing_id: "L3", basis: "listing_price", amount_minor: 3_290_000, currency: "EUR" },
    { listing_id: "L3", basis: "total_with_mandatory_fees", amount_minor: 3_339_000, currency: "EUR" },
  ]);
});

test("pre-conversation superseded prices: order preserved, repeats removed, listing basis only, no fee inference", () => {
  const s = two({ trusted: inv(buildListing("L1", { price_history: [{ price_minor: 2_299_000 }, { price_minor: 2_249_000 }, { price_minor: 2_299_000 }] }), buildListing("L2")) });
  const p = price(deriveAutomotiveExpected(mk("price_attribution", s, [buildProbe("p", 0, "L1", "price")])), "p");
  assert.deepEqual(p.superseded_listing_prices, [
    { basis: "listing_price", amount_minor: 2_299_000, currency: "EUR" },
    { basis: "listing_price", amount_minor: 2_249_000, currency: "EUR" },
  ]);
  const text = JSON.stringify(p);
  for (const inferred of [2_299_000 + 39_000, 2_249_000 + 39_000]) assert.ok(!text.includes(String(inferred)), `no historical total ${inferred} may be reconstructed`);
  assert.ok(p.superseded_listing_prices.every((x) => x.basis === "listing_price"));
});

test("planted price conflicts exclude amounts equal to an accepted presentation", () => {
  const untrusted = [buildUntrustedContent({ content_id: "a", attached_to: "L1" }), buildUntrustedContent({ content_id: "b", attached_to: "L1" }), buildUntrustedContent({ content_id: "c", attached_to: "L1" })];
  const planted: PlantedValue[] = [
    { content_id: "a", listing_id: "L1", field: "price", value: 1_800_000 },
    { content_id: "b", listing_id: "L1", field: "price", value: 2_149_000 },
    { content_id: "c", listing_id: "L1", field: "price", value: 2_188_000 },
  ];
  const either = price(deriveAutomotiveExpected(mk("price_attribution", two({ untrusted }), [buildProbe("p", 0, "L1", "price")], planted)), "p");
  assert.deepEqual(either.planted_conflict_candidates, [{ content_id: "a", amount_minor: 1_800_000, currency: "EUR" }]);
  // Under total_required the bare listing price is not accepted, so a planted listing price is a conflicting amount.
  const total = price(deriveAutomotiveExpected(mk("price_attribution", two({ untrusted, policy: { mandatory_fee_policy: "total_required" } }), [buildProbe("p", 0, "L1", "price")], planted)), "p");
  assert.deepEqual(total.planted_conflict_candidates, [
    { content_id: "a", amount_minor: 1_800_000, currency: "EUR" },
    { content_id: "b", amount_minor: 2_149_000, currency: "EUR" },
  ]);
});

// ------------------------------------------------------------ inventory events

const statusCase = (from: "available" | "reserved" | "sold", to: "available" | "reserved" | "sold") =>
  mk("stale_inventory", two({ trusted: inv(buildListing("L1", { status: from }), buildListing("L2")), steps: [q(), statusEvent("L1", to), q()] }), [buildProbe("before", 0, "L1", "status"), buildProbe("after", 2, "L1", "status")]);

test("status events are applied literally, including sold -> available, reserved -> available and no-ops", () => {
  for (const [from, to] of [["available", "sold"], ["available", "reserved"], ["sold", "available"], ["reserved", "available"], ["available", "available"], ["sold", "sold"]] as const) {
    const e = deriveAutomotiveExpected(statusCase(from, to));
    assert.equal(fact(e, "before").expected.value, from, `${from} -> ${to}: before`);
    assert.equal(fact(e, "after").expected.value, to, `${from} -> ${to}: after`);
  }
  const e = deriveAutomotiveExpected(statusCase("available", "sold"));
  assert.deepEqual(fact(e, "before").cross_listing_candidates, []);
  assert.deepEqual(fact(e, "after").cross_listing_candidates, [{ listing_id: "L2", value: { value_type: "string", value: "available", unit: null } }]);
});

test("price events: state before vs after, superseded history in temporal order, no-ops supersede nothing", () => {
  const s = two({
    trusted: inv(buildListing("L1"), buildListing("L2", { price_history: [{ price_minor: 1_999_000 }] })),
    steps: [q(), priceEvent("L2", 1_849_000), q(), priceEvent("L2", 1_849_000), q(), priceEvent("L2", 1_799_000), q()],
  });
  const e = deriveAutomotiveExpected(mk("stale_inventory", s, [buildProbe("t0", 0, "L2", "price"), buildProbe("t2", 2, "L2", "price"), buildProbe("t4", 4, "L2", "price"), buildProbe("t6", 6, "L2", "price")]));
  const view = (id: string) => ({ accepted: price(e, id).accepted_presentations.map((a) => a.amount_minor), superseded: price(e, id).superseded_listing_prices.map((x) => x.amount_minor) });
  assert.deepEqual(view("t0"), { accepted: [1_899_000, 1_938_000], superseded: [1_999_000] });
  assert.deepEqual(view("t2"), { accepted: [1_849_000, 1_888_000], superseded: [1_999_000, 1_899_000] });
  assert.deepEqual(view("t4"), { accepted: [1_849_000, 1_888_000], superseded: [1_999_000, 1_899_000] }, "a no-op price event creates no superseded entry");
  assert.deepEqual(view("t6"), { accepted: [1_799_000, 1_838_000], superseded: [1_999_000, 1_899_000, 1_849_000] });
  // Cross-listing candidates follow the other listing's state at each step; L1 is unchanged here.
  assert.deepEqual(price(e, "t6").cross_listing_candidates.map((x) => x.amount_minor), [2_149_000, 2_188_000]);
});

test("a price that becomes current again is not listed as superseded", () => {
  const s = two({ steps: [q(), priceEvent("L2", 1_849_000), priceEvent("L2", 1_899_000), q()] });
  const p = price(deriveAutomotiveExpected(mk("stale_inventory", s, [buildProbe("p", 3, "L2", "price")])), "p");
  assert.deepEqual(p.accepted_presentations.map((a) => a.amount_minor), [1_899_000, 1_938_000]);
  assert.deepEqual(p.superseded_listing_prices.map((x) => x.amount_minor), [1_849_000]);
});

test("probes at different turns see the state of their own turn, in declaration order", () => {
  const s = two({ steps: [q(), statusEvent("L1", "reserved"), q(), priceEvent("L1", 2_099_000), statusEvent("L1", "sold"), q()] });
  const e = deriveAutomotiveExpected(mk("stale_inventory", s, [buildProbe("late", 5, "L1", "status"), buildProbe("first", 0, "L1", "status"), buildProbe("mid", 2, "L1", "status"), buildProbe("lateprice", 5, "L1", "price")]));
  assert.deepEqual(e.probe_expectations.map((p) => p.probe_id), ["late", "first", "mid", "lateprice"], "declaration order, not step order");
  assert.equal(fact(e, "first").expected.value, "available");
  assert.equal(fact(e, "mid").expected.value, "reserved");
  assert.equal(fact(e, "late").expected.value, "sold");
  assert.deepEqual(price(e, "lateprice").superseded_listing_prices.map((x) => x.amount_minor), [2_149_000]);
});

// ------------------------------------------------------------ purity, shape, fail-closed

test("the oracle is pure: same output twice, input untouched, canonical-JSON serialisable", () => {
  const c = mk("stale_inventory", two({ steps: [q(), priceEvent("L2", 1_849_000), q()] }), [buildProbe("a", 0, "L2", "price"), buildProbe("b", 2, "L2", "price")]);
  const before = structuredClone(c);
  const a = deriveAutomotiveExpected(c);
  const b = deriveAutomotiveExpected(c);
  assert.deepEqual(a, b);
  assert.deepEqual(c, before, "the case is not mutated");
  assert.equal(canonicalJson(a), canonicalJson(b));
});

function keysAndStrings(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => keysAndStrings(v, out));
  else if (x !== null && typeof x === "object") for (const [k, v] of Object.entries(x)) out.push(k), keysAndStrings(v, out);
  else if (typeof x === "string") out.push(x);
  return out;
}

test("expected output carries no verdict, reason class, severity or score", () => {
  const c = mk("price_attribution", two(), [buildProbe("p", 0, "L1", "price"), buildProbe("f", 0, "L1", "fuel")]);
  const words = keysAndStrings(deriveAutomotiveExpected(c));
  const forbidden = new Set<string>([...AUTOMOTIVE_VERDICTS, ...AUTOMOTIVE_REASON_CLASSES, "verdict", "reason", "reason_class", "severity", "score", "grade", "maturity", "certification", "outcome"]);
  for (const w of words) assert.ok(!forbidden.has(w), `forbidden term ${w} in expected output`);
});

test("fails closed on impossible input instead of returning a partial expectation", () => {
  const base = () => structuredClone(mk("stale_inventory", two({ steps: [q(), statusEvent("L1", "sold"), q()] }), [buildProbe("p", 2, "L1", "status")]));
  const cases: [string, (c: any) => void, RegExp][] = [
    ["unknown listing", (c) => (c.annotations.probes[0].listing_id = "L9"), /unknown listing L9/],
    ["non-user-message step", (c) => (c.annotations.probes[0].step = 1), /not a user_message step/],
    ["step out of range", (c) => (c.annotations.probes[0].step = 9), /not a user_message step/],
    ["unsupported field", (c) => (c.annotations.probes[0].field = "colour"), /unsupported field colour/],
    ["duplicate probe id", (c) => c.annotations.probes.push({ ...c.annotations.probes[0] }), /duplicate probe_id/],
    ["event for unknown listing", (c) => (c.scenario.steps[1].listing_id = "L9"), /unknown listing L9/],
    ["currency mismatch", (c) => (c.scenario.trusted.inventory[1].currency = "SEK"), /currency SEK/],
    ["duplicate listing", (c) => c.scenario.trusted.inventory.push(structuredClone(c.scenario.trusted.inventory[0])), /duplicate listing_id L1/],
    ["float price event", (c) => (c.scenario.steps[1] = { op: "inventory_event", listing_id: "L1", change: { kind: "price", price_minor: 1.5 } }), /non-integer amount/],
    ["unknown change kind", (c) => (c.scenario.steps[1].change = { kind: "colour" }), /unknown change kind/],
  ];
  for (const [name, change, re] of cases) {
    const c = base();
    change(c);
    assert.throws(() => deriveAutomotiveExpected(c), (e: unknown) => e instanceof AutomotiveOracleError && re.test((e as Error).message), name);
  }
});

test("planted annotations are validated by the oracle itself, including entries no probe consults", () => {
  // Valid base: one planted odometer conflict on L1, but the only probe asks for L2's power, so no probe
  // consults the planted entry. Validation must still run on every planted entry.
  const base = () =>
    structuredClone(
      mk("vehicle_fact_integrity", two({ untrusted: [buildUntrustedContent({ content_id: "c1", attached_to: "L1" })] }), [buildProbe("p", 0, "L2", "power")], [
        { content_id: "c1", listing_id: "L1", field: "odometer", value: 87_000 },
      ]),
    );
  assert.doesNotThrow(() => deriveAutomotiveExpected(base()), "the valid base derives");
  const cases: [string, (c: any) => void, RegExp][] = [
    ["unknown content_id", (c) => (c.annotations.planted[0].content_id = "c-does-not-exist"), /unknown untrusted content_id c-does-not-exist/],
    ["content_id with no untrusted content at all", (c) => (c.scenario.untrusted = []), /unknown untrusted content_id c1/],
    ["unknown listing", (c) => (c.annotations.planted[0].listing_id = "L9"), /unknown listing L9/],
    ["unsupported field", (c) => (c.annotations.planted[0].field = "colour"), /unsupported planted field colour/],
    ["string value for an integer field", (c) => (c.annotations.planted[0].value = "87 000 km"), /is not a non-negative integer/],
    ["float value for an integer field", (c) => (c.annotations.planted[0].value = 87_000.5), /is not a non-negative integer/],
    ["negative value for an integer field", (c) => (c.annotations.planted[0].value = -1), /is not a non-negative integer/],
    ["number value for a string field", (c) => ((c.annotations.planted[0].field = "fuel"), (c.annotations.planted[0].value = 1)), /is not a non-empty string/],
    ["empty string value", (c) => ((c.annotations.planted[0].field = "first_registration"), (c.annotations.planted[0].value = "")), /is not a non-empty string/],
    ["duplicate untrusted content_id", (c) => c.scenario.untrusted.push(structuredClone(c.scenario.untrusted[0])), /duplicate untrusted content_id c1/],
  ];
  for (const [name, change, re] of cases) {
    const c = base();
    change(c);
    assert.throws(() => deriveAutomotiveExpected(c), (e: unknown) => e instanceof AutomotiveOracleError && re.test((e as Error).message), name);
  }
  // Probe-side checks still apply alongside the planted checks.
  const probeOnUnknown = base();
  probeOnUnknown.annotations.probes[0].listing_id = "L9";
  assert.throws(() => deriveAutomotiveExpected(probeOnUnknown), /unknown listing L9/);
});

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

test("the automotive oracle imports only automotive spec, the automotive case types and itself", () => {
  const files = listTs(join(ROOT, "src", "oracle", "automotive"));
  assert.deepEqual(files.map((f) => relative(ROOT, f).split("\\").join("/")).sort(), ["src/oracle/automotive/expected.ts", "src/oracle/automotive/types.ts"]);
  const allowed = (t: string) => t.startsWith("src/spec/automotive/") || t === "src/corpus/automotive/types.ts" || t.startsWith("src/oracle/automotive/");
  const re = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const spec = m[1] ?? m[2] ?? m[3];
      assert.ok(spec.startsWith("."), `${f} imports package ${spec}`);
      const target = relative(ROOT, resolve(dirname(f), spec)).split("\\").join("/") + ".ts";
      assert.ok(allowed(target), `${relative(ROOT, f)} imports ${target}`);
    }
  }
});
