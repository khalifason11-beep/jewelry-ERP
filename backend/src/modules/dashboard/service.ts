import { sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requirePerm } from '../../authz';
import { badRequest } from '../../core/errors';
import { rows, num } from '../../core/sql';
import { addDays, dayKey, dayRange, dayStart, eachDay } from '../../core/time';
import { branchMetrics, movementSummary, sumMetrics, type Period } from '../reports/metrics';
import { emptyStockWeight, stockWeight } from '../stock/weight';
import { cashBalance } from '../ledger/service';

export async function periodFor(ctx: Ctx, from?: string, to?: string): Promise<Period> {
  const { company } = await ctx.settings.get();
  const today = dayKey(new Date(), company.timezone);
  const fromKey = from ?? today;
  const toKey = to ?? fromKey;
  if (fromKey > toKey) throw badRequest('Invalid date range');
  const r = dayRange(fromKey, toKey, company.timezone);
  return { ...r, fromKey, toKey };
}

/** Operational dashboard for one branch and one business day. */
export async function branchDashboard(ctx: Ctx, actor: Actor, q: { branchId?: number; date?: string }) {
  requirePerm(actor, 'dashboard.branch');
  const branchId = branchScope(actor, q.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  const { company } = await ctx.settings.get();
  const period = await periodFor(ctx, q.date, q.date);
  const [m] = [...(await branchMetrics(ctx.db, period, branchId)).values()];
  const [movement] = await movementSummary(ctx.db, period, branchId);

  // Month-to-date for context.
  const mtdFrom = period.fromKey.slice(0, 8) + '01';
  const mtd = [...(await branchMetrics(ctx.db, await periodFor(ctx, mtdFrom, period.toKey), branchId)).values()][0];

  const tz = company.timezone;
  const iso = (d: Date) => d.toISOString();
  const trendFrom = addDays(period.toKey, -13);
  const trendRange = dayRange(trendFrom, period.toKey, tz);
  const [trendR, hourlyR, staffR, sellersR, presenceR, cashNow, countR, owedR] = await Promise.all([
    ctx.db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS n, coalesce(sum(total),0) AS revenue, coalesce(sum(total - cost_total),0) AS profit
      FROM sales WHERE status='COMPLETED' AND branch_id = ${branchId} AND created_at >= ${iso(trendRange.start)} AND created_at < ${iso(trendRange.end)}
      GROUP BY 1`),
    ctx.db.execute(sql`
      SELECT extract(hour FROM created_at AT TIME ZONE ${tz})::int AS h, count(*) AS n, coalesce(sum(total),0) AS revenue
      FROM sales WHERE status='COMPLETED' AND branch_id = ${branchId} AND created_at >= ${iso(period.start)} AND created_at < ${iso(period.end)}
      GROUP BY 1 ORDER BY 1`),
    // UI-B (D-ui-21): the team table from grouped queries (it used to run six sub-queries per person).
    ctx.db.execute(sql`
      SELECT u.id, u.full_name, u.full_name_ar, u.username, r.code AS role, r.rank
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.branch_id = ${branchId} AND u.status = 'ACTIVE'`),
    // Sellers of the day (grouped by the sale's seller, so a seller who left the branch still counts).
    ctx.db.execute(sql`
      SELECT s.cashier_id AS id, u.full_name, u.full_name_ar, u.username, r.code AS role, r.rank,
             count(*) FILTER (WHERE s.status = 'COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}) AS sales_count,
             coalesce(sum(s.total) FILTER (WHERE s.status = 'COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}), 0) AS sales_total,
             count(*) FILTER (WHERE s.status = 'VOIDED' AND s.voided_at >= ${iso(period.start)} AND s.voided_at < ${iso(period.end)}) AS voided
      FROM sales s JOIN users u ON u.id = s.cashier_id JOIN roles r ON r.id = u.role_id
      WHERE s.branch_id = ${branchId}
        AND ((s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}) OR (s.voided_at >= ${iso(period.start)} AND s.voided_at < ${iso(period.end)}))
      GROUP BY s.cashier_id, u.full_name, u.full_name_ar, u.username, r.code, r.rank`),
    ctx.db.execute(sql`
      SELECT se.user_id AS id, max(se.last_activity_at) AS last_activity, count(*) FILTER (WHERE se.status = 'ACTIVE') AS live_sessions,
             min(se.login_at) FILTER (WHERE se.login_at >= ${iso(period.start)} AND se.login_at < ${iso(period.end)}) AS first_login
      FROM sessions se JOIN users u ON u.id = se.user_id
      WHERE u.branch_id = ${branchId} OR se.user_id IN (SELECT DISTINCT cashier_id FROM sales WHERE branch_id = ${branchId} AND created_at >= ${iso(period.start)} AND created_at < ${iso(period.end)})
      GROUP BY se.user_id`),
    // Expected cash now (the ledger's CASH balance, as Cash) and the latest count (UI-B §2.2).
    cashBalance(ctx.db, branchId),
    ctx.db.execute(sql`
      SELECT business_day::text AS day, counted_amount, expected_amount, at FROM cash_counts
      WHERE branch_id = ${branchId} ORDER BY business_day DESC, at DESC, id DESC LIMIT 1`),
    // Gold owed to suppliers by this branch's open orders (24K mg; weights only, D-4-16).
    ctx.db.execute(sql`
      SELECT coalesce(sum(gold_owed_mg_pure24), 0) AS owed, count(*) AS orders FROM purchases
      WHERE branch_id = ${branchId} AND gold_owed_mg_pure24 > 0`),
  ]);

  const trendMap = new Map(rows<Record<string, unknown>>(trendR).map((r) => [String(r.day), r]));
  // The latest count against the expected cash at the end of its business day (the reconciliation's definition).
  const [count] = rows<Record<string, unknown>>(countR);
  const lastCount = count
    ? await (async () => {
        const day = String(count.day);
        const expected = await cashBalance(ctx.db, branchId, dayStart(addDays(day, 1), tz));
        return { day, countedAmount: num(count.counted_amount), expectedAmount: expected, difference: num(count.counted_amount) - expected, at: count.at };
      })()
    : null;

  const showProfit = can(actor, 'profit.view');
  // Gold held now (D-4-3): pieces + the broken-scrap pool, raw by karat and as 24K.
  const stock = (await stockWeight(ctx.db, branchId)).byBranch.get(branchId) ?? emptyStockWeight();
  return {
    branchId,
    date: period.fromKey,
    stockWeight: stock,
    kpis: {
      salesTotal: m.revenue,
      salesCount: m.salesCount,
      itemsSold: m.itemsSold,
      purchasesCost: m.purchasesCost,
      purchasesCount: m.purchasesCount,
      grossProfit: showProfit ? m.grossProfit : null,
      availableItems: m.availableItems,
      availableWeightMg: m.availableWeightMg,
      inventoryCost: showProfit ? m.inventoryCost : null,
    },
    mtd: {
      revenue: mtd.revenue,
      grossProfit: showProfit ? mtd.grossProfit : null,
      salesCount: mtd.salesCount,
    },
    movement,
    trend: eachDay(trendFrom, period.toKey).map((d) => {
      const r = trendMap.get(d);
      return { day: d, sales: num(r?.n), revenue: num(r?.revenue), profit: showProfit ? num(r?.profit) : null };
    }),
    hourly: rows<Record<string, unknown>>(hourlyR).map((r) => ({ hour: num(r.h), sales: num(r.n), revenue: num(r.revenue) })),
    cashiers: team(rows<Record<string, unknown>>(staffR), rows<Record<string, unknown>>(sellersR), rows<Record<string, unknown>>(presenceR)),
    // UI-B: the branch manager's level-1 figures (no cost: these are cash, weights and counts).
    expectedCash: cashNow,
    lastCount,
    goldOwed: (() => {
      const [o] = rows<Record<string, unknown>>(owedR);
      return { pureMg24: num(o?.owed), orders: num(o?.orders) };
    })(),
  };
}

/** The team of the day: the branch's active staff plus anyone who sold or voided there; one row each. */
function team(staff: Record<string, unknown>[], sellers: Record<string, unknown>[], presence: Record<string, unknown>[]) {
  const byId = new Map<number, Record<string, unknown>>();
  for (const s of staff) byId.set(num(s.id), { ...s, sales_count: 0, sales_total: 0, voided: 0 });
  for (const s of sellers) byId.set(num(s.id), { ...(byId.get(num(s.id)) ?? {}), ...s });
  const p = new Map(presence.map((r) => [num(r.id), r]));
  return [...byId.values()]
    .sort((a, z) => num(a.rank) - num(z.rank) || String(a.full_name).localeCompare(String(z.full_name)))
    .map((r) => ({
      userId: num(r.id),
      fullName: String(r.full_name),
      fullNameAr: (r.full_name_ar as string | null) ?? null,
      username: String(r.username),
      role: String(r.role),
      salesCount: num(r.sales_count),
      salesTotal: num(r.sales_total),
      voided: num(r.voided),
      lastActivity: p.get(num(r.id))?.last_activity ?? null,
      liveSessions: num(p.get(num(r.id))?.live_sessions),
      firstLogin: p.get(num(r.id))?.first_login ?? null,
    }));
}

/** Executive dashboard across all branches. */
export async function companyDashboard(ctx: Ctx, actor: Actor, q: { from?: string; to?: string }) {
  requirePerm(actor, 'dashboard.company', 'scope.all_branches');
  const { company } = await ctx.settings.get();
  const today = dayKey(new Date(), company.timezone);
  const period = await periodFor(ctx, q.from ?? today.slice(0, 8) + '01', q.to ?? today);
  const metrics = await branchMetrics(ctx.db, period, null);
  const branches = await ctx.db.select().from(t.branches).orderBy(t.branches.id);
  const stock = await stockWeight(ctx.db, null);
  const list = branches.map((b) => {
    const sw = stock.byBranch.get(b.id) ?? emptyStockWeight();
    return { ...metrics.get(b.id)!, code: b.code, name: b.name, nameAr: b.nameAr, city: b.city, brokenScrapWeightMg: sw.brokenScrap.weightMg, totalWeightMg: sw.totalWeightMg, totalPureMg24: sw.totalPureMg24 };
  });
  const totals = sumMetrics(list.map(({ code: _c, name: _n, nameAr: _a, city: _ci, brokenScrapWeightMg: _b, totalWeightMg: _w, totalPureMg24: _p, ...m }) => m));

  const tz = company.timezone;
  const iso = (d: Date) => d.toISOString();
  const trendR = await ctx.db.execute(sql`
    SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, branch_id, coalesce(sum(total),0) AS revenue, coalesce(sum(total-cost_total),0) AS profit
    FROM sales WHERE status='COMPLETED' AND created_at >= ${iso(period.start)} AND created_at < ${iso(period.end)}
    GROUP BY 1, 2`);
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows<Record<string, unknown>>(trendR)) {
    const d = String(r.day);
    const e = byDay.get(d) ?? {};
    e[`b${r.branch_id}`] = num(r.revenue);
    e.total = (e.total ?? 0) + num(r.revenue);
    e.profit = (e.profit ?? 0) + num(r.profit);
    byDay.set(d, e);
  }
  const invR = await ctx.db.execute(sql`
    SELECT karat, count(*) AS items, coalesce(sum(net_weight_mg),0) AS weight, coalesce(sum(acquisition_cost),0) AS cost
    FROM jewelry_items WHERE status = 'AVAILABLE' GROUP BY karat ORDER BY karat`);
  const catR = await ctx.db.execute(sql`
    SELECT coalesce(nullif(btrim(c.name), ''), c.name_ar) AS category, c.name_ar AS category_ar, count(*) AS items, coalesce(sum(si.final_price),0) AS revenue, coalesce(sum(si.final_price - si.unit_cost),0) AS profit
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN jewelry_items i ON i.id = si.item_id
    JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
    WHERE s.status='COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}
    GROUP BY c.id, c.name, c.name_ar ORDER BY 4 DESC`);
  const transitR = await ctx.db.execute(sql`SELECT count(*) AS n FROM transfers WHERE status='IN_TRANSIT'`);
  // UI-B (D-ui-19): pieces in transit belong to the company but to no branch: a sub-line of the company's gold.
  const inTransitR = await ctx.db.execute(sql`SELECT count(*) AS items, coalesce(sum(net_weight_mg), 0) AS weight FROM jewelry_items WHERE status = 'TRANSFERRED'`);
  const owedR = await ctx.db.execute(sql`SELECT coalesce(sum(gold_owed_mg_pure24), 0) AS owed, count(*) AS orders FROM purchases WHERE gold_owed_mg_pure24 > 0`);
  // The 14-day company sales line of level 2 (UI-B Q9: replaces the mockup's branch bars), ending on the period's last day.
  const lineFrom = addDays(period.toKey, -13);
  const line = dayRange(lineFrom, period.toKey, tz);
  const lineR = await ctx.db.execute(sql`
    SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS n, coalesce(sum(total), 0) AS revenue
    FROM sales WHERE status = 'COMPLETED' AND created_at >= ${iso(line.start)} AND created_at < ${iso(line.end)}
    GROUP BY 1`);
  const lineMap = new Map(rows<Record<string, unknown>>(lineR).map((r) => [String(r.day), r]));
  const [inTransit] = rows<Record<string, unknown>>(inTransitR);
  const [owed] = rows<Record<string, unknown>>(owedR);
  const sessionsR = await ctx.db.execute(sql`SELECT count(*) AS n FROM sessions WHERE status='ACTIVE'`);

  return {
    period: { from: period.fromKey, to: period.toKey },
    stockWeight: stock.total,
    inTransit: { items: num(inTransit?.items), weightMg: num(inTransit?.weight) },
    goldOwed: { pureMg24: num(owed?.owed), orders: num(owed?.orders) },
    salesLine: eachDay(lineFrom, period.toKey).map((d) => ({ day: d, sales: num(lineMap.get(d)?.n), revenue: num(lineMap.get(d)?.revenue) })),
    totals: {
      revenue: totals.revenue,
      costOfSales: totals.costOfSales,
      grossProfit: totals.grossProfit,
      inventoryCost: totals.inventoryCost,
      inventoryRetail: totals.inventoryRetail,
      availableItems: totals.availableItems,
      availableWeightMg: totals.availableWeightMg,
      salesCount: totals.salesCount,
      purchasesCost: totals.purchasesCost,
      discounts: totals.discounts,
    },
    branches: list,
    trend: eachDay(period.fromKey, period.toKey).map((d) => ({ day: d, ...(byDay.get(d) ?? {}) })),
    inventoryByKarat: rows<Record<string, unknown>>(invR).map((r) => ({ karat: num(r.karat), items: num(r.items), weightMg: num(r.weight), cost: num(r.cost) })),
    salesByCategory: rows<Record<string, unknown>>(catR).map((r) => ({ category: String(r.category), categoryAr: String(r.category_ar), items: num(r.items), revenue: num(r.revenue), profit: num(r.profit) })),
    attention: {
      transfersInTransit: num(rows<Record<string, unknown>>(transitR)[0]?.n),
      activeSessions: num(rows<Record<string, unknown>>(sessionsR)[0]?.n),
    },
  };
}
