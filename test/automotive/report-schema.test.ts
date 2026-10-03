import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import { runAutomotiveCorpus } from "../../src/eval/automotive/run";
import type { AutomotiveRunOutput } from "../../src/eval/automotive/types";
import { buildAutomotiveBundle } from "../../src/report/automotive/build";
import { AUTOMOTIVE_REPORT_LIMITATIONS } from "../../src/report/automotive/limitations";
import { AUTOMOTIVE_EVIDENCE_ORDER, AUTOMOTIVE_EVIDENCE_RECORD_FORMAT, AUTOMOTIVE_EVIDENCE_STATUSES, AUTOMOTIVE_IDENTITY_SOURCE, type AutomotiveReport } from "../../src/report/automotive/types";
import { loadAutomotiveSchema, validateAutomotiveManifest, validateAutomotiveReport } from "../../src/report/automotive/validate";
import { AUTOMOTIVE_VERDICTS } from "../../src/spec/automotive/outcomes";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS } from "../../src/spec/automotive/domains";
import { AUTOMOTIVE_HARNESS_ERROR_REASONS, AUTOMOTIVE_REASON_CLASSES, AUTOMOTIVE_UNASSESSABLE_REASONS, AUTOMOTIVE_VIOLATION_REASONS } from "../../src/spec/automotive/reason-taxonomy";
import * as V from "../../src/spec/automotive/version";
import { AUTOMOTIVE_SMOKE_CORPUS_IDENTITY } from "../../src/corpus/automotive/profiles";
import { PROBE_FIELDS } from "../../src/corpus/automotive/types";
import { AUTOMOTIVE_OBSERVATION_STATES, CLAIM_ATTRIBUTION_KINDS, EVENT_DELIVERY_STATES, UNVERIFIABLE_CLASSIFICATIONS } from "../../src/adapter/automotive/protocol";

const ROOT = join(__dirname, "..", "..", "..");
const REFERENCE = { command: process.execPath, args: [join(ROOT, "dist", "src", "adapter", "automotive-reference", "main.js")] };
const FAKE = join(ROOT, "test", "fixtures", "automotive", "fake-adapter.js");
const corpus = generateAutomotiveSmokeCorpus();
const report = loadAutomotiveSchema("report") as any;
const manifest = loadAutomotiveSchema("manifest") as any;
const defs = report.$defs;

const runs = new Map<string, Promise<AutomotiveRunOutput>>();
async function bundle(mode: string) {
  if (!runs.has(mode)) runs.set(mode, runAutomotiveCorpus(corpus.entries, mode === "reference" ? REFERENCE : { command: process.execPath, args: [FAKE, mode] }, { timeoutMs: 5_000 }));
  const run = structuredClone(await runs.get(mode)!);
  return buildAutomotiveBundle({ entries: corpus.entries, corpusBytes: corpus.bytes, run, harnessIdentity: { commit: "0123456789abcdef0123456789abcdef01234567", worktree_clean: false } });
}
const sorted = (xs: readonly string[]) => [...xs].sort();

// ------------------------------------------------------------ parity

