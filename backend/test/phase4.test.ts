// Phase 4: karat restriction, broken-scrap weight pool, gold-for-gold supplier settlement, counter
// payment methods (HASAD), stock weight incl. the pool, multi-item transfers. Runs on PGlite AND
// real PostgreSQL (the settlement race is in test/pg/settlement-race.test.ts).

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, count, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { COLUMN_CLASSES, COST_RESPONSE_FIELDS, SAFE_RESPONSE_FIELDS, pureGoldMg, sumInt } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { rows } from '../src/core/sql';
import { resetThrottleMemory } from '../src/auth/lockout';
import { loadActor } from '../src/modules/sessions/service';
import { createPurchase } from '../src/modules/purchases/service';
import { createSale } from '../src/modules/sales/service';
import { changePrice } from '../src/modules/inventory/service';
import { buyScrap, poolBalances, setScrapRates } from '../src/modules/scrap/service';
import { settleWithScrap } from '../src/modules/supplier-settlements/service';
import { balances, settleHasadReceivable } from '../src/modules/ledger/service';
import { stockWeight } from '../src/modules/stock/weight';
import { seedDemo } from '../src/seed/demo';
import { DEMO_PASSWORDS } from '../src/seed/catalog';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

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
async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = withIdempotencyKeys(request.agent(app));
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const product = async (karat = 21) => (await ctx.db.select().from(t.products).where(eq(t.products.karat, karat)).limit(1))[0];
/** A product of a karat this deployment does not sell (the demo catalogue is 21K only). */
const foreignProduct = async () => {
  const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 18)).limit(1);
  if (p) return p;
  const [cat] = await ctx.db.select().from(t.categories).limit(1);
  return (await ctx.db.insert(t.products).values({ sku: 'TEST-18-001', name: 'Test 18K Ring', nameAr: 'خاتم اختبار', categoryId: cat.id, karat: 18 }).returning())[0];
};
const pool = async (branch: number, karat: number) => (await poolBalances(ctx.db, branch, karat))[0]?.weightMg ?? 0;
const purchaseRow = async (id: number) => (await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, id)))[0];
const counts = async () => ({
  ledger: (await ctx.db.select({ n: count() }).from(t.ledgerEntries))[0].n,
  settlements: (await ctx.db.select({ n: count() }).from(t.supplierSettlements))[0].n,
  pool: (await ctx.db.select({ n: count() }).from(t.scrapWeightEntries))[0].n,
});
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; key?: string; message?: string }) => e);
const failure = async (statement: string) => {
  const e = await ctx.db.execute(sql.raw(statement)).then(() => null, (err: Error & { cause?: Error }) => err);
  return e ? `${e.message} ${e.cause?.message ?? ''}` : null;
};
const supplierId = async () => (await ctx.db.select().from(t.suppliers).orderBy(t.suppliers.id).limit(1))[0].id;
/** A purchase in `code` with known lines (21K): returns it and the expected gold debt. */
async function newPurchase(code: string, nets: number[], opts: { makingCost?: number; paidFrom?: 'CASH' | 'BANK' } = {}) {
  const bm = await actorOf(code === 'PZU' ? 'branch.manager.pzu' : code === 'OMD' ? 'branch.manager.omd' : code === 'BHR' ? 'branch.manager.bhr' : 'branch.manager.kh');
  const p = await product(21);
  const lines = nets.map((n) => ({ productId: p.id, grossWeightMg: n + 100, netWeightMg: n, purchaseCost: 1_000_000, makingCost: opts.makingCost ?? 50_000, otherCost: 0, sellingPrice: 1_400_000 }));
  const po = await createPurchase(ctx, bm, { branchId: await branchId(code), supplierId: await supplierId(), lines, makingChargePaidFrom: opts.paidFrom });
  return { po, bm, owed: sumInt(nets.map((n) => pureGoldMg(n, 21))) };
}
async function stockUp(code: string, karat: number, weightMg: number) {
  const bm = await actorOf(code === 'PZU' ? 'branch.manager.pzu' : code === 'OMD' ? 'branch.manager.omd' : code === 'BHR' ? 'branch.manager.bhr' : 'branch.manager.kh');
  await buyScrap(ctx, bm, { branchId: await branchId(code), kind: 'BROKEN', karat, grossWeightMg: weightMg, netWeightMg: weightMg, paymentMethod: 'CASH' });
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedDemo(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle.close());
beforeEach(() => resetThrottleMemory());

// ───────────────────────── 0. karat restriction ─────────────────────────
describe('karat restriction (sellable stock only, from the allowedKarats setting)', () => {
  it('the demo deployment sells 21K only; nothing in the code hardcodes the karat', async () => {
    expect((await ctx.settings.get()).inventory.allowedKarats).toEqual([21]);
    const files = sourceFiles(join(__dirname, '../src')).filter((f) => !f.includes('/seed/'));
    const code = (f: string) => readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const offenders = files.filter((f) => /allowedKarats[^\n]*\b21\b|karat\s*[!=]==?\s*21\b|\b21\s*[!=]==?\s*\w*karat/i.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('a supplier purchase of a non-allowed karat is refused with a clear error and writes nothing', async () => {
    const bm = await actorOf('branch.manager.kh');
    const p = await foreignProduct();
    const before = await counts();
    const e = await errorOf(createPurchase(ctx, bm, { branchId: await branchId('KRT'), supplierId: await supplierId(), lines: [{ productId: p.id, grossWeightMg: 5100, netWeightMg: 5000, purchaseCost: 900_000, makingCost: 40_000, otherCost: 0, sellingPrice: 1_200_000 }] }));
    expect(e).toMatchObject({ status: 400, key: '{karat}K is not sold here: sellable pieces must be {allowed}' });
    expect(e!.message).toBe('18K is not sold here: sellable pieces must be 21K');
    expect(await counts()).toEqual(before);
  });

  it('sellable counter scrap of a non-allowed karat is refused; the same piece can be bought as broken scrap', async () => {
    const bm = await actorOf('branch.manager.kh');
    const krt = await branchId('KRT');
    const p = await foreignProduct();
    const e = await errorOf(buyScrap(ctx, bm, { branchId: krt, kind: 'SELLABLE', karat: 18, grossWeightMg: 3000, netWeightMg: 3000, paymentMethod: 'CASH', productId: p.id, sellingPrice: 500_000 }));
    expect(e).toMatchObject({ status: 400, key: '{karat}K is not sold here: sellable pieces must be {allowed}' });
    const before = await pool(krt, 18);
    await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 18, grossWeightMg: 3000, netWeightMg: 3000, paymentMethod: 'CASH' });
    expect(await pool(krt, 18)).toBe(before + 3000);
  });

  it('a sale, a price change and the sell-rate entry refuse a karat that is not sold', async () => {
    // A legacy 18K piece (e.g. opening stock or a clean scrap piece from before the restriction).
    const cashier = await actorOf('cashier.kh.01');
    const bm = await actorOf('branch.manager.kh');
    const [template] = await freshItems('KRT', 1);
    const p = await foreignProduct();
    const { id: _id, code: _code, barcode: _barcode, ...rest } = template;
    const [item] = await ctx.db.insert(t.jewelryItems).values({ ...rest, code: 'T18-0001', barcode: 'T18-0001', productId: p.id, karat: 18 }).returning();
    const sale = await errorOf(createSale(ctx, cashier, { items: [{ itemId: item.id }], paymentMethod: 'CASH' }));
    expect(sale).toMatchObject({ status: 400, key: '{karat}K is not sold here: sellable pieces must be {allowed}' });
    expect(sale!.message).toBe('18K is not sold here: sellable pieces must be 21K');
    expect(await errorOf(changePrice(ctx, bm, item.id, 2_000_000, 'test'))).toMatchObject({ status: 400 });
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
    expect((await gm.post('/api/gold-rates').send({ rates: { 18: 160_000 } })).status).toBe(400);
    const [after] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, item.id));
    expect(after.status).toBe('AVAILABLE');
  });
});

