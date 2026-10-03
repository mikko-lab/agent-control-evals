import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import { runAutomotiveCorpus } from "../../src/eval/automotive/run";
import type { AutomotiveRunOutput } from "../../src/eval/automotive/types";
import { buildAutomotiveBundle } from "../../src/report/automotive/build";
import { AUTOMOTIVE_REPORT_LIMITATIONS } from "../../src/report/automotive/limitations";
import { AutomotiveJsonError, automotiveJson, automotiveJsonLines, prettyJsonFile } from "../../src/report/automotive/json";
import { AUTOMOTIVE_REFERENCE_IDENTITY, REFERENCE_AGENT_NOTICE, renderAutomotiveSummary } from "../../src/report/automotive/summary";
import { AutomotiveReportBuildError, type AutomotiveBundle, type AutomotiveEvidenceRecord, type AutomotiveReport } from "../../src/report/automotive/types";
import { referenceHello } from "../../src/adapter/automotive-reference/agent";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS } from "../../src/spec/automotive/domains";
import { AUTOMOTIVE_HARNESS_ERROR_REASONS, AUTOMOTIVE_UNASSESSABLE_REASONS, AUTOMOTIVE_VIOLATION_REASONS } from "../../src/spec/automotive/reason-taxonomy";
import { AUTOMOTIVE_EVIDENCE_VERSION } from "../../src/spec/automotive/version";
import { canonicalJson, canonicalJsonLines } from "../../src/util/canonical-json";
import { sha256Hex } from "../../src/util/hash";

const ROOT = join(__dirname, "..", "..", "..");
const REFERENCE = { command: process.execPath, args: [join(ROOT, "dist", "src", "adapter", "automotive-reference", "main.js")] };
const FAKE = join(ROOT, "test", "fixtures", "automotive", "fake-adapter.js");
const corpus = generateAutomotiveSmokeCorpus();
const ID = { commit: "0123456789abcdef0123456789abcdef01234567", worktree_clean: true };

const runs = new Map<string, Promise<AutomotiveRunOutput>>();
/** D1 run against the reference agent ("reference") or a fake adapter mode; cached, returned as a fresh copy. */
async function runOf(mode: string): Promise<AutomotiveRunOutput> {
  if (!runs.has(mode)) runs.set(mode, runAutomotiveCorpus(corpus.entries, mode === "reference" ? REFERENCE : { command: process.execPath, args: [FAKE, mode] }, { timeoutMs: 5_000 }));
  return structuredClone(await runs.get(mode)!);
}
const bundleOf = (run: AutomotiveRunOutput, entries = corpus.entries, corpusBytes = corpus.bytes): AutomotiveBundle => buildAutomotiveBundle({ entries, corpusBytes, run, harnessIdentity: ID });
const recordsOf = (b: AutomotiveBundle): AutomotiveEvidenceRecord[] => b.evidenceBytes.trimEnd().split("\n").map((l) => JSON.parse(l));
const buildError = (fn: () => unknown, re: RegExp, what: string) => assert.throws(fn, (e: unknown) => e instanceof AutomotiveReportBuildError && re.test(e.message), what);

// ------------------------------------------------------------ reference bundle

