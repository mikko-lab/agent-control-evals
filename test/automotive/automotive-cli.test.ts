import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAutomotive, parseAutomotiveArgs, AUTOMOTIVE_BUNDLE_FILES } from "../../src/automotive-cli";
import type { AutomotiveEvidenceRecord, AutomotiveReport } from "../../src/report/automotive/types";
import { canonicalJson } from "../../src/util/canonical-json";
import { sha256Hex } from "../../src/util/hash";

const ROOT = join(__dirname, "..", "..", "..");
const CLI = join(ROOT, "dist", "src", "automotive-cli.js");
const FAKE = join(ROOT, "test", "fixtures", "automotive", "fake-adapter.js");
const GOLDEN = readFileSync(join(ROOT, "corpus", "automotive", "smoke.jsonl"));
const GOLDEN_SHA = readFileSync(join(ROOT, "corpus", "automotive", "smoke.sha256"), "utf8").trim();
const NEVER_SPAWNED = { command: join(ROOT, "does-not-exist", "adapter-binary"), args: [] };
const TMP = mkdtempSync(join(tmpdir(), "ace-auto-cli-"));
let n = 0;
const outDir = () => join(TMP, `out-${++n}`);
after(() => rmSync(TMP, { recursive: true, force: true }));

function cli(...args: string[]) {
  const p = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  return { code: p.status, stdout: p.stdout, json: (() => { try { return JSON.parse(p.stdout); } catch { return null; } })(), stderr: p.stderr };
}
const fakeArgs = (mode: string) => ["--adapter-command", process.execPath, "--adapter-arg", FAKE, "--adapter-arg", mode, "--timeout-ms", "5000"];
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const reportOf = (dir: string): AutomotiveReport => JSON.parse(read(dir, "report.json"));
const evidenceOf = (dir: string): AutomotiveEvidenceRecord[] => read(dir, "evidence.jsonl").trimEnd().split("\n").map((l) => JSON.parse(l));

let referenceOut: string | null = null;
function referenceBundle(): string {
  if (referenceOut) return referenceOut;
  const out = outDir();
  const r = cli("evaluate", "--profile", "smoke", "--reference-agent", "--out", out);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  referenceOut = out;
  return out;
}

// ------------------------------------------------------------ reference acceptance

test("reference-agent acceptance: the CLI writes a valid 18/18 PASS bundle and exits 0", () => {
  const out = outDir();
  const r = cli("evaluate", "--profile", "smoke", "--reference-agent", "--out", out);
  assert.equal(r.code, 0, r.stderr);
  referenceOut = out;
  assert.deepEqual(Object.keys(r.json).sort(), ["all_required_assessed", "complete_execution", "corpus_sha256", "evidence_sha256", "exit_code", "manifest_schema_valid", "not_run", "out", "report_schema_valid", "run_valid", "scenario_verdicts"]);
  assert.deepEqual(
    [r.json.report_schema_valid, r.json.manifest_schema_valid, r.json.run_valid, r.json.complete_execution, r.json.all_required_assessed, r.json.not_run, r.json.exit_code],
    [true, true, true, true, true, 0, 0],
  );
  assert.deepEqual(r.json.scenario_verdicts, { PASS: 18, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0 });
  assert.equal(r.stdout.trim().split("\n").length, 1, "one concise JSON object on stdout");

  assert.deepEqual(readdirSync(out).sort(), [...AUTOMOTIVE_BUNDLE_FILES].sort());
  const rep = reportOf(out);
  assert.deepEqual([rep.scenario_summary.planned_scenarios, rep.scenario_summary.not_run_scenarios], [18, 0]);
  assert.deepEqual(rep.check_summary.required, { total: 32, PASS: 32, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0, assessed: 32 });
  assert.equal(rep.check_summary.optional.PASS, rep.check_summary.optional.total);
  assert.deepEqual([rep.observation_evidence.quoted_claims.total, rep.observation_evidence.unverifiable_claims.total], [0, 0]);
});

