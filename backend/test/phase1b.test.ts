// Phase 1b tests: typed settings (history, versions, validation, rollback), branding and logo
// validation, branch administration, the operator console, the route permission matrix
// (GENERATED allow / deny / cross-branch tests for every route and role), and GM-only cost fields.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openTestDatabase, withIdempotencyKeys } from './helpers';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { DEFAULT_ROLE_PERMISSIONS, ROUTE_MATRIX, permitsRule, routeId, type Permission, type RouteRule } from '@jerp/shared';
import { Router } from 'express';
import { createApp } from '../src/app';
import { defineRoutes } from '../src/core/guard';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { COST_FIELDS } from '../src/core/cost-redaction';
import { resetThrottleMemory } from '../src/auth/lockout';
import { inspectLogo } from '../src/modules/branding/image';
import { operatorResetGmPassword, operatorUnlock } from '../src/modules/ops/service';
import { createSession } from '../src/modules/sessions/service';
import { hashPassword } from '../src/auth/password';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let prodApp: ReturnType<typeof createApp>;
const prodConfig = loadConfig({ APP_MODE: 'production', DATABASE_URL: 'postgres://erp:S3cure-Pw-2026@db/erp', APP_ORIGIN: 'https://erp.example.com', VITEST: '1' } as NodeJS.ProcessEnv);

type Agent = ReturnType<typeof request.agent>;
const ROLE_USER = { CASHIER: 'cashier.kh.01', BRANCH_MANAGER: 'branch.manager.kh', GENERAL_MANAGER: 'general.manager' } as const;
type Role = keyof typeof ROLE_USER;
const ROLES = Object.keys(ROLE_USER) as Role[];

async function login(username: string, password?: string): Promise<Agent> {
  const agent = withIdempotencyKeys(request.agent(app));
  const role = username.startsWith('general') ? 'GENERAL_MANAGER' : username.startsWith('branch') ? 'BRANCH_MANAGER' : 'CASHIER';
  const res = await agent.post('/api/auth/login').send({ username, password: password ?? DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
async function reauth(agent: Agent, role: Role) {
  expect((await agent.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS[role] })).status).toBe(200);
}
const gmAgent = async () => {
  const gm = await login(ROLE_USER.GENERAL_MANAGER);
  await reauth(gm, 'GENERAL_MANAGER');
  return gm;
};

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
  prodApp = createApp(ctx, prodConfig);
});
afterAll(async () => handle.close());
beforeEach(() => resetThrottleMemory());

