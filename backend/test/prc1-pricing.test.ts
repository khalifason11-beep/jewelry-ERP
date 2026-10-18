// PRC-1 computed prices (D-prc1-1, D-prc1-4). Both projects; the world runs RATE_COMPUTED here.
//   * a piece's price is live: net weight × the current rate of its karat and kind, one rounding to the step; the
//     inventory list, the item detail, the POS grid (the same list) and the stock valuation change the moment the
//     General Manager changes a rate (the owner's example: 1 g at 100 → 110);
//   * new and used pieces are priced by their own rate; SQL (lists) and TypeScript (the sale) give the same price;
//   * a sale locks its price: the line keeps the rate, the gold value and the list price; a later rate change never
//     touches it; the cashier must have seen the price (409 PRICES_CHANGED with the new prices otherwise);
//   * a piece without a rate shows no price and cannot be sold (never 0); a manual price change is refused;
//   * FIXED_TAG behaves as before (stored prices, no listPrice needed, price change allowed);
//   * no cost field reaches the branch manager or the cashier on the new fields.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { COST_RESPONSE_FIELDS, computedPrice, goldValue, rateKindFor } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { rows } from '../src/core/sql';
import { currentSellingRates, rateKey } from '../src/modules/pricing/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
let gm: Agent;
let bm: Agent;
let cashier: Agent;
let krt: number;

interface Row {
  id: number;
  code: string;
  karat: number;
  origin: string;
  netWeightMg: number;
  sellingPrice: number | null;
  pricePerGram: number | null;
  status: string;
}

async function login(username: string, password: string): Promise<Agent> {
  const a = withIdempotencyKeys(request.agent(app));
  const res = await a.post('/api/auth/login').send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  a.set('x-csrf-token', res.body.csrfToken);
  return a;
}
const available = async (agent: Agent, origin?: string): Promise<Row[]> =>
  (await agent.get('/api/inventory/items').query({ branchId: krt, status: 'AVAILABLE', pageSize: 200, ...(origin ? { origin } : {}) })).body.rows;
// DEC-1 (RAT-1): these tests move rates far on purpose (100 → 110, random rates), so every change carries the reason
// and the password the edit guard asks for above its thresholds (the guard itself is tested in dec1-rate-guard).
const setRates = async (body: object) => {
  const r = await gm.post('/api/gold-rates').send({ reason: 'test: set the rates', confirmPassword: DEMO_PASSWORDS.GENERAL_MANAGER, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const rate = async (karat: number, kind: 'NEW' | 'USED') => (await currentSellingRates(ctx.db)).get(rateKey(karat, kind))!.pricePerGram;
const step = async () => (await ctx.settings.get()).pricing.roundingStep;
const sell = (agent: Agent, item: { id: number }, listPrice: number | null | undefined, extra: object = {}) =>
  agent.post('/api/sales').send({ items: [{ itemId: item.id, ...(listPrice != null ? { listPrice } : {}) }], paymentMethod: 'CASH', ...extra });

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date(), { pricingMode: 'RATE_COMPUTED' });
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await login('general.manager', DEMO_PASSWORDS.GENERAL_MANAGER);
  expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
  bm = await login('branch.manager.kh', DEMO_PASSWORDS.BRANCH_MANAGER);
  cashier = await login('cashier.kh.01', DEMO_PASSWORDS.CASHIER);
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
});
afterAll(async () => handle?.close());