test("reference run: an 18/18 PASS bundle with complete counts, no findings and the D1 evaluations unchanged", async () => {
  const run = await runOf("reference");
  const b = bundleOf(run);
  const r = b.report;
  assert.deepEqual([r.run_valid, r.complete_execution, r.all_required_assessed], [true, true, true]);
  assert.deepEqual(r.scenario_summary, {
    planned_scenarios: 18,
    evaluated_scenarios: 18,
    not_run_scenarios: 0,
    verdict_counts: { PASS: 18, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0 },
    assessed_scenarios: 18,
    violation_count: 0,
  });
  assert.deepEqual(r.check_summary.required, { total: 32, PASS: 32, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0, assessed: 32 });
  assert.equal(r.check_summary.optional.total, r.check_summary.optional.PASS);
  assert.ok(r.check_summary.optional.total > 100);
  assert.equal(r.check_summary.optional.VIOLATION, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual([r.harness_errors, r.adapter_errors, r.not_run_case_ids], [[], [], []]);
  for (const block of Object.values(r.reason_counts)) assert.ok(Object.values(block).every((n) => n === 0));
  assert.deepEqual([r.observation_evidence.quoted_claims.total, r.observation_evidence.unverifiable_claims.total], [0, 0]);
  assert.equal(canonicalJson(r.case_evaluations), canonicalJson(run.case_evaluations), "D1 evaluations are embedded unchanged");
  assert.deepEqual(r.limitations, [...AUTOMOTIVE_REPORT_LIMITATIONS]);
  const m = b.manifest;
  assert.deepEqual(m.adapter, { name: "automotive-reference-adapter", version: "auto-reference-agent-0.1.0", protocol_version: "auto-adapter-0.1.0", identity_source: "adapter_hello_self_declared" });
  assert.deepEqual(m.sut, { name: "automotive-reference-agent", version: "auto-reference-agent-0.1.0", revision: null, identity_source: "adapter_hello_self_declared" });
  assert.deepEqual(m.corpus.cases_per_domain, { vehicle_fact_integrity: 6, price_attribution: 6, stale_inventory: 6 });
  assert.deepEqual([m.corpus.profile, m.corpus.cases, m.corpus.variants, m.corpus.sha256], ["auto-smoke-0.1.0", 18, 18, "49c50fae1deeb1bd6f5a608ea0d9a2d5ebfd252e8df3ad59dc02b7cceb421a54"]);
  assert.deepEqual(m.evaluation.case_statuses, { evaluated: 18, harness_error: 0, not_run: 0 });
  assert.deepEqual(m.harness, ID);
});

test("every executable domain and every declared variant appears, with the same scenario-count shape", async () => {
  const r = bundleOf(await runOf("reference")).report;
  assert.deepEqual(Object.keys(r.by_domain), [...EXECUTABLE_AUTOMOTIVE_DOMAINS]);
  assert.deepEqual(Object.keys(r.by_variant), corpus.entries.map((e) => `${e.case.domain}/${e.case.variant}`));
  const shape = Object.keys(r.scenario_summary).sort();
  for (const d of Object.values(r.by_domain)) assert.deepEqual(Object.keys(d).sort(), shape);
  for (const [k, v] of Object.entries(r.by_variant)) {
    assert.deepEqual(Object.keys(v).sort(), [...shape, "case_ids", "domain", "variant"].sort(), k);
    assert.equal(`${v.domain}/${v.variant}`, k);
    assert.deepEqual([v.planned_scenarios, v.verdict_counts.PASS, v.case_ids.length], [1, 1, 1]);
  }
});

// ------------------------------------------------------------ evidence

test("evidence: one record per corpus case in corpus order; adapter_error keeps its result, protocol failure has none, not-run has neither", async () => {
  const ids = corpus.entries.map((e) => e.case.case_id);
  const adapterError = recordsOf(bundleOf(await runOf("adapter_error")));
  assert.deepEqual(adapterError.map((r) => r.case_id), ids);
  assert.ok(adapterError.every((r) => r.evidence_version === AUTOMOTIVE_EVIDENCE_VERSION && r.status === "harness_error" && r.evaluation?.verdict === "HARNESS_ERROR"));
  assert.ok(adapterError.every((r) => r.adapter_result?.status === "adapter_error"));
  assert.deepEqual(adapterError[0].adapter_result?.raw_sut_evidence, { note: "synthetic failure" }, "the raw adapter result is kept");

  const protocol = recordsOf(bundleOf(await runOf("missing_turn")));
  assert.deepEqual(protocol.map((r) => r.case_id), ids);
  assert.deepEqual([protocol[0].status, protocol[0].adapter_result, protocol[0].evaluation?.verdict], ["harness_error", null, "HARNESS_ERROR"]);
  assert.ok(protocol.slice(1).every((r) => r.status === "not_run" && r.adapter_result === null && r.evaluation === null));

  const hello = bundleOf(await runOf("wrong_protocol_version"));
  assert.ok(recordsOf(hello).every((r) => r.status === "not_run" && r.adapter_result === null && r.evaluation === null));
  assert.deepEqual([hello.manifest.adapter, hello.manifest.sut], [null, null], "no identity without a successful hello");
  assert.deepEqual([hello.report.complete_execution, hello.report.all_required_assessed, hello.report.scenario_summary.not_run_scenarios], [false, false, 18]);

  const ok = recordsOf(bundleOf(await runOf("reference")));
  assert.ok(ok.every((r) => r.status === "evaluated" && r.adapter_result !== null && r.evaluation !== null));
  assert.equal(bundleOf(await runOf("reference")).evidenceBytes, canonicalJsonLines(ok), "canonical JSON Lines, one LF each");
});

test("raw_sut_evidence survives verbatim and never changes a verdict; only a value outside the JSON model is a build error", async () => {
  const base = await runOf("reference");
  const run = structuredClone(base);
  const raw = { nested: [1, "ä \u0000 ✓", { z: 1, a: null }], "key with spaces": true, empty: {} };
  run.case_results[3].raw_sut_evidence = raw;
  const b = bundleOf(run);
  const rec = recordsOf(b)[3];
  assert.deepEqual(rec.adapter_result?.raw_sut_evidence, raw);
  assert.ok(b.evidenceBytes.includes(canonicalJson(raw)), "the exact canonical bytes of the raw evidence are in the file");
  assert.equal(canonicalJson(b.report.case_evaluations), canonicalJson(bundleOf(base).report.case_evaluations), "verdicts unchanged");
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, 10n, () => 1, new Date(0)]) {
    const r = structuredClone(base);
    r.case_results[0].raw_sut_evidence = { x: bad };
    buildError(() => bundleOf(r), /evidence is not JSON-serialisable without loss/, String(bad));
  }
});

