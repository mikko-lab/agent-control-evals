import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { AUTOMOTIVE_CASE_SCHEMA_VERSION, AUTOMOTIVE_PACK_VERSION, AUTOMOTIVE_REASON_TAXONOMY_VERSION } from "../../src/spec/automotive/version";
import {
  ALL_AUTOMOTIVE_DOMAINS,
  EXECUTABLE_AUTOMOTIVE_DOMAINS,
  PLANNED_AUTOMOTIVE_DOMAINS,
  automotiveDomainStatus,
  isAutomotiveDomain,
  isExecutableAutomotiveDomain,
} from "../../src/spec/automotive/domains";
import { AUTOMOTIVE_VERDICTS, isAutomotiveVerdict } from "../../src/spec/automotive/outcomes";
import {
  AUTOMOTIVE_HARNESS_ERROR_REASONS,
  AUTOMOTIVE_REASON_CLASSES,
  AUTOMOTIVE_REASON_REFINEMENTS,
  AUTOMOTIVE_REASON_TAXONOMY,
  AUTOMOTIVE_REASONS_BY_VERDICT,
  AUTOMOTIVE_UNASSESSABLE_REASONS,
  AUTOMOTIVE_VIOLATION_REASONS,
  isAutomotiveReasonClass,
} from "../../src/spec/automotive/reason-taxonomy";
import { ALL_FAMILIES } from "../../src/spec/families";
import { REASON_CLASSES } from "../../src/spec/reason-taxonomy";
import { CASE_SCHEMA_VERSION, HARNESS_VERSION, REASON_TAXONOMY_VERSION } from "../../src/version";

const ROOT = join(__dirname, "..", "..", "..");

test("automotive versions are exact and independent of the ACS versions", () => {
  assert.equal(AUTOMOTIVE_PACK_VERSION, "auto-0.1.0");
  assert.equal(AUTOMOTIVE_CASE_SCHEMA_VERSION, "auto-case-0.1.0");
  assert.equal(AUTOMOTIVE_REASON_TAXONOMY_VERSION, "auto-reasons-0.1.0");
  for (const v of [AUTOMOTIVE_PACK_VERSION, AUTOMOTIVE_CASE_SCHEMA_VERSION, AUTOMOTIVE_REASON_TAXONOMY_VERSION]) {
    assert.ok(![CASE_SCHEMA_VERSION, HARNESS_VERSION, REASON_TAXONOMY_VERSION].includes(v as never), `${v} collides with an ACS version`);
  }
});

test("domain registry: 3 executable, 7 planned, 10 total, no duplicates", () => {
  assert.deepEqual([...EXECUTABLE_AUTOMOTIVE_DOMAINS], ["vehicle_fact_integrity", "price_attribution", "stale_inventory"]);
  assert.deepEqual([...PLANNED_AUTOMOTIVE_DOMAINS], [
    "recommendation_integrity",
    "financing_fact_integrity",
    "prompt_injection_from_listing",
    "unauthorized_external_action",
    "confirmation_before_action",
    "sponsored_ranking_separation",
    "human_ai_handoff",
  ]);
  assert.equal(ALL_AUTOMOTIVE_DOMAINS.length, 10);
  assert.equal(new Set(ALL_AUTOMOTIVE_DOMAINS).size, 10);
  assert.deepEqual([...ALL_AUTOMOTIVE_DOMAINS], [...EXECUTABLE_AUTOMOTIVE_DOMAINS, ...PLANNED_AUTOMOTIVE_DOMAINS]);
  for (const d of EXECUTABLE_AUTOMOTIVE_DOMAINS) assert.equal(automotiveDomainStatus(d), "EXECUTABLE_TARGET");
  for (const d of PLANNED_AUTOMOTIVE_DOMAINS) {
    assert.equal(automotiveDomainStatus(d), "PLANNED");
    assert.equal(isExecutableAutomotiveDomain(d), false);
  }
  assert.equal(isAutomotiveDomain("vehicle_fact_integrity"), true);
  assert.equal(isAutomotiveDomain("capability_agent_binding"), false);
  assert.equal(isAutomotiveDomain(42), false);
});

test("verdict vocabulary is exactly the four normative verdicts; UNVERIFIABLE is not a verdict", () => {
  assert.deepEqual([...AUTOMOTIVE_VERDICTS], ["PASS", "VIOLATION", "UNASSESSABLE", "HARNESS_ERROR"]);
  assert.equal(isAutomotiveVerdict("UNVERIFIABLE"), false);
  assert.equal(isAutomotiveVerdict("pass"), false);
  for (const v of AUTOMOTIVE_VERDICTS) assert.equal(isAutomotiveVerdict(v), true);
});

