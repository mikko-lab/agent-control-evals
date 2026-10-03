import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AutomotiveAdapterClient, AutomotiveClientError } from "../../src/adapter/automotive/jsonl-client";
import { AutomotiveProtocolError } from "../../src/adapter/automotive/protocol";
import { exampleContradictionCase, exampleStaleInventoryCase, exampleVehicleFactCase, toAutomotiveAdapterView } from "../../src/corpus/automotive/builders";
import type { AutomotiveCaseForAdapter } from "../../src/corpus/automotive/types";

const ROOT = join(__dirname, "..", "..", "..");
const FAKE = join(ROOT, "test", "fixtures", "automotive", "fake-adapter.js");
const TIMEOUT_MS = 2_000;
const client = (mode: string, timeoutMs = TIMEOUT_MS) => new AutomotiveAdapterClient({ command: process.execPath, args: [FAKE, mode] }, timeoutMs);
const fact = toAutomotiveAdapterView(exampleVehicleFactCase());
const stale = toAutomotiveAdapterView(exampleStaleInventoryCase());
const contradiction = toAutomotiveAdapterView(exampleContradictionCase());

/** Runs one case in a fresh fake adapter and always shuts it down. */
async function one(mode: string, view: AutomotiveCaseForAdapter, timeoutMs = TIMEOUT_MS) {
  const c = client(mode, timeoutMs);
  try {
    await c.helloHandshake();
    return await c.runCase(view);
  } finally {
    await c.shutdown();
  }
}
const rejectsWith = async (p: Promise<unknown>, cls: Function, re: RegExp, what: string) =>
  assert.rejects(p, (e: unknown) => e instanceof cls && re.test((e as Error).message), what);

test("handshake, sequential cases and graceful shutdown", async () => {
  const c = client("valid");
  const hello = await c.helloHandshake();
  assert.deepEqual(hello.sut, { name: "synthetic-fake-sut", version: "0.0.0", revision: null });
  assert.equal(c.hello, hello);
  const a = await c.runCase(fact);
  const b = await c.runCase(stale);
  const d = await c.runCase(contradiction);
  assert.deepEqual([a.case_id, b.case_id, d.case_id], [fact.case_id, stale.case_id, contradiction.case_id]);
  assert.ok(b.status === "ok");
  assert.deepEqual(b.observations.turns.map((t) => t.step), [0, 2, 4]);
  assert.deepEqual(b.observations.event_acknowledgements.map((x) => [x.step, x.delivery.state]), [[1, "delivered"], [3, "delivered"]]);
  assert.equal(await c.shutdown(), 0, "clean exit after shutdown");
});

test("a case before the handshake is refused by the client", async () => {
  const c = client("valid");
  await rejectsWith(c.runCase(fact), AutomotiveClientError, /handshake required/, "no handshake");
  await c.shutdown();
});

test("silence and unavailable channels are valid evidence through the real process boundary", async () => {
  const s = await one("silent_claim_channel", stale);
  assert.ok(s.status === "ok");
  assert.ok(s.observations.turns.every((t) => t.claim_channel.state === "not_observed" && t.claims.length === 0));
  const u = await one("channel_unavailable", stale);
  assert.ok(u.status === "ok");
  assert.ok(u.observations.turns.every((t) => t.claim_channel.state === "unavailable" && t.claim_channel.source === "none"));
  assert.ok(u.observations.event_acknowledgements.every((x) => x.delivery.state === "unavailable" && x.delivery.source === "none"));
});

test("adapter_error is returned as a valid case result, not as a protocol failure", async () => {
  const r = await one("adapter_error", fact);
  assert.equal(r.status, "adapter_error");
  assert.equal(r.observations, null);
  assert.deepEqual(r.error, { message: "synthetic adapter failure" });
});

test("wrong but well-formed SUT behaviour is reported faithfully", async () => {
  const cross = await one("cross_listing_value", fact);
  assert.ok(cross.status === "ok");
  const p = cross.observations.turns[0].claims.find((c) => c.kind === "price");
  assert.ok(p && p.kind === "price" && p.listing_id === "L1" && p.amount_minor === 1_899_000, "L2's price on L1 is kept, not corrected");
  const unknown = await one("unknown_listing", fact);
  assert.ok(unknown.status === "ok");
  assert.equal(unknown.observations.turns[0].claims[0].listing_id, "L999");
  const quoted = await one("quoted_untrusted", contradiction);
  assert.ok(quoted.status === "ok");
  assert.deepEqual(quoted.observations.turns[0].claims[0].attribution, { kind: "quoted_untrusted", content_id: "content-1" });
  const quotedAbsent = await one("quoted_untrusted", fact);
  assert.ok(quotedAbsent.status === "ok");
  assert.deepEqual(quotedAbsent.observations.turns[0].claims[0].attribution, { kind: "quoted_untrusted", content_id: "content-not-in-case" });
});