test("hashes: same inputs give the same bytes and SHAs; one changed evidence value or corpus byte changes the bound SHA", async () => {
  const run = await runOf("reference");
  const a = bundleOf(run);
  const b = bundleOf(structuredClone(run));
  assert.equal(a.evidenceBytes, b.evidenceBytes);
  assert.equal(prettyJsonFile(a.manifest), prettyJsonFile(b.manifest));
  assert.equal(prettyJsonFile(a.report), prettyJsonFile(b.report));
  assert.equal(a.summary, b.summary);
  assert.equal(a.manifest.evidence.sha256, sha256Hex(Buffer.from(a.evidenceBytes, "utf8")));
  assert.equal(a.manifest.evidence.bytes, Buffer.byteLength(a.evidenceBytes, "utf8"));
  assert.equal(a.manifest.evidence.records, 18);
  assert.equal(a.manifest.corpus.sha256, sha256Hex(Buffer.from(corpus.bytes, "utf8")));

  const changedEvidence = structuredClone(run);
  changedEvidence.case_results[17].raw_sut_evidence = { changed: 1 };
  const c = bundleOf(changedEvidence);
  assert.notEqual(c.manifest.evidence.sha256, a.manifest.evidence.sha256);
  assert.equal(c.manifest.corpus.sha256, a.manifest.corpus.sha256);

  // In-memory corpus copy only: the committed golden is never touched.
  const entries = structuredClone(corpus.entries);
  const step = entries[0].case.scenario.steps[0];
  assert.ok(step.op === "user_message");
  step.text = `${step.text} (changed)`;
  const changedCorpus = bundleOf(structuredClone(run), entries, canonicalJsonLines(entries));
  assert.notEqual(changedCorpus.manifest.corpus.sha256, a.manifest.corpus.sha256);
  assert.equal(changedCorpus.report.manifest.corpus.sha256, changedCorpus.manifest.corpus.sha256);
  buildError(() => bundleOf(structuredClone(run), corpus.entries, corpus.bytes + "\n"), /not the canonical serialisation/, "corpus bytes must match the entries");
});

test("the report embeds exactly the manifest; JSON files are deterministic, key-sorted and end with one LF", async () => {
  const b = bundleOf(await runOf("reference"));
  assert.equal(canonicalJson(b.report.manifest), canonicalJson(b.manifest));
  const text = prettyJsonFile(b.report);
  assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"));
  assert.equal(canonicalJson(JSON.parse(text)), canonicalJson(b.report));
  assert.ok(b.evidenceBytes.endsWith("}\n") && !b.evidenceBytes.endsWith("\n\n"));
  assert.ok(b.summary.endsWith("\n") && !b.summary.endsWith("\n\n"));
  assert.equal(prettyJsonFile({ x: 0.5, y: [-0, 1e21] }), '{\n  "x": 0.5,\n  "y": [\n    0,\n    1e+21\n  ]\n}\n');
  assert.throws(() => prettyJsonFile({ x: Number.NaN }), /non-finite number at \$\.x/);
  assert.equal(prettyJsonFile({ b: [1, { d: 1, c: [] }], a: {} }), '{\n  "a": {},\n  "b": [\n    1,\n    {\n      "c": [],\n      "d": 1\n    }\n  ]\n}\n');
});

