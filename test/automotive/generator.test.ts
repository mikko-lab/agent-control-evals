import { test } from "node:test";
import assert from "node:assert/strict";
import { AutomotiveGeneratorError, buildAutomotiveCorpusEntry, generateAutomotiveSmokeCorpus, variantIntentProblems } from "../../src/corpus/automotive-generation/generate";
import { AUTOMOTIVE_VARIANTS, AUTOMOTIVE_VARIANTS_BY_DOMAIN } from "../../src/corpus/automotive/registry";
import { AUTOMOTIVE_SMOKE_CORPUS_IDENTITY, AUTOMOTIVE_SMOKE_PROFILE } from "../../src/corpus/automotive/profiles";
import type { AutomotiveVariantDef, ProbeIntent } from "../../src/corpus/automotive/variant";
import { toAutomotiveAdapterView } from "../../src/corpus/automotive/builders";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS, PLANNED_AUTOMOTIVE_DOMAINS } from "../../src/spec/automotive/domains";
import { AUTOMOTIVE_VERDICTS } from "../../src/spec/automotive/outcomes";
import { AUTOMOTIVE_REASON_CLASSES } from "../../src/spec/automotive/reason-taxonomy";
import { AUTOMOTIVE_CORPUS_ENTRY_VERSION, AUTOMOTIVE_GENERATOR_VERSION, AUTOMOTIVE_ORACLE_VERSION } from "../../src/spec/automotive/version";

const corpus = generateAutomotiveSmokeCorpus();

const EXPECTED_ORDER = [
  "vehicle_fact_integrity/odometer_and_power",
  "vehicle_fact_integrity/model_year_and_registration",
  "vehicle_fact_integrity/status_available",
  "vehicle_fact_integrity/cross_listing_odometer_context",
  "vehicle_fact_integrity/untrusted_odometer_conflict",
  "vehicle_fact_integrity/untrusted_fuel_conflict",
  "price_attribution/two_listing_current_prices",
  "price_attribution/either_basis_with_fees",
  "price_attribution/total_required_with_fees",
  "price_attribution/untrusted_price_conflict",
  "price_attribution/superseded_price_history",
  "price_attribution/multiple_superseded_prices",
  "stale_inventory/available_to_sold",
  "stale_inventory/available_to_reserved",
  "stale_inventory/price_change",
  "stale_inventory/multiple_price_changes",
  "stale_inventory/sold_to_available",
  "stale_inventory/noop_price_change",
];

test("smoke profile and corpus identity are exact", () => {
  assert.deepEqual(AUTOMOTIVE_SMOKE_PROFILE, { id: "auto-smoke-0.1.0", variants_per_domain: 6, cases: 18 });
  assert.deepEqual(AUTOMOTIVE_SMOKE_CORPUS_IDENTITY, {
    profile: "auto-smoke-0.1.0",
    pack_version: "auto-0.1.0",
    case_schema_version: "auto-case-0.1.0",
    oracle_version: "auto-oracle-0.1.0",
    generator_version: "auto-generator-0.1.0",
    corpus_entry_version: "auto-corpus-entry-0.1.0",
  });
  assert.equal(AUTOMOTIVE_GENERATOR_VERSION, "auto-generator-0.1.0");
  assert.equal(corpus.profile, "auto-smoke-0.1.0");
});

test("18 entries, 6 per executable domain, no planned domain, stable declaration order", () => {
  assert.equal(corpus.entries.length, 18);
  for (const d of EXECUTABLE_AUTOMOTIVE_DOMAINS) {
    assert.equal(corpus.entries.filter((e) => e.case.domain === d).length, 6, d);
    assert.equal(AUTOMOTIVE_VARIANTS_BY_DOMAIN[d].length, 6, d);
  }
  for (const e of corpus.entries) assert.ok(!(PLANNED_AUTOMOTIVE_DOMAINS as readonly string[]).includes(e.case.domain));
  assert.deepEqual(corpus.entries.map((e) => `${e.case.domain}/${e.case.variant}`), EXPECTED_ORDER);
  assert.deepEqual(AUTOMOTIVE_VARIANTS.map((v) => `${v.domain}/${v.name}`), EXPECTED_ORDER);
});

test("case ids are auto-case-000001..000018, unique; (domain, variant) pairs are unique", () => {
  assert.deepEqual(corpus.entries.map((e) => e.case.case_id), Array.from({ length: 18 }, (_, i) => `auto-case-${String(i + 1).padStart(6, "0")}`));
  assert.equal(new Set(corpus.entries.map((e) => e.case.case_id)).size, 18);
  assert.equal(new Set(corpus.entries.map((e) => `${e.case.domain}/${e.case.variant}`)).size, 18);
});

test("generation is deterministic: deep-equal entries, byte-identical canonical JSON, identical SHA-256", () => {
  const again = generateAutomotiveSmokeCorpus();
  assert.deepEqual(again.entries, corpus.entries);
  assert.equal(again.bytes, corpus.bytes);
  assert.equal(again.sha256, corpus.sha256);
  assert.match(corpus.sha256, /^[0-9a-f]{64}$/);
  assert.ok(corpus.bytes.endsWith("}\n") && !corpus.bytes.includes("\r"));
});