// ───────────────────────── 1. inventory states and the unified list ─────────────────────────
describe('three inventory states', () => {
  it('broken scrap is never an item; the browse list filters by origin, karat and weight range', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const itemsBefore = (await ctx.db.select({ n: count() }).from(t.jewelryItems))[0].n;
    await stockUp('KRT', 22, 2500);
    expect((await ctx.db.select({ n: count() }).from(t.jewelryItems))[0].n).toBe(itemsBefore);

    const scrap = (await bm.get('/api/inventory/items').query({ origin: 'SCRAP' })).body;
    expect(scrap.items.length).toBeGreaterThan(0);
    expect(scrap.items.every((i: { origin: string }) => i.origin === 'SCRAP')).toBe(true);
    const fresh = (await bm.get('/api/inventory/items').query({ origin: 'SUPPLIER_NEW' })).body;
    expect(fresh.items.every((i: { origin: string }) => i.origin === 'SUPPLIER_NEW')).toBe(true);
    const both = (await bm.get('/api/inventory/items')).body;
    expect(both.total).toBe(scrap.total + fresh.total + (await bm.get('/api/inventory/items').query({ origin: 'OPENING' })).body.total);
    const ranged = (await bm.get('/api/inventory/items').query({ karat: 21, minWeightMg: 5000, maxWeightMg: 8000 })).body;
    expect(ranged.items.length).toBeGreaterThan(0);
    for (const i of ranged.items) expect(i.netWeightMg >= 5000 && i.netWeightMg <= 8000 && i.karat === 21).toBe(true);
  });
});