test("float raw evidence: evidence -> JSONL -> parse gives the same value, with deterministic bytes and SHA", async () => {
  const base = await runOf("reference");
  const raw = { confidence: 0.73, latency_ms: 12.5, scores: [0.1, 1e-7, 5e-324, 1.7976931348623157e308, -2.5], third: 1 / 3, nested: { z: 0.30000000000000004, a: -0 } };
  const withFloat = () => {
    const r = structuredClone(base);
    r.case_results[6].raw_sut_evidence = structuredClone(raw);
    return bundleOf(r);
  };
  const a = withFloat();
  const b = withFloat();
  assert.equal(a.evidenceBytes, b.evidenceBytes, "deterministic bytes");
  assert.equal(a.manifest.evidence.sha256, b.manifest.evidence.sha256, "deterministic SHA");
  assert.equal(a.manifest.evidence.sha256, sha256Hex(Buffer.from(a.evidenceBytes, "utf8")));
  assert.notEqual(a.manifest.evidence.sha256, bundleOf(structuredClone(base)).manifest.evidence.sha256, "the float evidence is bound by the SHA");
  const line = a.evidenceBytes.split("\n")[6];
  assert.ok(line.includes('"raw_sut_evidence":{"confidence":0.73,"latency_ms":12.5,"nested":{"a":0,"z":0.30000000000000004},"scores":[0.1,1e-7,5e-324,1.7976931348623157e+308,-2.5],"third":0.3333333333333333}'), "sorted keys, shortest round-trip numbers");
  const parsed = JSON.parse(line) as AutomotiveEvidenceRecord;
  assert.deepEqual(parsed.adapter_result?.raw_sut_evidence, { ...raw, nested: { z: 0.30000000000000004, a: 0 } }, "every float round-trips exactly (-0 is written as 0)");
  assert.equal((parsed.adapter_result?.raw_sut_evidence as { third: number }).third, 1 / 3);
  // Re-serialising the parsed evidence reproduces the exact bytes.
  assert.equal(automotiveJsonLines(recordsOf(a)), a.evidenceBytes);
  assert.equal(canonicalJson(a.report.case_evaluations), canonicalJson(bundleOf(structuredClone(base)).report.case_evaluations), "raw evidence never changes an evaluation");
});

test("the automotive JSON serializer: full JSON model, sorted keys, finite numbers only, identical to canonical JSON on integers", () => {
  assert.equal(automotiveJson({ b: 1, a: [true, null, "x\u0000\"", { d: 0.5, c: -1 }], "": {} }), '{"":{},"a":[true,null,"x\\u0000\\"",{"c":-1,"d":0.5}],"b":1}');
  for (const [v, s] of [[0.73, "0.73"], [-0, "0"], [1e21, "1e+21"], [1e-7, "1e-7"], [123456789012345680000, "123456789012345680000"], [Number.MAX_SAFE_INTEGER + 2, "9007199254740992"]] as const) assert.equal(automotiveJson(v), s, String(v));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = [1, , 3];
  for (const [v, re] of [
    [Number.NaN, /non-finite number at \$/],
    [{ a: [Number.POSITIVE_INFINITY] }, /non-finite number at \$\.a\[0\]/],
    [{ a: undefined }, /undefined member at \$\.a/],
    [[undefined], /undefined array element/],
    [sparse, /undefined array element at \$\[1\]/],
    [10n, /unsupported bigint/],
    [Symbol("s"), /unsupported symbol/],
    [() => 1, /unsupported function/],
    [new Date(0), /non-plain object/],
    [new Map(), /non-plain object/],
    [Buffer.from("x"), /non-plain object/],
    [cyclic, /cycle at \$\.self/],
    [{ [Symbol("k")]: 1 }, /symbol-keyed member/],
  ] as const) assert.throws(() => automotiveJson(v), (e: unknown) => e instanceof AutomotiveJsonError && re.test(e.message), String(re));
  const shared = { x: 1 };
  assert.equal(automotiveJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}', "a repeated (non-cyclic) reference is fine");
  // Integer-only values: byte-identical to canonical JSON, so integer evidence keeps its previous SHA.
  for (const e of corpus.entries) assert.equal(automotiveJson(e), canonicalJson(e));
  assert.equal(automotiveJsonLines(corpus.entries), corpus.bytes);
  assert.equal(automotiveJsonLines([]), "");
});

test("integer-only reference evidence keeps the same bytes as canonical JSON Lines", async () => {
  const b = bundleOf(await runOf("reference"));
  assert.equal(b.evidenceBytes, canonicalJsonLines(recordsOf(b)));
  assert.equal(b.manifest.evidence.sha256, "c14a39c1d613f4eeb362c98e20ed9570b9e25d7ac0058d6f16e6167785222ea0");
});

// ------------------------------------------------------------ consistency

