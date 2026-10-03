import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import {
  AUTOMOTIVE_OBSERVATION_SOURCES,
  AUTOMOTIVE_OBSERVATION_STATES,
  AutomotiveProtocolError,
  CASE_RESULT_STATUSES,
  CLAIM_ATTRIBUTION_KINDS,
  EVENT_DELIVERY_SOURCES,
  EVENT_DELIVERY_STATES,
  OBSERVED_FACT_FIELDS,
  OBSERVED_FACT_UNIT,
  OBSERVED_PRICE_BASES,
  OBSERVED_STATUSES,
  PRICE_TEMPORAL_QUALIFIERS,
  REFERENCE_KINDS,
  UNVERIFIABLE_CLASSIFICATIONS,
  automotiveCaseMessage,
  validateAutomotiveCaseResult,
  validateAutomotiveHello,
} from "../../src/adapter/automotive/protocol";
import { exampleContradictionCase, examplePriceAttributionCase, exampleStaleInventoryCase, exampleVehicleFactCase, toAutomotiveAdapterView } from "../../src/corpus/automotive/builders";
import { FUELS, INVENTORY_CHANGE_KINDS, INVENTORY_STATUSES, PROBE_FIELDS, TRANSMISSIONS, type AutomotiveCaseForAdapter } from "../../src/corpus/automotive/types";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION } from "../../src/spec/automotive/version";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";

