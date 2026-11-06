// WSL-1 (D-wsl1-2): grains (حبات) of broken scrap sold at the POS. The owner's unit: 1 grain = 0.1 g = 100 mg; the
// quantity is a whole number of grains. A line is priced at the karat's selling rate on its WHOLE weight, rounded once
// (valueOfWeight), never per grain. Property-tested in backend/test/grains.property.test.ts.

import { valueOfWeight } from './money';

export const MG_PER_GRAIN = 100;

/** The weight of `grains` grains in mg (grains a whole number > 0). */
export function grainsToMg(grains: number): number {
  if (!Number.isSafeInteger(grains) || grains <= 0 || grains > Math.floor(Number.MAX_SAFE_INTEGER / MG_PER_GRAIN)) {
    throw new RangeError(`grains must be a whole number above 0, got ${grains}`);
  }
  return grains * MG_PER_GRAIN;
}

/** The price of a grain line: the rate per gram × its whole weight, rounded once (half up, exact). */
export function grainLinePrice(grains: number, ratePerGram: number): number {
  return valueOfWeight(grainsToMg(grains), ratePerGram);
}

/** How many whole grains a pool balance holds (a balance below one grain holds none). */
export function grainsIn(weightMg: number): number {
  return weightMg > 0 ? Math.floor(weightMg / MG_PER_GRAIN) : 0;
}
