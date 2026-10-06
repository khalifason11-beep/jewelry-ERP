// Phase 2b: cost model and branch money ledger. Runs on PGlite AND real PostgreSQL.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { rows } from '../src/core/sql';
import { resetThrottleMemory } from '../src/auth/lockout';
import { loadActor } from '../src/modules/sessions/service';
import { createSale, voidSale } from '../src/modules/sales/service';
import { balances, cashBalance, entriesFor, LINE_OF_EVENT, OTHER_EVENT_TYPES, post, reconciliation, reconciliationLines, RECONCILIATION_LINES } from '../src/modules/ledger/service';
import { LEDGER_EVENT_TYPES } from '@jerp/shared';
import { addDays, dayKey, dayStart } from '../src/core/time';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, PG_MODE, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const taken = new Set<number>();
async function freshItems(code: string, n: number) {
  const items = await ctx.db
    .select()
    .from(t.jewelryItems)
    .where(and(eq(t.jewelryItems.branchId, await branchId(code)), eq(t.jewelryItems.status, 'AVAILABLE')))
    .orderBy(t.jewelryItems.id);
  const out = items.filter((i) => !taken.has(i.id)).slice(0, n);
  if (out.length < n) throw new Error(`not enough available items in ${code}`);
  out.forEach((i) => taken.add(i.id));
  return out;
}
async function login(username: string, role: keyof typeof DEMO_PASSWORDS, keys = true): Promise<Agent> {
  const agent = keys ? withIdempotencyKeys(request.agent(app)) : request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const entryCount = async () => (await ctx.db.select({ n: count() }).from(t.ledgerEntries))[0].n;
const failure = async (statement: string) => {
  const e = await ctx.db.execute(sql.raw(statement)).then(() => null, (err: Error & { cause?: Error }) => err);
  return e ? `${e.message} ${e.cause?.message ?? ''}` : null;
};

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle.close());
beforeEach(() => resetThrottleMemory());

describe('cost model', () => {
  it('every item has an origin and an acquisition cost; supplier pieces include the making charge', async () => {
    const items = await ctx.db.select().from(t.jewelryItems);
    expect(items.length).toBeGreaterThan(100);
    const supplier = items.filter((i) => i.origin === 'SUPPLIER_NEW');
    const scrap = items.filter((i) => i.origin === 'SCRAP');
    expect(supplier.length + scrap.length).toBe(items.length);
    for (const i of supplier) {
      expect(i.acquisitionCost).toBe(i.purchaseCost + i.makingCost + i.otherCost);
      expect(i.makingCharge).toBe(i.makingCost);
      expect(i.makingCharge).toBeLessThanOrEqual(i.acquisitionCost);
      expect(i.costIsEstimated).toBe(false);
      expect(i.supplierId).not.toBeNull();
    }
    // Sellable counter scrap (Phase 4): its cost is what the customer was paid; no supplier.
    expect(scrap.length).toBeGreaterThan(0);
    const scrapBuys = await ctx.db.select().from(t.scrapPurchases);
    for (const i of scrap) {
      const buy = scrapBuys.find((b) => b.itemId === i.id)!;
      expect(i.acquisitionCost).toBe(buy.amount);
      expect(i.supplierId).toBeNull();
    }
  });

  it('a sale line stores the acquisition-cost snapshot and profit = final price − acquisition cost', async () => {
    const lines = await ctx.db.select().from(t.saleItems);
    expect(lines.length).toBeGreaterThan(50);
    for (const l of lines) {
      expect(l.profit).toBe(l.finalPrice - l.acquisitionCost);
      expect(l.pricingMode).toBe('FIXED_TAG');
      expect(l.priceGoldValue).toBeNull();
    }
    // The database refuses an inconsistent profit.
    const e = await ctx.db.update(t.saleItems).set({ profit: sql`profit + 1` }).where(sql`true`).then(() => null, (err: Error & { cause?: Error }) => `${err.message} ${err.cause?.message}`);
    expect(e).toContain('ck_sale_items_profit_sum');
  });

  it('profit and acquisition cost reach the GM only', async () => {
    const [line] = await ctx.db.select().from(t.saleItems).limit(1);
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const [sale] = await ctx.db.select().from(t.sales).where(eq(t.sales.id, line.saleId));
    const [krt] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, sale.branchId));
    const asBm = krt.code === 'KRT' ? bm : gm; // only compare when the BM may open this sale
    const g = (await gm.get(`/api/sales/${sale.id}`)).body;
    expect(g.items[0]).toHaveProperty('profit');
    expect(g.items[0]).toHaveProperty('acquisitionCost');
    if (asBm === bm) {
      const b = (await bm.get(`/api/sales/${sale.id}`)).body;
      expect(b.items[0]).not.toHaveProperty('profit');
      expect(b.items[0]).not.toHaveProperty('acquisitionCost');
    }
  });
});