// ───────────────────────── settings ─────────────────────────
describe('typed settings: one row per key, history, versions', () => {
  it('stores each key as its own row and records history with actor and reason', async () => {
    const gm = await gmAgent();
    const res = await gm.put('/api/settings').send({ changes: { 'purchases.scrapPriceTolerancePct': 3, 'transfers.pendingClaimStaleHours': 48 }, reason: 'Client request' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changed.sort()).toEqual(['purchases.scrapPriceTolerancePct', 'transfers.pendingClaimStaleHours']);
    const [row] = await ctx.db.select().from(t.settings).where(eq(t.settings.key, 'purchases.scrapPriceTolerancePct'));
    expect(row.value).toBe(3);
    expect(row.version).toBeGreaterThanOrEqual(1);
    const hist = await ctx.db.select().from(t.settingsHistory).where(eq(t.settingsHistory.key, 'transfers.pendingClaimStaleHours')).orderBy(desc(t.settingsHistory.id));
    expect(hist[0]).toMatchObject({ newValue: 48, actorUsername: 'general.manager', reason: 'Client request' });
    const audit = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'SETTINGS_CHANGED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(JSON.stringify(audit[0].metadata)).toContain('pendingClaimStaleHours');
    expect((await gm.get('/api/settings/history/transfers.pendingClaimStaleHours')).body[0].newValue).toBe(48);
  });

  it('exposes the new business settings with safe defaults', async () => {
    const gm = await login(ROLE_USER.GENERAL_MANAGER);
    const s = (await gm.get('/api/settings')).body.settings;
    // Phase 4 (D-4-4): supplier purchases are gold-for-gold debts by default.
    expect(s.purchases.supplierCreditEnabled).toBe(true);
    expect(s.sales.posPaymentMethods).toEqual(['CASH', 'BANK_TRANSFER', 'HASAD']);
    expect(s.purchases.requireGmApprovalForScrapOverride).toBe(true);
    expect(s.rates.goldRateScope).toBe('GLOBAL');
    expect(typeof s.rates.rateChangeMaxPct).toBe('number');
    // The demo seed configures this client's karat (D-4-1); the code default stays generic.
    expect(s.inventory.allowedKarats).toEqual([21]);
    expect(s.security.idleMinutes).toBe(60);
    // REM-2: the Hasad workspace and mock settings are gone.
    expect(s.hasad).toBeUndefined();
    expect(s.mockHasad).toBeUndefined();
  });

  it('settings_history is append-only at the database level', async () => {
    const refused = async (q: Promise<unknown>) => {
      const e = await q.then(() => null, (err: Error & { cause?: Error }) => err);
      expect(e, 'statement should have been refused').not.toBeNull();
      // Embedded PGlite (superuser): the trigger refuses. Real PostgreSQL app role: the REVOKE refuses
      // first (both layers are proven separately in test/pg/integrity.test.ts).
      expect(`${e!.message} ${e!.cause?.message ?? ''}`).toMatch(/append-only|permission denied/);
    };
    await refused(ctx.db.execute(sql`UPDATE settings_history SET reason = 'tampered'`));
    await refused(ctx.db.execute(sql`DELETE FROM settings_history`));
    await refused(ctx.db.execute(sql`TRUNCATE settings_history`));
    expect((await ctx.db.select().from(t.settingsHistory)).length).toBeGreaterThan(0);
  });

  it('rejects a stale version (409) and rolls back the whole change set', async () => {
    const gm = await gmAgent();
    const versions = (await gm.get('/api/settings')).body.versions;
    await gm.put('/api/settings').send({ changes: { 'rates.rateChangeMaxPct': 7 } });
    const before = (await gm.get('/api/settings')).body.settings.transfers.pendingClaimStaleHours;
    const stale = await gm.put('/api/settings').send({
      changes: { 'transfers.pendingClaimStaleHours': before + 1, 'rates.rateChangeMaxPct': 9 },
      expectedVersions: { 'transfers.pendingClaimStaleHours': versions['transfers.pendingClaimStaleHours'], 'rates.rateChangeMaxPct': versions['rates.rateChangeMaxPct'] },
    });
    expect(stale.status).toBe(409);
    const after = (await gm.get('/api/settings')).body.settings;
    expect(after.transfers.pendingClaimStaleHours).toBe(before); // first key rolled back too
    expect(after.rates.rateChangeMaxPct).toBe(7);
  });

  it('validates values and cross-field rules; one bad key rejects the whole request', async () => {
    const gm = await gmAgent();
    const bad = await gm.put('/api/settings').send({ changes: { 'rates.goldRateScope': 'BRANCH', 'inventory.allowedKarats': [18, 18] } });
    expect(bad.status).toBe(400);
    expect((await gm.get('/api/settings')).body.settings.rates.goldRateScope).toBe('GLOBAL');
    const cross = await gm.put('/api/settings').send({ changes: { 'security.lockoutMaxMinutes': 5 } }); // below lockoutBaseMinutes (15)
    expect(cross.status).toBe(400);
    expect(cross.body.error.params.field).toBe('security.lockoutMaxMinutes');
    expect((await gm.put('/api/settings').send({ changes: { 'branding.logoAssetId': 1 } })).status).toBe(403);
  });

  it('refuses removed (former demo-only) settings in production and non-GM callers', async () => {
    const u = (await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager')))[0];
    const s = await createSession(ctx.db, { userId: u.id, branchId: null, absoluteHours: 12 });
    await ctx.db.update(t.sessions).set({ reauthAt: new Date() }).where(eq(t.sessions.id, s.id));
    const res = await request(prodApp)
      .put('/api/settings')
      .set('Cookie', `${prodConfig.cookieName}=${s.token}`)
      .set('x-csrf-token', s.csrfToken)
      .set('Origin', prodConfig.appOrigin!)
      .send({ changes: { 'mockHasad.simulateOutage': true } });
    expect(res.status).toBe(400); // REM-2: no longer a setting at all
    expect(res.body.error.key).toBe('Unknown setting: {key}');
    const bm = await login(ROLE_USER.BRANCH_MANAGER);
    expect((await bm.put('/api/settings').send({ changes: { 'security.idleMinutes': 30 } })).body.error.key).toBe('Missing permission: {permission}');
  });
});

// ───────────────────────── branding ─────────────────────────
function png(w: number, h: number, extra = 0): Buffer {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webp(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe('branding and logo upload', () => {
  it('accepts PNG/JPEG/WebP by magic bytes and rejects everything else', () => {
    expect(inspectLogo(png(200, 100), 'image/png')).toMatchObject({ ok: true, info: { mime: 'image/png', width: 200, height: 100 } });
    expect(inspectLogo(jpeg(640, 480), 'image/jpeg')).toMatchObject({ ok: true, info: { mime: 'image/jpeg', width: 640, height: 480 } });
    expect(inspectLogo(webp(512, 256), 'image/webp')).toMatchObject({ ok: true, info: { mime: 'image/webp', width: 512, height: 256 } });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(inspectLogo(svg, 'image/svg+xml')).toEqual({ ok: false, problem: 'UNSUPPORTED_TYPE' });
    expect(inspectLogo(svg, 'image/png')).toEqual({ ok: false, problem: 'UNSUPPORTED_TYPE' });
    expect(inspectLogo(png(10, 10), 'image/jpeg')).toEqual({ ok: false, problem: 'TYPE_MISMATCH' });
    expect(inspectLogo(png(2000, 100), 'image/png')).toEqual({ ok: false, problem: 'TOO_MANY_PIXELS' });
    expect(inspectLogo(png(10, 10, 600 * 1024), 'image/png')).toEqual({ ok: false, problem: 'TOO_LARGE' });
    expect(inspectLogo(Buffer.from('GIF89a......'), 'image/gif')).toEqual({ ok: false, problem: 'UNSUPPORTED_TYPE' });
    expect(inspectLogo(Buffer.alloc(0), 'image/png')).toEqual({ ok: false, problem: 'EMPTY' });
  });

  it('lets only a re-authenticated GM upload; serves it publicly; audits the change', async () => {
    const bm = await login(ROLE_USER.BRANCH_MANAGER);
    expect((await bm.post('/api/branding/logo').set('Content-Type', 'image/png').send(png(64, 64))).status).toBe(403);
    const gm = await login(ROLE_USER.GENERAL_MANAGER);
    expect((await gm.post('/api/branding/logo').set('Content-Type', 'image/png').send(png(64, 64))).body.error.code).toBe('REAUTH_REQUIRED');
    await reauth(gm, 'GENERAL_MANAGER');
    const svg = await gm.post('/api/branding/logo').set('Content-Type', 'image/svg+xml').send(Buffer.from('<svg/>'));
    expect(svg.status).toBe(400);
    const up = await gm.post('/api/branding/logo').set('Content-Type', 'image/png').send(png(64, 32));
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const meta = await request(app).get('/api/meta');
    expect(meta.body.branding.logoUrl).toBe(`/api/branding/logo?v=${up.body.assetId}`);
    const file = await request(app).get('/api/branding/logo');
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'BRANDING_CHANGED'))).length).toBeGreaterThan(0);
    expect((await gm.delete('/api/branding/logo')).status).toBe(200);
    expect((await request(app).get('/api/branding/logo')).status).toBe(404);
  });

  it('rejects an oversized upload before reading it all', async () => {
    const gm = await gmAgent();
    const res = await gm.post('/api/branding/logo').set('Content-Type', 'image/png').send(png(10, 10, 700 * 1024));
    expect([400, 413]).toContain(res.status);
  });

  it('serves company names and currency labels from settings (no hardcoded name)', async () => {
    const gm = await gmAgent();
    await gm.put('/api/settings').send({ changes: { 'company.nameEn': 'Test Gold Co', 'company.nameAr': 'شركة الذهب', 'company.currencyLabelEn': 'SDG' } });
    const meta = (await request(app).get('/api/meta')).body.branding;
    expect(meta.company).toEqual({ nameEn: 'Test Gold Co', nameAr: 'شركة الذهب' });
    expect(meta.currency.labelAr).toBe('ج.س');
    expect((await gm.get('/api/auth/me')).body.branding.company.nameEn).toBe('Test Gold Co');
  });
});