test("reason taxonomy: exact classes, partitioned by non-PASS verdict, versioned", () => {
  assert.deepEqual([...AUTOMOTIVE_VIOLATION_REASONS], [
    "FACT_VALUE_MISMATCH",
    "CROSS_LISTING_FACT",
    "UNKNOWN_LISTING_REFERENCE",
    "UNTRUSTED_VALUE_PROMOTED",
    "PRICE_VALUE_MISMATCH",
    "CROSS_LISTING_PRICE",
    "SUPERSEDED_PRICE",
    "PRICE_BASIS_MISMATCH",
    "CURRENCY_MISMATCH",
    "STALE_STATUS",
    "STALE_PRICE",
  ]);
  assert.deepEqual([...AUTOMOTIVE_UNASSESSABLE_REASONS], ["CHANNEL_UNAVAILABLE", "PROBE_UNANSWERED", "PROBE_DECLINED", "EVENT_DELIVERY_UNCONFIRMED", "CLAIM_OUTSIDE_CONTRACT"]);
  assert.deepEqual([...AUTOMOTIVE_HARNESS_ERROR_REASONS], ["PROTOCOL_ERROR", "ADAPTER_ERROR", "TIMEOUT", "FIXTURE_INVALID", "ORACLE_INTEGRITY_ERROR"]);
  assert.equal(AUTOMOTIVE_REASON_CLASSES.length, 21);
  assert.equal(new Set(AUTOMOTIVE_REASON_CLASSES).size, 21, "no duplicate reason classes");
  assert.deepEqual(Object.keys(AUTOMOTIVE_REASONS_BY_VERDICT).sort(), ["HARNESS_ERROR", "UNASSESSABLE", "VIOLATION"], "PASS carries no reason class");
  const partition = Object.values(AUTOMOTIVE_REASONS_BY_VERDICT).flat();
  assert.deepEqual([...partition].sort(), [...AUTOMOTIVE_REASON_CLASSES].sort(), "every class belongs to exactly one verdict");
  assert.equal(AUTOMOTIVE_REASON_TAXONOMY.version, "auto-reasons-0.1.0");
  for (const r of AUTOMOTIVE_REASON_CLASSES) assert.equal(isAutomotiveReasonClass(r), true);
  assert.equal(isAutomotiveReasonClass("POLICY_DENY"), false);
  assert.equal(isAutomotiveReasonClass(undefined), false);
});

test("diagnostic refinements refine VIOLATION base classes only", () => {
  const violation = new Set<string>(AUTOMOTIVE_VIOLATION_REASONS);
  assert.deepEqual(Object.keys(AUTOMOTIVE_REASON_REFINEMENTS).sort(), ["CROSS_LISTING_FACT", "CROSS_LISTING_PRICE", "STALE_PRICE", "SUPERSEDED_PRICE", "UNTRUSTED_VALUE_PROMOTED"]);
  for (const [refinement, bases] of Object.entries(AUTOMOTIVE_REASON_REFINEMENTS)) {
    assert.ok(violation.has(refinement));
    for (const b of bases ?? []) {
      assert.ok(violation.has(b), `${refinement} refines non-violation ${b}`);
      assert.ok(!(b in AUTOMOTIVE_REASON_REFINEMENTS), `${b} is itself a refinement`);
    }
  }
});

test("automotive names do not collide with ACS families or ACS reason classes", () => {
  const families = new Set<string>(ALL_FAMILIES);
  for (const d of ALL_AUTOMOTIVE_DOMAINS) assert.ok(!families.has(d), `domain ${d} collides with an ACS family`);
  const acsReasons = new Set<string>(REASON_CLASSES);
  for (const r of AUTOMOTIVE_REASON_CLASSES) assert.ok(!acsReasons.has(r), `reason ${r} collides with an ACS reason class`);
});

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

test("automotive modules import only automotive modules (no ACS Family, outcome, reason or corpus types)", () => {
  const files = [...listTs(join(ROOT, "src", "spec", "automotive")), ...listTs(join(ROOT, "src", "corpus", "automotive"))];
  assert.ok(files.length >= 7);
  const allowed = ["src/spec/automotive/", "src/corpus/automotive/"];
  const re = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const spec = m[1] ?? m[2] ?? m[3];
      assert.ok(spec.startsWith("."), `${relative(ROOT, f)} imports non-relative module ${spec}`);
      const target = relative(ROOT, resolve(dirname(f), spec)).split("\\").join("/") + ".ts";
      assert.ok(allowed.some((a) => target.startsWith(a)), `${relative(ROOT, f)} imports ${target} outside the automotive namespace`);
    }
  }
});
