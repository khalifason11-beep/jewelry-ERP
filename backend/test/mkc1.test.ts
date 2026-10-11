// MKC-1 (docs/plans/MKC-1.md, D-mkc-*): a supplier order's making charge is paid by the owner, by one bank transfer from
// his PERSONAL account. Both projects. The order records the payment fact (OWNER_PERSONAL, the reference, the date) and
// moves no branch money; the making charge stays in each piece's cost, so cost and profit are exactly as before; a day
// with only an order asks for no cash count; only the General Manager records orders; the gold side is unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { DEFAULT_ROLE_PERMISSIONS, GM_ONLY_PERMISSIONS, pureGoldMg, REPORT_KEYS, sumInt } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { addDays, dayKey, dayStart } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { balances, drawer, reconciliation } from '../src/modules/ledger/service';
import { createBranch } from '../src/modules/branches/service';
import { createPurchase, type PurchaseLine } from '../src/modules/purchases/service';
import { createSale } from '../src/modules/sales/service';
import { buyScrap } from '../src/modules/scrap/service';
import { settleWithScrap } from '../src/modules/supplier-settlements/service';
import { owedOf, recordAdvance } from '../src/modules/funding/service';
import { attentionFor } from '../src/modules/attention/service';
import { branchDashboard, companyDashboard } from '../src/modules/dashboard/service';
import { runReport } from '../src/modules/reports/service';
import { seedRolesAndPermissions } from '../src/seed/reference';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gm: Actor;
let tz: string;
let today: string;
let productId: number;
let supplierId: number;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string; details?: { number?: string } }) => e);
const line = (makingCost: number, net = 4_000, purchaseCost = 700_000): PurchaseLine => ({ productId, grossWeightMg: net + 100, netWeightMg: net, purchaseCost, makingCost, otherCost: 15_000, sellingPrice: 1_500_000 });
const newBranch = async (code: string) => (await createBranch(ctx, gm, { code, name: `Test ${code}`, nameAr: `اختبار ${code}`, city: 'Test' })).id;
const login = async (username: string, role: keyof typeof DEMO_PASSWORDS) => {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
};

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await actorOf('general.manager');
  tz = (await ctx.settings.get()).company.timezone;
  today = dayKey(new Date(), tz);
  productId = (await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)))[0].id;
  supplierId = (await ctx.db.select().from(t.suppliers))[0].id;
});
afterAll(async () => handle?.close());

describe('the payment fact: no branch money moves', () => {
  it('an order records OWNER_PERSONAL, the normalized reference and the date, posts no ledger entry, and changes no money figure', async () => {
    const b = await newBranch('MK1');
    await recordAdvance(ctx, gm, { branchId: b, account: 'CASH', amount: 500_000, reason: 'test drawer float' });
    const money = async () => ({
      balances: await balances(ctx.db, b),
      owed: await owedOf(ctx, b),
      drawer: (await drawer(ctx, gm, {})).branches.find((x) => x.branchId === b),
      rec: await reconciliation(ctx, gm, { branchId: b, day: today }),
      home: (({ expectedCash, lastCount }) => ({ expectedCash, lastCount }))(await branchDashboard(ctx, gm, { branchId: b })),
    });
    const before = await money();
    const po = await createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: b, supplierId, lines: [line(120_000), line(130_000, 5_000)], makingChargeReference: 'trf ٤٤٥٥', makingChargeTransferDate: today });
    expect(await money()).toEqual(before);
    const [row] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, po.id));
    expect(row).toMatchObject({ makingChargePaid: 250_000, makingChargePaidFrom: 'OWNER_PERSONAL', makingChargeReference: 'TRF 4455', makingChargeTransferDate: today });
    expect(await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'purchase'), eq(t.ledgerEntries.refId, po.id)))).toEqual([]);
    const lines = before.rec.cashLines.map((l) => l.line);
    expect(lines).not.toContain('MAKING_CHARGES');
    expect(before.rec).not.toHaveProperty('makingChargesCash');
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'PURCHASE_CREATED'), eq(t.auditLogs.entityId, po.number)));
    expect(audit.metadata).toMatchObject({ makingChargePaidBy: 'OWNER_PERSONAL', makingChargeReference: 'TRF 4455', makingChargeTransferDate: today });
  });
});

describe('the fixture world', () => {
  it('records every supplier order as paid by the owner, and no making charge ever touched a drawer or a bank', async () => {
    const orders = await ctx.db.select().from(t.purchases);
    expect(orders.length).toBeGreaterThan(10);
    expect(orders.every((o) => o.makingChargePaidFrom === 'OWNER_PERSONAL')).toBe(true);
    expect(orders.filter((o) => (o.makingChargePaid ?? 0) > 0).every((o) => o.makingChargeReference && o.makingChargeTransferDate)).toBe(true);
    expect(await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.eventType, 'SUPPLIER_MAKING_CHARGE'))).toEqual([]);
    expect(await ctx.db.select().from(t.ledgerEntries).where(eq(t.ledgerEntries.refType, 'purchase'))).toEqual([]);
  });
});