// ───────────────────────── 2. broken-scrap pool ─────────────────────────
describe('broken-scrap weight pool', () => {
  it('is append-only at the database level', async () => {
    expect(await failure(`UPDATE scrap_weight_entries SET weight_mg = weight_mg + 1`)).toMatch(/append-only|permission denied/);
    expect(await failure(`DELETE FROM scrap_weight_entries`)).toMatch(/append-only|permission denied/);
    expect(await failure(`UPDATE scrap_purchases SET amount = amount + 1`)).toMatch(/append-only|permission denied/);
    expect(await failure(`DELETE FROM supplier_settlements`)).toMatch(/append-only|permission denied/);
    expect(await failure(`UPDATE scrap_rates SET price_per_gram = 1`)).toMatch(/append-only|permission denied/);
  });

  it('balance = SUM(entries) per branch and karat; nothing is cached', async () => {
    const raw = rows<{ branch_id: number; karat: number; w: string | number }>(
      await ctx.db.execute(sql`SELECT branch_id, karat, sum(weight_mg) AS w FROM scrap_weight_entries GROUP BY 1, 2 HAVING sum(weight_mg) <> 0 ORDER BY 1, 2`),
    ).map((r) => ({ branchId: Number(r.branch_id), karat: Number(r.karat), weightMg: Number(r.w) }));
    expect(await poolBalances(ctx.db, null)).toEqual(raw);
    // No balance column anywhere in the scrap / settlement tables.
    const cols = rows<{ column_name: string }>(
      await ctx.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name IN ('scrap_weight_entries','scrap_purchases','supplier_settlements','branches') AND column_name LIKE '%balance%'`),
    );
    expect(cols).toEqual([]);
    // Every balance is non-negative.
    for (const r of raw) expect(r.weightMg).toBeGreaterThan(0);
  });

  it('buying broken scrap pays the customer from CASH or BANK and raises the pool by exactly the weight', async () => {
    const bm = await actorOf('branch.manager.omd');
    const omd = await branchId('OMD');
    const before = await pool(omd, 22);
    const bal = async () => Object.fromEntries((await balances(ctx.db, omd)).map((a) => [a.kind, a.balance]));
    const money = await bal();
    const r = await buyScrap(ctx, bm, { branchId: omd, kind: 'BROKEN', karat: 22, grossWeightMg: 4120, netWeightMg: 4100, paymentMethod: 'BANK_TRANSFER' });
    expect(await pool(omd, 22)).toBe(before + 4100);
    const after = await bal();
    expect(after.BANK).toBe(money.BANK - r.amount);
    expect(after.CASH).toBe(money.CASH);
    expect(r.itemId).toBeNull();
  });

  it('is part of the branch total stock weight (raw by karat and 24K) on the dashboard and in the reports', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const krt = await branchId('KRT');
    const sw = (await stockWeight(ctx.db, krt)).byBranch.get(krt)!;
    const scrapRows = await poolBalances(ctx.db, krt);
    expect(sw.brokenScrap.weightMg).toBe(sumInt(scrapRows.map((r) => r.weightMg)));
    expect(sw.brokenScrap.pureMg24).toBe(sumInt(scrapRows.map((r) => pureGoldMg(r.weightMg, r.karat))));
    expect(sw.totalWeightMg).toBe(sw.items.weightMg + sw.brokenScrap.weightMg);
    expect(sw.brokenScrap.weightMg).toBeGreaterThan(0);

    const dash = (await bm.get('/api/dashboard/branch')).body;
    expect(dash.stockWeight).toEqual(JSON.parse(JSON.stringify(sw)));
    const report = (await bm.get('/api/reports/stock-weight')).body;
    expect(report.totals.brokenScrapWeightMg).toBe(sw.brokenScrap.weightMg);
    expect(report.totals.totalWeightMg).toBe(sw.totalWeightMg);
    const inv = (await bm.get('/api/reports/inventory')).body;
    expect(inv.summary.find((s: { label: string }) => s.label === 'Broken scrap weight').value).toBe(sw.brokenScrap.weightMg);
    const pv = (await bm.get('/api/scrap-pool')).body;
    expect(pv.branches).toHaveLength(1);
    expect(pv.weightMg).toBe(sw.brokenScrap.weightMg);

    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const company = (await gm.get('/api/dashboard/company')).body;
    const all = await stockWeight(ctx.db, null);
    expect(company.stockWeight.totalPureMg24).toBe(all.total.totalPureMg24);
    expect(company.branches.find((b: { code: string }) => b.code === 'KRT').brokenScrapWeightMg).toBe(sw.brokenScrap.weightMg);
  });

  it('a branch manager sees only their own pool; a cashier has no access', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    expect((await bm.get('/api/scrap-pool').query({ branchId: await branchId('OMD') })).status).toBe(403);
    const cashier = await login('cashier.kh.01', 'CASHIER');
    expect((await cashier.get('/api/scrap-pool')).status).toBe(403);
    expect((await cashier.post('/api/scrap-purchases').send({ kind: 'BROKEN', karat: 21, grossWeightMg: 1000, netWeightMg: 1000, paymentMethod: 'CASH' })).status).toBe(403);
  });

  it('scrap price outside the tolerance needs the GM; inside it the branch manager decides', async () => {
    const bm = await actorOf('branch.manager.kh');
    const gm = await actorOf('general.manager');
    const krt = await branchId('KRT');
    const { rates, tolerancePct } = await (await login('branch.manager.kh', 'BRANCH_MANAGER')).get('/api/scrap-rates').then((r) => r.body);
    const rate = rates.find((r: { karat: number }) => r.karat === 21).pricePerGram;
    const inside = Math.round(rate * (1 + (tolerancePct * 0.9) / 100));
    const outside = Math.round(rate * (1 + (tolerancePct * 1.5) / 100));
    await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 1000, netWeightMg: 1000, paymentMethod: 'CASH', agreedRatePerGram: inside });
    expect(await errorOf(buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 1000, netWeightMg: 1000, paymentMethod: 'CASH', agreedRatePerGram: outside }))).toMatchObject({ status: 403 });
    const ok = await buyScrap(ctx, gm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 1000, netWeightMg: 1000, paymentMethod: 'CASH', agreedRatePerGram: outside });
    expect(ok.overrideApproved).toBe(true);
  });
});

// ───────────────────────── 3. one pure-gold helper ─────────────────────────
describe('pure-gold conversion: one helper, one rounding', () => {
  it('no backend code converts karat weight to 24K by hand', () => {
    const files = sourceFiles(join(__dirname, '../src'));
    const handRolled = /(karat|Karat)\w*\s*\)?\s*\/\s*24\b|\/\s*24\s*\)?\s*\*\s*\w*[kK]arat|\*\s*\w*[kK]arat\w*\s*\)?\s*\/\s*24\b/;
    expect(files.filter((f) => handRolled.test(readFileSync(f, 'utf8')))).toEqual([]);
    for (const f of ['modules/supplier-settlements/service.ts', 'modules/scrap/service.ts', 'modules/purchases/service.ts']) {
      expect(readFileSync(join(__dirname, '../src', f), 'utf8')).toMatch(/pureGoldMg\(/);
    }
  });

  it('a purchase owes Σ pureGoldMg(net, karat) per piece — the single pure-gold helper', async () => {
    const { po, owed } = await newPurchase('KRT', [4_201, 7_777, 10_003]);
    expect(owed).toBe(pureGoldMg(4_201, 21) + pureGoldMg(7_777, 21) + pureGoldMg(10_003, 21));
    const row = await purchaseRow(po.id);
    expect(row.goldDebtMgPure24).toBe(owed);
    expect(row.goldOwedMgPure24).toBe(owed);
  });
});

// ───────────────────────── 4. supplier purchases and settlement ─────────────────────────
describe('supplier purchase: making charge in money, gold debt in 24K', () => {
  it('pays the making charge at once from the chosen account (the only supplier money)', async () => {
    const krt = await branchId('KRT');
    const bal = async () => Object.fromEntries((await balances(ctx.db, krt)).map((a) => [a.kind, a.balance]));
    const before = await bal();
    const { po } = await newPurchase('KRT', [5_000, 6_000], { makingCost: 70_000, paidFrom: 'BANK' });
    const after = await bal();
    expect(after.BANK).toBe(before.BANK - 140_000);
    expect(after.CASH).toBe(before.CASH);
    const row = await purchaseRow(po.id);
    expect(row).toMatchObject({ makingChargePaid: 140_000, makingChargePaidFrom: 'BANK' });
    const [e] = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'purchase'), eq(t.ledgerEntries.refId, po.id)));
    expect(e).toMatchObject({ amount: -140_000, eventType: 'SUPPLIER_MAKING_CHARGE', paymentMethod: 'BANK_TRANSFER' });
  });

  it('is refused when supplier credit is turned off', async () => {
    await ctx.settings.apply(ctx.db, { 'purchases.supplierCreditEnabled': false }, { actor: { id: null, username: 'test' }, allowDemoOnly: true });
    try {
      expect(await errorOf(newPurchase('KRT', [5_000]))).toMatchObject({ status: 400, key: 'Supplier purchases on gold credit are turned off in the settings' });
    } finally {
      await ctx.settings.apply(ctx.db, { 'purchases.supplierCreditEnabled': true }, { actor: { id: null, username: 'test' }, allowDemoOnly: true });
    }
  });
});

describe('supplier settlement with broken scrap only', () => {
  it('happy path: one visit settles the order in full; the pool drops; owed reaches exactly 0', async () => {
    const { po, bm, owed } = await newPurchase('BHR', [9_600]); // 8400 mg pure
    const bhr = await branchId('BHR');
    await stockUp('BHR', 24, owed);
    const poolBefore = await pool(bhr, 24);
    const s = await settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: owed });
    expect(s).toMatchObject({ settledKarat: 24, settledWeightMg: owed, settledPureMg24: owed, goldOwedMgPure24: 0 });
    expect((await purchaseRow(po.id)).goldOwedMgPure24).toBe(0);
    expect(await pool(bhr, 24)).toBe(poolBefore - owed);
    expect(await errorOf(settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: 1 }))).toMatchObject({ status: 400, key: 'This purchase is already fully settled' });
  });

  it('partial settlements across different karats until owed is exactly 0', async () => {
    const { po, bm, owed } = await newPurchase('PZU', [10_000, 8_000]); // 8750 + 7000 = 15750
    expect(owed).toBe(15_750);
    const pzu = await branchId('PZU');
    await stockUp('PZU', 21, 8_000);
    await stockUp('PZU', 18, 6_000);
    await stockUp('PZU', 24, 4_250);
    const p21 = await pool(pzu, 21);
    const p18 = await pool(pzu, 18);
    const p24 = await pool(pzu, 24);
    const a = await settleWithScrap(ctx, bm, po.id, { karat: 21, weightMg: 8_000 });
    expect(a).toMatchObject({ settledPureMg24: 7_000, goldOwedMgPure24: 8_750 });
    const b = await settleWithScrap(ctx, bm, po.id, { karat: 18, weightMg: 6_000 });
    expect(b).toMatchObject({ settledPureMg24: 4_500, goldOwedMgPure24: 4_250 });
    const c = await settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: 4_250 });
    expect(c).toMatchObject({ settledPureMg24: 4_250, goldOwedMgPure24: 0 });
    expect([await pool(pzu, 21), await pool(pzu, 18), await pool(pzu, 24)]).toEqual([p21 - 8_000, p18 - 6_000, p24 - 4_250]);
    const rowsS = await ctx.db.select().from(t.supplierSettlements).where(eq(t.supplierSettlements.purchaseId, po.id));
    expect(sumInt(rowsS.map((r) => r.settledPureMg24))).toBe(owed);
    // The debt and the settlements reconcile: debt − Σ settled = owed.
    const row = await purchaseRow(po.id);
    expect(row.goldDebtMgPure24! - sumInt(rowsS.map((r) => r.settledPureMg24))).toBe(row.goldOwedMgPure24);
  });

  it('over-settlement is refused and changes nothing', async () => {
    const { po, bm, owed } = await newPurchase('OMD', [4_000]); // 3500 pure
    const omd = await branchId('OMD');
    await stockUp('OMD', 24, owed + 5_000);
    const before = await counts();
    const poolBefore = await pool(omd, 24);
    const e = await errorOf(settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: owed + 1 }));
    expect(e).toMatchObject({ status: 400, key: 'This weight is more than the gold still owed on this purchase' });
    expect(await counts()).toEqual(before);
    expect(await pool(omd, 24)).toBe(poolBefore);
    expect((await purchaseRow(po.id)).goldOwedMgPure24).toBe(owed);
  });

  it('refuses more scrap than the pool holds, a purchase from before gold settlement, and another branch', async () => {
    const { po, bm } = await newPurchase('OMD', [40_000]);
    const omd = await branchId('OMD');
    const have = await pool(omd, 22);
    expect(await errorOf(settleWithScrap(ctx, bm, po.id, { karat: 22, weightMg: have + 1 }))).toMatchObject({ status: 400, key: 'Not enough {karat}K broken scrap in the pool' });
    // Another branch's manager.
    expect(await errorOf(settleWithScrap(ctx, await actorOf('branch.manager.kh'), po.id, { karat: 21, weightMg: 1_000 }))).toMatchObject({ status: 403 });
    // A purchase recorded before Phase 4 has no gold debt (NULL, never backfilled).
    const legacy = await newPurchase('OMD', [3_000]);
    await ctx.db.update(t.purchases).set({ goldDebtMgPure24: null, goldOwedMgPure24: null }).where(eq(t.purchases.id, legacy.po.id));
    expect(await errorOf(settleWithScrap(ctx, bm, legacy.po.id, { karat: 21, weightMg: 1_000 }))).toMatchObject({
      status: 400,
      key: 'This purchase was recorded before gold settlement existed and cannot be settled with scrap',
    });
  });

  it('the database refuses an owed amount below 0 or above the debt', async () => {
    const { po } = await newPurchase('KRT', [2_000]);
    expect(await failure(`UPDATE purchases SET gold_owed_mg_pure24 = -1 WHERE id = ${po.id}`)).toMatch(/ck_purchases_gold_owed_range|violates/);
    expect(await failure(`UPDATE purchases SET gold_owed_mg_pure24 = gold_debt_mg_pure24 + 1 WHERE id = ${po.id}`)).toMatch(/ck_purchases_gold_owed_range|violates/);
  });

  it('over HTTP: idempotent (a retry with the same key settles once) and strict (no money fields accepted)', async () => {
    const { po, owed } = await newPurchase('KRT', [8_000]);
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    await stockUp('KRT', 21, 4_000);
    const key = randomUUID();
    const body = { karat: 21, weightMg: 4_000 };
    const r1 = await bm.post(`/api/purchases/${po.id}/settlements`).set('Idempotency-Key', key).send(body);
    const r2 = await bm.post(`/api/purchases/${po.id}/settlements`).set('Idempotency-Key', key).send(body);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    const rowsS = await ctx.db.select().from(t.supplierSettlements).where(eq(t.supplierSettlements.purchaseId, po.id));
    expect(rowsS).toHaveLength(1);
    expect((await purchaseRow(po.id)).goldOwedMgPure24).toBe(owed - pureGoldMg(4_000, 21));
    for (const extra of [{ paymentMethod: 'CASH' }, { amount: 1_000 }, { account: 'BANK' }]) {
      expect((await bm.post(`/api/purchases/${po.id}/settlements`).send({ ...body, ...extra })).status).toBe(400);
    }
  });
});

describe('no code path lets a supplier settlement touch CASH or BANK', () => {
  it('the settlement module imports nothing from the money ledger', () => {
    const src = readFileSync(join(__dirname, '../src/modules/supplier-settlements/service.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => l.startsWith('import'));
    expect(imports.some((l) => /ledger/.test(l))).toBe(false);
    expect(src).not.toMatch(/ledgerEntries|ledger_entries|\bpost\(/);
  });

  it('the settlements table has no money or payment column', async () => {
    const cols = rows<{ column_name: string }>(await ctx.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'supplier_settlements'`)).map((c) => c.column_name);
    expect(cols.filter((c) => /amount|payment|cash|bank|price|rate|account/.test(c))).toEqual([]);
  });

  it('settling moves weight only: no ledger entry, CASH and BANK unchanged', async () => {
    const { po, bm } = await newPurchase('BHR', [6_000]);
    const bhr = await branchId('BHR');
    await stockUp('BHR', 21, 3_000);
    const before = await counts();
    const money = await balances(ctx.db, bhr);
    await settleWithScrap(ctx, bm, po.id, { karat: 21, weightMg: 3_000 });
    const after = await counts();
    expect(after.ledger).toBe(before.ledger);
    expect(after.settlements).toBe(before.settlements + 1);
    expect(after.pool).toBe(before.pool + 1);
    expect(await balances(ctx.db, bhr)).toEqual(money);
  });
});

