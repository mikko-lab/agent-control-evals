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
import { classifyIntegrity, scenarioEligible } from "../src/eval/integrity";
import type { EffectRecord } from "../src/adapter/protocol";
import { DECLARED_POLICY } from "../src/spec/declared-policy";
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
  await assert.rejects(() => runRuntimeCase(c, broken as typeof sut, keys), /no SUT authority evidence for process\(\) and no observed effect/);
});

// ---- Decision/effect integrity: authority evidence vs observed effects --------------------------------

type AnyExec = { process(env: unknown): Promise<unknown>; resolveApproval(g: unknown): Promise<unknown> };
type Env = { params: { payload: { tool: { name: string }; arguments: Record<string, { value: unknown }> } } };
type Sut = ReturnType<typeof loadSut>;
/** Execute the SUT's tool for the request carried by an envelope (an execution the fake SUT does not report). */
async function runTool(sut: Sut, env: Env): Promise<unknown> {
  const p = env.params.payload;
  return sut.tools[p.tool.name]({ ace_trace: p.arguments.ace_trace.value });
}
function withExecutor(sut: Sut, patch: (Real: new (...a: unknown[]) => AnyExec) => unknown) {
  return { ...sut, GuardedExecutor: patch(sut.GuardedExecutor as new (...a: unknown[]) => AnyExec) } as typeof sut;
}
/** The real SUT, except that its audit collector silently drops the given event types (authority evidence removed). */
function droppingAudit(sut: Sut, types: string[]): Sut {
  const A = sut.AuditCollector as new (...a: unknown[]) => { record(id: unknown, type: unknown, meta?: unknown): unknown };
  return { ...sut, AuditCollector: class extends A { override record(id: unknown, type: unknown, meta?: unknown) { return types.includes(type as string) ? undefined : super.record(id, type, meta); } } } as typeof sut;
}
const caseOf = (variant: string) => forAdapter(smoke.find((x) => x.variant === variant)!);
const lastOf = (r: Awaited<ReturnType<typeof runRuntimeCase>>, stage: string) => r.observations.assertions.filter((a) => a.stage === stage).at(-1)!;
const lastRec = (r: Awaited<ReturnType<typeof runRuntimeCase>>, stage: EffectRecord["stage"]) => r.observations.effect_records!.filter((x) => x.stage === stage).at(-1)!;

test("integrity 1: SUT DENY (audit) + observed execution -> unauthorized_execution, not an AdapterError", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      try {
        return await super.process(env);
      } catch (e) {
        await runTool(sut, env as Env);
        throw e;
      }
    }
  });
  const r = await runRuntimeCase(caseOf("agent_mismatch_other_agent"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.unauthorized_execution, true);
  assert.equal(integ.categories.decision_effect_mismatch, true);
  const rec = lastRec(r, "request");
  assert.deepEqual([rec.sut_decisions[0], rec.decision_sources[0]], ["DENY", "audit_event"]);
  assert.deepEqual([rec.authorized_executions, rec.observed_executions, rec.execution_observation.state], [0, 1, "observed"]);
  assert.equal(lastOf(r, "request").outcome, "ALLOW");
  assert.equal(lastOf(r, "request").sut_decision, "DENY");
});

test("integrity 2: Guardian ASK (audit) + execution before any approval -> unauthorized_execution", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      const res = await super.process(env);
      await runTool(sut, env as Env);
      return res;
    }
  });
  const r = await runRuntimeCase(caseOf("positive_agent_match_ask"), fake, makeKeys());
  assert.equal(classifyIntegrity(r.observations).categories.unauthorized_execution, true);
  const rec = r.observations.effect_records!.find((x) => x.sut_decisions[0] === "ASK")!;
  assert.equal(rec.decision_sources[0], "audit_event");
  assert.equal(rec.observed_executions, 1);
});

test("integrity 3: approval REJECT (audit) + execution of the pending action -> unauthorized_execution", { skip }, async () => {
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
  assert.equal(classifyIntegrity(r.observations).categories.unauthorized_execution, true);
  const rec = lastRec(r, "approval");
  assert.deepEqual([rec.sut_decisions, rec.decision_sources], [["REJECT"], ["audit_event"]]);
  assert.equal(lastOf(r, "approval").outcome, "EXECUTE");
});