const ROOT = join(__dirname, "..", "..", "..");
const V = AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION;
const load = (f: string) => JSON.parse(readFileSync(join(ROOT, "schemas", "automotive", f), "utf8"));
const protocolSchema = load("adapter-protocol.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(load("case.schema.json"));
ajv.addSchema(protocolSchema, "auto-proto");
const schemaHello = ajv.getSchema("auto-proto#/$defs/helloResponse")!;
const schemaResult = ajv.getSchema("auto-proto#/$defs/caseResult")!;
const schemaOutgoing = ajv.getSchema("auto-proto#/$defs/harnessToAdapter")!;
const defs = protocolSchema.$defs;

// ------------------------------------------------------------ helpers

const stale = toAutomotiveAdapterView(exampleStaleInventoryCase()); // steps: user, L1 -> sold, user, L2 price 1 849 000, user
const fact = toAutomotiveAdapterView(exampleVehicleFactCase()); // one user step, L1 + L2
const ch = (state: string, source = "sut_structured_output", detail: string | null = null) => ({ state, source: state === "unavailable" ? "none" : source, detail });
const odo = (listing_id = "L1", value: unknown = 187_400, unit: unknown = "km", attribution: unknown = { kind: "trusted_fact" }) => ({ kind: "vehicle_fact", listing_id, field: "odometer", value, unit, attribution });
const price = (o: Record<string, unknown> = {}) => ({ kind: "price", listing_id: "L1", field: "price", amount_minor: 2_149_000, currency: "EUR", basis: "listing_price", temporal_qualifier: "current", attribution: { kind: "trusted_fact" }, ...o });
const turnAt = (step: number, o: Record<string, unknown> = {}) => ({
  step,
  claim_channel: ch("observed"),
  claims: [odo()],
  unverifiable_claims: [],
  reference_channel: ch("observed", "adapter_structured_mapping"),
  references: [{ listing_id: "L1", kind: "mentioned" }],
  status_channel: ch("observed", "adapter_structured_mapping"),
  status_presentations: [{ listing_id: "L1", status: "available" }],
  ...o,
});
const silent = (step: number, state = "not_observed") => ({ step, claim_channel: ch(state), claims: [], unverifiable_claims: [], reference_channel: ch(state), references: [], status_channel: ch(state), status_presentations: [] });

/** A well-formed result for a view: one turn per user step, one delivered acknowledgement per event. */
function okResult(v: AutomotiveCaseForAdapter, turnFor: (step: number) => unknown = (s) => turnAt(s)): any {
  const turns: unknown[] = [];
  const acks: unknown[] = [];
  v.scenario.steps.forEach((s, i) => {
    if (s.op === "user_message") turns.push(turnFor(i));
    else acks.push({ step: i, listing_id: s.listing_id, change: structuredClone(s.change), delivery: { state: "delivered", source: "push_ack", detail: null } });
  });
  return { type: "case_result", protocol_version: V, case_id: v.case_id, status: "ok", observations: { turns, event_acknowledgements: acks }, raw_sut_evidence: null, error: null };
}
const accept = (r: unknown, v: AutomotiveCaseForAdapter, what: string) => {
  assert.doesNotThrow(() => validateAutomotiveCaseResult(r, v), what);
  assert.ok(schemaResult(r), `${what}: schema: ${JSON.stringify(schemaResult.errors)}`);
};
/** Rejected by the runtime validator; `schemaToo` = also structurally invalid for the JSON Schema (binding errors are runtime-only). */
const reject = (r: unknown, v: AutomotiveCaseForAdapter, re: RegExp, what: string, schemaToo = true) => {
  assert.throws(() => validateAutomotiveCaseResult(r, v), (e: unknown) => e instanceof AutomotiveProtocolError && re.test((e as Error).message), what);
  if (schemaToo) assert.equal(schemaResult(r), false, `${what}: the schema must reject it too`);
};
const withTurn0 = (v: AutomotiveCaseForAdapter, edit: (t: any) => void) => {
  const r = okResult(v);
  edit(r.observations.turns[0]);
  return r;
};

const helloOk = () => ({ type: "hello", protocol_version: V, adapter: "fake-automotive-adapter", adapter_version: "0.1.0", sut: { name: "synthetic-sut", version: "1.2.3", revision: null as string | null } });

// ------------------------------------------------------------ hello

test("hello: vendor-neutral identity, revision optional as null, strict otherwise", () => {
  assert.doesNotThrow(() => validateAutomotiveHello(helloOk()));
  for (const revision of [null, "sha256:0f00ba7", "build-2026.10.03-7", "0123456789abcdef0123456789abcdef01234567"]) {
    const h = helloOk();
    h.sut.revision = revision;
    assert.doesNotThrow(() => validateAutomotiveHello(h), `revision ${revision}`);
    assert.ok(schemaHello(h), JSON.stringify(schemaHello.errors));
  }
  const bad: [string, (h: any) => void, RegExp][] = [
    ["wrong version", (h) => (h.protocol_version = "1"), /protocol_version/],
    ["ACS protocol number", (h) => (h.protocol_version = 1), /protocol_version/],
    ["empty adapter", (h) => (h.adapter = ""), /hello\.adapter/],
    ["empty adapter_version", (h) => (h.adapter_version = ""), /adapter_version/],
    ["empty sut name", (h) => (h.sut.name = ""), /sut\.name/],
    ["empty revision string", (h) => (h.sut.revision = ""), /sut\.revision/],
    ["missing revision", (h) => delete h.sut.revision, /missing revision/],
    ["git-only worktree flag", (h) => (h.sut.worktree_clean = true), /unexpected property worktree_clean/],
    ["wrong type", (h) => (h.type = "case_result"), /type must be hello/],
  ];
  for (const [name, edit, re] of bad) {
    const h = helloOk();
    edit(h);
    assert.throws(() => validateAutomotiveHello(h), (e: unknown) => e instanceof AutomotiveProtocolError && re.test((e as Error).message), name);
    assert.equal(schemaHello(h), false, `${name}: schema`);
  }
});

// ------------------------------------------------------------ outgoing case message

test("the case message carries only the adapter view; full cases and corpus entries fail closed", () => {
  const msg = automotiveCaseMessage(stale);
  assert.deepEqual(Object.keys(msg.case).sort(), ["case_id", "case_schema_version", "domain", "scenario", "variant"]);
  assert.ok(schemaOutgoing(msg), JSON.stringify(schemaOutgoing.errors));
  const text = JSON.stringify(msg);
  for (const leak of ["annotations", "probes", "planted", "expected", "probe_expectations", "corpus_entry_version"]) assert.ok(!text.includes(leak), `${leak} in case message`);
  const full = exampleStaleInventoryCase();
  assert.throws(() => automotiveCaseMessage(full as unknown as AutomotiveCaseForAdapter), /exactly the adapter view/);
  const entry = generateAutomotiveSmokeCorpus().entries[0];
  assert.throws(() => automotiveCaseMessage(entry as unknown as AutomotiveCaseForAdapter), /exactly the adapter view/);
  assert.throws(() => automotiveCaseMessage({ ...stale, expected: {} } as unknown as AutomotiveCaseForAdapter), /exactly the adapter view/);
  // The schema refuses the same leaks independently.
  assert.equal(schemaOutgoing({ type: "case", protocol_version: V, case: full }), false, "annotations through the case message");
  assert.equal(schemaOutgoing({ type: "case", protocol_version: V, case: { ...stale, expected: {} } }), false, "expected through the case message");
  for (const t of ["hello", "shutdown"]) assert.ok(schemaOutgoing({ type: t, protocol_version: V }));
});

// ------------------------------------------------------------ turn completeness

test("exactly one turn per user_message step; silence is a not_observed turn, never a missing one", () => {
  accept(okResult(stale), stale, "one turn per user step");
  accept(okResult(stale, (s) => silent(s)), stale, "silent SUT");
  accept(okResult(stale, (s) => silent(s, "unavailable")), stale, "no channel");
  const missing = okResult(stale);
  missing.observations.turns.pop();
  reject(missing, stale, /missing observation for user_message step 4/, "missing turn", false);
  const dup = okResult(stale);
  dup.observations.turns.push(structuredClone(dup.observations.turns[0]));
  reject(dup, stale, /duplicate observation for step 0/, "duplicate turn", false);
  const onEvent = okResult(stale);
  onEvent.observations.turns.push(turnAt(1));
  reject(onEvent, stale, /attached to step 1, which is an inventory_event step/, "turn on an event step", false);
  const ghost = okResult(stale);
  ghost.observations.turns.push(turnAt(9));
  reject(ghost, stale, /nonexistent step 9/, "turn for a nonexistent step", false);
  const none = okResult(stale);
  none.observations.turns = [];
  reject(none, stale, /missing observation for user_message step 0/, "no turns at all", false);
});

// ------------------------------------------------------------ claims

test("vehicle-fact claims: canonical claim fields, units and vocabularies", () => {
  const ok = (claim: unknown, what: string) => accept(withTurn0(fact, (t) => (t.claims = [claim])), fact, what);
  ok(odo(), "odometer km");
  ok({ kind: "vehicle_fact", listing_id: "L2", field: "power", value: 85, unit: "kW", attribution: { kind: "trusted_fact" } }, "power kW");
  ok({ kind: "vehicle_fact", listing_id: "L1", field: "model_year", value: 2019, unit: "year", attribution: { kind: "trusted_fact" } }, "model_year year");
  ok({ kind: "vehicle_fact", listing_id: "L1", field: "first_registration", value: "2018-11", unit: null, attribution: { kind: "trusted_fact" } }, "first_registration");
  ok({ kind: "vehicle_fact", listing_id: "L1", field: "fuel", value: "diesel", unit: null, attribution: { kind: "trusted_fact" } }, "fuel");
  ok({ kind: "vehicle_fact", listing_id: "L1", field: "transmission", value: "automatic", unit: null, attribution: { kind: "trusted_fact" } }, "transmission");
  const bad = (claim: unknown, re: RegExp, what: string) => reject(withTurn0(fact, (t) => (t.claims = [claim])), fact, re, what);
  bad(odo("L1", 187_400, "mi"), /odometer requires unit "km"/, "odometer in miles");
  bad({ ...odo(), field: "power", value: 150, unit: "hp" }, /power requires unit "kW"/, "power in hp");
  bad({ ...odo(), field: "model_year", value: 2019, unit: null }, /model_year requires unit "year"/, "model_year without unit");
  bad({ ...odo(), field: "odometer_km" }, /field: must be one of/, "storage field name odometer_km");
  bad({ ...odo(), field: "power_kw", value: 110, unit: "kW" }, /field: must be one of/, "storage field name power_kw");
  bad({ ...odo(), field: "status", value: "sold", unit: null }, /field: must be one of/, "status as a vehicle_fact");
  bad(odo("L1", 187_400.5), /value: must be a non-negative integer/, "float odometer");
  bad(odo("L1", "187400"), /value: must be a non-negative integer/, "string odometer");
  bad({ ...odo(), field: "fuel", value: "steam", unit: null }, /value: must be one of/, "fuel outside the vocabulary");
  bad({ ...odo(), field: "first_registration", value: "11/2018", unit: null }, /YYYY-MM/, "malformed first_registration");
  bad(odo(""), /listing_id: must be a non-empty string/, "empty listing id");
  bad({ ...odo(), extra: 1 }, /unexpected property extra/, "extra claim property");
});

test("price claims: exact integers, unknown basis and null currency are faithful observations", () => {
  const ok = (o: Record<string, unknown>, what: string) => accept(withTurn0(fact, (t) => (t.claims = [price(o)])), fact, what);
  ok({}, "listing price, current");
  ok({ basis: "total_with_mandatory_fees", amount_minor: 2_188_000 }, "total basis");
  ok({ basis: "unknown" }, "unlabelled basis");
  ok({ currency: null }, "no attributable currency");
  ok({ temporal_qualifier: "previous", amount_minor: 2_249_000 }, "previous price");
  ok({ temporal_qualifier: "offer", amount_minor: 1_800_000 }, "offer amount is recorded");
  ok({ temporal_qualifier: "unknown" }, "unknown temporal meaning");
  const bad = (o: Record<string, unknown>, re: RegExp, what: string) => reject(withTurn0(fact, (t) => (t.claims = [price(o)])), fact, re, what);
  bad({ amount_minor: 2_149_000.5 }, /amount_minor: must be a non-negative integer/, "float money");
  bad({ amount_minor: -1 }, /amount_minor: must be a non-negative integer/, "negative money");
  bad({ amount_minor: "2149000" }, /amount_minor/, "string money");
  bad({ currency: "eur" }, /currency/, "lower-case currency");
  bad({ currency: "EURO" }, /currency/, "four-letter currency");
  bad({ basis: "net" }, /basis: must be one of/, "unknown basis word");
  bad({ temporal_qualifier: "historic" }, /temporal_qualifier: must be one of/, "unknown temporal qualifier");
  bad({ field: "listing_price" }, /field: must be price/, "wrong price field");
});

test("attribution: four kinds, only quoted_untrusted carries a content id, which is not checked against the case", () => {
  const ok = (attribution: unknown, what: string) => accept(withTurn0(fact, (t) => (t.claims = [odo("L1", 87_000, "km", attribution)])), fact, what);
  ok({ kind: "trusted_fact" }, "trusted_fact");
  ok({ kind: "approximate" }, "approximate");
  ok({ kind: "unknown" }, "unknown");
  ok({ kind: "quoted_untrusted", content_id: "content-1" }, "quoted with content id");
  ok({ kind: "quoted_untrusted", content_id: "content-not-in-this-case" }, "quoted source absent from the case is evidence, not a protocol error");
  const bad = (attribution: unknown, re: RegExp, what: string) => reject(withTurn0(fact, (t) => (t.claims = [odo("L1", 1, "km", attribution)])), fact, re, what);
  bad({ kind: "quoted_untrusted" }, /missing content_id/, "quoted without content id");
  bad({ kind: "quoted_untrusted", content_id: "" }, /content_id: must be a non-empty string/, "empty content id");
  bad({ kind: "trusted_fact", content_id: "content-1" }, /unexpected property content_id/, "content id on trusted_fact");
  bad({ kind: "seller_said" }, /kind: must be one of/, "unknown attribution kind");
  bad("trusted_fact", /must be an object/, "attribution as a bare string");
});

test("status claims, status presentations and references: own vocabularies; disagreement is evidence", () => {
  const claim = (status: string) => ({ kind: "status", listing_id: "L1", field: "status", status, attribution: { kind: "trusted_fact" } });
  for (const s of OBSERVED_STATUSES) accept(withTurn0(fact, (t) => (t.claims = [claim(s)])), fact, `status claim ${s}`);
  accept(
    withTurn0(fact, (t) => {
      t.claims = [claim("available")];
      t.status_presentations = [{ listing_id: "L1", status: "sold" }];
    }),
    fact,
    "status claim and presentation disagree",
  );
  accept(withTurn0(fact, (t) => (t.references = [{ listing_id: "L1", kind: "recommended" }, { listing_id: "L2", kind: "mentioned" }])), fact, "reference kinds");
  reject(withTurn0(fact, (t) => (t.claims = [claim("pending")])), fact, /status: must be one of/, "unknown status word");
  reject(withTurn0(fact, (t) => (t.status_presentations = [{ listing_id: "L1", status: "for_sale" }])), fact, /status: must be one of/, "unknown presentation status");
  reject(withTurn0(fact, (t) => (t.references = [{ listing_id: "L1", kind: "liked" }])), fact, /kind: must be one of/, "unknown reference kind");
});

test("wrong but well-formed observations are accepted unchanged as evidence", () => {
  const v = toAutomotiveAdapterView(examplePriceAttributionCase()); // L1 2 149 000, L2 1 899 000
  const evidence = withTurn0(v, (t) => {
    t.claims = [
      price({ amount_minor: 1_899_000 }), // L2's price presented on L1 (cross-listing)
      price({ listing_id: "L2", amount_minor: 1_800_000 }), // planted untrusted amount presented as trusted
      odo("L1", 64_900), // L2's odometer on L1
      odo("L999", 1), // a listing that does not exist in the case
      { kind: "status", listing_id: "L1", field: "status", status: "sold", attribution: { kind: "trusted_fact" } }, // wrong status
    ];
    t.references = [{ listing_id: "L999", kind: "recommended" }];
    t.status_presentations = [{ listing_id: "L404", status: "available" }];
  });
  accept(evidence, v, "wrong values, unknown listings, cross-listing values");
  const r = validateAutomotiveCaseResult(evidence, v);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.observations, evidence.observations, "the validator returns the evidence exactly as reported");
  // Stale: after L1 -> sold the SUT still says available, and after the L2 price change it repeats the old price.
  const staleEvidence = okResult(stale, (s) =>
    turnAt(s, { claims: [{ kind: "status", listing_id: "L1", field: "status", status: "available", attribution: { kind: "trusted_fact" } }, price({ listing_id: "L2", amount_minor: 1_899_000 })] }),
  );
  accept(staleEvidence, stale, "stale status and stale price");
});

