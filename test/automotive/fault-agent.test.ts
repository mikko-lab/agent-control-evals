import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import { toAutomotiveAdapterView } from "../../src/corpus/automotive/builders";
import { AUTOMOTIVE_VARIANTS } from "../../src/corpus/automotive/registry";
import type { AutomotiveCaseForAdapter } from "../../src/corpus/automotive/types";
import { validateAutomotiveCaseResult, validateAutomotiveHello } from "../../src/adapter/automotive/protocol";
import { AUTOMOTIVE_FAULT_IDS, FAULT_UNKNOWN_LISTING, faultHello, faultObservations, type AutomotiveFaultId } from "../../src/adapter/automotive-faults/agent";
import { referenceHello, referenceObservations } from "../../src/adapter/automotive-reference/agent";
import { runAutomotiveCorpus } from "../../src/eval/automotive/run";
import { buildAutomotiveBundle } from "../../src/report/automotive/build";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, AUTOMOTIVE_FAULT_ADAPTER_VERSION } from "../../src/spec/automotive/version";
import { canonicalJson } from "../../src/util/canonical-json";

const ROOT = join(__dirname, "..", "..", "..");
const FAULT_MAIN = join(ROOT, "dist", "src", "adapter", "automotive-faults", "main.js");
const corpus = generateAutomotiveSmokeCorpus();
const manifest = JSON.parse(readFileSync(join(ROOT, "faults", "automotive", "manifest.json"), "utf8")) as { faults: { fault_id: string; domain: string; expected_field: string; expected_reasons: string[]; witness_variants: string[] }[] };
const viewOf = (variant: string): AutomotiveCaseForAdapter => toAutomotiveAdapterView(corpus.entries.find((e) => e.case.variant === variant)!.case);
const result = (view: AutomotiveCaseForAdapter, observations: unknown) =>
  validateAutomotiveCaseResult({ type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: view.case_id, status: "ok", observations, raw_sut_evidence: null, error: null }, view);

test("implemented fault ids are exactly the declared manifest faults, in manifest order", () => {
  assert.deepEqual([...AUTOMOTIVE_FAULT_IDS], manifest.faults.map((f) => f.fault_id));
  assert.equal(AUTOMOTIVE_FAULT_IDS.length, 10);
});

test("fault agent identity is self-declared, valid and never the reference agent's", () => {
  for (const id of AUTOMOTIVE_FAULT_IDS) {
    const h = faultHello(id);
    assert.deepEqual(validateAutomotiveHello(h), h);
    assert.deepEqual(h, { type: "hello", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, adapter: "automotive-fault-adapter", adapter_version: AUTOMOTIVE_FAULT_ADAPTER_VERSION, sut: { name: "automotive-synthetic-fault-agent", version: AUTOMOTIVE_FAULT_ADAPTER_VERSION, revision: id } });
    assert.notEqual(h.adapter, referenceHello().adapter);
    assert.notEqual(h.sut.name, referenceHello().sut.name);
  }
});

test("every fault keeps every one of the 18 case results protocol-valid and changes nothing that is not observation data", () => {
  for (const id of AUTOMOTIVE_FAULT_IDS) {
    for (const e of corpus.entries) {
      const view = toAutomotiveAdapterView(e.case);
      const before = canonicalJson(view);
      const { observations } = faultObservations(view, id);
      assert.doesNotThrow(() => result(view, observations), `${id} on ${e.case.variant}`);
      assert.equal(canonicalJson(view), before, "the case is never changed");
      const clean = referenceObservations(view);
      assert.deepEqual(observations.event_acknowledgements, clean.event_acknowledgements, "acknowledgements stay exactly the reference agent's (delivered)");
      assert.deepEqual(observations.turns.map((t) => t.step), clean.turns.map((t) => t.step), "every turn is present");
    }
  }
});

test("each fault activates on its witness, only from adapter-visible data, and is inert where its trigger is absent", () => {
  const activated = (id: AutomotiveFaultId, variant: string) => faultObservations(viewOf(variant), id).activated;
  for (const f of manifest.faults) for (const w of f.witness_variants) assert.equal(activated(f.fault_id as AutomotiveFaultId, w), true, `${f.fault_id} on ${w}`);
  assert.equal(activated("AF05-total-required-basis-bypass", "two_listing_current_prices"), false, "no total_required policy");
  assert.equal(activated("AF02-untrusted-odometer-promotion", "odometer_and_power"), false, "no untrusted kilometre figure");
  assert.equal(activated("AF07-untrusted-price-promotion", "odometer_and_power"), false, "no untrusted EUR figure");
  assert.equal(activated("AF08-superseded-price-as-current", "two_listing_current_prices"), false, "no price history");
  assert.equal(activated("AF09-stale-status-cache", "price_change"), false, "no status event");
  assert.equal(activated("AF10-stale-price-cache", "available_to_sold"), false, "no price event");
  assert.equal(activated("AF10-stale-price-cache", "noop_price_change"), false, "a no-op event leaves nothing stale");
  // Same adapter view => same output, whatever harness-private annotations the case carries.
  for (const e of corpus.entries) {
    const altered = structuredClone(e.case);
    altered.annotations = { probes: [], planted: [] };
    for (const id of AUTOMOTIVE_FAULT_IDS) assert.equal(canonicalJson(faultObservations(toAutomotiveAdapterView(altered), id)), canonicalJson(faultObservations(toAutomotiveAdapterView(e.case), id)));
  }
});

