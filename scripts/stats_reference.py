"""Independent reference for test/stats.test.ts: exact one-sided Clopper-Pearson
upper bounds via rational binomial CDF + bisection (no floating-point CDF)."""
from fractions import Fraction
from math import comb

def cdf(k, n, p):
    return sum(comb(n, i) * p**i * (1 - p)**(n - i) for i in range(k + 1))

def upper(k, n, alpha=Fraction(1, 20)):
    if k == n:
        return 1.0
    lo, hi = Fraction(k, n), Fraction(1)
    for _ in range(45):
        mid = (lo + hi) / 2
        # keep denominators bounded
        mid = Fraction(round(mid * 10**15), 10**15)
        if cdf(k, n, mid) > alpha:
            lo = mid
        else:
            hi = mid
    return float((lo + hi) / 2)

if __name__ == "__main__":
    for k, n in [(0, 10), (0, 100), (0, 500), (1, 10), (2, 20), (5, 100), (10, 1000), (50, 500)]:
        print(k, n, f"{upper(k, n):.9f}")
    print(0, 10000, f"{1 - 0.05 ** (1 / 10000):.12f}")