test("observed fuel and transmission outside the input vocabulary cross the process boundary unchanged", async () => {
  const r = await one("open_vocabulary", fact);
  assert.ok(r.status === "ok");
  assert.deepEqual(
    r.observations.turns[0].claims.map((c) => (c.kind === "vehicle_fact" ? [c.listing_id, c.field, c.value, c.unit, c.attribution.kind] : null)),
    [
      ["L1", "fuel", "hydrogen", null, "trusted_fact"],
      ["L1", "transmission", "cvt", null, "trusted_fact"],
    ],
    "trusted L1 is diesel/automatic; the observation layer reports what the SUT said and corrects nothing",
  );
});

test("mapping fidelity through the process boundary", async () => {
  const r = await one("mapping_fidelity", contradiction);
  assert.ok(r.status === "ok");
  const t = r.observations.turns[0];
  assert.equal(t.step, 0);
  const byField = (field: string) => t.claims.filter((c) => c.field === field);
  assert.deepEqual(byField("model_year").map((c) => (c.kind === "vehicle_fact" ? [c.listing_id, c.value, c.unit] : null)), [["L1", 2019, "year"]]);
  assert.deepEqual(byField("power").map((c) => (c.kind === "vehicle_fact" ? [c.listing_id, c.value, c.unit] : null)), [["L1", 110, "kW"]]);
  assert.deepEqual(byField("odometer").map((c) => [c.listing_id, c.attribution]), [["L1", { kind: "quoted_untrusted", content_id: "content-1" }], ["L2", { kind: "approximate" }]]);
  assert.deepEqual(byField("price").map((c) => (c.kind === "price" ? [c.listing_id, c.amount_minor, c.currency, c.basis, c.temporal_qualifier] : null)), [
    ["L1", 2_249_000, null, "unknown", "previous"],
    ["L2", 1_800_000, "EUR", "total_with_mandatory_fees", "offer"],
  ]);
  assert.deepEqual(byField("status").map((c) => (c.kind === "status" ? c.status : null)), ["available"]);
  assert.deepEqual(t.status_presentations, [{ listing_id: "L1", status: "sold" }], "presentation that disagrees with the claim is kept");
  assert.deepEqual(t.references, [{ listing_id: "L1", kind: "recommended" }, { listing_id: "L2", kind: "mentioned" }]);
  assert.deepEqual(t.unverifiable_claims.map((u) => u.classification), ["qualitative"]);
});

test("protocol violations from the adapter fail closed and poison the client", async () => {
  const cases: [string, AutomotiveCaseForAdapter, RegExp][] = [
    ["wrong_case_id", fact, /case_id "auto-case-999999" != sent/],
    ["missing_turn", stale, /missing observation for user_message step 4/],
    ["duplicate_turn", fact, /duplicate observation for step 0/],
    ["turn_on_event_step", stale, /attached to step 1, which is an inventory_event step/],
    ["turn_on_event_step", fact, /nonexistent step 1/],
    ["missing_event_ack", stale, /missing acknowledgement for inventory_event step 3/],
    ["wrong_event_binding", stale, /step 1 acknowledges listing L2, the event is for L1/],
    ["observed_empty_channel", fact, /an observed channel must record at least one item/],
    ["unavailable_with_claim", fact, /recorded on a unavailable channel/],
    ["float_price", fact, /amount_minor: must be a non-negative integer/],
    ["wrong_unit", fact, /odometer requires unit "km"/],
  ];
  for (const [mode, view, re] of cases) {
    const c = client(mode);
    await c.helloHandshake();
    await rejectsWith(c.runCase(view), AutomotiveProtocolError, re, mode);
    await rejectsWith(c.runCase(view), AutomotiveProtocolError, re, `${mode}: client stays poisoned`);
    await c.shutdown();
  }
});

test("malformed JSON, wrong protocol version, timeout and premature exit fail closed", async () => {
  const bad = client("malformed_json");
  await bad.helloHandshake();
  await rejectsWith(bad.runCase(fact), AutomotiveProtocolError, /invalid JSON/, "malformed JSON");
  await bad.shutdown();

  const version = client("wrong_protocol_version");
  await rejectsWith(version.helloHandshake(), AutomotiveProtocolError, /protocol_version "auto-adapter-9.9.9" != auto-adapter-0.2.0/, "hello version mismatch");
  await rejectsWith(version.runCase(fact), AutomotiveClientError, /handshake required/, "no cases after a failed handshake");
  await version.shutdown();

  const hang = client("hang", 300);
  await hang.helloHandshake();
  await rejectsWith(hang.runCase(fact), AutomotiveClientError, /did not answer within 300 ms/, "timeout");
  await rejectsWith(hang.runCase(fact), AutomotiveClientError, /did not answer within 300 ms/, "poisoned after timeout");
  await hang.shutdown();

  const exit = client("premature_exit");
  await exit.helloHandshake();
  await rejectsWith(exit.runCase(fact), AutomotiveClientError, /exited prematurely \(code 9/, "premature exit");
  await exit.shutdown();
});

test("the case message sent across the boundary is the adapter view only", async () => {
  const c = client("valid");
  await c.helloHandshake();
  await assert.rejects(c.runCase(exampleStaleInventoryCase() as unknown as AutomotiveCaseForAdapter), /exactly the adapter view/, "a full case with annotations is never sent");
  // The refusal happens before any write, so the client is still usable.
  assert.equal((await c.runCase(stale)).status, "ok");
  await c.shutdown();
});
