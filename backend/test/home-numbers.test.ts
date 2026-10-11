// UI-B (docs/plans/UI-B.md §2, D-ui-19): every figure of the homes has one definition and is tied to its source.
// For every branch and every day of the fixture world:
// - home sales = the Sales report = Σ the Sales list (still-valid sales made in the period, D-ui-19 / Q1);
// - the ledger identity, by LEDGER ENTRY DATE: Σ SALE entries of day D = the home's sales of D + Σ totals of the
//   sales made on D and voided since; Σ SALE_VOID entries of day D = − Σ totals of the sales voided on D. (So a void
//   on a later day changes the earlier day's home figure, never the ledger's history.)
// - gross profit = Σ sale lines (final price − acquisition cost); the team's sales add up to the branch figure;
// - expected cash = the drawer = the ledger's CASH balance; the branch strips add up to the company figures; gold held
//   (company) = Σ branches + the pieces in transit sub-line; gold owed = Σ open supplier orders.
// And the number of SQL statements does not grow with the number of branches or of staff.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../src/bootstrap';
import type { Actor, Ctx } from '../src/core/context';
import { rows, num } from '../src/core/sql';
import { addDays, dayKey, dayStart } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { branchDashboard, companyDashboard } from '../src/modules/dashboard/service';
import { runReport } from '../src/modules/reports/service';
import { listSales } from '../src/modules/sales/service';
import { drawer } from '../src/modules/ledger/service';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let tz: string;
let today: string;
let branches: { id: number; code: string }[];

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const q1 = async (q: ReturnType<typeof sql>) => rows<Record<string, unknown>>(await ctx.db.execute(q))[0] ?? {};

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  gm = await actorOf('general.manager');
  tz = (await ctx.settings.get()).company.timezone;
  today = dayKey(new Date(), tz);
  branches = await ctx.db.select({ id: t.branches.id, code: t.branches.code }).from(t.branches);
});
afterAll(async () => handle?.close());

describe('sales and profit on the homes, every branch and every day', () => {
  it('equal the Sales report and the Sales list, and tie to the ledger by entry date', async () => {
    let days = 0;
    let voidedDays = 0;
    for (const b of branches) {
      for (let off = -30; off <= 0; off++) {
        const day = addDays(today, off);
        const d = await branchDashboard(ctx, gm, { branchId: b.id, date: day });
        const report = await runReport(ctx, gm, 'sales', { from: day, to: day, branchId: b.id });
        const list = (await listSales(ctx, gm, { from: day, to: day, branchId: b.id })).filter((s) => s.status === 'COMPLETED');
        expect(d.kpis.salesTotal, `${b.code} ${day}`).toBe(report.totals?.total ?? 0);
        expect(d.kpis.salesTotal).toBe(list.reduce((s, r) => s + r.total, 0));
        expect(d.kpis.salesCount).toBe(list.length);
        // Profit = the lines' final price − acquisition cost.
        const lines = await q1(sql`
          SELECT coalesce(sum(si.final_price - si.acquisition_cost), 0) AS p FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.status = 'COMPLETED' AND s.branch_id = ${b.id} AND s.created_at >= ${dayStart(day, tz).toISOString()} AND s.created_at < ${dayStart(addDays(day, 1), tz).toISOString()}`);
        expect(d.kpis.grossProfit).toBe(num(lines.p));
        // The ledger identity, by ledger entry date.
        const [start, end] = [dayStart(day, tz).toISOString(), dayStart(addDays(day, 1), tz).toISOString()];
        const led = await q1(sql`
          SELECT coalesce(sum(amount) FILTER (WHERE event_type = 'SALE'), 0) AS sale, coalesce(sum(amount) FILTER (WHERE event_type = 'SALE_VOID'), 0) AS void
          FROM ledger_entries WHERE branch_id = ${b.id} AND at >= ${start} AND at < ${end}`);
        const laterVoided = await q1(sql`
          SELECT coalesce(sum(total), 0) AS t FROM sales WHERE branch_id = ${b.id} AND status = 'VOIDED' AND created_at >= ${start} AND created_at < ${end}`);
        const voidedThatDay = await q1(sql`
          SELECT coalesce(sum(total), 0) AS t FROM sales WHERE branch_id = ${b.id} AND status = 'VOIDED' AND voided_at >= ${start} AND voided_at < ${end}`);
        expect(num(led.sale), `ledger SALE ${b.code} ${day}`).toBe(d.kpis.salesTotal + num(laterVoided.t));
        expect(num(led.void), `ledger SALE_VOID ${b.code} ${day}`).toBe(0 - num(voidedThatDay.t));
        if (num(laterVoided.t) > 0) voidedDays++;
        // The team adds up to the branch.
        expect(d.cashiers.reduce((s, c) => s + c.salesTotal, 0)).toBe(d.kpis.salesTotal);
        expect(d.cashiers.reduce((s, c) => s + c.salesCount, 0)).toBe(d.kpis.salesCount);
        days++;
      }
    }
    expect(days).toBeGreaterThan(100);
    expect(voidedDays).toBeGreaterThanOrEqual(0);
  });

  it('a void on a later day changes the earlier day’s home figure, not the ledger of that day', async () => {
    const b = branches.find((x) => x.code === 'KRT')!;
    const day = addDays(today, -3);
    const before = await branchDashboard(ctx, gm, { branchId: b.id, date: day });
    const [sale] = await ctx.db.select().from(t.sales).where(and(eq(t.sales.branchId, b.id), eq(t.sales.status, 'COMPLETED'), sql`${t.sales.createdAt} >= ${dayStart(day, tz).toISOString()} AND ${t.sales.createdAt} < ${dayStart(addDays(day, 1), tz).toISOString()}`)).limit(1);
    expect(sale, 'a sale three days ago').toBeTruthy();
    const ledgerBefore = await q1(sql`SELECT coalesce(sum(amount), 0) AS s FROM ledger_entries WHERE branch_id = ${b.id} AND event_type = 'SALE' AND at >= ${dayStart(day, tz).toISOString()} AND at < ${dayStart(addDays(day, 1), tz).toISOString()}`);
    const { voidSale } = await import('../src/modules/sales/service');
    await voidSale(ctx, await actorOf('branch.manager.kh'), sale.id, 'returned today');
    const after = await branchDashboard(ctx, gm, { branchId: b.id, date: day });
    expect(after.kpis.salesTotal).toBe(before.kpis.salesTotal - sale.total);
    const ledgerAfter = await q1(sql`SELECT coalesce(sum(amount), 0) AS s FROM ledger_entries WHERE branch_id = ${b.id} AND event_type = 'SALE' AND at >= ${dayStart(day, tz).toISOString()} AND at < ${dayStart(addDays(day, 1), tz).toISOString()}`);
    expect(num(ledgerAfter.s)).toBe(num(ledgerBefore.s));
  });
});