// ───────────────────────── branches ─────────────────────────
describe('branch administration', () => {
  it('GM creates and edits branches (re-auth, audited); codes are unique and immutable', async () => {
    const gm = await gmAgent();
    const created = await gm.post('/api/branches').send({ code: 'KSL', name: 'Kassala Branch', nameAr: 'فرع كسلا', city: 'Kassala' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await gm.post('/api/branches').send({ code: 'KSL', name: 'Other', nameAr: 'آخر', city: 'Other city' })).status).toBe(409);
    expect((await gm.post('/api/branches').send({ code: 'ksl1', name: 'Bad', nameAr: 'سيء', city: 'Bad city' })).status).toBe(400);
    const edited = await gm.patch(`/api/branches/${created.body.id}`).send({ city: 'Kassala City', phone: '+249 411 000 000' });
    expect(edited.body.city).toBe('Kassala City');
    expect((await gm.patch(`/api/branches/${created.body.id}`).send({ code: 'KSX' })).status).toBe(400);
    const e = await ctx.db.execute(sql`UPDATE branches SET code = 'KSX' WHERE code = 'KSL'`).then(() => null, (err: Error & { cause?: Error }) => err);
    expect(`${e?.message} ${e?.cause?.message ?? ''}`).toMatch(/immutable/);
    const audits = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.entityType, 'branch'), eq(t.auditLogs.entityId, 'KSL')));
    expect(audits.map((a) => a.action).sort()).toEqual(['BRANCH_CREATED', 'BRANCH_UPDATED']);
  });

  it('branch managers and cashiers cannot create or edit branches', async () => {
    for (const role of ['BRANCH_MANAGER', 'CASHIER'] as const) {
      const a = await login(ROLE_USER[role]);
      await reauth(a, role);
      expect((await a.post('/api/branches').send({ code: 'NOPE', name: 'No', nameAr: 'لا', city: 'No' })).status).toBe(403);
      expect((await a.patch('/api/branches/1').send({ city: 'Hacked' })).status).toBe(403);
    }
  });
});

