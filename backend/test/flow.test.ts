// End-to-end API tests for the first milestone (vertical slice) and the security rules.
// Runs against a fresh in-memory PostgreSQL (PGlite) seeded with the demo data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { hasadMockTables } from '@jerp/hasad';
import { createApp } from '../src/app';
import { createContext, openDatabase } from '../src/bootstrap';
import type { Ctx } from '../src/core/context';
import { seedDemo } from '../src/seed/demo';
import { movementSummary } from '../src/modules/reports/metrics';
import { periodFor } from '../src/modules/dashboard/service';
import { DEMO_PASSWORDS } from '../src/seed/catalog';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;

async function login(username: string, password?: string) {
  const agent = request.agent(app);
  const role = username.startsWith('general') ? 'GENERAL_MANAGER' : username.startsWith('branch') ? 'BRANCH_MANAGER' : 'CASHIER';
  const res = await agent.post('/api/auth/login').send({ username, password: password ?? DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return agent;
}

async function itemByCode(code: string) {
  const [i] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.code, code));
  return i;
}

beforeAll(async () => {
  handle = await openDatabase({ dataDir: 'memory://' });
  ctx = createContext(handle);
  await seedDemo(ctx);
  await ctx.settings.update(ctx.db, { mockHasad: { latencyMs: 0, simulateOutage: false } }, null);
  app = createApp(ctx);
});

afterAll(async () => {
  await handle.close();
});

describe('demo data', () => {
  it('has 4 branches and more than 100 available pieces', async () => {
    const items = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.status, 'AVAILABLE'));
    expect(items.length).toBeGreaterThanOrEqual(100);
    const branches = await ctx.db.select().from(t.branches);
    expect(branches).toHaveLength(4);
  });

  it('ledger-derived closing stock reconciles with live item statuses', async () => {
    const period = await periodFor(ctx);
    const summary = await movementSummary(ctx.db, period, null);
    for (const m of summary) {
      expect(m.closing.items, `branch ${m.branchId}`).toBe(m.actual!.items);
      expect(m.closing.weightMg).toBe(m.actual!.weightMg);
    }
  });

  it('never stores plaintext passwords', async () => {
    const users = await ctx.db.select().from(t.users);
    for (const u of users) {
      expect(u.passwordHash.startsWith('scrypt$')).toBe(true);
      expect(u.passwordHash).not.toContain('demo-');
    }
  });
});

describe('data isolation (enforced by the API, not the UI)', () => {
  it('cashier only sees own branch and cannot reach other branches or admin data', async () => {
    const cashier = await login('cashier.kh.01');
    const me = (await cashier.get('/api/auth/me')).body;
    const krt = me.user.branch.id;

    const items = await cashier.get('/api/inventory/items');
    expect(items.status).toBe(200);
    expect(items.body.items.every((i: { branchId: number }) => i.branchId === krt)).toBe(true);
    expect(items.body.items[0].totalCost).toBeUndefined(); // no cost data for cashiers

    const other = krt === 1 ? 2 : 1;
    expect((await cashier.get(`/api/inventory/items?branchId=${other}`)).status).toBe(403);
    expect((await cashier.get(`/api/dashboard/branch?branchId=${other}`)).status).toBe(403);
    expect((await cashier.get('/api/dashboard/company')).status).toBe(403);
    expect((await cashier.get('/api/users')).status).toBe(403);
    expect((await cashier.get('/api/audit')).status).toBe(403);
    expect((await cashier.get('/api/reports/profit')).status).toBe(403);
    expect((await cashier.post('/api/users').send({ username: 'new.cashier', fullName: 'New Cashier', roleCode: 'CASHIER', branchId: krt })).status).toBe(403);
  });

  it('branch manager cannot read another branch sale by id', async () => {
    const gm = await login('general.manager');
    const sales = (await gm.get('/api/sales?from=2000-01-01&to=2100-01-01')).body as { id: number; branchName: string }[];
    const omdSale = sales.find((s) => s.branchName.startsWith('Omdurman'))!;
    const bm = await login('branch.manager.kh');
    expect((await bm.get(`/api/sales/${omdSale.id}`)).status).toBe(403);
    expect((await gm.get(`/api/sales/${omdSale.id}`)).status).toBe(200);
  });

  it('branch manager cannot create users or reset passwords', async () => {
    const bm = await login('branch.manager.kh');
    expect((await bm.post('/api/users/1/reset-password')).status).toBe(403);
  });
});

