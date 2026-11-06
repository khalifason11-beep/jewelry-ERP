// WSL-1 (docs/plans/WSL-1.md, D-wsl1-1…5): grains (حبات) of broken scrap sold at the POS (both projects).
//   * 1 grain = 100 mg; the line is priced at the karat's selling (NEW) rate on its whole weight, rounded once:
//     3 grains at 123,456/g = 300 mg → 37,037; the sale's total, payments and ledger follow; no cost (profit NULL);
//   * the chosen karat's pool of the sale's branch drops by exactly the weight, in one SCRAP_SALE row linked to the line;
//   * refusals: more than the pool holds (409 SCRAP_POOL_SHORT, nothing written), a price the cashier did not see
//     (409 PRICES_CHANGED with the current price), no rate (NO_PRICE), 0 grains, the same karat twice, an empty cart;
//   * an Idempotency-Key retry of the same sale deducts once;
//   * a void (sales.void, branch manager; refused to the cashier) puts the grains back: one REVERSAL row, same karat;
//   * a supplier settlement can use only what the grain sales left in the pool;
//   * the POS list: one row per karat with pool weight, the whole grains and the rate, own branch only;
//   * a mixed sale's profit is its piece's only; a grains-only sale's profit is NULL; the footers agree;
//   * property: a random sequence of purchases, grain sales, voids and settlements keeps pool = Σ movements, never
//     below zero, and a void restores exactly what its sale took.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fc from 'fast-check';
import { and, asc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { grainLinePrice, grainsIn, grainsToMg, valueOfWeight } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createUser } from '../src/modules/users/service';
import { createPurchase } from '../src/modules/purchases/service';
import { buyScrap, poolBalances } from '../src/modules/scrap/service';
import { settleWithScrap } from '../src/modules/supplier-settlements/service';
import { createSale, getSale, pageSales, scrapGrainsForPos, voidSale } from '../src/modules/sales/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

const NOW = new Date('2026-11-05T09:00:00Z');
const RATE = 123_456;
let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gm: Actor;
let n = 0;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const pool = async (branch: number, karat: number) => (await poolBalances(ctx.db, branch, karat))[0]?.weightMg ?? 0;
const code = (e: unknown) => (e as { code?: string }).code ?? String(e);
const refused = (p: Promise<unknown>) => p.then(() => 'OK', code);

/** A new branch of its own (an empty pool), its branch manager and cashier, and `mg` of broken scrap of `karat`. */
async function branchWithPool(karat: number, mg: number) {
  n += 1;
  const [b] = await ctx.db.insert(t.branches).values({ code: `WS${n}`, name: `Grains ${n}`, nameAr: `[اختبار] حبات ${n}`, city: 'X' }).returning();
  const bmUser = await createUser(ctx, gm, { username: `wsl1.bm.${n}`, fullName: `[Test] Grains manager ${n}`, roleCode: 'BRANCH_MANAGER', branchId: b.id });
  const cashierUser = await createUser(ctx, gm, { username: `wsl1.cashier.${n}`, fullName: `[Test] Grains cashier ${n}`, roleCode: 'CASHIER', branchId: b.id });
  const bm = (await loadActor(ctx.db, bmUser.id, null))!;
  const cashier = (await loadActor(ctx.db, cashierUser.id, null))!;
  // Paid by bank transfer: the test needs no cash in a drawer.
  if (mg > 0) await buyScrap(ctx, bm, { branchId: b.id, kind: 'BROKEN', karat, grossWeightMg: mg, netWeightMg: mg, paymentMethod: 'BANK_TRANSFER', bankReference: `WSL-${n}-${karat}` });
  return { branchId: b.id, bm, cashier };
}
const grainsSale = (actor: Actor, branchId: number, lines: { karat: number; grains: number; listPrice?: number }[], extra: Record<string, unknown> = {}) =>
  createSale(ctx, actor, {
    branchId,
    items: [],
    scrapLines: lines.map((l) => ({ karat: l.karat, grains: l.grains, listPrice: l.listPrice ?? grainLinePrice(l.grains, RATE) })),
    paymentMethod: 'CASH',
    ...extra,
  });

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, NOW);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await actorOf('general.manager');
  // The selling rate of the owner's example, after the seed's rates (21K); 18K keeps none.
  await ctx.db.insert(t.goldRates).values({ karat: 21, kind: 'NEW', pricePerGram: RATE, effectiveAt: new Date('2026-11-05T10:00:00Z') });
  await ctx.db.insert(t.goldRates).values({ karat: 21, kind: 'USED', pricePerGram: 100_000, effectiveAt: new Date('2026-11-05T10:00:00Z') });
}, 120_000);
afterAll(async () => handle?.close());