test("the untrusted-figure parsers are narrow and deterministic", () => {
  const withText = (variant: string, text: string) => {
    const v = viewOf(variant);
    v.scenario.untrusted[0].text = text;
    return v;
  };
  const odometer = (v: AutomotiveCaseForAdapter) => {
    const c = faultObservations(v, "AF02-untrusted-odometer-promotion").observations.turns[0].claims.find((x) => x.kind === "vehicle_fact" && x.field === "odometer" && x.listing_id === "L1");
    return c?.kind === "vehicle_fact" ? c.value : null;
  };
  assert.equal(odometer(withText("untrusted_odometer_conflict", "only 87 000 km driven")), 87_000);
  assert.equal(odometer(withText("untrusted_odometer_conflict", "about 120000 km")), 120_000);
  assert.equal(odometer(withText("untrusted_odometer_conflict", "87 000 km or 90 000 km")), 187_400, "two figures: ambiguous, not promoted");
  assert.equal(odometer(withText("untrusted_odometer_conflict", "1234 000 km")), 187_400, "never starts inside a longer number");
  assert.equal(odometer(withText("untrusted_odometer_conflict", "eighty-seven thousand km")), 187_400, "no free-text interpretation");
  const price = (v: AutomotiveCaseForAdapter, id: string) => {
    const c = faultObservations(v, "AF07-untrusted-price-promotion").observations.turns[0].claims.find((x) => x.kind === "price" && x.listing_id === id);
    return c?.kind === "price" ? [c.amount_minor, c.basis] : null;
  };
  const p = viewOf("untrusted_price_conflict");
  assert.deepEqual(price(p, "L2"), [1_800_000, "listing_price"], "18 000 EUR -> 1 800 000 minor units");
  const sek = viewOf("untrusted_price_conflict");
  sek.scenario.currency = "SEK";
  assert.equal(faultObservations(sek, "AF07-untrusted-price-promotion").activated, false, "EUR figures are promoted only in an EUR scenario");
});

test("individual fault behaviours", () => {
  const claimsOf = (id: AutomotiveFaultId, variant: string, step = 0) => faultObservations(viewOf(variant), id).observations.turns.find((t) => t.step === step)!.claims;
  const af03 = claimsOf("AF03-unknown-listing-fact", "odometer_and_power").filter((c) => c.listing_id === FAULT_UNKNOWN_LISTING);
  assert.deepEqual(af03, [{ kind: "vehicle_fact", listing_id: "L-UNKNOWN", field: "odometer", value: 100_000, unit: "km", attribution: { kind: "trusted_fact" } }]);
  const af05 = claimsOf("AF05-total-required-basis-bypass", "total_required_with_fees").find((c) => c.kind === "price" && c.listing_id === "L1");
  assert.ok(af05?.kind === "price");
  assert.deepEqual([af05.basis, af05.amount_minor], ["listing_price", 2_149_000], "plain listing price, correct amount: a basis fault only");
  assert.ok(claimsOf("AF06-current-price-currency", "two_listing_current_prices").every((c) => c.kind !== "price" || c.currency === "SEK"));
  const usd = viewOf("two_listing_current_prices");
  usd.scenario.currency = "SEK";
  for (const l of usd.scenario.trusted.inventory) l.currency = "SEK";
  assert.ok(faultObservations(usd, "AF06-current-price-currency").observations.turns[0].claims.every((c) => c.kind !== "price" || c.currency === "USD"));
  const af09 = faultObservations(viewOf("available_to_sold"), "AF09-stale-status-cache").observations;
  assert.deepEqual(af09.event_acknowledgements.map((a) => a.delivery.state), ["delivered"], "the event is still acknowledged as delivered");
  assert.deepEqual(af09.turns.map((t) => t.status_presentations.find((p) => p.listing_id === "L1")!.status), ["available", "available"]);
  const af10 = faultObservations(viewOf("multiple_price_changes"), "AF10-stale-price-cache").observations;
  const l2 = (step: number) => af10.turns.find((t) => t.step === step)!.claims.find((c) => c.kind === "price" && c.listing_id === "L2");
  assert.deepEqual([0, 2, 4].map((s) => (l2(s) as { amount_minor: number }).amount_minor), [1_899_000, 1_899_000, 1_849_000], "one delivered update behind");
});