test("the builder rejects internally inconsistent D1 run objects with a report-build error", async () => {
  const run = await runOf("reference");
  const bad = (what: string, re: RegExp, mutate: (r: AutomotiveRunOutput) => void) => {
    const r = structuredClone(run);
    mutate(r);
    buildError(() => bundleOf(r), re, what);
  };
  bad("duplicate evaluation", /duplicate case evaluation/, (r) => r.case_evaluations.push(structuredClone(r.case_evaluations[0])));
  bad("duplicate adapter result", /duplicate adapter result/, (r) => r.case_results.push(structuredClone(r.case_results[0])));
  bad("unknown evaluation case", /not in the corpus/, (r) => (r.case_evaluations[0].case_id = "auto-case-999999"));
  bad("unknown adapter result case", /not in the corpus/, (r) => (r.case_results[0].case_id = "auto-case-999999"));
  bad("unknown not-run id", /not in the corpus/, (r) => r.not_run_case_ids.push("auto-case-999999"));
  bad("duplicate not-run id", /duplicate not-run id/, (r) => r.not_run_case_ids.push("auto-case-000001", "auto-case-000001"));
  bad("evaluated and not run", /listed as not run but has/, (r) => r.not_run_case_ids.push("auto-case-000002"));
  bad("wrong domain", /evaluation domain/, (r) => (r.case_evaluations[0].domain = "price_attribution"));
  bad("wrong variant", /evaluation variant/, (r) => (r.case_evaluations[0].variant = "price_change"));
  bad("wrong evaluator version", /evaluation version/, (r) => ((r.case_evaluations[0] as { evaluator_version: string }).evaluator_version = "auto-evaluator-9.9.9"));
  bad("wrong run evaluator version", /run evaluator_version/, (r) => ((r as { evaluator_version: string }).evaluator_version = "auto-evaluator-9.9.9"));
  bad("optional UNASSESSABLE", /optional check .* UNASSESSABLE/, (r) => Object.assign(r.case_evaluations[0].checks.find((c) => !c.required)!, { verdict: "UNASSESSABLE", reasons: ["PROBE_UNANSWERED"] }));
  bad("optional HARNESS_ERROR", /optional check .* HARNESS_ERROR/, (r) => Object.assign(r.case_evaluations[0].checks.find((c) => !c.required)!, { verdict: "HARNESS_ERROR", reasons: ["TIMEOUT"] }));
  bad("missing evidence status", /no evidence status/, (r) => {
    r.case_evaluations.pop();
    r.case_results.pop();
  });
  bad("adapter result without evaluation", /adapter result but no evaluation/, (r) => r.case_evaluations.pop());
  bad("ok result with HARNESS_ERROR", /ok adapter result but a HARNESS_ERROR/, (r) => (r.case_evaluations[0].verdict = "HARNESS_ERROR"));
  bad("no result but not HARNESS_ERROR", /no adapter result but its verdict/, (r) => r.case_results.shift());
  bad("PASS with a reason", /PASS check .* carries reasons/, (r) => (r.case_evaluations[0].checks[0].reasons = ["FACT_VALUE_MISMATCH"]));
  bad("reason of the wrong class", /not a VIOLATION reason/, (r) => Object.assign(r.case_evaluations[0].checks[0], { verdict: "VIOLATION", reasons: ["PROBE_UNANSWERED"] }));
  bad("non-PASS without reason", /carries no reason/, (r) => Object.assign(r.case_evaluations[0].checks[0], { verdict: "VIOLATION", reasons: [] }));
  bad("unknown harness-error case", /harness error for case/, (r) => r.harness_errors.push({ case_id: "auto-case-999999", reason: "TIMEOUT", message: "x" }));
  bad("quoted count mismatch", /quoted claim counts/, (r) => (r.case_evaluations[0].quoted_claims.count = 1));
});

test("harness identity: unknown is accepted and visible; malformed identities are rejected", async () => {
  const run = await runOf("reference");
  const unknown = buildAutomotiveBundle({ entries: corpus.entries, corpusBytes: corpus.bytes, run, harnessIdentity: { commit: "unknown", worktree_clean: false } });
  assert.deepEqual(unknown.manifest.harness, { commit: "unknown", worktree_clean: false });
  assert.match(unknown.summary, /Harness commit: unknown \(worktree clean: no\)/);
  const reject = (h: { commit: string; worktree_clean: boolean }, re: RegExp) => buildError(() => buildAutomotiveBundle({ entries: corpus.entries, corpusBytes: corpus.bytes, run, harnessIdentity: h }), re, JSON.stringify(h));
  reject({ commit: "unknown", worktree_clean: true }, /unknown harness commit cannot have a known-clean worktree/);
  reject({ commit: "HEAD", worktree_clean: true }, /40 hex characters/);
  reject({ commit: "0123456789ABCDEF0123456789ABCDEF01234567", worktree_clean: true }, /40 hex characters/);
});