describe('the unit and the price', () => {
  it('1 grain = 100 mg; the whole line is rounded once (the owner example: 3 grains at 123,456/g = 37,037)', () => {
    expect(grainsToMg(1)).toBe(100);
    expect(grainsToMg(10)).toBe(1_000);
    expect(grainLinePrice(3, 123_456)).toBe(37_037);
    expect(grainLinePrice(3, 123_456)).toBe(valueOfWeight(300, 123_456));
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => grainsToMg(bad), String(bad)).toThrow(RangeError);
    expect(grainsIn(1_299)).toBe(12);
    expect(grainsIn(0)).toBe(0);
    expect(grainsIn(-500)).toBe(0);
  });
  it('property: weight = grains × 100 mg; the line price is the whole weight at the rate, rounded once, never per grain', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 10_000_000 }), (grains, rate) => {
        expect(grainsToMg(grains)).toBe(grains * 100);
        const price = grainLinePrice(grains, rate);
        expect(price).toBe(valueOfWeight(grains * 100, rate));
        // Exact half-up rounding of grains × rate / 10, computed in BigInt.
        const exact = (BigInt(grains) * BigInt(rate) * 2n + 10n) / 20n;
        expect(BigInt(price)).toBe(exact);
        // The whole-line price never differs from the sum of per-grain prices by more than half a unit per grain.
        const perGrain = grains * valueOfWeight(100, rate);
        expect(Math.abs(perGrain - price)).toBeLessThanOrEqual(Math.ceil(grains / 2));
      }),
      { numRuns: 300 },
    );
  });
});