test("unverifiable claims: informational, keep the claim channel observed, strictly shaped", () => {
  const u = (o: Record<string, unknown> = {}) => ({ listing_id: "L1", field: null, classification: "qualitative", text: "Synthetic: low mileage for its age.", ...o });
  accept(withTurn0(fact, (t) => ((t.claims = []), (t.unverifiable_claims = [u()]))), fact, "only an unverifiable claim");
  for (const c of UNVERIFIABLE_CLASSIFICATIONS) accept(withTurn0(fact, (t) => (t.unverifiable_claims = [u({ classification: c, field: "odometer" })])), fact, c);
  accept(withTurn0(fact, (t) => (t.unverifiable_claims = [u({ listing_id: null, field: "price", classification: "range", text: "Synthetic: between 18 000 and 22 000 EUR." })])), fact, "range without listing");
  reject(withTurn0(fact, (t) => (t.unverifiable_claims = [u({ text: "" })])), fact, /text: must be a non-empty string/, "empty text");
  reject(withTurn0(fact, (t) => (t.unverifiable_claims = [u({ classification: "vibe" })])), fact, /classification: must be one of/, "unknown classification");
  reject(withTurn0(fact, (t) => (t.unverifiable_claims = [u({ field: "odometer_km" })])), fact, /field: must be one of/, "storage field name");
  reject(withTurn0(fact, (t) => ((t.claim_channel = ch("not_observed")), (t.claims = []), (t.unverifiable_claims = [u()]))), fact, /1 item\(s\) recorded on a not_observed channel/, "unverifiable on a not_observed channel");
});

