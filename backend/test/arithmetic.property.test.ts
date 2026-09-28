// Property tests (fast-check) for money and weight arithmetic: exact integer results, no float
// drift, symmetric rounding for negatives, and the Hasad settlement rule (finding L-7).

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  calculateSettlement,
  divRound,
  formatWeight,
  gramsToMg,
  mgToGrams,
  mulDivRound,
  parseScaled,
  pureGoldMg,
  roundMoney,
  PAYMENT_ACCOUNT,
  PAYMENT_METHODS,
  sumInt,
  valueOfWeight,
  weightedPricePerGram,
} from '@jerp/shared';

const RUNS = { numRuns: 2_000 };
const safe = fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
const den = fc.integer({ min: 1, max: 1_000_000_000 }).chain((d) => fc.constantFrom(d, -d));
/** Realistic weights (up to 100 kg in mg) and prices (up to 100 million per gram). */
const weightMg = fc.integer({ min: 0, max: 100_000_000 });
const signedWeightMg = fc.integer({ min: -100_000_000, max: 100_000_000 });
const pricePerGram = fc.integer({ min: 0, max: 100_000_000 });
const karat = fc.integer({ min: 1, max: 24 });

/** Reference: exact rational comparison with BigInt, independent of the implementation. */
function isCorrectRounding(num: bigint, d: bigint, r: bigint): boolean {
  if (d < 0n) {
    num = -num;
    d = -d;
  }
  const twiceErr = 2n * num - 2n * r * d; // 2·(num/d − r)·d
  const absErr = twiceErr < 0n ? -twiceErr : twiceErr;
  if (absErr > d) return false; // |num/d − r| > ½
  if (absErr === d) {
    // Exact tie: must round away from zero, i.e. |r| > |num/d|.
    const absR = r < 0n ? -r : r;
    const absNum = num < 0n ? -num : num;
    return absR * d > absNum;
  }
  return true;
}

describe('integer division and rounding', () => {
  it('divRound is the correctly rounded quotient (half away from zero)', () => {
    fc.assert(fc.property(safe, den, (n, d) => isCorrectRounding(BigInt(n), BigInt(d), BigInt(divRound(n, d)))), RUNS);
  });

  it('rounding is symmetric for negatives: round(−x) = −round(x)', () => {
    fc.assert(fc.property(safe, den, (n, d) => divRound(-n, d) === -divRound(n, d) || (divRound(-n, d) === 0 && divRound(n, d) === 0)), RUNS);
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(-1, 2)).toBe(-1);
    expect(divRound(1, -2)).toBe(-1);
  });

  it('mulDivRound is exact even when the product exceeds 2^53', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), fc.integer({ min: -1e9, max: 1e9 }), den, (a, b, d) => {
        const product = BigInt(a) * BigInt(b);
        const expectedFits = (() => {
          try {
            return mulDivRound(a, b, d);
          } catch {
            return null; // result outside the safe range: refusing is the correct behaviour
          }
        })();
        return expectedFits === null || isCorrectRounding(product, BigInt(d), BigInt(expectedFits));
      }),
      RUNS,
    );
  });

  it('refuses non-integers, unsafe integers and division by zero instead of guessing', () => {
    expect(() => divRound(1.5, 2)).toThrow(RangeError);
    expect(() => divRound(1, 0)).toThrow(RangeError);
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER + 1, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(RangeError);
    expect(() => sumInt([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });

  it('sums of integers are exact and order-independent', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1e12, max: 1e12 }), { maxLength: 50 }), (xs) => {
        const reversed = [...xs].reverse();
        return sumInt(xs) === sumInt(reversed) && BigInt(sumInt(xs)) === xs.reduce((s, x) => s + BigInt(x), 0n);
      }),
      RUNS,
    );
  });
});

