// MIS-1 (PUR-FIX, owner answer Q1 option B): property tests of what a correction really does, against the database.
// For random orders (1–4 pieces, random making costs, some pieces sold) and random sequences of corrections:
//   (a) the order's effective making charge = Σ of its pieces' effective making costs (and its total cost moves by the same);
//   (b) a sold piece's cost never changes (the piece, and its sale line), and its correction is refused (409);
//   (c) the supplier gold debt (and gold still owed) never changes;
//   (d) the stock value at cost after = before − old cost + new cost of each changed piece in stock.
// Both projects. Each run writes its own order; the database is shared across runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fc from 'fast-check';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { sumInt } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { dayKey } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { ledgerStock } from '../src/modules/inventory/ledger';
import { createPurchase, getPurchase } from '../src/modules/purchases/service';
import { correctPurchase } from '../src/modules/purchases/corrections';
import { createSale } from '../src/modules/sales/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let cashier: Actor;
let krt: number;
let productId: number;
let supplierId: number;
let today: string;
let fixedTag = true;
let seq = 0;
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const RUNS = { numRuns: 12 };

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  expect((await request(app).post('/api/auth/login').send({ username: 'general.manager', password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gm = (await loadActor(ctx.db, u.id, s.id))!;
  const [c] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'cashier.kh.01'));
  cashier = (await loadActor(ctx.db, c.id, null))!;
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  productId = (await ctx.db.select().from(t.products).where(and(eq(t.products.karat, 21), eq(t.products.isActive, true))).limit(1))[0].id;
  supplierId = (await ctx.db.select().from(t.suppliers))[0].id;
  const settings = await ctx.settings.get();
  today = dayKey(new Date(), settings.company.timezone);
  fixedTag = settings.pricing.mode === 'FIXED_TAG';
});
afterAll(async () => handle?.close());

const money = fc.integer({ min: 0, max: 500_000 });
const scenario = fc.record({
  pieces: fc.array(fc.record({ making: money, sold: fc.boolean() }), { minLength: 1, maxLength: 4 }),
  corrections: fc.array(fc.record({ line: fc.nat(), value: money }), { minLength: 1, maxLength: 5 }),
});

describe('a piece\'s making cost correction (option B), for random orders and corrections', () => {
  it('(a) order = Σ pieces, (b) sold pieces untouched, (c) gold debt unchanged, (d) stock moves by new − old', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ pieces, corrections }) => {
        const makings0 = pieces.map((p) => p.making);
        const total0 = sumInt(makings0);
        const po = await createPurchase(ctx, gm, {
          confirmOpenSupplierDebt: true,
          branchId: krt,
          supplierId,
          lines: pieces.map((p) => ({ productId, grossWeightMg: 3_100, netWeightMg: 3_000, purchaseCost: 600_000, makingCost: p.making, otherCost: 10_000, ...(fixedTag ? { sellingPrice: 1_400_000 } : {}) })),
          ...(total0 > 0 ? { makingChargeReference: `PROP-${process.pid}-${++seq}`, makingChargeTransferDate: today } : {}),
        });
        const lines = await ctx.db.select().from(t.purchaseItems).where(eq(t.purchaseItems.purchaseId, po.id)).orderBy(t.purchaseItems.id);
        for (const [i, p] of pieces.entries()) if (p.sold) await createSale(ctx, cashier, { items: [{ itemId: lines[i].itemId }], paymentMethod: 'CASH' });
        const soldLines0 = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, lines[0].itemId));
        const [p0] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, po.id));
        const hasRef = total0 > 0;
        const model = [...makings0];
        for (const c of corrections) {
          const i = c.line % lines.length;
          const stockBefore = await ledgerStock(ctx.db, krt, new Date(Date.now() + 60_000));
          const [itemBefore] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, lines[i].itemId));
          const res = await correctPurchase(ctx, gm, po.id, { field: 'MAKING_COST', purchaseItemId: lines[i].id, newValue: c.value, reason: 'property test', confirmPassword: PW }).then(
            () => 'OK',
            (e: { code?: string }) => e.code ?? String(e),
          );
          const nextTotal = sumInt(model) - model[i] + c.value;
          const expected = pieces[i].sold
            ? 'PURCHASE_PIECE_SOLD'
            : c.value === model[i]
              ? 'CORRECTION_NO_CHANGE'
              : nextTotal === 0 && hasRef
                ? 'MAKING_CHARGE_ZERO_WITH_REFERENCE'
                : nextTotal > 0 && !hasRef
                  ? 'MAKING_CHARGE_NEEDS_REFERENCE'
                  : 'OK';
          expect(res).toBe(expected);
          const [itemAfter] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, lines[i].itemId));
          const stockAfter = await ledgerStock(ctx.db, krt, new Date(Date.now() + 60_000));
          if (res === 'OK') {
            model[i] = c.value;
            expect(itemAfter.acquisitionCost).toBe(600_000 + c.value + 10_000);
            // (d) the stock value moves by new − old for a piece in stock; count and weight stay.
            expect(stockAfter).toEqual({ items: stockBefore.items, weightMg: stockBefore.weightMg, cost: stockBefore.cost - itemBefore.acquisitionCost + itemAfter.acquisitionCost });
          } else {
            expect(itemAfter).toEqual(itemBefore);
            expect(stockAfter).toEqual(stockBefore);
          }
        }
        const d = await getPurchase(ctx, gm, po.id);
        // (a) the order's effective making charge is the sum of its pieces' effective making costs (and the model's).
        expect(d.makingChargePaid).toBe(sumInt(d.items.map((x) => x.makingCost)));
        expect(d.items.map((x) => x.makingCost)).toEqual(model);
        expect(d.totalCost - p0.totalCost).toBe(sumInt(model) - total0);
        // (b) sold pieces keep their cost, and so do their sale lines.
        for (const [i, p] of pieces.entries()) {
          if (!p.sold) continue;
          const [it] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, lines[i].itemId));
          expect([it.acquisitionCost, it.makingCharge]).toEqual([600_000 + makings0[i] + 10_000, makings0[i]]);
          const [sl] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, lines[i].itemId));
          expect(sl.acquisitionCost).toBe(600_000 + makings0[i] + 10_000);
        }
        if (pieces[0].sold) expect(await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, lines[0].itemId))).toEqual(soldLines0);
        // (c) the supplier gold debt never changes.
        expect([d.goldDebtMgPure24, d.goldOwedMgPure24]).toEqual([p0.goldDebtMgPure24, p0.goldOwedMgPure24]);
      }),
      RUNS,
    );
  }, 300_000);
});
