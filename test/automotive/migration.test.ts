import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../src/util/hash";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import { AUTOMOTIVE_CASE_SCHEMA_VERSION, AUTOMOTIVE_CORPUS_ENTRY_VERSION, AUTOMOTIVE_ORACLE_VERSION } from "../../src/spec/automotive/version";

/**
 * Spec 7.4.13 case-schema migration: the 18 auto-0.1.0 variants regenerate semantically unchanged under
 * auto-case-0.2.0, except for the explicit `request: null` on every user_message step (and, in the
 * harness-owned expectation, the empty recommendation_expectations list) plus the contract version bumps.
 * The frozen auto-0.1.0 golden corpus is kept only as this test fixture.
 */
const ROOT = join(__dirname, "..", "..", "..");
const OLD_BYTES = readFileSync(join(ROOT, "test", "fixtures", "automotive", "smoke-auto-0.1.0.jsonl"), "utf8");
const OLD_SHA = "49c50fae1deeb1bd6f5a608ea0d9a2d5ebfd252e8df3ad59dc02b7cceb421a54";
const OLD = OLD_BYTES.trimEnd().split("\n").map((l) => JSON.parse(l));

const OLD_VERSIONS = { case_schema_version: "auto-case-0.1.0", corpus_entry_version: "auto-corpus-entry-0.1.0", oracle_version: "auto-oracle-0.1.0" };

/** The 0.2 entry mapped back to the 0.1 shape; fails if anything beyond the declared migration differs in kind. */
function downgrade(entry: any): any {
  const e = structuredClone(entry);
  assert.equal(e.corpus_entry_version, AUTOMOTIVE_CORPUS_ENTRY_VERSION);
  assert.equal(e.case.case_schema_version, AUTOMOTIVE_CASE_SCHEMA_VERSION);
  assert.equal(e.expected.oracle_version, AUTOMOTIVE_ORACLE_VERSION);
  e.corpus_entry_version = OLD_VERSIONS.corpus_entry_version;
  e.case.case_schema_version = OLD_VERSIONS.case_schema_version;
  e.expected.oracle_version = OLD_VERSIONS.oracle_version;
  for (const s of e.case.scenario.steps) {
    if (s.op !== "user_message") continue;
    assert.equal(s.request, null, `${e.case.case_id}: an auto-0.1.0 user turn must migrate to request: null`);
    delete s.request;
  }
  assert.deepEqual(e.expected.recommendation_expectations, [], `${e.case.case_id}: no recommendation expectation outside recommendation_integrity`);
  delete e.expected.recommendation_expectations;
  return e;
}

test("the frozen auto-0.1.0 golden fixture is byte-identical to the merged auto-0.1.0 golden", () => {
  assert.equal(sha256Hex(Buffer.from(OLD_BYTES, "utf8")), OLD_SHA);
  assert.equal(OLD.length, 18);
  for (const e of OLD) assert.equal(e.case.case_schema_version, "auto-case-0.1.0");
});

test("the 18 auto-0.1.0 variants regenerate semantically unchanged apart from request: null and version bumps", () => {
  const g = generateAutomotiveSmokeCorpus();
  assert.equal(g.entries.length, 24);
  const migrated = g.entries.slice(0, 18);
  migrated.forEach((entry, i) => {
    const old = OLD[i];
    assert.equal(entry.case.case_id, old.case.case_id);
    assert.equal(entry.case.domain, old.case.domain);
    assert.equal(entry.case.variant, old.case.variant);
    // Same scenario data, probes, planted values and probe expectations; only the declared migration differs.
    assert.deepEqual(downgrade(entry), old);
  });
});

test("the six new entries are the recommendation_integrity variants, appended after the migrated corpus", () => {
  const g = generateAutomotiveSmokeCorpus();
  const added = g.entries.slice(18);
  assert.deepEqual(
    added.map((e) => [e.case.case_id, e.case.domain, e.case.variant]),
    [
      ["auto-case-000019", "recommendation_integrity", "single_eligible_match"],
      ["auto-case-000020", "recommendation_integrity", "multiple_eligible_matches"],
      ["auto-case-000021", "recommendation_integrity", "no_eligible_match"],
      ["auto-case-000022", "recommendation_integrity", "unknown_listing_recommended"],
      ["auto-case-000023", "recommendation_integrity", "unavailable_listing_recommended"],
      ["auto-case-000024", "recommendation_integrity", "hard_constraint_mismatch"],
    ],
  );
  for (const e of added) {
    assert.deepEqual(e.expected.probe_expectations, []);
    assert.ok(e.expected.recommendation_expectations.length >= 1);
  }
});

test("a downgrade that drops a migrated difference is detected (the migration check is not vacuous)", () => {
  const g = generateAutomotiveSmokeCorpus();
  const tampered = structuredClone(g.entries[0]) as any;
  tampered.case.scenario.steps[0].text += " (changed)";
  assert.notDeepEqual(downgrade(tampered), OLD[0]);
  const withRequest = structuredClone(g.entries[0]) as any;
  withRequest.case.scenario.steps[0].request = { kind: "recommendation", hard_constraints: {} };
  assert.throws(() => downgrade(withRequest), /request: null/);
});
