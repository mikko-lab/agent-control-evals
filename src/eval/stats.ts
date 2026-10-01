/**
 * Exact binomial (Clopper-Pearson) one-sided upper confidence bounds.
 *
 * upper(k, n, alpha) = the p for which P(X <= k | n, p) = alpha, i.e. the
 * (1-alpha) quantile of Beta(k+1, n-k). For k = n the bound is 1. For k = 0
 * it has the closed form 1 - alpha^(1/n); the "rule of three" 3/n is reported
 * alongside as the familiar approximation.
 */
export const STATISTICS_DISCLAIMER =
  "Confidence bounds are conditional on the declared synthetic corpus sampling model. They are not estimates of the real-world probability that the system will fail in production.";

function logAddExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** log P(X <= k) for X ~ Binomial(n, p), computed in log space. */
export function logBinomCdf(k: number, n: number, p: number): number {
  if (k < 0) return -Infinity;
  if (k >= n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return -Infinity;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let logPmf = n * lq; // i = 0
  let acc = logPmf;
  for (let i = 0; i < k; i++) {
    logPmf += Math.log(n - i) - Math.log(i + 1) + lp - lq;
    acc = logAddExp(acc, logPmf);
  }
  return Math.min(0, acc);
}

export function clopperPearsonUpper(k: number, n: number, confidence = 0.95): number {
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || n <= 0 || k < 0 || k > n) throw new Error(`invalid k=${k} n=${n}`);
  if (k === n) return 1;
  const alpha = 1 - confidence;
  if (k === 0) return 1 - Math.pow(alpha, 1 / n);
  const target = Math.log(alpha);
  let lo = k / n;
  let hi = 1;
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2;
    if (logBinomCdf(k, n, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface Bound {
  k: number;
  n: number;
  observed_rate: number | null;
  one_sided_95_upper_bound: number | null;
  rule_of_three: number | null;
  method: "clopper-pearson-exact-one-sided";
}

export function bound(k: number, n: number): Bound {
  if (n === 0) return { k, n, observed_rate: null, one_sided_95_upper_bound: null, rule_of_three: null, method: "clopper-pearson-exact-one-sided" };
  return {
    k,
    n,
    observed_rate: round(k / n),
    one_sided_95_upper_bound: round(clopperPearsonUpper(k, n)),
    rule_of_three: k === 0 ? round(Math.min(1, 3 / n)) : null,
    method: "clopper-pearson-exact-one-sided",
  };
}

/** Fixed 6-significant-digit rounding so reports are stable across platforms. */
export function round(x: number): number {
  return Number(x.toPrecision(6));
}
