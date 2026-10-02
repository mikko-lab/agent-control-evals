import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTrace, ToolDoubles, ToolStateLeakError, TRACE_ARG } from "../src/adapter/acs/tool-doubles";

type Fn = (a: Record<string, unknown>) => Promise<unknown>;
function registry() {
  const read: Fn = async () => "orig-read";
  const upd: Fn = async () => "orig-update";
  return { reg: { read_record: read, update_record: upd } as Record<string, Fn>, read, upd };
}

test("install replaces, restore puts back the exact original functions and keys", async () => {
  const { reg, read, upd } = registry();
  const t = makeTrace("s1/q1", 0, 0);
  const d = new ToolDoubles(reg, new Map([[t, { classification: "restricted" }]]), ["read_record", "update_record", "extra_tool"]);
  d.install();
  assert.notEqual(reg.read_record, read);
  assert.deepEqual(await reg.read_record({ [TRACE_ARG]: t }), { classification: "restricted" });
  d.restore();
  assert.equal(reg.read_record, read);
  assert.equal(reg.update_record, upd);
  assert.deepEqual(Object.keys(reg).sort(), ["read_record", "update_record"]);
  assert.deepEqual(d.log, [{ tool: "read_record", trace: t, output: '{"classification":"restricted"}' }]);
});

test("outputs and execution logs never leak into the next case", async () => {
  const { reg } = registry();
  const t = makeTrace("s1/q1", 0, 0);
  const a = new ToolDoubles(reg, new Map([[t, { classification: "restricted" }]]), ["read_record"]);
  a.install();
  await reg.read_record({ [TRACE_ARG]: t });
  a.restore();
  const b = new ToolDoubles(reg, new Map(), ["read_record"]);
  b.install();
  assert.deepEqual(await reg.read_record({ [TRACE_ARG]: t }), { status: "ok" });
  b.restore();
  assert.equal(b.log.length, 1);
  assert.equal(a.log.length, 1);
});

test("returned outputs are deep copies (SUT mutation cannot alter corpus data)", async () => {
  const { reg } = registry();
  const t = makeTrace("s1/q1", 0, 0);
  const out = { classification: "restricted", rows: [1] };
  const d = new ToolDoubles(reg, new Map([[t, out]]), ["read_record"]);
  d.install();
  const got = (await reg.read_record({ [TRACE_ARG]: t })) as { rows: number[] };
  got.rows.push(2);
  d.restore();
  assert.deepEqual(out.rows, [1]);
});

test("a second concurrent install on the same registry is refused (interleaving would leak doubles)", () => {
  const { reg, read } = registry();
  const a = new ToolDoubles(reg, new Map(), ["read_record"]);
  const b = new ToolDoubles(reg, new Map(), ["read_record"]);
  a.install();
  assert.throws(() => b.install(), ToolStateLeakError);
  a.restore();
  assert.equal(reg.read_record, read);
  b.install();
  b.restore();
});

test("restore without install, and double install of one instance, are refused", () => {
  const { reg } = registry();
  const d = new ToolDoubles(reg, new Map(), ["read_record"]);
  assert.throws(() => d.restore(), ToolStateLeakError);
  d.install();
  assert.throws(() => d.install(), ToolStateLeakError);
  d.restore();
});
