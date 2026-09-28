// Phase 1a security tests: APP_MODE/production hardening (security item 2) and authentication
// (security item 3), plus the web-hardening and validation rules they depend on.
// Every block covers the happy path, the denial path and, where relevant, cross-branch access,
// concurrency and rollback.

import { randomBytes, scryptSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext, openDatabase } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { redact } from '../src/core/logger';
import { demoCredentialsInUse, productionConfigProblems } from '../src/core/startup';
import { hashPassword, needsRehash, verifyPassword } from '../src/auth/password';
import { assertPasswordPolicy } from '../src/auth/policy';
import { lockMinutes, resetThrottleMemory, IP_MAX_FAILURES } from '../src/auth/lockout';
import { createSession } from '../src/modules/sessions/service';
import { bootstrapProduction } from '../src/modules/bootstrap/service';
import { seedDemo } from '../src/seed/demo';
import { DEMO_PASSWORDS } from '../src/seed/catalog';

const PROD_ENV = {
  APP_MODE: 'production',
  DATABASE_URL: 'postgres://erp:S3cure-Pw-2026@db.internal:5432/erp',
  APP_ORIGIN: 'https://erp.example.com',
  VITEST: '1',
} as NodeJS.ProcessEnv;

let handle: DatabaseHandle;
let ctx: Ctx;
let demoApp: ReturnType<typeof createApp>;
let prodApp: ReturnType<typeof createApp>;
const prodConfig = loadConfig(PROD_ENV);

type Agent = ReturnType<typeof request.agent>;

async function login(username: string, password: string): Promise<Agent> {
  const agent = request.agent(demoApp);
  const res = await agent.post('/api/auth/login').send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const loginRole = (username: string) =>
  login(username, DEMO_PASSWORDS[username.startsWith('general') ? 'GENERAL_MANAGER' : username.startsWith('branch') ? 'BRANCH_MANAGER' : 'CASHIER']);

async function userByName(username: string) {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return u;
}

/** A throw-away user with a known password (isolates lockout tests from each other). */
async function makeUser(username: string, password: string, role = 'CASHIER', branchId: number | null = 1) {
  const [r] = await ctx.db.select().from(t.roles).where(eq(t.roles.code, role));
  const [u] = await ctx.db
    .insert(t.users)
    .values({ username, fullName: username, roleId: r.id, branchId: role === 'GENERAL_MANAGER' ? null : branchId, passwordHash: await hashPassword(password) })
    .returning();
  return u;
}

/** Authenticated production-mode requester (session created directly; cookies are Secure there). */
async function prodSession(username: string) {
  const u = await userByName(username);
  const s = await createSession(ctx.db, { userId: u.id, branchId: u.branchId, absoluteHours: 12 });
  const cookie = `${prodConfig.cookieName}=${s.token}`;
  return {
    get: (path: string) => request(prodApp).get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}, origin = prodConfig.appOrigin!) =>
      request(prodApp).post(path).set('Cookie', cookie).set('x-csrf-token', s.csrfToken).set('Origin', origin).send(body),
  };
}

