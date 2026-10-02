import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS, PLANNED_AUTOMOTIVE_DOMAINS } from "../../src/spec/automotive/domains";
import { AUTOMOTIVE_CASE_SCHEMA_VERSION } from "../../src/spec/automotive/version";
import {
  AUTOMOTIVE_CASE_ID_PATTERN,
  AUTOMOTIVE_LABEL_PATTERN,
  AUTOMOTIVE_VARIANT_PATTERN,
  CURRENCY_CODE_PATTERN,
  FIRST_REGISTRATION_PATTERN,
  FUELS,
  INTEGER_VALUED_FIELDS,
  INVENTORY_CHANGE_KINDS,
  INVENTORY_STATUSES,
  MANDATORY_FEE_POLICIES,
  MODEL_YEAR_MAX,
  MODEL_YEAR_MIN,
  PROBE_FIELDS,
  STEP_OPS,
  STRING_VALUED_FIELDS,
  TRANSMISSIONS,
  UNTRUSTED_AUTHOR_ROLES,
  UNTRUSTED_SOURCES,
  type AutomotiveCase,
} from "../../src/corpus/automotive/types";
import {
  exampleContradictionCase,
  examplePriceAttributionCase,
  exampleStaleInventoryCase,
  exampleVehicleFactCase,
  toAutomotiveAdapterView,
} from "../../src/corpus/automotive/builders";

const ROOT = join(__dirname, "..", "..", "..");
const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "automotive", "case.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema, "auto-case");
const validateCase = ajv.getSchema("auto-case")!;
const validateAdapterCase = ajv.getSchema("auto-case#/$defs/adapterCase")!;
const defs = schema.$defs;

const ok = (c: unknown, what: string) => assert.ok(validateCase(c), `${what}: ${JSON.stringify(validateCase.errors)}`);
const bad = (c: unknown, what: string) => assert.equal(validateCase(c), false, `${what} must be rejected`);
/** A mutable deep copy of a valid case for building malformed variants. */
const mut = (c: AutomotiveCase = exampleVehicleFactCase()): any => JSON.parse(JSON.stringify(c));