test("schema/code parity: versions", () => {
  assert.equal(report.properties.report_schema_version.const, V.AUTOMOTIVE_REPORT_SCHEMA_VERSION);
  assert.equal(report.properties.pack_version.const, V.AUTOMOTIVE_PACK_VERSION);
  assert.equal(report.properties.profile.const, AUTOMOTIVE_SMOKE_CORPUS_IDENTITY.profile);
  assert.equal(manifest.properties.manifest_version.const, V.AUTOMOTIVE_MANIFEST_VERSION);
  assert.equal(manifest.properties.evidence.properties.evidence_version.const, V.AUTOMOTIVE_EVIDENCE_VERSION);
  assert.equal(manifest.properties.evidence.properties.record_format.const, AUTOMOTIVE_EVIDENCE_RECORD_FORMAT);
  assert.equal(manifest.properties.evidence.properties.order.const, AUTOMOTIVE_EVIDENCE_ORDER);
  const pack = manifest.properties.pack.properties;
  const expected: Record<string, string> = {
    pack_version: V.AUTOMOTIVE_PACK_VERSION,
    case_schema_version: V.AUTOMOTIVE_CASE_SCHEMA_VERSION,
    reason_taxonomy_version: V.AUTOMOTIVE_REASON_TAXONOMY_VERSION,
    oracle_version: V.AUTOMOTIVE_ORACLE_VERSION,
    generator_version: V.AUTOMOTIVE_GENERATOR_VERSION,
    corpus_entry_version: V.AUTOMOTIVE_CORPUS_ENTRY_VERSION,
    adapter_protocol_version: V.AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION,
    evaluator_version: V.AUTOMOTIVE_EVALUATOR_VERSION,
    report_schema_version: V.AUTOMOTIVE_REPORT_SCHEMA_VERSION,
  };
  assert.deepEqual(Object.fromEntries(Object.entries(pack).map(([k, v]) => [k, (v as { const: string }).const])), expected);
  assert.deepEqual(sorted(manifest.properties.pack.required), sorted(Object.keys(expected)));
  for (const [k, v] of Object.entries(AUTOMOTIVE_SMOKE_CORPUS_IDENTITY)) assert.equal(manifest.properties.corpus.properties[k].const, v, k);
  assert.equal(manifest.properties.evaluation.properties.evaluator_version.const, V.AUTOMOTIVE_EVALUATOR_VERSION);
  assert.equal(defs.caseEvaluation.properties.evaluator_version.const, V.AUTOMOTIVE_EVALUATOR_VERSION);
  assert.equal(manifest.properties.adapter.oneOf[1].properties.protocol_version.const, V.AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION);
  assert.equal(manifest.properties.adapter.oneOf[1].properties.identity_source.const, AUTOMOTIVE_IDENTITY_SOURCE);
  assert.equal(manifest.properties.sut.oneOf[1].properties.identity_source.const, AUTOMOTIVE_IDENTITY_SOURCE);
});

test("schema/code parity: verdicts, every reason class, domains, evidence statuses and observation vocabularies", () => {
  assert.deepEqual(defs.verdict.enum, [...AUTOMOTIVE_VERDICTS]);
  assert.deepEqual(defs.verdictCounts.required, [...AUTOMOTIVE_VERDICTS]);
  assert.deepEqual(defs.reason.enum, [...AUTOMOTIVE_REASON_CLASSES]);
  const byVerdict = Object.fromEntries(defs.reasonsForVerdict.allOf.map((b: any) => [b.if.properties.verdict.const, b.then.properties.reasons.items?.enum ?? []]));
  assert.deepEqual(byVerdict, { PASS: [], VIOLATION: [...AUTOMOTIVE_VIOLATION_REASONS], UNASSESSABLE: [...AUTOMOTIVE_UNASSESSABLE_REASONS], HARNESS_ERROR: [...AUTOMOTIVE_HARNESS_ERROR_REASONS] });
  const rc = report.properties.reason_counts.properties;
  assert.deepEqual([rc.VIOLATION.required, rc.UNASSESSABLE.required, rc.HARNESS_ERROR.required], [[...AUTOMOTIVE_VIOLATION_REASONS], [...AUTOMOTIVE_UNASSESSABLE_REASONS], [...AUTOMOTIVE_HARNESS_ERROR_REASONS]]);
  assert.deepEqual(defs.harnessError.properties.reason.enum, [...AUTOMOTIVE_HARNESS_ERROR_REASONS]);
  assert.deepEqual(defs.finding.properties.verdict.enum, AUTOMOTIVE_VERDICTS.filter((v) => v !== "PASS"));
  assert.deepEqual(defs.domain.enum, [...EXECUTABLE_AUTOMOTIVE_DOMAINS]);
  assert.deepEqual(report.properties.by_domain.required, [...EXECUTABLE_AUTOMOTIVE_DOMAINS]);
  assert.deepEqual(manifest.$defs.domainCounts.required, [...EXECUTABLE_AUTOMOTIVE_DOMAINS]);
  assert.deepEqual(manifest.properties.evaluation.properties.case_statuses.required, [...AUTOMOTIVE_EVIDENCE_STATUSES]);
  assert.deepEqual(defs.field.oneOf[1].enum, [...PROBE_FIELDS]);
  const oe = report.properties.observation_evidence.properties;
  assert.deepEqual(oe.unverifiable_claims.properties.by_classification.required, [...UNVERIFIABLE_CLASSIFICATIONS]);
  assert.deepEqual(oe.attribution_counts.required, [...CLAIM_ATTRIBUTION_KINDS]);
  assert.deepEqual(oe.event_delivery_states.required, [...EVENT_DELIVERY_STATES]);
  for (const ch of ["claim", "reference", "status"]) assert.deepEqual(oe.channel_states.properties[ch].required, [...AUTOMOTIVE_OBSERVATION_STATES]);
  assert.deepEqual(defs.unverifiableClaim.properties.classification.enum, [...UNVERIFIABLE_CLASSIFICATIONS]);
  assert.deepEqual(defs.observationSummary.properties.event_acknowledgements.items.properties.delivery.enum, [...EVENT_DELIVERY_STATES]);
  assert.equal(report.properties.limitations.minItems, AUTOMOTIVE_REPORT_LIMITATIONS.length);
});