test("reference bundle artifacts: schemas valid via the CLI, hashes bound, manifest embedded, summary from report, no timestamps or paths", () => {
  const out = referenceBundle();
  for (const [cmd, f] of [["validate-report", "report.json"], ["validate-manifest", "manifest.json"]]) {
    const v = cli(cmd, "--file", join(out, f));
    assert.equal(v.code, 0, cmd);
    assert.deepEqual(v.json, { ok: true, errors: [] });
  }
  const corpusBytes = readFileSync(join(out, "corpus.jsonl"));
  assert.ok(corpusBytes.equals(GOLDEN), "corpus.jsonl is byte-identical to the committed golden");
  const manifest = JSON.parse(read(out, "manifest.json"));
  assert.equal(manifest.corpus.sha256, GOLDEN_SHA);
  assert.equal(sha256Hex(corpusBytes), manifest.corpus.sha256);
  assert.equal(manifest.corpus.bytes, corpusBytes.length);
  const evidence = readFileSync(join(out, "evidence.jsonl"));
  assert.equal(sha256Hex(evidence), manifest.evidence.sha256);
  assert.equal(manifest.evidence.bytes, evidence.length);
  assert.equal(evidenceOf(out).length, manifest.evidence.records);
  assert.equal(canonicalJson(reportOf(out).manifest), canonicalJson(manifest), "report.json embeds exactly manifest.json");
  const s = cli("summary", "--file", join(out, "report.json"));
  assert.equal(s.code, 0);
  assert.equal(s.stdout, read(out, "summary.md"), "summary.md is the rendering of report.json");
  for (const f of AUTOMOTIVE_BUNDLE_FILES) {
    const text = read(out, f);
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), `${f} ends with exactly one LF`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), `${f} has no timestamp`);
    assert.ok(!text.includes(TMP) && !text.includes(ROOT), `${f} has no absolute path`);
  }
});

test("deterministic rerun: identical artifact bytes for all five files", () => {
  const a = referenceBundle();
  const b = outDir();
  assert.equal(cli("evaluate", "--profile", "smoke", "--reference-agent", "--out", b).code, 0);
  for (const f of AUTOMOTIVE_BUNDLE_FILES) assert.ok(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), f);
});

// ------------------------------------------------------------ exit codes

test("VIOLATION: exit 1, and the violation is visible in counts, domain, variant, findings and reason counts", () => {
  const out = outDir();
  const r = cli("evaluate", "--profile", "smoke", ...fakeArgs("cross_listing_value"), "--out", out);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.run_valid, true);
  assert.ok(r.json.scenario_verdicts.VIOLATION > 0);
  const rep = reportOf(out);
  assert.ok(rep.by_domain.price_attribution.verdict_counts.VIOLATION > 0);
  assert.equal(rep.by_variant["price_attribution/two_listing_current_prices"].verdict_counts.VIOLATION, 1);
  assert.ok(rep.findings.some((f) => f.verdict === "VIOLATION" && f.reasons.includes("CROSS_LISTING_PRICE")));
  assert.ok(rep.reason_counts.VIOLATION.CROSS_LISTING_PRICE > 0);
  assert.match(read(out, "summary.md"), /\*\*VIOLATION\*\* PRICE_VALUE_MISMATCH, CROSS_LISTING_PRICE/);
  assert.equal(cli("validate-report", "--file", join(out, "report.json")).code, 0);
});

test("UNASSESSABLE only: exit 0, but all_required_assessed is false and nothing is counted as PASS or assessed", () => {
  const out = outDir();
  const r = cli("evaluate", "--profile", "smoke", ...fakeArgs("silent_claim_channel"), "--out", out);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.scenario_verdicts, { PASS: 0, VIOLATION: 0, UNASSESSABLE: 18, HARNESS_ERROR: 0 });
  assert.deepEqual([r.json.run_valid, r.json.complete_execution, r.json.all_required_assessed], [true, true, false]);
  const rep = reportOf(out);
  assert.deepEqual([rep.scenario_summary.assessed_scenarios, rep.check_summary.required.assessed], [0, 0]);
  assert.ok(rep.findings.length > 0 && rep.findings.every((f) => f.verdict === "UNASSESSABLE"));
  assert.match(read(out, "summary.md"), /All required checks assessed: no/);
});