test("schema is draft 2020-12, automotive-namespaced and does not reference the ACS case schema", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(schema.$id, /schemas\/automotive\/case\.schema\.json$/);
  const text = JSON.stringify(schema);
  const refs = [...text.matchAll(/"\$ref":"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const r of refs) assert.ok(r.startsWith("#/$defs/"), `external $ref ${r}`);
  for (const acs of ["capability_agent_binding", "\"ALLOW\"", "\"ASK\"", "POLICY_DENY", "\"request\",\"approval\""]) assert.ok(!text.includes(acs), `ACS vocabulary ${acs} in automotive schema`);
  assert.equal(defs.caseSchemaVersion.const, AUTOMOTIVE_CASE_SCHEMA_VERSION);
});

test("valid examples: vehicle_fact_integrity, price_attribution, stale_inventory and a trusted/untrusted contradiction", () => {
  ok(exampleVehicleFactCase(), "vehicle_fact_integrity");
  ok(examplePriceAttributionCase(), "price_attribution");
  ok(exampleStaleInventoryCase(), "stale_inventory");
  ok(exampleContradictionCase(), "contradiction");
});

test("adapter view validates as adapterCase and is not a full case; a full case is not an adapter view", () => {
  for (const c of [exampleVehicleFactCase(), examplePriceAttributionCase(), exampleStaleInventoryCase(), exampleContradictionCase()]) {
    const view = toAutomotiveAdapterView(c);
    assert.ok(validateAdapterCase(view), JSON.stringify(validateAdapterCase.errors));
    assert.equal(validateCase(view), false, "annotations are required in the harness-owned case");
    assert.equal(validateAdapterCase(c), false, "an adapter view must not carry annotations");
  }
});

test("rejects malformed numbers, vocabularies and formats", () => {
  let c = mut();
  c.scenario.trusted.inventory[0].price_minor = 2_149_000.5;
  bad(c, "float price");
  c = mut();
  c.scenario.trusted.inventory[0].mandatory_fees_minor = -1;
  bad(c, "negative fee");
  c = mut();
  c.scenario.trusted.inventory[0].odometer_km = 187_400.25;
  bad(c, "float odometer");
  c = mut();
  c.scenario.trusted.inventory[0].power_kw = 0;
  bad(c, "zero power");
  c = mut();
  c.scenario.trusted.inventory[0].model_year = 2019.5;
  bad(c, "float model year");
  c = mut();
  c.scenario.trusted.inventory[0].model_year = 1850;
  bad(c, "model year below range");
  c = mut();
  c.scenario.trusted.inventory[0].status = "pending";
  bad(c, "unknown status");
  c = mut();
  c.scenario.trusted.inventory[0].fuel = "steam";
  bad(c, "unknown fuel");
  c = mut();
  c.scenario.trusted.inventory[0].transmission = "cvt";
  bad(c, "unknown transmission");
  for (const fr of ["2018-13", "2018-00", "11/2018", "2018-1", "2018"]) {
    c = mut();
    c.scenario.trusted.inventory[0].first_registration = fr;
    bad(c, `first_registration ${fr}`);
  }
  c = mut();
  c.scenario.currency = "eur";
  bad(c, "lower-case currency");
  c = mut();
  c.scenario.policy.mandatory_fee_policy = "vat_included";
  bad(c, "unknown fee policy");
  c = mut();
  c.scenario.trusted.inventory[0].price_history = [{ price_minor: 1.5 }];
  bad(c, "float superseded price");
});

test("rejects ACS-style and malformed identifiers, wrong versions, unknown and planned domains", () => {
  let c = mut();
  c.case_id = "case-000001";
  bad(c, "ACS-style case id");
  c = mut();
  c.case_id = "auto-case-1";
  bad(c, "short case id");
  c = mut();
  c.case_schema_version = "0.1.0";
  bad(c, "ACS case schema version");
  c = mut();
  c.domain = "fuel_economy";
  bad(c, "unknown domain");
  for (const d of PLANNED_AUTOMOTIVE_DOMAINS) {
    c = mut();
    c.domain = d;
    bad(c, `planned domain ${d}`);
  }
  c = mut();
  c.scenario.trusted.inventory[0].listing_id = "L 1";
  bad(c, "listing id with whitespace");
});

test("rejects unexpected properties, missing fields and empty required collections", () => {
  let c = mut();
  c.scenario.trusted.inventory[0].vin = "not-a-real-identifier";
  bad(c, "unexpected listing property");
  c = mut();
  c.expected = {};
  bad(c, "unexpected root property");
  c = mut(exampleContradictionCase());
  c.scenario.untrusted[0].trusted = false;
  bad(c, "per-item trust flag");
  c = mut();
  delete c.scenario.trusted.inventory[0].listing_id;
  bad(c, "missing listing_id");
  c = mut();
  c.scenario.trusted.inventory = [];
  bad(c, "empty inventory");
  c = mut();
  c.scenario.trusted.dealers = [];
  bad(c, "empty dealers");
  c = mut();
  c.scenario.steps = [];
  bad(c, "empty steps");
  c = mut(exampleStaleInventoryCase());
  c.scenario.steps = c.scenario.steps.filter((s: { op: string }) => s.op !== "user_message");
  bad(c, "steps without a user_message");
  c = mut(exampleContradictionCase());
  c.scenario.untrusted[0].source = "web_page";
  bad(c, "unknown untrusted source");
  c = mut(exampleContradictionCase());
  c.scenario.untrusted[0].author_role = "anonymous";
  bad(c, "unknown author role");
});

test("rejects malformed inventory events and misplaced transitions", () => {
  const ev = (change: unknown, extra: Record<string, unknown> = {}) => {
    const c = mut(exampleStaleInventoryCase());
    c.scenario.steps[1] = { op: "inventory_event", listing_id: "L1", change, ...extra };
    return c;
  };
  ok(ev({ kind: "status", status: "reserved" }), "available -> reserved event");
  bad(ev({ kind: "status", status: "gone" }), "unknown status in event");
  bad(ev({ kind: "price", price_minor: 1_849_000.5 }), "float price event");
  bad(ev({ kind: "price", status: "sold" }), "price event without price_minor");
  bad(ev({ kind: "mileage", odometer_km: 1 }), "unknown change kind");
  bad(ev({ kind: "status", status: "sold" }, { at: 3 }), "unexpected event property");
  const noId = mut(exampleStaleInventoryCase());
  delete noId.scenario.steps[1].listing_id;
  bad(noId, "event without listing_id");
  const noEvents = mut(exampleStaleInventoryCase());
  noEvents.scenario.steps = noEvents.scenario.steps.filter((s: { op: string }) => s.op === "user_message");
  bad(noEvents, "stale_inventory without an inventory_event");
  const factWithEvent = mut(exampleVehicleFactCase());
  factWithEvent.scenario.steps.push({ op: "inventory_event", listing_id: "L1", change: { kind: "status", status: "sold" } });
  bad(factWithEvent, "vehicle_fact_integrity with an inventory_event");
});

test("rejects malformed annotations", () => {
  let c = mut(exampleContradictionCase());
  c.annotations.planted[0].value = "87 000 km";
  bad(c, "string value for an integer-valued planted field");
  c = mut(exampleContradictionCase());
  c.annotations.planted[0] = { content_id: "content-1", listing_id: "L1", field: "fuel", value: 1 };
  bad(c, "integer value for a string-valued planted field");
  c = mut();
  c.annotations.probes[0].field = "colour";
  bad(c, "unknown probe field");
  c = mut();
  c.annotations.probes[0].step = -1;
  bad(c, "negative probe step");
  c = mut();
  delete c.annotations;
  bad(c, "missing annotations");
});

// ------------------------------------------------------------ type / schema parity

test("every closed TypeScript vocabulary equals the schema enum for the same field", () => {
  const pairs: [string, readonly (string | number)[], unknown][] = [
    ["domain", EXECUTABLE_AUTOMOTIVE_DOMAINS, defs.domain.enum],
    ["status", INVENTORY_STATUSES, defs.status.enum],
    ["fuel", FUELS, defs.fuel.enum],
    ["transmission", TRANSMISSIONS, defs.transmission.enum],
    ["mandatory_fee_policy", MANDATORY_FEE_POLICIES, defs.mandatoryFeePolicy.enum],
    ["untrusted source", UNTRUSTED_SOURCES, defs.untrustedSource.enum],
    ["author role", UNTRUSTED_AUTHOR_ROLES, defs.untrustedAuthorRole.enum],
    ["probe field", PROBE_FIELDS, defs.probeField.enum],
    ["integer-valued field", INTEGER_VALUED_FIELDS, defs.integerValuedField.enum],
    ["string-valued field", STRING_VALUED_FIELDS, defs.stringValuedField.enum],
    ["step op", STEP_OPS, defs.step.oneOf.map((b: { properties: { op: { const: string } } }) => b.properties.op.const)],
    ["inventory change kind", INVENTORY_CHANGE_KINDS, defs.step.oneOf[1].properties.change.oneOf.map((b: { properties: { kind: { const: string } } }) => b.properties.kind.const)],
  ];
  for (const [name, ts, json] of pairs) assert.deepEqual(json, [...ts], `${name}: TypeScript and schema vocabularies differ`);
  assert.deepEqual([...INTEGER_VALUED_FIELDS, ...STRING_VALUED_FIELDS].sort(), [...PROBE_FIELDS].sort(), "probe fields split exactly into integer- and string-valued");
});

test("TypeScript patterns and bounds equal the schema patterns and bounds", () => {
  assert.equal(defs.caseId.pattern, AUTOMOTIVE_CASE_ID_PATTERN);
  assert.equal(defs.label.pattern, AUTOMOTIVE_LABEL_PATTERN);
  assert.equal(defs.variant.pattern, AUTOMOTIVE_VARIANT_PATTERN);
  assert.equal(defs.currency.pattern, CURRENCY_CODE_PATTERN);
  assert.equal(defs.firstRegistration.pattern, FIRST_REGISTRATION_PATTERN);
  assert.equal(defs.listing.properties.model_year.minimum, MODEL_YEAR_MIN);
  assert.equal(defs.listing.properties.model_year.maximum, MODEL_YEAR_MAX);
});

test("schema listing properties are exactly the TypeScript TrustedListing fields", () => {
  const listing = exampleVehicleFactCase().scenario.trusted.inventory[0];
  assert.deepEqual(Object.keys(defs.listing.properties).sort(), Object.keys(listing).sort());
  assert.deepEqual([...defs.listing.required].sort(), Object.keys(listing).sort());
});