test("the report schema references the manifest schema instead of duplicating it; both are closed 2020-12 schemas", () => {
  assert.deepEqual(report.properties.manifest, { $ref: "manifest.schema.json" });
  for (const s of [report, manifest]) {
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(s.$id, /^https:\/\/github\.com\/mikko-lab\/agent-control-evals\/schemas\/automotive\/(report|manifest)\.schema\.json$/);
    assert.equal(s.additionalProperties, false);
  }
  // Every closed control object is closed; only expected/observed payloads are open.
  const open: string[] = [];
  const walk = (node: any, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node === null || typeof node !== "object") return;
    if (node.type === "object" && node.properties && node.additionalProperties !== false) open.push(path);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(report, "report");
  walk(manifest, "manifest");
  assert.deepEqual(open, []);
});

// ------------------------------------------------------------ positive

test("bundles from every run class validate: PASS, VIOLATION, UNASSESSABLE, HARNESS_ERROR, protocol failure, failed hello", async () => {
  for (const mode of ["reference", "cross_listing_value", "silent_claim_channel", "adapter_error", "missing_turn", "wrong_protocol_version", "quoted_untrusted", "unknown_listing", "channel_unavailable"]) {
    const b = await bundle(mode);
    assert.deepEqual(validateAutomotiveManifest(b.manifest), { ok: true, errors: [] }, `${mode} manifest`);
    assert.deepEqual(validateAutomotiveReport(b.report), { ok: true, errors: [] }, `${mode} report`);
    assert.deepEqual(validateAutomotiveReport(JSON.parse(JSON.stringify(b.report))), { ok: true, errors: [] }, `${mode} parsed report`);
  }
});

// ------------------------------------------------------------ negative

test("unsupported versions fail without being validated against the current schema", async () => {
  const b = await bundle("reference");
  for (const v of ["auto-manifest-0.2.0", "auto-manifest-9.9.9", undefined, 1]) {
    const r = validateAutomotiveManifest({ ...b.manifest, manifest_version: v });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /unsupported manifest_version/);
  }
  for (const v of ["auto-report-0.2.0", "0.4.0", null]) {
    const r = validateAutomotiveReport({ ...b.report, report_schema_version: v });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /unsupported report_schema_version/);
  }
  assert.equal(validateAutomotiveReport(null).ok, false);
  assert.equal(validateAutomotiveManifest([]).ok, false);
});

