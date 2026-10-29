// UX-3 (docs/plans/UX-3.md §1): which routes ask for a re-authentication, and that no other route ever does.
// - static: every call of the step-up check in backend/src belongs to a route that declares it in the route matrix
//   (`reauth: true`, or `reauthWhen` for a route that asks only in one case); a new call site fails here;
// - dynamic: with a stale window, no route without either flag answers REAUTH_REQUIRED; each `reauthWhen` route asks
//   in its case and not otherwise; the recorder behind test/setup.ts notices an undeclared one.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { ROUTE_MATRIX, findRouteRule, routeId, type RouteRule } from '@jerp/shared';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { errorHandler, forgetUndeclaredReauth, undeclaredReauthRoutes } from '../src/core/http';
import { reauthRequired } from '../src/auth/reauth';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

const SRC = path.resolve(__dirname, '../src');
const STEP_UP = /\b(requireRecentReauth|reauthRequired)\(/g;
const declares = (rule: RouteRule | undefined) => !!rule && (!!rule.reauth || !!rule.reauthWhen);

/** The routes each service step-up serves (function → routes). A new function calling the check must be added here. */
const SERVICE_STEP_UPS: Record<string, { fn: string; routes: string[] }[]> = {
  'modules/auth/passkeys.ts': [
    { fn: 'requireFreshForCredentialChange', routes: ['POST /auth/passkeys/register/options', 'POST /auth/passkeys/register/verify'] },
    { fn: 'generateRecoveryCodes', routes: ['POST /auth/recovery-codes'] },
    { fn: 'updateSecondFactorPolicy', routes: ['PUT /security/second-factor'] },
  ],
  'modules/openings/service.ts': [{ fn: 'sealOpening', routes: ['POST /openings/:id/seal'] }],
  'modules/openings/corrections.ts': [{ fn: 'correctOpeningPiece', routes: ['POST /openings/:id/pieces/:itemId/correction'] }],
};
/** Files that define or relay the check (not a route of their own). */
const INFRASTRUCTURE = ['auth/reauth.ts', 'core/guard.ts'];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('UX-3: the step-up check is only ever reached from a declared route (static)', () => {
  it('every call site in backend/src is a declared route, a listed service function, or the infrastructure', () => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(STEP_UP)) {
        const before = src.slice(0, m.index);
        if (/export (const|async function|function) (requireRecentReauth|reauthRequired)\b[^\n]*$/.test(before.split('\n').pop() ?? '')) continue; // the definition
        if (INFRASTRUCTURE.includes(rel)) continue;
        if (rel === 'routes.ts') {
          const r = [...before.matchAll(/route\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/g)].pop();
          const id = r ? routeId(r[1], r[2]) : '?';
          expect(declares(findRouteRule(r![1] as never, r![2])), `${id} calls the step-up check: declare reauth or reauthWhen in the route matrix`).toBe(true);
          found.push(id);
          continue;
        }
        const fn = [...before.matchAll(/(?:async )?function (\w+)\s*\(/g)].pop()?.[1] ?? '?';
        const known = SERVICE_STEP_UPS[rel]?.find((x) => x.fn === fn);
        expect(known, `${rel}: ${fn}() calls the step-up check: list it in SERVICE_STEP_UPS with the routes it serves, and declare them`).toBeDefined();
        for (const id of known!.routes) {
          const [method, p] = id.split(' ');
          expect(declares(findRouteRule(method as never, p)), `${id} (via ${fn}) must declare reauth or reauthWhen`).toBe(true);
        }
        found.push(`${rel}:${fn}`);
      }
    }
    expect([...new Set(found)].sort()).toEqual(
      ['PATCH /users/:id', 'POST /sales/:id/void', ...Object.entries(SERVICE_STEP_UPS).flatMap(([rel, fns]) => fns.map((x) => `${rel}:${x.fn}`))].sort(),
    );
  });

  it('the protected list: 20 routes always, 5 in one case each', () => {
    expect(ROUTE_MATRIX.filter((r) => r.reauth).length).toBe(20);
    expect(ROUTE_MATRIX.filter((r) => r.reauthWhen).map((r) => routeId(r.method, r.path)).sort()).toEqual(
      ['PATCH /users/:id', 'POST /auth/passkeys/register/options', 'POST /auth/passkeys/register/verify', 'POST /auth/recovery-codes', 'POST /sales/:id/void'].sort(),
    );
    expect(ROUTE_MATRIX.filter((r) => r.reauth && r.reauthWhen)).toEqual([]);
  });
});

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = withIdempotencyKeys(request.agent(app)) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const send = (a: Agent, method: string, url: string, body: unknown = {}) => (a as unknown as Record<string, (u: string) => request.Test>)[method.toLowerCase()](url).send(body as object);

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('UX-3: with a stale window, only declared routes ask (dynamic)', () => {
  it('each reauthWhen route asks in its case, and not otherwise', async () => {
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'cashier.kh.01'));
    // PATCH /users/:id: the name alone does not ask; the role does.
    const renamed = await gm.patch(`/api/users/${u.id}`).send({ fullName: "Cashier renamed" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((await gm.patch(`/api/users/${u.id}`).send({ roleCode: 'BRANCH_MANAGER' })).body.error.code).toBe('REAUTH_REQUIRED');
    // POST /sales/:id/void: default 0 = every void asks.
    const [sale] = await ctx.db.select().from(t.sales).where(eq(t.sales.status, 'COMPLETED')).limit(1);
    expect((await gm.post(`/api/sales/${sale.id}/void`).send({ reason: 'audit check' })).body.error.code).toBe('REAUTH_REQUIRED');
    // Credential changes: a new passkey and new recovery codes ask for the password.
    expect((await gm.post('/api/auth/passkeys/register/options').send({ nickname: 'Audit device' })).body.error.code).toBe('REAUTH_REQUIRED');
    expect((await gm.post('/api/auth/recovery-codes').send({})).body.error.code).toBe('REAUTH_REQUIRED');
    // After one re-authentication none of them asks again (the window covers every protected route).
    expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
    expect((await gm.patch(`/api/users/${u.id}`).send({ roleCode: 'CASHIER' })).status).toBe(200);
    expect((await gm.post('/api/auth/passkeys/register/options').send({ nickname: 'Audit device' })).status).toBe(200);
  });

  it('no route without reauth or reauthWhen answers REAUTH_REQUIRED (General Manager, every such route, ids of real records)', async () => {
    const [sale] = await ctx.db.select({ id: t.sales.id }).from(t.sales).limit(1);
    const ids: Record<string, number> = { ':id': sale?.id ?? 1, ':itemId': 1 };
    // "This wasn't me" locks the account and signing out ends the session: they are called last.
    const LAST = ['POST /auth/sign-ins/:id/not-me', 'POST /auth/logout'];
    const rules = ROUTE_MATRIX.filter((r) => r.scope !== 'public' && !declares(r));
    const rank = (r: RouteRule) => LAST.indexOf(routeId(r.method, r.path));
    const ordered = [...rules].sort((a, b) => rank(a) - rank(b));
    let gm = await login('general.manager', 'GENERAL_MANAGER');
    const asked: string[] = [];
    let previous = '';
    for (const rule of ordered) {
      const url = '/api' + rule.path.replace(/:\w+/g, (k) => String(ids[k] ?? 1));
      let res = await send(gm, rule.method, url);
      if (res.status === 401) {
        gm = await login('general.manager', 'GENERAL_MANAGER');
        res = await send(gm, rule.method, url);
      }
      if (res.body?.error?.code === 'REAUTH_REQUIRED') asked.push(routeId(rule.method, rule.path));
      // A refusal that stops every later route would hide them: fail loudly instead.
      if (res.body?.error?.code === 'PASSWORD_CHANGE_REQUIRED') throw new Error(`blocked at ${routeId(rule.method, rule.path)} after ${previous}`);
      previous = `${routeId(rule.method, rule.path)} ${res.status}`;
    }
    expect(rules.length).toBeGreaterThan(70);
    expect(asked).toEqual([]);
  });

  it('the recorder notices a route that asks without declaring it (the guard of test/setup.ts)', () => {
    const res = { status: () => res, json: () => res } as never;
    errorHandler(reauthRequired({ password: false, hasPasskey: false, passkey: false, passkeyUv: false }), { routeRule: { method: 'GET', path: '/declared/nowhere', scope: 'self' } } as never, res, () => undefined);
    errorHandler(reauthRequired({ password: false, hasPasskey: false, passkey: false, passkeyUv: false }), { routeRule: findRouteRule('POST', '/sales/:id/void') } as never, res, () => undefined);
    expect(undeclaredReauthRoutes()).toEqual(['GET /declared/nowhere']);
    forgetUndeclaredReauth();
  });
});