test("HARNESS_ERROR: exit 2, run_valid false, never counted as VIOLATION; a protocol failure leaves the rest not run", () => {
  const out = outDir();
  const r = cli("evaluate", "--profile", "smoke", ...fakeArgs("adapter_error"), "--out", out);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.run_valid, false);
  assert.deepEqual(r.json.scenario_verdicts, { PASS: 0, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 18 });
  const rep = reportOf(out);
  assert.equal(rep.scenario_summary.violation_count, 0);
  assert.equal(cli("validate-report", "--file", join(out, "report.json")).code, 0, "the bundle of an invalid run is itself a valid report");
  assert.ok(evidenceOf(out).every((e) => e.status === "harness_error" && e.adapter_result !== null));

  const out2 = outDir();
  const p = cli("evaluate", "--profile", "smoke", ...fakeArgs("missing_turn"), "--out", out2);
  assert.equal(p.code, 2);
  assert.deepEqual([p.json.not_run, p.json.complete_execution, p.json.scenario_verdicts.HARNESS_ERROR], [17, false, 1]);
  const ev = evidenceOf(out2);
  assert.deepEqual([ev[0].status, ev[0].adapter_result], ["harness_error", null]);
  assert.ok(ev.slice(1).every((e) => e.status === "not_run" && e.adapter_result === null && e.evaluation === null));
});

test("float raw evidence end to end: valid bundle, exact round-trip through evidence.jsonl, deterministic SHA", () => {
  const FLOAT = join(ROOT, "test", "fixtures", "automotive", "float-evidence-adapter.js");
  const args = ["evaluate", "--profile", "smoke", "--adapter-command", process.execPath, "--adapter-arg", FLOAT];
  const a = outDir();
  const b = outDir();
  const ra = cli(...args, "--out", a);
  const rb = cli(...args, "--out", b);
  assert.equal(ra.code, 0, ra.stdout + ra.stderr);
  assert.deepEqual([ra.json.report_schema_valid, ra.json.manifest_schema_valid, ra.json.run_valid, ra.json.all_required_assessed], [true, true, true, true]);
  assert.deepEqual(ra.json.scenario_verdicts, { PASS: 18, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0 });
  assert.equal(ra.json.evidence_sha256, rb.json.evidence_sha256, "deterministic evidence SHA");
  for (const f of AUTOMOTIVE_BUNDLE_FILES) assert.ok(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), f);
  const evidence = readFileSync(join(a, "evidence.jsonl"));
  assert.equal(sha256Hex(evidence), ra.json.evidence_sha256);
  const records = evidenceOf(a);
  assert.equal(records.length, 18);
  records.forEach((r, i) => assert.deepEqual(r.adapter_result?.raw_sut_evidence, { big: 1e21, confidence: 0.73, latency_ms: 12.5 + i + 1, ratio: 1 / 3, tiny: 1e-7 }, r.case_id));
  assert.ok(read(a, "evidence.jsonl").includes('"raw_sut_evidence":{"big":1e+21,"confidence":0.73,"latency_ms":13.5,"ratio":0.3333333333333333,"tiny":1e-7}'));
  assert.ok(!read(a, "summary.md").includes("Reference-agent self-test"), "a different self-declared identity gets no self-test notice");
  assert.equal(cli("validate-report", "--file", join(a, "report.json")).code, 0);
  assert.equal(cli("validate-manifest", "--file", join(a, "manifest.json")).code, 0);
});

