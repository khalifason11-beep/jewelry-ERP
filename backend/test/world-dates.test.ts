// The fixture world is built relative to "now" in the business timezone, so its content depends on the weekday
// and the hour (Friday is the weekly closing day; "today" has activity only after the first minutes). In REM-3 it
// failed on one weekday in seven, and some tests failed right after midnight. This test builds it on 7
// consecutive FIXED days (every weekday once, whatever today is), each just after midnight and in the
// afternoon, and checks the invariants every other test relies on.

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS } from '@jerp/shared';
import { createContext } from '../src/bootstrap';
import { addDays, dayStart } from '../src/core/time';
import { movementSummary } from '../src/modules/reports/metrics';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

const TZ = DEFAULT_SETTINGS.company.timezone;
const FIRST_DAY = '2026-10-05'; // a Monday; the 7 days cover every weekday once
const HOURS: [number, number][] = [
  [0, 25], // just after midnight: no activity "today" yet (the REM-3 failure window)
  [14, 40], // trading hours
];
const CASES = Array.from({ length: 7 }, (_, d) => HOURS.map(([h, m]) => ({ day: addDays(FIRST_DAY, d), h, m }))).flat();

const n = (v: unknown) => Number(v ?? 0);
const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

describe('the fixture world on every weekday and at two hours', () => {
  it.each(CASES)('$day $h:$m (business time)', async ({ day, h, m }) => {
    const now = new Date(dayStart(day, TZ).getTime() + (h * 60 + m) * 60_000);
    const handle = await openTestDatabase();
    try {
      const ctx = createContext(handle);
      const world = await seedWorld(ctx, now);
      const q = async <T,>(query: ReturnType<typeof sql>) => rowsOf<T>(await ctx.db.execute(query));

      // Enough stock for the tests that sell, transfer and race on fixture pieces.
      const avail = await q<{ code: string; n: number }>(sql`SELECT b.code, count(*) AS n FROM jewelry_items i JOIN branches b ON b.id = i.branch_id WHERE i.status = 'AVAILABLE' GROUP BY b.code`);
      const availBy = Object.fromEntries(avail.map((r) => [r.code, n(r.n)]));
      expect(world.availableItems).toBeGreaterThan(100);
      expect(availBy.KRT).toBeGreaterThanOrEqual(40);
      expect(availBy.OMD).toBeGreaterThanOrEqual(10);

      // Nothing happens after "now".
      const [future] = await q<Record<string, unknown>>(sql`SELECT
          (SELECT count(*) FROM sales WHERE created_at > ${now.toISOString()}) AS sales,
          (SELECT count(*) FROM purchases WHERE created_at > ${now.toISOString()}) AS purchases,
          (SELECT count(*) FROM inventory_movements WHERE at > ${now.toISOString()}) AS movements,
          (SELECT count(*) FROM ledger_entries WHERE at > ${now.toISOString()}) AS ledger,
          (SELECT count(*) FROM audit_logs WHERE at > ${now.toISOString()}) AS audit`);
      expect(Object.values(future).map(n)).toEqual([0, 0, 0, 0, 0]);

      // Each sold piece is on exactly one completed sale; a piece in stock is on none.
      const [pieces] = await q<Record<string, unknown>>(sql`SELECT
          (SELECT count(*) FROM jewelry_items i WHERE i.status = 'SOLD'
             AND (SELECT count(*) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.item_id = i.id AND s.status = 'COMPLETED') <> 1) AS sold_wrong,
          (SELECT count(*) FROM jewelry_items i WHERE i.status = 'AVAILABLE'
             AND EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.item_id = i.id AND s.status = 'COMPLETED')) AS available_sold,
          (SELECT count(*) FROM sales WHERE status = 'VOIDED') AS voided`);
      expect([n(pieces.sold_wrong), n(pieces.available_sold)]).toEqual([0, 0]);
      expect(n(pieces.voided)).toBe(2);

      // The money ledger agrees with the sales: a completed sale posted its total, a voided one nets to zero.
      const [money] = await q<Record<string, unknown>>(sql`SELECT count(*) AS wrong FROM sales s
          WHERE coalesce((SELECT sum(amount) FROM ledger_entries e WHERE e.ref_type = 'sale' AND e.ref_id = s.id AND e.event_type IN ('SALE', 'SALE_VOID')), 0)
             <> CASE WHEN s.status = 'COMPLETED' THEN s.total ELSE 0 END`);
      expect(n(money.wrong)).toBe(0);

      // Inventory reconciles per branch: Σ movements = the pieces actually in stock.
      const period = { start: new Date(now.getTime() - 86_400_000), end: new Date(now.getTime() + 60_000) };
      for (const b of await movementSummary(ctx.db, period as Parameters<typeof movementSummary>[1], null)) {
        expect({ branch: b.branchId, ...b.actual }).toEqual({ branch: b.branchId, items: b.closing.items, weightMg: b.closing.weightMg });
      }

      // Gold debts: never negative; the order settled "in full" owes exactly 0. Scrap pools: never negative.
      const [gold] = await q<Record<string, unknown>>(sql`SELECT
          (SELECT count(*) FROM purchases WHERE gold_owed_mg_pure24 < 0) AS negative,
          (SELECT count(*) FROM purchases WHERE gold_owed_mg_pure24 = 0 AND gold_debt_mg_pure24 > 0) AS settled,
          (SELECT count(*) FROM (SELECT branch_id, karat, sum(weight_mg) AS w FROM scrap_weight_entries GROUP BY branch_id, karat) p WHERE p.w < 0) AS pools`);
      expect([n(gold.negative), n(gold.pools)]).toEqual([0, 0]);
      expect(n(gold.settled)).toBeGreaterThanOrEqual(1);

      // One transfer still in transit (the "Confirm receipt" example).
      const [tr] = await q<{ n: number }>(sql`SELECT count(*) AS n FROM transfers WHERE status = 'IN_TRANSIT'`);
      expect(n(tr.n)).toBe(1);
    } finally {
      await handle.close();
    }
  }, 180_000);
});