describe('weights', () => {
  it('grams ↔ mg round-trips exactly for every mg value', () => {
    fc.assert(fc.property(signedWeightMg, (mg) => gramsToMg(mgToGrams(mg)) === mg && gramsToMg(formatWeight(mg, false)) === mg), RUNS);
  });

  it('typed decimal grams are parsed without float error and rounded symmetrically', () => {
    expect(gramsToMg('4.2005')).toBe(4201);
    expect(gramsToMg('-4.2005')).toBe(-4201);
    expect(gramsToMg('1.0004')).toBe(1000);
    expect(gramsToMg(1.0005)).toBe(1001); // 1.0005 × 1000 in floating point is 1000.4999…
    expect(gramsToMg('.5')).toBe(500);
    expect(gramsToMg(1e-7)).toBe(0);
    expect(() => parseScaled('abc', 3)).toThrow(RangeError);
    expect(() => parseScaled('', 3)).toThrow(RangeError);
  });

  it('pure-gold equivalent: exact, 24K is identity, symmetric, monotonic in karat', () => {
    fc.assert(
      fc.property(signedWeightMg, karat, (mg, k) => {
        const p = pureGoldMg(mg, k);
        return (
          pureGoldMg(mg, 24) === mg &&
          pureGoldMg(-mg, k) === -p &&
          isCorrectRounding(BigInt(mg) * BigInt(k), 24n, BigInt(p)) &&
          (k === 24 || Math.abs(pureGoldMg(mg, k + 1)) >= Math.abs(p))
        );
      }),
      RUNS,
    );
  });
});

describe('money', () => {
  it('value of a weight is the correctly rounded mg × price / 1000', () => {
    fc.assert(fc.property(weightMg, pricePerGram, (mg, p) => isCorrectRounding(BigInt(mg) * BigInt(p), 1000n, BigInt(valueOfWeight(mg, p)))), RUNS);
    // The float formula this replaces, Math.round((mg / 1000) × rate), gets real cases wrong:
    // 9 mg at 190 500/g is exactly 1 714.5 → 1 715, but (9 / 1000) × 190500 = 1714.4999… → 1 714.
    expect(Math.round((9 / 1000) * 190_500)).toBe(1714);
    expect(valueOfWeight(9, 190_500)).toBe(1715);
    expect(valueOfWeight(1, 500)).toBe(1);
    expect(valueOfWeight(-1, 500)).toBe(-1);
  });

  it('weighted price per gram lies between the lowest and highest price and is exact', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ weightMg: fc.integer({ min: 1, max: 5_000_000 }), pricePerGram }), { minLength: 1, maxLength: 20 }), (lines) => {
        const r = weightedPricePerGram(lines);
        const num = lines.reduce((s, l) => s + BigInt(l.weightMg) * BigInt(l.pricePerGram), 0n);
        const d = lines.reduce((s, l) => s + BigInt(l.weightMg), 0n);
        const lo = Math.min(...lines.map((l) => l.pricePerGram));
        const hi = Math.max(...lines.map((l) => l.pricePerGram));
        return r >= lo && r <= hi && isCorrectRounding(num, d, BigInt(r));
      }),
      RUNS,
    );
    expect(weightedPricePerGram([])).toBe(0);
  });
});

describe('Hasad settlement (L-7)', () => {
  const items = fc.array(fc.record({ netWeightMg: fc.integer({ min: 0, max: 200_000 }), karat }), { maxLength: 8 });
  const basis = fc.constantFrom('NET_WEIGHT' as const, 'PURE_GOLD_EQUIVALENT' as const);

  it('amount is the exact integer value of |difference|, direction follows the sign', () => {
    fc.assert(
      fc.property(weightMg, karat, items, pricePerGram, basis, (entitled, k, its, rate, b) => {
        const s = calculateSettlement({ entitledWeightMg: entitled, entitlementKarat: k, items: its, ratePerGram: rate, basis: b });
        const expectedDirection = s.differenceMg < 0 ? 'BRANCH_PAYS_CUSTOMER' : s.differenceMg > 0 ? 'CUSTOMER_PAYS_BRANCH' : 'NONE';
        return (
          Number.isSafeInteger(s.amount) &&
          s.amount >= 0 &&
          s.direction === expectedDirection &&
          s.absDifferenceMg === Math.abs(s.differenceMg) &&
          s.differenceMg === s.deliveredWeightMg - s.entitledWeightMg &&
          isCorrectRounding(BigInt(s.absDifferenceMg) * BigInt(rate), 1000n, BigInt(s.amount))
        );
      }),
      RUNS,
    );
  });

  it('is symmetric: swapping entitled and delivered swaps who pays, never the amount', () => {
    fc.assert(
      fc.property(weightMg, weightMg, pricePerGram, (a, b, rate) => {
        const x = calculateSettlement({ entitledWeightMg: a, entitlementKarat: 21, items: [{ netWeightMg: b, karat: 21 }], ratePerGram: rate, basis: 'NET_WEIGHT' });
        const y = calculateSettlement({ entitledWeightMg: b, entitlementKarat: 21, items: [{ netWeightMg: a, karat: 21 }], ratePerGram: rate, basis: 'NET_WEIGHT' });
        const flipped = { BRANCH_PAYS_CUSTOMER: 'CUSTOMER_PAYS_BRANCH', CUSTOMER_PAYS_BRANCH: 'BRANCH_PAYS_CUSTOMER', NONE: 'NONE' } as const;
        return x.amount === y.amount && y.direction === flipped[x.direction];
      }),
      RUNS,
    );
  });

  it('matches known values', () => {
    const s = calculateSettlement({ entitledWeightMg: 10_000, entitlementKarat: 21, items: [{ netWeightMg: 9_873, karat: 21 }], ratePerGram: 190_500, basis: 'NET_WEIGHT' });
    expect(s).toMatchObject({ direction: 'BRANCH_PAYS_CUSTOMER', absDifferenceMg: 127, amount: 24_194 }); // 127 × 190.5 = 24 193.5 → 24 194
  });
});