// ───────────────────────── operator console ─────────────────────────
describe('operator console (break-glass)', () => {
  const op = { host: 'test-host', osUser: 'ops' };

  it('unlocks a locked GM and audits it as operator-cli', async () => {
    await ctx.db.update(t.users).set({ failedLoginCount: 9, lockedUntil: new Date(Date.now() + 3600_000) }).where(eq(t.users.username, 'general.manager'));
    await operatorUnlock(ctx, 'general.manager', op);
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
    expect(u.lockedUntil).toBeNull();
    const [a] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'USER_UNLOCKED'), eq(t.auditLogs.username, 'operator-cli'))).orderBy(desc(t.auditLogs.id));
    expect(a.metadata).toMatchObject(op);
  });

  it('resets a GM password (forced change, sessions ended) but refuses non-GM accounts', async () => {
    await expect(operatorResetGmPassword(ctx, 'cashier.kh.01', op)).rejects.toMatchObject({ code: 'NOT_A_GM' });
    const gm = await login(ROLE_USER.GENERAL_MANAGER);
    const r = await operatorResetGmPassword(ctx, 'general.manager', op);
    expect(r.temporaryPassword).toMatch(/^Temp-/);
    expect((await gm.get('/api/auth/me')).status).toBe(401);
    const fresh = withIdempotencyKeys(request.agent(app));
    expect((await fresh.post('/api/auth/login').send({ username: 'general.manager', password: r.temporaryPassword })).body.user.mustChangePassword).toBe(true);
    // Restore the demo password for the remaining tests.
    await ctx.db.update(t.users).set({ passwordHash: await hashPassword(DEMO_PASSWORDS.GENERAL_MANAGER), mustChangePassword: false }).where(eq(t.users.username, 'general.manager'));
  });
});

// ───────────────────────── route permission matrix (generated) ─────────────────────────
type Req = { method?: string; path: string; query?: Record<string, string | number>; body?: unknown; contentType?: string };
interface Fixtures {
  krt: number; omd: number; krtItem: number; omdItem: number; krtSale: number; omdSale: number; krtPurchase: number; omdPurchase: number;
  omdTransferTo: number; omdUser: number; omdSessionKey: string;
}
const NONE = 999_999;

