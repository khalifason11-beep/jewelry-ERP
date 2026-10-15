// SAFE-1: a deploy restart never cuts a money write in half. Real PostgreSQL only (test/pg).
//   * SIGKILL in the middle of a burst of sales (the worst case: no shutdown code runs at all): every sale that exists
//     is complete (its line, the piece SOLD, the movement, the ledger entry equal to its total), and no piece is SOLD
//     without its sale. A transaction cut by the kill rolls back as a whole.
//   * SIGTERM during a burst: the server stops accepting, lets running requests finish, closes the pool and exits 0;
//     every answered sale is complete, no request gets a 500, and the same invariants hold.
// The server runs as a real child process (`tsx src/server.ts`) on the test database.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import type { Ctx } from '../../src/core/context';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';
import { startServer as startServerProcess } from './server-process';

let handle: DatabaseHandle & { url?: string };
let ctx: Ctx;

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
}, 120_000);
afterAll(async () => handle?.close());

const startServer = () => startServerProcess(handle.url!, { SHUTDOWN_GRACE_MS: '10000' });

async function cashierSession(base: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cashier.kh.01', password: DEMO_PASSWORDS.CASHIER }) });
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('jerp_session='))!;
  expect(cookie).toBeTruthy();
  const { csrfToken } = (await r.json()) as { csrfToken: string };
  return { cookie, csrfToken };
}

async function availableItems(n: number) {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'cashier.kh.01'));
  const rows = await ctx.db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, u.branchId!), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(n);
  return rows.map((r) => r.id);
}

/** A burst of one-piece cash sales; each resolves to the HTTP status, or 'cut' when the connection was dropped. */
function burst(base: string, s: { cookie: string; csrfToken: string }, items: number[]) {
  return items.map((itemId) =>
    fetch(`${base}/api/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrfToken, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ items: [{ itemId }], paymentMethod: 'CASH' }),
    }).then((r) => r.status, () => 'cut' as const),
  );
}

/** The invariants of a complete sale, over the whole database. */
async function partialSales() {
  const q = async (s: string) => Number(((await ctx.db.execute(sql.raw(s))) as unknown as { rows: { n: string }[] }).rows[0].n);
  return {
    salesWithoutLines: await q(`SELECT count(*) AS n FROM sales s WHERE NOT EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id)`),
    completedSalesWithUnsoldPieces: await q(`SELECT count(*) AS n FROM sales s JOIN sale_items i ON i.sale_id = s.id JOIN jewelry_items j ON j.id = i.item_id WHERE s.status = 'COMPLETED' AND j.status <> 'SOLD'`),
    salesWhoseLedgerDiffers: await q(`SELECT count(*) AS n FROM sales s WHERE s.status = 'COMPLETED' AND coalesce((SELECT sum(e.amount) FROM ledger_entries e WHERE e.ref_type = 'sale' AND e.ref_id = s.id AND e.event_type = 'SALE'), 0) <> s.total`),
    soldPiecesWithoutSale: await q(`SELECT count(*) AS n FROM jewelry_items j WHERE j.status = 'SOLD' AND NOT EXISTS (SELECT 1 FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE i.item_id = j.id AND s.status = 'COMPLETED')`),
    salesWithoutMovement: await q(`SELECT count(*) AS n FROM sales s JOIN sale_items i ON i.sale_id = s.id WHERE s.status = 'COMPLETED' AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.item_id = i.item_id AND m.type = 'SALE')`),
  };
}
const NONE = { salesWithoutLines: 0, completedSalesWithUnsoldPieces: 0, salesWhoseLedgerDiffers: 0, soldPiecesWithoutSale: 0, salesWithoutMovement: 0 };

describe('a restart never cuts a money write in half', () => {
  it('the fixture is consistent to start with', async () => {
    expect(await partialSales()).toEqual(NONE);
  });

  it('SIGKILL during a burst of sales: whatever was recorded is complete', async () => {
    const srv = await startServer();
    const s = await cashierSession(srv.base);
    const before = (await ctx.db.select({ n: sql<number>`count(*)` }).from(t.sales))[0].n;
    const results = burst(srv.base, s, await availableItems(12));
    await new Promise((r) => setTimeout(r, 60));
    srv.child.kill('SIGKILL');
    await srv.exited;
    const statuses = await Promise.all(results);
    expect(statuses.some((x) => x === 'cut' || x === 200), JSON.stringify(statuses)).toBe(true);
    expect(statuses.filter((x) => typeof x === 'number' && x >= 500)).toEqual([]);
    expect(await partialSales()).toEqual(NONE);
    const after = (await ctx.db.select({ n: sql<number>`count(*)` }).from(t.sales))[0].n;
    expect(Number(after) - Number(before)).toBeGreaterThanOrEqual(statuses.filter((x) => x === 200).length);
  }, 120_000);

  it('SIGTERM during a burst: running requests finish, the process exits 0, nothing partial', async () => {
    const srv = await startServer();
    const s = await cashierSession(srv.base);
    const results = burst(srv.base, s, await availableItems(12));
    await new Promise((r) => setTimeout(r, 30));
    srv.child.kill('SIGTERM');
    expect(await srv.exited).toBe(0);
    const statuses = await Promise.all(results);
    // A request is either answered normally or was never accepted (connection refused): never a 500, never half done.
    expect(statuses.filter((x) => typeof x === 'number' && x >= 500)).toEqual([]);
    expect(statuses.filter((x) => x === 200).length, JSON.stringify(statuses)).toBeGreaterThan(0);
    expect(await partialSales()).toEqual(NONE);
  }, 120_000);
});
