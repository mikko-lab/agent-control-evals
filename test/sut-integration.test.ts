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

test("real SUT: the adapter never maps an unclassifiable SUT exception (without execution) to DENY", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const keys = makeKeys();
  const c = forAdapter(smoke.find((x) => x.variant === "positive_agent_match_allow")!);
  const broken = { ...sut, GuardedExecutor: class { constructor() {} async process() { throw new TypeError("random failure"); } } };
  await assert.rejects(() => runRuntimeCase(c, broken as typeof sut, keys), /unclassified SUT exception/);
});

// ---- A1: decision vs effect -------------------------------------------------------------------

type AnyExec = { process(env: unknown): Promise<unknown>; resolveApproval(g: unknown): Promise<unknown> };
/** Run `fn` as the SUT's tool for the request carried by an envelope (simulates an execution the SUT does not report). */
async function runTool(sut: ReturnType<typeof loadSut>, env: { params: { payload: { tool: { name: string }; arguments: Record<string, { value: unknown }> } } }) {
  const p = env.params.payload;
  await sut.tools[p.tool.name]({ ace_trace: p.arguments.ace_trace.value });
}

function withExecutor(sut: ReturnType<typeof loadSut>, patch: (Real: new (...a: unknown[]) => AnyExec) => unknown) {
  return { ...sut, GuardedExecutor: patch(sut.GuardedExecutor as new (...a: unknown[]) => AnyExec) } as typeof sut;
}

test("A1: tool executed but SUT reports DENY -> ALLOW (effect) with sut_decision kept, not an AdapterError", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const c = forAdapter(smoke.find((x) => x.variant === "agent_mismatch_other_agent")!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<never> {
      await runTool(sut, env as never);
      throw new Error("Execution blocked (deny): simulated");
    }
  });
  const r = await runRuntimeCase(c, fake, makeKeys());
  const last = r.observations.assertions.filter((a) => a.stage === "request").at(-1)!;
  assert.equal(last.outcome, "ALLOW");
  assert.equal(last.decision_effect_mismatch, true);
  assert.match(last.sut_decision!, /^(DENY:|unclassified:)/);
  assert.ok((r.observations.decision_effect_mismatches ?? []).some((m) => m.observed_executions === 1 && m.decided_executions === 0));
  const total = Object.values(r.observations.executions).reduce((a, b) => a + b, 0);
  assert.ok(total >= 1);
});

test("A1: SUT returns pending (ASK) but the tool ran -> ALLOW with sut_decision ASK", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const c = forAdapter(smoke.find((x) => x.variant === "positive_agent_match_ask")!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      await runTool(sut, env as never);
      return { status: "pending" };
    }
  });
  const r = await runRuntimeCase(c, fake, makeKeys());
  const last = r.observations.assertions.filter((a) => a.stage === "request").at(-1)!;
  assert.equal(last.outcome, "ALLOW");
  assert.equal(last.sut_decision, "ASK");
});

test("A1: approval rejected by the SUT but the pending tool ran -> EXECUTE with sut_decision REJECT", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const c = forAdapter(smoke.find((x) => x.variant === "grant_for_read_record")!);
  let pendingEnv: unknown = null;
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      pendingEnv = env;
      return super.process(env);
    }
    override async resolveApproval(g: unknown): Promise<never> {
      await runTool(sut, pendingEnv as never);
      return super.resolveApproval(g) as Promise<never>;
    }
  });
  const r = await runRuntimeCase(c, fake, makeKeys());
  const ap = r.observations.assertions.filter((a) => a.stage === "approval").at(-1)!;
  assert.equal(ap.outcome, "EXECUTE");
  assert.match(ap.sut_decision!, /^REJECT:APPROVAL_TOOL_MISMATCH/);
});

test("A1: a post-execution-looking exception WITHOUT an execution is REJECT (flagged), never EXECUTE", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const c = forAdapter(smoke.find((x) => x.variant === "positive_valid_approval")!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async resolveApproval(): Promise<never> {
      throw new sut.CorrelationError("simulated correlation failure without execution");
    }
  });
  const r = await runRuntimeCase(c, fake, makeKeys());
  const ap = r.observations.assertions.filter((a) => a.stage === "approval").at(-1)!;
  assert.equal(ap.outcome, "REJECT");
  assert.equal(ap.decision_effect_mismatch, true);
  assert.match(ap.sut_decision!, /^EXECUTE:/);
});

test("A1: unclassifiable SUT exception without execution is still an AdapterError, with partial evidence kept", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const c = forAdapter(smoke.find((x) => x.variant === "positive_valid_approval")!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async resolveApproval(): Promise<never> {
      throw new TypeError("random failure");
    }
  });
  await assert.rejects(
    () => runRuntimeCase(c, fake, makeKeys()),
    (e: Error & { partial?: { assertions: unknown[]; executions: Record<string, number> } }) =>
      /unclassified SUT behaviour/.test(e.message) && Array.isArray(e.partial?.assertions) && e.partial!.assertions.length > 0,
  );
});
