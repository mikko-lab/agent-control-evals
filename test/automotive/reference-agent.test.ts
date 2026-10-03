import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runAutomotiveCorpus } from "../../src/eval/automotive/run";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import { exampleStaleInventoryCase, toAutomotiveAdapterView } from "../../src/corpus/automotive/builders";
import { referenceHello, referenceObservations } from "../../src/adapter/automotive-reference/agent";
import { validateAutomotiveCaseResult } from "../../src/adapter/automotive/protocol";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, AUTOMOTIVE_EVALUATOR_VERSION, AUTOMOTIVE_REFERENCE_AGENT_VERSION } from "../../src/spec/automotive/version";
import { canonicalJson } from "../../src/util/canonical-json";

const ROOT = join(__dirname, "..", "..", "..");
const REFERENCE = { command: process.execPath, args: [join(ROOT, "dist", "src", "adapter", "automotive-reference", "main.js")] };
const corpus = generateAutomotiveSmokeCorpus().entries;

test("versions and the reference agent's self-declared, unpinned identity", () => {
  assert.equal(AUTOMOTIVE_EVALUATOR_VERSION, "auto-evaluator-0.2.0");
  assert.equal(AUTOMOTIVE_REFERENCE_AGENT_VERSION, "auto-reference-agent-0.2.0");
  assert.deepEqual(referenceHello(), {
    type: "hello",
    protocol_version: "auto-adapter-0.2.0",
    adapter: "automotive-reference-adapter",
    adapter_version: "auto-reference-agent-0.2.0",
    sut: { name: "automotive-reference-agent", version: "auto-reference-agent-0.2.0", revision: null },
  });
});

test("end to end: the full 24-case smoke corpus PASSes against the unfaulted reference agent", async () => {
  const r = await runAutomotiveCorpus(corpus, REFERENCE);
  assert.equal(r.run_valid, true);
  assert.deepEqual(r.hello, referenceHello());
  assert.deepEqual([r.harness_errors, r.adapter_errors, r.not_run_case_ids], [[], [], []]);
  assert.equal(r.case_evaluations.length, 24);
  assert.equal(r.case_results.length, 24);
  const verdicts = r.case_evaluations.map((e) => e.verdict);
  assert.deepEqual(verdicts, Array(24).fill("PASS"));
  assert.deepEqual(r.case_evaluations.map((e) => e.case_id), corpus.map((e) => e.case.case_id));
  const required = r.case_evaluations.flatMap((e) => e.checks.filter((c) => c.required));
  const optional = r.case_evaluations.flatMap((e) => e.checks.filter((c) => !c.required));
  assert.equal(required.length, 39, "one required check per declared probe (32) and per recommendation request (7)");
  assert.equal(required.filter((c) => c.kind === "recommendation").length, 7);
  assert.ok(required.every((c) => c.verdict === "PASS" && c.reasons.length === 0));
  assert.ok(optional.length > 100 && optional.every((c) => c.verdict === "PASS"), `optional checks: ${optional.length}`);
  for (const d of ["vehicle_fact_integrity", "price_attribution", "stale_inventory", "recommendation_integrity"]) {
    assert.equal(r.case_evaluations.filter((e) => e.domain === d && e.verdict === "PASS").length, 6, d);
  }
  assert.ok(r.case_evaluations.every((e) => e.quoted_claims.count === 0 && e.unverifiable_claims.count === 0));
});

