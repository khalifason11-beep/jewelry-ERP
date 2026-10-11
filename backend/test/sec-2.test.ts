// SEC-2 (docs/plans/POS-FIXES.md §5, D-sec2-1, D-sec2-2):
// - cancelling a sale whose total is above the General Manager's amount (sales.voidReauthAboveAmount, default 0 =
//   every void) needs a fresh password confirmation, the same window and dialog as every sensitive action;
// - a final line price different from the list price needs one reason per sale, stored on the sale and in the audit
//   log (SALE_PRICE_CHANGED, prices only, no cost), never in the print payload;
// - the reason for an item price edit is required.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS } from '@jerp/shared';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { resetThrottleMemory } from '../src/auth/lockout';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS, keys = true): Promise<Agent> {
  const raw = request.agent(app);
  const agent = (keys ? withIdempotencyKeys(raw) : raw) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const reauth = async (a: Agent, role: keyof typeof DEMO_PASSWORDS) => expect((await a.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS[role] })).status).toBe(200);
const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const completedSale = async (code: string, pred: (total: number) => boolean = () => true) => {
  const rows = await ctx.db.select().from(t.sales).where(and(eq(t.sales.branchId, await branchId(code)), eq(t.sales.status, 'COMPLETED'))).orderBy(desc(t.sales.id));
  const s = rows.find((r) => pred(r.total));
  if (!s) throw new Error('no matching sale in the fixture world');
  return s;
};
const lastAudit = async (action: string) => (await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, action)).orderBy(desc(t.auditLogs.id)).limit(1))[0];
const setThreshold = async (amount: number) => {
  const gm = await login('general.manager', 'GENERAL_MANAGER');
  await reauth(gm, 'GENERAL_MANAGER');
  const r = await gm.put('/api/settings').send({ changes: { 'sales.voidReauthAboveAmount': amount } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());
beforeEach(() => resetThrottleMemory());

describe('the void threshold setting', () => {
  it('defaults to 0 (every void asks); no money amount is guessed', async () => {
    expect(DEFAULT_SETTINGS.sales.voidReauthAboveAmount).toBe(0);
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.get('/api/settings')).body.settings.sales.voidReauthAboveAmount).toBe(0);
    expect((await gm.get('/api/auth/me')).body.voidReauthAboveAmount).toBe(0);
  });

  it('only the General Manager changes it, with the password, and it is audited', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    await reauth(bm, 'BRANCH_MANAGER');
    expect((await bm.put('/api/settings').send({ changes: { 'sales.voidReauthAboveAmount': 5_000_000 } })).status).toBe(403);
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const noPw = await gm.put('/api/settings').send({ changes: { 'sales.voidReauthAboveAmount': 5_000_000 } });
    expect(noPw.status).toBe(403);
    expect(noPw.body.error.code).toBe('REAUTH_REQUIRED');
    for (const bad of [-1, 1.5, 'x']) {
      await reauth(gm, 'GENERAL_MANAGER');
      expect((await gm.put('/api/settings').send({ changes: { 'sales.voidReauthAboveAmount': bad } })).status, String(bad)).toBe(400);
    }
    await setThreshold(5_000_000);
    const audit = await lastAudit('SETTINGS_CHANGED');
    expect(JSON.stringify(audit)).toContain('sales.voidReauthAboveAmount');
    await setThreshold(0);
  });
});

