// Units: weights are stored as integer milligrams, money as integer SDG.
// Using integers avoids floating-point drift in settlement and ledger arithmetic.

import { mulDivRound, parseScaled } from './money';

export const MG_PER_GRAM = 1000;

/** Grams (as typed, e.g. "4.205" or 4.205) to integer mg, rounded half away from zero, no float math. */
export function gramsToMg(grams: number | string): number {
  if (typeof grams === 'number') {
    if (!Number.isFinite(grams)) throw new RangeError(`not a finite number: ${grams}`);
    // String(n) is the shortest decimal that round-trips; exponent forms are expanded first.
    const text = /e/i.test(String(grams)) ? grams.toFixed(20) : String(grams);
    return parseScaled(text, 3);
  }
  return parseScaled(grams, 3);
}

export function mgToGrams(mg: number): number {
  return mg / MG_PER_GRAM;
}

/** "4.200 g" style formatting (always 3 decimals, the jewellery-trade convention). */
export function formatWeight(mg: number, withUnit = true): string {
  const s = (mg / MG_PER_GRAM).toFixed(3);
  return withUnit ? `${s} g` : s;
}

export function formatMoney(amount: number, currency = 'SDG', locale = 'en-US'): string {
  const s = Math.round(amount).toLocaleString(locale);
  return currency ? `${s} ${currency}` : s;
}

/** Pure-gold equivalent in mg for a karat (24K = 100%). */
export function pureGoldMg(netMg: number, karat: number): number {
  return mulDivRound(netMg, karat, 24);
}
