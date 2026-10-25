// MIS-1 (PUR-FIX, plan docs/plans/MIS-1.md §4, owner answer Q1 option B): the General Manager corrects a supplier order,
// one piece's making cost at a time, or the order's transfer reference. Both projects (the race with a sale is in
// test/pg/purchase-fix-race.test.ts; the property tests in test/purchase-fix.property.test.ts).
//   * who, the reason (3–200, else 422) and the password (missing / wrong → 403); a replay of the Idempotency-Key;
//   * a piece's making cost: the order's making charge = Σ effective piece values; the piece's live cost and making
//     charge change with two ADJUSTMENT movements while it is in stock (count, weight and value reconcile); a piece out of
//     stock changes cost only and its restock carries the new cost; a SOLD piece → 409 naming its code, its sale line
//     untouched; a sale after the correction snapshots the new cost;
//   * nothing changes → 422; the order's charge 0 with a reference → 422 (Q5), a piece at 0 with the total above 0 passes;
//   * the reference: FIX-2 normalization, a duplicate → 409 unless confirmed (audited); the new-order duplicate warning
//     sees corrected references;
//   * the reads (detail with the history, list, report) use the effective values; the supplier gold debt never changes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { dayKey } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { ledgerStock } from '../src/modules/inventory/ledger';
import { adjustItem } from '../src/modules/inventory/service';
import { createPurchase, getPurchase, pagePurchases, type PurchaseLine } from '../src/modules/purchases/service';
import { correctPurchase } from '../src/modules/purchases/corrections';
import { createSale } from '../src/modules/sales/service';
import { runReport } from '../src/modules/reports/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gmHttp: ReturnType<typeof request.agent>;
let gm: Actor;
let bm: Actor;
let cashier: Actor;
let krt: number;
let productId: number;
let supplierId: number;
let today: string;
let fixedTag = true;
let refSeq = 0;

const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const why = { reason: 'Typed the wrong amount', confirmPassword: PW };
const actorOf = async (username: string, sessionId: string | null = null): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, sessionId))!;
};
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; params?: Record<string, unknown> }) => e);
const line = (makingCost: number, net = 4_000): PurchaseLine => ({ productId, grossWeightMg: net + 100, netWeightMg: net, purchaseCost: 700_000, makingCost, otherCost: 15_000, ...(fixedTag ? { sellingPrice: 1_500_000 } : {}) });
const order = async (makings: number[], reference: string | null = `MIS1-REF-${++refSeq}`) =>
  createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: krt, supplierId, lines: makings.map((m) => line(m)), ...(reference ? { makingChargeReference: reference, makingChargeTransferDate: today } : {}) });
