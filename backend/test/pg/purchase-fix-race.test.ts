// Real PostgreSQL only (MIS-1, PUR-FIX): a correction of a piece's making cost racing the sale of that piece.
//   The correction locks the piece row (FOR UPDATE) before it reads the status; the sale locks it too. Exactly one order
//   of events happens: either the sale is first (the correction answers 409 PURCHASE_PIECE_SOLD and the sale line holds
//   the OLD cost), or the correction is first (the sale line snapshots the NEW cost). Never a sold piece with a corrected
//   cost, never a sale line that disagrees with the piece. Several rounds, both orders.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { dayKey } from '../../src/core/time';
import { loadActor } from '../../src/modules/sessions/service';
import { createPurchase } from '../../src/modules/purchases/service';
import { correctPurchase } from '../../src/modules/purchases/corrections';
import { createSale } from '../../src/modules/sales/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let cashier: Actor;
let krt: number;
let productId: number;
let supplierId: number;
let today: string;
let fixedTag = true;
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
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

describe('a making-cost correction racing the sale of the piece', () => {
  it('exactly one order of events; the sale line agrees with it', async () => {
    const OLD = 700_000 + 50_000 + 15_000;
    const NEW = 700_000 + 20_000 + 15_000;
    const seen = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const po = await createPurchase(ctx, gm, {
        confirmOpenSupplierDebt: true,
        branchId: krt,
        supplierId,
        lines: [50_000, 40_000].map((m) => ({ productId, grossWeightMg: 4_100, netWeightMg: 4_000, purchaseCost: 700_000, makingCost: m, otherCost: 15_000, ...(fixedTag ? { sellingPrice: 1_500_000 } : {}) })),
        makingChargeReference: `RACE-FIX-${process.pid}-${round}`,
        makingChargeTransferDate: today,
      });
      const [line] = await ctx.db.select().from(t.purchaseItems).where(eq(t.purchaseItems.purchaseId, po.id)).orderBy(t.purchaseItems.id).limit(1);
      // The correction checks the password before its transaction (a slow hash): on odd rounds the sale starts later,
      // so both orders reach the piece lock.
      const fix = correctPurchase(ctx, gm, po.id, { field: 'MAKING_COST', purchaseItemId: line.id, newValue: 20_000, reason: 'race test', confirmPassword: PW });
      if (round % 2) await sleep(5 + round * 15);
      const [f, s] = await Promise.allSettled([fix, createSale(ctx, cashier, { items: [{ itemId: line.itemId }], paymentMethod: 'CASH' })]);
      expect(codeOf(s), `round ${round}: the sale always goes through`).toBe('OK');
      const [sl] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, line.itemId));
      const [item] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, line.itemId));
      const corrections = await ctx.db.select().from(t.purchaseCorrections).where(eq(t.purchaseCorrections.purchaseId, po.id));
      if (codeOf(f) === 'OK') {
        expect([sl.acquisitionCost, item.acquisitionCost, corrections.length], `round ${round}`).toEqual([NEW, NEW, 1]);
        seen.add('correction first');
      } else {
        expect(codeOf(f), `round ${round}`).toBe('PURCHASE_PIECE_SOLD');
        expect([sl.acquisitionCost, item.acquisitionCost, corrections.length], `round ${round}`).toEqual([OLD, OLD, 0]);
        seen.add('sale first');
      }
      expect(item.status).toBe('SOLD');
    }
    expect(seen.size, 'both orders of events happened').toBe(2);
  }, 120_000);
});
