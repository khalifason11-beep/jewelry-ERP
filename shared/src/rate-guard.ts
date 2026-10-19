// DEC-1 (RAT-1, D-dec1-11): how far a gold or scrap rate may move in one edit.
//
//   * change ≤ warn %            → allowed;
//   * warn % < change ≤ confirm % → a written reason is required;
//   * change > confirm %          → a reason AND the password, given again in the request;
//   * no previous rate             → the first rate of a karat is not checked.
//
// Exact integer arithmetic (BigInt): |new − old| × 100 is compared with pct × old, so 10 % is exactly 10 %, never
// 9.9999 or 10.0001. The percentage shown and audited is in basis points (1 % = 100), rounded half away from zero.

import { roundDivBig } from './money';

export type RateChangeLevel = 'FIRST' | 'NONE' | 'REASON' | 'CONFIRM';

/** SEC-2 rule for a written reason (the same bounds as a price-change reason). */
export const CHANGE_REASON_MIN = 3;
export const CHANGE_REASON_MAX = 200;

export function rateChangeLevel(from: number | null, to: number, warnPct: number, confirmPct: number): RateChangeLevel {
  if (from == null || from <= 0) return 'FIRST';
  const delta = BigInt(Math.abs(to - from)) * 100n;
  const base = BigInt(from);
  if (delta <= BigInt(warnPct) * base) return 'NONE';
  if (delta <= BigInt(confirmPct) * base) return 'REASON';
  return 'CONFIRM';
}

/** Signed change in basis points (+1250 = +12.50 %), or null when there is no previous rate. */
export function rateChangeBp(from: number | null, to: number): number | null {
  if (from == null || from <= 0) return null;
  return Number(roundDivBig(BigInt(to - from) * 10_000n, BigInt(from)));
}

/** "+12.50" / "−3.75" from basis points (display only; the decision never uses it). */
export function formatChangeBp(bp: number): string {
  const sign = bp > 0 ? '+' : bp < 0 ? '−' : '';
  const abs = Math.abs(bp);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The strictest level among several changes (a request is refused or accepted as a whole). */
export function strictestLevel(levels: RateChangeLevel[]): RateChangeLevel {
  for (const l of ['CONFIRM', 'REASON', 'NONE'] as const) if (levels.includes(l)) return l;
  return 'FIRST';
}

/**
 * MIS-1 (D-mis1-2): the reason of a void or a correction, trimmed, when it is 3–200 characters long (counted as the
 * database counts them, in code points); otherwise null. The screens and the server use the same rule.
 */
export function correctionReason(raw: string | null | undefined): string | null {
  const r = (raw ?? '').trim();
  const n = [...r].length;
  return n >= CHANGE_REASON_MIN && n <= CHANGE_REASON_MAX ? r : null;
}
