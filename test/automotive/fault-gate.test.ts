import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import { runAutomotiveCorpus } from "../../src/eval/automotive/run";
import { buildAutomotiveBundle } from "../../src/report/automotive/build";
import type { AutomotiveReport } from "../../src/report/automotive/types";
import { AUTOMOTIVE_FAULT_IDS } from "../../src/adapter/automotive-faults/agent";
import { automotiveFaultSetProblems, checkAutomotiveFaultSet } from "../../src/fault/automotive/manifest";
import { automotiveBaselineProblems, buildAutomotiveFaultReport, judgeAutomotiveFault, witnessCaseIds } from "../../src/fault/automotive/report";
import { AUTOMOTIVE_FAULT_REPORT_LIMITATIONS } from "../../src/fault/automotive/limitations";
import { AUTOMOTIVE_FAULT_SELF_TEST_NOTICE, renderAutomotiveFaultSummary } from "../../src/fault/automotive/summary";
import { AutomotiveFaultGateError, type AutomotiveFaultDefinition, type AutomotiveFaultReport, type AutomotiveFaultRunOutcome, type AutomotiveFaultSet } from "../../src/fault/automotive/types";
import { validateAutomotiveFaultReport } from "../../src/fault/automotive/validate";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS } from "../../src/spec/automotive/domains";
import { AUTOMOTIVE_VIOLATION_REASONS } from "../../src/spec/automotive/reason-taxonomy";

const ROOT = join(__dirname, "..", "..", "..");
const DIST = join(ROOT, "dist", "src", "adapter");
const corpus = generateAutomotiveSmokeCorpus();
const FAULT_SET: AutomotiveFaultSet = JSON.parse(readFileSync(join(ROOT, "faults", "automotive", "manifest.json"), "utf8"));
const ID = { commit: "0123456789abcdef0123456789abcdef01234567", worktree_clean: true };
const SHA = "a".repeat(64);
const faultOf = (id: string) => FAULT_SET.faults.find((f) => f.fault_id === id)!;

const runs = new Map<string, Promise<AutomotiveReport>>();
/** D2 report for "reference", "float" (a foreign adapter that PASSes everything), a fault id, or "fake:<mode>"; cached, fresh copy. */
async function reportOf(who: string): Promise<AutomotiveReport> {
  if (!runs.has(who)) {
    const adapter =
      who === "reference"
        ? { command: process.execPath, args: [join(DIST, "automotive-reference", "main.js")] }
        : who === "float"
          ? { command: process.execPath, args: [join(ROOT, "test", "fixtures", "automotive", "float-evidence-adapter.js")] }
          : who.startsWith("fake:")
          ? { command: process.execPath, args: [join(ROOT, "test", "fixtures", "automotive", "fake-adapter.js"), who.slice(5)] }
          : { command: process.execPath, args: [join(DIST, "automotive-faults", "main.js"), who] };
    runs.set(
      who,
      runAutomotiveCorpus(corpus.entries, adapter, { timeoutMs: 5_000 }).then((run) => buildAutomotiveBundle({ entries: corpus.entries, corpusBytes: corpus.bytes, run, harnessIdentity: ID }).report),
    );
  }
  return structuredClone(await runs.get(who)!);
}
const outcome = (report: AutomotiveReport | null, failure: string | null = null): AutomotiveFaultRunOutcome => ({ report, report_path: report ? "faults/x/report.json" : null, failure });
async function judge(f: AutomotiveFaultDefinition, report: AutomotiveReport | null, failure: string | null = null) {
  return judgeAutomotiveFault(f, outcome(report, failure), witnessCaseIds(f, await reportOf("reference")));
}
async function fullReport(override?: (id: string, r: AutomotiveReport) => AutomotiveReport | null): Promise<AutomotiveFaultReport> {
  const outcomes: AutomotiveFaultRunOutcome[] = [];
  for (const f of FAULT_SET.faults) {
    const r = await reportOf(f.fault_id);
    const o = override ? override(f.fault_id, r) : r;
    outcomes.push(o ? { report: o, report_path: `faults/${f.fault_id}/report.json`, failure: null } : { report: null, report_path: null, failure: "synthetic build failure" });
  }
  return buildAutomotiveFaultReport({ faultSet: FAULT_SET, faultSetSha256: SHA, baseline: await reportOf("reference"), baselineReportPath: "baseline/report.json", outcomes, harnessIdentity: ID });
}

