// OPN-1 §6 (D-dec1-3): a piece of UNKNOWN cost (an opening piece: acquisition cost NULL, never 0) sells, moves and is
// adjusted like any other; every cost or profit figure covers the pieces of KNOWN cost only and says how many it
// leaves out. Both projects.
//   * a sale line of unknown cost: unit cost, acquisition cost and profit NULL; the sale's cost total sums the known
//     lines and counts the other; its profit is the known lines' (NULL, shown "—", when it has none);
//   * the sales list, its footer and the sales report; the profit report by branch, type, karat, cashier and day; the
//     branch metrics, the branch and company homes and their 14-day line: each checked against Σ sale_items.profit;
//   * the stock value at cost (inventory totals, branch metrics, the ledger) leaves the piece out and counts it; its
//     live price (weight × rate, or its tag) still counts;
//   * transfer (sent, received), damage, restock, return to supplier and a sale void with a NULL cost: every movement
//     carries a NULL cost value and the ledger's cost reconciles with the pieces of known cost on hand;
//   * a branch manager sees none of the new counts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../src/bootstrap';
import type { Actor, Ctx } from '../src/core/context';
import { rows, num } from '../src/core/sql';
import { dayKey } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { createCategory } from '../src/modules/catalog/service';
import { createSale, getSale, pageSales, salesReportAggregates, voidSale } from '../src/modules/sales/service';
import { getItemDetail, itemsReportAggregates, pageItems, adjustItem } from '../src/modules/inventory/service';
import { ledgerStock } from '../src/modules/inventory/ledger';
import { createTransfer, receiveTransfer } from '../src/modules/transfers/service';
import { runReport } from '../src/modules/reports/service';
import { branchMetrics, movementSummary } from '../src/modules/reports/metrics';
import { pricingOf } from '../src/modules/pricing/service';
import { branchDashboard, companyDashboard, periodFor } from '../src/modules/dashboard/service';
import { seedWorld } from './fixtures/world';
import { insertUnknownCostPiece } from './fixtures/unknown-cost';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let bm: Actor;
let bmOmd: Actor;
let cashier: Actor;
let krt: number;
let omd: number;
let today: string;
let karat: number;
let typeU: { id: number; nameAr: string };
let known: { id: number; code: string; acquisitionCost: number | null };
let mixedSaleId: number;
let unknownSaleId: number;

const actorOf = async (username: string) => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const piece = (branchId = krt, description?: string) =>
  insertUnknownCostPiece(ctx, { branchId, categoryId: typeU.id, karat, netWeightMg: 5_000, sellingPrice: 1_200_000, description, userId: gm.userId });
const COST_KEYS = ['unknownCostLines', 'unknownCostPieces', 'knownCostRevenue', 'grossProfit', 'costTotal', 'totalCost', 'inventoryCost'];
const hasCostKey = (o: object) => Object.keys(o).filter((k) => COST_KEYS.includes(k));

/** The reference: Σ profit and the count of NULL-cost lines of today's completed sales (optionally one branch). */
async function expectedProfit(branchId?: number, extra = sql``) {
  const r = await ctx.db.execute(sql`
    SELECT sum(si.profit) AS profit, count(*) FILTER (WHERE si.unit_cost IS NULL) AS unknown, count(*) AS lines,
           coalesce(sum(si.final_price) FILTER (WHERE si.unit_cost IS NOT NULL), 0) AS known_revenue
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.status = 'COMPLETED' AND s.created_at >= ${(await periodFor(ctx, today, today)).start.toISOString()}
      ${branchId != null ? sql`AND s.branch_id = ${branchId}` : sql``} ${extra}`);
  const [x] = rows<Record<string, unknown>>(r);
  return { profit: x.profit == null ? null : num(x.profit), unknown: num(x.unknown), lines: num(x.lines), knownRevenue: num(x.known_revenue) };
}

