// Units: weights are stored as integer milligrams, money as integer SDG.
// Using integers avoids floating-point drift in settlement and ledger arithmetic.

export const MG_PER_GRAM = 1000;

export function gramsToMg(grams: number): number {
  return Math.round(grams * MG_PER_GRAM);
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
  return Math.round((netMg * karat) / 24);
}
