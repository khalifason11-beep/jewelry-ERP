// Real PostgreSQL only: parallel reprints of one invoice over a connection pool. The counter is a
// single UPDATE … SET reprint_count = reprint_count + 1, so no reprint is lost and every copy number
// is handed out exactly once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createSale } from '../../src/modules/sales/service';
import { printSale } from '../../src/modules/print/service';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
});
afterAll(async () => handle?.close());

describe('parallel reprints', () => {
  it('40 parallel reprints: counter = 40, copy numbers 1..40 each once, 40 audit entries', async () => {
    const [b] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT'));
    const [item] = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, b.id), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(1);
    const sale = await createSale(ctx, await actorOf('cashier.kh.01'), { items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    const managers = [await actorOf('branch.manager.kh'), await actorOf('general.manager')];
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => printSale(ctx, managers[i % 2], sale.id)));
    const ns = results.map((r) => r.document.copy!.n).sort((x, y) => x - y);
    expect(ns).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect((await ctx.db.select().from(t.sales).where(eq(t.sales.id, sale.id)))[0].reprintCount).toBe(40);
    const audits = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'INVOICE_REPRINTED'), eq(t.auditLogs.entityId, sale.number)));
    expect(audits).toHaveLength(40);
  });
});
