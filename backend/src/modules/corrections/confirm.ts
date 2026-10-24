// MIS-1 (D-mis1-2): what every mistake correction of the General Manager asks for again.
//
//   * a written reason, 3–200 characters after trimming (the SEC-2 bounds); missing or out of bounds → 422
//     CORRECTION_REASON_REQUIRED;
//   * the password in the request, checked by the same `reauthenticate` as POST /auth/reauth (a wrong one counts towards
//     the lockout, is audited, and answers 403 REAUTH_FAILED); missing → 403 CONFIRM_PASSWORD_REQUIRED.
//
// Both are checked before the business transaction (as the DEC-1 rate guard); the reason is checked first, so a request
// refused for its reason never spends a password attempt.

import { CHANGE_REASON_MAX, CHANGE_REASON_MIN, correctionReason } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { reauthenticate } from '../auth/service';

export interface ConfirmationInput {
  reason?: string;
  confirmPassword?: string;
}

/** The trimmed reason and a checked password, or the refusal. */
export async function requireConfirmation(ctx: Ctx, actor: Actor, input: ConfirmationInput): Promise<string> {
  const reason = correctionReason(input.reason);
  if (reason == null) {
    throw new AppError(422, 'CORRECTION_REASON_REQUIRED', 'Write a reason of {min} to {max} characters', { min: CHANGE_REASON_MIN, max: CHANGE_REASON_MAX });
  }
  if (!input.confirmPassword) throw new AppError(403, 'CONFIRM_PASSWORD_REQUIRED', 'Enter your password to confirm');
  await reauthenticate(ctx, actor, input.confirmPassword);
  return reason;
}
