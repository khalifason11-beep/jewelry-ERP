// Idempotency for requests that create or confirm business records (routes flagged `idempotent`
// in shared/src/route-matrix.ts; docs/decisions.md D-2a-4).
//
//   * The client sends `Idempotency-Key: <random>`; one key per user action, reused for retries.
//   * First request with a key: reserved (IN_PROGRESS), the handler runs, and a 2xx response is
//     stored (COMPLETED) *before* it is sent, so any later retry sees the stored result.
//   * Same user + key + same request (method, path, body) → the stored response is replayed
//     (`Idempotent-Replayed: true`); nothing is created twice.
//   * Same key with a different request → 422 IDEMPOTENCY_KEY_REUSED.
//   * Same key while the first is still running (double click) → 409 IDEMPOTENCY_IN_PROGRESS.
//   * A non-2xx response (validation error, REAUTH_REQUIRED, …) created nothing, so the
//     reservation is released and the same key may be retried.
//
// MONEY routes (flag `idempotencyInTx`, D-2b-6) go further: the key is claimed and the result stored
// INSIDE the business transaction that also writes the ledger entries. There is no reservation
// outside that transaction, so no crash window can leave an "uncertain" key behind: either the sale,
// its ledger entries and its idempotency record all commit, or none of them does. A concurrent
// duplicate blocks on the key's unique index until the first commits, then replays its result.