describe('ledger basics', () => {
  it('every branch has CASH, BANK, FUNDS_IN_TRANSIT and HASAD_RECEIVABLE accounts, also a branch created later', async () => {
    const accounts = await ctx.db.select().from(t.ledgerAccounts);
    const branches = await ctx.db.select().from(t.branches);
    expect(accounts).toHaveLength(branches.length * 4);
    const [b] = await ctx.db.insert(t.branches).values({ code: 'LDGT', name: 'Ledger Test', nameAr: 'اختبار', city: 'Test' }).returning();
    const kinds = (await ctx.db.select().from(t.ledgerAccounts).where(eq(t.ledgerAccounts.branchId, b.id))).map((a) => a.kind).sort();
    expect(kinds).toEqual(['BANK', 'CASH', 'FUNDS_IN_TRANSIT', 'HASAD_RECEIVABLE']);
  });

  it('the demo seed posted entries consistent with its history', async () => {
    const sales = await ctx.db.select().from(t.sales);
    const saleEntries = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'SALE'));
    expect(saleEntries.reduce((s, e) => s + e.amount, 0)).toBe(sales.reduce((s, x) => s + x.total, 0));
    const voids = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'SALE_VOID'));
    expect(voids.reduce((s, e) => s + e.amount, 0)).toBe(-sales.filter((x) => x.status === 'VOIDED').reduce((s, x) => s + x.total, 0));
    // Expenses were removed (REM-1): the seed records none and the ledger holds no EXPENSE entry.
    expect(await ctx.db.select().from(t.expenses)).toHaveLength(0);
    expect(await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'EXPENSE'))).toHaveLength(0);
    // Hasad weight-difference settlements were removed (REM-2): none in the seed, none in the ledger.
    expect(await ctx.db.select().from(t.settlements)).toHaveLength(0);
    expect(await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'HASAD_SETTLEMENT'))).toHaveLength(0);
  });

  it('a balance is exactly the sum of its entries (no cached balance anywhere)', async () => {
    const raw = rows<{ account_id: number; s: string }>(await ctx.db.execute(sql`SELECT account_id, sum(amount)::text AS s FROM ledger_entries GROUP BY account_id`));
    const accounts = await ctx.db.select().from(t.ledgerAccounts);
    const bal = await balances(ctx.db, null);
    for (const a of accounts) {
      const b = bal.find((x) => x.branchId === a.branchId && x.kind === a.kind)!;
      expect(b.balance, `${a.branchId}/${a.kind}`).toBe(Number(raw.find((r) => r.account_id === a.id)?.s ?? 0));
    }
  });

  it('refuses fractional amounts and skips zero lines', async () => {
    const before = await entryCount();
    await expect(ctx.db.transaction((tx) => post(tx, [{ branchId: 1, kind: 'CASH', amount: 10.5, eventType: 'SALE', ref: { refType: 'test', refId: 1 } }], { actor: null }))).rejects.toThrow(RangeError);
    await ctx.db.transaction((tx) => post(tx, [{ branchId: 1, kind: 'CASH', amount: 0, eventType: 'SALE', ref: { refType: 'test', refId: 1 } }], { actor: null }));
    expect(await entryCount()).toBe(before);
  });

  it('a reversal must point at an existing entry, same account, opposite amount, not itself a reversal', async () => {
    const [e] = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'SCRAP_PURCHASE')).limit(1);
    const bad = async (values: Partial<typeof t.ledgerEntries.$inferInsert>) => {
      const row = { accountId: e.accountId, branchId: e.branchId, amount: -e.amount, eventType: 'REVERSAL', refType: e.refType, refId: e.refId, reversesEntryId: e.id, ...values };
      return ctx.db.insert(t.ledgerEntries).values(row as typeof t.ledgerEntries.$inferInsert).then(() => null, (err: Error & { cause?: Error }) => `${err.message} ${err.cause?.message}`);
    };
    expect(await bad({ reversesEntryId: 999_999_999 })).toMatch(/does not exist/);
    expect(await bad({ amount: -e.amount + 1 })).toMatch(/opposite amount/);
    expect(await bad({ reversesEntryId: null })).toMatch(/ck_ledger_entries_reversal_type/);
    expect(await bad({})).toBeNull(); // a correct reversal is accepted…
    expect(await bad({})).toMatch(/unique|duplicate/i); // …but only once
  });

  it('ledger_entries and cash_counts are append-only', async () => {
    for (const table of ['ledger_entries', 'cash_counts']) {
      if (table === 'cash_counts') {
        const bm = await actorOf('branch.manager.kh');
        await ctx.db.insert(t.cashCounts).values({ branchId: bm.branchId!, businessDay: '2026-01-01', countedAmount: 5, expectedAmount: 5, countedBy: bm.userId });
      }
      for (const stmt of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        expect(await failure(stmt), stmt).toMatch(PG_MODE ? /permission denied|append-only/ : /append-only/);
      }
    }
  });
});

