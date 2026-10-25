// PAY-1 (docs/plans/PAY-1.md §2, §3, §7; D-pay1-1): a sale paid by one or two payment lines.
// - one or two lines of different methods, each accepted at the counter, each amount a whole number above 0, summing
//   EXACTLY to the total (422 PAYMENT_TOTAL_MISMATCH otherwise); each method's references; the single-method shape is
//   one line of the whole total; both shapes at once are refused. A refusal writes nothing.
// - one ledger entry per line, on the line's account; a void reverses each line through its own account and restores
//   every balance exactly; the cash part of a void obeys the drawer rule (DRAWER_SHORT).
// - the duplicate bank reference works on a split sale's bank line; the lines are on the sale, its list row and its
//   print payload. Cost, profit and the sale-line snapshots do not depend on how the sale was paid.
// The test works in its own branch, which it funds itself (CLAUDE.md testing rules).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fc from 'fast-check';
import { and, asc, desc, eq } from 'drizzle-orm';
import { LEDGER_ACCOUNT_KINDS, paymentAccount, salePaymentLabel, splitRemainder, type PaymentMethod } from '@jerp/shared';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createSale, getSale, pageSales, voidSale } from '../src/modules/sales/service';
import { balances } from '../src/modules/ledger/service';
import { createBranch } from '../src/modules/branches/service';
import { createUser } from '../src/modules/users/service';
import { createPurchase } from '../src/modules/purchases/service';
import { recordAdvance, recordRepayment } from '../src/modules/funding/service';
import { printSale } from '../src/modules/print/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gm: Actor;
let cashier: Actor;
let branchId: number;
type Agent = ReturnType<typeof request.agent>;

const PRICE = 1_500_000;
const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string; params?: Record<string, string> }) => e);
const bal = async () => Object.fromEntries((await balances(ctx.db, branchId)).map((b) => [b.kind, b.balance])) as Record<string, number>;
const status = async (itemId: number) => (await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, itemId)))[0].status;
const salesCount = async () => (await ctx.db.select().from(t.sales).where(eq(t.sales.branchId, branchId))).length;

/** Fresh pieces of the test branch, received from a supplier order (tag price PRICE). */
const stock: number[] = [];
async function piece(): Promise<number> {
  if (!stock.length) {
    const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).orderBy(asc(t.products.id)).limit(1);
    const [s] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    const line = { productId: p.id, grossWeightMg: 4_100, netWeightMg: 4_000, purchaseCost: 700_000, makingCost: 0, otherCost: 0, sellingPrice: PRICE };
    await createPurchase(ctx, gm, { branchId, supplierId: s.id, confirmOpenSupplierDebt: true, lines: Array.from({ length: 12 }, () => line) });
    const items = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, branchId), eq(t.jewelryItems.status, 'AVAILABLE'))).orderBy(asc(t.jewelryItems.id));
    stock.push(...items.map((i) => i.id).filter((id) => !used.has(id)));
  }
  const id = stock.shift()!;
  used.add(id);
  return id;
}
const used = new Set<number>();

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = withIdempotencyKeys(request.agent(app)) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}

/** What each account must move by for these lines: + amount on the line's account (none for a line that moves none). */
function expectedMoves(lines: { method: PaymentMethod; amount: number }[], sign = 1) {
  const out: Record<string, number> = Object.fromEntries(LEDGER_ACCOUNT_KINDS.map((k) => [k, 0]));
  for (const l of lines) {
    const k = paymentAccount(l.method);
    if (k) out[k] += sign * l.amount;
  }
  return out;
}
const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(LEDGER_ACCOUNT_KINDS.map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)]));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await actorOf('general.manager');
  branchId = (await createBranch(ctx, gm, { code: 'PAY', name: 'Payments test', nameAr: 'فرع اختبار الدفع', city: 'Test' })).id;
  await createUser(ctx, gm, { username: 'pay.cashier', fullName: 'Pay cashier', roleCode: 'CASHIER', branchId });
  cashier = await actorOf('pay.cashier');
  // The branch funds its own drawer and bank (CLAUDE.md).
  await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: 5_000_000, reason: 'test drawer float' });
  await recordAdvance(ctx, gm, { branchId, account: 'BANK', amount: 5_000_000, reason: 'test bank funding', bankReference: 'PAY-FUND-1' });
});
afterAll(async () => handle?.close());