describe('cost visibility of the new fields and routes', () => {
  it('every gold WEIGHT of an order and its settlements is SAFE (operational); money costs stay COST; pool, scrap and Hasad fields are SAFE', () => {
    for (const f of ['makingChargePaid', 'acquisitionCost', 'makingCharge', 'totalCost', 'purchaseCost', 'makingCost']) expect(COST_RESPONSE_FIELDS.has(f), f).toBe(true);
    for (const f of ['goldDebtMgPure24', 'goldOwedMgPure24', 'owedAfterMgPure24', 'settledKarat', 'settledWeightMg', 'settledPureMg24']) {
      expect(COST_RESPONSE_FIELDS.has(f), f).toBe(false);
      expect(SAFE_RESPONSE_FIELDS.has(f), f).toBe(true);
    }
    expect(COLUMN_CLASSES.purchases.safe).toEqual(expect.arrayContaining(['gold_owed_mg_pure24', 'gold_debt_mg_pure24']));
    expect(COLUMN_CLASSES.purchases.cost).toEqual(['total_cost', 'making_charge_paid']);
    expect(COLUMN_CLASSES.supplier_settlements.cost ?? []).toEqual([]);
    expect(COLUMN_CLASSES.supplier_settlements.safe).toEqual(expect.arrayContaining(['settled_karat', 'settled_weight_mg', 'settled_pure_mg24']));
    expect(COLUMN_CLASSES.scrap_weight_entries.cost ?? []).toEqual([]);
    expect(COLUMN_CLASSES.hasad_receivable_settlements.cost ?? []).toEqual([]);
    expect(COLUMN_CLASSES.sales.safe).toEqual(expect.arrayContaining(['payment_ref_invoice', 'payment_ref_transaction']));
  });

  it('the branch manager sees every gold weight (debt, owed, running balance, settled karat/weight/24K) but never a money cost on the same responses', async () => {
    const { po, owed } = await newPurchase('KRT', [7_000]);
    await stockUp('KRT', 21, 3_000);
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const first = await bm.post(`/api/purchases/${po.id}/settlements`).send({ karat: 21, weightMg: 2_000 });
    expect(first.status).toBe(200);
    expect(first.body.goldOwedMgPure24).toBe(owed - pureGoldMg(2_000, 21));
    expect(first.body).toMatchObject({ settledKarat: 21, settledWeightMg: 2_000, settledPureMg24: pureGoldMg(2_000, 21) });
    const second = await bm.post(`/api/purchases/${po.id}/settlements`).send({ karat: 21, weightMg: 1_000 });
    const left = owed - pureGoldMg(2_000, 21) - pureGoldMg(1_000, 21);
    expect(second.body.goldOwedMgPure24).toBe(left);

    // The purchase order view (the settlement screen): all gold weights, no money cost anywhere.
    const view = (await bm.get(`/api/purchases/${po.id}`)).body;
    expect(view).toMatchObject({ goldDebtMgPure24: owed, goldOwedMgPure24: left });
    expect(view.settlements.map((x: { settledKarat: number; settledWeightMg: number; settledPureMg24: number }) => [x.settledKarat, x.settledWeightMg, x.settledPureMg24])).toEqual([
      [21, 2_000, pureGoldMg(2_000, 21)],
      [21, 1_000, pureGoldMg(1_000, 21)],
    ]);
    expect(view.settlements.map((x: { owedAfterMgPure24: number }) => x.owedAfterMgPure24)).toEqual([owed - pureGoldMg(2_000, 21), left]);
    for (const body of [first.body, second.body, view]) {
      const text = JSON.stringify(body);
      for (const f of ['acquisitionCost', 'makingCharge', 'makingChargePaid', 'makingCost', 'purchaseCost', 'otherCost', 'totalCost', 'profit']) {
        expect(text, f).not.toContain(`"${f}"`);
      }
    }
    // The GM sees everything.
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const gmView = (await gm.get(`/api/purchases/${po.id}`)).body;
    expect(gmView).toMatchObject({ goldOwedMgPure24: left, goldDebtMgPure24: owed, makingChargePaid: 50_000 });
    expect(gmView.settlements[0]).toMatchObject({ settledKarat: 21, settledWeightMg: 2_000 });
  });
});

