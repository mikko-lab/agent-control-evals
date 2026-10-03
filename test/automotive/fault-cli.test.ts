import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { faultsAutomotive } from "../../src/automotive-cli";
import { AUTOMOTIVE_FAULT_IDS } from "../../src/adapter/automotive-faults/agent";
import type { AutomotiveFaultReport } from "../../src/fault/automotive/types";
import { sha256Hex } from "../../src/util/hash";

const ROOT = join(__dirname, "..", "..", "..");
const CLI = join(ROOT, "dist", "src", "automotive-cli.js");
const FAKE = join(ROOT, "test", "fixtures", "automotive", "fake-adapter.js");
const MANIFEST = join(ROOT, "faults", "automotive", "manifest.json");
const TMP = mkdtempSync(join(tmpdir(), "ace-auto-faults-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const outDir = () => join(TMP, `out-${++n}`);
const ID = { commit: "0123456789abcdef0123456789abcdef01234567", worktree_clean: true };
const BUNDLE = ["corpus.jsonl", "evidence.jsonl", "manifest.json", "report.json", "summary.md"];

function cli(...args: string[]) {
  const p = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
  let json: any = null;
  try {
    json = JSON.parse(p.stdout);
  } catch {
    /* not JSON */
  }
  return { code: p.status, stdout: p.stdout, stderr: p.stderr, json };
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]));
}
const rel = (dir: string) => files(dir).map((f) => relative(dir, f)).sort();
const reportOf = (dir: string): AutomotiveFaultReport => JSON.parse(readFileSync(join(dir, "fault-sensitivity.json"), "utf8"));

let gateOut: string | null = null;
function gate(): string {
  if (gateOut) return gateOut;
  const out = outDir();
  const r = cli("faults", "--profile", "smoke", "--out", out);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  gateOut = out;
  return out;
}

test("faults CLI: baseline 18/18 PASS, 10 declared faults all killed, exit 0, one compact JSON object", () => {
  const out = outDir();
  const r = cli("faults", "--profile", "smoke", "--out", out);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  gateOut = out;
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.deepEqual(Object.keys(r.json).sort(), ["baseline_valid", "corpus_sha256", "exit_code", "fault_count", "fault_report_schema_valid", "fault_set_sha256", "fault_set_version", "gate_passed", "invalid", "killed", "out", "survived"]);
  assert.deepEqual(
    [r.json.fault_set_version, r.json.fault_report_schema_valid, r.json.baseline_valid, r.json.gate_passed, r.json.fault_count, r.json.killed, r.json.survived, r.json.invalid, r.json.exit_code],
    ["auto-faults-0.1.0", true, true, true, 10, 10, 0, 0, 0],
  );
  assert.equal(r.json.corpus_sha256, "49c50fae1deeb1bd6f5a608ea0d9a2d5ebfd252e8df3ad59dc02b7cceb421a54");
});

