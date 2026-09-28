// Step-up authentication for sensitive actions (security item 3, docs/decisions.md D-1a-8).
// The user re-enters their password (POST /auth/reauth); for the next REAUTH_WINDOW_MINUTES the
// session may perform re-auth-protected actions. Enforced at the route layer because services are
// also called by trusted code (seed, CLI) that has no session.

import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { t } from '@jerp/database';
import type { Ctx } from '../core/context';
import { AppError } from '../core/errors';

export const REAUTH_WINDOW_MINUTES = 5;

export const reauthRequired = () => new AppError(403, 'REAUTH_REQUIRED', 'Please confirm your password to continue');

export async function requireRecentReauth(ctx: Ctx, req: Request): Promise<void> {
  const sessionId = req.actor?.sessionId;
  if (!sessionId) throw reauthRequired();
  const [s] = await ctx.db.select({ reauthAt: t.sessions.reauthAt }).from(t.sessions).where(eq(t.sessions.id, sessionId));
  if (!s?.reauthAt || Date.now() - s.reauthAt.getTime() > REAUTH_WINDOW_MINUTES * 60_000) throw reauthRequired();
}