describe('live computed prices', () => {
  it('every available piece is priced from its karat and kind; SQL (the list) equals TypeScript (the sale)', async () => {
    const rates = await currentSellingRates(ctx.db);
    const s = await step();
    const list = await available(gm);
    expect(list.length).toBeGreaterThan(5);
    expect(list.some((r) => r.origin === 'SCRAP') && list.some((r) => r.origin !== 'SCRAP')).toBe(true);
    for (const r of list) {
      const kindRate = rates.get(rateKey(r.karat, rateKindFor(r.origin)))!.pricePerGram;
      expect(r.pricePerGram, r.code).toBe(kindRate);
      expect(r.sellingPrice, r.code).toBe(computedPrice(r.netWeightMg, kindRate, s));
    }
    // New and used rates are different numbers in the world, so the two kinds really are priced apart.
    expect(await rate(21, 'NEW')).not.toBe(await rate(21, 'USED'));
  });

  it('a rate change reprices the inventory list, the item detail, the POS grid and the valuation at once', async () => {
    const before = await available(cashier);
    const reportBefore = (await gm.get('/api/reports/inventory').query({ branchId: krt, status: 'AVAILABLE' })).body.totals.sellingPrice;
    const homeBefore = (await gm.get('/api/dashboard/company')).body.totals?.inventoryRetail;
    const newRate = (await rate(21, 'NEW')) + 10_000;
    await setRates({ rates: { 21: newRate } });
    const after = await available(cashier);
    const s = await step();
    for (const r of after.filter((x) => x.origin !== 'SCRAP')) {
      expect(r.sellingPrice, r.code).toBe(computedPrice(r.netWeightMg, newRate, s));
      expect(r.sellingPrice!).toBeGreaterThan(before.find((b) => b.id === r.id)!.sellingPrice!);
    }
    for (const r of after.filter((x) => x.origin === 'SCRAP')) expect(r.sellingPrice).toBe(before.find((b) => b.id === r.id)!.sellingPrice); // used rate unchanged
    const one = after.find((x) => x.origin !== 'SCRAP')!;
    expect((await gm.get(`/api/inventory/items/${one.id}`)).body.item).toMatchObject({ sellingPrice: one.sellingPrice, pricePerGram: newRate });
    const reportAfter = (await gm.get('/api/reports/inventory').query({ branchId: krt, status: 'AVAILABLE' })).body.totals.sellingPrice;
    expect(reportAfter).toBeGreaterThan(reportBefore);
    if (homeBefore != null) expect((await gm.get('/api/dashboard/company')).body.totals.inventoryRetail).toBeGreaterThan(homeBefore);
  });

  it("the owner's example: a 1 g piece at 100 on Sunday sells at 110 on Monday", async () => {
    // A copy of an available new piece weighing exactly 1 g (a new row; nothing else changes).
    const src = (await available(gm)).find((r) => r.origin !== 'SCRAP')!;
    await ctx.db.execute(sql`
      INSERT INTO jewelry_items (code, barcode, product_id, karat, gross_weight_mg, net_weight_mg, origin, acquisition_cost, making_charge, selling_price, branch_id, status)
      SELECT 'PRC-1G', '6281000PRC1G', product_id, karat, 1000, 1000, 'SUPPLIER_NEW', 50, 0, 0, branch_id, 'AVAILABLE' FROM jewelry_items WHERE id = ${src.id}`);
    const old = await rate(21, 'NEW');
    await setRates({ rates: { 21: 100 } });
    const sunday = (await available(gm)).find((r) => r.code === 'PRC-1G')!;
    expect(sunday.sellingPrice).toBe(100);
    await setRates({ rates: { 21: 110 } });
    const monday = (await available(gm)).find((r) => r.code === 'PRC-1G')!;
    expect(monday.sellingPrice).toBe(110);
    const sale = await sell(cashier, monday, 110);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(sale.body.total).toBe(110);
    await setRates({ rates: { 21: old } });
  });
});