test("every entry: exact versions, expected bound to its own case, only stale_inventory has events", () => {
  for (const e of corpus.entries) {
    assert.deepEqual(Object.keys(e).sort(), ["case", "corpus_entry_version", "expected"]);
    assert.equal(e.corpus_entry_version, AUTOMOTIVE_CORPUS_ENTRY_VERSION);
    assert.equal(e.expected.oracle_version, AUTOMOTIVE_ORACLE_VERSION);
    assert.equal(e.expected.case_id, e.case.case_id);
    assert.equal(e.expected.domain, e.case.domain);
    assert.deepEqual(e.expected.probe_expectations.map((p) => p.probe_id), e.case.annotations.probes.map((p) => p.probe_id));
    assert.ok(e.expected.probe_expectations.length > 0);
    const events = e.case.scenario.steps.filter((s) => s.op === "inventory_event").length;
    assert.equal(events > 0, e.case.domain === "stale_inventory", `${e.case.case_id}: events only in stale_inventory`);
  }
});

test("every registered variant's intent agrees with the oracle (double entry)", () => {
  for (const e of corpus.entries) {
    const def = AUTOMOTIVE_VARIANTS.find((v) => v.domain === e.case.domain && v.name === e.case.variant)!;
    assert.deepEqual(variantIntentProblems(def, e.expected, e.case.scenario.currency), []);
  }
});

const variant = (name: string) => AUTOMOTIVE_VARIANTS.find((v) => v.name === name)!;
const withIntent = (name: string, edit: (probes: ProbeIntent[]) => ProbeIntent[]): AutomotiveVariantDef => {
  const v = variant(name);
  return { ...v, intent: { probes: edit(structuredClone(v.intent.probes)) } };
};
const rejects = (def: AutomotiveVariantDef, re: RegExp, what: string) =>
  assert.throws(() => buildAutomotiveCorpusEntry(def, 1), (e: unknown) => e instanceof AutomotiveGeneratorError && re.test((e as Error).message), what);

test("a deliberately wrong variant intent fails closed", () => {
  rejects(withIntent("available_to_sold", (p) => p.map((x) => (x.probe_id === "p2" ? { ...x, expected: "available" } : x)) as ProbeIntent[]), /oracle expected "sold" != intent "available"/, "post-event status");
  rejects(
    withIntent("total_required_with_fees", (p) => p.map((x) => (x.field === "price" ? { ...x, accepted: [{ basis: "listing_price" as const, amount_minor: 2_149_000 }, ...x.accepted] } : x))),
    /oracle accepted/,
    "accepted bases under total_required",
  );
  rejects(withIntent("untrusted_odometer_conflict", (p) => p.map((x) => ({ ...x, min_planted_conflicts: 2 }))), /planted conflicts < intent minimum 2/, "planted witness");
  rejects(withIntent("superseded_price_history", (p) => p.map((x) => (x.field === "price" ? { ...x, superseded: [] } : x))), /oracle superseded \[2249000\] != intent \[\]/, "superseded witness");
  rejects(withIntent("odometer_and_power", (p) => p.map((x) => ({ ...x, min_cross_listing_candidates: 5 }))), /cross-listing candidates < intent minimum 5/, "cross-listing minimum");
  rejects(withIntent("odometer_and_power", (p) => p.slice(1)), /oracle probes .* != intent probes/, "missing probe intent");
  rejects(withIntent("odometer_and_power", (p) => [...p, { ...p[0], probe_id: "p9" }]), /oracle probes .* != intent probes/, "extra probe intent");
  rejects(withIntent("odometer_and_power", (p) => p.map((x) => (x.probe_id === "p1" && x.field !== "price" ? { ...x, field: "model_year" as const } : x))), /oracle field odometer != intent field model_year/, "field mismatch");
  rejects(withIntent("price_change", (p) => p.map((x) => (x.probe_id === "p2" && x.field === "price" ? { ...x, accepted: x.accepted.map((a) => ({ ...a, amount_minor: 1_899_000 })) } : x))), /oracle accepted/, "stale price as current");
});

test("the registry contract is enforced: duplicate, missing or surplus variants fail closed", () => {
  const vs = [...AUTOMOTIVE_VARIANTS];
  assert.throws(() => generateAutomotiveSmokeCorpus([...vs.slice(0, 17), vs[0]]), /duplicate variant/);
  assert.throws(() => generateAutomotiveSmokeCorpus(vs.slice(1)), /has 5 variants/);
  assert.throws(() => generateAutomotiveSmokeCorpus([...vs, { ...vs[0], name: "extra" }]), /has 7 variants/);
});

function keysAndStrings(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => keysAndStrings(v, out));
  else if (x !== null && typeof x === "object") for (const [k, v] of Object.entries(x)) out.push(k), keysAndStrings(v, out);
  else if (typeof x === "string") out.push(x);
  return out;
}

test("no verdict, reason class, severity or score appears in any committed expected output", () => {
  const forbidden = new Set<string>([...AUTOMOTIVE_VERDICTS, ...AUTOMOTIVE_REASON_CLASSES, "verdict", "reason", "reason_class", "severity", "score", "grade", "maturity", "certification", "outcome"]);
  for (const e of corpus.entries) for (const w of keysAndStrings(e.expected)) assert.ok(!forbidden.has(w), `${e.case.case_id}: forbidden term ${w}`);
});

test("the adapter view of entry.case carries neither expected output nor harness annotations", () => {
  for (const e of corpus.entries) {
    const view = toAutomotiveAdapterView(e.case);
    assert.deepEqual(Object.keys(view).sort(), ["case_id", "case_schema_version", "domain", "scenario", "variant"]);
    const text = JSON.stringify(view);
    for (const leak of ["\"expected\"", "probe_expectations", "oracle_version", "\"annotations\"", "\"probes\"", "\"planted\"", "probe_id", "accepted_presentations", "candidates"]) {
      assert.ok(!text.includes(leak), `${e.case.case_id}: ${leak} leaked into the adapter view`);
    }
  }
});
