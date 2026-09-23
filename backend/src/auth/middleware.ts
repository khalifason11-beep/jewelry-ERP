import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import type { Ctx } from '../core/context';
import { AppError, unauthorized } from '../core/errors';
import { resolveSession, touchSession } from '../modules/sessions/service';
import { t } from '@jerp/database';
import { eq } from 'drizzle-orm';

export function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return ip.replace(/^::ffff:/, '') || 'unknown';
}

/** Attach the authenticated actor (if any) and record session activity. */
export function authenticate(ctx: Ctx) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[config.cookieName];
    if (!token) return next();
    const resolved = await resolveSession(ctx, token);
    if (!resolved) return next();
    resolved.actor.ip = clientIp(req);
    req.actor = resolved.actor;
    req.sessionId = resolved.session.id;
    const module = req.header('x-client-module') ?? undefined;
    await touchSession(ctx, resolved.session, module);
    const [u] = await ctx.db.select({ m: t.users.mustChangePassword }).from(t.users).where(eq(t.users.id, resolved.actor.userId));
    req.mustChangePassword = !!u?.m;
    next();
  };
}

/** Require an authenticated user. Users with a forced password change may only reach /auth. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.actor) return next(unauthorized());
  if (req.mustChangePassword && !req.originalUrl.startsWith('/api/auth/')) {
    return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must set a new password before continuing'));
  }
  next();
}
