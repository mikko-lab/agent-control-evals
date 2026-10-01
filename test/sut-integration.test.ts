/**
 * Contract tests against the real pinned ACS adapter. Requires a prepared
 * SUT environment (CI: `ace sut-verify` first):
 *   ACE_SUT_CHECKOUT=<checkout> ACE_SUT_BUILD=<build>
 * Skipped (not passed) when those are not set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { adapterCommand } from "../src/sut/environment";
import { runCases } from "../src/eval/run";
import { generateCorpus } from "../src/corpus/generate";
import { PROFILES } from "../src/corpus/profiles";
import { loadSut } from "../src/adapter/acs/sut";
import { makeKeys, runRuntimeCase } from "../src/adapter/acs/runtime";
import { forAdapter } from "../src/eval/run";

const ROOT = join(__dirname, "..", "..");
const CO = process.env.ACE_SUT_CHECKOUT;
const BUILD = process.env.ACE_SUT_BUILD;
const skip = !CO || !BUILD ? "ACE_SUT_CHECKOUT/ACE_SUT_BUILD not set" : false;
const PIN = "403d31593a0d57187df3f5e1ef3df6127baaefb9";
const smoke = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases).cases;

test("real adapter: hello reports the pinned, clean SUT and protocol v1", { skip }, async () => {
  const r = await runCases(smoke.slice(0, 1), adapterCommand(ROOT, CO!, BUILD!), PIN);
  assert.equal(r.hello?.protocol_version, 1);
  assert.equal(r.hello?.sut.commit, PIN);
  assert.equal(r.hello?.sut.worktree_clean, true);
  assert.equal(r.harness_errors.length, 0);
});

test("real adapter: unknown message type and wrong protocol version terminate the adapter (exit != 0)", { skip }, () => {
  const cmd = adapterCommand(ROOT, CO!, BUILD!);
  for (const line of ['{"type":"nope","protocol_version":1}', '{"type":"hello","protocol_version":2}', "not json"]) {
    const r = spawnSync(cmd.command, cmd.args, { input: line + "\n", env: { ...process.env, ...cmd.env }, encoding: "utf8" });
    assert.notEqual(r.status, 0, line);
    assert.equal(r.stdout, "", "no response line on protocol violation");
  }
});

test("real adapter: one case per line in, one result per line out, in order, across both boundaries", { skip }, async () => {
  const sample = [...smoke.filter((c) => c.evaluation_boundary === "runtime").slice(0, 10), ...smoke.filter((c) => c.evaluation_boundary === "component").slice(0, 10)];
  const r = await runCases(sample, adapterCommand(ROOT, CO!, BUILD!), PIN);
  assert.deepEqual(r.results.map((x) => x.case_id), sample.map((c) => c.case_id));
  assert.equal(r.adapter_errors.length, 0);
});

test("real SUT: tool registry is restored after every case and restricted output does not leak into the next case", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const before = new Map(Object.entries(sut.tools));
  const keys = makeKeys();
  const restricted = smoke.find((c) => c.variant === "restricted_output_on_allow")!;
  const ordinary = smoke.find((c) => c.variant === "positive_ordinary_output_on_allow")!;
  const a = await runRuntimeCase(forAdapter(restricted), sut, keys);
  const b = await runRuntimeCase(forAdapter(ordinary), sut, keys);
  const res = (o: typeof a) => o.observations.assertions.filter((x) => x.stage === "result").map((x) => x.outcome);
  assert.equal(res(a).at(-1), "WITHHOLD");
  assert.equal(res(b).at(-1), "DELIVER");
  assert.deepEqual(Object.keys(sut.tools).sort(), [...before.keys()].sort());
  for (const [k, fn] of before) assert.equal(sut.tools[k], fn, `tools.${k} restored`);
});

test("real SUT: concurrent cases on one registry are refused rather than allowed to interleave", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const keys = makeKeys();
  const c = smoke.find((x) => x.variant === "positive_ordinary_output_on_allow")!;
  const results = await Promise.allSettled([runRuntimeCase(forAdapter(c), sut, keys), runRuntimeCase(forAdapter(c), sut, keys)]);
  assert.ok(results.some((r) => r.status === "rejected"), "second concurrent install must be refused");
  const after = await runRuntimeCase(forAdapter(c), sut, keys);
  assert.ok(after.observations.assertions.length > 0, "registry usable again after the refused case");
});

test("real SUT: the adapter never maps an unclassifiable SUT exception to DENY", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const keys = makeKeys();
  const c = forAdapter(smoke.find((x) => x.variant === "positive_agent_match_allow")!);
  const broken = { ...sut, GuardedExecutor: class { constructor() {} async process() { throw new TypeError("random failure"); } } };
  await assert.rejects(() => runRuntimeCase(c, broken as typeof sut, keys), /unclassified SUT exception/);
});

test("real SUT: a post-execution-looking exception without an actual execution is an adapter error, not EXECUTE", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const keys = makeKeys();
  const c = forAdapter(smoke.find((x) => x.variant === "positive_valid_approval")!);
  const Real = sut.GuardedExecutor;
  const Fake = class extends Real {
    async resolveApproval(): Promise<never> {
      throw new sut.CorrelationError("simulated correlation failure without execution");
    }
  };
  await assert.rejects(() => runRuntimeCase(c, { ...sut, GuardedExecutor: Fake } as typeof sut, keys), /observations but 0 observed tool executions/);
});
