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
import { AdapterError, makeKeys, runRuntimeCase } from "../src/adapter/acs/runtime";
import { runPermitCase } from "../src/adapter/acs/component";
import { classifyIntegrity } from "../src/eval/integrity";
import type { EffectRecord } from "../src/adapter/protocol";
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
  await assert.rejects(() => runRuntimeCase(c, broken as typeof sut, keys), /unclassified SUT report on process\(\) without an observed effect/);
});

// ---- Decision/effect integrity (A1 + integrity metric) ----------------------------------------------

type AnyExec = { process(env: unknown): Promise<unknown>; resolveApproval(g: unknown): Promise<unknown> };
type Env = { params: { payload: { tool: { name: string }; arguments: Record<string, { value: unknown }> } } };
/** Execute the SUT's tool for the request carried by an envelope (an execution the fake SUT does not report). */
async function runTool(sut: ReturnType<typeof loadSut>, env: Env): Promise<unknown> {
  const p = env.params.payload;
  return sut.tools[p.tool.name]({ ace_trace: p.arguments.ace_trace.value });
}
function withExecutor(sut: ReturnType<typeof loadSut>, patch: (Real: new (...a: unknown[]) => AnyExec) => unknown) {
  return { ...sut, GuardedExecutor: patch(sut.GuardedExecutor as new (...a: unknown[]) => AnyExec) } as typeof sut;
}
const caseOf = (variant: string) => forAdapter(smoke.find((x) => x.variant === variant)!);
const lastOf = (r: Awaited<ReturnType<typeof runRuntimeCase>>, stage: string) => r.observations.assertions.filter((a) => a.stage === stage).at(-1)!;

test("integrity 1: DENY reported + observed execution -> unauthorized_execution, not an AdapterError", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<never> {
      await runTool(sut, env as Env);
      throw new Error("Execution blocked (deny): simulated");
    }
  });
  const r = await runRuntimeCase(caseOf("agent_mismatch_other_agent"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.unauthorized_execution, true);
  assert.equal(integ.categories.decision_effect_mismatch, true);
  const rec = r.observations.effect_records!.at(-1)!;
  assert.deepEqual([rec.authorized_executions, rec.observed_executions], [0, 1]);
  assert.equal(rec.sut_reports[0].kind, "threw");
  assert.equal(lastOf(r, "request").outcome, "ALLOW");
  assert.match(lastOf(r, "request").sut_decision!, /^(DENY|UNCLASSIFIED)$/);
});

test("integrity 2: ASK reported + execution before any approval -> unauthorized_execution", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      await runTool(sut, env as Env);
      return { status: "pending" };
    }
  });
  const r = await runRuntimeCase(caseOf("positive_agent_match_ask"), fake, makeKeys());
  assert.equal(classifyIntegrity(r.observations).categories.unauthorized_execution, true);
  assert.equal(r.observations.effect_records!.at(-1)!.sut_decisions[0], "ASK");
  assert.equal(lastOf(r, "request").sut_decision, "ASK");
});

test("integrity 3: approval REJECT reported + execution of the pending action -> unauthorized_execution", { skip }, async () => {
  const sut = loadSut(BUILD!);
  let pendingEnv: unknown = null;
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      pendingEnv = env;
      return super.process(env);
    }
    override async resolveApproval(g: unknown): Promise<never> {
      await runTool(sut, pendingEnv as Env);
      return super.resolveApproval(g) as Promise<never>;
    }
  });
  const r = await runRuntimeCase(caseOf("grant_for_read_record"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.unauthorized_execution, true);
  const rec = r.observations.effect_records!.filter((x) => x.stage === "approval").at(-1)!;
  assert.deepEqual(rec.sut_decisions, ["REJECT"]);
  assert.equal(lastOf(r, "approval").outcome, "EXECUTE");
});

test("integrity 4: result control WITHHOLD + raw output observed in the returned value -> unauthorized_delivery", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      const raw = { value: undefined as unknown };
      const tool = (env as Env).params.payload.tool.name;
      const orig = sut.tools[tool];
      sut.tools[tool] = async (args) => (raw.value = await orig(args));
      try {
        const res = (await super.process(env)) as { status: string; result: { outputs: unknown[] } };
        // SUT says WITHHOLD (exit_status blocked) but leaks the raw output alongside the withheld marker.
        return { ...res, result: { ...res.result, outputs: [...res.result.outputs, { value: raw.value }] } };
      } finally {
        sut.tools[tool] = orig;
      }
    }
  });
  const r = await runRuntimeCase(caseOf("restricted_output_on_allow"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.unauthorized_delivery, true);
  assert.equal(integ.categories.unauthorized_execution, false);
  const rec = r.observations.effect_records!.at(-1)!;
  assert.deepEqual(rec.result_control_decisions, ["WITHHOLD"]);
  assert.equal(lastOf(r, "result").outcome, "DELIVER", "the normalised result outcome follows the observed delivery");
});