describe('cancelling a sale above the amount needs the password again', () => {
  it('threshold 0: every void is refused until the password is re-entered; the same key then succeeds', async () => {
    await setThreshold(0);
    const sale = await completedSale('KRT');
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER', false);
    const key = randomUUID();
    const first = await bm.post(`/api/sales/${sale.id}/void`).set('Idempotency-Key', key).send({ reason: 'Customer returned it' });
    expect(first.status).toBe(403);
    expect(first.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await ctx.db.select().from(t.sales).where(eq(t.sales.id, sale.id)))[0].status).toBe('COMPLETED');
    await reauth(bm, 'BRANCH_MANAGER');
    // The refusal consumed no idempotency key: the retry after the dialog carries the same key.
    const again = await bm.post(`/api/sales/${sale.id}/void`).set('Idempotency-Key', key).send({ reason: 'Customer returned it' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const audit = await lastAudit('SALE_CANCELLED');
    expect(audit.metadata).toMatchObject({ reauthenticated: true, reauthAboveAmount: 0 });
    // A replay of the same request returns the same answer, even without a fresh password.
    await ctx.db.update(t.sessions).set({ reauthAt: new Date(Date.now() - 3600_000) }).where(eq(t.sessions.userId, audit.userId!));
    const replay = await bm.post(`/api/sales/${sale.id}/void`).set('Idempotency-Key', key).send({ reason: 'Customer returned it' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(again.body);
  });

  it('below or at the amount: no password; above it: the password', async () => {
    const small = await completedSale('KRT');
    await setThreshold(small.total); // equal → not above
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const ok = await bm.post(`/api/sales/${small.id}/void`).send({ reason: 'At the threshold' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await lastAudit('SALE_CANCELLED')).metadata).not.toHaveProperty('reauthenticated');

    const big = await completedSale('KRT', (total) => total > 1000);
    await setThreshold(big.total - 1);
    const refused = await bm.post(`/api/sales/${big.id}/void`).send({ reason: 'Above the threshold' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('REAUTH_REQUIRED');
    await reauth(bm, 'BRANCH_MANAGER');
    expect((await bm.post(`/api/sales/${big.id}/void`).send({ reason: 'Above the threshold' })).status).toBe(200);
  });

  it('the re-confirmation window expires (security.reauthWindowMinutes)', async () => {
    await setThreshold(0);
    const sale = await completedSale('KRT');
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    await reauth(bm, 'BRANCH_MANAGER');
    const me = (await bm.get('/api/auth/me')).body;
    const minutes = DEFAULT_SETTINGS.security.reauthWindowMinutes;
    await ctx.db.update(t.sessions).set({ reauthAt: new Date(Date.now() - (minutes + 1) * 60_000) }).where(eq(t.sessions.userId, me.user.id));
    const r = await bm.post(`/api/sales/${sale.id}/void`).send({ reason: 'Window expired' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('another branch: the ordinary refusal comes first, never a password prompt', async () => {
    await setThreshold(0);
    const omd = await completedSale('OMD');
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const r = await bm.post(`/api/sales/${omd.id}/void`).send({ reason: 'cross-branch' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).not.toBe('REAUTH_REQUIRED');
    await reauth(bm, 'BRANCH_MANAGER');
    expect((await bm.post(`/api/sales/${omd.id}/void`).send({ reason: 'cross-branch' })).status).toBe(403);
    expect((await ctx.db.select().from(t.sales).where(eq(t.sales.id, omd.id)))[0].status).toBe('COMPLETED');
  });

  it('a cashier is refused as before (no void permission), not asked for a password', async () => {
    const sale = await completedSale('KRT');
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const r = await cashier.post(`/api/sales/${sale.id}/void`).send({ reason: 'not allowed' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).not.toBe('REAUTH_REQUIRED');
  });
});

describe('a changed price needs a reason, kept internal', () => {
  const REASON = 'زبون دائم: خصم متفق عليه';
  const pieces = async (cashier: Agent, n: number) => {
    const items = (await cashier.get(`/api/inventory/items?status=AVAILABLE&limit=50`)).body.items as { id: number; sellingPrice: number; code: string }[];
    return items.slice(0, n);
  };

  it('a discounted sale without a reason is refused and nothing is recorded', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const [p] = await pieces(cashier, 1);
    const discount = Math.floor((p.sellingPrice * 0.02) / 1000) * 1000;
    expect(discount).toBeGreaterThan(0);
    for (const priceChangeReason of [undefined, '', '  ', 'ab']) {
      const r = await cashier.post('/api/sales').send({ items: [{ itemId: p.id, discount }], paymentMethod: 'CASH', ...(priceChangeReason !== undefined ? { priceChangeReason } : {}) });
      expect(r.status, JSON.stringify(priceChangeReason)).toBe(400);
    }
    expect((await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, p.id)))[0].status).toBe('AVAILABLE');
  });

  it('with a reason: stored on the sale, SALE_PRICE_CHANGED lists prices only (no cost), never printed', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const [a, b] = await pieces(cashier, 2);
    const discount = Math.floor((a.sellingPrice * 0.02) / 1000) * 1000;
    const r = await cashier.post('/api/sales').send({ items: [{ itemId: a.id, discount }, { itemId: b.id }], paymentMethod: 'CASH', priceChangeReason: `  ${REASON} ` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.priceChangeReason).toBe(REASON);
    const audit = await lastAudit('SALE_PRICE_CHANGED');
    expect(audit.entityId).toBe(r.body.number);
    expect(audit.metadata).toEqual({ reason: REASON, lines: [{ code: a.code, listPrice: a.sellingPrice, discount, finalPrice: a.sellingPrice - discount }] });
    expect(JSON.stringify(audit)).not.toMatch(/cost|profit/i);
    expect((await lastAudit('SALE_CREATED')).metadata).toMatchObject({ priceChangeReason: REASON });

    // The original print (cashier, same session) and a manager's reprint: the reason is in neither.
    const original = await cashier.post(`/api/sales/${r.body.id}/print`).send({});
    expect(original.status).toBe(200);
    expect(JSON.stringify(original.body)).not.toContain(REASON);
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const reprint = await bm.post(`/api/sales/${r.body.id}/print`).send({});
    expect(reprint.status).toBe(200);
    expect(JSON.stringify(reprint.body)).not.toContain(REASON);
    // The manager sees it on the sale detail and in the audit log.
    expect((await bm.get(`/api/sales/${r.body.id}`)).body.priceChangeReason).toBe(REASON);
  });

  it('no changed price: no reason is stored (and none is required)', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const [p] = await pieces(cashier, 1);
    const r = await cashier.post('/api/sales').send({ items: [{ itemId: p.id, discount: 0 }], paymentMethod: 'CASH', priceChangeReason: 'ignored' });
    expect(r.status).toBe(200);
    expect(r.body.priceChangeReason).toBeNull();
  });

  it('a branch manager reading the audit log sees the price-change entry without any cost', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const res = await bm.get('/api/audit?action=SALE_PRICE_CHANGED&limit=20');
    expect(res.status).toBe(200);
    const rows = (Array.isArray(res.body) ? res.body : (res.body.rows ?? res.body.items)) as unknown[];
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/cost|profit/i);
  });
});

describe('the item price edit needs a reason (Q7)', () => {
  it('refused without one, accepted and audited with one', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const [p] = (await bm.get(`/api/inventory/items?status=AVAILABLE&limit=5`)).body.items as { id: number; sellingPrice: number }[];
    for (const body of [{ sellingPrice: p.sellingPrice + 1000 }, { sellingPrice: p.sellingPrice + 1000, reason: '' }, { sellingPrice: p.sellingPrice + 1000, reason: 'ab' }]) {
      expect((await bm.post(`/api/inventory/items/${p.id}/price`).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    const ok = await bm.post(`/api/inventory/items/${p.id}/price`).send({ sellingPrice: p.sellingPrice + 1000, reason: 'Gold rate increase' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(JSON.stringify(await lastAudit('PRICE_CHANGED'))).toContain('Gold rate increase');
  });
});
