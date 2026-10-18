// DEC-1 (RAT-1, D-dec1-11, D-dec1-13): the edit guard of the gold and scrap rates.
//
//   * a request may carry `reason` (SEC-2 rule: 3–200 characters) and `confirmPassword`;
//   * the password, when given, is checked BEFORE the rate transaction, by the same function as POST /auth/reauth
//     (a wrong one counts towards the lockout and answers 403 REAUTH_FAILED);
//   * inside the transaction, after the lock that serialises rate edits, every real change is compared with the
//     CURRENT previous value of the same rate (never a value read before the lock), and the whole request is refused
//     when one change needs more than it carries: 403 RATE_CHANGE_CONFIRM_REQUIRED (no password above confirm %),
//     422 RATE_CHANGE_REASON_REQUIRED (no reason above warn %).

import { CHANGE_REASON_MIN, formatChangeBp, rateChangeBp, rateChangeLevel, strictestLevel, type RateChangeLevel, type SystemSettings } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { reauthenticate } from '../auth/service';

export interface RateGuardInput {
  reason?: string;
  confirmPassword?: string;
}

export interface RateChange {
  karat: number;
  /** NEW / USED (selling rates) or SCRAP (scrap buying rate). */
  kind: string;
  from: number | null;
  to: number;
}

export interface CheckedRateChange extends RateChange {
  level: RateChangeLevel;
  /** Signed basis points (+1000 = +10.00 %), null for a first rate. */
  changeBp: number | null;
}

/** The password given with the request, checked like a re-confirmation (before the rate transaction). */
export async function confirmPasswordIfGiven(ctx: Ctx, actor: Actor, input: RateGuardInput): Promise<boolean> {
  if (!input.confirmPassword) return false;
  await reauthenticate(ctx, actor, input.confirmPassword);
  return true;
}

/** Classify every change; refuse the whole request when one of them needs a reason or the password it lacks. */
export function checkRateChanges(rates: SystemSettings['rates'], changes: RateChange[], input: RateGuardInput, confirmed: boolean): CheckedRateChange[] {
  const checked = changes.map((c) => ({ ...c, level: rateChangeLevel(c.from, c.to, rates.warnChangePercent, rates.confirmChangePercent), changeBp: rateChangeBp(c.from, c.to) }));
  const top = strictestLevel(checked.map((c) => c.level));
  const details = {
    warnChangePercent: rates.warnChangePercent,
    confirmChangePercent: rates.confirmChangePercent,
    changes: checked.map((c) => ({ karat: c.karat, kind: c.kind, from: c.from, to: c.to, changeBp: c.changeBp, level: c.level })),
  };
  if (top === 'CONFIRM' && !confirmed) {
    throw new AppError(403, 'RATE_CHANGE_CONFIRM_REQUIRED', 'A rate change of more than {pct}% needs a reason and your password', { pct: rates.confirmChangePercent }, details);
  }
  if ((top === 'REASON' || top === 'CONFIRM') && (input.reason ?? '').trim().length < CHANGE_REASON_MIN) {
    throw new AppError(422, 'RATE_CHANGE_REASON_REQUIRED', 'A rate change of more than {pct}% needs a reason', { pct: rates.warnChangePercent }, details);
  }
  return checked;
}

/** Audit additions of one checked change: the percentage always, the reason when one was needed. */
export function guardAudit(c: CheckedRateChange, input: RateGuardInput) {
  const guarded = c.level === 'REASON' || c.level === 'CONFIRM';
  return {
    guarded,
    change: c.changeBp == null ? '' : formatChangeBp(c.changeBp),
    reason: guarded ? (input.reason ?? '').trim() : '',
    metadata: { changeBp: c.changeBp, guard: c.level, ...(guarded ? { reason: (input.reason ?? '').trim() } : {}) },
  };
}
