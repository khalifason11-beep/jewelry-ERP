// Real PostgreSQL only (WSL-1, D-wsl1-3): grains sold from one branch's broken-scrap pool at the same time. The sale
// takes the branch's pool lock and reads the karat's balance again under it, so:
//   * two sales of the last grains at once: exactly one succeeds, the other is refused 409 SCRAP_POOL_SHORT; the pool
//     ends at 0, never below;
//   * a grain sale racing a supplier settlement for the same last weight: exactly one wins;
//   * a void racing a new grain sale: both land, the pool is exactly what the movements say.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { grainLinePrice } from '@jerp/shared';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createUser } from '../../src/modules/users/service';
import { createPurchase } from '../../src/modules/purchases/service';
import { buyScrap, poolBalances } from '../../src/modules/scrap/service';
import { settleWithScrap } from '../../src/modules/supplier-settlements/service';
import { createSale, voidSale } from '../../src/modules/sales/service';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

const ROUNDS = 6;
const RATE = 123_456;
let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let n = 0;
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));
const pool = async (branch: number) => (await poolBalances(ctx.db, branch, 21))[0]?.weightMg ?? 0;

async function branchWithPool(mg: number) {
  n += 1;
  const [b] = await ctx.db.insert(t.branches).values({ code: `WR${n}`, name: `Grains race ${n}`, nameAr: `[اختبار] سباق الحبات ${n}`, city: 'X' }).returning();
  const users = await Promise.all(
    ['a', 'b'].map((x) => createUser(ctx, gm, { username: `wsl1.race.${n}.${x}`, fullName: `[Test] Race cashier ${n}${x}`, roleCode: 'CASHIER', branchId: b.id })),
  );
  const bmUser = await createUser(ctx, gm, { username: `wsl1.race.${n}.bm`, fullName: `[Test] Race manager ${n}`, roleCode: 'BRANCH_MANAGER', branchId: b.id });
  const [c1, c2] = await Promise.all(users.map(async (u) => (await loadActor(ctx.db, u.id, null))!));
  const bm = (await loadActor(ctx.db, bmUser.id, null))!;
  await buyScrap(ctx, bm, { branchId: b.id, kind: 'BROKEN', karat: 21, grossWeightMg: mg, netWeightMg: mg, paymentMethod: 'BANK_TRANSFER', bankReference: `WR-${n}` });
  return { branchId: b.id, c1, c2, bm };
}
const sell = (actor: Actor, branchId: number, grains: number) =>
  createSale(ctx, actor, { branchId, items: [], scrapLines: [{ karat: 21, grains, listPrice: grainLinePrice(grains, RATE) }], paymentMethod: 'CASH' });

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-11-05T09:00:00Z'));
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  gm = (await loadActor(ctx.db, u.id, null))!;
  await ctx.db.insert(t.goldRates).values({ karat: 21, kind: 'NEW', pricePerGram: RATE, effectiveAt: new Date('2026-11-05T10:00:00Z') });
}, 120_000);
afterAll(async () => handle?.close());

describe('grains sold at the same time', () => {
  it('two sales of the last 5 grains: exactly one succeeds; the pool ends at 0, never below', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { branchId, c1, c2 } = await branchWithPool(500);
      const codes = (await Promise.allSettled([sell(c1, branchId, 5), sell(c2, branchId, 5)])).map(codeOf).sort();
      expect(codes, `round ${round}`).toEqual(['OK', 'SCRAP_POOL_SHORT']);
      expect(await pool(branchId)).toBe(0);
      const sales = await ctx.db.select().from(t.sales).where(eq(t.sales.branchId, branchId));
      expect(sales).toHaveLength(1);
    }
  }, 240_000);

  it('a grain sale racing a supplier settlement for the same last weight: exactly one wins', async () => {
    const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).orderBy(asc(t.products.id)).limit(1);
    const [s] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    for (let round = 0; round < ROUNDS; round++) {
      const { branchId, c1, bm } = await branchWithPool(800);
      const po = await createPurchase(ctx, gm, { branchId, supplierId: s.id, confirmOpenSupplierDebt: true, lines: [{ productId: p.id, grossWeightMg: 9_000, netWeightMg: 9_000, purchaseCost: 1_000_000, makingCost: 0, otherCost: 0, sellingPrice: 1_500_000 }] });
      const codes = (await Promise.allSettled([sell(c1, branchId, 8), settleWithScrap(ctx, bm, po.id, { karat: 21, weightMg: 800 })])).map(codeOf);
      expect(codes.filter((c) => c === 'OK'), `round ${round}: ${codes.join('/')}`).toHaveLength(1);
      expect(await pool(branchId)).toBe(0);
    }
  }, 240_000);

  it('a void racing a new grain sale: both land; the pool is exactly the movements', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { branchId, c1, c2, bm } = await branchWithPool(1_000);
      const first = await sell(c1, branchId, 6); // 400 mg left
      const codes = (await Promise.allSettled([voidSale(ctx, bm, first.id, 'سباق الإلغاء'), sell(c2, branchId, 4)])).map(codeOf);
      expect(codes, `round ${round}`).toEqual(['OK', 'OK']);
      expect(await pool(branchId)).toBe(600);
    }
  }, 240_000);
});