describe('a sale locks its price', () => {
  it('the line stores the rate, the gold value, the list and final price; a later rate change never touches it', async () => {
    const piece = (await available(cashier, 'SCRAP'))[0];
    const res = await sell(cashier, piece, piece.sellingPrice);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [line] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, res.body.id));
    const usedRate = await rate(21, 'USED');
    expect(line).toMatchObject({
      pricingMode: 'COMPUTED',
      priceRatePerGram: usedRate,
      priceGoldValue: goldValue(piece.netWeightMg, usedRate),
      priceMakingCharge: null, // Q-1 open: no making charge
      listPrice: piece.sellingPrice,
      finalPrice: piece.sellingPrice,
      discount: 0,
    });
    expect(line.profit).toBe(line.finalPrice - line.acquisitionCost);
    await setRates({ usedRates: { 21: usedRate + 25_000 } });
    const detail = (await gm.get(`/api/sales/${res.body.id}`)).body;
    expect(detail.total).toBe(piece.sellingPrice);
    expect(detail.items[0]).toMatchObject({ listPrice: piece.sellingPrice, priceRatePerGram: usedRate });
    const listed = (await gm.get('/api/sales').query({ q: res.body.number })).body.rows[0];
    expect(listed.pricePerGram).toBe(usedRate);
  });

  it('a price the cashier did not see is never charged: 409 PRICES_CHANGED with every new price, then confirm again', async () => {
    const [a, b] = (await available(cashier)).filter((r) => r.origin !== 'SCRAP');
    const seen = [a.sellingPrice!, b.sellingPrice!];
    const newRate = (await rate(21, 'NEW')) + 5_000;
    await setRates({ rates: { 21: newRate } });
    const first = await cashier.post('/api/sales').send({ items: [{ itemId: a.id, listPrice: seen[0] }, { itemId: b.id, listPrice: seen[1] }], paymentMethod: 'CASH' });
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('PRICES_CHANGED');
    const s = await step();
    expect(first.body.error.details.lines).toEqual([
      { itemId: a.id, code: a.code, listPrice: computedPrice(a.netWeightMg, newRate, s), pricePerGram: newRate },
      { itemId: b.id, code: b.code, listPrice: computedPrice(b.netWeightMg, newRate, s), pricePerGram: newRate },
    ]);
    // Nothing was sold.
    expect((await available(cashier)).some((r) => r.id === a.id)).toBe(true);
    const again = await cashier.post('/api/sales').send({ items: first.body.error.details.lines.map((l: { itemId: number; listPrice: number }) => ({ itemId: l.itemId, listPrice: l.listPrice })), paymentMethod: 'CASH' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.subtotal).toBe(first.body.error.details.lines[0].listPrice + first.body.error.details.lines[1].listPrice);
  });

  it('a sale without the price shown is refused the same way (409 with the price)', async () => {
    const [p] = (await available(cashier)).filter((r) => r.origin !== 'SCRAP');
    const r = await sell(cashier, p, undefined);
    expect(r.status).toBe(409);
    expect(r.body.error.details.lines[0]).toMatchObject({ itemId: p.id, listPrice: p.sellingPrice });
  });

  it('discount limits and the price-change reason still apply, on the computed price', async () => {
    const [p] = (await available(cashier)).filter((r) => r.origin !== 'SCRAP');
    const tooMuch = await cashier.post('/api/sales').send({ items: [{ itemId: p.id, listPrice: p.sellingPrice, discount: Math.ceil(p.sellingPrice! * 0.04) }], paymentMethod: 'CASH', priceChangeReason: 'Regular customer' });
    expect(tooMuch.status).toBe(403);
    const noReason = await cashier.post('/api/sales').send({ items: [{ itemId: p.id, listPrice: p.sellingPrice, discount: 1_000 }], paymentMethod: 'CASH' });
    expect(noReason.status).toBe(400);
    const ok = await cashier.post('/api/sales').send({ items: [{ itemId: p.id, listPrice: p.sellingPrice, discount: 1_000 }], paymentMethod: 'CASH', priceChangeReason: 'Regular customer' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.total).toBe(p.sellingPrice! - 1_000);
  });
});

