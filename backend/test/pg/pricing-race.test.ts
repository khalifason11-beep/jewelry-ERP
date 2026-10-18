// Real PostgreSQL only (PRC-1, D-prc1-5): a rate change racing a sale confirmation is safe.
//   * a rate change takes the pricing lock exclusively; a sale takes it shared before reading the rates;
//   * a sale that arrives while a rate change is being written waits for it, then sees the new rate and answers 409
//     PRICES_CHANGED (the cashier saw the old price): never charged at a rate it was not shown;
//   * a rate change waits for a sale being confirmed;
//   * under a storm of sales and rate changes, every sale that went through was charged exactly the price the cashier
//     saw, which equals round(weight × the rate stored on its line); every other sale was refused with 409.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { computedPrice } from '@jerp/shared';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createSale } from '../../src/modules/sales/service';
import { pageItems } from '../../src/modules/inventory/service';
import { currentSellingRates, lockPricingExclusive, lockPricingShared, rateKey, setSellingRates } from '../../src/modules/pricing/service';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let cashier: Actor;
let krt: number;

const actor = async (username: string) => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newPieces = async (n: number) =>
  ((await pageItems(ctx, cashier, { branchId: krt, status: ['AVAILABLE'], origin: 'SUPPLIER_NEW', pageSize: 200 })).rows as { id: number; netWeightMg: number; sellingPrice: number }[]).slice(0, n);
const newRate = async () => (await currentSellingRates(ctx.db)).get(rateKey(21, 'NEW'))!.pricePerGram;
const codeOf = (e: unknown) => (e as { code?: string })?.code ?? String(e);

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date(), { pricingMode: 'RATE_COMPUTED' });
  gm = await actor('general.manager');
  cashier = await actor('cashier.kh.01');
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
});
afterAll(async () => handle?.close());

describe('a rate change racing a sale', () => {
  it('a sale arriving during a rate change waits for it, then refuses with the new price (409)', async () => {
    const [piece] = await newPieces(1);
    const seen = piece.sellingPrice;
    const higher = (await newRate()) + 7_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let written!: () => void;
    const rateWritten = new Promise<void>((r) => (written = r));
    const rateChange = ctx.db.transaction(async (tx) => {
      await lockPricingExclusive(tx);
      await tx.insert(t.goldRates).values({ karat: 21, kind: 'NEW', pricePerGram: higher, setBy: gm.userId });
      written();
      await gate;
    });
    await rateWritten;
    let settled = false;
    const sale = createSale(ctx, cashier, { items: [{ itemId: piece.id, listPrice: seen }], paymentMethod: 'CASH' }).finally(() => (settled = true));
    await sleep(400);
    expect(settled, 'the sale waits for the rate change').toBe(false);
    release();
    await rateChange;
    const err = await sale.then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe('PRICES_CHANGED');
    const lines = (err as { details: { lines: { listPrice: number; pricePerGram: number }[] } }).details.lines;
    expect(lines[0]).toMatchObject({ listPrice: computedPrice(piece.netWeightMg, higher, 1), pricePerGram: higher });
    // Confirmed again at the price now shown: sold at the new rate.
    const sold = await createSale(ctx, cashier, { items: [{ itemId: piece.id, listPrice: lines[0].listPrice }], paymentMethod: 'CASH' });
    const [line] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sold.id));
    expect(line).toMatchObject({ priceRatePerGram: higher, listPrice: lines[0].listPrice });
  });

  it('a rate change waits for a sale being confirmed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const saleLocked = new Promise<void>((r) => (locked = r));
    const saleInProgress = ctx.db.transaction(async (tx) => {
      await lockPricingShared(tx);
      locked();
      await gate;
    });
    await saleLocked;
    let done = false;
    const change = setSellingRates(ctx, gm, { NEW: { 21: (await newRate()) + 1_000 } }).finally(() => (done = true));
    await sleep(400);
    expect(done, 'the rate change waits for the sale').toBe(false);
    release();
    await saleInProgress;
    await change;
    expect(done).toBe(true);
  });

  it('a storm of sales and rate changes: every sale charged exactly the price shown, at the rate on its line', async () => {
    for (let round = 0; round < 6; round++) {
      const pieces = await newPieces(4);
      expect(pieces.length).toBe(4);
      const base = await newRate();
      const sales = pieces.map((p) => createSale(ctx, cashier, { items: [{ itemId: p.id, listPrice: p.sellingPrice }], paymentMethod: 'CASH' }));
      const changes = [setSellingRates(ctx, gm, { NEW: { 21: base + 1_000 * (round + 1) } }), setSellingRates(ctx, gm, { NEW: { 21: base + 1_000 * (round + 1) + 500 } })];
      const rs = await Promise.allSettled(sales);
      await Promise.all(changes);
      for (const [i, r] of rs.entries()) {
        if (r.status === 'rejected') {
          expect(codeOf(r.reason), `round ${round} piece ${i}`).toBe('PRICES_CHANGED');
          continue;
        }
        const [line] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, r.value.id));
        expect(line.listPrice, `round ${round}: charged the price shown`).toBe(pieces[i].sellingPrice);
        expect(line.listPrice).toBe(computedPrice(line.netWeightMg, line.priceRatePerGram!, 1));
      }
      // Pieces refused are still available; pieces sold are not.
      const sold = rs.flatMap((r, i) => (r.status === 'fulfilled' ? [pieces[i].id] : []));
      if (sold.length) {
        const st = await ctx.db.select({ status: t.jewelryItems.status }).from(t.jewelryItems).where(and(inArray(t.jewelryItems.id, sold)));
        expect(st.every((s) => s.status === 'SOLD')).toBe(true);
      }
    }
  }, 120_000);
});