// ------------------------------------------------------------ verdict classes in the report

test("a VIOLATION report shows the violation in scenario counts, domain, variant, findings and reason counts", async () => {
  const r = bundleOf(await runOf("cross_listing_value")).report;
  assert.equal(r.run_valid, true);
  const v = r.scenario_summary.verdict_counts.VIOLATION;
  assert.ok(v > 0);
  assert.equal(r.scenario_summary.violation_count, v);
  assert.equal(EXECUTABLE_AUTOMOTIVE_DOMAINS.reduce((n, d) => n + r.by_domain[d].verdict_counts.VIOLATION, 0), v);
  assert.equal(Object.values(r.by_variant).reduce((n, x) => n + x.verdict_counts.VIOLATION, 0), v);
  const f = r.findings.find((x) => x.case_id === "auto-case-000007" && x.check_id === "probe:p1")!;
  assert.deepEqual([f.verdict, f.reasons, f.required], ["VIOLATION", ["PRICE_VALUE_MISMATCH", "CROSS_LISTING_PRICE"], true]);
  assert.ok(r.reason_counts.VIOLATION.CROSS_LISTING_PRICE > 0 && r.reason_counts.VIOLATION.PRICE_VALUE_MISMATCH > 0);
  // Findings are exactly the non-PASS checks, in corpus order then D1 check order.
  const expected = r.case_evaluations.flatMap((e) => e.checks.filter((c) => c.verdict !== "PASS").map((c) => `${e.case_id}|${c.check_id}`));
  assert.deepEqual(r.findings.map((x) => `${x.case_id}|${x.check_id}`), expected);
  const totalReasons = (block: Record<string, number>) => Object.values(block).reduce((n, x) => n + x, 0);
  assert.equal(totalReasons(r.reason_counts.VIOLATION), r.findings.filter((x) => x.verdict === "VIOLATION").reduce((n, x) => n + x.reasons.length, 0));
});

test("an UNASSESSABLE report is never PASS, never in the assessed denominator, visible in findings, all_required_assessed false", async () => {
  const r = bundleOf(await runOf("silent_claim_channel")).report;
  assert.deepEqual(r.scenario_summary.verdict_counts, { PASS: 0, VIOLATION: 0, UNASSESSABLE: 18, HARNESS_ERROR: 0 });
  assert.deepEqual([r.scenario_summary.assessed_scenarios, r.check_summary.required.assessed, r.check_summary.required.PASS], [0, 0, 0]);
  assert.equal(r.check_summary.required.UNASSESSABLE, 32);
  assert.deepEqual([r.run_valid, r.complete_execution, r.all_required_assessed], [true, true, false]);
  assert.equal(r.findings.length, 32);
  assert.ok(r.findings.every((f) => f.verdict === "UNASSESSABLE" && f.reasons[0] === "PROBE_UNANSWERED"));
  assert.equal(r.reason_counts.UNASSESSABLE.PROBE_UNANSWERED, 32);
  assert.match(renderAutomotiveSummary(r), /No VIOLATION checks were observed in this evaluated corpus\.\n\n32 non-PASS checks/);
});

test("a HARNESS_ERROR report has run_valid false and never counts a harness failure as a violation", async () => {
  const r = bundleOf(await runOf("adapter_error")).report;
  assert.equal(r.run_valid, false);
  assert.deepEqual(r.scenario_summary.verdict_counts, { PASS: 0, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 18 });
  assert.deepEqual([r.scenario_summary.violation_count, r.scenario_summary.assessed_scenarios], [0, 0]);
  assert.ok(Object.values(r.reason_counts.VIOLATION).every((n) => n === 0));
  assert.equal(r.reason_counts.HARNESS_ERROR.ADAPTER_ERROR, 32);
  assert.equal(r.adapter_errors.length, 18);
  assert.ok(r.findings.every((f) => f.verdict === "HARNESS_ERROR"));
});

