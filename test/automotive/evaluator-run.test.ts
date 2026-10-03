import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { classifyHarnessFailure, runAutomotiveCorpus } from "../../src/eval/automotive/run";
import { preflightEntry } from "../../src/eval/automotive/truth";
import type { AutomotiveRunOutput } from "../../src/eval/automotive/types";
import { generateAutomotiveSmokeCorpus } from "../../src/corpus/automotive-generation/generate";
import type { AutomotiveCorpusEntry } from "../../src/corpus/automotive-generation/corpus-entry";
import { AutomotiveAdapterClient, AutomotiveClientError } from "../../src/adapter/automotive/jsonl-client";
import { AutomotiveProtocolError } from "../../src/adapter/automotive/protocol";
import { toAutomotiveAdapterView } from "../../src/corpus/automotive/builders";

const ROOT = join(__dirname, "..", "..", "..");
const FAKE = join(ROOT, "test", "fixtures", "automotive", "fake-adapter.js");
const fake = (mode: string) => ({ command: process.execPath, args: [FAKE, mode] });
const corpus = generateAutomotiveSmokeCorpus().entries;
const pick = (...variants: string[]): AutomotiveCorpusEntry[] => variants.map((v) => structuredClone(corpus.find((e) => e.case.variant === v)!));
const NEVER_SPAWNED = { command: join(ROOT, "does-not-exist", "adapter-binary"), args: [] };

/** No harness failure may ever surface as a SUT violation. */
function assertNoViolationFromHarness(r: AutomotiveRunOutput) {
  for (const ev of r.case_evaluations) {
    if (ev.verdict === "HARNESS_ERROR") assert.ok(ev.checks.every((c) => c.verdict === "HARNESS_ERROR" && c.observed === null), ev.case_id);
  }
}

// ------------------------------------------------------------ preflight

test("preflight: a clean corpus passes; invalid fixtures and stale expectations are caught before any SUT runs", async () => {
  for (const e of corpus) assert.equal(preflightEntry(e), null, e.case.case_id);

  const badFixture = pick("odometer_and_power")[0];
  badFixture.case.scenario.trusted.inventory[0].dealer_id = "D9";
  assert.equal(preflightEntry(badFixture)?.reason, "FIXTURE_INVALID");
  const badVersion = { ...pick("odometer_and_power")[0], corpus_entry_version: "auto-corpus-entry-9.9.9" } as unknown as AutomotiveCorpusEntry;
  assert.equal(preflightEntry(badVersion)?.reason, "FIXTURE_INVALID");
  const stale = pick("price_change")[0];
  const p = stale.expected.probe_expectations[1];
  assert.ok(p.kind === "price");
  p.accepted_presentations[0].amount_minor = 1_899_000;
  assert.deepEqual([preflightEntry(stale)?.reason, preflightEntry(stale)?.message], ["ORACLE_INTEGRITY_ERROR", "stored expected output differs from the oracle's recomputation"]);
  const throwing = pick("odometer_and_power")[0];
  (throwing.case.annotations.probes[0] as { field: string }).field = "colour";
  assert.equal(preflightEntry(throwing)?.reason, "FIXTURE_INVALID", "fixture validation runs first");

  // A failing preflight never spawns the adapter: the command does not even exist.
  const r = await runAutomotiveCorpus([pick("odometer_and_power")[0], stale, badFixture], NEVER_SPAWNED);
  assert.equal(r.hello, null);
  assert.equal(r.run_valid, false);
  assert.deepEqual(r.harness_errors.map((h) => [h.case_id, h.reason]), [[stale.case.case_id, "ORACLE_INTEGRITY_ERROR"], [badFixture.case.case_id, "FIXTURE_INVALID"]]);
  assert.deepEqual(r.not_run_case_ids, ["auto-case-000001"]);
  assert.deepEqual(r.case_evaluations.map((e) => [e.case_id, e.verdict, e.checks.map((c) => c.reasons[0])]), [
    [stale.case.case_id, "HARNESS_ERROR", ["ORACLE_INTEGRITY_ERROR", "ORACLE_INTEGRITY_ERROR"]],
    [badFixture.case.case_id, "HARNESS_ERROR", ["FIXTURE_INVALID", "FIXTURE_INVALID"]],
  ]);
  assert.deepEqual(r.case_results, []);
  assertNoViolationFromHarness(r);
});

// ------------------------------------------------------------ run-time harness failures

test("explicit adapter_error: HARNESS_ERROR / ADAPTER_ERROR per case, and the run continues", async () => {
  const entries = pick("odometer_and_power", "price_change", "status_available");
  const r = await runAutomotiveCorpus(entries, fake("adapter_error"));
  assert.ok(r.hello);
  assert.equal(r.case_evaluations.length, 3, "the protocol channel stays valid");
  assert.ok(r.case_evaluations.every((e) => e.verdict === "HARNESS_ERROR" && e.checks.every((c) => c.reasons[0] === "ADAPTER_ERROR")));
  assert.equal(r.adapter_errors.length, 3);
  assert.deepEqual(r.not_run_case_ids, []);
  assert.equal(r.run_valid, false);
  assertNoViolationFromHarness(r);
});