test("integrity 5a: ALLOW reported (executed) but no execution observed -> missing_expected_effect, not a bypass", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(): Promise<unknown> {
      return { status: "executed", result: { tool: { name: "read_record" }, request_id_ref: "x", exit_status: "success", outputs: [{ value: { fabricated: true } }] } };
    }
  });
  const r = await runRuntimeCase(caseOf("positive_agent_match_allow"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.missing_expected_effect, true);
  assert.equal(integ.categories.unauthorized_execution, false);
  assert.equal(integ.categories.unauthorized_delivery, false);
});

test("integrity 5b: EXECUTE inferred from a post-execution exception without an execution -> missing_expected_effect, never EXECUTE", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async resolveApproval(): Promise<never> {
      throw new sut.CorrelationError("simulated correlation failure without execution");
    }
  });
  const r = await runRuntimeCase(caseOf("positive_valid_approval"), fake, makeKeys());
  assert.equal(classifyIntegrity(r.observations).categories.missing_expected_effect, true);
  assert.equal(lastOf(r, "approval").outcome, "REJECT");
  assert.equal(lastOf(r, "approval").sut_decision, "EXECUTE");
});

test("integrity 6: SUT exception after a confirmed execution -> the finding is kept (observations returned)", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<never> {
      await runTool(sut, env as Env);
      throw new TypeError("random failure after executing");
    }
  });
  const r = await runRuntimeCase(caseOf("agent_mismatch_other_agent"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.unauthorized_execution, true);
  const rec = r.observations.effect_records!.at(-1)!;
  assert.equal(rec.sut_decisions[0], "UNCLASSIFIED");
  assert.equal(rec.sut_reports[0].exception?.name, "TypeError");
});

test("integrity 7: SUT exception without any execution -> no fabricated unauthorized_execution", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async resolveApproval(): Promise<never> {
      throw new TypeError("random failure");
    }
  });
  let partial: { effect_records: EffectRecord[]; executions: Record<string, number> } | undefined;
  await assert.rejects(
    () => runRuntimeCase(caseOf("positive_valid_approval"), fake, makeKeys()),
    (e: Error & { partial?: typeof partial }) => {
      partial = e.partial;
      return /unclassified SUT report/.test(e.message);
    },
  );
  const integ = classifyIntegrity({ assertions: [], executions: partial!.executions, unattributed_executions: 0, effect_records: partial!.effect_records });
  assert.equal(integ.categories.unauthorized_execution, false);
  assert.equal(integ.categories.unauthorized_delivery, false);
  assert.ok(partial!.effect_records.length > 0, "decisions and effects observed before the error are kept");
});

test("integrity 8: a genuine adapter failure is an AdapterError and produces no SUT finding", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const c = caseOf("positive_agent_match_allow");
  const broken = { ...c, scenario: { kind: "runtime", steps: [{ op: "teleport" }] } } as unknown as typeof c;
  await assert.rejects(() => runRuntimeCase(broken, sut, makeKeys()), (e: Error) => e instanceof AdapterError);
  const r = await runCases(smoke.slice(0, 3), { command: process.execPath, args: [join(ROOT, "test", "fixtures", "fake-adapter.js"), "adapter-error"] }, PIN);
  assert.equal(r.verdicts.length, 0, "no verdict, hence no integrity or oracle finding, for an adapter failure");
  assert.equal(r.adapter_errors.length, 3);
});

test("integrity: the real pinned SUT shows no decision/effect violations on a smoke sample and records every decision point", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const keys = makeKeys();
  for (const c of smoke.filter((_, i) => i % 7 === 0 && smoke[i].evaluation_boundary === "runtime")) {
    const r = await runRuntimeCase(forAdapter(c), sut, keys);
    const integ = classifyIntegrity(r.observations);
    assert.ok(integ.decision_points > 0, c.case_id);
    assert.equal(integ.categories.decision_effect_mismatch, false, `${c.case_id}: ${JSON.stringify(integ.violations)}`);
  }
});

test("integrity (component): gate rejection with an observed execution -> unauthorized_execution", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const c = forAdapter(smoke.find((x) => x.variant === "sequential_reuse_x2")!);
  const Gate = sut.ExecutionGate as new (...a: unknown[]) => { execute(env: unknown, permit: unknown): Promise<unknown> };
  let n = 0;
  const fake = {
    ...sut,
    ExecutionGate: class extends Gate {
      override async execute(env: unknown, permit: unknown): Promise<unknown> {
        if (++n === 1) return super.execute(env, permit);
        await runTool(sut, env as Env);
        throw new Error("Execution blocked: valid execution permit required");
      }
    },
  } as typeof sut;
  const r = await runPermitCase(c, fake);
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.unauthorized_execution, true);
  assert.equal(r.observations.assertions[0].outcome, "REUSE_ACCEPTED");
});
