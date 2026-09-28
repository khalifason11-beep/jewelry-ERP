// Central route guard built from the shared ROUTE_MATRIX (deny by default).
// `defineRoutes` is the only way routes are registered: a route missing from the matrix throws at
// start-up, so nothing can be exposed without an explicit access rule.

import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { findRouteRule, permitsRule, routeId, type HttpMethod, type RouteRule } from '@jerp/shared';
import type { Ctx } from './context';
import { AppError, forbidden, unauthorized } from './errors';
import { requireRecentReauth } from '../auth/reauth';
import { idempotency, idempotencyInTx } from './idempotency';

export interface RouteRegistry {
  /** Rules registered on this router (tests compare them with the matrix). */
  registered: RouteRule[];
  route(method: HttpMethod, path: string, ...handlers: RequestHandler[]): void;
}

/** Throws the reason a request is refused by `rule`, or returns normally. */
export async function enforceRule(ctx: Ctx, rule: RouteRule, req: Request): Promise<void> {
  if (rule.scope === 'public') return;
  const actor = req.actor;
  if (!actor) throw unauthorized();
  if (req.mustChangePassword && !req.path.startsWith('/auth/')) {
    throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must set a new password before continuing');
  }
  const has = (p: Parameters<typeof actor.permissions.has>[0]) => actor.permissions.has(p);
  if (!permitsRule(rule, has)) {
    const missing = rule.all?.find((p) => !has(p)) ?? (rule.scope === 'global' && !has('scope.all_branches') ? 'scope.all_branches' : undefined);
    if (missing) throw forbidden('Missing permission: {permission}', { permission: missing });
    throw forbidden('Requires one of: {permissions}', { permissions: (rule.any ?? []).join(', ') });
  }
  if (rule.reauth) await requireRecentReauth(ctx, req);
}

export function defineRoutes(router: Router, ctx: Ctx, opts: { demo: boolean }): RouteRegistry {
  const registered: RouteRule[] = [];
  return {
    registered,
    route(method, path, ...handlers) {
      const rule = findRouteRule(method, path);
      if (!rule) throw new Error(`Route ${routeId(method, path)} is not in ROUTE_MATRIX (shared/src/route-matrix.ts)`);
      if (rule.demoOnly && !opts.demo) return;
      if (rule.destructive && !opts.demo) throw new Error(`Destructive route ${routeId(method, path)} cannot be registered outside demo mode`);
      registered.push(rule);
      const guard = async (req: Request, _res: Response, next: NextFunction) => {
        try {
          await enforceRule(ctx, rule, req);
          next();
        } catch (e) {
          next(e);
        }
      };
      const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      // Order: access rule (auth, permissions, re-auth) → idempotency → handler. A refused request
      // never consumes an idempotency key.
      router[m](path, guard, ...(rule.idempotent ? [rule.idempotencyInTx ? idempotencyInTx(ctx, rule) : idempotency(ctx, rule)] : []), ...handlers);
    },
  };
}