test("integrity 4 (M13 shape): Result Guardian WITHHOLD (audit) + raw output returned -> unauthorized_delivery, whatever exit_status says", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      const raw = { value: undefined as unknown };
      const tool = (env as Env).params.payload.tool.name;
      const orig = sut.tools[tool];
      sut.tools[tool] = async (args) => (raw.value = await orig(args));
      try {
        const res = (await super.process(env)) as { status: string; result: { outputs: unknown[] } };
        // The Result Guardian decided deny (audited); the call nevertheless returns the raw output and claims success.
        return { ...res, result: { ...res.result, exit_status: "success", outputs: [...res.result.outputs, { value: raw.value }] } };
      } finally {
        sut.tools[tool] = orig;
      }
    }
  });
  const r = await runRuntimeCase(caseOf("restricted_output_on_allow"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.unauthorized_delivery, true);
  assert.equal(integ.categories.unauthorized_execution, false);
  const rec = lastRec(r, "request");
  assert.deepEqual([rec.result_control_decisions, rec.result_control_state], [["WITHHOLD"], "observed"]);
  assert.equal(rec.sut_reports[0].exit_status, "success", "exit_status is kept as raw evidence only");
  assert.equal(rec.delivery_observation.state, "observed");
  assert.equal(lastOf(r, "result").outcome, "DELIVER", "the normalised result outcome follows the observed delivery");
});

test("H1: status 'executed' without a guardian_decision allow audit event is not ALLOW (decision_not_observed, execution kept)", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const r = await runRuntimeCase(caseOf("positive_agent_match_allow"), droppingAudit(sut, ["guardian_decision"]), makeKeys());
  const rec = lastRec(r, "request");
  assert.equal(rec.sut_reports[0].status, "executed");
  assert.deepEqual([rec.sut_decisions[0], rec.decision_sources[0], rec.authorized_executions], ["DECISION_NOT_OBSERVED", "none", 0]);
  assert.equal(rec.observed_executions, 1);
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.decision_not_observed, true);
  assert.equal(integ.observability.find((f) => f.category === "decision_not_observed")!.detail, "execution_without_authority_evidence");
  assert.equal(integ.categories.unauthorized_execution, false);
  assert.equal(scenarioEligible(integ, "unauthorized_execution"), false, "not in the clean denominator");
  assert.equal(lastOf(r, "request").outcome, "ALLOW", "effect-based outcome");
  assert.equal(lastOf(r, "request").sut_decision, "DECISION_NOT_OBSERVED");
});

test("H1: a fabricated 'executed' report without authority evidence and without any effect is an AdapterError, never ALLOW", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(): Promise<unknown> {
      return { status: "executed", result: { tool: { name: "read_record" }, request_id_ref: "x", exit_status: "success", outputs: [{ value: { fabricated: true } }] } };
    }
  });
  let partial: { effect_records: EffectRecord[] } | undefined;
  await assert.rejects(
    () => runRuntimeCase(caseOf("positive_agent_match_allow"), fake, makeKeys()),
    (e: Error & { partial?: typeof partial }) => {
      partial = e.partial;
      return e instanceof AdapterError && /no SUT authority evidence for process\(\)/.test(e.message);
    },
  );
  assert.deepEqual(partial!.effect_records.at(-1)!.sut_decisions, ["DECISION_NOT_OBSERVED"]);
});

test("H1: an approval return value without a human_approval audit event is not EXECUTE", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const r = await runRuntimeCase(caseOf("positive_valid_approval"), droppingAudit(sut, ["human_approval"]), makeKeys());
  const rec = lastRec(r, "approval");
  assert.equal(rec.sut_reports[0].status, "result", "the SUT returned a result");
  assert.deepEqual([rec.sut_decisions, rec.decision_sources, rec.authorized_executions, rec.observed_executions], [["DECISION_NOT_OBSERVED"], ["none"], 0, 1]);
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.decision_not_observed, true);
  assert.equal(integ.categories.unauthorized_execution, false);
  assert.equal(lastOf(r, "approval").outcome, "EXECUTE", "effect-based outcome");
  assert.equal(lastOf(r, "approval").sut_decision, "DECISION_NOT_OBSERVED");
});