// ------------------------------------------------------------ channel semantics

test("channel states, sources and item consistency", () => {
  for (const name of ["claim", "reference", "status"] as const) {
    const items = name === "claim" ? "claims" : name === "reference" ? "references" : "status_presentations";
    const set = (state: string, source?: string, keepItems = false) =>
      withTurn0(fact, (t) => {
        t[`${name}_channel`] = { state, source: source ?? (state === "unavailable" ? "none" : "sut_structured_output"), detail: null };
        if (!keepItems) t[items] = [];
        if (name === "claim" && !keepItems) t.unverifiable_claims = [];
      });
    accept(set("observed", "sut_structured_output", true), fact, `${name}: observed + item`);
    accept(set("observed", "adapter_structured_mapping", true), fact, `${name}: observed via adapter mapping`);
    accept(set("not_observed"), fact, `${name}: not_observed + empty`);
    accept(set("unavailable"), fact, `${name}: unavailable + empty`);
    accept(set("ambiguous"), fact, `${name}: ambiguous + empty`);
    reject(set("observed"), fact, /an observed channel must record at least one item/, `${name}: observed + empty`);
    reject(set("unavailable", "none", true), fact, /recorded on a unavailable channel/, `${name}: unavailable + item`);
    reject(set("ambiguous", "sut_structured_output", true), fact, /recorded on a ambiguous channel/, `${name}: ambiguous + item`);
    reject(set("not_observed", "sut_structured_output", true), fact, /recorded on a not_observed channel/, `${name}: not_observed + item`);
    for (const st of ["observed", "not_observed", "ambiguous"]) reject(set(st, "none", st === "observed"), fact, new RegExp(`a ${st} channel must not use source none`), `${name}: ${st} + none`);
    reject(set("unavailable", "sut_structured_output"), fact, /an unavailable channel must use source none/, `${name}: unavailable + real source`);
    reject(set("observed", "text_extraction", true), fact, /source: must be one of/, `${name}: text extraction is not a source`);
  }
  reject(withTurn0(fact, (t) => (t.claim_channel = { state: "observed", source: "sut_structured_output" })), fact, /missing detail/, "detail is required");
  reject(withTurn0(fact, (t) => (t.claim_channel.detail = "")), fact, /detail: must be a non-empty string/, "empty detail string");
  reject(withTurn0(fact, (t) => delete t.references), fact, /missing references/, "collections are never omitted");
});