beforeAll(async () => {
  handle = await openDatabase({ dataDir: 'memory://' });
  ctx = createContext(handle);
  await seedDemo(ctx);
  demoApp = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
  prodApp = createApp(ctx, prodConfig);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => resetThrottleMemory());

// ───────────────────────── security item 2: APP_MODE / production ─────────────────────────
describe('production mode (security item 2)', () => {
  it('refuses unsafe production configurations and accepts a safe one', () => {
    expect(productionConfigProblems(prodConfig)).toEqual([]);
    const bad = (env: Record<string, string | undefined>) => productionConfigProblems(loadConfig({ ...PROD_ENV, ...env } as NodeJS.ProcessEnv));
    expect(bad({ DATABASE_URL: undefined }).join()).toMatch(/PGlite/);
    expect(bad({ DATABASE_URL: 'postgres://postgres:postgres@db/erp' }).join()).toMatch(/default password/);
    expect(bad({ DATABASE_URL: 'postgres://erp@db/erp' }).join()).toMatch(/default password/);
    expect(bad({ APP_ORIGIN: undefined }).join()).toMatch(/APP_ORIGIN is required/);
    expect(bad({ APP_ORIGIN: 'http://erp.example.com' }).join()).toMatch(/https/);
    expect(bad({ COOKIE_SECURE: 'false' }).join()).toMatch(/COOKIE_SECURE/);
    expect(() => loadConfig({ APP_MODE: 'prod' } as NodeJS.ProcessEnv)).toThrow(/APP_MODE/);
    // Demo mode has no production requirements.
    expect(productionConfigProblems(loadConfig({} as NodeJS.ProcessEnv))).toEqual([]);
  });

  it('detects demo accounts that still accept their published password (startup refusal)', async () => {
    const leaked = await demoCredentialsInUse(ctx.db);
    expect(leaked).toContain('general.manager');
    expect(leaked).toContain('cashier.kh.01');
  });

  it('does not register demo reset or the Hasad simulator in production (404), even for the GM', async () => {
    const gm = await prodSession('general.manager');
    expect((await gm.post('/api/demo/reset')).status).toBe(404);
    expect((await gm.get('/api/hasad/simulator/customers')).status).toBe(404);
    expect((await gm.post('/api/hasad/simulator/withdrawals', { customerId: 'HC-204518', branchId: 1 })).status).toBe(404);
    expect((await gm.get('/api/hasad/integration-log')).status).toBe(404);
    // The same GM session works for normal routes, so the 404 is not an auth artefact.
    expect((await gm.get('/api/auth/me')).status).toBe(200);
    // In demo mode the routes exist.
    const demoGm = await loginRole('general.manager');
    expect((await demoGm.get('/api/hasad/simulator/customers')).status).toBe(200);
  });

  it('never exposes demo credentials in production, and minimises /health', async () => {
    const prodMeta = await request(prodApp).get('/api/meta');
    expect(prodMeta.status).toBe(200);
    expect(prodMeta.body.appMode).toBe('production');
    expect(prodMeta.body.demoAccounts).toEqual([]);
    expect(JSON.stringify(prodMeta.body)).not.toContain('demo-');
    expect((await request(prodApp).get('/api/health')).body).toEqual({ ok: true });

    const demoMeta = await request(demoApp).get('/api/meta');
    expect(demoMeta.body.demoAccounts.length).toBeGreaterThan(0);
  });

  it('uses a __Host- Secure cookie and HSTS in production', async () => {
    expect(prodConfig.cookieName).toBe('__Host-jerp_session');
    expect(prodConfig.cookieSecure).toBe(true);
    const res = await request(prodApp).get('/api/meta');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
  });

  it('bootstraps the first General Manager once, atomically, with a forced password change', async () => {
    const fresh = await openDatabase({ dataDir: 'memory://' });
    try {
      const fctx = createContext(fresh);
      const res = await bootstrapProduction(fctx, {
        username: 'owner.gm',
        fullName: 'Owner',
        branches: [{ code: 'KRT', name: 'Khartoum Branch', nameAr: 'فرع الخرطوم', city: 'Khartoum' }],
      });
      expect(res.temporaryPassword).toMatch(/^Temp-/);
      expect(res.branches).toEqual(['KRT']);
      const [gm] = await fresh.db.select().from(t.users).where(eq(t.users.username, 'owner.gm'));
      expect(gm.mustChangePassword).toBe(true);
      expect(gm.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(await demoCredentialsInUse(fresh.db)).toEqual([]);

      // Second run is refused and rolls back completely (the extra branch is NOT created).
      await expect(
        bootstrapProduction(fctx, { username: 'second.gm', fullName: 'Second', branches: [{ code: 'OMD', name: 'Omdurman Branch', nameAr: 'فرع أم درمان', city: 'Omdurman' }] }),
      ).rejects.toMatchObject({ code: 'ALREADY_BOOTSTRAPPED' });
      expect(await fresh.db.select().from(t.branches).where(eq(t.branches.code, 'OMD'))).toHaveLength(0);
      expect(await fresh.db.select().from(t.users)).toHaveLength(1);

      // The GM can sign in only to change the password.
      const app = createApp(fctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
      const agent = request.agent(app);
      const li = await agent.post('/api/auth/login').send({ username: 'owner.gm', password: res.temporaryPassword });
      expect(li.status).toBe(200);
      const blocked = await agent.get('/api/users');
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    } finally {
      await fresh.close();
    }
  });
});

// ───────────────────────── security item 3: authentication ─────────────────────────
describe('password hashing and policy', () => {
  it('hashes with argon2id (m=19456, t=2, p=1) and verifies', async () => {
    const h = await hashPassword('Correct-Horse-7');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('Correct-Horse-7', h)).toBe(true);
    expect(await verifyPassword('correct-horse-7', h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('accepts legacy scrypt hashes and upgrades them to argon2id on the next sign-in', async () => {
    const salt = randomBytes(16);
    const legacy = ['scrypt', 16384, 8, 1, salt.toString('base64'), scryptSync('Legacy-Pass-2026', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')].join('$');
    const u = await makeUser('legacy.user', 'placeholder-1');
    await ctx.db.update(t.users).set({ passwordHash: legacy }).where(eq(t.users.id, u.id));
    expect(needsRehash(legacy)).toBe(true);
    await login('legacy.user', 'Legacy-Pass-2026');
    const after = await userByName('legacy.user');
    expect(after.passwordHash.startsWith('$argon2id$')).toBe(true);
    await login('legacy.user', 'Legacy-Pass-2026');
  });

  it('enforces the password policy', () => {
    const ok = (p: string) => assertPasswordPolicy(p, { minLength: 10, username: 'ahmed.ali' });
    expect(() => ok('Short1')).toThrow(/at least/);
    expect(() => ok('onlyletters')).toThrow(/letters and digits/);
    expect(() => ok('1234567890123')).toThrow(/letters and digits/);
    expect(() => ok('ahmed.ali2026x')).toThrow(/username/);
    expect(() => ok('password123')).toThrow(/too common/);
    expect(() => ok('x'.repeat(130) + '1')).toThrow(/at most/);
    expect(() => ok('Counter-2026-xy')).not.toThrow();
  });

  it('applies the policy to temporary passwords typed by the GM (M-8)', async () => {
    const gm = await loginRole('general.manager');
    await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER });
    const weak = await gm.post('/api/users').send({ username: 'weak.temp', fullName: 'Weak Temp', roleCode: 'CASHIER', branchId: 1, temporaryPassword: 'abcdefghij' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.key).toBe('Use letters and digits');
  });
});

describe('sign-in throttling and lockout', () => {
  it('computes the lock duration: 15 → 30 → 60 (cap)', () => {
    const s = { lockoutThreshold: 5, lockoutBaseMinutes: 15, lockoutMaxMinutes: 60 };
    expect([4, 5, 6, 7, 8, 30].map((n) => lockMinutes(n, s))).toEqual([0, 15, 30, 60, 60, 60]);
  });

  it('locks after 5 consecutive failures, refuses the right password while locked, and doubles after expiry', async () => {
    const u = await makeUser('lock.victim', 'Right-Pass-2026');
    for (let i = 0; i < 5; i++) {
      const r = await request(demoApp).post('/api/auth/login').send({ username: 'lock.victim', password: `wrong-${i}` });
      expect(r.status).toBe(401);
    }
    const locked = await request(demoApp).post('/api/auth/login').send({ username: 'lock.victim', password: 'Right-Pass-2026' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    let row = await userByName('lock.victim');
    const minutes = (row.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'ACCOUNT_LOCKED'), eq(t.auditLogs.entityId, 'lock.victim')))).toHaveLength(1);

    // Lock expires; one more failure doubles the lock to 30 minutes.
    await ctx.db.update(t.users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(t.users.id, u.id));
    expect((await request(demoApp).post('/api/auth/login').send({ username: 'lock.victim', password: 'wrong-again' })).status).toBe(401);
    row = await userByName('lock.victim');
    expect((row.lockedUntil!.getTime() - Date.now()) / 60_000).toBeGreaterThan(29);

    // After expiry the right password works and resets the counter.
    await ctx.db.update(t.users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(t.users.id, u.id));
    await login('lock.victim', 'Right-Pass-2026');
    row = await userByName('lock.victim');
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('does not reveal whether a username exists (same status, body and lock behaviour)', async () => {
    await makeUser('real.user', 'Real-Pass-2026');
    const known = await request(demoApp).post('/api/auth/login').send({ username: 'real.user', password: 'nope-nope-1' });
    const unknown = await request(demoApp).post('/api/auth/login').send({ username: 'ghost.user', password: 'nope-nope-1' });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    for (let i = 0; i < 5; i++) await request(demoApp).post('/api/auth/login').send({ username: 'ghost.user', password: `x-${i}` });
    const ghostLocked = await request(demoApp).post('/api/auth/login').send({ username: 'ghost.user', password: 'x' });
    expect(ghostLocked.status).toBe(429);
    expect(ghostLocked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('counts parallel failures atomically (no lost updates)', async () => {
    await makeUser('parallel.victim', 'Parallel-Pass-2026');
    await Promise.all(Array.from({ length: 4 }, (_, i) => request(demoApp).post('/api/auth/login').send({ username: 'parallel.victim', password: `bad-${i}` })));
    expect((await userByName('parallel.victim')).failedLoginCount).toBe(4);
  });

  it('throttles an IP that sprays many accounts', async () => {
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      await request(demoApp).post('/api/auth/login').send({ username: `spray.${i}`, password: 'Spray-2026-x' });
    }
    const blocked = await request(demoApp).post('/api/auth/login').send({ username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('lets the GM unlock an account (audited); a branch manager cannot', async () => {
    const u = await makeUser('to.unlock', 'Unlock-Pass-2026');
    await ctx.db.update(t.users).set({ failedLoginCount: 7, lockedUntil: new Date(Date.now() + 3600_000) }).where(eq(t.users.id, u.id));
    const bm = await loginRole('branch.manager.kh');
    const denied = await bm.post(`/api/users/${u.id}/unlock`);
    expect(denied.status).toBe(403);
    const gm = await loginRole('general.manager');
    expect((await gm.post(`/api/users/${u.id}/unlock`)).status).toBe(200);
    await login('to.unlock', 'Unlock-Pass-2026');
    expect(await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'USER_UNLOCKED'), eq(t.auditLogs.entityId, 'to.unlock')))).toHaveLength(1);
  });

  it('never records the typed username verbatim when it is not a valid username (L-1)', async () => {
    await request(demoApp).post('/api/auth/login').send({ username: 'My Secret Pass 1!', password: 'whatever-1' });
    const rows = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'LOGIN_FAILED'));
    expect(JSON.stringify(rows)).not.toContain('My Secret Pass');
  });
});

describe('sessions: timeouts and rotation', () => {
  const sessionOf = async (agent: Agent) => {
    const me = await agent.get('/api/auth/me');
    const [s] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.csrfToken, me.body.csrfToken));
    return s;
  };

  it('ends any session after 60 idle minutes (all roles), not before', async () => {
    const cashier = await loginRole('cashier.kh.02');
    const bm = await loginRole('branch.manager.bhr');
    const gm = await loginRole('general.manager');
    // 59 minutes idle: still signed in.
    for (const a of [cashier, bm, gm]) await ctx.db.update(t.sessions).set({ lastActivityAt: new Date(Date.now() - 59 * 60_000) }).where(eq(t.sessions.id, (await sessionOf(a)).id));
    for (const a of [cashier, bm, gm]) expect((await a.get('/api/auth/me').set('x-client-idle-ms', String(59 * 60_000))).status).toBe(200);
    // 61 minutes idle: signed out, whatever the role.
    for (const a of [cashier, bm, gm]) await ctx.db.update(t.sessions).set({ lastActivityAt: new Date(Date.now() - 61 * 60_000) }).where(eq(t.sessions.id, (await sessionOf(a)).id));
    for (const a of [cashier, bm, gm]) expect((await a.get('/api/auth/me')).status).toBe(401);
  });

  it('lets the GM change the idle timeout from settings (no code change)', async () => {
    const gm = await loginRole('general.manager');
    await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER });
    const res = await gm.put('/api/settings').send({ changes: { 'security.idleMinutes': 20 }, reason: 'Shorter at the counter' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cashier = await loginRole('cashier.kh.01');
    const [s] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.csrfToken, (await cashier.get('/api/auth/me')).body.csrfToken));
    await ctx.db.update(t.sessions).set({ lastActivityAt: new Date(Date.now() - 21 * 60_000) }).where(eq(t.sessions.id, s.id));
    expect((await cashier.get('/api/auth/me')).status).toBe(401);
    expect((await gm.put('/api/settings').send({ changes: { 'security.idleMinutes': 60 } })).status).toBe(200);
  });

  it('enforces the absolute session limit regardless of activity', async () => {
    const bm = await loginRole('branch.manager.pzu');
    const s = await sessionOf(bm);
    expect(s.absoluteExpiresAt!.getTime() - s.loginAt.getTime()).toBe(12 * 3600_000);
    await ctx.db.update(t.sessions).set({ absoluteExpiresAt: new Date(Date.now() - 1000) }).where(eq(t.sessions.id, s.id));
    expect((await bm.get('/api/auth/me')).status).toBe(401);
  });

  it('background polling (x-client-idle-ms) does not keep an unattended session alive', async () => {
    const cashier = await loginRole('cashier.omd.01');
    const s = await sessionOf(cashier);
    const old = new Date(Date.now() - 10 * 60_000);
    await ctx.db.update(t.sessions).set({ lastActivityAt: old }).where(eq(t.sessions.id, s.id));
    await cashier.get('/api/notifications').set('x-client-idle-ms', String(10 * 60_000));
    const [after] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, s.id));
    expect(Math.abs(after.lastActivityAt.getTime() - old.getTime())).toBeLessThan(20_000);
    // Real input moves it forward.
    await cashier.get('/api/notifications').set('x-client-idle-ms', '500');
    const [touched] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, s.id));
    expect(Date.now() - touched.lastActivityAt.getTime()).toBeLessThan(5_000);
  });

  it('issues a fresh session on every sign-in and rotates it on a password change', async () => {
    const a = await loginRole('cashier.bhr.01');
    const b = await loginRole('cashier.bhr.01');
    expect((await sessionOf(a)).id).not.toBe((await sessionOf(b)).id);

    const u = await makeUser('rotate.me', 'Rotate-Pass-2026');
    await ctx.db.update(t.users).set({ mustChangePassword: true }).where(eq(t.users.id, u.id));
    const agent = await login('rotate.me', 'Rotate-Pass-2026');
    const before = await sessionOf(agent);
    const changed = await agent.post('/api/auth/change-password').send({ currentPassword: 'Rotate-Pass-2026', newPassword: 'Rotated-Pass-2027' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [oldRow] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, before.id));
    expect(oldRow.status).toBe('REVOKED');
    agent.set('x-csrf-token', changed.body.csrfToken);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('rejects wildcard session keys on revoke (M-6)', async () => {
    const gm = await loginRole('general.manager');
    expect((await gm.post('/api/sessions/%25/revoke')).status).toBe(400);
    expect((await gm.post('/api/sessions/0000000000000000/revoke')).status).toBe(404);
  });
});

describe('re-authentication for sensitive actions', () => {
  it('requires a recent password confirmation for gold-rate changes', async () => {
    const gm = await loginRole('general.manager');
    const first = await gm.post('/api/gold-rates').send({ rates: { '21': 191_000 } });
    expect(first.status).toBe(403);
    expect(first.body.error.code).toBe('REAUTH_REQUIRED');
    const wrong = await gm.post('/api/auth/reauth').send({ password: 'not-my-password-1' });
    expect(wrong.body.error.code).toBe('REAUTH_FAILED');
    expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
    expect((await gm.post('/api/gold-rates').send({ rates: { '21': 191_000 } })).status).toBe(200);

    // The window closes after 5 minutes.
    const me = await gm.get('/api/auth/me');
    await ctx.db.update(t.sessions).set({ reauthAt: new Date(Date.now() - 6 * 60_000) }).where(eq(t.sessions.csrfToken, me.body.csrfToken));
    expect((await gm.post('/api/gold-rates').send({ rates: { '21': 192_000 } })).body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('requires re-auth for role changes', async () => {
    const gm = await loginRole('general.manager');
    const target = await userByName('cashier.bhr.01');
    const res = await gm.patch(`/api/users/${target.id}`).send({ roleCode: 'BRANCH_MANAGER' });
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await userByName('cashier.bhr.01')).roleId).toBe(target.roleId);
  });

  it('requires re-auth for inventory adjustments; permission and branch checks still apply', async () => {
    const [item] = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, 1), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(1);
    const cashier = await loginRole('cashier.kh.01');
    expect((await cashier.post(`/api/inventory/items/${item.id}/adjust`).send({ action: 'MARK_DAMAGED', reason: 'Test damage' })).body.error.code).toBe('FORBIDDEN');

    const bmOther = await loginRole('branch.manager.omd');
    await bmOther.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.BRANCH_MANAGER });
    const cross = await bmOther.post(`/api/inventory/items/${item.id}/adjust`).send({ action: 'MARK_DAMAGED', reason: 'Test damage' });
    expect(cross.status).toBe(403);
    expect(cross.body.error.key).toBe('You can only access data of your own branch');

    const bm = await loginRole('branch.manager.kh');
    expect((await bm.post(`/api/inventory/items/${item.id}/adjust`).send({ action: 'MARK_DAMAGED', reason: 'Test damage' })).body.error.code).toBe('REAUTH_REQUIRED');
    await bm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.BRANCH_MANAGER });
    expect((await bm.post(`/api/inventory/items/${item.id}/adjust`).send({ action: 'MARK_DAMAGED', reason: 'Test damage' })).status).toBe(200);
  });

  it('wrong re-auth passwords count toward the lockout and end every session of the user', async () => {
    await makeUser('reauth.guess', 'Reauth-Pass-2026', 'BRANCH_MANAGER', 2);
    const a = await login('reauth.guess', 'Reauth-Pass-2026');
    const other = await login('reauth.guess', 'Reauth-Pass-2026');
    for (let i = 0; i < 5; i++) await a.post('/api/auth/reauth').send({ password: `guess-${i}-x` });
    expect((await a.get('/api/auth/me')).status).toBe(401);
    expect((await other.get('/api/auth/me')).status).toBe(401);
    expect((await userByName('reauth.guess')).lockedUntil).not.toBeNull();
  });
});