/** The reference for stock: AVAILABLE pieces of a branch, the cost of the known ones and the count of the others. */
async function availableStock(branchId: number) {
  const r = await ctx.db.execute(sql`
    SELECT count(*) AS n, coalesce(sum(net_weight_mg),0) AS w, coalesce(sum(acquisition_cost),0) AS c,
           count(*) FILTER (WHERE acquisition_cost IS NULL) AS u
    FROM jewelry_items WHERE status = 'AVAILABLE' AND branch_id = ${branchId}`);
  const [x] = rows<Record<string, unknown>>(r);
  return { items: num(x.n), weightMg: num(x.w), cost: num(x.c), unknownCostPieces: num(x.u) };
}
const later = () => new Date(Date.now() + 60_000);

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  gm = await actorOf('general.manager');
  bm = await actorOf('branch.manager.kh');
  bmOmd = await actorOf('branch.manager.omd');
  cashier = await actorOf('cashier.kh.01');
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  omd = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'OMD')))[0].id;
  today = dayKey(new Date(), (await ctx.settings.get()).company.timezone);
  // A piece of known cost the POS can sell today (its karat has a rate), and the karat the unknown pieces share.
  const [k] = await ctx.db
    .select({ id: t.jewelryItems.id, code: t.jewelryItems.code, acquisitionCost: t.jewelryItems.acquisitionCost, karat: t.jewelryItems.karat })
    .from(t.jewelryItems)
    .where(and(eq(t.jewelryItems.branchId, krt), eq(t.jewelryItems.status, 'AVAILABLE'), isNotNull(t.jewelryItems.acquisitionCost)))
    .limit(1);
  known = k;
  karat = k.karat;
  typeU = await createCategory(ctx, gm, { nameAr: '[اختبار] رصيد افتتاحي', name: '[Test] Opening stock' });

  const u1 = await piece(krt, 'قطعة قديمة 1');
  const u2 = await piece(krt);
  mixedSaleId = (await createSale(ctx, cashier, { items: [{ itemId: known.id }, { itemId: u1.id }], paymentMethod: 'CASH' })).id;
  unknownSaleId = (await createSale(ctx, cashier, { items: [{ itemId: u2.id }], paymentMethod: 'CASH' })).id;
});
afterAll(async () => handle?.close());