// ───────────────────────── odd-karat scrap ─────────────────────────
describe('scrap buying accepts any karat 1–24; selling stays limited to allowedKarats', () => {
  it('a 14K broken-scrap purchase is recorded while a 14K sellable piece is still rejected', async () => {
    const gm = await actorOf('general.manager');
    const bm = await actorOf('branch.manager.omd');
    const omd = await branchId('OMD');
    await setScrapRates(ctx, gm, { 14: 95_000 });
    const before = await pool(omd, 14);
    const r = await buyScrap(ctx, bm, { branchId: omd, kind: 'BROKEN', karat: 14, grossWeightMg: 3_300, netWeightMg: 3_300, paymentMethod: 'CASH' });
    expect(r.karat).toBe(14);
    expect(await pool(omd, 14)).toBe(before + 3_300);
    const p = await foreignProduct();
    expect(await errorOf(buyScrap(ctx, bm, { branchId: omd, kind: 'SELLABLE', karat: 14, grossWeightMg: 3_000, netWeightMg: 3_000, paymentMethod: 'CASH', productId: p.id, sellingPrice: 500_000 }))).toMatchObject({
      status: 400,
      key: '{karat}K is not sold here: sellable pieces must be {allowed}',
    });
    // Over HTTP too: the route accepts 14 (and 9) for scrap, refuses 0 and 25.
    const http = await login('branch.manager.omd', 'BRANCH_MANAGER');
    const ok = await http.post('/api/scrap-purchases').send({ kind: 'BROKEN', karat: 14, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'CASH' });
    expect(ok.status).toBe(200);
    for (const k of [0, 25]) expect((await http.post('/api/scrap-purchases').send({ kind: 'BROKEN', karat: k, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'CASH' })).status).toBe(400);
    const sell = await http.post('/api/scrap-purchases').send({ kind: 'SELLABLE', karat: 14, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'CASH', productId: p.id, sellingPrice: 300_000 });
    expect(sell.status).toBe(400);
    // The 24K equivalent of odd karats uses the same helper.
    const sw = (await stockWeight(ctx.db, omd)).byBranch.get(omd)!;
    expect(sw.brokenScrap.byKarat.find((x) => x.karat === 14)!.pureMg24).toBe(pureGoldMg(await pool(omd, 14), 14));
  });
});