describe('money events post in the same transaction as the business change', () => {
  it('cash sale → +total to CASH; bank-transfer sale → BANK with its payment method; void nets each to zero', async () => {
    const cashier = await actorOf('cashier.kh.01');
    const bm = await actorOf('branch.manager.kh');
    const krt = await branchId('KRT');
    const [a, b] = await freshItems('KRT', 2);
    const cashBefore = await cashBalance(ctx.db, krt);
    const s1 = await createSale(ctx, cashier, { items: [{ itemId: a.id }], paymentMethod: 'CASH' });
    const s2 = await createSale(ctx, cashier, { items: [{ itemId: b.id }], paymentMethod: 'BANK_TRANSFER' });
    expect(await cashBalance(ctx.db, krt)).toBe(cashBefore + s1.total);
    const e2 = await entriesFor(ctx.db, 'sale', [s2.id]);
    expect(e2).toHaveLength(1);
    expect(e2[0]).toMatchObject({ amount: s2.total, paymentMethod: 'BANK_TRANSFER', eventType: 'SALE' });
    const [acc] = await ctx.db.select().from(t.ledgerAccounts).where(eq(t.ledgerAccounts.id, e2[0].accountId));
    expect(acc.kind).toBe('BANK');

    await voidSale(ctx, bm, s1.id, 'Customer returned it');
    await voidSale(ctx, bm, s2.id, 'Transfer reversed');
    for (const s of [s1, s2]) {
      const e = await entriesFor(ctx.db, 'sale', [s.id]);
      expect(e).toHaveLength(2);
      expect(e.reduce((x, y) => x + y.amount, 0)).toBe(0);
      expect(e[1]).toMatchObject({ eventType: 'SALE_VOID', reversesEntryId: e[0].id, accountId: e[0].accountId, paymentMethod: e[0].paymentMethod });
    }
    expect(await cashBalance(ctx.db, krt)).toBe(cashBefore);
    // A second void is refused and never refunds twice.
    await expect(voidSale(ctx, bm, s1.id, 'again')).rejects.toMatchObject({ status: 400 });
    expect(await entriesFor(ctx.db, 'sale', [s1.id])).toHaveLength(2);
  });

  it('a failed sale writes neither the sale nor any ledger entry (same transaction)', async () => {
    const cashier = await actorOf('cashier.kh.01');
    const [a] = await freshItems('KRT', 1);
    await createSale(ctx, cashier, { items: [{ itemId: a.id }], paymentMethod: 'CASH' });
    const before = await entryCount();
    await expect(createSale(ctx, cashier, { items: [{ itemId: a.id }], paymentMethod: 'CASH' })).rejects.toBeTruthy();
    expect(await entryCount()).toBe(before);
  });

  it('expenses are gone (REM-1): routes answer 404, no permission, setting or report remains', async () => {
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.get('/api/expenses')).status).toBe(404);
    expect((await gm.post('/api/expenses').send({ category: 'OTHER', amount: 1000, description: 'Tea' })).status).toBe(404);
    expect((await gm.post('/api/expenses/1/review').send({ decision: 'APPROVED' })).status).toBe(404);
    expect((await gm.get('/api/reports/expenses')).status).toBe(400); // an unknown report key, like any other
    expect(await ctx.db.select().from(t.permissions).where(sql`code LIKE 'expenses.%'`)).toHaveLength(0);
    expect(await ctx.db.select().from(t.rolePermissions).where(sql`permission_code LIKE 'expenses.%'`)).toHaveLength(0);
    const settings = (await gm.get('/api/settings')).body;
    expect(settings.settings.expenses).toBeUndefined();
    for (const path of ['/api/dashboard/company', '/api/notifications', '/api/reports/branch-performance', '/api/reports/profit']) {
      const res = await gm.get(path);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toMatch(/expense|contribution/i);
    }
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    expect(JSON.stringify((await bm.get('/api/dashboard/branch')).body)).not.toMatch(/expense|contribution/i);
  });

  it('expenses are gone (REM-1): the database refuses new expense rows and new EXPENSE ledger entries', async () => {
    const krt = await branchId('KRT');
    const [gm] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
    const row = await failure(
      `INSERT INTO expenses (number, branch_id, category, amount, expense_date, description, status, created_by) VALUES ('EXP-X', ${krt}, 'OTHER', 1000, '2026-01-01', 'x', 'APPROVED', ${gm.id})`,
    );
    expect(row).toMatch(/expenses were removed/);
    const before = await entryCount();
    await expect(
      ctx.db.transaction((tx) => post(tx, [{ branchId: krt, kind: 'CASH', amount: -1000, eventType: 'EXPENSE', ref: { refType: 'expense', refId: 1 } }], { actor: null })),
    ).rejects.toThrow();
    expect(await entryCount()).toBe(before);
    // Every other event type still posts.
    await ctx.db.transaction((tx) => post(tx, [{ branchId: krt, kind: 'BANK', amount: 1, eventType: 'HASAD_RECEIVABLE_SETTLEMENT', ref: { refType: 'test', refId: 1 } }], { actor: null }));
    expect(await entryCount()).toBe(before + 1);
  });

  it('the Hasad workspace is gone (REM-2): the database refuses new withdrawals, sessions, weight settlements and HASAD_SETTLEMENT entries', async () => {
    const krt = await branchId('KRT');
    for (const [table, stmt] of [
      ['hasad_withdrawals', `INSERT INTO hasad_withdrawals (external_id) VALUES ('X')`],
      ['hasad_redemptions', `INSERT INTO hasad_redemptions (number) VALUES ('X')`],
      ['hasad_redemption_items', `INSERT INTO hasad_redemption_items (redemption_id) VALUES (1)`],
      ['settlements', `INSERT INTO settlements (number) VALUES ('X')`],
      ['hasad_mock.customers', `INSERT INTO hasad_mock.customers (id) VALUES ('X')`],
    ]) {
      expect(await failure(stmt), table).toMatch(/was removed|were removed/);
    }
    const before = await entryCount();
    await expect(
      ctx.db.transaction((tx) => post(tx, [{ branchId: krt, kind: 'CASH', amount: 500, eventType: 'HASAD_SETTLEMENT', ref: { refType: 'hasad_redemption', refId: 1 } }], { actor: null })),
    ).rejects.toThrow();
    expect(await entryCount()).toBe(before);
    expect(await ctx.db.select().from(t.permissions).where(sql`code LIKE 'hasad.%'`)).toHaveLength(0);
  });
});