describe('cost and profit stay exactly as before (Q6)', () => {
  it('every cost and profit figure equals the arithmetic of the order lines, the making charge included', async () => {
    const b = await newBranch('MK2');
    const lines = [line(120_000, 4_000, 700_000), line(90_000, 6_000, 1_000_000), line(0, 3_000, 500_000)];
    const acq = lines.map((l) => l.purchaseCost + l.makingCost + l.otherCost);
    const po = await createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: b, supplierId, lines, makingChargeReference: 'TEST-COST-1', makingChargeTransferDate: today });
    // Each piece's cost basis = purchase + making + other, whoever paid the making charge.
    const items = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.purchaseId, po.id)).orderBy(t.jewelryItems.id);
    expect(items.map((i) => i.acquisitionCost)).toEqual(acq);
    expect(items.map((i) => i.makingCharge)).toEqual(lines.map((l) => l.makingCost));
    // Sell the first piece in cash: its cost of sales and profit carry the making charge.
    const sale = await createSale(ctx, gm, { branchId: b, items: [{ itemId: items[0].id }], paymentMethod: 'CASH' });
    const [saleItem] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sale.id));
    expect(saleItem.unitCost).toBe(acq[0]);
    const range = { from: addDays(today, -1), to: today, branchId: b };
    // Every report (their CSV exports are built in the browser from these same rows) runs and its figures add up.
    const reports = Object.fromEntries(await Promise.all(REPORT_KEYS.map(async (k) => [k, await runReport(ctx, gm, k, range)] as const)));
    const totals = (k: string) => (reports[k] as { totals: Record<string, number> }).totals;
    expect(totals('purchases').totalCost).toBe(sumInt(acq));
    // The inventory report lists every piece of the branch whatever its status (the sold one too).
    expect(totals('inventory').totalCost).toBe(sumInt(acq));
    expect(totals('sales')).toMatchObject({ costTotal: acq[0], grossProfit: sale.total - acq[0] });
    expect(totals('profit')).toMatchObject({ costOfSales: acq[0], grossProfit: sale.total - acq[0] });
    expect(totals('branch-performance')).toMatchObject({ purchasesCost: sumInt(acq), grossProfit: sale.total - acq[0], inventoryCost: acq[1] + acq[2], availableItems: 2 });
    // The GM home: this branch's strip.
    const home = await companyDashboard(ctx, gm, { from: today, to: today });
    expect(home.branches.find((x) => x.branchId === b)).toMatchObject({ costOfSales: acq[0], grossProfit: sale.total - acq[0], purchasesCost: sumInt(acq), inventoryCost: acq[1] + acq[2] });
    // Money: the drawer holds the sale only (no making charge left it).
    expect((await balances(ctx.db, b)).find((x) => x.kind === 'CASH')!.balance).toBe(sale.total);
  });
});

describe('a day with only a supplier order asks for no cash count (A5)', () => {
  it('an order recorded late yesterday raises no A5; a cash movement yesterday does (control)', async () => {
    const b = await newBranch('MK3');
    const lateYesterday = new Date(dayStart(today, tz).getTime() - 60 * 60_000); // 23:00 yesterday, business time
    await createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: b, supplierId, lines: [line(80_000)], makingChargeReference: 'TEST-NIGHT-1', makingChargeTransferDate: addDays(today, -1) }, { at: lateYesterday });
    const a5 = async () => (await attentionFor(ctx, gm)).signals.filter((s) => s.code === 'A5' && s.branchId === b);
    expect(await a5()).toHaveLength(0);
    await recordAdvance(ctx, gm, { branchId: b, account: 'CASH', amount: 10_000, reason: 'test float yesterday' }, { at: lateYesterday });
    expect(await a5()).toHaveLength(1);
  });
});

describe('the transfer reference and date', () => {
  const order = (over: Record<string, unknown>, lines = [line(50_000)]) => createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: undefined as never, supplierId, lines, ...over });
  it('are required above 0, follow the FIX-2 reference rules, and the date is a real day, never in the future', async () => {
    const krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
    const at = (over: Record<string, unknown>, lines?: PurchaseLine[]) => err(order({ branchId: krt, ...over }, lines));
    expect((await at({ makingChargeTransferDate: today }))?.key).toBe('Enter the bank transfer reference (4 to 40 letters or digits)');
    expect((await at({ makingChargeReference: 'AB1', makingChargeTransferDate: today }))?.key).toBe('Enter the bank transfer reference (4 to 40 letters or digits)');
    expect((await at({ makingChargeReference: 'TEST-DATE-1' }))?.key).toBe('Enter the date of the transfer');
    expect((await at({ makingChargeReference: 'TEST-DATE-2', makingChargeTransferDate: addDays(today, 1) }))?.key).toBe('The transfer date cannot be in the future');
    expect((await at({ makingChargeReference: 'TEST-DATE-3', makingChargeTransferDate: '2026-02-30' }))?.status).toBe(400);
    // A charge of 0: no reference, no date (and giving one is refused rather than silently dropped).
    expect((await at({ makingChargeReference: 'TEST-ZERO-1', makingChargeTransferDate: today }, [line(0)]))?.key).toBe('A making charge of 0 has no transfer to record');
    const zero = await order({ branchId: krt }, [line(0)]);
    expect(zero).toMatchObject({ makingChargePaid: 0, makingChargePaidFrom: 'OWNER_PERSONAL', makingChargeReference: null, makingChargeTransferDate: null });
  });

  it('Q4: a reference already on another order (any branch) asks for a confirmation, never blocks, and the confirmation is audited', async () => {
    const krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
    const omd = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'OMD')))[0].id;
    const first = await order({ branchId: krt, makingChargeReference: 'TEST-DUP-77', makingChargeTransferDate: today });
    const e = await err(order({ branchId: omd, makingChargeReference: 'test dup 77'.replace(/ /g, '-'), makingChargeTransferDate: today }));
    expect(e).toMatchObject({ status: 409, code: 'DUPLICATE_BANK_REFERENCE', key: 'This transfer reference is already on supplier order {number}. Record it anyway?', details: { number: first.number } });
    const again = await order({ branchId: omd, makingChargeReference: 'TEST-DUP-77', makingChargeTransferDate: today, confirmDuplicateReference: true });
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'PURCHASE_CREATED'), eq(t.auditLogs.entityId, again.number)));
    expect(audit.metadata).toMatchObject({ duplicateReferenceOf: first.number });
  });
});