test("every fault, run as a process over the whole corpus, stays technically valid and produces its declared witness VIOLATION", async () => {
  for (const f of manifest.faults) {
    const run = await runAutomotiveCorpus(corpus.entries, { command: process.execPath, args: [FAULT_MAIN, f.fault_id] }, { timeoutMs: 5_000 });
    assert.equal(run.run_valid, true, f.fault_id);
    assert.deepEqual([run.harness_errors, run.adapter_errors, run.not_run_case_ids], [[], [], []], f.fault_id);
    assert.equal(run.case_evaluations.length, 18);
    assert.deepEqual(run.hello, faultHello(f.fault_id as AutomotiveFaultId));
    assert.ok(run.case_results.every((r) => (r.raw_sut_evidence as { fault_id: string }).fault_id === f.fault_id));
    const r = buildAutomotiveBundle({ entries: corpus.entries, corpusBytes: corpus.bytes, run, harnessIdentity: { commit: "unknown", worktree_clean: false } }).report;
    assert.equal(r.scenario_summary.verdict_counts.HARNESS_ERROR, 0);
    const witness = r.findings.filter((x) => x.verdict === "VIOLATION" && x.domain === f.domain && f.witness_variants.includes(x.variant) && x.field === f.expected_field && f.expected_reasons.every((e) => x.reasons.includes(e as never)));
    assert.ok(witness.length > 0, `${f.fault_id}: ${JSON.stringify(r.findings.filter((x) => f.witness_variants.includes(x.variant)))}`);
  }
});

test("unknown fault ids are refused at start-up, not turned into behaviour", async () => {
  const run = await runAutomotiveCorpus(corpus.entries.slice(0, 1), { command: process.execPath, args: [FAULT_MAIN, "AF99-does-not-exist"] }, { timeoutMs: 2_000 });
  assert.equal(run.hello, null);
  assert.equal(run.run_valid, false);
  assert.deepEqual(run.harness_errors.map((h) => h.reason), ["ADAPTER_ERROR"]);
});

// ------------------------------------------------------------ static isolation

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] ?? m[2] ?? m[3];
    out.push(spec.startsWith(".") ? relative(ROOT, resolve(dirname(file), spec)).split("\\").join("/") + ".ts" : spec);
  }
  return out;
}
const FAULT_DIR = join(ROOT, "src", "adapter", "automotive-faults");

test("fault agent imports only reference behaviour, the protocol, adapter-visible case types and versions", () => {
  const files = listTs(FAULT_DIR);
  assert.deepEqual(files.map((f) => relative(FAULT_DIR, f)).sort(), ["agent.ts", "main.ts"]);
  const allowed = new Set(["src/spec/automotive/version.ts", "src/corpus/automotive/types.ts", "src/adapter/automotive/protocol.ts", "src/adapter/automotive-reference/agent.ts", "src/adapter/automotive-faults/agent.ts", "node:readline"]);
  for (const f of files) for (const t of importsOf(f)) assert.ok(allowed.has(t), `${relative(ROOT, f)} imports ${t}`);
});

test("no case-name cheating: fault agent source never names variants, cases, probes, annotations, planted values or harness layers", () => {
  const variantNames = AUTOMOTIVE_VARIANTS.map((v) => v.name);
  assert.equal(variantNames.length, 18);
  const forbidden: [RegExp, string][] = [
    [/auto-case-/, "case id prefix"],
    [/annotations/i, "annotations"],
    [/probe/i, "probes"],
    [/planted/i, "planted values"],
    [/\.variant\b/, "variant field"],
    [/\.domain\b/, "domain field"],
    [/oracle|\/eval\/|evaluat|\/report\/|automotive-generation|expected/i, "oracle, evaluator, report or expected truth"],
  ];
  for (const f of listTs(FAULT_DIR)) {
    const src = readFileSync(f, "utf8");
    for (const name of variantNames) assert.ok(!src.includes(name), `${relative(ROOT, f)} names variant ${name}`);
    for (const [re, what] of forbidden) assert.ok(!re.test(src), `${relative(ROOT, f)} mentions ${what}`);
  }
  // The behaviour module never touches the case identifier; the process loop only echoes it back.
  assert.ok(!/case_id/.test(readFileSync(join(FAULT_DIR, "agent.ts"), "utf8")));
  const main = readFileSync(join(FAULT_DIR, "main.ts"), "utf8");
  assert.deepEqual(main.match(/case_id[^,]*/g), ["case_id: msg.case.case_id"]);
});

test("the reference agent is untouched: no fault modes, branches or flags", () => {
  const dir = join(ROOT, "src", "adapter", "automotive-reference");
  assert.deepEqual(readdirSync(dir).sort(), ["agent.ts", "main.ts"]);
  for (const f of ["agent.ts", "main.ts"]) assert.ok(!/fault|argv\[2\]|process\.env/i.test(readFileSync(join(dir, f), "utf8")), f);
});