describe('idempotency inside the money transaction', () => {
  it('a replay with the same key creates no second sale and no second ledger entry', async () => {
    const cashier = await login('cashier.kh.02', 'CASHIER', false);
    const [item] = await freshItems('KRT', 1);
    const key = `ldg-${crypto.randomUUID()}`;
    const body = { items: [{ itemId: item.id }], paymentMethod: 'CASH' };
    const first = await cashier.post('/api/sales').set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200);
    const again = await cashier.post('/api/sales').set('Idempotency-Key', key).send(body);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    const e = await entriesFor(ctx.db, 'sale', [first.body.id]);
    expect(e).toHaveLength(1);
    expect(e[0].idempotencyKey).toBe(key);
    const [row] = await ctx.db.select().from(t.idempotencyKeys).where(eq(t.idempotencyKeys.key, key));
    expect(row.status).toBe('COMPLETED');
  });

  it('a failed money request leaves no idempotency record (claimed inside the rolled-back transaction)', async () => {
    const cashier = await login('cashier.kh.02', 'CASHIER', false);
    const [sold] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.status, 'SOLD')).limit(1);
    const key = `ldg-${crypto.randomUUID()}`;
    const res = await cashier.post('/api/sales').set('Idempotency-Key', key).send({ items: [{ itemId: sold.id }], paymentMethod: 'CASH' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await ctx.db.select().from(t.idempotencyKeys).where(eq(t.idempotencyKeys.key, key))).toHaveLength(0);
  });

  it('parallel submits with one key: one sale, one entry, the others replay or wait', async () => {
    const cashier = await login('cashier.kh.02', 'CASHIER', false);
    const [item] = await freshItems('KRT', 1);
    const key = `ldg-${crypto.randomUUID()}`;
    const rs = await Promise.all([1, 2, 3, 4].map(() => cashier.post('/api/sales').set('Idempotency-Key', key).send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' })));
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const ids = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const sales = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, item.id));
    expect(sales).toHaveLength(1);
    expect(await entriesFor(ctx.db, 'sale', [[...ids][0]])).toHaveLength(1);
  });
});