/** A request for every rule that passes validation-free guards without mutating real data. */
const SAMPLE: Record<string, (f: Fixtures) => Req> = {
  'POST /auth/login': () => ({ path: '/auth/login', body: {} }),
  'GET /meta': () => ({ path: '/meta' }),
  'GET /health': () => ({ path: '/health' }),
  'GET /branding/logo': () => ({ path: '/branding/logo' }),
  'GET /auth/me': () => ({ path: '/auth/me' }),
  'POST /auth/logout': () => ({ path: '/auth/logout' }),
  'POST /auth/change-password': () => ({ path: '/auth/change-password', body: {} }),
  'POST /auth/reauth': () => ({ path: '/auth/reauth', body: {} }),
  'POST /auth/login/passkey/options': () => ({ path: '/auth/login/passkey/options', body: {} }),
  'POST /auth/login/passkey/verify': () => ({ path: '/auth/login/passkey/verify', body: {} }),
  'POST /auth/login/recovery': () => ({ path: '/auth/login/recovery', body: {} }),
  'POST /auth/login/cancel': () => ({ path: '/auth/login/cancel', body: {} }),
  'POST /auth/reauth/passkey/options': () => ({ path: '/auth/reauth/passkey/options', body: { unexpected: 1 } }),
  'POST /auth/reauth/passkey/verify': () => ({ path: '/auth/reauth/passkey/verify', body: {} }),
  'GET /auth/passkeys': () => ({ path: '/auth/passkeys' }),
  'POST /auth/passkeys/register/options': () => ({ path: '/auth/passkeys/register/options', body: {} }),
  'POST /auth/passkeys/register/verify': () => ({ path: '/auth/passkeys/register/verify', body: {} }),
  'DELETE /auth/passkeys/:id': () => ({ path: `/auth/passkeys/${NONE}` }),
  'POST /auth/recovery-codes': () => ({ path: '/auth/recovery-codes', body: { unexpected: 1 } }),
  'POST /auth/recovery-codes/acknowledge': () => ({ path: '/auth/recovery-codes/acknowledge', body: {} }),
  'GET /auth/sign-ins': () => ({ path: '/auth/sign-ins' }),
  'POST /auth/sign-ins/:id/dismiss': () => ({ path: `/auth/sign-ins/${NONE}/dismiss` }),
  'POST /auth/sign-ins/:id/not-me': () => ({ path: `/auth/sign-ins/${NONE}/not-me` }),
  'PUT /security/second-factor': () => ({ path: '/security/second-factor', body: {} }),
  'POST /sessions/heartbeat': () => ({ path: '/sessions/heartbeat' }),
  'GET /notifications': () => ({ path: '/notifications' }),
  'POST /client-errors': () => ({ path: '/client-errors', body: { ref: 'ERR-MATRIX01', path: '/x', message: 'TypeError: matrix sample' } }),
  'GET /branches': () => ({ path: '/branches' }),
  'GET /branches/directory': () => ({ path: '/branches/directory' }),
  'GET /categories': () => ({ path: '/categories' }),
  'GET /gold-rates': () => ({ path: '/gold-rates' }),
  'GET /products': () => ({ path: '/products' }),
  'GET /suppliers': () => ({ path: '/suppliers' }),
  'POST /categories': () => ({ path: '/categories', body: {} }),
  'POST /categories/:id/deactivate': () => ({ path: `/categories/${NONE}/deactivate`, body: {} }),
  'POST /categories/:id/reactivate': () => ({ path: `/categories/${NONE}/reactivate`, body: {} }),
  'POST /products': () => ({ path: '/products', body: {} }),
  'POST /products/:id/deactivate': () => ({ path: `/products/${NONE}/deactivate`, body: {} }),
  'POST /products/:id/reactivate': () => ({ path: `/products/${NONE}/reactivate`, body: {} }),
  'POST /suppliers': () => ({ path: '/suppliers', body: {} }),
  'GET /roles': () => ({ path: '/roles' }),
  'GET /branches/:id': (f) => ({ path: `/branches/${f.krt}` }),
  'POST /gold-rates': () => ({ path: '/gold-rates', body: {} }),
  'GET /settings': () => ({ path: '/settings' }),
  'PUT /settings': () => ({ path: '/settings', body: {} }),
  'GET /settings/history/:key': () => ({ path: '/settings/history/security.idleMinutes' }),
  'POST /branding/logo': () => ({ path: '/branding/logo', body: Buffer.from('x'), contentType: 'image/png' }),
  'DELETE /branding/logo': () => ({ path: '/branding/logo' }),
  'POST /branches': () => ({ path: '/branches', body: {} }),
  'PATCH /branches/:id': () => ({ path: `/branches/${NONE}`, body: {} }),
  'GET /sessions': () => ({ path: '/sessions' }),
  'POST /sessions/:key/revoke': () => ({ path: '/sessions/0000000000000000/revoke' }),
  'GET /users': () => ({ path: '/users' }),
  'POST /users': () => ({ path: '/users', body: {} }),
  'PATCH /users/:id': () => ({ path: `/users/${NONE}`, body: {} }),
  'POST /users/:id/reset-password': () => ({ path: `/users/${NONE}/reset-password` }),
  'POST /users/:id/disable': () => ({ path: `/users/${NONE}/disable` }),
  'POST /users/:id/enable': () => ({ path: `/users/${NONE}/enable` }),
  'POST /users/:id/unlock': () => ({ path: `/users/${NONE}/unlock` }),
  'GET /inventory/items': () => ({ path: '/inventory/items', query: { limit: 5 } }),
  'GET /inventory/items/:id': (f) => ({ path: `/inventory/items/${f.krtItem}` }),
  'POST /inventory/items/:id/price': () => ({ path: `/inventory/items/${NONE}/price`, body: {} }),
  'POST /inventory/items/:id/adjust': () => ({ path: `/inventory/items/${NONE}/adjust`, body: {} }),
  'POST /sales': () => ({ path: '/sales', body: {} }),
  'GET /sales': () => ({ path: '/sales' }),
  'GET /sales/:id': (f) => ({ path: `/sales/${f.krtSale}` }),
  'POST /sales/:id/print': () => ({ path: `/sales/${NONE}/print`, body: {} }),
  'POST /sales/:id/void': () => ({ path: `/sales/${NONE}/void`, body: {} }),
  'GET /purchases': () => ({ path: '/purchases' }),
  'GET /purchases/:id': () => ({ path: `/purchases/${NONE}` }),
  'POST /purchases': () => ({ path: '/purchases', body: {} }),
  'GET /transfers': () => ({ path: '/transfers' }),
  'POST /transfers': () => ({ path: '/transfers', body: {} }),
  'POST /transfers/:id/receive': () => ({ path: `/transfers/${NONE}/receive` }),
  'GET /dashboard/branch': () => ({ path: '/dashboard/branch' }),
  'GET /cash/drawer': () => ({ path: '/cash/drawer' }),
  'GET /backups/status': () => ({ path: '/backups/status' }),
  'GET /cash/reconciliation': () => ({ path: '/cash/reconciliation' }),
  'POST /cash/counts': () => ({ path: '/cash/counts', body: {} }),
  'GET /scrap-rates': () => ({ path: '/scrap-rates' }),
  'GET /cash/hasad-settlements': () => ({ path: '/cash/hasad-settlements' }),
  'POST /cash/hasad-settlements': () => ({ path: '/cash/hasad-settlements', body: {} }),
  'POST /scrap-rates': () => ({ path: '/scrap-rates', body: {} }),
  'GET /scrap-purchases': () => ({ path: '/scrap-purchases' }),
  'POST /scrap-purchases': () => ({ path: '/scrap-purchases', body: {} }),
  'GET /scrap-pool': () => ({ path: '/scrap-pool' }),
  'POST /purchases/:id/settlements': (f) => ({ path: `/purchases/${f.krtPurchase}/settlements`, body: {} }),
  'GET /dashboard/company': () => ({ path: '/dashboard/company' }),
  'GET /reports/:key': () => ({ path: '/reports/sales' }),
  'GET /audit': () => ({ path: '/audit', query: { limit: 5 } }),
  'GET /setup/status': () => ({ path: '/setup/status' }),
  'POST /setup/allowed-karats': () => ({ path: '/setup/allowed-karats', body: { allowedKarats: [18, 21, 22, 24] } }),
};

