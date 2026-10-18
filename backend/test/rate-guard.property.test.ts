// DEC-1 (RAT-1, D-dec1-11): property tests of the rate edit guard (shared/src/rate-guard.ts), against an independent
// formulation: the largest allowed move is floor(pct × old / 100) whole units, in either direction.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { rateChangeBp, rateChangeLevel } from '@jerp/shared';

const RUNS = { numRuns: 2_000 };
const MAX_RATE = 100_000_000; // the API's cap per gram
const rate = fc.integer({ min: 1, max: MAX_RATE });
const thresholds = fc.integer({ min: 1, max: 99 }).chain((warn) => fc.integer({ min: warn + 1, max: 100 }).map((confirm) => ({ warn, confirm })));

const allowedMove = (old: number, pct: number) => (BigInt(old) * BigInt(pct)) / 100n; // floor

function reference(old: number, next: number, warn: number, confirm: number) {
  const move = BigInt(Math.abs(next - old));
  if (move <= allowedMove(old, warn)) return 'NONE';
  if (move <= allowedMove(old, confirm)) return 'REASON';
  return 'CONFIRM';
}

describe('rate edit guard (exact integers)', () => {
  it('the level equals the floor(pct × old / 100) reference, for any rates and thresholds', () => {
    fc.assert(
      fc.property(rate, rate, thresholds, (old, next, { warn, confirm }) => {
        expect(rateChangeLevel(old, next, warn, confirm)).toBe(reference(old, next, warn, confirm));
      }),
      RUNS,
    );
  });

  it('exactly at the boundary passes; one unit beyond does not (up and down)', () => {
    fc.assert(
      fc.property(rate, thresholds, (old, { warn, confirm }) => {
        const w = Number(allowedMove(old, warn));
        const c = Number(allowedMove(old, confirm));
        expect(rateChangeLevel(old, old + w, warn, confirm)).toBe('NONE');
        if (old - w >= 1) expect(rateChangeLevel(old, old - w, warn, confirm)).toBe('NONE');
        if (c > w) expect(rateChangeLevel(old, old + w + 1, warn, confirm)).toBe('REASON');
        expect(rateChangeLevel(old, old + c, warn, confirm)).toBe(c > w ? 'REASON' : 'NONE');
        expect(rateChangeLevel(old, old + c + 1, warn, confirm)).toBe('CONFIRM');
      }),
      RUNS,
    );
  });

  it('monotonic: a bigger move is never a weaker level; the first rate is never checked', () => {
    const order = { NONE: 0, REASON: 1, CONFIRM: 2 } as const;
    fc.assert(
      fc.property(rate, fc.integer({ min: 0, max: MAX_RATE }), fc.integer({ min: 0, max: MAX_RATE }), thresholds, (old, a, b, { warn, confirm }) => {
        const [small, big] = a <= b ? [a, b] : [b, a];
        const l1 = rateChangeLevel(old, old + small, warn, confirm) as keyof typeof order;
        const l2 = rateChangeLevel(old, old + big, warn, confirm) as keyof typeof order;
        expect(order[l1]).toBeLessThanOrEqual(order[l2]);
        expect(rateChangeLevel(null, old, warn, confirm)).toBe('FIRST');
      }),
      RUNS,
    );
  });

  it('basis points are the signed change rounded half away from zero', () => {
    fc.assert(
      fc.property(rate, rate, (old, next) => {
        const exact = ((BigInt(next - old) * 10_000n * 2n) + (next >= old ? BigInt(old) : -BigInt(old))) / (2n * BigInt(old));
        expect(BigInt(rateChangeBp(old, next)!)).toBe(exact);
      }),
      RUNS,
    );
  });
});
