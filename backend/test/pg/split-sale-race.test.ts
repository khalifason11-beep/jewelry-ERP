// Real PostgreSQL only (PAY-1, docs/plans/PAY-1.md §8): a sale paid by two methods under concurrency.
//   * two parallel voids of one split sale: exactly one succeeds; every line is reversed once and every balance is
//     back exactly where it was before the sale;
//   * a void racing the sales report: the report reads in one snapshot, so the sale is in its count, its total and its
//     channels, or in none of them; the channels always add up to the total;
//   * the same Idempotency-Key sent five times at once: one sale, one set of lines, one entry per line;
//   * the void of a split sale whose cash part is all the drawer holds, racing a repayment to the General Manager of
//     that same cash: exactly one of them takes the cash; the drawer never goes below zero.
// The test works in its own branch, which it funds itself (CLAUDE.md testing rules).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createSale, salesReportAggregates, voidSale } from '../../src/modules/sales/service';
import { balances } from '../../src/modules/ledger/service';
import { createBranch } from '../../src/modules/branches/service';
import { createUser } from '../../src/modules/users/service';
import { createPurchase } from '../../src/modules/purchases/service';
import { recordAdvance, recordRepayment } from '../../src/modules/funding/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';

const ROUNDS = 8;
const PRICE = 1_500_000;
const CASH_PART = 400_000;
let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gm: Actor;
let cashier: Actor;
let branchId: number;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const bal = async () => Object.fromEntries((await balances(ctx.db, branchId)).map((b) => [b.kind, b.balance])) as Record<string, number>;
const fulfilled = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === 'fulfilled').length;
const codes = (rs: PromiseSettledResult<unknown>[]) =>
  rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.code ?? r.reason?.key ?? r.reason?.message ?? r.reason));

/** Fresh pieces of the test branch, received from a supplier order (tag price PRICE). */
const stock: number[] = [];
async function piece(): Promise<number> {
  if (!stock.length) {
    const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).orderBy(asc(t.products.id)).limit(1);
    const [s] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    const line = { productId: p.id, grossWeightMg: 4_100, netWeightMg: 4_000, purchaseCost: 700_000, makingCost: 0, otherCost: 0, sellingPrice: PRICE };
    const before = new Set((await ctx.db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(eq(t.jewelryItems.branchId, branchId))).map((r) => r.id));
    await createPurchase(ctx, gm, { branchId, supplierId: s.id, confirmOpenSupplierDebt: true, lines: Array.from({ length: 20 }, () => line) });
    const items = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, branchId), eq(t.jewelryItems.status, 'AVAILABLE'))).orderBy(asc(t.jewelryItems.id));
    stock.push(...items.map((i) => i.id).filter((id) => !before.has(id)));
  }
  return stock.shift()!;
}
/** A sale of one piece: CASH_PART in cash, the rest by the other method. */
async function splitSale(other: 'BANK_TRANSFER' | 'HASAD', n: number) {
  const ref = other === 'HASAD' ? { refInvoice: `HSD-RACE-${n}` } : { refTransaction: `RACE-${n}-${randomUUID().slice(0, 8)}` };
  return createSale(ctx, cashier, { items: [{ itemId: await piece() }], payments: [{ method: 'CASH', amount: CASH_PART }, { method: other, amount: PRICE - CASH_PART, ...ref }] });
}

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await actorOf('general.manager');
  branchId = (await createBranch(ctx, gm, { code: 'SPR', name: 'Split race', nameAr: 'فرع سباق الدفع', city: 'Test' })).id;
  await createUser(ctx, gm, { username: 'split.race.cashier', fullName: 'Split race cashier', roleCode: 'CASHIER', branchId });
  cashier = await actorOf('split.race.cashier');
  // The branch owes the General Manager enough for every repayment below; its drawer starts empty.
  await recordAdvance(ctx, gm, { branchId, account: 'BANK', amount: 50_000_000, reason: 'split race funding', bankReference: 'SPR-FUND-1' });
});
afterAll(async () => handle?.close());

