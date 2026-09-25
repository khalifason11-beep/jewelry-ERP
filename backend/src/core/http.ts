import type { NextFunction, Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import { HasadError } from '@jerp/hasad';
import type { Actor } from './context';
import { AppError, badRequest, unauthorized } from './errors';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    sessionId?: string;
    mustChangePassword?: boolean;
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
    throw badRequest('Invalid value for {field}', { field: first.path.join('.') || 'input' }, r.error.issues);
  }
  return r.data;
}

/** Common query-string schemas. */
export const zId = z.coerce.number().int().positive();
export const zOptId = z.preprocess((v) => (v === '' || v === 'all' ? undefined : v), z.coerce.number().int().positive().optional());
export const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // `key` + `params` let the UI translate the message; `message` is the English rendering.
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, key: err.key, params: err.params, details: err.details } });
    return;
  }
  if (err instanceof HasadError) {
    const status = { NOT_FOUND: 404, INVALID_STATE: 409, REJECTED: 422, UNAVAILABLE: 502 }[err.code];
    res.status(status).json({ error: { code: `HASAD_${err.code}`, message: err.message, key: err.key, params: err.params } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error', key: 'Unexpected server error' } });
}
