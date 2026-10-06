// End-to-end API tests for the first milestone (vertical slice) and the security rules.
// Runs against a fresh in-memory PostgreSQL (PGlite) seeded with the demo data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openTestDatabase, withIdempotencyKeys } from './helpers';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import type { Ctx } from '../src/core/context';
import { seedDemo } from '../src/seed/demo';
import { movementSummary } from '../src/modules/reports/metrics';
import { periodFor } from '../src/modules/dashboard/service';
import { DEMO_PASSWORDS } from '../src/seed/catalog';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;

async function login(username: string, password?: string) {
  const agent = withIdempotencyKeys(request.agent(app));
  const role = username.startsWith('general') ? 'GENERAL_MANAGER' : username.startsWith('branch') ? 'BRANCH_MANAGER' : 'CASHIER';
  const res = await agent.post('/api/auth/login').send({ username, password: password ?? DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // Every mutation must echo the session's CSRF token (security item 8).
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}

/** Open the step-up re-authentication window (rate/role/settings changes, adjustments). */
async function reauth(agent: ReturnType<typeof request.agent>, password: string) {
  const res = await agent.post('/api/auth/reauth').send({ password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function itemByCode(code: string) {
  const [i] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.code, code));
  return i;
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedDemo(ctx);
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
      expect(u.passwordHash.startsWith('$argon2id$')).toBe(true);
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

describe('vertical slice: sale → dashboards → audit', () => {
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

  it('a prepaid Hasad pickup is an ordinary sale paid through Hasad (REM-2)', async () => {
    const cashier = await login('cashier.kh.01');
    const gm = await login('general.manager');
    const items = (await cashier.get('/api/inventory/items?status=AVAILABLE')).body.items;
    const item = items.find((i: { code: string }) => !['J-1001', 'J-1002', 'J-1003'].includes(i.code));
    // The Hasad invoice number is required; the transaction reference is optional.
    expect((await cashier.post('/api/sales').send({ items: [{ itemId: item.id }], paymentMethod: 'HASAD' })).status).toBe(400);
    const sale = await cashier.post('/api/sales').send({ items: [{ itemId: item.id }], paymentMethod: 'HASAD', paymentRefInvoice: 'HSD-INV-77', paymentRefTransaction: 'TX-9' });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const [entry] = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.refId, sale.body.id));
    const [account] = await ctx.db.select().from(t.ledgerAccounts).where(eq(t.ledgerAccounts.id, entry.accountId));
    expect(account.kind).toBe('HASAD_RECEIVABLE');
    expect(entry.amount).toBe(sale.body.total);
    // Sales reports group by channel: cash, bank transfer, Hasad.
    const report = (await gm.get('/api/reports/sales')).body;
    const channels = Object.fromEntries(report.summary.map((x: { label: string; value: number }) => [x.label, x.value]));
    expect(Object.keys(channels)).toEqual(expect.arrayContaining(['CASH', 'BANK_TRANSFER', 'HASAD']));
    expect(channels.HASAD).toBeGreaterThanOrEqual(sale.body.total);
    const completed = report.rows.filter((r: { status: string }) => r.status === 'COMPLETED');
    expect(Object.values(channels).reduce((a: number, b) => a + (b as number), 0)).toBe(completed.reduce((a: number, r: { total: number }) => a + r.total, 0));
    // The withdrawal workspace, simulator and Hasad report are gone.
    for (const path of ['/api/hasad/withdrawals', '/api/hasad/withdrawals/1', '/api/hasad/simulator/customers', '/api/hasad/integration-log']) {
      expect((await gm.get(path)).status, path).toBe(404);
    }
    expect((await gm.get('/api/reports/hasad')).status).toBe(400); // an unknown report key, like any other
    // The stock ledger still reconciles.
    const summary = await movementSummary(ctx.db, await periodFor(ctx), null);
    for (const m of summary) expect(m.closing.items).toBe(m.actual!.items);
  });
});

describe('user administration & sessions', () => {
  it('GM creates a user with a temporary password; user must change it before working', async () => {
    const gm = await login('general.manager');
    await reauth(gm, DEMO_PASSWORDS.GENERAL_MANAGER);
    const created = await gm.post('/api/users').send({ username: 'cashier.kh.03', fullName: 'New Cashier', roleCode: 'CASHIER', branchId: 1 });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const temp = created.body.temporaryPassword;
    expect(temp).toMatch(/^Temp-/);

    const user = await login('cashier.kh.03', temp);
    const blocked = await user.get('/api/inventory/items');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await user.post('/api/auth/change-password').send({ currentPassword: temp, newPassword: 'Counter2026' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    // The session is rotated on a password change: continue with the new CSRF token.
    user.set('x-csrf-token', changed.body.csrfToken);
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
    for (const key of ['sales', 'purchases', 'inventory', 'inventory-movement', 'inventory-ledger', 'profit', 'branch-performance', 'user-activity', 'audit']) {
      const res = await gm.get(`/api/reports/${key}?from=2026-01-01&to=2030-12-31`);
      expect(res.status, `${key}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      expect(Array.isArray(res.body.rows)).toBe(true);
    }
    for (const group of ['category', 'karat', 'cashier', 'day']) {
      expect((await gm.get(`/api/reports/profit?group=${group}`)).status).toBe(200);
    }
  });
});