// ───────────────────────── web hardening used by items 2–3 ─────────────────────────
describe('CSRF, headers, proxy trust and validation', () => {
  it('rejects cookie-authenticated mutations without the session CSRF token', async () => {
    const cashier = await loginRole('cashier.kh.01');
    const noToken = await request(demoApp)
      .post('/api/sessions/heartbeat')
      .set('Cookie', (await cashier.get('/api/auth/me')).request.cookies);
    expect([401, 403]).toContain(noToken.status);
    const wrong = await cashier.post('/api/sessions/heartbeat').set('x-csrf-token', 'forged-token');
    expect(wrong.body.error.code).toBe('CSRF_FAILED');
    expect((await cashier.post('/api/sessions/heartbeat')).status).toBe(200);
  });

  it('in production rejects mutations and sign-ins from a foreign Origin', async () => {
    const gm = await prodSession('general.manager');
    expect((await gm.post('/api/sessions/heartbeat', {}, 'https://evil.example')).body.error.code).toBe('CSRF_FAILED');
    expect((await gm.post('/api/sessions/heartbeat')).status).toBe(200);
    const login = await request(prodApp).post('/api/auth/login').set('Origin', 'https://evil.example').send({ username: 'general.manager', password: 'x' });
    expect(login.status).toBe(403);
  });

  it('sends security headers and no-store on the API', async () => {
    const res = await request(demoApp).get('/api/meta');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('ignores X-Forwarded-For unless a proxy is configured (H-6)', async () => {
    const agent = request.agent(demoApp);
    const res = await agent.post('/api/auth/login').set('X-Forwarded-For', '6.6.6.6').send({ username: 'cashier.pzu.01', password: DEMO_PASSWORDS.CASHIER });
    expect(res.body.session.ipAddress).not.toBe('6.6.6.6');
    const proxied = createApp(ctx, loadConfig({ VITEST: '1', TRUST_PROXY: '1' } as NodeJS.ProcessEnv));
    const viaProxy = await request(proxied).post('/api/auth/login').set('X-Forwarded-For', '6.6.6.6').send({ username: 'cashier.pzu.01', password: DEMO_PASSWORDS.CASHIER });
    expect(viaProxy.body.session.ipAddress).toBe('6.6.6.6');
  });

  it('rejects unknown fields, unbounded numbers, bad settings and oversized bodies', async () => {
    const cashier = await loginRole('cashier.kh.01');
    const extra = await cashier.post('/api/sales').send({ items: [{ itemId: 1 }], paymentMethod: 'CASH', branchId: 1, isAdmin: true });
    expect(extra.status).toBe(400);
    expect(extra.body.error.details[0]).toEqual({ path: '', code: 'unrecognized_keys' });
    expect((await cashier.post('/api/sales').send({ items: [{ itemId: 1, discount: -5 }], paymentMethod: 'CASH' })).status).toBe(400);
    expect((await cashier.post('/api/sales').send({ items: [{ itemId: 1, discount: 10.5 }], paymentMethod: 'CASH' })).status).toBe(400);
    expect((await cashier.get('/api/inventory/items').query({ limit: 999999 })).status).toBe(400);
    expect((await cashier.get('/api/inventory/items').query({ karat: 19 })).status).toBe(400);

    const gm = await loginRole('general.manager');
    await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER });
    expect((await gm.put('/api/settings').send({ changes: { 'company.timezone': 'Mars/Olympus' } })).status).toBe(400);
    expect((await gm.put('/api/settings').send({ changes: { 'security.minPasswordLength': 4 } })).status).toBe(400);
    expect((await gm.put('/api/settings').send({ changes: { 'sales.maxDiscountPercentByRole': { CASHIER: 150 } } })).status).toBe(400);
    expect((await gm.put('/api/settings').send({ changes: { 'security.unknownKey': 1 } })).status).toBe(400);
    expect((await gm.put('/api/settings').set('Content-Type', 'application/json').send('{"changes":{"__proto__":{"polluted":true}}}')).status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const ok = await gm.put('/api/settings').send({ changes: { 'expenses.approvalThreshold': 1_600_000 } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.expenses.approvalThreshold).toBe(1_600_000);

    const huge = await cashier.post('/api/sales').send({ items: [{ itemId: 1 }], paymentMethod: 'CASH', customerName: 'x'.repeat(150_000) });
    expect(huge.status).toBe(413);
  });

  it('redacts secrets in structured logs', () => {
    const out = redact({ password: 'p', nested: { sessionToken: 't', csrf: 'c', ok: 1 }, err: new Error('Failed query: update users set password_hash=$1 params: $argon2id$abc') }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toContain('"p"');
    expect(s).not.toContain('"t"');
    expect(s).not.toContain('$argon2id$abc');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });
});