describe('only the General Manager records an order; the branch manager keeps the rest', () => {
  it('HTTP: 403 for the branch manager and the cashier; the old payment source is refused; the GM sees the reference and date, the branch manager does not', async () => {
    const gmA = await login('general.manager', 'GENERAL_MANAGER');
    const bmA = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
    const body = { confirmOpenSupplierDebt: true, branchId: krt, supplierId, lines: [line(60_000)], makingChargeReference: 'TEST-HTTP-1', makingChargeTransferDate: today };
    expect((await bmA.post('/api/purchases').set('Idempotency-Key', crypto.randomUUID()).send(body)).status).toBe(403);
    expect((await cashier.post('/api/purchases').set('Idempotency-Key', crypto.randomUUID()).send(body)).status).toBe(403);
    expect((await gmA.post('/api/purchases').set('Idempotency-Key', crypto.randomUUID()).send({ ...body, makingChargePaidFrom: 'CASH' })).status).toBe(400);
    const res = await gmA.post('/api/purchases').set('Idempotency-Key', crypto.randomUUID()).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const gmDetail = (await gmA.get(`/api/purchases/${res.body.id}`)).body;
    expect(gmDetail).toMatchObject({ makingChargePaidFrom: 'OWNER_PERSONAL', makingChargeReference: 'TEST-HTTP-1', makingChargeTransferDate: today });
    const bmDetail = (await bmA.get(`/api/purchases/${res.body.id}`)).body;
    expect(bmDetail.makingChargePaidFrom).toBe('OWNER_PERSONAL');
    expect(bmDetail).not.toHaveProperty('makingChargeReference');
    expect(bmDetail).not.toHaveProperty('makingChargeTransferDate');
    const bmList = (await bmA.get('/api/purchases')).body as Record<string, unknown>[];
    expect(bmList.length).toBeGreaterThan(0);
    expect(bmList.every((r) => !('makingChargeReference' in r))).toBe(true);
    expect(((await gmA.get('/api/purchases')).body as { number: string; makingChargeReference?: string }[]).find((r) => r.number === res.body.number)?.makingChargeReference).toBe('TEST-HTTP-1');
  });

  it('GM-only permissions: never in another role’s defaults, nor in the database after the seed (run again too)', async () => {
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (role === 'GENERAL_MANAGER') expect(perms).toEqual(expect.arrayContaining([...GM_ONLY_PERMISSIONS]));
      else for (const p of GM_ONLY_PERMISSIONS) expect(perms, `${role} ${p}`).not.toContain(p);
    }
    await seedRolesAndPermissions(ctx.db);
    const holders = await ctx.db
      .select({ role: t.roles.code, perm: t.rolePermissions.permissionCode })
      .from(t.rolePermissions)
      .innerJoin(t.roles, eq(t.roles.id, t.rolePermissions.roleId));
    for (const p of GM_ONLY_PERMISSIONS) expect(holders.filter((h) => h.perm === p).map((h) => h.role), p).toEqual(['GENERAL_MANAGER']);
  });

  it('the gold side is unchanged: the order owes its pure-24K weight, and the branch manager settles it with broken scrap', async () => {
    const bm = await actorOf('branch.manager.kh');
    const krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
    const po = await createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: krt, supplierId, lines: [line(40_000, 2_000)], makingChargeReference: 'TEST-GOLD-1', makingChargeTransferDate: today });
    const owed = pureGoldMg(2_000, 21);
    expect(po).toMatchObject({ goldDebtMgPure24: owed, goldOwedMgPure24: owed });
    await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'CASH' });
    const s = await settleWithScrap(ctx, bm, po.id, { karat: 21, weightMg: 1_000 });
    expect(s.goldOwedMgPure24).toBe(owed - pureGoldMg(1_000, 21));
  });
});