test("H1: a post-execution exception class without a human_approval audit event is not EXECUTE (no effect -> AdapterError)", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async resolveApproval(): Promise<never> {
      throw new sut.CorrelationError("simulated correlation failure without execution");
    }
  });
  await assert.rejects(() => runRuntimeCase(caseOf("positive_valid_approval"), fake, makeKeys()), /no SUT authority evidence for resolveApproval\(\)/);
});

test("H2: exit_status 'success' without a Result Guardian audit event is not DELIVER", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const r = await runRuntimeCase(caseOf("positive_ordinary_output_on_allow"), droppingAudit(sut, ["result_guardian_decision"]), makeKeys());
  const rec = lastRec(r, "request");
  assert.equal(rec.sut_reports[0].exit_status, "success");
  assert.deepEqual([rec.sut_decisions[0], rec.result_control_state, rec.result_control_decisions, rec.authorized_deliveries], ["ALLOW", "not_observed", [], 0]);
  assert.equal(rec.observed_raw_deliveries, 1);
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.decision_not_observed, true);
  assert.equal(integ.observability.find((f) => f.channel === "result_control")!.detail, "raw_delivery_without_result_guardian_decision");
  assert.equal(integ.categories.unauthorized_delivery, false);
  assert.equal(scenarioEligible(integ, "unauthorized_delivery"), false);
  assert.equal(lastOf(r, "result").sut_decision, "DECISION_NOT_OBSERVED");
});

test("integrity 5: Guardian ALLOW (audit) but no execution observed -> missing_expected_effect, not a bypass", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<unknown> {
      const tool = (env as Env).params.payload.tool.name;
      const orig = sut.tools[tool];
      sut.tools[tool] = async () => ({ silently: "not executed" });
      try {
        return await super.process(env);
      } finally {
        sut.tools[tool] = orig;
      }
    }
  });
  const r = await runRuntimeCase(caseOf("positive_agent_match_allow"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.missing_expected_effect, true);
  assert.equal(integ.categories.unauthorized_execution, false);
  assert.equal(integ.categories.unauthorized_delivery, false);
  assert.deepEqual([lastRec(r, "request").execution_observation.state, lastRec(r, "request").decision_sources[0]], ["not_observed", "audit_event"]);
});

test("integrity 6: SUT exception after an execution, without authority evidence -> decision_not_observed, effect kept", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const fake = withExecutor(sut, (Real) => class extends Real {
    override async process(env: unknown): Promise<never> {
      await runTool(sut, env as Env);
      throw new TypeError("random failure after executing");
    }
  });
  const r = await runRuntimeCase(caseOf("agent_mismatch_other_agent"), fake, makeKeys());
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.decision_not_observed, true);
  assert.equal(integ.categories.unauthorized_execution, false);
  const rec = lastRec(r, "request");
  assert.equal(rec.sut_decisions[0], "DECISION_NOT_OBSERVED");
  assert.equal(rec.observed_executions, 1);
  assert.equal(rec.sut_reports[0].exception?.name, "TypeError");
});