describe('selling grains', () => {
  it('the cashier sells 3 grains of 21K: the sale, its line, one SCRAP_SALE row, the pool −300 mg; no cost', async () => {
    const { branchId, cashier } = await branchWithPool(21, 1_250);
    const sale = await grainsSale(cashier, branchId, [{ karat: 21, grains: 3 }]);
    expect(sale.total).toBe(37_037);
    expect(sale.subtotal).toBe(37_037);
    expect(sale.costTotal).toBe(0);
    expect(sale.unknownCostLines).toBe(1);
    expect(await pool(branchId, 21)).toBe(950);
    const lines = await ctx.db.select().from(t.saleScrapLines).where(eq(t.saleScrapLines.saleId, sale.id));
    expect(lines).toMatchObject([{ lineNo: 1, karat: 21, grains: 3, weightMg: 300, ratePerGram: RATE, price: 37_037 }]);
    const moves = await ctx.db.select().from(t.scrapWeightEntries).where(and(eq(t.scrapWeightEntries.refType, 'sale_scrap_line'), eq(t.scrapWeightEntries.refId, lines[0].id)));
    expect(moves).toMatchObject([{ branchId, karat: 21, weightMg: -300, eventType: 'SCRAP_SALE', refNumber: sale.number }]);
    // The money: the drawer receives the total (one SALE entry).
    const ledger = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'sale'), eq(t.ledgerEntries.refId, sale.id)));
    expect(ledger.map((e) => [e.eventType, e.amount])).toEqual([['SALE', 37_037]]);
    // The sale page: the grain line; the General Manager sees no profit (nothing known).
    const page = await getSale(ctx, gm, sale.id);
    expect(page.scrapLines).toMatchObject([{ karat: 21, grains: 3, weightMg: 300, ratePerGram: RATE, price: 37_037 }]);
    expect(page.items).toEqual([]);
    expect((page as { grossProfit?: number | null }).grossProfit).toBeNull();
    const asCashier = await getSale(ctx, cashier, sale.id);
    expect(asCashier.scrapLines).toHaveLength(1);
  });

  it('several karats in one sale, each from its own pool', async () => {
    const { branchId, cashier } = await branchWithPool(21, 1_000);
    await ctx.db.insert(t.goldRates).values({ karat: 22, kind: 'NEW', pricePerGram: 150_000, effectiveAt: new Date('2026-11-05T10:00:00Z') });
    await buyScrap(ctx, gm, { branchId, kind: 'BROKEN', karat: 22, grossWeightMg: 700, netWeightMg: 700, paymentMethod: 'BANK_TRANSFER', bankReference: 'WSL-22-A' });
    const sale = await createSale(ctx, cashier, {
      branchId,
      items: [],
      scrapLines: [
        { karat: 21, grains: 4, listPrice: grainLinePrice(4, RATE) },
        { karat: 22, grains: 7, listPrice: grainLinePrice(7, 150_000) },
      ],
      paymentMethod: 'CASH',
    });
    expect(sale.total).toBe(grainLinePrice(4, RATE) + grainLinePrice(7, 150_000));
    expect([await pool(branchId, 21), await pool(branchId, 22)]).toEqual([600, 0]);
  });

  it('refusals: more than the pool, a price not seen, no rate, 0 grains, the same karat twice, an empty cart; nothing written', async () => {
    const { branchId, cashier } = await branchWithPool(21, 1_250); // 12 whole grains
    await buyScrap(ctx, gm, { branchId, kind: 'BROKEN', karat: 18, grossWeightMg: 500, netWeightMg: 500, paymentMethod: 'BANK_TRANSFER', bankReference: 'WSL-18-A' });
    const before = await ctx.db.select().from(t.sales).where(eq(t.sales.branchId, branchId));
    const err = await grainsSale(cashier, branchId, [{ karat: 21, grains: 13 }]).catch((e) => e);
    expect(err.code).toBe('SCRAP_POOL_SHORT');
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ karat: 21, balanceMg: 1_250, neededMg: 1_300 });
    const changed = await grainsSale(cashier, branchId, [{ karat: 21, grains: 3, listPrice: 37_000 }]).catch((e) => e);
    expect(changed.code).toBe('PRICES_CHANGED');
    expect(changed.details.scrapLines).toEqual([{ karat: 21, grains: 3, listPrice: 37_037, pricePerGram: RATE }]);
    expect(await refused(grainsSale(cashier, branchId, [{ karat: 18, grains: 1, listPrice: 1 }]))).toBe('NO_PRICE');
    expect(await refused(grainsSale(cashier, branchId, [{ karat: 21, grains: 0, listPrice: 1 }]))).toBe('BAD_REQUEST');
    expect(await refused(grainsSale(cashier, branchId, [{ karat: 21, grains: 1 }, { karat: 21, grains: 2 }]))).toBe('BAD_REQUEST');
    expect(await refused(createSale(ctx, cashier, { branchId, items: [], scrapLines: [], paymentMethod: 'CASH' }))).toBe('BAD_REQUEST');
    // The exact balance is sellable (12 grains = 1,200 mg; 50 mg stay).
    await grainsSale(cashier, branchId, [{ karat: 21, grains: 12 }]);
    expect(await pool(branchId, 21)).toBe(50);
    expect(await refused(grainsSale(cashier, branchId, [{ karat: 21, grains: 1 }]))).toBe('SCRAP_POOL_SHORT');
    expect((await ctx.db.select().from(t.sales).where(eq(t.sales.branchId, branchId))).length).toBe(before.length + 1);
  });

  it('another branch: a branch-bound cashier sells from the own branch only', async () => {
    const a = await branchWithPool(21, 1_000);
    const b = await branchWithPool(21, 1_000);
    // The cashier of A names branch B: refused (branch scope); B's pool never moves.
    expect(await refused(grainsSale(a.cashier, b.branchId, [{ karat: 21, grains: 2 }]))).not.toBe('OK');
    expect(await pool(b.branchId, 21)).toBe(1_000);
    expect(await pool(a.branchId, 21)).toBe(1_000);
  });

  it('the POS list: one row per karat with pool weight, its whole grains and its rate (null without one); own branch only', async () => {
    const { branchId, cashier } = await branchWithPool(21, 1_299);
    await buyScrap(ctx, gm, { branchId, kind: 'BROKEN', karat: 18, grossWeightMg: 400, netWeightMg: 400, paymentMethod: 'BANK_TRANSFER', bankReference: 'WSL-18-B' });
    const list = await scrapGrainsForPos(ctx, cashier, {});
    expect(list).toEqual({
      branchId,
      rows: [
        { karat: 18, weightMg: 400, grains: 4, pricePerGram: null },
        { karat: 21, weightMg: 1_299, grains: 12, pricePerGram: RATE },
      ],
    });
    const other = await branchWithPool(21, 300);
    expect(await refused(scrapGrainsForPos(ctx, cashier, { branchId: other.branchId }))).toBe('FORBIDDEN');
    expect(await refused(scrapGrainsForPos(ctx, gm, {}))).toBe('BAD_REQUEST');
    expect((await scrapGrainsForPos(ctx, gm, { branchId: other.branchId })).rows).toEqual([{ karat: 21, weightMg: 300, grains: 3, pricePerGram: RATE }]);
  });
});