describe('a split sale under concurrency (real PostgreSQL)', () => {
  it('two parallel voids: exactly one succeeds; every line is reversed once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const before = await bal();
      const sale = await splitSale(round % 2 ? 'HASAD' : 'BANK_TRANSFER', round);
      const rs = await Promise.allSettled([1, 2].map((i) => voidSale(ctx, gm, sale.id, `parallel void ${round}.${i}`)));
      expect(fulfilled(rs), `round ${round}`).toBe(1);
      expect(rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason?.key), `round ${round}`).toEqual(['Sale is already {status}']);
      expect(await bal(), `round ${round}`).toEqual(before);
      const voids = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'sale'), eq(t.ledgerEntries.refId, sale.id), eq(t.ledgerEntries.eventType, 'SALE_VOID')));
      expect(voids, `round ${round}`).toHaveLength(round % 2 ? 1 : 2); // a Hasad line moves no account, so it has nothing to reverse
    }
  });

  it('a void racing the sales report: the sale is in all of count, total and channels, or in none', async () => {
    const q = { branchId };
    const read = async () => {
      const r = await salesReportAggregates(ctx, gm, q);
      const channels = [...r.byChannel.values()].reduce((s, v) => s + Number(v ?? 0), 0);
      return { rows: r.rowCount, total: Number(r.totals.total ?? 0), channels, cash: Number(r.byChannel.get('CASH') ?? 0) };
    };
    for (let round = 0; round < ROUNDS; round++) {
      const sale = await splitSale('HASAD', 100 + round);
      const withSale = await read();
      const reads: Awaited<ReturnType<typeof read>>[] = [];
      let voided = false;
      const reader = (async () => {
        while (!voided || reads.length < 3) reads.push(await read());
      })();
      await voidSale(ctx, gm, sale.id, `void racing the report ${round}`);
      voided = true;
      await reader;
      const without = { rows: withSale.rows, total: withSale.total - PRICE, channels: withSale.channels - PRICE, cash: withSale.cash - CASH_PART };
      for (const r of reads) {
        expect(r.channels, `round ${round}`).toBe(r.total);
        expect([withSale, without], `round ${round}`).toContainEqual(r); // a voided sale still counts as a row
      }
      expect(await read()).toEqual(without);
    }
  });

  it('the same Idempotency-Key five times at once: one sale, its two lines, one entry per moving line', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ username: 'cashier.kh.01', password: DEMO_PASSWORDS.CASHIER });
    expect(login.status).toBe(200);
    agent.set('x-csrf-token', login.body.csrfToken);
    const krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
    const [item] = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.status, 'AVAILABLE'), eq(t.jewelryItems.branchId, krt))).orderBy(desc(t.jewelryItems.id)).limit(1);
    const total = item.sellingPrice;
    const key = randomUUID();
    const body = { items: [{ itemId: item.id }], payments: [{ method: 'CASH', amount: 1_000 }, { method: 'HASAD', amount: total - 1_000, refInvoice: 'HSD-IDEM-1' }] };
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => agent.post('/api/sales').set('Idempotency-Key', key).send(body)));
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const ok = rs.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    const sales = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, item.id));
    expect(sales).toHaveLength(1);
    const saleId = sales[0].saleId;
    expect(ok[0].body.id).toBe(saleId);
    const lines = await ctx.db.select().from(t.salePayments).where(eq(t.salePayments.saleId, saleId)).orderBy(asc(t.salePayments.lineNo));
    expect(lines.map((l) => [l.method, l.amount])).toEqual([['CASH', 1_000], ['HASAD', total - 1_000]]);
    const entries = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'sale'), eq(t.ledgerEntries.refId, saleId)));
    expect(entries.map((e) => [e.paymentMethod, e.amount])).toEqual([['CASH', 1_000]]);
  });

  it('the void of a split sale whose cash part is the whole drawer, racing a repayment of that cash: exactly one wins', async () => {
    let voids = 0;
    let repayments = 0;
    for (let round = 0; round < ROUNDS; round++) {
      expect((await bal()).CASH, `round ${round}`).toBe(0);
      const sale = await splitSale('BANK_TRANSFER', 200 + round);
      const before = await bal();
      expect(before.CASH).toBe(CASH_PART);
      const repay = () => recordRepayment(ctx, gm, { branchId, account: 'CASH', amount: CASH_PART, reason: `repayment racing a void ${round}` });
      const cancel = () => voidSale(ctx, gm, sale.id, `void racing a repayment ${round}`);
      const rs = await Promise.allSettled(round % 2 ? [repay(), cancel()] : [cancel(), repay()]);
      expect(fulfilled(rs), `round ${round}`).toBe(1);
      expect(codes(rs), `round ${round}`).toEqual(['DRAWER_SHORT']);
      const after = await bal();
      expect(after.CASH, `round ${round}`).toBe(0);
      const [row] = await ctx.db.select().from(t.sales).where(eq(t.sales.id, sale.id));
      if (row.status === 'VOIDED') {
        voids++;
        expect(after.BANK, `round ${round}`).toBe(before.BANK - (PRICE - CASH_PART));
        expect(after.OWED_TO_GM).toBe(before.OWED_TO_GM);
      } else {
        repayments++;
        expect(row.status).toBe('COMPLETED');
        expect(after.BANK).toBe(before.BANK);
        expect(after.OWED_TO_GM).toBe(before.OWED_TO_GM - CASH_PART);
      }
    }
    expect(voids + repayments).toBe(ROUNDS);
  });
});