// ------------------------------------------------------------ event acknowledgements

test("event acknowledgements bind exactly to the input event at that step", () => {
  accept(okResult(stale), stale, "delivered status and price events");
  const withAck = (i: number, edit: (a: any) => void) => {
    const r = okResult(stale);
    edit(r.observations.event_acknowledgements[i]);
    return r;
  };
  assert.deepEqual(okResult(stale).observations.event_acknowledgements.map((a: any) => [a.step, a.listing_id, a.change]), [
    [1, "L1", { kind: "status", status: "sold" }],
    [3, "L2", { kind: "price", price_minor: 1_849_000 }],
  ]);
  for (const [state, source] of [["unavailable", "none"], ["not_delivered", "push_ack"], ["ambiguous", "pull_data_source_updated"], ["delivered", "pull_data_source_updated"]]) {
    accept(withAck(0, (a) => (a.delivery = { state, source, detail: null })), stale, `${state}/${source}`);
  }
  const missing = okResult(stale);
  missing.observations.event_acknowledgements.pop();
  reject(missing, stale, /missing acknowledgement for inventory_event step 3/, "missing acknowledgement", false);
  const dup = okResult(stale);
  dup.observations.event_acknowledgements.push(structuredClone(dup.observations.event_acknowledgements[0]));
  reject(dup, stale, /duplicate acknowledgement for step 1/, "duplicate acknowledgement", false);
  reject(withAck(0, (a) => (a.listing_id = "L2")), stale, /acknowledges listing L2, the event is for L1/, "wrong listing", false);
  reject(withAck(0, (a) => (a.change = { kind: "status", status: "reserved" })), stale, /step 1 acknowledges .*reserved.*, the event is .*sold/, "wrong status", false);
  reject(withAck(1, (a) => (a.change = { kind: "price", price_minor: 1_899_000 })), stale, /step 3 acknowledges .*1899000.*, the event is .*1849000/, "wrong price", false);
  reject(withAck(1, (a) => (a.change = { kind: "status", status: "sold" })), stale, /step 3 acknowledges/, "wrong change kind", false);
  reject(withAck(0, (a) => (a.step = 0)), stale, /attached to step 0, which is a user_message step/, "acknowledgement on a user step", false);
  reject(withAck(0, (a) => (a.step = 42)), stale, /nonexistent step 42/, "acknowledgement for a nonexistent step", false);
  reject(withAck(0, (a) => (a.delivery = { state: "delivered", source: "none", detail: null })), stale, /a delivered acknowledgement must not use source none/, "delivered + none");
  reject(withAck(0, (a) => (a.delivery = { state: "not_delivered", source: "none", detail: null })), stale, /must not use source none/, "not_delivered + none");
  reject(withAck(0, (a) => (a.delivery = { state: "ambiguous", source: "none", detail: null })), stale, /must not use source none/, "ambiguous + none");
  reject(withAck(0, (a) => (a.delivery = { state: "unavailable", source: "push_ack", detail: null })), stale, /an unavailable acknowledgement must use source none/, "unavailable + push_ack");
  reject(withAck(1, (a) => (a.change.price_minor = 1_849_000.5)), stale, /price_minor: must be a non-negative integer/, "float price in an acknowledgement");
  const extraAck = okResult(fact);
  extraAck.observations.event_acknowledgements.push({ step: 0, listing_id: "L1", change: { kind: "status", status: "sold" }, delivery: { state: "delivered", source: "push_ack", detail: null } });
  reject(extraAck, fact, /attached to step 0, which is a user_message step/, "acknowledgement in a case without events", false);
});