test("the schemas reject malformed manifests and reports", async () => {
  const b = await bundle("cross_listing_value");
  const bad = (what: string, kind: "report" | "manifest", mutate: (x: any) => void) => {
    const doc = structuredClone(kind === "report" ? b.report : b.manifest) as any;
    mutate(doc);
    const r = kind === "report" ? validateAutomotiveReport(doc) : validateAutomotiveManifest(doc);
    assert.equal(r.ok, false, what);
    assert.ok(r.errors.length > 0, what);
  };
  bad("extra manifest field", "manifest", (m) => (m.timestamp = "2026-01-01"));
  bad("bad corpus sha", "manifest", (m) => (m.corpus.sha256 = "ABC"));
  bad("bad evidence sha", "manifest", (m) => (m.evidence.sha256 = "0".repeat(63)));
  bad("bad commit", "manifest", (m) => (m.harness.commit = "main"));
  bad("verified identity source", "manifest", (m) => (m.sut.identity_source = "verified"));
  bad("empty sut revision", "manifest", (m) => (m.sut.revision = ""));
  bad("missing domain count", "manifest", (m) => delete m.corpus.cases_per_domain.stale_inventory);
  bad("score field", "report", (r) => (r.score = 1));
  bad("pass rate in a domain block", "report", (r) => (r.by_domain.stale_inventory.pass_rate = 1));
  bad("missing domain", "report", (r) => delete r.by_domain.price_attribution);
  bad("unknown verdict", "report", (r) => (r.case_evaluations[0].verdict = "WARN"));
  bad("unknown reason", "report", (r) => (r.findings[0].reasons = ["SOMETHING_ELSE"]));
  bad("reason of the wrong verdict class", "report", (r) => Object.assign(r.case_evaluations[0].checks[0], { verdict: "VIOLATION", reasons: ["PROBE_DECLINED"] }));
  bad("PASS with a reason", "report", (r) => Object.assign(r.case_evaluations[0].checks[0], { verdict: "PASS", reasons: ["FACT_VALUE_MISMATCH"] }));
  bad("optional UNASSESSABLE", "report", (r) => Object.assign(r.case_evaluations[0].checks.find((c: any) => !c.required), { verdict: "UNASSESSABLE", reasons: ["PROBE_UNANSWERED"] }));
  bad("PASS finding", "report", (r) => Object.assign(r.findings[0], { verdict: "PASS", reasons: [] }));
  bad("unknown domain", "report", (r) => (r.case_evaluations[0].domain = "financing_fact_integrity"));
  bad("extra check field", "report", (r) => (r.case_evaluations[0].checks[0].severity = "high"));
  bad("missing reason count", "report", (r) => delete r.reason_counts.VIOLATION.STALE_PRICE);
  bad("unsupported optional verdict count", "report", (r) => (r.check_summary.optional.UNASSESSABLE = 0));
  bad("negative count", "report", (r) => (r.scenario_summary.planned_scenarios = -1));
  bad("float count", "report", (r) => (r.scenario_summary.assessed_scenarios = 1.5));
  bad("too few limitations", "report", (r) => r.limitations.pop());
  bad("bad embedded manifest", "report", (r) => (r.manifest.manifest_version = "auto-manifest-9.9.9"));
  bad("bad variant key", "report", (r) => (r.by_variant["planned_domain/x"] = r.by_variant[Object.keys(r.by_variant)[0]]));
  bad("unknown harness reason", "report", (r) => r.harness_errors.push({ case_id: null, reason: "NETWORK", message: "x" }));
});

test("expected and observed payloads stay open: arbitrary JSON evidence validates", async () => {
  const b = await bundle("cross_listing_value");
  const r = structuredClone(b.report) as AutomotiveReport;
  r.findings[0].expected = { anything: [1, "two", { three: null }] };
  r.findings[0].observed = "free text";
  r.case_evaluations[0].checks[0].observed = [[{}]];
  assert.deepEqual(validateAutomotiveReport(r), { ok: true, errors: [] });
});
