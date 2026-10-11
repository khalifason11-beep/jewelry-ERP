// CLN-3: a proxy that rewrites Origin and Host (GitHub Codespaces' port forwarder, measured by the owner) must not break
// passkeys in demo mode, and must not change production. The proxy is simulated with supertest: it reaches the app as
// Host localhost:4000 / Origin https://localhost:4000 and tells the real public host in X-Forwarded-Host/-Proto.
// Both projects.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';
import { desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { publicOrigin } from '../src/core/origin';
import { relyingParty } from '../src/auth/webauthn';
import { resetThrottleMemory } from '../src/auth/lockout';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

const PUBLIC = 'https://demo.example.test';
const PROXIED = { Host: 'localhost:4000', 'X-Forwarded-Host': 'demo.example.test', 'X-Forwarded-Proto': 'https', Origin: 'https://localhost:4000' };
const GM = { username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER };
const BM = { username: 'branch.manager.kh', password: DEMO_PASSWORDS.BRANCH_MANAGER };
const env = (over: Record<string, string> = {}) => loadConfig({ APP_MODE: 'demo', VITEST: '1', ...over } as NodeJS.ProcessEnv);

let handle: DatabaseHandle;
let ctx: Ctx;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
});
afterAll(async () => handle?.close());

/** An agent that always arrives through the simulated proxy. */
function proxied(app: ReturnType<typeof createApp>) {
  const a = request.agent(app);
  for (const [k, v] of Object.entries(PROXIED)) a.set(k, v);
  return a;
}
async function login(a: ReturnType<typeof proxied>, u: { username: string; password: string }) {
  resetThrottleMemory();
  const r = await a.post('/api/auth/login').send(u);
  if (r.body.csrfToken) a.set('x-csrf-token', r.body.csrfToken);
  return r;
}
/** Adding a passkey on a signed-in session asks for the password again (re-confirmation). */
const reauth = async (a: ReturnType<typeof proxied>, password: string) => expect((await a.post('/api/auth/reauth').send({ password })).status).toBe(200);
const lastChallenge = async (username: string) => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await ctx.db.select().from(t.webauthnChallenges).where(eq(t.webauthnChallenges.userId, u.id)).orderBy(desc(t.webauthnChallenges.id)).limit(1))[0];
};

describe('trust proxy OFF: forwarded headers are ignored (as before)', () => {
  it('the relying party comes from the Origin header, never from X-Forwarded-Host', async () => {
    const a = proxied(createApp(ctx, env()));
    expect((await login(a, BM)).status).toBe(200);
    await reauth(a, BM.password);
    const o = await a.post('/api/auth/passkeys/register/options').send({ nickname: 'BM PC' });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.options.rp.id).toBe('localhost');
    expect(await lastChallenge(BM.username)).toMatchObject({ rpId: 'localhost', origin: 'https://localhost:4000' });
  });
});

describe('trust proxy ON (TRUST_PROXY=1), demo, no APP_ORIGIN: the public host is used', () => {
  const app = () => createApp(ctx, env({ TRUST_PROXY: '1' }));
  const key = new SoftAuthenticator({ uv: true });

  it('sign-in passes and the passkey options name the public host; the challenge stores the public origin', async () => {
    const a = proxied(app());
    const r = await login(a, GM);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await reauth(a, GM.password);
    const o = await a.post('/api/auth/passkeys/register/options').send({ nickname: 'Shop PC' });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.options.rp.id).toBe('demo.example.test');
    expect(await lastChallenge(GM.username)).toMatchObject({ rpId: 'demo.example.test', origin: PUBLIC });
  });

  it('a full register-then-authenticate passkey round trip through the proxy', async () => {
    const a = proxied(app());
    expect((await login(a, GM)).status).toBe(200);
    await reauth(a, GM.password);
    const o = await a.post('/api/auth/passkeys/register/options').send({ nickname: 'Shop PC' });
    const v = await a.post('/api/auth/passkeys/register/verify').send({ response: key.create(o.body.options, PUBLIC) });
    expect(v.status, JSON.stringify(v.body)).toBe(200);

    // A new browser: password, then the passkey, all through the proxy.
    const b = proxied(app());
    const r = await login(b, GM);
    expect(r.body.status).toBe('SECOND_FACTOR_REQUIRED');
    const lo = await b.post('/api/auth/login/passkey/options').send({});
    expect(lo.body.options.rpId).toBe('demo.example.test');
    const lv = await b.post('/api/auth/login/passkey/verify').send({ response: key.get(lo.body.options, PUBLIC) });
    expect(lv.status, JSON.stringify(lv.body)).toBe(200);
    // The same assertion signed for the rewritten origin would be refused: the check is real.
    const c = proxied(app());
    await login(c, GM);
    const co = await c.post('/api/auth/login/passkey/options').send({});
    expect((await c.post('/api/auth/login/passkey/verify').send({ response: key.get(co.body.options, 'https://localhost:4000') })).status).not.toBe(200);
  });
});

describe('production: APP_ORIGIN always wins and the Origin check is unchanged', () => {
  const PROD = { APP_MODE: 'production', APP_ORIGIN: 'https://erp.example.com', DATABASE_URL: 'postgres://erp:S3cure-Pw-2026@db.internal:5432/erp', TRUST_PROXY: '1', VITEST: '1' };
  const prod = loadConfig(PROD as NodeJS.ProcessEnv);
  const fakeReq = { header: (n: string) => (n.toLowerCase() === 'origin' ? PROXIED.Origin : undefined), protocol: 'https', host: 'demo.example.test' } as unknown as Request;

  it('forwarded headers never override APP_ORIGIN', () => {
    expect(publicOrigin(prod, fakeReq)).toBe('https://erp.example.com');
    expect(relyingParty(prod, fakeReq)).toMatchObject({ rpId: 'erp.example.com', origin: 'https://erp.example.com' });
  });

  it('a request whose Origin differs from APP_ORIGIN is still refused (403 CSRF_FAILED), with or without forwarded headers', async () => {
    const app = createApp(ctx, prod);
    const wrong = await request(app).post('/api/auth/login').set(PROXIED).send(BM);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('CSRF_FAILED');
    const forwardedMatch = await request(app).post('/api/auth/login').set({ ...PROXIED, 'X-Forwarded-Host': 'erp.example.com' }).send(BM);
    expect(forwardedMatch.body.error?.code).toBe('CSRF_FAILED');
    // The right Origin passes the check (the request then reaches the sign-in itself).
    resetThrottleMemory();
    const right = await request(app).post('/api/auth/login').set('Origin', 'https://erp.example.com').send({ username: BM.username, password: 'wrong-password' });
    expect(right.body.error?.code).not.toBe('CSRF_FAILED');
  });
});