// FIX-5: the same instant builds the same world, on PGlite and on PostgreSQL. The sales pick a piece by a seeded random
// index into the branch's available pieces; without an ORDER BY, PostgreSQL returned them in heap order and 20 builds of
// one instant gave 4 different worlds (one of them left a branch's drawer short for a test). Three builds must agree on
// every sold piece and every ledger balance.
describe('the fixture world is deterministic', () => {
  it('three builds of the same instant: the same sold pieces and the same balances', async () => {
    const now = new Date(dayStart(addDays(FIRST_DAY, 6), TZ).getTime() + (9 * 60 + 50) * 60_000);
    const prints: string[] = [];
    for (let i = 0; i < 3; i++) {
      const handle = await openTestDatabase();
      try {
        const ctx = createContext(handle);
        await seedWorld(ctx, now);
        const [sold] = rowsOf<{ c: string }>(await ctx.db.execute(sql`SELECT string_agg(i.code, ',' ORDER BY s.number, si.id) AS c FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN jewelry_items i ON i.id = si.item_id`));
        const bals = rowsOf<{ b: string }>(await ctx.db.execute(sql`SELECT string_agg(br.code || ':' || a.kind || '=' || coalesce(x.v, 0), ',' ORDER BY br.code, a.kind) AS b FROM ledger_accounts a JOIN branches br ON br.id = a.branch_id LEFT JOIN (SELECT account_id, sum(amount) AS v FROM ledger_entries GROUP BY account_id) x ON x.account_id = a.id`));
        prints.push(`${sold.c} | ${bals[0].b}`);
      } finally {
        await handle.close();
      }
    }
    expect(prints[0].length).toBeGreaterThan(100);
    expect(prints[1]).toBe(prints[0]);
    expect(prints[2]).toBe(prints[0]);
  }, 300_000);
});