describe('vertical slice: sale → Hasad redemption → dashboards → audit', () => {
  it('normal sale marks the item SOLD and updates dashboards', async () => {
    const gm = await login('general.manager');
    const bm = await login('branch.manager.kh');
    const cashier = await login('cashier.kh.01');

    const beforeCompany = (await gm.get('/api/dashboard/company')).body.totals.revenue;
    const beforeBranch = (await bm.get('/api/dashboard/branch')).body.kpis;

    const items = (await cashier.get('/api/inventory/items?status=AVAILABLE&sort=price')).body.items;
    const item = items.find((i: { code: string }) => !['J-1001', 'J-1002', 'J-1003'].includes(i.code));
    const sale = await cashier.post('/api/sales').send({ items: [{ itemId: item.id, discount: 0 }], paymentMethod: 'CASH', customerName: 'Test Customer' });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(sale.body.total).toBe(item.sellingPrice);

    expect((await itemByCode(item.code)).status).toBe('SOLD');
    // Selling the same piece twice is impossible.
    expect((await cashier.post('/api/sales').send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' })).status).toBe(400);

    const afterBranch = (await bm.get('/api/dashboard/branch')).body.kpis;
    expect(afterBranch.salesTotal).toBe(beforeBranch.salesTotal + item.sellingPrice);
    expect(afterBranch.availableItems).toBe(beforeBranch.availableItems - 1);
    const afterCompany = (await gm.get('/api/dashboard/company')).body.totals.revenue;
    expect(afterCompany).toBe(beforeCompany + item.sellingPrice);

    const audit = (await gm.get('/api/audit?action=SALE_CREATED')).body;
    expect(audit[0].entityId).toBe(sale.body.number);
    expect(audit[0].username).toBe('cashier.kh.01');
  });

  it('cashier discount above role limit is rejected', async () => {
    const cashier = await login('cashier.kh.02');
    const items = (await cashier.get('/api/inventory/items?status=AVAILABLE')).body.items;
    const item = items.find((i: { code: string }) => !['J-1001', 'J-1002', 'J-1003'].includes(i.code));
    const res = await cashier.post('/api/sales').send({ items: [{ itemId: item.id, discount: Math.round(item.sellingPrice * 0.2) }], paymentMethod: 'CASH' });
    expect(res.status).toBe(403);
  });

  it('Hasad withdrawal: no reservation until the customer picks; settlement both ways; completion', async () => {
    const cashier = await login('cashier.kh.01');
    const list = (await cashier.get('/api/hasad/withdrawals')).body;
    const w = list.withdrawals.find((x: { externalId: string }) => x.externalId === 'HG-10025');
    expect(w.status).toBe('READY_FOR_PICKUP');
    expect(w.entitledWeightMg).toBe(4200);
    expect(w.pickupCode).toBeUndefined(); // secret never sent to the browser

    const availableBefore = (await cashier.get('/api/inventory/items?status=AVAILABLE&limit=1')).body.total;

    // Wrong pickup code is refused.
    expect((await cashier.post(`/api/hasad/withdrawals/${w.id}/open`).send({ verification: 'PICKUP_CODE', pickupCode: '000000' })).status).toBe(400);
    const opened = await cashier.post(`/api/hasad/withdrawals/${w.id}/open`).send({ verification: 'PICKUP_CODE', pickupCode: '482913' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);

    // Opening the request does not touch inventory.
    expect((await cashier.get('/api/inventory/items?status=AVAILABLE&limit=1')).body.total).toBe(availableBefore);

    // CASE A — 4.180 g: branch pays the customer 0.020 g.
    const a = await itemByCode('J-1002');
    expect(a.netWeightMg).toBe(4180);
    expect((await cashier.post(`/api/hasad/withdrawals/${w.id}/items`).send({ itemId: a.id })).status).toBe(200);
    expect((await itemByCode('J-1002')).status).toBe('RESERVED');
    let detail = (await cashier.get(`/api/hasad/withdrawals/${w.id}`)).body;
    expect(detail.settlement.direction).toBe('BRANCH_PAYS_CUSTOMER');
    expect(detail.settlement.absDifferenceMg).toBe(20);
    const rate21 = (await cashier.get('/api/gold-rates')).body.current['21'].pricePerGram;
    expect(detail.settlement.amount).toBe(Math.round(0.02 * rate21));

    // Customer changes their mind → item released back to AVAILABLE.
    expect((await cashier.delete(`/api/hasad/withdrawals/${w.id}/items/${a.id}`)).status).toBe(200);
    expect((await itemByCode('J-1002')).status).toBe('AVAILABLE');

    // CASE B — 4.350 g: customer pays the branch 0.150 g.
    const b = await itemByCode('J-1003');
    await cashier.post(`/api/hasad/withdrawals/${w.id}/items`).send({ itemId: b.id });
    detail = (await cashier.get(`/api/hasad/withdrawals/${w.id}`)).body;
    expect(detail.settlement.direction).toBe('CUSTOMER_PAYS_BRANCH');
    expect(detail.settlement.absDifferenceMg).toBe(150);

    // Completing with a stale/unconfirmed settlement is refused.
    const stale = await cashier.post(`/api/hasad/withdrawals/${w.id}/complete`).send({ paymentMethod: 'CASH', customerAcknowledged: true, expectedDirection: 'BRANCH_PAYS_CUSTOMER', expectedAmount: 1 });
    expect(stale.status).toBe(409);
    const noAck = await cashier.post(`/api/hasad/withdrawals/${w.id}/complete`).send({ paymentMethod: 'CASH', customerAcknowledged: false, expectedDirection: detail.settlement.direction, expectedAmount: detail.settlement.amount });
    expect(noAck.status).toBe(400);

    const done = await cashier.post(`/api/hasad/withdrawals/${w.id}/complete`).send({
      paymentMethod: 'CASH',
      customerAcknowledged: true,
      expectedDirection: detail.settlement.direction,
      expectedAmount: detail.settlement.amount,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await itemByCode('J-1003')).status).toBe('REDEEMED');
    expect((await itemByCode('J-1002')).status).toBe('AVAILABLE');

    const [mock] = await ctx.db.select().from(hasadMockTables.mockWithdrawals).where(eq(hasadMockTables.mockWithdrawals.id, 'HG-10025'));
    expect(mock.status).toBe('COMPLETED');

    const moves = await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, b.id));
    expect(moves.map((m) => m.type)).toContain('HASAD_REDEMPTION');

    const gm = await login('general.manager');
    const audit = (await gm.get('/api/audit?q=HG-10025&from=2000-01-01&to=2100-01-01')).body.map((a: { action: string }) => a.action);
    for (const act of ['HASAD_WITHDRAWAL_RECEIVED', 'HASAD_WITHDRAWAL_OPENED', 'ITEM_RESERVED', 'ITEM_RELEASED', 'HASAD_WITHDRAWAL_COMPLETED']) {
      expect(audit).toContain(act);
    }
    const bm = await login('branch.manager.kh');
    const dash = (await bm.get('/api/dashboard/branch')).body;
    expect(dash.hasad.completedToday).toBeGreaterThanOrEqual(1);
    expect(dash.hasad.collectedFromCustomers).toBeGreaterThanOrEqual(detail.settlement.amount);

    // Ledger still reconciles after all of this.
    const summary = await movementSummary(ctx.db, await periodFor(ctx), null);
    for (const m of summary) expect(m.closing.items).toBe(m.actual!.items);
  });

  it('aborting a counter session releases reserved items and keeps the request open', async () => {
    const cashier = await login('cashier.kh.02');
    const list = (await cashier.get('/api/hasad/withdrawals')).body;
    const w = list.withdrawals.find((x: { externalId: string }) => x.externalId === 'HG-10027');
    await cashier.post(`/api/hasad/withdrawals/${w.id}/open`).send({ verification: 'ID_DOCUMENT' });
    const candidates = (await cashier.get(`/api/hasad/withdrawals/${w.id}/candidates`)).body;
    await cashier.post(`/api/hasad/withdrawals/${w.id}/items`).send({ itemId: candidates[0].id });
    expect((await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, candidates[0].id)))[0].status).toBe('RESERVED');
    expect((await cashier.post(`/api/hasad/withdrawals/${w.id}/abort`).send({ reason: 'Customer will come back tomorrow' })).status).toBe(200);
    expect((await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, candidates[0].id)))[0].status).toBe('AVAILABLE');
    const after = (await cashier.get(`/api/hasad/withdrawals/${w.id}`)).body;
    expect(after.withdrawal.status).toBe('READY_FOR_PICKUP');
  });

  it('Hasad outage is reported cleanly and never corrupts inventory', async () => {
    const gm = await login('general.manager');
    await gm.put('/api/settings').send({ mockHasad: { simulateOutage: true } });
    const cashier = await login('cashier.omd.01');
    const list = (await cashier.get('/api/hasad/withdrawals')).body;
    const w = list.withdrawals.find((x: { externalId: string }) => x.externalId === 'HG-10028');
    const res = await cashier.post(`/api/hasad/withdrawals/${w.id}/open`).send({ verification: 'ID_DOCUMENT' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('HASAD_UNAVAILABLE');
    await gm.put('/api/settings').send({ mockHasad: { simulateOutage: false } });
  });
});

