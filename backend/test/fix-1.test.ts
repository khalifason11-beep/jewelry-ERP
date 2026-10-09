// FIX-1 (docs/plans/POS-FIXES.md §2, D-fix-1, D-rem4-1): a transfer to another branch has two entry points with one
// rule set: the branch manager's POS cart and the General Manager's "New transfer" on the Transfers screen.
// - the courier's name is required (stored in transfers.courier_name, audited);
// - all or nothing: the piece rows are locked; one piece no longer AVAILABLE refuses the whole transfer (409
//   ITEMS_UNAVAILABLE) and nothing changes;
// - the Idempotency-Key is required and claimed inside the transaction (a refusal consumes none; a replay returns
//   the same transfer);
// - permissions: cashier 403; a branch manager only from their own branch with their own pieces.
// The races (two transfers, or a sale and a transfer, for the same piece) run on real PostgreSQL:
// test/pg/concurrency.test.ts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = request.agent(app) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const taken = new Set<number>();
async function freshItems(code: string, n: number) {
  const rows = await ctx.db
    .select()
    .from(t.jewelryItems)
    .where(and(eq(t.jewelryItems.branchId, await branchId(code)), eq(t.jewelryItems.status, 'AVAILABLE')))
    .orderBy(t.jewelryItems.id);
  const out = rows.filter((i) => !taken.has(i.id)).slice(0, n);
  if (out.length < n) throw new Error(`not enough pieces in ${code}`);
  out.forEach((i) => taken.add(i.id));
  return out;
}
const transferCount = async () => (await ctx.db.select({ n: count() }).from(t.transfers))[0].n;
const statuses = async (ids: number[]) => (await ctx.db.select({ status: t.jewelryItems.status }).from(t.jewelryItems).where(inArray(t.jewelryItems.id, ids))).map((r) => r.status);
const send = (a: Agent, body: object, key: string | null = randomUUID()) => {
  const r = a.post('/api/transfers');
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('the branch manager sends the POS cart', () => {
  it('one transfer holds every piece; courier stored, listed and audited', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const items = await freshItems('KRT', 3);
    const r = await send(bm, { toBranchId: await branchId('OMD'), itemIds: items.map((i) => i.id), courierName: '  عثمان   الطيب ' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'IN_TRANSIT', courierName: 'عثمان الطيب' });
    expect(await statuses(items.map((i) => i.id))).toEqual(['TRANSFERRED', 'TRANSFERRED', 'TRANSFERRED']);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'INVENTORY_TRANSFER')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.entityId).toBe(r.body.number);
    expect(audit.metadata).toMatchObject({ courierName: 'عثمان الطيب', items: items.map((i) => i.code) });
    const list = (await bm.get('/api/transfers')).body as { id: number; courierName: string | null }[];
    expect(list.find((x) => x.id === r.body.id)?.courierName).toBe('عثمان الطيب');
  });

  it('the courier is required (2–80 characters)', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const [p] = await freshItems('KRT', 1);
    const before = await transferCount();
    for (const courierName of [undefined, '', ' x ', 'x'.repeat(81)]) {
      const r = await send(bm, { toBranchId: await branchId('OMD'), itemIds: [p.id], ...(courierName !== undefined ? { courierName } : {}) });
      expect(r.status, JSON.stringify(courierName)).toBe(400);
    }
    expect(await transferCount()).toBe(before);
    expect(await statuses([p.id])).toEqual(['AVAILABLE']);
  });

  it('the Idempotency-Key is required; a replay returns the same transfer', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const items = await freshItems('KRT', 2);
    const body = { toBranchId: await branchId('OMD'), itemIds: items.map((i) => i.id), courierName: 'مندوب' };
    const none = await send(bm, body, null);
    expect(none.status).toBe(428);
    expect(none.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const before = await transferCount();
    const first = await send(bm, body, key);
    const again = await send(bm, body, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await transferCount()).toBe(before + 1);
  });

  it('one piece sold meanwhile: the whole transfer is refused, nothing changes, the key is not consumed', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const [a, b, c] = await freshItems('KRT', 3);
    const sold = await cashier.post('/api/sales').set('Idempotency-Key', randomUUID()).send({ items: [{ itemId: b.id }], paymentMethod: 'CASH' });
    expect(sold.status).toBe(200);
    const before = await transferCount();
    const movesBefore = (await ctx.db.select({ n: count() }).from(t.inventoryMovements).where(inArray(t.inventoryMovements.itemId, [a.id, c.id])))[0].n;
    const key = randomUUID();
    const r = await send(bm, { toBranchId: await branchId('OMD'), itemIds: [a.id, b.id, c.id], courierName: 'مندوب' }, key);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ITEMS_UNAVAILABLE');
    expect(r.body.error.message).toContain(b.code);
    expect(r.body.error.details).toEqual({ unavailable: [{ itemId: b.id, code: b.code, status: 'SOLD' }] });
    expect(await transferCount()).toBe(before);
    expect(await statuses([a.id, c.id])).toEqual(['AVAILABLE', 'AVAILABLE']);
    expect((await ctx.db.select({ n: count() }).from(t.inventoryMovements).where(inArray(t.inventoryMovements.itemId, [a.id, c.id])))[0].n).toBe(movesBefore);
    // The same key is free: the corrected cart goes with it.
    const ok = await send(bm, { toBranchId: await branchId('OMD'), itemIds: [a.id, c.id], courierName: 'مندوب' }, key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('the same piece twice in one transfer is refused', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const [p] = await freshItems('KRT', 1);
    expect((await send(bm, { toBranchId: await branchId('OMD'), itemIds: [p.id, p.id], courierName: 'مندوب' })).status).toBe(400);
  });
});

describe('who may send what', () => {
  it('a cashier is refused (no transfer permission)', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const [p] = await freshItems('KRT', 1);
    const r = await send(cashier, { toBranchId: await branchId('OMD'), itemIds: [p.id], courierName: 'مندوب' });
    expect(r.status).toBe(403);
    expect(await statuses([p.id])).toEqual(['AVAILABLE']);
  });

  it('a branch manager cannot send from another branch, nor another branch’s pieces', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const [omdPiece] = await freshItems('OMD', 1);
    expect((await send(bm, { fromBranchId: await branchId('OMD'), toBranchId: await branchId('BHR'), itemIds: [omdPiece.id], courierName: 'مندوب' })).status).toBe(403);
    expect((await send(bm, { toBranchId: await branchId('BHR'), itemIds: [omdPiece.id], courierName: 'مندوب' })).status).toBe(403);
    expect(await statuses([omdPiece.id])).toEqual(['AVAILABLE']);
  });

  it('the General Manager’s "New transfer": any branch to any branch, same rules (courier, all or nothing)', async () => {
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const items = await freshItems('BHR', 2);
    const body = { fromBranchId: await branchId('BHR'), toBranchId: await branchId('PZU'), itemIds: items.map((i) => i.id) };
    expect((await send(gm, body)).status).toBe(400);
    const r = await send(gm, { ...body, courierName: 'سائق الشركة' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.courierName).toBe('سائق الشركة');
    const again = await send(gm, { ...body, courierName: 'سائق الشركة' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ITEMS_UNAVAILABLE');
  });
});