describe('shared rules', () => {
  it('the label is the one method, or SPLIT for two different methods', () => {
    expect(salePaymentLabel(['CASH'])).toBe('CASH');
    expect(salePaymentLabel(['HASAD', 'CASH'])).toBe('SPLIT');
    expect(() => salePaymentLabel([])).toThrow();
    expect(() => salePaymentLabel(['CASH', 'CASH'])).toThrow();
    expect(() => salePaymentLabel(['CASH', 'BANK_TRANSFER', 'HASAD'])).toThrow();
  });
  it('property: the remainder keeps the two parts summing exactly to the total, each above 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 2 ** 40 }), fc.integer({ min: -10, max: 2 ** 40 }), (total, first) => {
        const r = splitRemainder(total, first);
        if (first > 0 && first < total) {
          expect(r).not.toBeNull();
          expect(first + r!).toBe(total);
          expect(r!).toBeGreaterThan(0);
        } else expect(r).toBeNull();
      }),
    );
    expect(splitRemainder(1000, 1.5)).toBeNull();
  });
});

describe('a split sale', () => {
  const pairs: [PaymentMethod, PaymentMethod, Record<string, string>, Record<string, string>][] = [
    ['CASH', 'BANK_TRANSFER', {}, { refTransaction: ' pay ١٠٠١ ' }],
    ['HASAD', 'CASH', { refInvoice: 'HSD-PAY-1', refTransaction: 'htx-1' }, {}],
    ['BANK_TRANSFER', 'HASAD', { refTransaction: 'PAY-1002' }, { refInvoice: 'HSD-PAY-2' }],
  ];
  for (const [m1, m2, r1, r2] of pairs) {
    it(`${m1} + ${m2}: two lines, label SPLIT, one entry per line on its own account; the void restores every balance`, async () => {
      const itemId = await piece();
      const before = await bal();
      const first = 400_000;
      const sale = await createSale(ctx, cashier, { items: [{ itemId }], payments: [{ method: m1, amount: first, ...r1 }, { method: m2, amount: PRICE - first, ...r2 }] });
      expect(sale.paymentMethod).toBe('SPLIT');
      expect(sale.total).toBe(PRICE);
      const lines = (await getSale(ctx, gm, sale.id)).payments;
      expect(lines.map((l) => [l.method, l.amount])).toEqual([[m1, first], [m2, PRICE - first]]);
      // References stored per line, the bank one normalized.
      for (const l of lines) {
        if (l.method === 'BANK_TRANSFER') expect(l.refTransaction).toMatch(/^PAY[ -]1\d{3}$/);
        if (l.method === 'HASAD') expect(l.refInvoice).toMatch(/^HSD-PAY-/);
        if (l.method === 'CASH') expect([l.refInvoice, l.refTransaction]).toEqual([null, null]);
      }
      const entries = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'sale'), eq(t.ledgerEntries.refId, sale.id))).orderBy(asc(t.ledgerEntries.id));
      expect(entries.map((e) => [e.paymentMethod, e.amount])).toEqual(lines.filter((l) => paymentAccount(l.method)).map((l) => [l.method, l.amount]));
      expect(delta(before, await bal())).toEqual(expectedMoves(lines));
      await voidSale(ctx, gm, sale.id, 'test void of a split sale');
      expect(await bal()).toEqual(before);
      expect(await status(itemId)).toBe('AVAILABLE');
      // The lines never change: the void is the sale's status.
      expect((await getSale(ctx, gm, sale.id)).payments).toEqual(lines);
    });
  }

  it('the single-method shape is one line of the whole total', async () => {
    const itemId = await piece();
    const sale = await createSale(ctx, cashier, { items: [{ itemId }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'pay 2001' });
    const s = await getSale(ctx, gm, sale.id);
    expect(s.paymentMethod).toBe('BANK_TRANSFER');
    expect(s.payments).toEqual([{ method: 'BANK_TRANSFER', amount: PRICE, refInvoice: null, refTransaction: 'PAY 2001' }]);
    expect(s.paymentRefTransaction).toBe('PAY 2001');
    // A one-line `payments` request is the same thing.
    const other = await createSale(ctx, cashier, { items: [{ itemId: await piece() }], payments: [{ method: 'CASH', amount: PRICE }] });
    expect((await getSale(ctx, gm, other.id)).payments).toEqual([{ method: 'CASH', amount: PRICE, refInvoice: null, refTransaction: null }]);
  });

  it('refusals write nothing: sum off by one either way, amounts not above 0, the same method twice, missing references, both shapes', async () => {
    const itemId = await piece();
    const n = await salesCount();
    const before = await bal();
    const sell = (input: Record<string, unknown>) => refusal(createSale(ctx, cashier, { items: [{ itemId }], ...input } as never));
    for (const off of [-1, 1]) {
      const e = await sell({ payments: [{ method: 'CASH', amount: 500_000 }, { method: 'BANK_TRANSFER', amount: PRICE - 500_000 + off, refTransaction: 'PAY-3001' }] });
      expect(e).toMatchObject({ status: 422, code: 'PAYMENT_TOTAL_MISMATCH', params: { total: PRICE.toLocaleString('en-US'), sum: (PRICE + off).toLocaleString('en-US') } });
    }
    expect(await sell({ payments: [{ method: 'CASH', amount: PRICE - 1 }] })).toMatchObject({ status: 422, code: 'PAYMENT_TOTAL_MISMATCH' });
    for (const amount of [0, -5, 10.5]) {
      expect(await sell({ payments: [{ method: 'CASH', amount }, { method: 'BANK_TRANSFER', amount: PRICE - amount, refTransaction: 'PAY-3002' }] }), String(amount)).toMatchObject({ status: 400 });
    }
    expect(await sell({ payments: [{ method: 'CASH', amount: 500_000 }, { method: 'CASH', amount: PRICE - 500_000 }] })).toMatchObject({ status: 400, key: 'Each payment line must use a different method' });
    expect(await sell({ payments: [{ method: 'CASH', amount: 500_000 }, { method: 'BANK_TRANSFER', amount: PRICE - 500_000 }] })).toMatchObject({ status: 400, key: 'Enter the bank transfer reference' });
    expect(await sell({ payments: [{ method: 'CASH', amount: 500_000 }, { method: 'BANK_TRANSFER', amount: PRICE - 500_000, refTransaction: 'ab' }] })).toMatchObject({ status: 400 });
    expect(await sell({ payments: [{ method: 'HASAD', amount: 500_000 }, { method: 'CASH', amount: PRICE - 500_000 }] })).toMatchObject({ status: 400, key: 'Enter the Hasad invoice number' });
    expect(await sell({ payments: [{ method: 'CASH', amount: 500_000, refTransaction: 'X-1234' }, { method: 'HASAD', amount: PRICE - 500_000, refInvoice: 'H-1' }] })).toMatchObject({ status: 400 });
    expect(await sell({ payments: [{ method: 'CARD', amount: 500_000 }, { method: 'CASH', amount: PRICE - 500_000 }] })).toMatchObject({ status: 400, key: '{method} is not accepted at the counter' });
    expect(await sell({ payments: [{ method: 'CASH', amount: PRICE }], paymentMethod: 'CASH' })).toMatchObject({ status: 400, key: 'Send the payment lines or one payment method, not both' });
    expect(await sell({})).toMatchObject({ status: 400, key: 'Choose how the sale is paid' });
    expect(await sell({ payments: [{ method: 'CASH', amount: 1 }, { method: 'BANK_TRANSFER', amount: 1, refTransaction: 'PAY-3003' }, { method: 'HASAD', amount: PRICE - 2, refInvoice: 'H' }] })).toMatchObject({ status: 400 });
    expect(await salesCount()).toBe(n);
    expect(await bal()).toEqual(before);
    expect(await status(itemId)).toBe('AVAILABLE');
  });

  it('the API: three lines, both shapes and a mismatch are refused; a split sale answers with its lines', async () => {
    const api = await login('cashier.kh.01', 'CASHIER');
    const [item] = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.status, 'AVAILABLE'), eq(t.jewelryItems.branchId, (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id))).orderBy(desc(t.jewelryItems.id)).limit(1);
    const total = item.sellingPrice;
    const three = [{ method: 'CASH', amount: 1 }, { method: 'BANK_TRANSFER', amount: 1, refTransaction: 'API-0001' }, { method: 'HASAD', amount: total - 2, refInvoice: 'H-API' }];
    expect((await api.post('/api/sales').send({ items: [{ itemId: item.id }], payments: three })).status).toBe(400);
    expect((await api.post('/api/sales').send({ items: [{ itemId: item.id }], payments: [{ method: 'CASH', amount: total }], paymentMethod: 'CASH' })).status).toBe(400);
    const mismatch = await api.post('/api/sales').send({ items: [{ itemId: item.id }], payments: [{ method: 'CASH', amount: 1 }, { method: 'HASAD', amount: total - 2, refInvoice: 'H-API' }] });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('PAYMENT_TOTAL_MISMATCH');
    const ok = await api.post('/api/sales').send({ items: [{ itemId: item.id }], payments: [{ method: 'CASH', amount: 1 }, { method: 'HASAD', amount: total - 1, refInvoice: 'H-API', refTransaction: 'TX-API' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.paymentMethod).toBe('SPLIT');
    expect(ok.body.payments).toEqual([
      { method: 'CASH', amount: 1, refInvoice: null, refTransaction: null },
      { method: 'HASAD', amount: total - 1, refInvoice: 'H-API', refTransaction: 'TX-API' },
    ]);
    // The list row and the print payload carry the payment too.
    const page = await pageSales(ctx, gm, { q: ok.body.number, pageSize: 5 } as never);
    expect((page.rows[0] as { payments: unknown }).payments).toEqual(ok.body.payments);
    const printed = await printSale(ctx, gm, ok.body.id);
    expect(printed.document).toBeTruthy();
  });

  it('the duplicate bank reference: the bank line of a split sale is found, refused until confirmed, and the confirmation audited', async () => {
    const one = await createSale(ctx, cashier, { items: [{ itemId: await piece() }], payments: [{ method: 'CASH', amount: 100_000 }, { method: 'BANK_TRANSFER', amount: PRICE - 100_000, refTransaction: 'PAY-DUP-9' }] });
    const itemId = await piece();
    const input = { items: [{ itemId }], paymentMethod: 'BANK_TRANSFER' as const, paymentRefTransaction: 'pay-dup-9' };
    expect(await refusal(createSale(ctx, cashier, input))).toMatchObject({ status: 409, code: 'DUPLICATE_BANK_REFERENCE', params: { number: one.number } });
    const two = await createSale(ctx, cashier, { ...input, confirmDuplicateReference: true });
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'SALE_CREATED'), eq(t.auditLogs.entityId, two.number)));
    expect(audit.metadata).toMatchObject({ duplicateBankReferenceOf: one.number, bankReference: 'PAY-DUP-9', payments: [{ method: 'BANK_TRANSFER', amount: PRICE, refTransaction: 'PAY-DUP-9' }] });
    // A voided sale's reference no longer counts.
    await voidSale(ctx, gm, one.id, 'test');
    await voidSale(ctx, gm, two.id, 'test');
    const three = await createSale(ctx, cashier, { items: [{ itemId: await piece() }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'PAY-DUP-9' });
    expect(three.paymentMethod).toBe('BANK_TRANSFER');
  });

  it('cost, profit and the sale-line snapshots do not depend on how the sale was paid', async () => {
    const a = await createSale(ctx, cashier, { items: [{ itemId: await piece() }], paymentMethod: 'CASH' });
    const b = await createSale(ctx, cashier, { items: [{ itemId: await piece() }], payments: [{ method: 'CASH', amount: 1 }, { method: 'HASAD', amount: PRICE - 1, refInvoice: 'H-COST' }] });
    const [sa, sb] = [await getSale(ctx, gm, a.id), await getSale(ctx, gm, b.id)];
    expect([sb.costTotal, sb.grossProfit, sb.total]).toEqual([sa.costTotal, sa.grossProfit, sa.total]);
    const strip = (i: Record<string, unknown>) => ({ ...i, id: 0, itemId: 0, itemCode: '', barcode: '' });
    expect(sb.items.map(strip)).toEqual(sa.items.map(strip));
  });

  it('a void of a split sale refunds its cash part from the drawer: refused when the drawer is short, nothing changed', async () => {
    const sale = await createSale(ctx, cashier, { items: [{ itemId: await piece() }], payments: [{ method: 'CASH', amount: 600_000 }, { method: 'BANK_TRANSFER', amount: PRICE - 600_000, refTransaction: 'PAY-SHORT-1' }] });
    const drawer = (await bal()).CASH;
    // Pay the drawer out to the General Manager until 599,999 is left: the cash part is 1 more than that.
    await recordRepayment(ctx, gm, { branchId, account: 'CASH', amount: drawer - 599_999, reason: 'test repayment' });
    const before = await bal();
    const e = await refusal(voidSale(ctx, gm, sale.id, 'test void'));
    expect(e).toMatchObject({ status: 409, code: 'DRAWER_SHORT', params: { balance: '599,999', amount: '600,000', short: '1' } });
    expect(await bal()).toEqual(before);
    expect((await getSale(ctx, gm, sale.id)).status).toBe('COMPLETED');
    await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: 1, reason: 'test top-up' });
    await voidSale(ctx, gm, sale.id, 'test void');
    const after = await bal();
    expect(after.CASH).toBe(0);
    expect(after.BANK).toBe(before.BANK - (PRICE - 600_000));
  });

  it('the database refuses a sale whose lines do not match it, whoever writes it', async () => {
    const [s] = await ctx.db.select().from(t.sales).where(and(eq(t.sales.branchId, branchId), eq(t.sales.paymentMethod, 'BANK_TRANSFER'))).orderBy(asc(t.sales.id)).limit(1);
    const tamper = async (fn: (tx: Parameters<Parameters<Ctx['db']['transaction']>[0]>[0]) => Promise<unknown>) =>
      ctx.db.transaction(fn).then(() => null, (err: Error & { cause?: Error }) => `${err.message} ${err.cause?.message ?? ''}`);
    // A second line that breaks the sum; a label that disagrees with the lines; a sale without any line.
    expect(await tamper((tx) => tx.insert(t.salePayments).values({ saleId: s.id, lineNo: 2, method: 'HASAD', amount: 5, refInvoice: 'H-X' }))).toMatch(/payment line/);
    expect(await tamper((tx) => tx.update(t.sales).set({ paymentMethod: 'SPLIT' }).where(eq(t.sales.id, s.id)))).toMatch(/payment line/);
    expect(
      await tamper((tx) => tx.insert(t.sales).values({ number: 'PAY-NOLINE-1', branchId, cashierId: cashier.userId, subtotal: 10, total: 10, costTotal: 0, paymentMethod: 'CASH' })),
    ).toMatch(/payment line/);
  });
});