describe('void, idempotency, settlement, profit', () => {
  it('a void (branch manager) puts the grains back: one REVERSAL row of the same karat; the cashier cannot void', async () => {
    const { branchId, bm, cashier } = await branchWithPool(21, 1_000);
    const sale = await grainsSale(cashier, branchId, [{ karat: 21, grains: 6 }]);
    expect(await pool(branchId, 21)).toBe(400);
    expect(await refused(voidSale(ctx, cashier, sale.id, 'خطأ في الكمية'))).toBe('FORBIDDEN');
    await voidSale(ctx, bm, sale.id, 'خطأ في الكمية');
    expect(await pool(branchId, 21)).toBe(1_000);
    const [line] = await ctx.db.select().from(t.saleScrapLines).where(eq(t.saleScrapLines.saleId, sale.id));
    const moves = await ctx.db.select().from(t.scrapWeightEntries).where(and(eq(t.scrapWeightEntries.refType, 'sale_scrap_line'), eq(t.scrapWeightEntries.refId, line.id))).orderBy(asc(t.scrapWeightEntries.id));
    expect(moves.map((m) => [m.eventType, m.karat, m.weightMg])).toEqual([['SCRAP_SALE', 21, -600], ['REVERSAL', 21, 600]]);
    // A second void is refused; the pool does not move again.
    expect(await refused(voidSale(ctx, bm, sale.id, 'مرة ثانية'))).toBe('BAD_REQUEST');
    expect(await pool(branchId, 21)).toBe(1_000);
  });

  it('an Idempotency-Key retry of the same sale deducts once (HTTP, the seeded cashier of KRT)', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ username: 'cashier.kh.01', password: DEMO_PASSWORDS.CASHIER });
    expect(login.status).toBe(200);
    agent.set('x-csrf-token', login.body.csrfToken);
    const [krt] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT'));
    await buyScrap(ctx, gm, { branchId: krt.id, kind: 'BROKEN', karat: 21, grossWeightMg: 500, netWeightMg: 500, paymentMethod: 'BANK_TRANSFER', bankReference: 'WSL-KRT-1' });
    const before = await pool(krt.id, 21);
    const offered = await agent.get('/api/pos/scrap-grains');
    expect(offered.status).toBe(200);
    expect(offered.body.rows.find((r: { karat: number }) => r.karat === 21)).toMatchObject({ weightMg: before, pricePerGram: RATE });
    const key = randomUUID();
    const body = { items: [], scrapLines: [{ karat: 21, grains: 2, listPrice: grainLinePrice(2, RATE) }], paymentMethod: 'CASH' };
    const first = await agent.post('/api/sales').set('Idempotency-Key', key).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.scrapLines).toMatchObject([{ karat: 21, grains: 2, weightMg: 200 }]);
    const again = await agent.post('/api/sales').set('Idempotency-Key', key).send(body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await pool(krt.id, 21)).toBe(before - 200);
    expect((await ctx.db.select().from(t.saleScrapLines).where(eq(t.saleScrapLines.saleId, first.body.id))).length).toBe(1);
  });

  it('a supplier settlement can use only what the grain sales left in the pool', async () => {
    const { branchId, bm, cashier } = await branchWithPool(24, 1_000);
    await ctx.db.insert(t.goldRates).values({ karat: 24, kind: 'NEW', pricePerGram: 200_000, effectiveAt: new Date('2026-11-05T10:00:00Z') });
    const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).orderBy(asc(t.products.id)).limit(1);
    const [s] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    const po = await createPurchase(ctx, gm, { branchId, supplierId: s.id, confirmOpenSupplierDebt: true, lines: [{ productId: p.id, grossWeightMg: 5_000, netWeightMg: 5_000, purchaseCost: 1_000_000, makingCost: 0, otherCost: 0, sellingPrice: 1_500_000 }] });
    await createSale(ctx, cashier, { branchId, items: [], scrapLines: [{ karat: 24, grains: 6, listPrice: grainLinePrice(6, 200_000) }], paymentMethod: 'CASH' });
    expect(await pool(branchId, 24)).toBe(400);
    expect(await refused(settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: 500 }))).not.toBe('OK');
    await settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: 400 });
    expect(await pool(branchId, 24)).toBe(0);
    expect(await refused(grainsSale(cashier, branchId, [{ karat: 24, grains: 1, listPrice: grainLinePrice(1, 200_000) }]))).toBe('SCRAP_POOL_SHORT');
  });

  it('profit: a mixed sale counts its piece only; a grains-only sale has none; the list footer agrees', async () => {
    const { branchId, cashier } = await branchWithPool(21, 1_000);
    // A piece of known cost moved into the new branch (its own fixture: a supplier order received there).
    const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).orderBy(asc(t.products.id)).limit(1);
    const [s] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    await createPurchase(ctx, gm, { branchId, supplierId: s.id, confirmOpenSupplierDebt: true, lines: [{ productId: p.id, grossWeightMg: 5_100, netWeightMg: 5_000, purchaseCost: 400_000, makingCost: 0, otherCost: 0, sellingPrice: 900_000 }] });
    const [item] = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, branchId), eq(t.jewelryItems.status, 'AVAILABLE'))).orderBy(asc(t.jewelryItems.id));
    const grains = grainLinePrice(5, RATE);
    const mixed = await createSale(ctx, cashier, { branchId, items: [{ itemId: item.id, listPrice: item.sellingPrice ?? undefined }], scrapLines: [{ karat: 21, grains: 5, listPrice: grains }], paymentMethod: 'CASH' });
    expect(mixed.total).toBe((item.sellingPrice ?? 0) + grains);
    expect(mixed.unknownCostLines).toBe(1);
    const detail = (await getSale(ctx, gm, mixed.id)) as { grossProfit: number | null };
    expect(detail.grossProfit).toBe((item.sellingPrice ?? 0) - (item.acquisitionCost ?? 0));
    const only = await grainsSale(cashier, branchId, [{ karat: 21, grains: 1 }]);
    expect(((await getSale(ctx, gm, only.id)) as { grossProfit: number | null }).grossProfit).toBeNull();
    const list = await pageSales(ctx, gm, { branchId, page: 1, pageSize: 50 } as never);
    const totals = list.totals as Record<string, number | null>;
    expect(totals.total).toBe(mixed.total + only.total);
    expect(totals.grossProfit).toBe(detail.grossProfit);
    expect(totals.unknownCostLines).toBe(2);
  });
});