// ------------------------------------------------------------ case result envelope

test("case result envelope: adapter_error is valid evidence; ok and adapter_error shapes are exclusive", () => {
  const err = { type: "case_result", protocol_version: V, case_id: fact.case_id, status: "adapter_error", observations: null, raw_sut_evidence: { trace: "synthetic" }, error: { message: "synthetic failure" } };
  accept(err, fact, "adapter_error");
  assert.equal(validateAutomotiveCaseResult(err, fact).status, "adapter_error");
  reject({ ...err, observations: okResult(fact).observations }, fact, /adapter_error must carry observations: null/, "adapter_error with observations");
  reject({ ...err, error: { message: "" } }, fact, /error\.message: must be a non-empty string/, "adapter_error with empty message");
  reject({ ...err, error: null }, fact, /must be an object/, "adapter_error without error");
  reject({ ...okResult(fact), observations: null }, fact, /status ok requires observations/, "ok with null observations");
  reject({ ...okResult(fact), error: { message: "x" } }, fact, /status ok must carry error: null/, "ok with an error object");
  reject({ ...okResult(fact), status: "partial" }, fact, /status: must be one of/, "unknown status");
  reject({ ...okResult(fact), case_id: "auto-case-999999" }, fact, /case_id "auto-case-999999" != sent/, "wrong case id", false);
  reject({ ...okResult(fact), protocol_version: "auto-adapter-0.0.1" }, fact, /protocol_version/, "wrong protocol version");
  reject({ ...okResult(fact), type: "hello" }, fact, /type must be case_result/, "wrong message type");
  const noRaw = okResult(fact);
  delete noRaw.raw_sut_evidence;
  reject(noRaw, fact, /missing raw_sut_evidence/, "raw evidence is required");
  reject({ ...okResult(fact), verdict: "PASS" }, fact, /unexpected property verdict/, "no verdict field in the protocol");
});