test("protocol, timeout and process failures stop the run and leave the rest unrun", async () => {
  const entries = pick("price_change", "odometer_and_power", "status_available");
  const cases: [string, string, number?][] = [
    ["missing_turn", "PROTOCOL_ERROR"],
    ["malformed_json", "PROTOCOL_ERROR"],
    ["wrong_case_id", "PROTOCOL_ERROR"],
    ["hang", "TIMEOUT", 300],
    ["premature_exit", "ADAPTER_ERROR"],
  ];
  for (const [mode, reason, timeoutMs] of cases) {
    const r = await runAutomotiveCorpus(entries, fake(mode), { timeoutMs });
    assert.deepEqual(r.harness_errors.map((h) => [h.case_id, h.reason]), [[entries[0].case.case_id, reason]], mode);
    assert.deepEqual(r.case_evaluations.map((e) => e.verdict), ["HARNESS_ERROR"], mode);
    assert.deepEqual(r.not_run_case_ids, [entries[1].case.case_id, entries[2].case.case_id], mode);
    assert.equal(r.run_valid, false);
    assertNoViolationFromHarness(r);
  }
});

test("a failed handshake or an unstartable adapter runs no case", async () => {
  const entries = pick("odometer_and_power", "price_change");
  const version = await runAutomotiveCorpus(entries, fake("wrong_protocol_version"));
  assert.deepEqual(version.harness_errors.map((h) => [h.case_id, h.reason]), [[null, "PROTOCOL_ERROR"]]);
  assert.deepEqual(version.not_run_case_ids, entries.map((e) => e.case.case_id));
  assert.deepEqual(version.case_evaluations, []);
  const spawn = await runAutomotiveCorpus(entries, NEVER_SPAWNED);
  assert.deepEqual(spawn.harness_errors.map((h) => [h.case_id, h.reason]), [[null, "ADAPTER_ERROR"]]);
  assert.match(spawn.harness_errors[0].message, /failed to spawn adapter/);
  assert.deepEqual(spawn.not_run_case_ids, entries.map((e) => e.case.case_id));
});

test("well-formed but wrong SUT evidence through the process boundary is a SUT VIOLATION, not a harness error", async () => {
  const r = await runAutomotiveCorpus(pick("two_listing_current_prices"), fake("cross_listing_value"));
  assert.equal(r.run_valid, true);
  assert.deepEqual(r.harness_errors, []);
  const p1 = r.case_evaluations[0].checks.find((c) => c.check_id === "probe:p1")!;
  assert.deepEqual([p1.verdict, p1.reasons], ["VIOLATION", ["PRICE_VALUE_MISMATCH", "CROSS_LISTING_PRICE"]]);
  const open = await runAutomotiveCorpus(pick("untrusted_fuel_conflict"), fake("open_vocabulary"));
  const fuel = open.case_evaluations[0].checks.find((c) => c.check_id === "probe:p1")!;
  assert.deepEqual([fuel.verdict, fuel.reasons], ["VIOLATION", ["FACT_VALUE_MISMATCH"]], "observed hydrogen for a diesel car");
  const silent = await runAutomotiveCorpus(pick("odometer_and_power"), fake("silent_claim_channel"));
  assert.equal(silent.case_evaluations[0].verdict, "UNASSESSABLE");
  assert.ok(silent.case_evaluations[0].checks.every((c) => c.reasons[0] === "PROBE_UNANSWERED"));
  const unavailable = await runAutomotiveCorpus(pick("price_change"), fake("channel_unavailable"));
  assert.ok(unavailable.case_evaluations[0].checks.filter((c) => c.required).every((c) => c.verdict === "UNASSESSABLE"));
  assert.deepEqual(unavailable.case_evaluations[0].checks.map((c) => c.reasons[0]), ["CHANNEL_UNAVAILABLE", "EVENT_DELIVERY_UNCONFIRMED"], "post-event probe: the unavailable acknowledgement takes precedence");
});

// ------------------------------------------------------------ typed client errors (PR C client regression)

test("client errors carry a deterministic kind; the harness classifies without parsing messages", async () => {
  const view = toAutomotiveAdapterView(corpus[0].case);
  const kindOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof AutomotiveClientError ? e.kind : e instanceof AutomotiveProtocolError ? "protocol" : "other";
    }
    return "none";
  };
  const fresh = new AutomotiveAdapterClient(fake("valid"), 2_000);
  assert.equal(await kindOf(fresh.runCase(view)), "client_state", "case before handshake");
  await fresh.helloHandshake();
  assert.equal(await kindOf(fresh.helloHandshake()), "client_state", "repeated handshake");
  assert.equal((await fresh.runCase(view)).status, "ok", "client still usable after client_state errors");
  await fresh.shutdown();

  const hang = new AutomotiveAdapterClient(fake("hang"), 300);
  await hang.helloHandshake();
  assert.equal(await kindOf(hang.runCase(view)), "timeout");
  await hang.shutdown();

  const exit = new AutomotiveAdapterClient(fake("premature_exit"), 2_000);
  await exit.helloHandshake();
  assert.equal(await kindOf(exit.runCase(view)), "process_exit");
  await exit.shutdown();

  const spawn = new AutomotiveAdapterClient(NEVER_SPAWNED, 2_000);
  assert.equal(await kindOf(spawn.helloHandshake()), "spawn");
  await spawn.shutdown(200);

  assert.equal(classifyHarnessFailure(new AutomotiveProtocolError("x")), "PROTOCOL_ERROR");
  assert.equal(classifyHarnessFailure(new AutomotiveClientError("x", "timeout")), "TIMEOUT");
  for (const k of ["process_exit", "spawn", "client_state"] as const) assert.equal(classifyHarnessFailure(new AutomotiveClientError("x", k)), "ADAPTER_ERROR");
  assert.equal(classifyHarnessFailure(new Error("unknown")), "ADAPTER_ERROR");
});