test("argument rules: one adapter source, smoke profile only, required --out, no shell", () => {
  const out = outDir();
  const usage = (args: string[], re: RegExp) => {
    const r = cli(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.json.error, re);
  };
  usage(["evaluate", "--reference-agent", "--adapter-command", process.execPath, "--out", out], /exactly one adapter source/);
  usage(["evaluate", "--out", out], /exactly one adapter source/);
  usage(["evaluate", "--profile", "full", "--reference-agent", "--out", out], /unsupported automotive profile/);
  usage(["evaluate", "--reference-agent"], /--out is required/);
  usage(["evaluate", "--reference-agent", "--adapter-arg", "x", "--out", out], /only valid with --adapter-command/);
  usage(["evaluate", "--reference-agent", "--timeout-ms", "0", "--out", out], /positive integer/);
  usage(["evaluate", "--reference-agent", "--bogus", "--out", out], /unknown option/);
  usage(["mutate"], /unknown command/);
  assert.ok(!existsSync(out), "no usage error writes anything");
  assert.deepEqual(parseAutomotiveArgs(["evaluate", "--adapter-arg", "--looks-like-a-flag", "--adapter-arg", "b c"]).adapterArgs, ["--looks-like-a-flag", "b c"]);

  // Arguments reach the adapter verbatim, never through a shell.
  const marker = join(TMP, "shell-was-used");
  const literal = `literal; touch ${marker}`;
  const shellOut = outDir();
  const r = cli("evaluate", "--adapter-command", process.execPath, "--adapter-arg", FAKE, "--adapter-arg", literal, "--out", shellOut);
  assert.ok(r.code === 0 || r.code === 1, r.stdout);
  assert.ok(!existsSync(marker), "no shell interpreted the argument");
  assert.deepEqual(evidenceOf(shellOut)[0].adapter_result?.raw_sut_evidence, { mode: literal });
});

test("golden precondition: a corpus or SHA mismatch exits 2 before any adapter starts and leaves no report", async () => {
  const fakeRoot = (mutate: (dir: string) => void) => {
    const root = join(TMP, `root-${++n}`);
    mkdirSync(join(root, "corpus"), { recursive: true });
    cpSync(join(ROOT, "corpus", "automotive"), join(root, "corpus", "automotive"), { recursive: true });
    mutate(join(root, "corpus", "automotive"));
    return root;
  };
  const cases: [string, (d: string) => void, RegExp][] = [
    ["changed corpus byte", (d) => writeFileSync(join(d, "smoke.jsonl"), GOLDEN.toString("utf8").replace("auto-case-000001", "auto-case-000009")), /differs from the committed golden/],
    ["changed SHA file", (d) => writeFileSync(join(d, "smoke.sha256"), "0".repeat(64) + "\n"), /golden SHA mismatch/],
    ["missing golden", (d) => rmSync(join(d, "smoke.jsonl")), /could not be read/],
  ];
  for (const [what, mutate, re] of cases) {
    const out = outDir();
    mkdirSync(out);
    writeFileSync(join(out, "report.json"), "{\"stale\":true}\n");
    const r = await evaluateAutomotive({ root: fakeRoot(mutate), out, adapter: NEVER_SPAWNED });
    assert.equal(r.exitCode, 2, what);
    const body = r.stdout as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /^harness integrity: /, what);
    assert.match(body.error, re, what);
    assert.match(body.error, /no adapter was started and no report was produced/);
    assert.deepEqual(readdirSync(out), [], `${what}: no artifact, and the stale report is gone`);
  }
});

test("summary / validate commands refuse invalid input with exit 2 and regenerate nothing", () => {
  const out = referenceBundle();
  const bad = join(TMP, "bad-report.json");
  const rep = reportOf(out) as any;
  rep.scenario_summary.verdict_counts.PASS = "eighteen";
  writeFileSync(bad, JSON.stringify(rep));
  const s = cli("summary", "--file", bad);
  assert.equal(s.code, 2);
  assert.equal(s.json.ok, false);
  assert.ok(s.json.errors.length > 0);
  const v = cli("validate-report", "--file", bad);
  assert.deepEqual([v.code, v.json.ok], [2, false]);
  const notJson = join(TMP, "not-json.json");
  writeFileSync(notJson, "{");
  for (const cmd of ["summary", "validate-report", "validate-manifest"]) assert.equal(cli(cmd, "--file", notJson).code, 2, cmd);
  assert.equal(cli("validate-manifest", "--file", join(out, "report.json")).code, 2, "a report is not a manifest");
  assert.equal(cli("validate-report", "--file", join(TMP, "missing.json")).code, 2);
  const future = join(TMP, "future-report.json");
  writeFileSync(future, JSON.stringify({ ...reportOf(out), report_schema_version: "auto-report-0.2.0" }));
  assert.match(cli("validate-report", "--file", future).json.errors[0], /unsupported report_schema_version/);
});