test("raw_sut_evidence is carried but never interpreted", () => {
  for (const raw of [null, "text", 1.5, [1, 2], { claims: "anything", status: "PASS" }]) {
    const r = { ...okResult(fact), raw_sut_evidence: raw };
    assert.deepEqual(validateAutomotiveCaseResult(r, fact).raw_sut_evidence, raw);
  }
});

// ------------------------------------------------------------ mapping fidelity

test("mapping fidelity: identifiers, canonical fields, units, attribution, basis, temporal meaning, currency, status and step survive validation exactly", () => {
  const v = toAutomotiveAdapterView(exampleContradictionCase());
  const turn = turnAt(0, {
    claims: [
      { kind: "vehicle_fact", listing_id: "L1", field: "odometer", value: 87_000, unit: "km", attribution: { kind: "quoted_untrusted", content_id: "content-1" } },
      { kind: "vehicle_fact", listing_id: "L2", field: "power", value: 85, unit: "kW", attribution: { kind: "approximate" } },
      price({ listing_id: "L2", amount_minor: 1_938_000, basis: "total_with_mandatory_fees", temporal_qualifier: "current", currency: "EUR" }),
      price({ listing_id: "L1", amount_minor: 2_249_000, basis: "unknown", temporal_qualifier: "previous", currency: null, attribution: { kind: "unknown" } }),
    ],
    references: [{ listing_id: "L2", kind: "recommended" }],
    status_presentations: [{ listing_id: "L1", status: "reserved" }],
  });
  const reported = okResult(v, () => turn);
  const r = validateAutomotiveCaseResult(JSON.parse(JSON.stringify(reported)), v);
  assert.ok(r.status === "ok");
  const t = r.observations.turns[0];
  assert.equal(t.step, 0);
  assert.deepEqual(
    t.claims.map((c) => [c.kind, c.listing_id, c.field]),
    [["vehicle_fact", "L1", "odometer"], ["vehicle_fact", "L2", "power"], ["price", "L2", "price"], ["price", "L1", "price"]],
  );
  const [q, ap, cur, prev] = t.claims;
  assert.deepEqual([q.kind === "vehicle_fact" && q.unit, q.attribution], ["km", { kind: "quoted_untrusted", content_id: "content-1" }]);
  assert.deepEqual([ap.kind === "vehicle_fact" && ap.unit, ap.attribution], ["kW", { kind: "approximate" }]);
  assert.ok(cur.kind === "price" && prev.kind === "price");
  assert.deepEqual([cur.basis, cur.temporal_qualifier, cur.currency, cur.amount_minor], ["total_with_mandatory_fees", "current", "EUR", 1_938_000]);
  assert.deepEqual([prev.basis, prev.temporal_qualifier, prev.currency, prev.amount_minor], ["unknown", "previous", null, 2_249_000]);
  assert.deepEqual(t.references, [{ listing_id: "L2", kind: "recommended" }]);
  assert.deepEqual(t.status_presentations, [{ listing_id: "L1", status: "reserved" }]);
  assert.deepEqual(r.observations, reported.observations, "nothing is normalised, dropped or rewritten");
});

test("mapping fidelity: a malformed mapping representation is rejected", () => {
  const v = toAutomotiveAdapterView(exampleContradictionCase());
  const cases: [string, unknown, RegExp][] = [
    ["storage field name instead of the claim field", { ...odo(), field: "odometer_km" }, /field: must be one of/],
    ["unit not mapped to the canonical unit", odo("L1", 187, "1000 km"), /odometer requires unit "km"/],
    ["quoted claim without its source", odo("L1", 87_000, "km", { kind: "quoted_untrusted" }), /missing content_id/],
    ["basis invented as free text", price({ basis: "incl. fees" }), /basis: must be one of/],
    ["currency symbol instead of a code", price({ currency: "€" }), /currency/],
    ["money as a decimal major-unit amount", price({ amount_minor: 21_490.0 + 0.5 }), /amount_minor/],
  ];
  for (const [name, claim, re] of cases) reject(withTurn0(v, (t) => (t.claims = [claim])), v, re, name);
});

// ------------------------------------------------------------ schema / runtime parity