// ------------------------------------------------------------ kill / survive / invalid

test("every declared fault is killed from its own run's evaluator findings", async () => {
  const r = await fullReport();
  assert.deepEqual(r.gate, { passed: true, fault_count: 10, killed: 10, survived: 0, invalid: 0 });
  assert.deepEqual(r.faults.map((f) => f.fault_id), [...AUTOMOTIVE_FAULT_IDS], "manifest order");
  for (const f of r.faults) {
    assert.equal(f.status, "killed", f.fault_id);
    assert.deepEqual(f.matched_witness_case_ids, f.witness_case_ids, f.fault_id);
    assert.equal(f.invalid_reason, null);
    assert.equal(f.report_path, `faults/${f.fault_id}/report.json`);
    assert.match(f.evidence_sha256 ?? "", /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(r.faults.find((f) => f.fault_id === "AF01-cross-listing-odometer")!.witness_case_ids, ["auto-case-000001"]);
  assert.deepEqual(r.faults.find((f) => f.fault_id === "AF10-stale-price-cache")!.witness_case_ids, ["auto-case-000015"]);
  const af01 = r.faults[0].collateral_violation_case_ids;
  assert.deepEqual(af01, [...af01].sort(), "collateral in corpus order");
  assert.ok(!af01.includes("auto-case-000001"), "the witness is never collateral");
  assert.deepEqual(validateAutomotiveFaultReport(r), { ok: true, errors: [] });
});

test("negative control: the expected witness finding masked -> SURVIVED, even though the adapter says activated", async () => {
  const f = faultOf("AF04-cross-listing-price");
  const r = await reportOf(f.fault_id);
  r.findings = r.findings.filter((x) => !(x.variant === "two_listing_current_prices" && x.field === "price"));
  const res = await judge(f, r);
  assert.equal(res.status, "survived");
  assert.deepEqual(res.matched_witness_case_ids, []);
  assert.ok(res.collateral_violation_case_ids.length > 0, "collateral never kills");
});

test("negative control: a witness VIOLATION without every declared reason -> SURVIVED", async () => {
  const f = faultOf("AF10-stale-price-cache");
  const r = await reportOf(f.fault_id);
  for (const x of r.findings) if (x.variant === "price_change") x.reasons = x.reasons.filter((y) => y !== "STALE_PRICE");
  assert.equal((await judge(f, r)).status, "survived");
  const wrongField = await reportOf(f.fault_id);
  for (const x of wrongField.findings) if (x.variant === "price_change") x.field = "status";
  assert.equal((await judge(f, wrongField)).status, "survived", "wrong field");
  const wrongVerdict = await reportOf(f.fault_id);
  for (const x of wrongVerdict.findings) if (x.variant === "price_change") Object.assign(x, { verdict: "UNASSESSABLE", reasons: ["PROBE_DECLINED"] });
  assert.equal((await judge(f, wrongVerdict)).status, "survived", "not a VIOLATION");
});

test("negative control: collateral-only violation (a non-witness case is red, the witness is not) -> SURVIVED", async () => {
  // AF01's run has violations in five non-witness vehicle cases; remove only the witness ones.
  const f = faultOf("AF01-cross-listing-odometer");
  const r = await reportOf(f.fault_id);
  r.findings = r.findings.filter((x) => x.variant !== "odometer_and_power");
  const res = await judge(f, r);
  assert.equal(res.status, "survived");
  assert.equal(res.collateral_violation_case_ids.length, 5);
  // Red cases elsewhere in the run never substitute for the declared witness rule: the same run, judged for a
  // field the fault does not touch, survives although six scenarios are VIOLATION.
  const otherField: AutomotiveFaultDefinition = { ...f, expected_field: "power" };
  const full = await reportOf(f.fault_id);
  assert.equal(full.scenario_summary.verdict_counts.VIOLATION, 6);
  assert.equal((await judge(otherField, full)).status, "survived");
});

test("negative control: HARNESS_ERROR, an invalid or incomplete run, a build failure or a foreign identity -> INVALID, never killed", async () => {
  const f = faultOf("AF06-current-price-currency");
  const harness = await judge(f, await reportOf("fake:adapter_error"));
  assert.deepEqual([harness.status, harness.matched_witness_case_ids], ["invalid", []]);
  assert.match(harness.invalid_reason ?? "", /run_valid false|HARNESS_ERROR/);
  const protocol = await judge(f, await reportOf("fake:missing_turn"));
  assert.equal(protocol.status, "invalid");
  const noReport = await judge(f, null, "report build failed: synthetic");
  assert.deepEqual([noReport.status, noReport.invalid_reason, noReport.verdict_counts, noReport.report_path, noReport.evidence_sha256], ["invalid", "report build failed: synthetic", null, null, null]);
  // A run with real violations but not produced by the declared fault agent cannot kill the fault.
  const violating = await judge(f, await reportOf("fake:cross_listing_value"));
  assert.equal(violating.status, "invalid");
  assert.match(violating.invalid_reason ?? "", /identity/);
  const otherFault = await judge(f, await reportOf("AF04-cross-listing-price"));
  assert.equal(otherFault.status, "invalid", "another fault's run is not this fault's run");
  const forged = await reportOf(f.fault_id);
  forged.run_valid = false;
  assert.equal((await judge(f, forged)).status, "invalid");
});

test("gate: any survived or invalid fault fails the gate; counts only", async () => {
  const survived = await fullReport((id, r) => (id === "AF05-total-required-basis-bypass" ? { ...r, findings: [] } : r));
  assert.deepEqual(survived.gate, { passed: false, fault_count: 10, killed: 9, survived: 1, invalid: 0 });
  const invalid = await fullReport((id, r) => (id === "AF09-stale-status-cache" ? null : r));
  assert.deepEqual(invalid.gate, { passed: false, fault_count: 10, killed: 9, survived: 0, invalid: 1 });
  assert.equal(invalid.faults[8].invalid_reason, "synthetic build failure");
  for (const r of [survived, invalid]) assert.deepEqual(validateAutomotiveFaultReport(r), { ok: true, errors: [] });
});

// ------------------------------------------------------------ baseline

test("baseline must be a clean 18/18 PASS reference run, and every witness must PASS in it", async () => {
  assert.deepEqual(automotiveBaselineProblems(await reportOf("reference")), []);
  for (const bad of ["fake:cross_listing_value", "fake:silent_claim_channel", "fake:adapter_error", "fake:missing_turn"]) {
    const b = await reportOf(bad);
    assert.ok(automotiveBaselineProblems(b).length > 0, bad);
    const outcomes = FAULT_SET.faults.map(() => outcome(null, "x"));
    assert.throws(() => buildAutomotiveFaultReport({ faultSet: FAULT_SET, faultSetSha256: SHA, baseline: b, baselineReportPath: "baseline/report.json", outcomes, harnessIdentity: ID }), AutomotiveFaultGateError, bad);
  }
  const broken = await reportOf("reference");
  broken.case_evaluations.find((e) => e.variant === "price_change")!.verdict = "VIOLATION";
  assert.throws(() => witnessCaseIds(faultOf("AF10-stale-price-cache"), broken), /broken baseline cannot be a witness/);
  const clean = await reportOf("reference");
  assert.throws(() => witnessCaseIds({ ...faultOf("AF10-stale-price-cache"), witness_variants: ["no_such_variant"] }, clean), /no baseline case/);
  assert.throws(() => witnessCaseIds({ ...faultOf("AF10-stale-price-cache"), witness_variants: ["odometer_and_power"] }, clean), /belongs to vehicle_fact_integrity/);
});

test("baseline identity: a clean 18/18 PASS from any adapter other than the exact reference agent is refused (harness failure)", async () => {
  const foreign = await reportOf("float");
  assert.deepEqual([foreign.scenario_summary.verdict_counts.PASS, foreign.run_valid, foreign.all_required_assessed], [18, true, true], "technically a perfect run");
  assert.deepEqual(automotiveBaselineProblems(foreign), ["baseline identity is not the in-repo reference agent (adapter float-evidence-fixture-adapter 0.1.0, SUT synthetic-float-evidence-sut 0.1.0 revision null)"]);
  const outcomes = FAULT_SET.faults.map(() => outcome(null, "x"));
  assert.throws(() => buildAutomotiveFaultReport({ faultSet: FAULT_SET, faultSetSha256: SHA, baseline: foreign, baselineReportPath: "baseline/report.json", outcomes, harnessIdentity: ID }), (e: unknown) => e instanceof AutomotiveFaultGateError && /identity is not the in-repo reference agent/.test(e.message));
  // Every single identity field counts.
  const variants: [string, (r: AutomotiveReport) => void][] = [
    ["adapter name", (r) => (r.manifest.adapter!.name = "automotive-reference-adapter-x")],
    ["adapter version", (r) => (r.manifest.adapter!.version = "auto-reference-agent-0.1.1")],
    ["sut name", (r) => (r.manifest.sut!.name = "automotive-reference-agent-x")],
    ["sut version", (r) => (r.manifest.sut!.version = "auto-reference-agent-0.1.1")],
    ["sut revision", (r) => (r.manifest.sut!.revision = "deadbeef")],
    ["no hello", (r) => ((r.manifest.adapter = null), (r.manifest.sut = null))],
  ];
  for (const [what, change] of variants) {
    const r = await reportOf("reference");
    change(r);
    assert.equal(automotiveBaselineProblems(r).length, 1, what);
  }
  assert.deepEqual(automotiveBaselineProblems(await reportOf("reference")), []);
});

test("harness binding: baseline and every fault bundle must carry exactly the fault report's harness identity, else a harness failure", async () => {
  const gateError = (re: RegExp) => (e: unknown) => e instanceof AutomotiveFaultGateError && re.test(e.message);
  const build = async (opts: { injected?: typeof ID; baseline?: (r: AutomotiveReport) => void; fault?: [string, (r: AutomotiveReport) => void] }) => {
    const baseline = await reportOf("reference");
    opts.baseline?.(baseline);
    const outcomes: AutomotiveFaultRunOutcome[] = [];
    for (const f of FAULT_SET.faults) {
      const r = await reportOf(f.fault_id);
      if (opts.fault && opts.fault[0] === f.fault_id) opts.fault[1](r);
      outcomes.push({ report: r, report_path: `faults/${f.fault_id}/report.json`, failure: null });
    }
    return buildAutomotiveFaultReport({ faultSet: FAULT_SET, faultSetSha256: SHA, baseline, baselineReportPath: "baseline/report.json", outcomes, harnessIdentity: opts.injected ?? ID });
  };
  assert.equal((await build({})).gate.passed, true, "control: one identity everywhere");
  const otherCommit = "fedcba9876543210fedcba9876543210fedcba98";
  // Fault bundle from another commit, or with another worktree state.
  await assert.rejects(build({ fault: ["AF07-untrusted-price-promotion", (r) => (r.manifest.harness = { commit: otherCommit, worktree_clean: true })] }), gateError(/AF07-untrusted-price-promotion bundle harness fedcba98.* != baseline harness 01234567/));
  await assert.rejects(build({ fault: ["AF01-cross-listing-odometer", (r) => (r.manifest.harness = { ...ID, worktree_clean: false })] }), gateError(/AF01-cross-listing-odometer bundle harness .*worktree clean: false.* != baseline harness .*worktree clean: true/));
  // Baseline bundle that differs from the identity the fault report would record.
  await assert.rejects(build({ baseline: (r) => (r.manifest.harness = { commit: otherCommit, worktree_clean: true }) }), gateError(/baseline bundle harness fedcba98.* != fault report harness 01234567/));
  await assert.rejects(build({ injected: { ...ID, worktree_clean: false } }), gateError(/baseline bundle harness .*worktree clean: true.* != fault report harness .*worktree clean: false/));
  await assert.rejects(build({ injected: { commit: "unknown", worktree_clean: false } }), gateError(/!= fault report harness unknown/));
  // The mismatch is never turned into an INVALID fault or a kill: no report exists at all.
  let report: unknown = null;
  try {
    report = await build({ fault: ["AF03-unknown-listing-fact", (r) => (r.manifest.harness = { ...ID, commit: otherCommit })] });
  } catch {
    /* expected */
  }
  assert.equal(report, null);
});

// ------------------------------------------------------------ fault-set manifest

test("the committed fault set is valid; every implemented fault is declared and vice versa", () => {
  assert.deepEqual(checkAutomotiveFaultSet(FAULT_SET, corpus.entries, AUTOMOTIVE_FAULT_IDS), { ok: true, faultSet: FAULT_SET });
  assert.deepEqual(automotiveFaultSetProblems(FAULT_SET, corpus.entries, [...AUTOMOTIVE_FAULT_IDS, "AF11-new"]), ["implemented fault AF11-new is not declared"]);
  assert.deepEqual(automotiveFaultSetProblems(FAULT_SET, corpus.entries, AUTOMOTIVE_FAULT_IDS.slice(1)), ["declared fault AF01-cross-listing-odometer is not implemented"]);
});

test("fault-set validation fails closed on every malformed declaration", () => {
  const bad = (what: string, re: RegExp, mutate: (d: any) => void) => {
    const d = structuredClone(FAULT_SET) as any;
    mutate(d);
    const r = checkAutomotiveFaultSet(d, corpus.entries, AUTOMOTIVE_FAULT_IDS);
    assert.equal(r.ok, false, what);
    if (!r.ok) assert.ok(r.errors.some((e) => re.test(e)), `${what}: ${r.errors.join(" | ")}`);
  };
  bad("unknown version", /unsupported fault_set_version/, (d) => (d.fault_set_version = "auto-faults-9.9.9"));
  bad("duplicate fault id", /duplicate fault_id/, (d) => (d.faults[1].fault_id = d.faults[0].fault_id));
  bad("unknown domain", /unknown domain/, (d) => (d.faults[0].domain = "financing_fact_integrity"));
  bad("empty description", /empty description/, (d) => (d.faults[0].description = "  "));
  bad("empty target behaviour", /empty target_behavior/, (d) => (d.faults[0].target_behavior = ""));
  bad("invalid field", /invalid expected_field/, (d) => (d.faults[0].expected_field = "colour"));
  bad("empty reasons", /non-empty array/, (d) => (d.faults[0].expected_reasons = []));
  bad("non-VIOLATION reason", /not a VIOLATION reason/, (d) => (d.faults[0].expected_reasons = ["PROBE_UNANSWERED"]));
  bad("duplicate reason", /duplicate expected reason/, (d) => (d.faults[0].expected_reasons = ["FACT_VALUE_MISMATCH", "FACT_VALUE_MISMATCH"]));
  bad("missing witness variant", /not in the corpus/, (d) => (d.faults[0].witness_variants = ["no_such_variant"]));
  bad("witness of another domain", /belongs to price_attribution/, (d) => (d.faults[0].witness_variants = ["two_listing_current_prices"]));
  bad("duplicate witness", /duplicate witness variant/, (d) => (d.faults[0].witness_variants = ["odometer_and_power", "odometer_and_power"]));
  bad("no witnesses", /witness_variants must be a non-empty array/, (d) => (d.faults[0].witness_variants = []));
  bad("extra field", /schema: .*additional/, (d) => (d.faults[0].severity = "high"));
  bad("score field", /schema: .*additional/, (d) => (d.score = 1));
  bad("empty fault list", /non-empty array/, (d) => (d.faults = []));
});

test("declared fault-set coverage: every executable domain, and the union of reasons is every current VIOLATION reason", () => {
  for (const d of EXECUTABLE_AUTOMOTIVE_DOMAINS) assert.ok(FAULT_SET.faults.filter((f) => f.domain === d).length >= 1, d);
  assert.deepEqual([...new Set(FAULT_SET.faults.flatMap((f) => f.expected_reasons))].sort(), [...AUTOMOTIVE_VIOLATION_REASONS].sort());
});

// ------------------------------------------------------------ report discipline and summary

test("the fault report carries the complete limitations and no score, rate, percentage or severity anywhere", async () => {
  const r = await fullReport();
  assert.deepEqual(r.limitations, [...AUTOMOTIVE_FAULT_REPORT_LIMITATIONS]);
  assert.equal(r.limitations.length, 10);
  const forbidden = /score|grade|maturity|assurance_level|rating|rate$|ratio|percent|probability|severity|rank|weight/i;
  const keys = (v: unknown, out: string[]) => {
    if (Array.isArray(v)) v.forEach((x) => keys(x, out));
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), keys(x, out));
    return out;
  };
  for (const k of keys(r, [])) assert.ok(!forbidden.test(k), k);
  assert.deepEqual([r.harness, r.fault_set_sha256, r.corpus_sha256], [ID, SHA, "49c50fae1deeb1bd6f5a608ea0d9a2d5ebfd252e8df3ad59dc02b7cceb421a54"]);
  assert.equal(r.baseline.report_path, "baseline/report.json");
});