// ───────────────────────── Hasad receivable settled by bank transfer ─────────────────────────
describe('Hasad receivable settled by bank transfer', () => {
  const bal = async (branch: number) => Object.fromEntries((await balances(ctx.db, branch)).map((a) => [a.kind, a.balance]));
  async function receivable(code: string, n: number) {
    const cashier = await actorOf('cashier.kh.01');
    let total = 0;
    for (const item of await freshItems(code, n)) {
      const s = await createSale(ctx, cashier, { items: [{ itemId: item.id }], paymentMethod: 'HASAD', paymentRefInvoice: `HSD-T-${item.id}` });
      total += s.total;
    }
    return total;
  }

  it('moves the amount from HASAD_RECEIVABLE to BANK in one transaction (two entries netting to zero); partial is fine', async () => {
    const krt = await branchId('KRT');
    await receivable('KRT', 2);
    const before = await bal(krt);
    const bm = await actorOf('branch.manager.kh');
    const part = Math.floor(before.HASAD_RECEIVABLE / 3);
    const r = await settleHasadReceivable(ctx, bm, { amount: part, bankReference: 'BOK-123' });
    const after = await bal(krt);
    expect(after.HASAD_RECEIVABLE).toBe(before.HASAD_RECEIVABLE - part);
    expect(after.BANK).toBe(before.BANK + part);
    expect(after.CASH).toBe(before.CASH);
    expect(r.hasadReceivableBalance).toBe(after.HASAD_RECEIVABLE);
    const entries = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'hasad_receivable_settlement'), eq(t.ledgerEntries.refId, r.id)));
    expect(entries).toHaveLength(2);
    expect(sumInt(entries.map((e) => e.amount))).toBe(0);
    expect(entries.every((e) => e.eventType === 'HASAD_RECEIVABLE_SETTLEMENT')).toBe(true);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'HASAD_RECEIVABLE_SETTLED'), eq(t.auditLogs.entityId, r.number)));
    expect(audit).toBeTruthy();
    // The daily reconciliation shows it on the bank side, never in the drawer.
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const rec = (await gm.get('/api/cash/reconciliation').query({ branchId: krt })).body;
    expect(rec.hasadReceivableToBank).toBeGreaterThanOrEqual(part);
  });

  it('more than the current receivable is refused and changes nothing; the record is append-only', async () => {
    const omd = await branchId('OMD');
    const bm = await actorOf('branch.manager.omd');
    const before = await bal(omd);
    const n = (await ctx.db.select({ n: count() }).from(t.hasadReceivableSettlements))[0].n;
    const e = await errorOf(settleHasadReceivable(ctx, bm, { amount: before.HASAD_RECEIVABLE + 1 }));
    expect(e).toMatchObject({ status: 400, key: 'This is more than the Hasad receivable of this branch ({balance})' });
    expect(await bal(omd)).toEqual(before);
    expect((await ctx.db.select({ n: count() }).from(t.hasadReceivableSettlements))[0].n).toBe(n);
    expect(await failure('UPDATE hasad_receivable_settlements SET amount = amount + 1')).toMatch(/append-only|permission denied/);
    expect(await failure('DELETE FROM hasad_receivable_settlements')).toMatch(/append-only|permission denied/);
  });

  it('over HTTP: idempotent (same key settles once), strict, own branch only, cashier refused', async () => {
    const krt = await branchId('KRT');
    await receivable('KRT', 1);
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const before = await bal(krt);
    const key = randomUUID();
    const body = { amount: 1_000 };
    const r1 = await bm.post('/api/cash/hasad-settlements').set('Idempotency-Key', key).send(body);
    const r2 = await bm.post('/api/cash/hasad-settlements').set('Idempotency-Key', key).send(body);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect((await bal(krt)).BANK).toBe(before.BANK + 1_000);
    expect((await bm.post('/api/cash/hasad-settlements').send({ amount: 1_000, paymentMethod: 'CASH' })).status).toBe(400);
    expect((await bm.post('/api/cash/hasad-settlements').send({ amount: 0 })).status).toBe(400);
    expect((await bm.post('/api/cash/hasad-settlements').send({ branchId: await branchId('OMD'), amount: 1_000 })).status).toBe(403);
    const cashier = await login('cashier.kh.01', 'CASHIER');
    expect((await cashier.post('/api/cash/hasad-settlements').send(body)).status).toBe(403);
    const list = (await bm.get('/api/cash/hasad-settlements')).body;
    expect(list.every((x: { branchId: number }) => x.branchId === krt)).toBe(true);
  });
});