const linesOf = async (purchaseId: number) => ctx.db.select().from(t.purchaseItems).where(eq(t.purchaseItems.purchaseId, purchaseId)).orderBy(t.purchaseItems.id);
const piece = async (itemId: number) => (await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, itemId)))[0];
const stock = () => ledgerStock(ctx.db, krt, new Date(Date.now() + 60_000));
const fixCost = (purchaseId: number, purchaseItemId: number, newValue: number, extra: object = {}) => correctPurchase(ctx, gm, purchaseId, { field: 'MAKING_COST', purchaseItemId, newValue, ...why, ...extra });
const fixRef = (purchaseId: number, newValue: string, extra: object = {}) => correctPurchase(ctx, gm, purchaseId, { field: 'MAKING_CHARGE_REFERENCE', newValue, ...why, ...extra });

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gmHttp = withIdempotencyKeys(request.agent(app));
  const res = await gmHttp.post('/api/auth/login').send({ username: 'general.manager', password: PW });
  gmHttp.set('x-csrf-token', res.body.csrfToken);
  expect((await gmHttp.post('/api/auth/reauth').send({ password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gm = await actorOf('general.manager', s.id);
  bm = await actorOf('branch.manager.kh');
  cashier = await actorOf('cashier.kh.01');
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  productId = (await ctx.db.select().from(t.products).where(and(eq(t.products.karat, 21), eq(t.products.isActive, true))).limit(1))[0].id;
  supplierId = (await ctx.db.select().from(t.suppliers))[0].id;
  const settings = await ctx.settings.get();
  today = dayKey(new Date(), settings.company.timezone);
  fixedTag = settings.pricing.mode === 'FIXED_TAG';
});
afterAll(async () => handle?.close());

describe('who, the reason and the password', () => {
  it('only the General Manager: the branch manager and the cashier get 403', async () => {
    const po = await order([50_000]);
    const [l] = await linesOf(po.id);
    for (const a of [bm, cashier]) expect((await err(correctPurchase(ctx, a, po.id, { field: 'MAKING_COST', purchaseItemId: l.id, newValue: 40_000, ...why })))?.status).toBe(403);
    expect(await ctx.db.select().from(t.purchaseCorrections).where(eq(t.purchaseCorrections.purchaseId, po.id))).toEqual([]);
  });

  it('the reason at 2 and 201 characters → 422, at 3 and 200 → saved; missing or wrong password → 403', async () => {
    const po = await order([50_000, 60_000]);
    const [a, b] = await linesOf(po.id);
    const send = (body: object) => gmHttp.post(`/api/purchases/${po.id}/corrections`).send({ field: 'MAKING_COST', purchaseItemId: a.id, newValue: 45_000, ...body });
    for (const reason of ['ab', ` ${'x'.repeat(201)} `, undefined]) {
      const r = await send({ reason, confirmPassword: PW });
      expect([r.status, r.body.error.code], String(reason)).toEqual([422, 'CORRECTION_REASON_REQUIRED']);
    }
    expect([(await send({ reason: 'abcd' })).body.error.code]).toEqual(['CONFIRM_PASSWORD_REQUIRED']);
    const wrong = await send({ reason: 'abcd', confirmPassword: 'nope-nope' });
    expect([wrong.status, wrong.body.error.code]).toEqual([403, 'REAUTH_FAILED']);
    expect(await ctx.db.select().from(t.purchaseCorrections).where(eq(t.purchaseCorrections.purchaseId, po.id))).toEqual([]);
    expect((await send({ reason: 'abc', confirmPassword: PW })).status).toBe(200);
    const long = 'r'.repeat(200);
    const r200 = await gmHttp.post(`/api/purchases/${po.id}/corrections`).send({ field: 'MAKING_COST', purchaseItemId: b.id, newValue: 61_000, reason: long, confirmPassword: PW });
    expect(r200.status).toBe(200);
    const rows = await ctx.db.select().from(t.purchaseCorrections).where(eq(t.purchaseCorrections.purchaseId, po.id)).orderBy(t.purchaseCorrections.id);
    expect(rows.map((r) => r.reason)).toEqual(['abc', long]);
  });

  it('the same Idempotency-Key replays the first answer and corrects once', async () => {
    const po = await order([50_000]);
    const [l] = await linesOf(po.id);
    const key = randomUUID();
    const send = () => gmHttp.post(`/api/purchases/${po.id}/corrections`).set('Idempotency-Key', key).send({ field: 'MAKING_COST', purchaseItemId: l.id, newValue: 30_000, ...why });
    const first = await send();
    const again = await send();
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await ctx.db.select().from(t.purchaseCorrections).where(eq(t.purchaseCorrections.purchaseId, po.id))).toHaveLength(1);
    expect((await piece(l.itemId)).acquisitionCost).toBe(700_000 + 30_000 + 15_000);
  });
});

describe('a piece\'s making cost', () => {
  it('in stock: the piece\'s cost and making charge, two ADJUSTMENT movements, stock reconciles; the order total follows; gold debt unchanged', async () => {
    const po = await order([50_000, 70_000]);
    const [a, b] = await linesOf(po.id);
    const before = await stock();
    const [p0] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, po.id));
    await fixCost(po.id, a.id, 20_000);
    const pa = await piece(a.itemId);
    expect([pa.acquisitionCost, pa.makingCharge]).toEqual([700_000 + 20_000 + 15_000, 20_000]);
    const moves = await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, a.itemId)).orderBy(t.inventoryMovements.id);
    expect(moves.map((m) => [m.type, m.direction, m.costValue])).toEqual([
      ['PURCHASE', 1, 765_000],
      ['ADJUSTMENT', -1, 765_000],
      ['ADJUSTMENT', 1, 735_000],
    ]);
    const after = await stock();
    expect(after).toEqual({ items: before.items, weightMg: before.weightMg, cost: before.cost - 765_000 + 735_000, unknownCostPieces: before.unknownCostPieces });
    const [avail] = await ctx.db
      .select({ n: sql<number>`count(*)`.mapWith(Number), c: sql<number>`coalesce(sum(acquisition_cost), 0)`.mapWith(Number) })
      .from(t.jewelryItems)
      .where(and(eq(t.jewelryItems.branchId, krt), eq(t.jewelryItems.status, 'AVAILABLE')));
    expect([avail.n, avail.c]).toEqual([after.items, after.cost]);
    const d = await getPurchase(ctx, gm, po.id);
    expect(d.makingChargePaid).toBe(20_000 + 70_000);
    expect(d.totalCost).toBe(p0.totalCost - 30_000);
    expect(d.items.find((i) => i.itemId === a.itemId)?.makingCost).toBe(20_000);
    expect(d.items.find((i) => i.itemId === b.itemId)?.makingCost).toBe(70_000);
    expect([d.goldDebtMgPure24, d.goldOwedMgPure24]).toEqual([p0.goldDebtMgPure24, p0.goldOwedMgPure24]);
    expect(d.corrections).toMatchObject([{ field: 'MAKING_COST', itemCode: pa.code, valueBefore: '50000', valueAfter: '20000', reason: 'Typed the wrong amount', correctedByName: expect.any(String) }]);
    // The stored rows are never updated.
    expect((await linesOf(po.id))[0].makingCost).toBe(50_000);
    expect((await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, po.id)))[0].makingChargePaid).toBe(120_000);
    // A second correction of the same piece: the latest wins; the history keeps both.
    await fixCost(po.id, a.id, 25_000);
    const d2 = await getPurchase(ctx, gm, po.id);
    expect(d2.makingChargePaid).toBe(25_000 + 70_000);
    expect(d2.corrections.map((c) => [c.valueBefore, c.valueAfter])).toEqual([['50000', '20000'], ['20000', '25000']]);
    // The audit: actor, reason, ids, before and after; never the password.
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'PURCHASE_CORRECTED'), eq(t.auditLogs.entityId, po.number))).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.userId).toBe(gm.userId);
    expect(audit.metadata).toMatchObject({ purchaseItemId: a.id, itemCode: pa.code, reason: 'Typed the wrong amount', before: { makingCost: 20_000, orderMakingCharge: 90_000 }, after: { makingCost: 25_000, orderMakingCharge: 95_000 } });
    expect(JSON.stringify(audit)).not.toContain(PW);
  });

  it('a SOLD piece → 409 naming its code; its sale line keeps its cost exactly', async () => {
    const po = await order([50_000, 60_000]);
    const [a] = await linesOf(po.id);
    const sale = await createSale(ctx, cashier, { items: [{ itemId: a.itemId }], paymentMethod: 'CASH' });
    const [saleLine0] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sale.id));
    const e = await err(fixCost(po.id, a.id, 10_000));
    expect([e?.status, e?.code]).toEqual([409, 'PURCHASE_PIECE_SOLD']);
    expect(e?.params).toMatchObject({ code: (await piece(a.itemId)).code });
    const [saleLine1] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sale.id));
    expect(saleLine1).toEqual(saleLine0);
    expect((await piece(a.itemId)).acquisitionCost).toBe(765_000);
  });

  it('a sale after the correction snapshots the new cost', async () => {
    const po = await order([50_000]);
    const [a] = await linesOf(po.id);
    await fixCost(po.id, a.id, 5_000);
    const sale = await createSale(ctx, cashier, { items: [{ itemId: a.itemId }], paymentMethod: 'CASH' });
    const [sl] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sale.id));
    expect(sl.acquisitionCost).toBe(700_000 + 5_000 + 15_000);
  });

  it('out of stock (damaged): the cost changes without movements; the restock carries the new cost; stock reconciles', async () => {
    const po = await order([50_000]);
    const [a] = await linesOf(po.id);
    await adjustItem(ctx, gm, a.itemId, 'MARK_DAMAGED', 'dropped');
    const before = await stock();
    await fixCost(po.id, a.id, 10_000);
    expect(await stock()).toEqual(before);
    const moves0 = await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, a.itemId));
    expect(moves0.map((m) => m.type)).toEqual(['PURCHASE', 'DAMAGE']);
    await adjustItem(ctx, gm, a.itemId, 'RESTOCK', 'repaired');
    expect(await stock()).toEqual({ items: before.items + 1, weightMg: before.weightMg + 4_000, cost: before.cost + 725_000, unknownCostPieces: before.unknownCostPieces });
  });

  it('nothing changes → 422; the total to 0 with a reference → 422 (Q5); one piece at 0 with the total above 0 passes', async () => {
    const po = await order([40_000, 30_000]);
    const [a, b] = await linesOf(po.id);
    expect((await err(fixCost(po.id, a.id, 40_000)))?.code).toBe('CORRECTION_NO_CHANGE');
    await fixCost(po.id, a.id, 0);
    expect((await getPurchase(ctx, gm, po.id)).makingChargePaid).toBe(30_000);
    const e = await err(fixCost(po.id, b.id, 0));
    expect([e?.status, e?.code]).toEqual([422, 'MAKING_CHARGE_ZERO_WITH_REFERENCE']);
    expect((await getPurchase(ctx, gm, po.id)).makingChargePaid).toBe(30_000);
  });

  it('an order without a making charge: a piece above 0 needs a reference first (422); a line of another order → 404', async () => {
    const po = await order([0, 0], null);
    const [a] = await linesOf(po.id);
    expect((await err(fixCost(po.id, a.id, 10_000)))?.code).toBe('MAKING_CHARGE_NEEDS_REFERENCE');
    expect((await err(fixRef(po.id, 'ANY-REF-1')))?.code).toBe('MAKING_CHARGE_NONE');
    const other = await order([10_000]);
    expect((await err(fixCost(other.id, a.id, 5_000)))?.status).toBe(404);
  });
});