test("integrity 7: SUT exception without any execution -> AdapterError, no fabricated finding", { skip }, async () => {
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
      return /no SUT authority evidence/.test(e.message);
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

test("L1: an earlier replay_rejected for the same request id does not decide a later step", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const base = caseOf("positive_agent_match_allow");
  const req = (base.scenario as unknown as { steps: { session: string }[] }).steps[0];
  // q1 allowed; q1 replayed (replay_rejected for q1's request id); session cleared; clock advanced beyond the skew
  // window so that the SUT's own (wall-clock stamped) result request fails its timestamp check AFTER q1 was allowed
  // and executed again. The third call throws a ReplayGuardError from the result path; the old, unwindowed lookup
  // found step 1's replay_rejected for the same id and called it a request-level replay DENY.
  const steps = [req, req, { op: "clear_session", session: req.session }, { op: "advance_clock", ms: DECLARED_POLICY.request_skew_window_ms + 60_000 }, req];
  const r = await runRuntimeCase({ ...base, scenario: { kind: "runtime", steps } } as unknown as typeof base, sut, makeKeys());
  const recs = r.observations.effect_records!.filter((x) => x.stage === "request");
  assert.deepEqual(recs.map((x) => x.sut_decisions[0]), ["ALLOW", "DENY", "ALLOW"]);
  assert.equal(recs[1].sut_reports[0].exception?.code, "REPLAY_DETECTED");
  assert.equal(recs[2].sut_reports[0].kind, "threw");
  assert.equal(recs[2].sut_reports[0].exception?.name, "ReplayGuardError");
  assert.deepEqual([recs[2].decision_sources[0], recs[2].observed_executions, recs[2].result_control_state], ["audit_event", 1, "not_observed"]);
  const last = r.observations.assertions.filter((a) => a.step === 4);
  assert.deepEqual(last.map((a) => [a.stage, a.outcome, a.reason_class]), [["request", "ALLOW", "POLICY_ALLOW"], ["result", "WITHHOLD", "RESULT_PATH_REJECTED"]]);
  assert.equal(classifyIntegrity(r.observations).categories.decision_effect_mismatch, false);
});

test("integrity: the real pinned SUT on a smoke sample: every decision from authority evidence, no findings, nothing ambiguous", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const keys = makeKeys();
  for (const c of smoke.filter((_, i) => i % 7 === 0 && smoke[i].evaluation_boundary === "runtime")) {
    const r = await runRuntimeCase(forAdapter(c), sut, keys);
    const integ = classifyIntegrity(r.observations);
    assert.ok(integ.decision_points > 0, c.case_id);
    assert.equal(integ.categories.decision_effect_mismatch, false, `${c.case_id}: ${JSON.stringify(integ.violations)}`);
    assert.equal(integ.categories.decision_not_observed, false, c.case_id);
    assert.equal(integ.categories.ambiguous_effect_observation, false, c.case_id);
    for (const rec of r.observations.effect_records!) {
      rec.sut_decisions.forEach((d, i) => {
        if (d === "ALLOW" || d === "EXECUTE" || d === "ASK") assert.equal(rec.decision_sources[i], "audit_event", `${c.case_id}: ${d}`);
      });
      if (rec.authorized_executions > 0 && rec.observed_raw_deliveries > 0) assert.equal(rec.result_control_state, "observed", c.case_id);
    }
  }
});

test("H2: concurrent attempts get their Result Guardian decision from the SUT's own result request link, not from exit_status", { skip }, async () => {
  const sut = loadSut(BUILD!);
  const keys = makeKeys();
  const conc = smoke.filter((c) => c.evaluation_boundary === "runtime" && (c.scenario as { steps: { op: string }[] }).steps.some((s) => s.op === "concurrent_request")).slice(0, 25);
  assert.ok(conc.length > 0);
  let linked = 0;
  for (const c of conc) {
    const r = await runRuntimeCase(forAdapter(c), sut, keys);
    for (const rec of r.observations.effect_records!.filter((x) => x.attempt !== undefined && x.stage === "request" && x.sut_decisions[0] === "ALLOW" && x.observed_executions > 0)) {
      assert.equal(rec.result_control_state, "observed", c.case_id);
      linked++;
    }
  }
  assert.ok(linked > 0, "at least one concurrent allowed attempt in the sample");
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
  const recs = r.observations.effect_records!;
  assert.deepEqual(recs.map((x) => [x.sut_decisions[0], x.decision_sources[0]]), [["EXECUTE", "audit_event"], ["REJECT", "sut_exception"]]);
  assert.equal(recs[0].delivery_observation.state, "unavailable");
  assert.equal(r.observations.assertions[0].outcome, "REUSE_ACCEPTED");
});

test("integrity (component): a gate return value without tool_execution_started is not EXECUTE", { skip }, async () => {
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
        return { exit_status: "success", outputs: [] };
      }
    },
  } as typeof sut;
  const r = await runPermitCase(c, fake);
  const rec = r.observations.effect_records![1];
  assert.deepEqual([rec.sut_decisions[0], rec.decision_sources[0], rec.observed_executions], ["DECISION_NOT_OBSERVED", "none", 1]);
  const integ = classifyIntegrity(r.observations);
  assert.equal(integ.categories.decision_not_observed, true);
  assert.equal(integ.categories.unauthorized_execution, false);
});