describe('a sale with a piece of unknown cost', () => {
  it('the line keeps NULL cost and profit; the sale sums the known line and counts the other', async () => {
    const lines = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, mixedSaleId));
    const u = lines.find((l) => l.itemId !== known.id)!;
    const k = lines.find((l) => l.itemId === known.id)!;
    expect([u.unitCost, u.acquisitionCost, u.profit]).toEqual([null, null, null]);
    expect([k.unitCost, k.profit]).toEqual([known.acquisitionCost, k.finalPrice - known.acquisitionCost!]);
    const [s] = await ctx.db.select().from(t.sales).where(eq(t.sales.id, mixedSaleId));
    expect([s.costTotal, s.unknownCostLines]).toEqual([known.acquisitionCost, 1]);
  });

  it('the sale detail: the profit of the known line; NULL when no line is known; components "—"', async () => {
    const d = await getSale(ctx, gm, mixedSaleId);
    const known1 = d.items.find((i) => i.itemId === known.id)!;
    const u = d.items.find((i) => i.itemId !== known.id)!;
    expect(d).toMatchObject({ grossProfit: (known1 as unknown as { profit: number }).profit, unknownCostLines: 1 });
    expect(u).toMatchObject({ unitCost: null, acquisitionCost: null, profit: null, purchaseCost: null, makingCost: null, otherCost: null, categoryNameAr: typeU.nameAr, productNameAr: 'قطعة قديمة 1' });
    const only = await getSale(ctx, gm, unknownSaleId);
    expect(only).toMatchObject({ grossProfit: null, costTotal: 0, unknownCostLines: 1 });
    expect(hasCostKey(await getSale(ctx, bm, mixedSaleId))).toEqual([]);
  });

  it('the sales list, its footer and the sales report: Σ profit of the known lines, with the count', async () => {
    const ref = await expectedProfit(krt);
    expect(ref.unknown).toBe(2);
    const page = await pageSales(ctx, gm, { from: today, to: today, branchId: krt, pageSize: 200 });
    expect(page.rows.find((r) => r.id === unknownSaleId)).toMatchObject({ grossProfit: null, unknownCostLines: 1 });
    expect(page.rows.find((r) => r.id === mixedSaleId)).toMatchObject({ grossProfit: (await getSale(ctx, gm, mixedSaleId)).grossProfit });
    expect(page.totals).toMatchObject({ grossProfit: ref.profit, unknownCostLines: 2 });
    const agg = await salesReportAggregates(ctx, gm, { from: today, to: today, branchId: krt });
    expect(agg.totals).toMatchObject({ grossProfit: ref.profit, unknownCostLines: 2 });
    // Sorting by profit runs (a sale without profit sorts as 0) and lists every sale once.
    const sorted = await pageSales(ctx, gm, { from: today, to: today, branchId: krt, sort: 'grossProfit', pageSize: 200 });
    expect(sorted.rows.map((r) => r.id).sort()).toEqual(page.rows.map((r) => r.id).sort());
    // The branch manager: no profit, no count.
    const bmPage = await pageSales(ctx, bm, { from: today, to: today, branchId: krt, pageSize: 200 });
    expect(hasCostKey(bmPage.totals!)).toEqual([]);
    for (const r of bmPage.rows) expect(hasCostKey(r)).toEqual([]);
  });

  it('the profit report, every grouping: profit and margin of the known lines; a group with none shows NULL', async () => {
    const all = await expectedProfit();
    for (const group of ['branch', 'category', 'karat', 'cashier', 'day'] as const) {
      const rep = await runReport(ctx, gm, 'profit', { group, from: today, to: today });
      expect(rep.totals).toMatchObject({ grossProfit: all.profit, unknownCostLines: all.unknown });
      expect(rep.totals!.margin).toBeCloseTo((all.profit! / all.knownRevenue) * 100, 6);
      for (const r of rep.rows as Record<string, unknown>[]) expect(r).not.toHaveProperty('knownCostRevenue');
    }
    const byType = (await runReport(ctx, gm, 'profit', { group: 'category', from: today, to: today })).rows as Record<string, unknown>[];
    // Only pieces of unknown cost were sold in this type: no profit, no margin ("—"), never 0.
    expect(byType.find((r) => r.labelAr === typeU.nameAr)).toMatchObject({ grossProfit: null, margin: null, costOfSales: 0, unknownCostLines: 2 });
    const byBranch = (await runReport(ctx, gm, 'profit', { group: 'branch', from: today, to: today })).rows as Record<string, unknown>[];
    expect(byBranch.find((r) => r.branchId === krt)).toMatchObject({ grossProfit: (await expectedProfit(krt)).profit, unknownCostLines: 2 });
  });

  it('branch metrics, the branch home (and its 14-day line) and the company home', async () => {
    const ref = await expectedProfit(krt);
    const period = await periodFor(ctx, today, today);
    const m = (await branchMetrics(ctx.db, period, krt, await pricingOf(ctx))).get(krt)!;
    expect(m).toMatchObject({ grossProfit: ref.profit, unknownCostLines: 2, knownCostRevenue: ref.knownRevenue });
    const home = await branchDashboard(ctx, gm, { branchId: krt, date: today });
    expect(home.kpis).toMatchObject({ grossProfit: ref.profit, unknownCostLines: 2 });
    expect(home.trend.find((d) => d.day === today)?.profit).toBe(ref.profit);
    const bmHome = await branchDashboard(ctx, bm, { branchId: krt, date: today });
    expect(bmHome.kpis).toMatchObject({ grossProfit: null, unknownCostLines: null, unknownCostPieces: null });
    const all = await expectedProfit();
    const company = await companyDashboard(ctx, gm, { from: today, to: today });
    expect(company.totals).toMatchObject({ grossProfit: all.profit, unknownCostLines: all.unknown });
  });
});