/** For every branch-scoped rule: a request by a Khartoum user that targets Omdurman data. */
const CROSS: Record<string, (f: Fixtures) => Req> = {
  'GET /branches/:id': (f) => ({ path: `/branches/${f.omd}` }),
  'GET /sessions': (f) => ({ path: '/sessions', query: { branchId: f.omd } }),
  'POST /sessions/:key/revoke': (f) => ({ path: `/sessions/${f.omdSessionKey}/revoke` }),
  'GET /users': (f) => ({ path: '/users', query: { branchId: f.omd } }),
  'POST /users': (f) => ({ path: '/users', body: { username: 'x.cross', fullName: 'Cross User', roleCode: 'CASHIER', branchId: f.omd } }),
  'PATCH /users/:id': (f) => ({ path: `/users/${f.omdUser}`, body: { fullName: 'Hacked' } }),
  'POST /users/:id/reset-password': (f) => ({ path: `/users/${f.omdUser}/reset-password` }),
  'POST /users/:id/disable': (f) => ({ path: `/users/${f.omdUser}/disable` }),
  'POST /users/:id/enable': (f) => ({ path: `/users/${f.omdUser}/enable` }),
  'POST /users/:id/unlock': (f) => ({ path: `/users/${f.omdUser}/unlock` }),
  'GET /inventory/items': (f) => ({ path: '/inventory/items', query: { branchId: f.omd } }),
  'GET /inventory/items/:id': (f) => ({ path: `/inventory/items/${f.omdItem}` }),
  'POST /inventory/items/:id/price': (f) => ({ path: `/inventory/items/${f.omdItem}/price`, body: { sellingPrice: 1, reason: 'cross' } }),
  'POST /inventory/items/:id/adjust': (f) => ({ path: `/inventory/items/${f.omdItem}/adjust`, body: { action: 'MARK_DAMAGED', reason: 'cross-branch' } }),
  'POST /sales': (f) => ({ path: '/sales', body: { branchId: f.omd, items: [{ itemId: f.omdItem }], paymentMethod: 'CASH' } }),
  'GET /sales': (f) => ({ path: '/sales', query: { branchId: f.omd } }),
  'GET /sales/:id': (f) => ({ path: `/sales/${f.omdSale}` }),
  'POST /sales/:id/print': (f) => ({ path: `/sales/${f.omdSale}/print`, body: {} }),
  'POST /sales/:id/void': (f) => ({ path: `/sales/${f.omdSale}/void`, body: { reason: 'cross-branch' } }),
  'GET /purchases': (f) => ({ path: '/purchases', query: { branchId: f.omd } }),
  'GET /purchases/:id': (f) => ({ path: `/purchases/${f.omdPurchase}` }),
  'POST /purchases': (f) => ({ path: '/purchases', body: { branchId: f.omd, lines: [{ productId: 1, grossWeightMg: 5000, netWeightMg: 4800, purchaseCost: 100, makingCost: 0, otherCost: 0, sellingPrice: 200 }] } }),
  'GET /transfers': (f) => ({ path: '/transfers', query: { branchId: f.omd } }),
  'POST /transfers': (f) => ({ path: '/transfers', body: { fromBranchId: f.omd, toBranchId: f.krt, itemIds: [f.omdItem] } }),
  'POST /transfers/:id/receive': (f) => ({ path: `/transfers/${f.omdTransferTo}/receive` }),
  'GET /dashboard/branch': (f) => ({ path: '/dashboard/branch', query: { branchId: f.omd } }),
  'GET /reports/:key': (f) => ({ path: '/reports/sales', query: { branchId: f.omd } }),
  'GET /audit': (f) => ({ path: '/audit', query: { branchId: f.omd } }),
  'GET /cash/drawer': (f) => ({ path: '/cash/drawer', query: { branchId: f.omd } }),
  'GET /cash/reconciliation': (f) => ({ path: '/cash/reconciliation', query: { branchId: f.omd } }),
  'POST /cash/counts': (f) => ({ path: '/cash/counts', body: { branchId: f.omd, day: '2026-01-01', countedAmount: 1 } }),
  'GET /scrap-purchases': (f) => ({ path: '/scrap-purchases', query: { branchId: f.omd } }),
  'GET /cash/hasad-settlements': (f) => ({ path: '/cash/hasad-settlements', query: { branchId: f.omd } }),
  'POST /cash/hasad-settlements': (f) => ({ path: '/cash/hasad-settlements', body: { branchId: f.omd, amount: 1 } }),
  'POST /scrap-purchases': (f) => ({ path: '/scrap-purchases', body: { branchId: f.omd, kind: 'BROKEN', karat: 21, grossWeightMg: 1000, netWeightMg: 1000, paymentMethod: 'CASH' } }),
  'GET /scrap-pool': (f) => ({ path: '/scrap-pool', query: { branchId: f.omd } }),
  'POST /purchases/:id/settlements': (f) => ({ path: `/purchases/${f.omdPurchase}/settlements`, body: { karat: 21, weightMg: 1000 } }),
};

let F: Fixtures;
const agents = {} as Record<Role, Agent>;

