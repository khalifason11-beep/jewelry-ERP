// PRC-1 (docs/plans/PRC-1.md, D-prc1-1…): computed selling prices. Exact integer arithmetic through money.ts only.
//
//   price of a piece = round(net mg × rate per gram / (1000 × step)) × step
//
// one rounding, half away from zero, after the exact (BigInt) product; step = `pricing.roundingStep` (whole units,
// provisional until Q-2). The rate is the current selling rate of the piece's karat and kind: NEW for supplier and
// opening pieces, USED for sellable scrap. No making charge (Q-1 open): the sale line keeps price_making_charge NULL.
// A missing rate (none, or ≤ 0) means NO price, never 0.

import type { GoldRateKind, ItemOrigin } from './enums';
import { mulDivRound, sumInt } from './money';

/** The selling rate that prices a piece of this origin. */
export function rateKindFor(origin: ItemOrigin | string): GoldRateKind {
  return origin === 'SCRAP' ? 'USED' : 'NEW';
}

/** The gold value of a piece: round(mg × rate / 1000), whole units (the sale line's price_gold_value). */
export function goldValue(netWeightMg: number, ratePerGram: number): number {
  return mulDivRound(netWeightMg, ratePerGram, 1000);
}

/** The computed price, or null when there is no usable rate. */
export function computedPrice(netWeightMg: number, ratePerGram: number | null | undefined, roundingStep = 1): number | null {
  if (ratePerGram == null || ratePerGram <= 0) return null;
  if (!Number.isSafeInteger(roundingStep) || roundingStep < 1) throw new RangeError(`rounding step must be a positive integer, got ${roundingStep}`);
  return mulDivRound(netWeightMg, ratePerGram, 1000 * roundingStep) * roundingStep;
}

/** The invoice subtotal of computed lines: their exact sum (no rounding of the sum). */
export function subtotalOf(prices: number[]): number {
  return sumInt(prices);
}