describe('stock with pieces of unknown cost', () => {
  it('stock value at cost leaves them out and counts them; their live price still counts', async () => {
    const extra = await piece(krt, 'قطعة في المخزون');
    const s = await availableStock(krt);
    expect(s.unknownCostPieces).toBeGreaterThan(0);
    const agg = await itemsReportAggregates(ctx, gm, { branchId: krt, status: ['AVAILABLE'] });
    expect(agg.totals).toMatchObject({ totalCost: s.cost, unknownCostPieces: s.unknownCostPieces });
    const page = await pageItems(ctx, gm, { branchId: krt, status: ['AVAILABLE'], pageSize: 1 });
    expect(page.totals).toMatchObject({ totalCost: s.cost, unknownCostPieces: s.unknownCostPieces });
    const m = (await branchMetrics(ctx.db, await periodFor(ctx, today, today), krt, await pricingOf(ctx))).get(krt)!;
    expect([m.inventoryCost, m.unknownCostPieces, m.availableItems]).toEqual([s.cost, s.unknownCostPieces, s.items]);
    // Valuation by weight × rate (or the tag) is not affected: the piece has a price.
    const d = await getItemDetail(ctx, gm, extra.id);
    expect(d.item).toMatchObject({ totalCost: null, acquisitionCost: null, purchaseCost: null, makingCost: null, otherCost: null });
    expect(d.item.sellingPrice).toBeGreaterThan(0);
    // The branch manager: no cost, no count.
    expect(hasCostKey((await pageItems(ctx, bm, { branchId: krt, pageSize: 1 })).totals!)).toEqual([]);
  });

  it('transfer (sent, received), damage, restock, return to supplier and a sale void: NULL cost values; the ledger reconciles with the pieces of known cost', async () => {
    const reconciles = async () => {
      for (const b of [krt, omd]) {
        const avail = await availableStock(b);
        const ledger = await ledgerStock(ctx.db, b, later());
        expect(ledger).toEqual(avail);
        const [mv] = await movementSummary(ctx.db, await periodFor(ctx, today, today), b);
        expect(mv.closing).toEqual({ items: avail.items, weightMg: avail.weightMg, cost: avail.cost, unknownCostPieces: avail.unknownCostPieces });
      }
    };
    await reconciles();
    const p = await piece(krt);
    const tr = await createTransfer(ctx, gm, { fromBranchId: krt, toBranchId: omd, itemIds: [p.id], courierName: 'Test courier' });
    await reconciles();
    await receiveTransfer(ctx, bmOmd, tr.id);
    await reconciles();
    await adjustItem(ctx, gm, p.id, 'MARK_DAMAGED', 'dropped');
    await reconciles();
    await adjustItem(ctx, gm, p.id, 'RESTOCK', 'repaired');
    await reconciles();
    await adjustItem(ctx, gm, p.id, 'RETURN_TO_SUPPLIER', 'sent back');
    await reconciles();
    const v = await piece(krt);
    const sale = await createSale(ctx, cashier, { items: [{ itemId: v.id }], paymentMethod: 'CASH' });
    await reconciles();
    await voidSale(ctx, bm, sale.id, 'Customer returned it');
    await reconciles();
    const moves = await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, p.id));
    expect(moves.map((m) => m.type)).toEqual(['ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'DAMAGE', 'ADJUSTMENT', 'ADJUSTMENT']);
    expect(moves.every((m) => m.costValue === null)).toBe(true);
    const vm = await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, v.id));
    expect(vm.every((m) => m.costValue === null)).toBe(true);
    // No movement of a piece of unknown cost ever carries a cost, and no known one lacks it.
    const bad = await ctx.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(t.inventoryMovements)
      .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.inventoryMovements.itemId))
      .where(sql`(${t.jewelryItems.acquisitionCost} IS NULL) <> (${t.inventoryMovements.costValue} IS NULL)`);
    expect(bad[0].n).toBe(0);
    // The voided sale counts for nothing; the piece is back in stock with no cost.
    expect((await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.id, v.id), isNull(t.jewelryItems.acquisitionCost))))[0].status).toBe('AVAILABLE');
  });
});
