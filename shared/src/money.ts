// Exact integer arithmetic for money (integer SDG) and weights (integer milligrams).
//
// Rules (docs/decisions.md D-2a-5):
//   * inputs and outputs are safe integers; anything else is a programming error (RangeError)
//   * intermediate products are computed with BigInt, so there is no floating-point drift and no
//     overflow even when mg × price-per-gram exceeds 2^53
//   * rounding is half AWAY FROM ZERO, so it is symmetric: round(−x) = −round(x)
//     (Math.round is not: Math.round(−2.5) = −2 but Math.round(2.5) = 3)

function big(n: number, name: string): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name} must be a safe integer, got ${n}`);
  return BigInt(n);
}

function toSafeNumber(b: bigint): number {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new RangeError(`result ${b} is outside the safe integer range`);
  return n;
}

/** num / den rounded half away from zero (BigInt in, BigInt out). */
export function roundDivBig(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError('division by zero');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = (abs * 2n + den) / (2n * den);
  return negative ? -q : q;
}

/** round(num / den), half away from zero. */
export function divRound(num: number, den: number): number {
  return toSafeNumber(roundDivBig(big(num, 'num'), big(den, 'den')));
}

/** round(a × b / den), half away from zero, with an exact intermediate product. */
export function mulDivRound(a: number, b: number, den: number): number {
  return toSafeNumber(roundDivBig(big(a, 'a') * big(b, 'b'), big(den, 'den')));
}

/** Value of `weightMg` at `pricePerGram` (integer SDG): round(mg × price / 1000). */
export function valueOfWeight(weightMg: number, pricePerGram: number): number {
  return mulDivRound(weightMg, pricePerGram, 1000);
}

/** Weight-averaged price per gram: round(Σ(price × mg) / Σ mg). 0 when there is no weight. */
export function weightedPricePerGram(lines: { weightMg: number; pricePerGram: number }[]): number {
  let num = 0n;
  let den = 0n;
  for (const l of lines) {
    num += big(l.weightMg, 'weightMg') * big(l.pricePerGram, 'pricePerGram');
    den += big(l.weightMg, 'weightMg');
  }
  return den === 0n ? 0 : toSafeNumber(roundDivBig(num, den));
}

/** Sum of safe integers; throws instead of silently losing precision. */
export function sumInt(values: number[]): number {
  let s = 0n;
  for (const v of values) s += big(v, 'value');
  return toSafeNumber(s);
}

/**
 * Parse a decimal string (e.g. "4.2005", "-0.5") into an integer scaled by 10^scale, rounding the
 * extra digits half away from zero. No floating point is involved.
 */
export function parseScaled(text: string, scale: number): number {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`not a decimal number: "${text}"`);
  const negative = m[1] === '-';
  const whole = m[2] || '0';
  const frac = m[3] ?? '';
  const kept = (frac + '0'.repeat(scale)).slice(0, scale);
  const rest = frac.slice(scale);
  let v = BigInt(whole + kept);
  if (rest && rest[0] >= '5') v += 1n; // half away from zero on the magnitude
  return toSafeNumber(negative ? -v : v);
}

/**
 * Q1: the ONE rounding entry point for money typed or computed as a decimal: whole SDG, half away
 * from zero (−2.5 → −3). Works on the decimal text of the number, so 1.005 or 2.675 never fall on the
 * wrong side because of their binary representation.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite amount: ${value}`);
  if (Number.isSafeInteger(value)) return value;
  const text = /e/i.test(String(value)) ? value.toFixed(20) : String(value);
  return parseScaled(text, 0);
}