describe('property: the pool after any sequence of purchases, grain sales, voids and settlements', () => {
  it('pool = Σ movements = purchases − grain sales + voids − settlements; never below zero; a void restores exactly', async () => {
    const { branchId, bm, cashier } = await branchWithPool(21, 0);
    let model = 0;
    const open: { id: number; mg: number }[] = [];
    const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).orderBy(asc(t.products.id)).limit(1);
    const [s] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    const po = await createPurchase(ctx, gm, { branchId, supplierId: s.id, confirmOpenSupplierDebt: true, lines: [{ productId: p.id, grossWeightMg: 200_000, netWeightMg: 200_000, purchaseCost: 1_000_000, makingCost: 0, otherCost: 0, sellingPrice: 1_500_000 }] });
    const op = fc.oneof(
      fc.record({ k: fc.constant('buy' as const), mg: fc.integer({ min: 50, max: 2_000 }) }),
      fc.record({ k: fc.constant('sell' as const), grains: fc.integer({ min: 1, max: 25 }) }),
      fc.record({ k: fc.constant('void' as const), pick: fc.nat() }),
      fc.record({ k: fc.constant('settle' as const), mg: fc.integer({ min: 1, max: 1_500 }) }),
    );
    let ref = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 10 }), async (ops) => {
        for (const o of ops) {
          if (o.k === 'buy') {
            ref += 1;
            await buyScrap(ctx, bm, { branchId, kind: 'BROKEN', karat: 21, grossWeightMg: o.mg, netWeightMg: o.mg, paymentMethod: 'BANK_TRANSFER', bankReference: `WSL-P-${ref}` });
            model += o.mg;
          } else if (o.k === 'sell') {
            const r = await grainsSale(cashier, branchId, [{ karat: 21, grains: o.grains }]).then((x) => ({ id: x.id, code: 'OK' }), (e) => ({ id: 0, code: code(e) }));
            if (o.grains * 100 <= model) {
              expect(r.code).toBe('OK');
              open.push({ id: r.id, mg: o.grains * 100 });
              model -= o.grains * 100;
            } else expect(r.code).toBe('SCRAP_POOL_SHORT');
          } else if (o.k === 'void') {
            if (!open.length) continue;
            const [v] = open.splice(o.pick % open.length, 1);
            const before = await pool(branchId, 21);
            await voidSale(ctx, bm, v.id, 'اختبار الخاصية');
            expect(await pool(branchId, 21)).toBe(before + v.mg);
            model += v.mg;
          } else {
            const r = await refused(settleWithScrap(ctx, bm, po.id, { karat: 21, weightMg: o.mg }));
            // The order owes far more than the pool ever holds: a settlement is refused only for want of scrap.
            if (r === 'OK') model -= o.mg;
            else expect(o.mg).toBeGreaterThan(model);
          }
          const now = await pool(branchId, 21);
          expect(now).toBe(model);
          expect(now).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 6 },
    );
    // Σ movements by type adds up to the balance.
    const rows = await ctx.db.select().from(t.scrapWeightEntries).where(and(eq(t.scrapWeightEntries.branchId, branchId), eq(t.scrapWeightEntries.karat, 21)));
    const by = (type: string) => rows.filter((r) => r.eventType === type).reduce((x, r) => x + r.weightMg, 0);
    expect(by('SCRAP_PURCHASE') + by('SCRAP_SALE') + by('REVERSAL') + by('SUPPLIER_SETTLEMENT')).toBe(await pool(branchId, 21));
    expect(by('SCRAP_SALE')).toBeLessThanOrEqual(0);
  }, 300_000);
});