describe('no rate, no price', () => {
  it('a piece whose rate is missing shows no price and cannot be sold (never 0); A16 says so', async () => {
    // A used piece of its own (a copy of an available piece, origin SCRAP; the world's one used piece was sold above).
    const src = (await available(gm))[0];
    await ctx.db.execute(sql`
      INSERT INTO jewelry_items (code, barcode, product_id, karat, gross_weight_mg, net_weight_mg, origin, acquisition_cost, making_charge, selling_price, branch_id, status)
      SELECT 'PRC-USED', '6281000PRCUS', product_id, karat, 3500, 3400, 'SCRAP', 400000, 0, 0, branch_id, 'AVAILABLE' FROM jewelry_items WHERE id = ${src.id}`);
    const p = (await available(cashier, 'SCRAP')).find((r) => r.code === 'PRC-USED')!;
    expect(p.sellingPrice).toEqual(expect.any(Number));
    const usedRate = await rate(21, 'USED');
    // A used rate of 0 is no rate (append-only history: a new row; the API refuses 0, a stale import might not).
    await ctx.db.insert(t.goldRates).values({ karat: 21, kind: 'USED', pricePerGram: 0 });
    const after = await available(cashier, 'SCRAP');
    const row = after.find((r) => r.id === p.id)!;
    expect(row).toMatchObject({ sellingPrice: null, pricePerGram: null });
    const r = await sell(cashier, p, p.sellingPrice);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'NO_PRICE', key: 'No selling rate for used {karat}K pieces: {code} cannot be sold until the General Manager sets it', params: { code: p.code, karat: 21 } });
    expect(((await gm.get('/api/attention')).body.signals as { code: string }[]).map((s) => s.code)).toContain('A16');
    await setRates({ usedRates: { 21: usedRate } });
    expect((await available(cashier, 'SCRAP')).find((x) => x.id === p.id)!.sellingPrice).toBe(p.sellingPrice);
  });

  it('nobody types a price: the manual price change is refused while prices follow the rates', async () => {
    const [p] = await available(bm);
    const r = await bm.post(`/api/inventory/items/${p.id}/price`).send({ sellingPrice: 1_000_000, reason: 'Test of the refusal' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PRICE_FOLLOWS_RATES');
  });
});