test("fault output layout, schema validity, hash binding and no absolute paths or timestamps", () => {
  const out = gate();
  const expected = ["fault-set.json", "fault-sensitivity.json", "fault-summary.md", ...BUNDLE.map((f) => `baseline/${f}`), ...AUTOMOTIVE_FAULT_IDS.flatMap((id) => BUNDLE.map((f) => `faults/${id}/${f}`))].sort();
  assert.deepEqual(rel(out), expected, "exactly one directory per declared fault");
  const v = cli("validate-fault-report", "--file", join(out, "fault-sensitivity.json"));
  assert.deepEqual([v.code, v.json], [0, { ok: true, errors: [] }]);
  for (const dir of ["baseline", ...AUTOMOTIVE_FAULT_IDS.map((id) => `faults/${id}`)]) {
    assert.equal(cli("validate-report", "--file", join(out, dir, "report.json")).code, 0, dir);
    assert.equal(cli("validate-manifest", "--file", join(out, dir, "manifest.json")).code, 0, dir);
  }
  const fs = readFileSync(join(out, "fault-set.json"));
  assert.ok(fs.equals(readFileSync(MANIFEST)), "fault-set.json is the committed manifest, byte for byte");
  const report = reportOf(out);
  assert.equal(report.fault_set_sha256, sha256Hex(fs));
  assert.equal(report.corpus_sha256, sha256Hex(readFileSync(join(out, "baseline", "corpus.jsonl"))));
  assert.equal(report.baseline.evidence_sha256, sha256Hex(readFileSync(join(out, "baseline", "evidence.jsonl"))));
  for (const f of report.faults) {
    assert.equal(f.report_path, `faults/${f.fault_id}/report.json`);
    assert.equal(f.evidence_sha256, sha256Hex(readFileSync(join(out, "faults", f.fault_id, "evidence.jsonl"))), f.fault_id);
    assert.ok(readFileSync(join(out, "faults", f.fault_id, "summary.md"), "utf8").includes("SUT (self-declared via adapter hello): automotive-synthetic-fault-agent"));
    assert.ok(!readFileSync(join(out, "faults", f.fault_id, "summary.md"), "utf8").includes("Reference-agent self-test"), "the fault agent never gets the reference notice");
  }
  for (const f of files(out)) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes(TMP) && !text.includes(ROOT), `${relative(out, f)} has no absolute path`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), `${relative(out, f)} has no timestamp`);
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), `${relative(out, f)} ends with one LF`);
  }
  const summary = readFileSync(join(out, "fault-summary.md"), "utf8");
  assert.match(summary, /^# Automotive fault sensitivity auto-faults-0\.1\.0\n\nThis measures detection of the declared deliberately planted synthetic faults\. It is not an assessment of an external automotive AI product\.\n/);
});

test("the gate's baseline bundle is byte-identical to a normal evaluate --reference-agent bundle", () => {
  const out = gate();
  const ev = outDir();
  assert.equal(cli("evaluate", "--profile", "smoke", "--reference-agent", "--out", ev).code, 0);
  for (const f of BUNDLE) assert.ok(readFileSync(join(out, "baseline", f)).equals(readFileSync(join(ev, f))), f);
});

test("deterministic rerun: every fault-gate artifact is byte-identical", () => {
  const a = gate();
  const b = outDir();
  assert.equal(cli("faults", "--profile", "smoke", "--out", b).code, 0);
  assert.deepEqual(rel(a), rel(b));
  for (const f of rel(a)) assert.ok(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), f);
});

test("faults arguments: smoke only, --out required, no adapter options", () => {
  const usage = (args: string[], re: RegExp) => {
    const r = cli(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.json.error, re);
  };
  usage(["faults", "--profile", "full", "--out", outDir()], /unsupported automotive profile/);
  usage(["faults"], /--out is required/);
  usage(["faults", "--reference-agent", "--out", outDir()], /adapter options are not accepted/);
  usage(["faults", "--adapter-command", process.execPath, "--out", outDir()], /adapter options are not accepted/);
  usage(["faults", "--adapter-arg", "x", "--out", outDir()], /adapter options are not accepted/);
});

// ------------------------------------------------------------ negative gate controls (injected; the CLI never exposes these)

test("a surviving declared fault fails the gate with exit 3", async () => {
  const doc = JSON.parse(readFileSync(MANIFEST, "utf8"));
  doc.faults.find((f: { fault_id: string }) => f.fault_id === "AF06-current-price-currency").expected_reasons = ["CURRENCY_MISMATCH", "CROSS_LISTING_PRICE"];
  const faultSetFile = join(TMP, "survived-manifest.json");
  writeFileSync(faultSetFile, JSON.stringify(doc, null, 2) + "\n");
  const out = outDir();
  const r = await faultsAutomotive({ root: ROOT, out, harnessIdentity: ID, faultSetFile });
  assert.equal(r.exitCode, 3);
  assert.deepEqual([(r.stdout as any).gate_passed, (r.stdout as any).killed, (r.stdout as any).survived, (r.stdout as any).invalid], [false, 9, 1, 0]);
  const rep = reportOf(out);
  assert.equal(rep.faults.find((f) => f.fault_id === "AF06-current-price-currency")!.status, "survived");
  assert.ok(readFileSync(join(out, "fault-set.json")).equals(readFileSync(faultSetFile)), "the fault set actually used is the one recorded");
  assert.equal(cli("validate-fault-report", "--file", join(out, "fault-sensitivity.json")).code, 0);
});

