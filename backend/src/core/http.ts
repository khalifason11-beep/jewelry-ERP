import type { NextFunction, Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import { routeId, type RouteRule } from '@jerp/shared';
import type { Actor } from './context';
import { AppError, badRequest, unauthorized } from './errors';
import { log } from './logger';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    sessionId?: string;
    mustChangePassword?: boolean;
    /** Phase 2fa: required role without a passkey / confirmed recovery codes: only /auth/* is open. */
    enrollmentRequired?: boolean;
    /** SAFE-1: random id of this request, in the X-Request-Id response header, the access log and error bodies. */
    requestId?: string;
    /** UX-3: the route-matrix rule of the route being served (set by the guard). */
    routeRule?: RouteRule;
  }
}

export function actorOf(req: Request): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    // Only paths and issue codes go back to the client (M-10), never received values.
    throw badRequest('Invalid value for {field}', { field: first.path.join('.') || 'input' }, r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })));
  }
  return r.data;
}

/** Common query-string schemas. */
export const zId = z.coerce.number().int().positive();
export const zOptId = z.preprocess((v) => (v === '' || v === 'all' ? undefined : v), z.coerce.number().int().positive().optional());
export const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// UX-3: a route that asks for a re-confirmation must say so in the route matrix (`reauth` or `reauthWhen`), so the
// protected list the owner reads is complete. An undeclared one is logged and recorded; the tests fail on any.
const undeclared = new Set<string>();
export const undeclaredReauthRoutes = () => [...undeclared].sort();
/** Tests only: forget what a test recorded on purpose. */
export const forgetUndeclaredReauth = () => undeclared.clear();
function noteUndeclaredReauth(rule: RouteRule | undefined, requestId: string | undefined) {
  if (!rule || rule.reauth || rule.reauthWhen) return;
  undeclared.add(routeId(rule.method, rule.path));
  log.error('re-authentication asked by a route that does not declare it in the route matrix', { route: routeId(rule.method, rule.path), requestId });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // `key` + `params` let the UI translate the message; `message` is the English rendering. An error body never carries
  // a stack trace, in any mode. The request id travels in the X-Request-Id header only (SAFE-1): the sign-in refusals
  // must stay byte-for-byte identical whatever the reason (no enumeration channel), which a per-request id in the body
  // would break.
  const requestId = _req.requestId;
  if (err instanceof AppError) {
    if (err.code === 'REAUTH_REQUIRED') noteUndeclaredReauth(_req.routeRule, requestId);
    res.status(err.status).json({ error: { code: err.code, message: err.message, key: err.key, params: err.params, details: err.details } });
    return;
  }
  // express.json() body errors: malformed JSON or payload over the size limit.
  const status = (err as { status?: number; type?: string })?.status;
  if (status === 413 || status === 400) {
    const tooLarge = status === 413;
    res.status(status).json({ error: { code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: tooLarge ? 'Request is too large' : 'Malformed request', key: tooLarge ? 'Request is too large' : 'Malformed request' } });
    return;
  }
  log.error('unhandled error', { err, method: _req.method, path: _req.path, requestId });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error', key: 'Unexpected server error' } });
}
