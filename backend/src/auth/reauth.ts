// Step-up authentication for sensitive actions (security item 3, docs/decisions.md D-1a-8, D-2fa-7).
// The user re-enters their password (POST /auth/reauth); a user who has a passkey ALSO confirms with
// it (POST /auth/reauth/passkey/verify). For the next `security.reauthWindowMinutes` (GM setting,
// default 15 since UX-3, 1–30) the session may perform every re-auth-protected action, so changing three rates in a
// row asks once. Enforced at the route layer because services are also called by trusted code
// (seed, CLI) that has no session.

import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { t, type Executor } from '@jerp/database';
import type { Ctx } from '../core/context';
import { AppError } from '../core/errors';
import { activeCredentialCount } from './second-factor';

export interface FreshFactors {
  password: boolean;
  /** The user has at least one active passkey (then the passkey step-up is required too). */
  hasPasskey: boolean;
  passkey: boolean;
  /** The confirming passkey assertion proved user verification (fingerprint, face, PIN). */
  passkeyUv: boolean;
}

/**
 * UX-3: the window, as a pure function of the clock passed in (tests fix `now`; nothing here reads the wall clock).
 * A confirmation made at `at` is fresh until `at + windowMinutes`, that instant included.
 */
export function windowUntil(at: Date | null | undefined, windowMinutes: number): Date | null {
  return at ? new Date(at.getTime() + windowMinutes * 60_000) : null;
}
export function isFresh(at: Date | null | undefined, windowMinutes: number, now: Date): boolean {
  const until = windowUntil(at, windowMinutes);
  return !!until && now.getTime() <= until.getTime();
}

export const reauthRequired = (needs: FreshFactors) =>
  new AppError(403, 'REAUTH_REQUIRED', needs.hasPasskey ? 'Please confirm your password and your passkey to continue' : 'Please confirm your password to continue', undefined, {
    password: !needs.password,
    passkey: needs.hasPasskey && !needs.passkey,
  });

export async function freshFactors(ctx: Ctx, exec: Executor, sessionId: string | null | undefined, userId: number, now = new Date()): Promise<FreshFactors> {
  return (await reauthState(ctx, exec, sessionId, userId, now)).factors;
}

/** The session's window: which factors are fresh at `now`, and until when (`GET /auth/reauth`, the guard, the services). */
export async function reauthState(ctx: Ctx, exec: Executor, sessionId: string | null | undefined, userId: number, now = new Date()) {
  const { security } = await ctx.settings.get();
  const minutes = security.reauthWindowMinutes;
  const [s] = sessionId
    ? await exec.select({ reauthAt: t.sessions.reauthAt, pkAt: t.sessions.passkeyReauthAt, pkUv: t.sessions.passkeyReauthUv }).from(t.sessions).where(eq(t.sessions.id, sessionId))
    : [];
  const hasPasskey = (await activeCredentialCount(exec, userId)) > 0;
  const passkey = isFresh(s?.pkAt, minutes, now);
  const factors: FreshFactors = { password: isFresh(s?.reauthAt, minutes, now), hasPasskey, passkey, passkeyUv: passkey && !!s?.pkUv };
  return { factors, windowMinutes: minutes, passwordUntil: windowUntil(s?.reauthAt, minutes), passkeyUntil: windowUntil(s?.pkAt, minutes) };
}

export async function requireRecentReauth(ctx: Ctx, req: Request): Promise<FreshFactors> {
  const actor = req.actor;
  if (!actor?.sessionId) throw reauthRequired({ password: false, hasPasskey: false, passkey: false, passkeyUv: false });
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  if (!f.password || (f.hasPasskey && !f.passkey)) throw reauthRequired(f);
  return f;
}
