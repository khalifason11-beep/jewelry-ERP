// Real PostgreSQL only: truly parallel requests over a connection pool (PGlite has one connection,
// so it cannot show these races). Each race is repeated several rounds to make interleaving likely.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, count, eq, inArray } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createSale } from '../../src/modules/sales/service';
import { createTransfer, receiveTransfer } from '../../src/modules/transfers/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
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
const settled = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);
const winners = <T>(rs: PromiseSettledResult<T>[]) => rs.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled');
const reasons = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.key ?? r.reason?.message ?? r.reason));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('parallel double-sell of the same item', () => {
  it('exactly one sale wins; one SALE movement; the loser changes nothing', async () => {
    const c1 = await actorOf('cashier.kh.01');
    const c2 = await actorOf('cashier.kh.02');
    for (let round = 0; round < ROUNDS; round++) {
      const [item] = await freshItems('KRT', 1);
      // A piece back in stock after a voided sale already has a sale line and a SALE movement: count only new ones.
      const linesOf = async () => (await ctx.db.select({ n: count() }).from(t.saleItems).where(eq(t.saleItems.itemId, item.id)))[0].n;
      const movesOf = async () => (await ctx.db.select({ n: count() }).from(t.inventoryMovements).where(and(eq(t.inventoryMovements.itemId, item.id), eq(t.inventoryMovements.type, 'SALE'))))[0].n;
      const [linesBefore, movesBefore] = [await linesOf(), await movesOf()];
      const rs = await settled([
        createSale(ctx, c1, { items: [{ itemId: item.id }], paymentMethod: 'CASH' }),
        createSale(ctx, c2, { items: [{ itemId: item.id }], paymentMethod: 'BANK_TRANSFER' }),
        createSale(ctx, c1, { items: [{ itemId: item.id }], paymentMethod: 'CASH' }),
      ]);
      expect(winners(rs), `round ${round}: ${reasons(rs)}`).toHaveLength(1);
      for (const r of reasons(rs)) expect(r).toMatch(/cannot be sold/);
      expect(await linesOf()).toBe(linesBefore + 1);
      expect(await movesOf()).toBe(movesBefore + 1);
      const [after] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, item.id));
      expect(after.status).toBe('SOLD');
    }
  });

  it('overlapping carts locked in opposite order never deadlock', async () => {
    const c1 = await actorOf('cashier.kh.01');
    const c2 = await actorOf('cashier.kh.02');
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await freshItems('KRT', 2);
      const rs = await settled([
        createSale(ctx, c1, { items: [{ itemId: a.id }, { itemId: b.id }], paymentMethod: 'CASH' }),
        createSale(ctx, c2, { items: [{ itemId: b.id }, { itemId: a.id }], paymentMethod: 'CASH' }),
      ]);
      expect(reasons(rs).join()).not.toMatch(/deadlock/i);
      expect(winners(rs)).toHaveLength(1);
    }
  });

  it('parallel sales of different items all succeed with distinct, gap-free numbers', async () => {
    const c1 = await actorOf('cashier.kh.01');
    const items = await freshItems('KRT', 8);
    const rs = await settled(items.map((i) => createSale(ctx, c1, { items: [{ itemId: i.id }], paymentMethod: 'CASH' })));
    const ok = winners(rs).map((w) => w.value.number);
    expect(ok, reasons(rs).join()).toHaveLength(8);
    const nums = ok.map((n) => Number(n.split('-').pop())).sort((x, y) => x - y);
    expect(new Set(nums).size).toBe(8);
    expect(nums[7] - nums[0]).toBe(7);
  });
});

describe('parallel double-receive of a transfer (M-4)', () => {
  it('exactly one receive wins; one TRANSFER_IN per item', async () => {
    const bmOmd = await actorOf('branch.manager.omd');
    const bmKrt = await actorOf('branch.manager.kh');
    for (let round = 0; round < ROUNDS; round++) {
      const items = await freshItems('OMD', 2);
      const tr = await createTransfer(ctx, bmOmd, { toBranchId: await branchId('KRT'), itemIds: items.map((i) => i.id) });
      const rs = await settled([receiveTransfer(ctx, bmKrt, tr.id), receiveTransfer(ctx, bmKrt, tr.id), receiveTransfer(ctx, bmKrt, tr.id)]);
      expect(winners(rs), `round ${round}: ${reasons(rs)}`).toHaveLength(1);
      for (const r of reasons(rs)) expect(r).toMatch(/Transfer is \{status\}/);
      const ins = await ctx.db
        .select({ n: count() })
        .from(t.inventoryMovements)
        .where(and(inArray(t.inventoryMovements.itemId, items.map((i) => i.id)), eq(t.inventoryMovements.type, 'TRANSFER_IN')));
      expect(ins[0].n).toBe(2);
      const [after] = await ctx.db.select().from(t.transfers).where(eq(t.transfers.id, tr.id));
      expect(after.status).toBe('RECEIVED');
      const audits = await ctx.db
        .select({ n: count() })
        .from(t.auditLogs)
        .where(and(eq(t.auditLogs.action, 'INVENTORY_TRANSFER_RECEIVED'), eq(t.auditLogs.entityId, tr.number)));
      expect(audits[0].n).toBe(1);
    }
  });
});

describe('idempotency under real parallelism', () => {
  it('five simultaneous submits with one key create exactly one sale', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ username: 'cashier.kh.02', password: DEMO_PASSWORDS.CASHIER });
    agent.set('x-csrf-token', res.body.csrfToken);
    const [item] = await freshItems('KRT', 1);
    const key = `dbl-${crypto.randomUUID()}`;
    const before = (await ctx.db.select({ n: count() }).from(t.sales))[0].n;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => agent.post('/api/sales').set('Idempotency-Key', key).send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' })));
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const ids = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect((await ctx.db.select({ n: count() }).from(t.sales))[0].n).toBe(before + 1);
    const replay = await agent.post('/api/sales').set('Idempotency-Key', key).send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });
});
