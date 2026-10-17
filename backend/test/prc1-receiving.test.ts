// PRC-1 receiving and the cashier's sellable-scrap purchase (D-prc1-6, D-prc1-8). Both projects.
//   * computed prices: a supplier order and a sellable scrap purchase take no selling price (one sent is refused, never
//     dropped); the piece is priced live from its rate (new for a supplier piece, used for scrap);
//   * tag prices: both still need a positive price, as before;
//   * the cashier buys a sellable piece (scrap.buy_sellable), with every limit: the price tolerance and its override,
//     the drawer BLOCK; the bank part is never refused; the audit names the cashier; no cost reaches the cashier;
//   * the cashier still cannot buy broken scrap, record a supplier order or change a rate (route matrix).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { COST_RESPONSE_FIELDS, computedPrice, valueOfWeight } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { balances } from '../src/modules/ledger/service';
import { currentSellingRates, rateKey } from '../src/modules/pricing/service';
import { scrapRates } from '../src/modules/scrap/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
let gm: Agent;
let cashier: Agent;
let krt: number;
let supplierId: number;
let productId: number;

async function login(username: string, password: string): Promise<Agent> {
  const a = withIdempotencyKeys(request.agent(app));
  const res = await a.post('/api/auth/login').send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  a.set('x-csrf-token', res.body.csrfToken);
  return a;
}
const mode = (m: 'RATE_COMPUTED' | 'FIXED_TAG') => ctx.settings.apply(ctx.db, { 'pricing.mode': m }, { actor: { id: null, username: 'test' } });
const line = (extra: object = {}) => ({ productId, grossWeightMg: 5_200, netWeightMg: 5_000, purchaseCost: 900_000, makingCost: 0, otherCost: 0, ...extra });
const order = (lines: object[]) => gm.post('/api/purchases').send({ branchId: krt, supplierId, lines, confirmOpenSupplierDebt: true });
const scrapRate21 = async () => (await scrapRates(ctx.db))[21].pricePerGram;
const sellable = (extra: object = {}) => ({ kind: 'SELLABLE', karat: 21, grossWeightMg: 2_100, netWeightMg: 2_000, productId, paymentMethod: 'CASH', ...extra });
const drawer = async () => (await balances(ctx.db, krt)).find((b) => b.kind === 'CASH')!.balance;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date(), { pricingMode: 'RATE_COMPUTED' });
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await login('general.manager', DEMO_PASSWORDS.GENERAL_MANAGER);
  cashier = await login('cashier.kh.01', DEMO_PASSWORDS.CASHIER);
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  supplierId = (await ctx.db.select().from(t.suppliers).limit(1))[0].id;
  productId = (await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).limit(1))[0].id;
});
afterAll(async () => handle?.close());

describe('receiving stock asks for no selling price (computed prices)', () => {
  it('a supplier order without prices: the pieces are priced live from the new-piece rate; a price sent is refused', async () => {
    const res = await order([line(), line({ netWeightMg: 4_000, grossWeightMg: 4_100 })]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.purchaseId, res.body.id));
    expect(items.map((i) => i.sellingPrice)).toEqual([0, 0]); // no tag price stored
    const rate = (await currentSellingRates(ctx.db)).get(rateKey(21, 'NEW'))!.pricePerGram;
    const detail = (await gm.get(`/api/purchases/${res.body.id}`)).body;
    for (const it of detail.items) expect(it.sellingPrice).toBe(computedPrice(it.netWeightMg, rate, 1));
    const refused = await order([line({ sellingPrice: 1_500_000 })]);
    expect(refused.status).toBe(400);
    expect(refused.body.error.key).toBe('Selling prices follow the rates: do not send one');
  });

  it('with tag prices a supplier order still needs a positive price per line', async () => {
    await mode('FIXED_TAG');
    expect((await order([line()])).status).toBe(400);
    const ok = await order([line({ sellingPrice: 1_400_000 })]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [it] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.purchaseId, ok.body.id));
    expect(it.sellingPrice).toBe(1_400_000);
    await mode('RATE_COMPUTED');
  });
});

describe('the cashier buys a sellable piece from a customer', () => {
  it('allowed without a price: the piece is priced from the used-piece rate; the audit names the cashier; no cost', async () => {
    const res = await cashier.post('/api/scrap-purchases').send(sellable());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).filter((k) => COST_RESPONSE_FIELDS.has(k))).toEqual([]);
    const [p] = await ctx.db.select().from(t.scrapPurchases).where(eq(t.scrapPurchases.number, res.body.number));
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'cashier.kh.01'));
    expect(p.createdBy).toBe(u.id);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.entityId, res.body.number))).orderBy(desc(t.auditLogs.id));
    expect(audit.userId).toBe(u.id);
    const [item] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.code, res.body.itemCode));
    expect(item).toMatchObject({ origin: 'SCRAP', sellingPrice: 0, status: 'AVAILABLE' });
    const used = (await currentSellingRates(ctx.db)).get(rateKey(21, 'USED'))!.pricePerGram;
    const row = (await cashier.get('/api/inventory/items').query({ q: item.code })).body.rows[0];
    expect(row).toMatchObject({ sellingPrice: computedPrice(2_000, used, 1), pricePerGram: used });
    // A price sent is refused (computed prices).
    expect((await cashier.post('/api/scrap-purchases').send(sellable({ sellingPrice: 900_000 }))).status).toBe(400);
  });

  it('every limit still applies to the cashier: the tolerance (no override), the drawer BLOCK; the bank part is never refused', async () => {
    const rate = await scrapRate21();
    const beyond = await cashier.post('/api/scrap-purchases').send(sellable({ agreedRatePerGram: rate + Math.ceil(rate * 0.1) }));
    expect(beyond.status).toBe(403);
    expect(beyond.body.error.key).toMatch(/needs General Manager approval/);
    // More cash than the drawer holds: refused (DRAWER_SHORT); the same amount by bank transfer goes through.
    const amount = valueOfWeight(2_000_000, rate); // 2 kg (test value)
    expect(amount).toBeGreaterThan(await drawer());
    const big = sellable({ grossWeightMg: 2_000_000, netWeightMg: 2_000_000 });
    const short = await cashier.post('/api/scrap-purchases').send({ ...big, paymentMethod: undefined, cashAmount: amount, bankAmount: 0 });
    expect(short.status).toBe(409);
    expect(short.body.error.code).toBe('DRAWER_SHORT');
    const byBank = await cashier.post('/api/scrap-purchases').send({ ...big, paymentMethod: undefined, cashAmount: 0, bankAmount: amount, bankReference: 'PRC1-CASHIER-BANK' });
    expect(byBank.status, JSON.stringify(byBank.body)).toBe(200);
  });

  it('the cashier still cannot buy broken scrap, record a supplier order or change a rate', async () => {
    const broken = await cashier.post('/api/scrap-purchases').send({ kind: 'BROKEN', karat: 21, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'CASH' });
    expect(broken.status).toBe(403);
    expect((await cashier.post('/api/purchases').send({ branchId: krt, supplierId, lines: [line()] })).status).toBe(403);
    expect((await cashier.post('/api/gold-rates').send({ usedRates: { 21: 1 } })).status).toBe(403);
    expect((await cashier.post('/api/scrap-rates').send({ rates: [{ karat: 21, pricePerGram: 1 }] })).status).toBe(403);
  });

  it('broken scrap carries no product and no price', async () => {
    const r = await gm.post('/api/scrap-purchases').send({ branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'BANK_TRANSFER', bankReference: 'PRC1-BROKEN-1', sellingPrice: 5 });
    expect(r.status).toBe(400);
  });
});