describe('concurrent sales and voids keep the ledger consistent', () => {
  it('sales, voids and duplicate voids in parallel: entries match the records exactly', async () => {
    const c1 = await actorOf('cashier.kh.01');
    const c2 = await actorOf('cashier.kh.02');
    const bm = await actorOf('branch.manager.kh');
    const krt = await branchId('KRT');
    const cashBefore = await cashBalance(ctx.db, krt);
    const items = await freshItems('KRT', 8);
    const made = await Promise.allSettled(items.map((i, n) => createSale(ctx, n % 2 ? c1 : c2, { items: [{ itemId: i.id }], paymentMethod: 'CASH' })));
    const sales = made.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createSale>>> => r.status === 'fulfilled').map((r) => r.value);
    expect(sales).toHaveLength(8);
    const toVoid = sales.slice(0, 4);
    // Each void is fired three times at once: exactly one of each may win.
    await Promise.allSettled(toVoid.flatMap((s) => [1, 2, 3].map(() => voidSale(ctx, bm, s.id, 'parallel test'))));
    const ids = sales.map((s) => s.id);
    const entries = await entriesFor(ctx.db, 'sale', ids);
    const [{ voided }] = rows<{ voided: number }>(await ctx.db.execute(sql`SELECT count(*)::int AS voided FROM sales WHERE id IN ${ids} AND status = 'VOIDED'`));
    expect(voided).toBe(4);
    expect(entries.filter((e) => e.eventType === 'SALE')).toHaveLength(8);
    expect(entries.filter((e) => e.eventType === 'SALE_VOID')).toHaveLength(4);
    for (const s of toVoid) expect(entries.filter((e) => e.refId === s.id).reduce((x, e) => x + e.amount, 0)).toBe(0);
    const kept = sales.slice(4).reduce((x, s) => x + s.total, 0);
    expect(await cashBalance(ctx.db, krt)).toBe(cashBefore + kept);
    const reversals = await ctx.db.select().from(t.ledgerEntries).where(inArray(t.ledgerEntries.refId, ids));
    const reversedIds = reversals.map((e) => e.reversesEntryId).filter((x): x is number => x != null);
    expect(new Set(reversedIds).size).toBe(reversedIds.length);
  });
});