import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { t } from '@jerp/database';
import { routeId, type RouteRule } from '@jerp/shared';
import type { Executor } from '@jerp/database';
import type { Ctx } from './context';
import { AppError, badRequest } from './errors';
import { log } from './logger';
import { stripCostFields } from './cost-redaction';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Keys are kept this long; a retry after that is treated as a new request. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;
/** A reservation older than this without a stored result means the outcome is unknown. */
export const IDEMPOTENCY_STALE_MS = 5 * 60_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** JSON with object keys sorted, so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${canonicalJson(body ?? {})}`).digest('hex');
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body ?? null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

let lastPurge = 0;
async function purgeExpired(ctx: Ctx) {
  if (Date.now() - lastPurge < 60 * 60_000) return;
  lastPurge = Date.now();
  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_HOURS * 3600_000);
  await ctx.db.delete(t.idempotencyKeys).where(lt(t.idempotencyKeys.createdAt, cutoff));
}

export function idempotency(ctx: Ctx, rule: RouteRule): RequestHandler {
  const route = routeId(rule.method, rule.path);
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.header(IDEMPOTENCY_HEADER);
      if (!key) throw new AppError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header');
      if (!KEY_PATTERN.test(key)) throw badRequest('Invalid Idempotency-Key');
      const userId = req.actor!.userId;
      const hash = requestHash(req.method, req.originalUrl.split('?')[0], req.body);
      await purgeExpired(ctx).catch((e) => log.warn('idempotency purge failed', { error: String(e) }));

      const [reserved] = await ctx.db
        .insert(t.idempotencyKeys)
        .values({ userId, key, route, requestHash: hash, status: 'IN_PROGRESS' })
        .onConflictDoNothing()
        .returning({ id: t.idempotencyKeys.id });

      if (!reserved) {
        const [prior] = await ctx.db
          .select()
          .from(t.idempotencyKeys)
          .where(and(eq(t.idempotencyKeys.userId, userId), eq(t.idempotencyKeys.key, key)));
        if (!prior) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed. Please wait.');
        if (prior.requestHash !== hash || prior.route !== route) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
        }
        if (prior.status === 'COMPLETED') {
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(prior.responseStatus ?? 200).json(prior.responseBody);
          return;
        }
        if (Date.now() - prior.createdAt.getTime() > IDEMPOTENCY_STALE_MS) {
          throw new AppError(409, 'IDEMPOTENCY_UNCERTAIN', 'An earlier attempt of this action did not finish. Check whether it was recorded before trying again.');
        }
        throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed. Please wait.');
      }

      // Store the final (already cost-redacted) body before it leaves, so a retry can never race
      // ahead of the stored result.
      const originalSend = res.send.bind(res);
      let settled = false;
      res.send = ((body?: unknown) => {
        if (settled) return originalSend(body as never);
        settled = true;
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const persist = ok
          ? ctx.db
              .update(t.idempotencyKeys)
              .set({
                status: 'COMPLETED',
                responseStatus: res.statusCode,
                responseBody: parseBody(body),
                completedAt: new Date(),
              })
              .where(eq(t.idempotencyKeys.id, reserved.id))
          : ctx.db.delete(t.idempotencyKeys).where(eq(t.idempotencyKeys.id, reserved.id));
        Promise.resolve(persist)
          .catch((e) => log.error('idempotency record could not be finalised', { route, error: String(e) }))
          .finally(() => originalSend(body as never));
        return res;
      }) as Response['send'];
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ───────── money routes: idempotency inside the business transaction (D-2b-6) ─────────

/** Handed to a money service; it calls claim() first and complete() last inside its transaction. */
export interface TxIdempotency {
  readonly key: string;
  /** Insert the key (IN_PROGRESS, visible to nobody until commit). A duplicate fails here. */
  claim(tx: Executor): Promise<void>;
  /** Store the service result (COMPLETED) in the same transaction as the business change. */
  complete(tx: Executor, result: unknown): Promise<void>;
}

declare module 'express-serve-static-core' {
  interface Request {
    idempotencyTx?: TxIdempotency & { userId: number; route: string; hash: string };
    idempotencyPrior?: { responseBody: unknown };
  }
}

const isKeyConflict = (e: unknown): boolean => {
  for (let x = e as { code?: string; constraint?: string; cause?: unknown; message?: string } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (x.code === '23505' && (!x.constraint || x.constraint === 'idem_user_key_idx')) return true;
    if (typeof x.message === 'string' && x.message.includes('idem_user_key_idx')) return true;
  }
  return false;
};

/** Middleware for `idempotencyInTx` routes: validates the key, replays a stored result, never reserves. */
export function idempotencyInTx(ctx: Ctx, rule: RouteRule): RequestHandler {
  const route = routeId(rule.method, rule.path);
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const key = req.header(IDEMPOTENCY_HEADER);
      if (!key) throw new AppError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header');
      if (!KEY_PATTERN.test(key)) throw badRequest('Invalid Idempotency-Key');
      const userId = req.actor!.userId;
      const canSeeCost = req.actor!.permissions.has('profit.view');
      const hash = requestHash(req.method, req.originalUrl.split('?')[0], req.body);
      await purgeExpired(ctx).catch((e) => log.warn('idempotency purge failed', { error: String(e) }));
      const [prior] = await ctx.db.select().from(t.idempotencyKeys).where(and(eq(t.idempotencyKeys.userId, userId), eq(t.idempotencyKeys.key, key)));
      if (prior) {
        if (prior.requestHash !== hash || prior.route !== route) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
        }
        if (prior.status !== 'COMPLETED') throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed. Please wait.');
        req.idempotencyPrior = { responseBody: prior.responseBody };
        return next();
      }
      req.idempotencyTx = {
        key,
        userId,
        route,
        hash,
        async claim(tx) {
          await tx.insert(t.idempotencyKeys).values({ userId, key, route, requestHash: hash, status: 'IN_PROGRESS' });
        },
        async complete(tx, result) {
          // Store what the caller is allowed to see: never keep COST fields for a caller without
          // profit.view (the replay is redacted again on the way out anyway).
          const plain = JSON.parse(JSON.stringify(result ?? null));
          const stored = canSeeCost ? plain : stripCostFields(plain);
          await tx
            .update(t.idempotencyKeys)
            .set({ status: 'COMPLETED', responseStatus: 200, responseBody: stored, completedAt: new Date() })
            .where(and(eq(t.idempotencyKeys.userId, userId), eq(t.idempotencyKeys.key, key)));
        },
      };
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Run a money service once per key. Returns the stored result on a replay (sequential retry, or a
 * concurrent duplicate that lost the race on the key), otherwise the fresh result.
 */
export async function runIdempotent<T>(ctx: Ctx, req: Request, res: Response, fn: (idem: TxIdempotency | undefined) => Promise<T>): Promise<T> {
  if (req.idempotencyPrior) {
    res.setHeader('Idempotent-Replayed', 'true');
    return req.idempotencyPrior.responseBody as T;
  }
  const idem = req.idempotencyTx;
  try {
    return await fn(idem);
  } catch (e) {
    if (!idem || !isKeyConflict(e)) throw e;
    // Another request with this key committed first: replay its result (or refuse a different body).
    const [row] = await ctx.db.select().from(t.idempotencyKeys).where(and(eq(t.idempotencyKeys.userId, idem.userId), eq(t.idempotencyKeys.key, idem.key)));
    if (!row || row.requestHash !== idem.hash || row.route !== idem.route) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }
    if (row.status !== 'COMPLETED') throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed. Please wait.');
    res.setHeader('Idempotent-Replayed', 'true');
    return row.responseBody as T;
  }
}