// ───────────────────────── 5. counter payment methods ─────────────────────────
describe('POS payment methods', () => {
  it('a cashier is offered exactly Cash, Bank transfer and Hasad', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const me = (await cashier.get('/api/auth/me')).body;
    expect(me.posPaymentMethods).toEqual(['CASH', 'BANK_TRANSFER', 'HASAD']);
  });

  it('CARD and MOBILE_WALLET stay in the data model but are not accepted at the counter', async () => {
    const cashier = await actorOf('cashier.kh.01');
    const [a, b] = await freshItems('KRT', 2);
    for (const [item, method] of [[a, 'CARD'], [b, 'MOBILE_WALLET']] as const) {
      expect(await errorOf(createSale(ctx, cashier, { items: [{ itemId: item.id }], paymentMethod: method }))).toMatchObject({ status: 400, key: '{method} is not accepted at the counter' });
    }
  });

  it('a Hasad sale needs the Hasad invoice number, stores the references and posts to the branch Hasad receivable', async () => {
    const cashier = await actorOf('cashier.kh.01');
    const krt = await branchId('KRT');
    const [a, b] = await freshItems('KRT', 2);
    expect(await errorOf(createSale(ctx, cashier, { items: [{ itemId: a.id }], paymentMethod: 'HASAD' }))).toMatchObject({ status: 400, key: 'Enter the Hasad invoice number' });
    expect(await errorOf(createSale(ctx, cashier, { items: [{ itemId: a.id }], paymentMethod: 'CASH', paymentRefInvoice: 'X' }))).toMatchObject({ status: 400 });
    const bal = async () => Object.fromEntries((await balances(ctx.db, krt)).map((x) => [x.kind, x.balance]));
    const before = await bal();
    const sale = await createSale(ctx, cashier, { items: [{ itemId: b.id }], paymentMethod: 'HASAD', paymentRefInvoice: 'HSD-INV-123456', paymentRefTransaction: 'HTX00112233' });
    expect(sale).toMatchObject({ paymentMethod: 'HASAD', paymentRefInvoice: 'HSD-INV-123456', paymentRefTransaction: 'HTX00112233' });
    const after = await bal();
    expect(after.HASAD_RECEIVABLE).toBe(before.HASAD_RECEIVABLE + sale.total);
    expect(after.CASH).toBe(before.CASH);
    expect(after.BANK).toBe(before.BANK);
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const drawer = (await gm.get('/api/cash/drawer')).body.branches.find((x: { branchId: number }) => x.branchId === krt);
    expect(drawer.hasadReceivable).toBe(after.HASAD_RECEIVABLE);
    expect(await failure(`UPDATE sales SET payment_ref_invoice = NULL WHERE id = ${sale.id}`)).toMatch(/ck_sales_hasad_reference|violates/);
  });
});

// ───────────────────────── 6. multi-item transfer ─────────────────────────
describe('branch manager transfer of several selected items', () => {
  it('one request with the selected item IDs creates exactly one transfer holding all of them', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const items = await freshItems('KRT', 3);
    const before = (await ctx.db.select({ n: count() }).from(t.transfers))[0].n;
    const res = await bm.post('/api/transfers').send({ toBranchId: await branchId('OMD'), itemIds: items.map((i) => i.id) });
    expect(res.status).toBe(200);
    expect((await ctx.db.select({ n: count() }).from(t.transfers))[0].n).toBe(before + 1);
    const lines = await ctx.db.select().from(t.transferItems).where(eq(t.transferItems.transferId, res.body.id));
    expect(lines.map((l) => l.itemId).sort()).toEqual(items.map((i) => i.id).sort());
    const [tr] = await ctx.db.select().from(t.transfers).where(eq(t.transfers.id, res.body.id));
    expect(tr.status).toBe('IN_TRANSIT');
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}
