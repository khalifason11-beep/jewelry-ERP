// SUP-1 (docs/plans/SUP-1.md, D-sup-*): a supplier allows one open order at a time, so a new order while gold is still
// owed to that supplier asks the General Manager first ("record anyway"), never blocks. Both projects. Company-wide (a
// supplier belongs to the company), weights / order number / days only, the confirmation audited, and the facts come
// from the same helper as attention A6 (one source of truth; A6 unchanged).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { pureGoldMg } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { dayKey } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { createPurchase, supplierOpenDebt, type PurchaseLine } from '../src/modules/purchases/service';
import { createSupplier } from '../src/modules/catalog/service';
import { buyScrap } from '../src/modules/scrap/service';
import { settleWithScrap } from '../src/modules/supplier-settlements/service';
import { attentionFor } from '../src/modules/attention/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gm: Actor;
let today: string;
let productId: number;
let krt: number;
let omd: number;
let refSeq = 0;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const branchOf = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string; params?: Record<string, unknown>; details?: Record<string, unknown> }) => e);
const line = (net = 2_000): PurchaseLine => ({ productId, grossWeightMg: net + 100, netWeightMg: net, purchaseCost: 700_000, makingCost: 30_000, otherCost: 0, sellingPrice: 1_200_000 });
const order = (supplierId: number, branchId: number, over: Record<string, unknown> = {}, opts: { at?: Date } = {}) =>
  createPurchase(ctx, gm, { branchId, supplierId, lines: [line()], makingChargeReference: `TEST-SUP-${++refSeq}`, makingChargeTransferDate: today, ...over }, opts);
const newSupplier = async (nameAr: string) => (await createSupplier(ctx, gm, { nameAr })).id;
const purchasesOf = async (supplierId: number) => ctx.db.select().from(t.purchases).where(eq(t.purchases.supplierId, supplierId));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await actorOf('general.manager');
  today = dayKey(new Date(), (await ctx.settings.get()).company.timezone);
  productId = (await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)))[0].id;
  krt = await branchOf('KRT');
  omd = await branchOf('OMD');
});
afterAll(async () => handle?.close());