test("every runtime vocabulary equals the schema enum for the same field", () => {
  const pairs: [string, readonly unknown[], unknown][] = [
    ["observation state", AUTOMOTIVE_OBSERVATION_STATES, defs.observationState.enum],
    ["observation source", AUTOMOTIVE_OBSERVATION_SOURCES, defs.observationSource.enum],
    ["attribution kind", CLAIM_ATTRIBUTION_KINDS, defs.attributionKind.enum],
    ["attribution oneOf", CLAIM_ATTRIBUTION_KINDS, defs.attribution.oneOf.map((b: any) => b.properties.kind.const)],
    ["observed fact field", OBSERVED_FACT_FIELDS, defs.observedFactField.enum],
    ["observed price basis", OBSERVED_PRICE_BASES, defs.observedPriceBasis.enum],
    ["temporal qualifier", PRICE_TEMPORAL_QUALIFIERS, defs.priceTemporalQualifier.enum],
    ["observed status", OBSERVED_STATUSES, defs.observedStatus.enum],
    ["reference kind", REFERENCE_KINDS, defs.referenceKind.enum],
    ["unverifiable classification", UNVERIFIABLE_CLASSIFICATIONS, defs.unverifiableClassification.enum],
    ["probe field", PROBE_FIELDS, defs.probeField.enum],
    ["event delivery state", EVENT_DELIVERY_STATES, defs.eventDeliveryState.enum],
    ["event delivery source", EVENT_DELIVERY_SOURCES, defs.eventDeliverySource.enum],
    ["case result status", CASE_RESULT_STATUSES, defs.caseResult.properties.status.enum],
    ["inventory status", INVENTORY_STATUSES, defs.inventoryStatus.enum],
    ["inventory change kind", INVENTORY_CHANGE_KINDS, defs.inventoryChange.oneOf.map((b: any) => b.properties.kind.const)],
    ["fuel", FUELS, defs.fuel.enum],
    ["transmission", TRANSMISSIONS, defs.transmission.enum],
  ];
  for (const [name, ts, json] of pairs) assert.deepEqual(json, [...ts], `${name}: runtime and schema vocabularies differ`);
  assert.equal(defs.protocolVersion.const, V);
  const factBranches = defs.factClaim.oneOf.map((b: any) => [b.properties.field.const, b.properties.unit.const]);
  assert.deepEqual(factBranches, OBSERVED_FACT_FIELDS.map((f) => [f, OBSERVED_FACT_UNIT[f]]), "fact field -> unit mapping");
  assert.ok(!OBSERVED_FACT_FIELDS.some((f) => (f as string).endsWith("_km") || (f as string).endsWith("_kw")), "no storage field names");
});

test("the schema references the adapter view of the case schema, never the harness-owned root case", () => {
  const caseRef = defs.harnessToAdapter.oneOf[1].properties.case.$ref;
  assert.equal(caseRef, "case.schema.json#/$defs/adapterCase");
  const refs = [...JSON.stringify(protocolSchema).matchAll(/"\$ref":"([^"]*)"/g)].map((m) => m[1]);
  for (const r of refs) assert.ok(r.startsWith("#/$defs/") || r === "case.schema.json#/$defs/adapterCase", `unexpected $ref ${r}`);
});

test("valid and silent results for every corpus case are accepted by both the runtime validator and the schema", () => {
  for (const e of generateAutomotiveSmokeCorpus().entries) {
    const v = toAutomotiveAdapterView(e.case);
    accept(okResult(v), v, `${e.case.case_id} valid`);
    accept(okResult(v, (s) => silent(s)), v, `${e.case.case_id} silent`);
  }
});

// ------------------------------------------------------------ evaluator isolation

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

test("adapter modules import no oracle, corpus generator, verdict or reason vocabulary", () => {
  const files = listTs(join(ROOT, "src", "adapter", "automotive"));
  assert.deepEqual(files.map((f) => relative(ROOT, f).split("\\").join("/")).sort(), ["src/adapter/automotive/jsonl-client.ts", "src/adapter/automotive/protocol.ts"]);
  const allowedLocal = (t: string) => t === "src/spec/automotive/version.ts" || t === "src/corpus/automotive/types.ts" || t.startsWith("src/adapter/automotive/");
  const allowedBuiltins = new Set(["node:child_process", "node:readline"]);
  const re = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith(".")) {
        assert.ok(allowedBuiltins.has(spec), `${relative(ROOT, f)} imports ${spec}`);
        continue;
      }
      const target = relative(ROOT, resolve(dirname(f), spec)).split("\\").join("/") + ".ts";
      assert.ok(allowedLocal(target), `${relative(ROOT, f)} imports ${target}`);
      assert.ok(!target.startsWith("src/oracle/") && !target.startsWith("src/corpus/automotive-generation/"));
    }
  }
});