describe('expected cash and daily reconciliation', () => {
  it('reconciliation: opening + the day’s cash movements = expected; counted cash and difference', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const cashier = await actorOf('cashier.kh.01');
    const [item] = await freshItems('KRT', 1);
    const sale = await createSale(ctx, cashier, { items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    const r = (await bm.get('/api/cash/reconciliation')).body;
    expect(r.expectedCash).toBe(r.openingCash + r.cashMovement);
    expect(r.salesByMethod.find((m: { paymentMethod: string }) => m.paymentMethod === 'CASH').amount).toBeGreaterThanOrEqual(sale.total);
    const drawer = (await bm.get('/api/cash/drawer')).body;
    expect(drawer.branches).toHaveLength(1);
    expect(drawer.branches[0].expectedCash).toBe(r.expectedCash);
    const counted = r.expectedCash - 5_000;
    expect((await bm.post('/api/cash/counts').send({ day: r.day, countedAmount: counted, note: 'short 5000' })).status).toBe(200);
    const after = (await bm.get('/api/cash/reconciliation')).body;
    expect(after.counted.amount).toBe(counted);
    expect(after.difference).toBe(-5_000);
    // A recount is a new row; the latest one counts.
    await bm.post('/api/cash/counts').send({ day: r.day, countedAmount: r.expectedCash });
    expect((await bm.get('/api/cash/reconciliation')).body.difference).toBe(0);
    expect(await ctx.db.select().from(t.cashCounts).where(eq(t.cashCounts.businessDay, r.day))).toHaveLength(2);
  });

  it('SPEC §18.10: for every branch and day, the reconciliation lines add up exactly to the ledger movement of each account', async () => {
    const gm = await actorOf('general.manager');
    const { company } = await ctx.settings.get();
    const today = dayKey(new Date(), company.timezone);
    const branches = await ctx.db.select().from(t.branches);
    let days = 0;
    for (const b of branches) {
      for (let off = -35; off <= 0; off++) {
        const day = addDays(today, off);
        const r = await reconciliation(ctx, gm, { branchId: b.id, day });
        // Independent of the service: the raw ledger movement of the day per account.
        const raw = rows<{ kind: string; s: string }>(
          await ctx.db.execute(sql`
            SELECT a.kind, coalesce(sum(e.amount), 0)::text AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
            WHERE e.branch_id = ${b.id} AND e.at >= ${dayStart(day, company.timezone).toISOString()} AND e.at < ${dayStart(addDays(day, 1), company.timezone).toISOString()}
            GROUP BY a.kind`),
        );
        const moved = (kind: string) => Number(raw.find((x) => x.kind === kind)?.s ?? 0);
        const sum = (lines: { amount: number }[]) => lines.reduce((s, l) => s + l.amount, 0);
        expect(r.cashLines.map((l) => l.line)).toEqual([...RECONCILIATION_LINES.CASH]);
        expect(r.bankLines.map((l) => l.line)).toEqual([...RECONCILIATION_LINES.BANK]);
        expect(sum(r.cashLines)).toBe(moved('CASH'));
        expect(r.cashMovement).toBe(moved('CASH'));
        expect(r.openingCash + sum(r.cashLines)).toBe(r.expectedCash);
        expect(sum(r.bankLines)).toBe(moved('BANK'));
        expect(r.bankMovement).toBe(moved('BANK'));
        days++;
      }
    }
    expect(days).toBeGreaterThan(100);
  });

  it('guardrail: every ledger event type has a reconciliation line or is explicitly listed as "Other" with a reason', () => {
    // Adding an event type to LEDGER_EVENT_TYPES fails here until someone decides: give it a line in
    // LINE_OF_EVENT, or add it to OTHER_EVENT_TYPES with the reason (backend/src/modules/ledger/service.ts).
    const undecided = LEDGER_EVENT_TYPES.filter((e) => !(e in LINE_OF_EVENT) && !(e in OTHER_EVENT_TYPES));
    expect(undecided, 'ledger event types with no reconciliation decision').toEqual([]);
    const both = LEDGER_EVENT_TYPES.filter((e) => e in LINE_OF_EVENT && e in OTHER_EVENT_TYPES);
    expect(both, 'an event type cannot have a line and be listed as Other').toEqual([]);
    for (const [e, reason] of Object.entries(OTHER_EVENT_TYPES)) {
      expect((LEDGER_EVENT_TYPES as readonly string[]).includes(e), `${e} is not a ledger event type`).toBe(true);
      expect(reason?.trim().length, `${e} needs a reason`).toBeGreaterThan(10);
    }
    expect(Object.keys(OTHER_EVENT_TYPES).sort()).toEqual(['EXPENSE', 'HASAD_SETTLEMENT', 'REVERSAL']);
    // And the lines they map to exist for at least one account.
    const all = new Set<string>([...RECONCILIATION_LINES.CASH, ...RECONCILIATION_LINES.BANK]);
    for (const line of Object.values(LINE_OF_EVENT)) expect(all.has(line!), line).toBe(true);
  });

  it('an event type without a line of its own is shown under "Other": nothing silently disappears', async () => {
    // Historical EXPENSE (REM-1) and HASAD_SETTLEMENT (REM-2) entries, and any future event type, land in OTHER.
    const lines = reconciliationLines('CASH', [
      { kind: 'CASH', eventType: 'SALE', amount: 50_000 },
      { kind: 'CASH', eventType: 'EXPENSE', amount: -7_000 },
      { kind: 'CASH', eventType: 'HASAD_SETTLEMENT', amount: -100 }, // a Hasad weight-difference settlement (removed by REM-2)
      { kind: 'CASH', eventType: 'HASAD_RECEIVABLE_SETTLEMENT', amount: -1 }, // never a drawer event: not a CASH line
      { kind: 'CASH', eventType: 'SOMETHING_NEW', amount: 3 },
      { kind: 'BANK', eventType: 'SALE', amount: 999 }, // another account: ignored
    ]);
    expect(Object.fromEntries(lines.map((l) => [l.line, l.amount]))).toEqual({ SALES: 50_000, VOIDS: 0, SCRAP_PURCHASES: 0, MAKING_CHARGES: 0, OTHER: -7_098 });
    // And through the API: an entry on the drawer whose event type has no drawer line appears under OTHER, and the total still matches.
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const krt = await branchId('KRT');
    const before = (await bm.get('/api/cash/reconciliation')).body;
    await ctx.db.transaction((tx) => post(tx, [{ branchId: krt, kind: 'CASH', amount: -1_234, eventType: 'HASAD_RECEIVABLE_SETTLEMENT', ref: { refType: 'test', refId: 2 } }], { actor: null }));
    const after = (await bm.get('/api/cash/reconciliation')).body;
    const other = (r: { cashLines: { line: string; amount: number }[] }) => r.cashLines.find((l) => l.line === 'OTHER')!.amount;
    expect(other(after) - other(before)).toBe(-1_234);
    expect(after.cashMovement - before.cashMovement).toBe(-1_234);
    expect(after.cashLines.reduce((s: number, l: { amount: number }) => s + l.amount, 0)).toBe(after.cashMovement);
    expect(JSON.stringify(after)).not.toMatch(/expense/i);
  });

  it('branch managers see only their own branch; cashiers see no cash screens; no cost or profit anywhere', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const omd = await branchId('OMD');
    expect((await bm.get(`/api/cash/reconciliation?branchId=${omd}`)).status).toBe(403);
    expect((await bm.get(`/api/cash/drawer?branchId=${omd}`)).status).toBe(403);
    expect((await cashier.get('/api/cash/drawer')).status).toBe(403);
    expect((await cashier.post('/api/cash/counts').send({ day: '2026-01-01', countedAmount: 1 })).status).toBe(403);
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.get('/api/cash/drawer')).body.branches.length).toBeGreaterThan(3);
    const text = JSON.stringify((await bm.get('/api/cash/reconciliation')).body);
    for (const f of ['profit', 'acquisitionCost', 'costTotal', 'unitCost']) expect(text).not.toContain(f);
  });
});
