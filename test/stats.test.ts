import { test } from "node:test";
import assert from "node:assert/strict";
import { bound, clopperPearsonUpper, logBinomCdf } from "../src/eval/stats";

// Reference values computed independently with exact rational arithmetic
// (scripts/stats_reference.py: Python fractions + bisection).
const VECTORS: [number, number, number][] = [
  [0, 10, 0.258865551],
  [0, 100, 0.02951305],
  [0, 500, 0.005973552],
  [0, 10000, 0.00029952836],
  [1, 10, 0.394163302],
  [2, 20, 0.282618525],
  [5, 100, 0.102253378],
  [10, 1000, 0.016903175],
  [50, 500, 0.124865807],
];

test("Clopper-Pearson one-sided 95% upper bounds match reference vectors", () => {
  for (const [k, n, want] of VECTORS) {
    const got = clopperPearsonUpper(k, n);
    assert.ok(Math.abs(got - want) < 1e-7, `k=${k} n=${n}: got ${got}, want ${want}`);
  }
});

test("k = n gives 1 and k = 0 matches closed form", () => {
  assert.equal(clopperPearsonUpper(7, 7), 1);
  for (const n of [1, 3, 30, 3000]) assert.ok(Math.abs(clopperPearsonUpper(0, n) - (1 - Math.pow(0.05, 1 / n))) < 1e-12);
});

test("bound reports rule of three only when k = 0", () => {
  assert.equal(bound(0, 300).rule_of_three, 0.01);
  assert.equal(bound(1, 300).rule_of_three, null);
  assert.equal(bound(0, 0).one_sided_95_upper_bound, null);
});

test("binomial CDF is a CDF", () => {
  assert.ok(Math.abs(Math.exp(logBinomCdf(10, 10, 0.3)) - 1) < 1e-12);
  assert.ok(Math.exp(logBinomCdf(3, 10, 0.3)) < Math.exp(logBinomCdf(4, 10, 0.3)));
});