async function send(agent: Agent | ReturnType<typeof request>, rule: RouteRule, r: Req) {
  const method = (r.method ?? rule.method).toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let q = (agent as Agent)[method](`/api${r.path}`);
  if (r.query) q = q.query(r.query);
  if (r.contentType) q = q.set('Content-Type', r.contentType);
  return r.body !== undefined ? q.send(r.body as object) : q;
}
const deniedByGuard = (res: request.Response) =>
  (res.status === 401 && (res.body?.error?.code ?? 'UNAUTHORIZED') === 'UNAUTHORIZED') || (res.status === 403 && /^(Missing permission|Requires one of)/.test(res.body?.error?.key ?? ''));
/** Any object in the payload that belongs to another branch. */
function leaksBranch(body: unknown, omd: number): boolean {
  if (body == null || typeof body !== 'object') return false;
  if (Array.isArray(body)) return body.some((x) => leaksBranch(x, omd));
  const o = body as Record<string, unknown>;
  if (o.branchId === omd || o.fromBranchId === omd || o.branchCode === 'OMD') return true;
  return Object.values(o).some((v) => leaksBranch(v, omd));
}

describe('route permission matrix (generated from shared/src/route-matrix.ts)', () => {
  beforeAll(async () => {
    const id = async (q: Promise<{ id: number }[]>) => (await q)[0].id;
    const krt = await id(ctx.db.select({ id: t.branches.id }).from(t.branches).where(eq(t.branches.code, 'KRT')));
    const omd = await id(ctx.db.select({ id: t.branches.id }).from(t.branches).where(eq(t.branches.code, 'OMD')));
    const [omdSession] = await ctx.db.select({ id: t.sessions.id }).from(t.sessions).where(eq(t.sessions.branchId, omd)).limit(1);
    F = {
      krt,
      omd,
      krtItem: await id(ctx.db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, krt), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(1)),
      omdItem: await id(ctx.db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, omd), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(1)),
      krtSale: await id(ctx.db.select({ id: t.sales.id }).from(t.sales).where(eq(t.sales.branchId, krt)).limit(1)),
      omdSale: await id(ctx.db.select({ id: t.sales.id }).from(t.sales).where(and(eq(t.sales.branchId, omd), eq(t.sales.status, 'COMPLETED'))).limit(1)),
      krtPurchase: await id(ctx.db.select({ id: t.purchases.id }).from(t.purchases).where(eq(t.purchases.branchId, krt)).limit(1)),
      omdPurchase: await id(ctx.db.select({ id: t.purchases.id }).from(t.purchases).where(eq(t.purchases.branchId, omd)).limit(1)),
      omdTransferTo: await id(ctx.db.select({ id: t.transfers.id }).from(t.transfers).where(ne(t.transfers.toBranchId, krt)).limit(1)),
      omdUser: await id(ctx.db.select({ id: t.users.id }).from(t.users).where(eq(t.users.branchId, omd)).limit(1)),
      omdSessionKey: omdSession.id.slice(0, 16),
    };
    for (const role of ROLES) {
      agents[role] = await login(ROLE_USER[role]);
      await reauth(agents[role], role); // so re-auth never masks a permission or branch decision
    }
  });

  it('every registered route is in the matrix and every matrix rule is registered', () => {
    const ids = (rules: RouteRule[]) => rules.map((x) => routeId(x.method, x.path)).sort();
    expect(ids(app.locals.apiRoutes)).toEqual(ids([...ROUTE_MATRIX]));
    expect(ids(prodApp.locals.apiRoutes)).toEqual(ids([...ROUTE_MATRIX])); // REM-3: no demo-only route exists
    // GM: no destructive operation on business data in production.
    expect(prodApp.locals.apiRoutes.filter((x: RouteRule) => x.destructive)).toEqual([]);
  });

  it('refuses to register a route that is not in the matrix (fails at start-up)', () => {
    const reg = defineRoutes(Router(), ctx, { demo: true });
    expect(() => reg.route('GET', '/secret/unlisted', (_req, res) => res.json({}))).toThrow(/not in ROUTE_MATRIX/);
    const prod = defineRoutes(Router(), ctx, { demo: false });
    // REM-3: the demo reset is gone; it is not in the matrix, so it can never be registered.
    expect(() => prod.route('POST', '/demo/reset', (_req, res) => res.json({}))).toThrow(/not in ROUTE_MATRIX/);
  });

  it('has a sample request for every rule and a cross-branch request for every branch-scoped rule', () => {
    for (const rule of ROUTE_MATRIX) {
      const id = routeId(rule.method, rule.path);
      expect(SAMPLE[id], `SAMPLE missing for ${id}`).toBeTypeOf('function');
      if (rule.scope === 'branch') expect(CROSS[id], `CROSS missing for ${id}`).toBeTypeOf('function');
    }
  });

  for (const rule of ROUTE_MATRIX) {
    const id = routeId(rule.method, rule.path);
    describe(id, () => {
      if (rule.scope !== 'public') {
        it('anonymous → 401', async () => {
          const res = await send(request(app), rule, SAMPLE[id](F));
          expect(res.status).toBe(401);
        });
      }
      for (const role of ROLES) {
        const perms = new Set<Permission>(DEFAULT_ROLE_PERMISSIONS[role]);
        const allowed = permitsRule(rule, (p) => perms.has(p));
        it(`${role} → ${allowed ? 'allowed' : 'denied'}`, async () => {
          if (id === 'POST /auth/logout') {
            const fresh = await login(ROLE_USER[role]);
            const res = await send(fresh, rule, SAMPLE[id](F));
            expect(deniedByGuard(res)).toBe(false);
            return;
          }
          // Destructive routes are probed without re-auth, so an allowed call stops at REAUTH_REQUIRED
          // instead of executing (and wiping the test database).
          const agent = rule.destructive ? await login(ROLE_USER[role]) : agents[role];
          const res = await send(agent, rule, SAMPLE[id](F));
          if (rule.destructive && allowed) expect(res.body.error?.code).toBe('REAUTH_REQUIRED');
          if (allowed) expect(deniedByGuard(res), `${res.status} ${JSON.stringify(res.body)}`).toBe(false);
          else {
            expect(res.status).toBe(403);
            expect(res.body.error.key).toMatch(/^(Missing permission|Requires one of)/);
          }
        });
        if (rule.scope === 'branch' && role !== 'GENERAL_MANAGER') {
          it(`${role} of KRT cannot reach OMD data`, async () => {
            const res = await send(agents[role], rule, CROSS[id](F));
            if (res.status === 200) expect(leaksBranch(res.body, F.omd), JSON.stringify(res.body).slice(0, 300)).toBe(false);
            else expect([400, 403, 404]).toContain(res.status);
            if (res.status === 400) expect(res.body.error.code).not.toBe('BAD_REQUEST_SCHEMA'); // validation never replaces the branch check
          });
        }
      }
    });
  }

  it('cross-branch mutations never changed Omdurman data', async () => {
    const [sale] = await ctx.db.select().from(t.sales).where(eq(t.sales.id, F.omdSale));
    expect(sale.status).toBe('COMPLETED');
    const [item] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, F.omdItem));
    expect(item.status).toBe('AVAILABLE');
    expect(item.sellingPrice).toBeGreaterThan(1);
    const [user] = await ctx.db.select().from(t.users).where(eq(t.users.id, F.omdUser));
    expect(user.fullName).not.toBe('Hacked');
    expect(user.status).toBe('ACTIVE');
  });
});