describe('the transfer reference', () => {
  it('normalized (FIX-2); a duplicate → 409 unless confirmed (audited); nothing changes → 422', async () => {
    const po = await order([50_000], 'MIS1 ORIG 1');
    const other = await order([60_000], 'MIS1 TAKEN 1');
    const r = await fixRef(po.id, 'mis1 new ٧٧٨٨');
    expect(r.valueAfter).toBe('MIS1 NEW 7788');
    expect((await getPurchase(ctx, gm, po.id)).makingChargeReference).toBe('MIS1 NEW 7788');
    expect((await err(fixRef(po.id, 'MIS1 NEW 7788')))?.code).toBe('CORRECTION_NO_CHANGE');
    const dup = await err(fixRef(po.id, 'mis1 taken 1'));
    expect([dup?.status, dup?.code]).toEqual([409, 'DUPLICATE_BANK_REFERENCE']);
    expect(dup?.params).toMatchObject({ number: other.number });
    await fixRef(po.id, 'MIS1 TAKEN 1', { confirmDuplicateReference: true });
    const [c] = await ctx.db.select().from(t.purchaseCorrections).where(eq(t.purchaseCorrections.purchaseId, po.id)).orderBy(desc(t.purchaseCorrections.id)).limit(1);
    expect(c.confirmedDuplicate).toBe(true);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'PURCHASE_CORRECTED'), eq(t.auditLogs.entityId, po.number))).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.metadata).toMatchObject({ duplicateReferenceOf: other.number });
    expect((await err(fixRef(po.id, 'x')))?.status).toBe(400);
  });

  it('a new order with a reference that a correction put on another order is warned about', async () => {
    const po = await order([50_000], 'MIS1 BEFORE 9');
    await fixRef(po.id, 'MIS1 AFTER 9');
    const e = await err(createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: krt, supplierId, lines: [line(10_000)], makingChargeReference: 'MIS1 AFTER 9', makingChargeTransferDate: today }));
    expect([e?.status, e?.code]).toEqual([409, 'DUPLICATE_BANK_REFERENCE']);
    // The old reference is free again.
    expect((await createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: krt, supplierId, lines: [line(10_000)], makingChargeReference: 'MIS1 BEFORE 9', makingChargeTransferDate: today })).id).toBeGreaterThan(0);
  });
});