test("an invalid fault run (HARNESS_ERROR) fails the gate with exit 3 and never kills the fault", async () => {
  const out = outDir();
  const r = await faultsAutomotive({
    root: ROOT,
    out,
    harnessIdentity: ID,
    faultAdapter: (id) => (id === "AF09-stale-status-cache" ? { command: process.execPath, args: [FAKE, "adapter_error"] } : { command: process.execPath, args: [join(ROOT, "dist", "src", "adapter", "automotive-faults", "main.js"), id] }),
  });
  assert.equal(r.exitCode, 3);
  assert.deepEqual([(r.stdout as any).killed, (r.stdout as any).survived, (r.stdout as any).invalid], [9, 0, 1]);
  const f = reportOf(out).faults.find((x) => x.fault_id === "AF09-stale-status-cache")!;
  assert.equal(f.status, "invalid");
  assert.match(f.invalid_reason ?? "", /run_valid false|HARNESS_ERROR/);
});

test("an invalid baseline is a harness failure (exit 2): no fault is run and no sensitivity is claimed", async () => {
  for (const mode of ["silent_claim_channel", "cross_listing_value", "adapter_error"]) {
    const out = outDir();
    let faultRuns = 0;
    const r = await faultsAutomotive({
      root: ROOT,
      out,
      harnessIdentity: ID,
      referenceAdapter: { command: process.execPath, args: [FAKE, mode] },
      faultAdapter: (id) => (faultRuns++, { command: process.execPath, args: [join(ROOT, "dist", "src", "adapter", "automotive-faults", "main.js"), id] }),
    });
    assert.equal(r.exitCode, 2, mode);
    assert.match((r.stdout as any).error, /baseline/);
    assert.equal(faultRuns, 0, `${mode}: no fault run after a broken baseline`);
    assert.ok(!existsSync(join(out, "fault-sensitivity.json")) && !existsSync(join(out, "faults")), mode);
  }
});

test("an invalid fault set or a golden mismatch is a harness failure (exit 2); stale output is removed first", async () => {
  const out = outDir();
  mkdirSync(join(out, "faults", "stale"), { recursive: true });
  writeFileSync(join(out, "fault-sensitivity.json"), "{}\n");
  const bad = join(TMP, "bad-manifest.json");
  writeFileSync(bad, JSON.stringify({ fault_set_version: "auto-faults-0.1.0", faults: [] }));
  const r = await faultsAutomotive({ root: ROOT, out, harnessIdentity: ID, faultSetFile: bad });
  assert.equal(r.exitCode, 2);
  assert.match((r.stdout as any).error, /invalid fault set/);
  assert.ok(!existsSync(join(out, "fault-sensitivity.json")) && !existsSync(join(out, "faults")), "stale fault output is gone");

  const root = join(TMP, "golden-root");
  mkdirSync(join(root, "corpus"), { recursive: true });
  cpSync(join(ROOT, "corpus", "automotive"), join(root, "corpus", "automotive"), { recursive: true });
  writeFileSync(join(root, "corpus", "automotive", "smoke.sha256"), "0".repeat(64) + "\n");
  const g = await faultsAutomotive({ root, out: outDir(), harnessIdentity: ID });
  assert.equal(g.exitCode, 2);
  assert.match((g.stdout as any).error, /^harness integrity: /);
});

test("validate-fault-report refuses invalid, unreadable and future-version reports with exit 2", () => {
  const out = gate();
  const doc = reportOf(out) as any;
  doc.gate.kill_rate = 1;
  const f = join(TMP, "bad-fault-report.json");
  writeFileSync(f, JSON.stringify(doc));
  assert.equal(cli("validate-fault-report", "--file", f).code, 2);
  const future = join(TMP, "future-fault-report.json");
  writeFileSync(future, JSON.stringify({ ...reportOf(out), fault_report_version: "auto-fault-report-0.2.0" }));
  const r = cli("validate-fault-report", "--file", future);
  assert.equal(r.code, 2);
  assert.match(r.json.errors[0], /unsupported fault_report_version/);
  assert.equal(cli("validate-fault-report", "--file", join(TMP, "missing.json")).code, 2);
  assert.equal(cli("validate-fault-report", "--file", join(out, "baseline", "report.json")).code, 2, "a D2 report is not a fault report");
});