test("observation evidence aggregates D1's informational evidence and creates no verdict", async () => {
  const run = await runOf("quoted_untrusted");
  const r = bundleOf(run).report;
  const o = r.observation_evidence;
  const d1Quoted = run.case_evaluations.flatMap((e) => e.quoted_claims.claims);
  assert.ok(d1Quoted.length > 0);
  assert.deepEqual([o.quoted_claims.total, o.quoted_claims.source_exists_count, o.quoted_claims.missing_source_count], [d1Quoted.length, d1Quoted.filter((q) => q.content_exists).length, d1Quoted.filter((q) => !q.content_exists).length]);
  assert.equal(o.attribution_counts.quoted_untrusted, run.case_evaluations.reduce((n, e) => n + (e.observation_summary?.attribution_counts.quoted_untrusted ?? 0), 0));
  assert.deepEqual(Object.keys(o.unverifiable_claims.by_classification).sort(), ["approximate", "outside_contract", "qualitative", "range"]);
  assert.deepEqual(Object.keys(o.event_delivery_states).sort(), ["ambiguous", "delivered", "not_delivered", "unavailable"]);
  assert.equal(canonicalJson(r.case_evaluations), canonicalJson(run.case_evaluations), "no verdict or reason is changed by aggregation");
  const unknown = await runOf("unknown_listing");
  const ids = [...new Set(unknown.case_evaluations.flatMap((e) => e.observation_summary?.unknown_reference_listing_ids ?? []))].sort();
  assert.deepEqual(bundleOf(unknown).report.observation_evidence.unknown_reference_listing_ids, ids);
});

// ------------------------------------------------------------ limitations, summary, discipline

test("every report carries the complete limitations set and the summary renders the report's own copy", async () => {
  for (const mode of ["reference", "silent_claim_channel", "adapter_error", "missing_turn"]) assert.deepEqual(bundleOf(await runOf(mode)).report.limitations, [...AUTOMOTIVE_REPORT_LIMITATIONS], mode);
  assert.equal(AUTOMOTIVE_REPORT_LIMITATIONS.length, 12);
  const r = bundleOf(await runOf("reference")).report;
  const altered: AutomotiveReport = { ...structuredClone(r), limitations: ["Synthetic limitation A.", "Synthetic limitation B."] };
  const s = renderAutomotiveSummary(altered);
  assert.match(s, /## Limitations\n\n1\. Synthetic limitation A\.\n2\. Synthetic limitation B\.\n$/);
  assert.ok(!s.includes(AUTOMOTIVE_REPORT_LIMITATIONS[0]));
  const src = readFileSync(join(ROOT, "src", "report", "automotive", "summary.ts"), "utf8");
  assert.ok(!src.includes("limitations\"") && !/import[^;]*limitations/.test(src), "the summary imports no limitations list");
  for (const l of AUTOMOTIVE_REPORT_LIMITATIONS) assert.ok(!src.includes(l.slice(0, 40)), "no limitation text in the summary module");
});

test("summary: factual headline and sections, notice only for the exact reference identity, identical from the parsed report.json", async () => {
  const b = bundleOf(await runOf("reference"));
  const s = b.summary;
  assert.ok(s.startsWith("# Automotive Agent Assurance auto-0.1.0\n\n" + REFERENCE_AGENT_NOTICE + "\n\n- Corpus: auto-smoke-0.1.0\n- Planned scenarios: 18\n- Scenario verdicts: PASS 18 | VIOLATION 0 | UNASSESSABLE 0 | HARNESS_ERROR 0\n- Not run: 0\n- Required checks assessed: 32 / 32\n"));
  for (const h of ["Run identity", "Scenario verdicts", "Results by domain", "Results by variant", "Required / optional checks", "Findings", "Unassessable evidence", "Quoted / unverifiable evidence", "Reproducibility", "Limitations"]) assert.ok(s.includes(`\n## ${h}\n`), h);
  assert.match(s, /No VIOLATION checks were observed in this evaluated corpus\./);
  assert.match(s, /self-declared via adapter hello/);
  assert.match(s, /\| stale_inventory \/ noop_price_change \| auto-case-000018 \| PASS \|/);
  const beforeLimitations = s.slice(0, s.indexOf("## Limitations"));
  for (const w of [/certif/i, /\bcompliant\b/i, /\bcompliance\b/i, /production-ready/i, /fully assured/i, /\bsafe\b/i, /100%/, /no problems/i]) assert.ok(!w.test(beforeLimitations), String(w));
  assert.equal(renderAutomotiveSummary(JSON.parse(prettyJsonFile(b.report))), s, "renders identically from report.json");

  assert.deepEqual(AUTOMOTIVE_REFERENCE_IDENTITY, { adapter: { name: referenceHello().adapter, version: referenceHello().adapter_version }, sut: referenceHello().sut });
  for (const change of [(r: AutomotiveReport) => (r.manifest.sut!.revision = "abc"), (r: AutomotiveReport) => (r.manifest.adapter!.name = "other-adapter"), (r: AutomotiveReport) => (r.manifest.sut!.version = "9")]) {
    const r = structuredClone(b.report);
    change(r);
    assert.ok(!renderAutomotiveSummary(r).includes("Reference-agent self-test"));
  }
  assert.ok(!bundleOf(await runOf("silent_claim_channel")).summary.includes("Reference-agent self-test"), "fake SUT gets no notice");
  const notRun = bundleOf(await runOf("missing_turn")).summary;
  assert.match(notRun, /\| vehicle_fact_integrity \/ model_year_and_registration \| auto-case-000002 \| NOT_RUN \|/);
});

test("no aggregate score, grade, rate, maturity, assurance level or confidence field anywhere in a report", async () => {
  const forbidden = /score|grade|maturity|assurance_level|rating|pass_rate|rate$|percent|confidence|probability|severity|rank/i;
  const keys = (v: unknown, path: string, out: string[]) => {
    if (Array.isArray(v)) v.forEach((x, i) => keys(x, `${path}[${i}]`, out));
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(`${path}.${k}`), keys(x, `${path}.${k}`, out));
    return out;
  };
  for (const mode of ["reference", "cross_listing_value", "silent_claim_channel", "adapter_error"]) {
    const b = bundleOf(await runOf(mode));
    for (const p of [...keys(b.report, "report", []), ...keys(b.manifest, "manifest", [])]) assert.ok(!forbidden.test(p.split(".").pop()!), `${mode}: ${p}`);
  }
});

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