describe('money rounding and ledger arithmetic (Phase 2b, Q1)', () => {
  it('roundMoney: whole SDG, half away from zero, symmetric, never off by more than ½', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), fc.integer({ min: 0, max: 999 }), (whole, milli) => {
        const text = `${whole < 0 ? '-' : ''}${Math.abs(whole)}.${String(milli).padStart(3, '0')}`;
        const x = Number(text);
        const r = roundMoney(x);
        const exact = BigInt(Math.abs(whole)) * 1000n + BigInt(milli);
        const expected = (exact + 500n) / 1000n; // half up on the magnitude
        return Number.isSafeInteger(r) && BigInt(Math.abs(r)) === expected && roundMoney(-x) === -r + 0;
      }),
      RUNS,
    );
    expect(roundMoney(2.5)).toBe(3);
    expect(roundMoney(-2.5)).toBe(-3);
    expect(roundMoney(1.005)).toBe(1);
    expect(roundMoney(2.675)).toBe(3);
    expect(roundMoney(1_500_000)).toBe(1_500_000);
    expect(() => roundMoney(Number.NaN)).toThrow(RangeError);
  });

  it('profit per line = final price − acquisition cost, exactly, and sums without drift', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ listPrice: fc.integer({ min: 0, max: 50_000_000 }), discountPct: fc.integer({ min: 0, max: 20 }), acquisition: fc.integer({ min: 0, max: 50_000_000 }) }), { maxLength: 30 }),
        (lines) => {
          let total = 0n;
          let profit = 0n;
          for (const l of lines) {
            const discount = roundMoney((l.listPrice * l.discountPct) / 100);
            const final = l.listPrice - discount;
            total += BigInt(final);
            profit += BigInt(final - l.acquisition);
          }
          const cost = lines.reduce((s, l) => s + BigInt(l.acquisition), 0n);
          return total - cost === profit;
        },
      ),
      RUNS,
    );
  });

  it('a set of sales and voids nets to the sum of the sales that were not voided, per account', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ amount: fc.integer({ min: 1, max: 100_000_000 }), method: fc.constantFrom(...PAYMENT_METHODS), voided: fc.boolean() }), { maxLength: 60 }),
        (events) => {
          const entries: { kind: string; amount: number }[] = [];
          for (const e of events) {
            entries.push({ kind: PAYMENT_ACCOUNT[e.method], amount: e.amount });
            if (e.voided) entries.push({ kind: PAYMENT_ACCOUNT[e.method], amount: -e.amount });
          }
          for (const kind of ['CASH', 'BANK']) {
            const bal = entries.filter((x) => x.kind === kind).reduce((s, x) => s + x.amount, 0);
            const kept = events.filter((e) => !e.voided && PAYMENT_ACCOUNT[e.method] === kind).reduce((s, e) => s + e.amount, 0);
            if (bal !== kept) return false;
          }
          return true;
        },
      ),
      RUNS,
    );
  });
});
