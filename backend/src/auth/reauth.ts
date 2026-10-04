// Step-up authentication for sensitive actions (security item 3, docs/decisions.md D-1a-8, D-2fa-7).
// The user re-enters their password (POST /auth/reauth); a user who has a passkey ALSO confirms with
// it (POST /auth/reauth/passkey/verify). For the next `security.reauthWindowMinutes` (GM setting,
// default 5, 1–30) the session may perform re-auth-protected actions, so changing three rates in a
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

export const reauthRequired = (needs: FreshFactors) =>
  new AppError(403, 'REAUTH_REQUIRED', needs.hasPasskey ? 'Please confirm your password and your passkey to continue' : 'Please confirm your password to continue', undefined, {
    password: !needs.password,
    passkey: needs.hasPasskey && !needs.passkey,
  });

export async function freshFactors(ctx: Ctx, exec: Executor, sessionId: string | null | undefined, userId: number): Promise<FreshFactors> {
  const { security } = await ctx.settings.get();
  const windowMs = security.reauthWindowMinutes * 60_000;
  const [s] = sessionId
    ? await exec.select({ reauthAt: t.sessions.reauthAt, pkAt: t.sessions.passkeyReauthAt, pkUv: t.sessions.passkeyReauthUv }).from(t.sessions).where(eq(t.sessions.id, sessionId))
    : [];
  const recent = (d: Date | null | undefined) => !!d && Date.now() - d.getTime() <= windowMs;
  const hasPasskey = (await activeCredentialCount(exec, userId)) > 0;
  return { password: recent(s?.reauthAt), hasPasskey, passkey: recent(s?.pkAt), passkeyUv: recent(s?.pkAt) && !!s?.pkUv };
}

export async function requireRecentReauth(ctx: Ctx, req: Request): Promise<FreshFactors> {
  const actor = req.actor;
  if (!actor?.sessionId) throw reauthRequired({ password: false, hasPasskey: false, passkey: false, passkeyUv: false });
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  if (!f.password || (f.hasPasskey && !f.passkey)) throw reauthRequired(f);
  return f;
}
