// Real PostgreSQL only: concurrent supplier settlements of one purchase order. The order row is
// locked FOR UPDATE and the branch pool is serialised by an advisory lock, so parallel visits can
// never take gold_owed below 0 or the pool below 0, and every successful settlement is applied once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { pureGoldMg, sumInt } from '@jerp/shared';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createPurchase } from '../../src/modules/purchases/service';
import { buyScrap, poolBalances } from '../../src/modules/scrap/service';
import { settleWithScrap } from '../../src/modules/supplier-settlements/service';
import { seedDemo } from '../../src/seed/demo';
import { DEMO_PASSWORDS } from '../../src/seed/catalog';
import { openTestDatabase, PG_MODE } from '../helpers';

const ROUNDS = 5;
let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const pool = async (branch: number, karat: number) => (await poolBalances(ctx.db, branch, karat))[0]?.weightMg ?? 0;
const winners = <T>(rs: PromiseSettledResult<T>[]) => rs.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled');
const reasons = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.key ?? r.reason?.message ?? r.reason));

async function order(bm: Actor, branch: number, net: number) {
  const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).limit(1);
  return createPurchase(ctx, bm, { branchId: branch, lines: [{ productId: p.id, grossWeightMg: net, netWeightMg: net, purchaseCost: 1_000_000, makingCost: 0, otherCost: 0, sellingPrice: 1_500_000 }] });
}

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedDemo(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('parallel supplier settlements of one order (row lock)', () => {
  it('two visits each worth 60% of the debt: exactly one wins, the other is refused, nothing goes below 0', async () => {
    const bm = await actorOf('branch.manager.kh');
    const krt = await branchId('KRT');
    for (let round = 0; round < ROUNDS; round++) {
      const po = await order(bm, krt, 9_600); // owes 8400 mg pure
      const owed = pureGoldMg(9_600, 21);
      const part = Math.round(owed * 0.6); // 24K weight = pure weight
      await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 24, grossWeightMg: part * 2, netWeightMg: part * 2, paymentMethod: 'CASH' });
      const poolBefore = await pool(krt, 24);
      const rs = await Promise.allSettled([1, 2].map(() => settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: part })));
      expect(winners(rs)).toHaveLength(1);
      expect(reasons(rs)).toEqual(['This weight is more than the gold still owed on this purchase']);
      const [row] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, po.id));
      expect(row.goldOwedMgPure24).toBe(owed - part);
      expect(await pool(krt, 24)).toBe(poolBefore - part);
      expect(await ctx.db.select().from(t.supplierSettlements).where(eq(t.supplierSettlements.purchaseId, po.id))).toHaveLength(1);
    }
  });

  it('many small parallel visits: owed = debt − Σ successful settlements, never below 0; the pool drops by exactly that weight', async () => {
    const bm = await actorOf('branch.manager.omd');
    const omd = await branchId('OMD');
    for (let round = 0; round < ROUNDS; round++) {
      const po = await order(bm, omd, 8_000); // owes 7000 mg pure
      const owed = pureGoldMg(8_000, 21);
      await buyScrap(ctx, bm, { branchId: omd, kind: 'BROKEN', karat: 24, grossWeightMg: 20_000, netWeightMg: 20_000, paymentMethod: 'CASH' });
      const poolBefore = await pool(omd, 24);
      const rs = await Promise.allSettled(Array.from({ length: 10 }, () => settleWithScrap(ctx, bm, po.id, { karat: 24, weightMg: 1_000 })));
      const ok = winners(rs);
      expect(ok.length).toBe(7);
      const [row] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.id, po.id));
      expect(row.goldOwedMgPure24).toBe(owed - sumInt(ok.map((r) => r.value.settledPureMg24)));
      expect(row.goldOwedMgPure24).toBe(0);
      expect(await pool(omd, 24)).toBe(poolBefore - 7_000);
    }
  });

  it('two orders drawing on one small pool: the pool never goes below 0', async () => {
    const bm = await actorOf('branch.manager.bhr');
    const bhr = await branchId('BHR');
    const a = await order(bm, bhr, 20_000);
    const b = await order(bm, bhr, 20_000);
    const have = await pool(bhr, 22);
    await buyScrap(ctx, bm, { branchId: bhr, kind: 'BROKEN', karat: 22, grossWeightMg: 5_000 - have, netWeightMg: 5_000 - have, paymentMethod: 'CASH' });
    expect(await pool(bhr, 22)).toBe(5_000);
    const rs = await Promise.allSettled([a, b].map((po) => settleWithScrap(ctx, bm, po.id, { karat: 22, weightMg: 4_000 })));
    expect(winners(rs)).toHaveLength(1);
    expect(reasons(rs)).toEqual(['Not enough {karat}K broken scrap in the pool']);
    expect(await pool(bhr, 22)).toBe(1_000);
  });

  it('parallel retries with one idempotency key settle once', async () => {
    const krt = await branchId('KRT');
    const bm = await actorOf('branch.manager.kh');
    const po = await order(bm, krt, 6_000);
    await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 2_000, netWeightMg: 2_000, paymentMethod: 'CASH' });
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ username: 'branch.manager.kh', password: DEMO_PASSWORDS.BRANCH_MANAGER });
    agent.set('x-csrf-token', login.body.csrfToken);
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 4 }, () => agent.post(`/api/purchases/${po.id}/settlements`).set('Idempotency-Key', key).send({ karat: 21, weightMg: 2_000 })));
    expect(res.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of res) expect([200, 409]).toContain(r.status);
    expect(await ctx.db.select().from(t.supplierSettlements).where(eq(t.supplierSettlements.purchaseId, po.id))).toHaveLength(1);
  });
});