test("the summary is a renderer: it imports no oracle, evaluator, corpus generator, adapter or run engine", () => {
  const imports = importsOf(join(ROOT, "src", "report", "automotive", "summary.ts"));
  const allowed = new Set(["src/report/automotive/json.ts", "src/spec/automotive/domains.ts", "src/spec/automotive/outcomes.ts", "src/spec/automotive/reason-taxonomy.ts", "src/spec/automotive/version.ts", "src/report/automotive/types.ts"]);
  assert.ok(imports.length > 0);
  for (const t of imports) assert.ok(allowed.has(t), `summary.ts imports ${t}`);
});

test("report modules never import the reference SUT; the pure builders touch no Git, filesystem, process or clock", () => {
  const files = listTs(join(ROOT, "src", "report", "automotive"));
  assert.deepEqual(files.map((f) => relative(join(ROOT, "src", "report", "automotive"), f)).sort(), ["build.ts", "evidence.ts", "harness-git.ts", "json.ts", "limitations.ts", "manifest.ts", "summary.ts", "types.ts", "validate.ts"]);
  for (const f of files) {
    for (const t of importsOf(f)) {
      assert.ok(!t.startsWith("src/adapter/automotive-reference/") && !t.includes("fixtures"), `${f} imports ${t}`);
      assert.ok(!t.startsWith("src/report/") || t.startsWith("src/report/automotive/"), `${f} imports ACS reporting ${t}`);
    }
  }
  for (const name of ["build.ts", "evidence.ts", "manifest.ts", "summary.ts", "limitations.ts", "json.ts", "types.ts"]) {
    const file = join(ROOT, "src", "report", "automotive", name);
    const src = readFileSync(file, "utf8");
    for (const t of importsOf(file)) assert.ok(!t.startsWith("node:") || t === "node:crypto", `${name} imports ${t}`);
    assert.ok(!/Date\.now|new Date|Math\.random|process\.(env|cwd|hrtime|pid)|hostname/.test(src), `${name} reads ambient state`);
  }
  assert.ok(importsOf(join(ROOT, "src", "report", "automotive", "build.ts")).every((t) => t !== "src/report/automotive/harness-git.ts" && t !== "src/eval/automotive/run.ts"), "the builder never runs Git or the SUT");
});

test("automotive reasons and domains in report blocks follow the taxonomy order exactly", async () => {
  const r = bundleOf(await runOf("reference")).report;
  assert.deepEqual(Object.keys(r.reason_counts.VIOLATION), [...AUTOMOTIVE_VIOLATION_REASONS]);
  assert.deepEqual(Object.keys(r.reason_counts.UNASSESSABLE), [...AUTOMOTIVE_UNASSESSABLE_REASONS]);
  assert.deepEqual(Object.keys(r.reason_counts.HARNESS_ERROR), [...AUTOMOTIVE_HARNESS_ERROR_REASONS]);
});