describe('a new order while gold is still owed to the supplier', () => {
  it('no warning for a supplier with nothing owed', async () => {
    const s = await newSupplier('مورد اختبار بلا دين');
    expect(await supplierOpenDebt(ctx, gm, s)).toEqual({ supplierId: s, pureMg24: 0, orders: 0, oldestNumber: null, oldestPurchaseId: null, days: null });
    await order(s, krt);
    expect(await purchasesOf(s)).toHaveLength(1);
  });

  it('the first attempt is refused (409 SUPPLIER_GOLD_OWED) with weights, the order number and days only; nothing is recorded', async () => {
    const s = await newSupplier('مورد اختبار مدين');
    const twelveDaysAgo = new Date(Date.now() - 12 * 86_400_000 - 60_000);
    const first = await order(s, krt, { makingChargeTransferDate: dayKey(twelveDaysAgo, (await ctx.settings.get()).company.timezone) }, { at: twelveDaysAgo });
    const e = await err(order(s, krt));
    expect(e).toMatchObject({
      status: 409,
      code: 'SUPPLIER_GOLD_OWED',
      key: 'We still owe this supplier {weight} g of 24K from order {number}, open for {days} days. Record the new order anyway?',
      params: { weight: (pureGoldMg(2_000, 21) / 1000).toFixed(3), number: first.number, days: 12 },
      details: { pureMg24: pureGoldMg(2_000, 21), orders: 1, oldestNumber: first.number, oldestPurchaseId: first.id, days: 12 },
    });
    // Weights, counts, the order number and days: no money key anywhere in the warning.
    expect(Object.keys({ ...e!.params, ...e!.details }).filter((k) => /cost|price|amount|charge|money/i.test(k))).toEqual([]);
    expect(await purchasesOf(s)).toHaveLength(1);
  });

  it('"record anyway": the confirmed order is recorded and the confirmation is audited with the facts', async () => {
    const s = await newSupplier('مورد اختبار مؤكد');
    const first = await order(s, krt);
    const second = await order(s, krt, { confirmOpenSupplierDebt: true });
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'PURCHASE_CREATED'), eq(t.auditLogs.entityId, second.number)));
    expect(audit.metadata).toMatchObject({ openSupplierDebtConfirmed: { pureMg24: pureGoldMg(2_000, 21), orders: 1, oldestNumber: first.number, days: 0 } });
    // A first order (nothing owed) carries no such note.
    const [firstAudit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'PURCHASE_CREATED'), eq(t.auditLogs.entityId, first.number)));
    expect(firstAudit.metadata).not.toHaveProperty('openSupplierDebtConfirmed');
    // Both open orders now count: the next warning says 2 orders and the sum of both debts.
    expect(await supplierOpenDebt(ctx, gm, s)).toMatchObject({ orders: 2, pureMg24: 2 * pureGoldMg(2_000, 21), oldestNumber: first.number });
  });

  it('company-wide: an order still owed in another branch warns too (a supplier belongs to the company)', async () => {
    const s = await newSupplier('مورد اختبار فرعين');
    const inOmd = await order(s, omd);
    expect(await err(order(s, krt))).toMatchObject({ code: 'SUPPLIER_GOLD_OWED', details: { oldestNumber: inOmd.number } });
  });

  it('the warning disappears once the gold owed is settled with broken scrap', async () => {
    const s = await newSupplier('مورد اختبار مسدد');
    const bm = await actorOf('branch.manager.kh');
    const first = await order(s, krt);
    await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 2_000, netWeightMg: 2_000, paymentMethod: 'CASH' });
    const partly = await settleWithScrap(ctx, bm, first.id, { karat: 21, weightMg: 1_000 });
    expect(partly.goldOwedMgPure24).toBeGreaterThan(0);
    expect((await err(order(s, krt)))?.code).toBe('SUPPLIER_GOLD_OWED'); // still owed in part
    const done = await settleWithScrap(ctx, bm, first.id, { karat: 21, weightMg: 1_000 });
    expect(done.goldOwedMgPure24).toBe(0);
    expect((await supplierOpenDebt(ctx, gm, s)).orders).toBe(0);
    await order(s, krt); // no warning, no confirmation needed
    expect(await purchasesOf(s)).toHaveLength(2);
  });

  it('A6 reads the same facts and is unchanged (one source of truth)', async () => {
    const s = await newSupplier('مورد اختبار انتباه');
    const first = await order(s, krt);
    const a6 = (await attentionFor(ctx, gm)).signals.find((x) => x.id === `A6:${s}`)!;
    const facts = await supplierOpenDebt(ctx, gm, s);
    expect(a6).toMatchObject({ code: 'A6', severity: 'info', count: facts.orders, link: `/purchases/${first.id}`, params: { pureMg24: facts.pureMg24, orders: facts.orders, days: facts.days, supplierAr: 'مورد اختبار انتباه' } });
  });
});

describe('who can read it', () => {
  it('GET /suppliers/:id/gold-owed: the General Manager only (403 for the branch manager and the cashier), weights only', async () => {
    const login = async (username: string, role: keyof typeof DEMO_PASSWORDS) => {
      const agent = request.agent(app);
      const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
      agent.set('x-csrf-token', res.body.csrfToken);
      return agent;
    };
    const s = await newSupplier('مورد اختبار قراءة');
    const first = await order(s, krt);
    const gmA = await login('general.manager', 'GENERAL_MANAGER');
    const res = await gmA.get(`/api/suppliers/${s}/gold-owed`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supplierId: s, pureMg24: pureGoldMg(2_000, 21), orders: 1, oldestNumber: first.number, oldestPurchaseId: first.id, days: 0 });
    expect((await gmA.get('/api/suppliers/999999/gold-owed')).status).toBe(404);
    expect((await (await login('branch.manager.kh', 'BRANCH_MANAGER')).get(`/api/suppliers/${s}/gold-owed`)).status).toBe(403);
    expect((await (await login('cashier.kh.01', 'CASHIER')).get(`/api/suppliers/${s}/gold-owed`)).status).toBe(403);
    // Over HTTP the first attempt answers 409 with the facts in `details`; the retry with the flag is recorded.
    const body = { branchId: krt, supplierId: s, lines: [line()], makingChargeReference: 'TEST-SUP-HTTP', makingChargeTransferDate: today };
    const refused = await gmA.post('/api/purchases').set('Idempotency-Key', crypto.randomUUID()).send(body);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'SUPPLIER_GOLD_OWED', details: { oldestNumber: first.number } });
    const ok = await gmA.post('/api/purchases').set('Idempotency-Key', crypto.randomUUID()).send({ ...body, confirmOpenSupplierDebt: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});
