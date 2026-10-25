// PRC-1 (D-prc1-1): property tests of the computed price (shared/src/pricing.ts). Exact rational reference with
// BigInt, independent of the implementation.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computedPrice, goldValue, rateKindFor, subtotalOf } from '@jerp/shared';

const RUNS = { numRuns: 2_000 };
/** The server's caps: a piece ≤ 10 kg, a rate ≤ 100,000,000 per gram (D-ux1-3). */
const MAX_WEIGHT_MG = 10_000_000;
const MAX_RATE = 100_000_000;
const weight = fc.integer({ min: 1, max: MAX_WEIGHT_MG });
const rate = fc.integer({ min: 1, max: MAX_RATE });
const step = fc.constantFrom(1, 5, 10, 50, 100, 500, 1_000, 5_000, 1_000_000);

/** round(mg × rate / (1000 × step)) × step, half away from zero, on exact integers. */
function reference(mg: number, r: number, s: number): bigint {
  const num = BigInt(mg) * BigInt(r);
  const den = 1000n * BigInt(s);
  return ((num * 2n + den) / (2n * den)) * BigInt(s);
}

describe('computed price', () => {
  it('equals the exact reference: one rounding, half away from zero, after the multiplication', () => {
    fc.assert(
      fc.property(weight, rate, step, (mg, r, s) => {
        expect(BigInt(computedPrice(mg, r, s)!)).toBe(reference(mg, r, s));
      }),
      RUNS,
    );
  });

  it('is rounded once: never the step-rounding of an already rounded gold value', () => {
    // 999 mg at 500/g = 499.5 exactly. Rounded once at a step of 1,000: 0. Rounding to the unit first (500) and then
    // to the step would give 1,000: the price must never be rounded twice.
    expect(goldValue(999, 500)).toBe(500); // 999 mg × 500 = 499.5
    expect(computedPrice(999, 500, 1_000)).toBe(0);
    fc.assert(
      fc.property(weight, rate, step, (mg, r, s) => {
        const p = computedPrice(mg, r, s)!;
        expect(p % s).toBe(0);
        // Within half a step of the exact value.
        expect(Math.abs(p * 1000 - mg * r) <= (s * 1000) / 2).toBe(true);
      }),
      RUNS,
    );
  });

  it('is monotonic in weight and in rate', () => {
    fc.assert(
      fc.property(weight, weight, rate, rate, step, (a, b, r1, r2, s) => {
        const [w1, w2] = a <= b ? [a, b] : [b, a];
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1];
        expect(computedPrice(w1, lo, s)!).toBeLessThanOrEqual(computedPrice(w2, lo, s)!);
        expect(computedPrice(w1, lo, s)!).toBeLessThanOrEqual(computedPrice(w1, hi, s)!);
      }),
      RUNS,
    );
  });

  it('does not overflow at the largest weight and rate', () => {
    const p = computedPrice(MAX_WEIGHT_MG, MAX_RATE, 1)!;
    expect(p).toBe(1_000_000_000_000);
    expect(Number.isSafeInteger(p)).toBe(true);
    expect(goldValue(MAX_WEIGHT_MG, MAX_RATE)).toBe(1_000_000_000_000);
  });

  it('the invoice subtotal is the exact sum of the line prices', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(weight, rate), { minLength: 1, maxLength: 50 }), step, (lines, s) => {
        const prices = lines.map(([mg, r]) => computedPrice(mg, r, s)!);
        expect(BigInt(subtotalOf(prices))).toBe(lines.reduce((acc, [mg, r]) => acc + reference(mg, r, s), 0n));
      }),
      { numRuns: 500 },
    );
  });

  it('a missing rate gives no price, never 0; the step must be a positive integer', () => {
    expect(computedPrice(5_000, null)).toBeNull();
    expect(computedPrice(5_000, undefined)).toBeNull();
    expect(computedPrice(5_000, 0)).toBeNull();
    expect(computedPrice(5_000, -1)).toBeNull();
    expect(() => computedPrice(5_000, 100, 0)).toThrow(RangeError);
    expect(() => computedPrice(5_000, 100, 1.5)).toThrow(RangeError);
  });

  it("the owner's example: 1 g at 100 on Sunday is 100; at 110 on Monday it is 110", () => {
    expect(computedPrice(1_000, 100)).toBe(100);
    expect(computedPrice(1_000, 110)).toBe(110);
  });

  it('new and used pieces are priced by their own rate', () => {
    expect(rateKindFor('SUPPLIER_NEW')).toBe('NEW');
    // OPN-2: an opening piece is not decided by its origin; it takes its line's condition (opn2 tests).
    expect(rateKindFor('SCRAP')).toBe('USED');
  });
});
