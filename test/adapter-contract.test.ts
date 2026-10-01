import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { validateCaseResult, validateHello, ProtocolError } from "../src/adapter/protocol";
import { runCases } from "../src/eval/run";
import { generateCorpus } from "../src/corpus/generate";
import { PROFILES } from "../src/corpus/profiles";
import { computeBoundaryMetrics } from "../src/eval/metrics";

const ROOT = join(__dirname, "..", "..");
const PIN = "403d31593a0d57187df3f5e1ef3df6127baaefb9";
const cases = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases).cases.slice(0, 5);
const fake = (mode: string) => ({ command: process.execPath, args: [join(ROOT, "test", "fixtures", "fake-adapter.js"), mode] });

test("structural validation rejects malformed results", () => {
  const ok = { type: "case_result", case_id: "c", protocol_version: 1, evaluation_boundary: "runtime", status: "ok", observations: { assertions: [], executions: {}, unattributed_executions: 0 }, raw_sut_evidence: null };
  assert.doesNotThrow(() => validateCaseResult(ok, "c", "runtime"));
  const bad: [string, unknown][] = [
    ["case_id", { ...ok, case_id: "d" }],
    ["boundary", { ...ok, evaluation_boundary: "component" }],
    ["protocol", { ...ok, protocol_version: 2 }],
    ["status", { ...ok, status: "deny" }],
    ["evidence", (({ raw_sut_evidence: _r, ...rest }) => rest)(ok)],
    ["observations", { ...ok, observations: null }],
    ["exec", { ...ok, observations: { ...ok.observations, executions: { a: -1 } } }],
    ["adapter_error w/o message", { ...ok, status: "adapter_error" }],
  ];
  for (const [name, x] of bad) assert.throws(() => validateCaseResult(x, "c", "runtime"), ProtocolError, name);
  assert.throws(() => validateHello({ type: "hello", protocol_version: 1, adapter: "a", adapter_version: "1", sut: { name: "n", commit: "c", version: "v" } }), ProtocolError);
});

test("adapter_error is recorded as an error, never as a verdict or a DENY", async () => {
  const r = await runCases(cases, fake("adapter-error"), PIN);
  assert.equal(r.verdicts.length, 0);
  assert.equal(r.adapter_errors.length, cases.length);
  const m = computeBoundaryMetrics("runtime", cases, r.verdicts);
  assert.equal(m.total.counts.cases, 0, "errored cases must not enter any denominator");
  assert.equal(m.total.counts.false_allow + m.total.counts.false_deny, 0);
});

for (const mode of ["garbage", "wrong-id", "bad-outcome", "unknown-reason"]) {
  test(`protocol violation (${mode}) aborts the run as a protocol error`, async () => {
    const r = await runCases(cases, fake(mode), PIN);
    assert.equal(r.verdicts.length, 0);
    assert.equal(r.harness_errors.length, 1);
    assert.equal(r.harness_errors[0].kind, "protocol_error");
  });
}

test("adapter crash mid-run is a protocol error and stops the run", async () => {
  const r = await runCases(cases, fake("crash"), PIN);
  assert.equal(r.verdicts.length, 1);
  assert.equal(r.harness_errors.length, 1);
  assert.match(r.harness_errors[0].message, /exited/);
});

test("adapter hang hits the per-case timeout and is a harness error", async () => {
  const r = await runCases(cases, fake("hang"), PIN, { timeoutMs: 500 });
  assert.equal(r.verdicts.length, 0);
  assert.equal(r.harness_errors[0].kind, "harness_error");
});

test("wrong protocol version or wrong SUT commit in hello fails closed before any case", async () => {
  const a = await runCases(cases, fake("bad-protocol"), PIN);
  assert.equal(a.results.length, 0);
  assert.equal(a.harness_errors.length, 1);
  const b = await runCases(cases, fake("wrong-sut"), PIN);
  assert.equal(b.results.length, 0);
  assert.match(b.harness_errors[0].message, /expected 403d315/);
});

test("an adapter that denies everything is caught as false denies, not rewarded", async () => {
  const sample = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases).cases.filter((c) => c.variant === "positive_agent_match_allow").slice(0, 3);
  const r = await runCases(sample, fake("deny-everything"), PIN);
  assert.equal(r.verdicts.length, 3);
  assert.ok(r.verdicts.every((v) => !v.outcome_match && v.mismatches.some((m) => m.kind === "false_deny")));
});