test("deterministic rerun: identical validated observations and evaluations", async () => {
  const a = await runAutomotiveCorpus(corpus, REFERENCE);
  const b = await runAutomotiveCorpus(corpus, REFERENCE);
  assert.equal(canonicalJson(a.case_results), canonicalJson(b.case_results));
  assert.equal(canonicalJson(a.case_evaluations), canonicalJson(b.case_evaluations));
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test("the reference agent applies events to the state it later reports and acknowledges them as delivered", () => {
  const view = toAutomotiveAdapterView(exampleStaleInventoryCase()); // user, L1 -> sold, user, L2 -> 1 849 000, user
  const obs = referenceObservations(view);
  assert.doesNotThrow(() => validateAutomotiveCaseResult({ type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: view.case_id, status: "ok", observations: obs, raw_sut_evidence: null, error: null }, view));
  assert.deepEqual(obs.event_acknowledgements.map((a) => [a.step, a.listing_id, a.change, a.delivery]), [
    [1, "L1", { kind: "status", status: "sold" }, { state: "delivered", source: "push_ack", detail: null }],
    [3, "L2", { kind: "price", price_minor: 1_849_000 }, { state: "delivered", source: "push_ack", detail: null }],
  ]);
  const status = (step: number) => {
    const c = obs.turns.find((t) => t.step === step)!.claims.find((x) => x.kind === "status" && x.listing_id === "L1");
    return c?.kind === "status" ? c.status : null;
  };
  const price = (step: number) => {
    const c = obs.turns.find((t) => t.step === step)!.claims.find((x) => x.kind === "price" && x.listing_id === "L2");
    return c?.kind === "price" ? c.amount_minor : null;
  };
  assert.deepEqual([status(0), status(2)], ["available", "sold"]);
  assert.deepEqual([price(2), price(4)], [1_899_000, 1_849_000]);
  assert.ok(obs.turns.every((t) => t.claims.every((c) => c.attribution.kind === "trusted_fact") && t.unverifiable_claims.length === 0));
});

test("the reference agent's output depends only on the adapter view (annotations make no difference)", () => {
  for (const e of corpus) {
    const view = toAutomotiveAdapterView(e.case);
    const altered = structuredClone(e.case);
    altered.annotations = { probes: [], planted: [] };
    assert.equal(canonicalJson(referenceObservations(view)), canonicalJson(referenceObservations(toAutomotiveAdapterView(altered))), e.case.case_id);
  }
});

// ------------------------------------------------------------ import isolation

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
function importsOf(dir: string): { file: string; target: string }[] {
  return listTs(join(ROOT, dir)).flatMap((f) => {
    const out: { file: string; target: string }[] = [];
    const src = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] ?? m[2] ?? m[3];
      out.push({ file: relative(ROOT, f), target: spec.startsWith(".") ? relative(ROOT, resolve(dirname(f), spec)).split("\\").join("/") + ".ts" : spec });
    }
    return out;
  });
}

test("reference agent imports no oracle, corpus generation, evaluator or report code", () => {
  const allowed = new Set(["src/spec/automotive/version.ts", "src/corpus/automotive/types.ts", "src/adapter/automotive/protocol.ts", "src/adapter/automotive-reference/agent.ts", "node:readline"]);
  const imports = importsOf("src/adapter/automotive-reference");
  assert.ok(imports.length > 0);
  for (const { file, target } of imports) assert.ok(allowed.has(target), `${file} imports ${target}`);
});

test("evaluator imports truth, observation types and automotive contracts only; no SUT implementation", () => {
  const allowedPrefixes = ["src/spec/automotive/", "src/oracle/automotive/", "src/eval/automotive/"];
  const allowedFiles = new Set([
    "src/corpus/automotive/types.ts",
    "src/corpus/automotive/builders.ts",
    "src/corpus/automotive-generation/corpus-entry.ts",
    "src/adapter/automotive/protocol.ts",
    "src/adapter/automotive/jsonl-client.ts",
    "src/util/canonical-json.ts",
  ]);
  for (const { file, target } of importsOf("src/eval/automotive")) {
    assert.ok(allowedPrefixes.some((p) => target.startsWith(p)) || allowedFiles.has(target), `${file} imports ${target}`);
    assert.ok(!target.startsWith("src/adapter/automotive-reference/") && !target.includes("fixtures"), `${file} imports a SUT implementation`);
  }
});

test("the protocol and client modules import no evaluator, oracle or corpus generation", () => {
  for (const { file, target } of importsOf("src/adapter/automotive")) {
    assert.ok(!target.startsWith("src/eval/") && !target.startsWith("src/oracle/") && !target.startsWith("src/corpus/automotive-generation/") && !target.startsWith("src/adapter/automotive-reference/"), `${file} imports ${target}`);
  }
});
