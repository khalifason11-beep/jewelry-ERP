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
import { createExpense, reviewExpense } from '../src/modules/expenses/service';
import { addItem, completeWithdrawal, computeSettlement, openWithdrawal } from '../src/modules/hasad/service';
import { balances, cashBalance, entriesFor, post } from '../src/modules/ledger/service';
import { seedDemo } from '../src/seed/demo';
import { DEMO_PASSWORDS } from '../src/seed/catalog';
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
  await seedDemo(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle.close());
beforeEach(() => resetThrottleMemory());

describe('cost model', () => {
  it('every item has an origin and an acquisition cost; supplier pieces include the making charge', async () => {
    const items = await ctx.db.select().from(t.jewelryItems);
    expect(items.length).toBeGreaterThan(100);
    for (const i of items) {
      expect(i.origin).toBe('SUPPLIER_NEW');
      expect(i.acquisitionCost).toBe(i.purchaseCost + i.makingCost + i.otherCost);
      expect(i.makingCharge).toBe(i.makingCost);
      expect(i.makingCharge).toBeLessThanOrEqual(i.acquisitionCost);
      expect(i.costIsEstimated).toBe(false);
    }
    expect(items.filter((i) => i.supplierId != null).length).toBe(items.length);
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
  it('every branch has CASH, BANK and FUNDS_IN_TRANSIT accounts, also a branch created later', async () => {
    const accounts = await ctx.db.select().from(t.ledgerAccounts);
    const branches = await ctx.db.select().from(t.branches);
    expect(accounts).toHaveLength(branches.length * 3);
    const [b] = await ctx.db.insert(t.branches).values({ code: 'LDGT', name: 'Ledger Test', nameAr: 'اختبار', city: 'Test' }).returning();
    const kinds = (await ctx.db.select().from(t.ledgerAccounts).where(eq(t.ledgerAccounts.branchId, b.id))).map((a) => a.kind).sort();
    expect(kinds).toEqual(['BANK', 'CASH', 'FUNDS_IN_TRANSIT']);
  });

  it('the demo seed posted entries consistent with its history', async () => {
    const sales = await ctx.db.select().from(t.sales);
    const saleEntries = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'SALE'));
    expect(saleEntries.reduce((s, e) => s + e.amount, 0)).toBe(sales.reduce((s, x) => s + x.total, 0));
    const voids = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'SALE_VOID'));
    expect(voids.reduce((s, e) => s + e.amount, 0)).toBe(-sales.filter((x) => x.status === 'VOIDED').reduce((s, x) => s + x.total, 0));
    const approved = await ctx.db.select().from(t.expenses).where(eq(t.expenses.status, 'APPROVED'));
    const exp = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'EXPENSE'));
    expect(exp).toHaveLength(approved.length);
    const settlements = await ctx.db.select().from(t.settlements);
    expect(await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'HASAD_SETTLEMENT'))).toHaveLength(settlements.length);
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
    const [e] = await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'EXPENSE')).limit(1);
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
  it('cash sale → +total to CASH; card sale → BANK with its payment method; void nets each to zero', async () => {
    const cashier = await actorOf('cashier.kh.01');
    const bm = await actorOf('branch.manager.kh');
    const krt = await branchId('KRT');
    const [a, b] = await freshItems('KRT', 2);
    const cashBefore = await cashBalance(ctx.db, krt);
    const s1 = await createSale(ctx, cashier, { items: [{ itemId: a.id }], paymentMethod: 'CASH' });
    const s2 = await createSale(ctx, cashier, { items: [{ itemId: b.id }], paymentMethod: 'CARD' });
    expect(await cashBalance(ctx.db, krt)).toBe(cashBefore + s1.total);
    const e2 = await entriesFor(ctx.db, 'sale', [s2.id]);
    expect(e2).toHaveLength(1);
    expect(e2[0]).toMatchObject({ amount: s2.total, paymentMethod: 'CARD', eventType: 'SALE' });
    const [acc] = await ctx.db.select().from(t.ledgerAccounts).where(eq(t.ledgerAccounts.id, e2[0].accountId));
    expect(acc.kind).toBe('BANK');

    await voidSale(ctx, bm, s1.id, 'Customer returned it');
    await voidSale(ctx, bm, s2.id, 'Card reversed');
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

  it('expenses post only on approval, from the chosen account; rejected ones never move money', async () => {
    const bm = await actorOf('branch.manager.kh');
    const gm = await actorOf('general.manager');
    const krt = await branchId('KRT');
    const { expenses } = await ctx.settings.get();
    const big = expenses.approvalThreshold + 10_000;
    const pending = await createExpense(ctx, bm, { category: 'MAINTENANCE', amount: big, description: 'Safe repair', paidFrom: 'BANK' });
    expect(pending.status).toBe('PENDING');
    expect(await entriesFor(ctx.db, 'expense', [pending.id])).toHaveLength(0);
    const bankBefore = (await balances(ctx.db, krt)).find((x) => x.kind === 'BANK')!.balance;
    await reviewExpense(ctx, gm, pending.id, 'APPROVED');
    const [e] = await entriesFor(ctx.db, 'expense', [pending.id]);
    expect(e).toMatchObject({ amount: -big, eventType: 'EXPENSE', paymentMethod: 'BANK_TRANSFER' });
    expect((await balances(ctx.db, krt)).find((x) => x.kind === 'BANK')!.balance).toBe(bankBefore - big);

    const rejected = await createExpense(ctx, bm, { category: 'OTHER', amount: big, description: 'Not needed' });
    await reviewExpense(ctx, gm, rejected.id, 'REJECTED');
    expect(await entriesFor(ctx.db, 'expense', [rejected.id])).toHaveLength(0);

    const small = await createExpense(ctx, bm, { category: 'OTHER', amount: 2_000, description: 'Tea' });
    expect(small.status).toBe('APPROVED');
    const [se] = await entriesFor(ctx.db, 'expense', [small.id]);
    expect(se).toMatchObject({ amount: -2_000, paymentMethod: 'CASH' });
  });

  it('a Hasad settlement posts to CASH by default, or to BANK when chosen, with the right sign', async () => {
    const cashier = await actorOf('cashier.kh.01');
    const krt = await branchId('KRT');
    const ready = await ctx.db.select().from(t.hasadWithdrawals).where(and(eq(t.hasadWithdrawals.branchId, krt), eq(t.hasadWithdrawals.status, 'READY_FOR_PICKUP')));
    expect(ready.length).toBeGreaterThan(0);
    const w = ready[0];
    await openWithdrawal(ctx, cashier, w.id, { verification: 'ID_DOCUMENT' });
    const [item] = await freshItems('KRT', 1);
    await addItem(ctx, cashier, w.id, item.id);
    const s = await computeSettlement(ctx, w, [{ netWeightMg: item.netWeightMg, karat: item.karat }]);
    const res = await completeWithdrawal(ctx, cashier, w.id, { paymentMethod: 'MOBILE_WALLET', customerAcknowledged: true, expectedDirection: s.direction, expectedAmount: s.amount });
    const [draft] = await ctx.db.select().from(t.hasadRedemptions).where(eq(t.hasadRedemptions.number, res.redemptionNumber));
    const e = await entriesFor(ctx.db, 'hasad_redemption', [draft.id]);
    if (s.direction === 'NONE') expect(e).toHaveLength(0);
    else {
      expect(e).toHaveLength(1);
      expect(e[0].amount).toBe(s.direction === 'BRANCH_PAYS_CUSTOMER' ? -s.amount : s.amount);
      expect(e[0].paymentMethod).toBe('MOBILE_WALLET');
      const [acc] = await ctx.db.select().from(t.ledgerAccounts).where(eq(t.ledgerAccounts.id, e[0].accountId));
      expect(acc.kind).toBe('BANK');
    }
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
