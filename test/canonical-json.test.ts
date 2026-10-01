import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, canonicalJsonLines } from "../src/util/canonical-json";

test("keys are sorted recursively and whitespace is removed", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test("non-integers, non-finite numbers, undefined members and non-plain objects are rejected", () => {
  assert.throws(() => canonicalJson({ a: 1.5 }));
  assert.throws(() => canonicalJson({ a: Number.NaN }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: new Date(0) }));
  assert.throws(() => canonicalJson({ a: 2 ** 60 }));
});

test("negative zero is normalised and strings use JSON escaping", () => {
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson("ä\n\" "), JSON.stringify("ä\n\" "));
});

test("JSON Lines: LF separated, exactly one final newline, empty -> empty string", () => {
  assert.equal(canonicalJsonLines([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
  assert.equal(canonicalJsonLines([]), "");
});
