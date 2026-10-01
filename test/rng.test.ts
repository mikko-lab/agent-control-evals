import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/util/rng";

test("same seed and stream give the same sequence; different streams differ", () => {
  const a = new Rng("s", "x");
  const b = new Rng("s", "x");
  const c = new Rng("s", "y");
  const sa = Array.from({ length: 50 }, () => a.u32());
  const sb = Array.from({ length: 50 }, () => b.u32());
  const sc = Array.from({ length: 50 }, () => c.u32());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
});

test("pinned first values (cross-platform regression; u32 values cross-checked with Python hashlib)", () => {
  const r = new Rng("ace", "pin");
  assert.deepEqual([r.u32(), r.u32(), r.int(0, 9), r.int(-5, 5)], [3723229880, 1006194891, 0, 5]);
});

test("int stays within inclusive bounds including large spans", () => {
  const r = new Rng("ace", "bounds");
  for (let i = 0; i < 2000; i++) {
    const v = r.int(-3, 3);
    assert.ok(v >= -3 && v <= 3);
    const w = r.int(0, 365 * 24 * 3_600_000 * 10);
    assert.ok(Number.isSafeInteger(w) && w >= 0 && w <= 365 * 24 * 3_600_000 * 10);
  }
});

