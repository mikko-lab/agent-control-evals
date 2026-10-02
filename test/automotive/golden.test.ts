import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import type { AutomotiveCorpusEntry } from "../../src/corpus/automotive-generation/corpus-entry";
import { deriveAutomotiveExpected } from "../../src/oracle/automotive/expected";
import { AUTOMOTIVE_CASE_SCHEMA_VERSION, AUTOMOTIVE_CORPUS_ENTRY_VERSION, AUTOMOTIVE_ORACLE_VERSION } from "../../src/spec/automotive/version";
import { sha256Hex } from "../../src/util/hash";

const ROOT = join(__dirname, "..", "..", "..");
const GOLDEN = join(ROOT, "corpus", "automotive", "smoke.jsonl");
const GOLDEN_SHA = join(ROOT, "corpus", "automotive", "smoke.sha256");
const ACS_GOLDEN_SHA = "3e7fe2c95bb3859e24d9583aabc9b28004d998fdb570df197eea57dfaf9633fc";

const committed = readFileSync(GOLDEN);
const committedSha = readFileSync(GOLDEN_SHA, "utf8");
const lines = committed.toString("utf8").split("\n");
const entries = lines.slice(0, -1).map((l) => JSON.parse(l) as AutomotiveCorpusEntry);

test("generated automotive corpus equals the committed golden bytes and SHA-256", () => {
  const g = generateAutomotiveSmokeCorpus();
  assert.equal(g.bytes, committed.toString("utf8"), "regenerate corpus/automotive/smoke.jsonl only together with a reviewed version bump");
  assert.equal(committedSha, `${g.sha256}\n`, "smoke.sha256 holds the SHA-256 and one LF");
  assert.equal(sha256Hex(committed), g.sha256, "the SHA covers the exact committed bytes");
  assert.equal(generateAutomotiveSmokeCorpus().bytes, g.bytes, "two generations are byte-identical");
});

test("committed format: 18 canonical JSON lines, LF only, exactly one final newline", () => {
  assert.equal(lines.length, 19);
  assert.equal(lines[18], "", "exactly one final LF");
  assert.ok(!committed.includes(0x0d), "no CR");
  assert.equal(entries.length, 18);
});

test("every committed case satisfies the automotive case JSON Schema and carries current versions", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(readFileSync(join(ROOT, "schemas", "automotive", "case.schema.json"), "utf8")));
  for (const e of entries) {
    assert.ok(validate(e.case), `${e.case.case_id}: ${JSON.stringify(validate.errors)}`);
    assert.equal(e.corpus_entry_version, AUTOMOTIVE_CORPUS_ENTRY_VERSION);
    assert.equal(e.case.case_schema_version, AUTOMOTIVE_CASE_SCHEMA_VERSION);
    assert.equal(e.expected.oracle_version, AUTOMOTIVE_ORACLE_VERSION);
  }
});

test("recomputing the oracle from each committed case reproduces the committed expected output", () => {
  for (const e of entries) assert.deepEqual(deriveAutomotiveExpected(e.case), e.expected, `${e.case.case_id}: stale committed expectation`);
});

test("a stale committed expectation would be detected", () => {
  const stale = structuredClone(entries.find((e) => e.case.variant === "price_change")!);
  const p = stale.expected.probe_expectations.find((x) => x.probe_id === "p2");
  assert.ok(p && p.kind === "price");
  p.accepted_presentations[0].amount_minor = 1_899_000; // the pre-event price
  assert.notDeepEqual(deriveAutomotiveExpected(stale.case), stale.expected);
  const tampered = committed.toString("utf8").replace("\"amount_minor\":1849000", "\"amount_minor\":1899000");
  assert.notEqual(sha256Hex(Buffer.from(tampered, "utf8")), committedSha.trim(), "any byte change breaks the committed SHA");
});

test("the ACS golden corpus and its SHA are untouched", () => {
  const acs = readFileSync(join(ROOT, "corpus", "smoke.jsonl"));
  assert.equal(sha256Hex(acs), ACS_GOLDEN_SHA);
  assert.equal(readFileSync(join(ROOT, "corpus", "smoke.sha256"), "utf8").trim(), ACS_GOLDEN_SHA);
});
