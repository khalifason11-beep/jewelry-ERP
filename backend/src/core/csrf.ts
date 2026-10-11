// CSRF protection for cookie-authenticated mutations (security item 8, docs/decisions.md D-1a-7).
//   1. Origin check: unsafe requests carrying an Origin (or Referer) from another origin are refused.
//   2. Synchronizer token: authenticated unsafe requests must echo the session's CSRF token in the
//      `x-csrf-token` header. The token is only readable through same-origin API responses.
//      The sign-in steps (route-matrix scope `public`) are the exception (CLN-3): they authenticate fresh credentials
//      and never act on the session a leftover cookie points to (a successful sign-in ends it), so a browser that
//      still holds a valid cookie but lost the token can sign in again. They keep check 1, exactly like a sign-in
//      without a cookie; production requires APP_ORIGIN, so login CSRF stays covered there.

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config';
import type { Ctx } from './context';
import { AppError } from './errors';
import { csrfTokenFor } from '../modules/sessions/service';
import { ROUTE_MATRIX } from '@jerp/shared';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Unsafe sign-in steps (paths relative to /api), from the route matrix: no token, Origin check only. */
const SIGN_IN = new Set(ROUTE_MATRIX.filter((r) => r.scope === 'public' && !SAFE.has(r.method)).map((r) => `${r.method} ${r.path}`));

const csrfError = () => new AppError(403, 'CSRF_FAILED', 'Your session could not be verified. Reload the page and try again.');

function sameOrigin(req: Request, allowed: string | undefined): boolean {
  const origin = req.header('origin') ?? (req.header('referer') ? safeOrigin(req.header('referer')!) : undefined);
  if (!origin) return true; // non-browser clients; the token check below still applies to sessions
  // Without a configured origin (demo/dev only — production requires APP_ORIGIN, see startup.ts),
  // proxies such as Codespaces rewrite scheme/host unpredictably: rely on the token check alone.
  if (!allowed) return true;
  return origin === allowed;
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid';
  }
}

export function csrfProtection(ctx: Ctx, config: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE.has(req.method)) return next();
    if (!sameOrigin(req, config.appOrigin)) return next(csrfError());
    if (!req.sessionId) return next(); // unauthenticated: login is protected by the origin check
    if (SIGN_IN.has(`${req.method} ${req.path}`)) return next(); // sign-in with a leftover cookie: same as without one
    const expected = await csrfTokenFor(ctx.db, req.sessionId);
    const got = req.header('x-csrf-token') ?? '';
    if (!expected || expected.length !== got.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
      return next(csrfError());
    }
    next();
  };
}