describe('user administration & sessions', () => {
  it('GM creates a user with a temporary password; user must change it before working', async () => {
    const gm = await login('general.manager');
    const created = await gm.post('/api/users').send({ username: 'cashier.kh.03', fullName: 'New Cashier', roleCode: 'CASHIER', branchId: 1 });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const temp = created.body.temporaryPassword;
    expect(temp).toMatch(/^Temp-/);

    const user = await login('cashier.kh.03', temp);
    const blocked = await user.get('/api/inventory/items');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await user.post('/api/auth/change-password').send({ currentPassword: temp, newPassword: 'Counter2026' })).status).toBe(200);
    expect((await user.get('/api/inventory/items')).status).toBe(200);

    // Centralized password control: no further self-service changes.
    expect((await user.post('/api/auth/change-password').send({ currentPassword: 'Counter2026', newPassword: 'Another2026' })).status).toBe(403);

    // Reset: old session is terminated, new temporary password issued.
    const reset = await gm.post(`/api/users/${created.body.id}/reset-password`);
    expect(reset.body.temporaryPassword).toMatch(/^Temp-/);
    expect((await user.get('/api/auth/me')).status).toBe(401);

    // Disable: login refused.
    await gm.post(`/api/users/${created.body.id}/disable`);
    const refused = await request(app).post('/api/auth/login').send({ username: 'cashier.kh.03', password: reset.body.temporaryPassword });
    expect(refused.status).toBe(403);
  });

  it('GM sees active sessions of every branch with the real account, device and concurrency flag', async () => {
    const gm = await login('general.manager');
    const sessions = (await gm.get('/api/sessions?scope=active')).body as { username: string; concurrentSessions: number; device: string }[];
    expect(sessions.some((s) => s.username === 'cashier.omd.01')).toBe(true);
    expect(sessions.find((s) => s.username === 'cashier.pzu.01')!.concurrentSessions).toBeGreaterThanOrEqual(2);

    const bm = await login('branch.manager.kh');
    const own = (await bm.get('/api/sessions?scope=active')).body as { branchName: string }[];
    expect(own.every((s) => s.branchName === 'Khartoum Branch')).toBe(true);
  });

  it('every report runs for the General Manager', async () => {
    const gm = await login('general.manager');
    for (const key of ['sales', 'purchases', 'expenses', 'inventory', 'inventory-movement', 'inventory-ledger', 'profit', 'hasad', 'branch-performance', 'user-activity', 'audit']) {
      const res = await gm.get(`/api/reports/${key}?from=2026-01-01&to=2030-12-31`);
      expect(res.status, `${key}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      expect(Array.isArray(res.body.rows)).toBe(true);
    }
    for (const group of ['category', 'karat', 'cashier', 'day']) {
      expect((await gm.get(`/api/reports/profit?group=${group}`)).status).toBe(200);
    }
  });
});
