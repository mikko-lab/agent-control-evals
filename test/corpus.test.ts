import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allocate, generateCorpus } from "../src/corpus/generate";
import { PROFILES } from "../src/corpus/profiles";
import { ALL_FAMILIES, boundaryOfFamily } from "../src/spec/families";
import { FAMILY_VARIANTS } from "../src/corpus/registry";
import { forAdapter } from "../src/eval/run";
import { loadMutationManifest } from "../src/mutation/manifest";
import { isWitnessCandidate } from "../src/mutation/runner";
import { MIN_SMOKE_WITNESS_CANDIDATES } from "../src/mutation/reachability";
import { sha256Hex } from "../src/util/hash";

const ROOT = join(__dirname, "..", "..");
const smoke = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases);

test("smoke corpus is byte-for-byte deterministic and matches the committed golden", () => {
  const again = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases);
  assert.equal(smoke.bytes, again.bytes);
  assert.equal(readFileSync(join(ROOT, "corpus", "smoke.sha256"), "utf8").trim(), smoke.sha256);
  assert.equal(sha256Hex(readFileSync(join(ROOT, "corpus", "smoke.jsonl"))), smoke.sha256);
});

test("corpus bytes do not depend on timezone, locale or wall clock", () => {
  const script = `const g=require(${JSON.stringify(join(ROOT, "dist", "src", "corpus", "generate.js"))});process.stdout.write(g.generateCorpus(${JSON.stringify(PROFILES.smoke.seed)},${PROFILES.smoke.cases}).sha256)`;
  for (const env of [{ TZ: "Pacific/Kiritimati", LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8" }, { TZ: "America/Adak", LANG: "C" }]) {
    const out = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(out, smoke.sha256);
  }
});

test("format: UTF-8, LF only, one record per line, single final newline, canonical lines", () => {
  assert.ok(smoke.bytes.endsWith("}\n") && !smoke.bytes.endsWith("\n\n"));
  assert.ok(!smoke.bytes.includes("\r"));
  const lines = smoke.bytes.slice(0, -1).split("\n");
  assert.equal(lines.length, PROFILES.smoke.cases);
  for (const l of lines.slice(0, 20)) assert.equal(l, JSON.stringify(sortKeys(JSON.parse(l))));
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

test("allocation is stratified: families equal (+/-1), variants within a family equal (+/-1)", () => {
  for (const n of [PROFILES.smoke.cases, PROFILES.full.cases, 1234]) {
    const a = allocate(n);
    assert.equal(a.reduce((s, x) => s + x.count, 0), n);
    const perFam = ALL_FAMILIES.map((f) => a.filter((x) => x.family === f).reduce((s, x) => s + x.count, 0));
    assert.ok(Math.max(...perFam) - Math.min(...perFam) <= 1, `family spread at n=${n}`);
    for (const f of ALL_FAMILIES) {
      const v = a.filter((x) => x.family === f).map((x) => x.count);
      assert.ok(Math.max(...v) - Math.min(...v) <= 1);
      assert.equal(v.length, FAMILY_VARIANTS[f].length);
    }
  }
});

test("every case carries the required fields and a boundary consistent with its family", () => {
  for (const c of smoke.cases) {
    for (const k of ["case_id", "family", "variant", "evaluation_boundary", "scenario", "expected"]) assert.ok(k in c, k);
    assert.equal(c.evaluation_boundary, boundaryOfFamily(c.family));
    assert.ok(typeof c.expected.outcome === "string" && typeof c.expected.stage === "string");
  }
});

test("the adapter view of a case never contains the expectation", () => {
  for (const c of smoke.cases.slice(0, 50)) {
    const v = forAdapter(c) as Record<string, unknown>;
    assert.equal("expected" in v, false);
    assert.equal(JSON.stringify(v).includes('"acceptable_reason_classes"'), false);
  }
});

test("every mutant has enough smoke witness candidates on its own boundary", () => {
  const m = loadMutationManifest(ROOT);
  for (const x of m.mutants) {
    const n = smoke.cases.filter((c) => isWitnessCandidate(c, x)).length;
    assert.ok(n >= MIN_SMOKE_WITNESS_CANDIDATES, `${x.mutation_id}: ${n}`);
  }
});

test("each family has adversarial and non-adversarial variants (false-allow and false-deny are both measurable)", () => {
  for (const f of ALL_FAMILIES) {
    const vs = FAMILY_VARIANTS[f];
    assert.ok(vs.some((v) => v.adversarial), `${f} adversarial`);
    assert.ok(vs.some((v) => !v.adversarial), `${f} positive control`);
  }
});