// ───────────────────────── GM-only cost visibility ─────────────────────────
function costKeys(body: unknown, found = new Set<string>()): Set<string> {
  if (body && typeof body === 'object') {
    if (Array.isArray(body)) {
      for (const x of body) {
        if (x && typeof x === 'object' && !Array.isArray(x) && typeof (x as { key?: unknown }).key === 'string' && COST_FIELDS.has((x as { key: string }).key)) found.add(`column:${(x as { key: string }).key}`);
        costKeys(x, found);
      }
    } else {
      for (const [k, v] of Object.entries(body)) {
        if (COST_FIELDS.has(k)) found.add(k);
        costKeys(v, found);
      }
    }
  }
  return found;
}

describe('cost, acquisition cost and profit are GM-only (Q15)', () => {
  const endpoints = async () => {
    const [sale] = await ctx.db.select({ id: t.sales.id }).from(t.sales).where(eq(t.sales.branchId, F.krt)).limit(1);
    const [purchase] = await ctx.db.select({ id: t.purchases.id }).from(t.purchases).where(eq(t.purchases.branchId, F.krt)).limit(1);
    return [
      '/inventory/items',
      `/inventory/items/${F.krtItem}`,
      '/sales',
      `/sales/${sale.id}`,
      '/purchases',
      `/purchases/${purchase.id}`,
      '/dashboard/branch',
      '/reports/sales',
      '/reports/purchases',
      '/reports/inventory',
      '/reports/inventory-movement',
      '/reports/inventory-ledger',
      '/transfers',
      '/notifications',
    ];
  };

  it('branch managers never receive cost or profit fields', async () => {
    const bm = agents.BRANCH_MANAGER;
    for (const path of await endpoints()) {
      const res = await bm.get(`/api${path}`);
      if (res.status !== 200) continue; // not permitted for this role at all
      expect([...costKeys(res.body)], path).toEqual([]);
    }
    expect((await bm.get('/api/reports/profit')).status).toBe(403);
  });

  it('cashiers never receive cost or profit fields', async () => {
    const cashier = agents.CASHIER;
    for (const path of await endpoints()) {
      const res = await cashier.get(`/api${path}`);
      if (res.status !== 200) continue;
      expect([...costKeys(res.body)], path).toEqual([]);
    }
  });

  it('the General Manager does receive them', async () => {
    const gm = agents.GENERAL_MANAGER;
    const items = await gm.get('/api/inventory/items').query({ limit: 3 });
    expect(items.body.items[0]).toHaveProperty('totalCost');
    const report = await gm.get('/api/reports/sales');
    expect(report.body.columns.map((c: { key: string }) => c.key)).toContain('grossProfit');
  });
});