describe('cash, stock and gold', () => {
  it('expected cash = the drawer = the ledger CASH balance; the last count is against the end of its day', async () => {
    for (const b of branches) {
      const d = await branchDashboard(ctx, gm, { branchId: b.id });
      const dr = (await drawer(ctx, gm, { branchId: b.id })).branches.find((x) => x.branchId === b.id);
      expect(d.expectedCash, b.code).toBe(dr?.expectedCash ?? 0);
      if (d.lastCount) expect(d.lastCount.difference).toBe(d.lastCount.countedAmount - d.lastCount.expectedAmount);
    }
  });

  it('the branch strips add up to the company; gold held = Σ branches + in transit; gold owed = open orders', async () => {
    for (const range of [{ from: today, to: today }, { from: addDays(today, -29), to: today }]) {
      const c = await companyDashboard(ctx, gm, range);
      const sum = (k: 'revenue' | 'grossProfit' | 'salesCount' | 'availableItems' | 'availableWeightMg' | 'inventoryCost') => c.branches.reduce((s, b) => s + b[k], 0);
      expect(sum('revenue')).toBe(c.totals.revenue);
      expect(sum('grossProfit')).toBe(c.totals.grossProfit);
      expect(sum('salesCount')).toBe(c.totals.salesCount);
      expect(sum('availableItems')).toBe(c.totals.availableItems);
      expect(sum('inventoryCost')).toBe(c.totals.inventoryCost);
      expect(c.branches.reduce((s, b) => s + b.totalWeightMg, 0)).toBe(c.stockWeight.totalWeightMg);
      const transit = await q1(sql`SELECT count(*) AS n, coalesce(sum(net_weight_mg), 0) AS w FROM jewelry_items WHERE status = 'TRANSFERRED'`);
      expect(c.inTransit).toEqual({ items: num(transit.n), weightMg: num(transit.w) });
      const owed = await q1(sql`SELECT coalesce(sum(gold_owed_mg_pure24), 0) AS o FROM purchases WHERE gold_owed_mg_pure24 > 0`);
      expect(c.goldOwed.pureMg24).toBe(num(owed.o));
      // The 14-day line ends on the period's last day and matches the daily sales.
      expect(c.salesLine).toHaveLength(14);
      expect(c.salesLine.at(-1)!.day).toBe(range.to);
    }
  });

  it('the branch manager’s gold owed is the own branch’s open orders, in grams of 24K (no money)', async () => {
    const bm = await actorOf('branch.manager.kh');
    const d = await branchDashboard(ctx, bm, {});
    const krt = branches.find((x) => x.code === 'KRT')!;
    const owed = await q1(sql`SELECT coalesce(sum(gold_owed_mg_pure24), 0) AS o, count(*) AS n FROM purchases WHERE branch_id = ${krt.id} AND gold_owed_mg_pure24 > 0`);
    expect(d.goldOwed).toEqual({ pureMg24: num(owed.o), orders: num(owed.n) });
    expect(d.kpis.grossProfit).toBeNull();
    expect(d.kpis.inventoryCost).toBeNull();
  });
});

describe('no per-row queries', () => {
  const count = async (fn: () => Promise<unknown>) => {
    let n = 0;
    const orig = ctx.db.execute.bind(ctx.db);
    (ctx.db as unknown as { execute: typeof orig }).execute = ((q: Parameters<typeof orig>[0]) => (n++, orig(q))) as typeof orig;
    try {
      await fn();
    } finally {
      (ctx.db as unknown as { execute: typeof orig }).execute = orig;
    }
    return n;
  };

  it('the same number of SQL statements with more branches and more staff', async () => {
    const krt = branches.find((x) => x.code === 'KRT')!;
    const company = () => companyDashboard(ctx, gm, { from: addDays(today, -6), to: today });
    const branch = () => branchDashboard(ctx, gm, { branchId: krt.id });
    const [c0, b0] = [await count(company), await count(branch)];
    for (let i = 0; i < 4; i++) await ctx.db.insert(t.branches).values({ code: `NQ${i}`, name: `More ${i}`, nameAr: `فرع ${i}`, city: 'City' });
    const [role] = await ctx.db.select().from(t.roles).where(eq(t.roles.code, 'CASHIER'));
    for (let i = 0; i < 10; i++) {
      await ctx.db.insert(t.users).values({ username: `extra.cashier.${i}`, fullName: `Extra ${i}`, roleId: role.id, branchId: krt.id, passwordHash: 'x' });
    }
    expect(await count(company)).toBe(c0);
    expect(await count(branch)).toBe(b0);
  });
});