describe('the reads use the effective values', () => {
  it('the list, its totals and the purchases report; the branch manager sees the history without the values', async () => {
    const po = await order([50_000, 50_000]);
    const [a] = await linesOf(po.id);
    const [p0] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, po.id));
    const all0 = await pagePurchases(ctx, gm, { branchId: krt, q: po.number });
    await fixCost(po.id, a.id, 80_000);
    const all1 = await pagePurchases(ctx, gm, { branchId: krt, q: po.number });
    expect(all1.rows[0].totalCost).toBe(p0.totalCost + 30_000);
    expect((all1.totals as { totalCost: number }).totalCost - (all0.totals as { totalCost: number }).totalCost).toBe(30_000);
    const report = await runReport(ctx, gm, 'purchases', { branchId: krt, from: today, to: today, q: po.number } as never);
    expect((report.rows as { number: string; totalCost: number }[]).find((r) => r.number === po.number)?.totalCost).toBe(p0.totalCost + 30_000);
    const http = await gmHttp.get(`/api/purchases/${po.id}`);
    expect(http.body.corrections).toHaveLength(1);
    const bmHttp = request.agent(app);
    const res = await bmHttp.post('/api/auth/login').send({ username: 'branch.manager.kh', password: DEMO_PASSWORDS.BRANCH_MANAGER });
    bmHttp.set('x-csrf-token', res.body.csrfToken);
    const seen = await bmHttp.get(`/api/purchases/${po.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.corrections[0]).toMatchObject({ field: 'MAKING_COST', reason: 'Typed the wrong amount' });
    expect(seen.body.corrections[0].valueAfter).toBeUndefined();
    expect(seen.body.corrections[0].valueBefore).toBeUndefined();
  });
});