describe('SQL equals TypeScript on random values', () => {
  it('300 random weights, 3 random rates and steps: the list price is computedPrice() every time', async () => {
    const rnd = (() => {
      let x = 20261017;
      return (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
    })();
    const src = (await available(gm))[0];
    const weights = Array.from({ length: 300 }, () => 1 + rnd(10_000_000));
    await ctx.db.execute(sql.raw(`
      INSERT INTO jewelry_items (code, barcode, product_id, karat, gross_weight_mg, net_weight_mg, origin, acquisition_cost, making_charge, selling_price, branch_id, status)
      SELECT 'RND-' || g.i, 'RND' || lpad(g.i::text, 9, '0'), product_id, karat, w.mg, w.mg, 'OPENING', 1, 0, 0, branch_id, 'AVAILABLE'
      FROM jewelry_items, unnest(ARRAY[${weights.join(',')}]) WITH ORDINALITY AS w(mg, i), LATERAL (SELECT w.i AS i) g
      WHERE id = ${src.id}`));
    const old = await rate(21, 'NEW');
    for (const [r, st] of [[1 + rnd(100_000_000), 1], [1 + rnd(1_000_000), 500], [1 + rnd(250_000), 1_000_000]]) {
      await setRates({ rates: { 21: r } });
      await ctx.settings.apply(ctx.db, { 'pricing.roundingStep': st }, { actor: { id: null, username: 'test' } });
      const list = (await gm.get('/api/inventory/items').query({ branchId: krt, status: 'AVAILABLE', q: 'RND-', pageSize: 200 })).body.rows as Row[];
      const more = (await gm.get('/api/inventory/items').query({ branchId: krt, status: 'AVAILABLE', q: 'RND-', pageSize: 200, page: 2 })).body.rows as Row[];
      const all = [...list, ...more];
      expect(all).toHaveLength(300);
      for (const x of all) expect(x.sellingPrice, `${x.netWeightMg} mg × ${r} step ${st}`).toBe(computedPrice(x.netWeightMg, r, st));
    }
    await ctx.settings.apply(ctx.db, { 'pricing.roundingStep': 1 }, { actor: { id: null, username: 'test' } });
    await setRates({ rates: { 21: old } });
    await ctx.db.execute(sql`UPDATE jewelry_items SET status = 'DAMAGED' WHERE code LIKE 'RND-%'`);
  });
});

describe('rounding step (provisional, Q-2)', () => {
  it('a step of 1,000 rounds every price once, to a multiple of 1,000', async () => {
    await ctx.settings.apply(ctx.db, { 'pricing.roundingStep': 1_000 }, { actor: { id: null, username: 'test' } });
    const rates = await currentSellingRates(ctx.db);
    for (const r of await available(gm)) {
      expect(r.sellingPrice! % 1_000).toBe(0);
      expect(r.sellingPrice).toBe(computedPrice(r.netWeightMg, rates.get(rateKey(r.karat, rateKindFor(r.origin)))!.pricePerGram, 1_000));
    }
    await ctx.settings.apply(ctx.db, { 'pricing.roundingStep': 1 }, { actor: { id: null, username: 'test' } });
  });
});

describe('cost visibility on the new fields', () => {
  it('the branch manager and the cashier see the live price and the rate, never a cost', async () => {
    for (const agent of [bm, cashier]) {
      const list = await agent.get('/api/inventory/items').query({ branchId: krt, status: 'AVAILABLE', pageSize: 20 });
      for (const r of list.body.rows as Record<string, unknown>[]) {
        expect(Object.keys(r).filter((k) => COST_RESPONSE_FIELDS.has(k))).toEqual([]);
        expect(r.pricePerGram).toEqual(expect.any(Number));
      }
      expect(Object.keys(list.body.totals ?? {}).filter((k) => COST_RESPONSE_FIELDS.has(k))).toEqual([]);
    }
  });
});

describe('FIXED_TAG keeps the stored tag prices exactly', () => {
  it('lists show the stored price, a sale needs no listPrice and stores a FIXED_TAG line; the price change works again', async () => {
    await ctx.settings.apply(ctx.db, { 'pricing.mode': 'FIXED_TAG' }, { actor: { id: null, username: 'test' } });
    const stored = new Map(rows<{ id: number; selling_price: string }>(await ctx.db.execute(sql`SELECT id, selling_price FROM jewelry_items WHERE status = 'AVAILABLE' AND branch_id = ${krt}`)).map((r) => [Number(r.id), Number(r.selling_price)]));
    const list = await available(cashier);
    for (const r of list) {
      expect(r.sellingPrice).toBe(stored.get(r.id));
      expect(r.pricePerGram).toBeNull();
    }
    const p = list.find((r) => (r.sellingPrice ?? 0) > 0 && r.code !== 'PRC-1G')!;
    const res = await sell(cashier, p, undefined);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [line] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, res.body.id));
    expect(line).toMatchObject({ pricingMode: 'FIXED_TAG', listPrice: p.sellingPrice, priceRatePerGram: null, priceGoldValue: null });
    const [q] = await available(bm);
    expect((await bm.post(`/api/inventory/items/${q.id}/price`).send({ sellingPrice: 1_234_000, reason: 'Tag price check' })).status).toBe(200);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'PRICE_CHANGED'), eq(t.auditLogs.entityId, q.code))).orderBy(desc(t.auditLogs.id));
    expect(audit.metadata).toMatchObject({ to: 1_234_000 });
    await ctx.settings.apply(ctx.db, { 'pricing.mode': 'RATE_COMPUTED' }, { actor: { id: null, username: 'test' } });
  });
});