test("fault summary: factual headline and self-test notice, rendered from the report alone", async () => {
  const r = await fullReport();
  const s = renderAutomotiveFaultSummary(r);
  assert.ok(s.startsWith(`# Automotive fault sensitivity auto-faults-0.1.0\n\n${AUTOMOTIVE_FAULT_SELF_TEST_NOTICE}\n\n- Baseline reference run: PASS 18 / 18\n- Declared faults: 10\n- Killed: 10\n- Survived: 0\n- Invalid: 0\n- Gate passed: yes\n`));
  assert.ok(s.endsWith(`10. ${AUTOMOTIVE_FAULT_REPORT_LIMITATIONS[9]}\n`));
  for (const w of [/score/i, /kill rate/i, /%/, /certif/i, /\bsafe\b/i]) assert.ok(!w.test(s.slice(0, s.indexOf("## Limitations"))), String(w));
  assert.equal(renderAutomotiveFaultSummary(JSON.parse(JSON.stringify(r))), s);
  const altered = { ...structuredClone(r), limitations: ["Only this."] };
  assert.match(renderAutomotiveFaultSummary(altered), /## Limitations\n\n1\. Only this\.\n$/);
  const survived = await fullReport((id, x) => (id === "AF05-total-required-basis-bypass" ? { ...x, findings: [] } : x));
  assert.match(renderAutomotiveFaultSummary(survived), /- Survived: 1\n- Invalid: 0\n- Gate passed: no/);
});

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

test("purity: the fault summary imports only report types and spec vocabulary; the judge and builder run no SUT and read no files, Git or clock", () => {
  const dir = join(ROOT, "src", "fault", "automotive");
  assert.deepEqual(importsOf(join(dir, "summary.ts")).sort(), ["src/fault/automotive/types.ts", "src/spec/automotive/outcomes.ts"]);
  for (const name of ["report.ts", "manifest.ts", "summary.ts", "limitations.ts", "types.ts"]) {
    const imports = importsOf(join(dir, name));
    for (const t of imports) {
      assert.ok(!t.startsWith("node:"), `${name} imports ${t}`);
      assert.ok(!t.startsWith("src/adapter/") && !t.startsWith("src/eval/") && !t.startsWith("src/oracle/") && !t.includes("automotive-generation/generate") && !t.includes("harness-git"), `${name} imports ${t}`);
    }
    assert.ok(!/Date\.now|new Date|Math\.random|process\./.test(readFileSync(join(dir, name), "utf8")), `${name} reads ambient state`);
  }
});
