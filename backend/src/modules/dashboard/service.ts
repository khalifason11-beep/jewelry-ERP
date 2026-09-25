import { sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requirePerm } from '../../authz';
import { badRequest } from '../../core/errors';
import { rows, num } from '../../core/sql';
import { addDays, dayKey, dayRange, eachDay } from '../../core/time';
import { branchMetrics, movementSummary, sumMetrics, type Period } from '../reports/metrics';

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
  const [trendR, hourlyR, cashiersR, expensesR, hasadR] = await Promise.all([
    ctx.db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS n, coalesce(sum(total),0) AS revenue, coalesce(sum(total - cost_total),0) AS profit
      FROM sales WHERE status='COMPLETED' AND branch_id = ${branchId} AND created_at >= ${iso(trendRange.start)} AND created_at < ${iso(trendRange.end)}
      GROUP BY 1`),
    ctx.db.execute(sql`
      SELECT extract(hour FROM created_at AT TIME ZONE ${tz})::int AS h, count(*) AS n, coalesce(sum(total),0) AS revenue
      FROM sales WHERE status='COMPLETED' AND branch_id = ${branchId} AND created_at >= ${iso(period.start)} AND created_at < ${iso(period.end)}
      GROUP BY 1 ORDER BY 1`),
    ctx.db.execute(sql`
      SELECT u.id, u.full_name, u.username, r.code AS role,
        (SELECT count(*) FROM sales s WHERE s.cashier_id = u.id AND s.status='COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}) AS sales_count,
        (SELECT coalesce(sum(total),0) FROM sales s WHERE s.cashier_id = u.id AND s.status='COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}) AS sales_total,
        (SELECT count(*) FROM hasad_redemptions h WHERE h.cashier_id = u.id AND h.status='COMPLETED' AND h.completed_at >= ${iso(period.start)} AND h.completed_at < ${iso(period.end)}) AS hasad_count,
        (SELECT count(*) FROM sales s WHERE s.cashier_id = u.id AND s.status='VOIDED' AND s.voided_at >= ${iso(period.start)} AND s.voided_at < ${iso(period.end)}) AS voided,
        (SELECT max(last_activity_at) FROM sessions se WHERE se.user_id = u.id) AS last_activity,
        (SELECT count(*) FROM sessions se WHERE se.user_id = u.id AND se.status='ACTIVE') AS live_sessions,
        (SELECT min(login_at) FROM sessions se WHERE se.user_id = u.id AND se.login_at >= ${iso(period.start)} AND se.login_at < ${iso(period.end)}) AS first_login
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.branch_id = ${branchId} AND u.status = 'ACTIVE'
      ORDER BY r.rank, u.full_name`),
    ctx.db.execute(sql`
      SELECT e.id, e.number, e.category, e.amount, e.expense_date, e.description, e.status, u.full_name AS created_by
      FROM expenses e JOIN users u ON u.id = e.created_by
      WHERE e.branch_id = ${branchId} AND e.expense_date >= ${mtdFrom} AND e.expense_date <= ${period.toKey}
      ORDER BY e.expense_date DESC, e.id DESC LIMIT 12`),
    ctx.db.execute(sql`
      SELECT id, external_id, customer_name, customer_name_ar, entitled_weight_mg, status, requested_at
      FROM hasad_withdrawals WHERE branch_id = ${branchId} AND status IN ('READY_FOR_PICKUP','IN_PROGRESS')
      ORDER BY requested_at ASC LIMIT 10`),
  ]);

  const trendMap = new Map(rows<Record<string, unknown>>(trendR).map((r) => [String(r.day), r]));
  const expensesByCat = await ctx.db.execute(sql`
      SELECT category, coalesce(sum(amount),0) AS amount FROM expenses
      WHERE branch_id = ${branchId} AND status='APPROVED' AND expense_date >= ${mtdFrom} AND expense_date <= ${period.toKey}
      GROUP BY category ORDER BY 2 DESC`);

  const showProfit = can(actor, 'profit.view');
  return {
    branchId,
    date: period.fromKey,
    kpis: {
      salesTotal: m.revenue,
      salesCount: m.salesCount,
      itemsSold: m.itemsSold,
      purchasesCost: m.purchasesCost,
      purchasesCount: m.purchasesCount,
      expenses: m.expenses,
      pendingExpenses: m.pendingExpenses,
      grossProfit: showProfit ? m.grossProfit : null,
      contribution: showProfit ? m.contribution : null,
      availableItems: m.availableItems,
      availableWeightMg: m.availableWeightMg,
      reservedItems: m.reservedItems,
      inventoryCost: showProfit ? m.inventoryCost : null,
      hasadCompleted: m.hasadCompleted,
      hasadOpen: m.hasadOpen + m.hasadInProgress,
    },
    mtd: {
      revenue: mtd.revenue,
      grossProfit: showProfit ? mtd.grossProfit : null,
      expenses: mtd.expenses,
      contribution: showProfit ? mtd.contribution : null,
      salesCount: mtd.salesCount,
      hasadCompleted: mtd.hasadCompleted,
    },
    movement,
    hasad: {
      newRequests: m.hasadReceived,
      waiting: m.hasadOpen,
      inProgress: m.hasadInProgress,
      completedToday: m.hasadCompleted,
      cancelled: m.hasadCancelled,
      weightDeliveredMg: m.hasadWeightMg,
      paidToCustomers: m.hasadPaidToCustomers,
      collectedFromCustomers: m.hasadCollectedFromCustomers,
      queue: rows<Record<string, unknown>>(hasadR).map((r) => ({
        id: num(r.id),
        externalId: String(r.external_id),
        customerName: String(r.customer_name),
        customerNameAr: r.customer_name_ar == null ? null : String(r.customer_name_ar),
        entitledWeightMg: num(r.entitled_weight_mg),
        status: String(r.status),
        requestedAt: r.requested_at,
      })),
    },
    trend: eachDay(trendFrom, period.toKey).map((d) => {
      const r = trendMap.get(d);
      return { day: d, sales: num(r?.n), revenue: num(r?.revenue), profit: showProfit ? num(r?.profit) : null };
    }),
    hourly: rows<Record<string, unknown>>(hourlyR).map((r) => ({ hour: num(r.h), sales: num(r.n), revenue: num(r.revenue) })),
    expenses: {
      recent: rows<Record<string, unknown>>(expensesR).map((r) => ({
        id: num(r.id), number: String(r.number), category: String(r.category), amount: num(r.amount),
        expenseDate: String(r.expense_date), description: String(r.description), status: String(r.status), createdBy: String(r.created_by),
      })),
      byCategory: rows<Record<string, unknown>>(expensesByCat).map((r) => ({ category: String(r.category), amount: num(r.amount) })),
    },
    cashiers: rows<Record<string, unknown>>(cashiersR).map((r) => ({
      userId: num(r.id), fullName: String(r.full_name), username: String(r.username), role: String(r.role),
      salesCount: num(r.sales_count), salesTotal: num(r.sales_total), hasadCount: num(r.hasad_count), voided: num(r.voided),
      lastActivity: r.last_activity, liveSessions: num(r.live_sessions), firstLogin: r.first_login,
    })),
  };
}

/** Executive dashboard across all branches. */
export async function companyDashboard(ctx: Ctx, actor: Actor, q: { from?: string; to?: string }) {
  requirePerm(actor, 'dashboard.company', 'scope.all_branches');
  const { company } = await ctx.settings.get();
  const today = dayKey(new Date(), company.timezone);
  const period = await periodFor(ctx, q.from ?? today.slice(0, 8) + '01', q.to ?? today);
  const metrics = await branchMetrics(ctx.db, period, null);
  const branches = await ctx.db.select().from(t.branches).orderBy(t.branches.id);
  const list = branches.map((b) => ({ ...metrics.get(b.id)!, code: b.code, name: b.name, nameAr: b.nameAr, city: b.city }));
  const totals = sumMetrics(list.map(({ code: _c, name: _n, nameAr: _a, city: _ci, ...m }) => m));

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
    SELECT karat, count(*) AS items, coalesce(sum(net_weight_mg),0) AS weight, coalesce(sum(total_cost),0) AS cost
    FROM jewelry_items WHERE status IN ('AVAILABLE','RESERVED') GROUP BY karat ORDER BY karat`);
  const catR = await ctx.db.execute(sql`
    SELECT c.name AS category, count(*) AS items, coalesce(sum(si.final_price),0) AS revenue, coalesce(sum(si.final_price - si.unit_cost),0) AS profit
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN jewelry_items i ON i.id = si.item_id
    JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
    WHERE s.status='COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}
    GROUP BY c.name ORDER BY 3 DESC`);
  const pendingR = await ctx.db.execute(sql`SELECT count(*) AS n, coalesce(sum(amount),0) AS amount FROM expenses WHERE status='PENDING'`);
  const transitR = await ctx.db.execute(sql`SELECT count(*) AS n FROM transfers WHERE status='IN_TRANSIT'`);
  const sessionsR = await ctx.db.execute(sql`SELECT count(*) AS n FROM sessions WHERE status='ACTIVE'`);

  return {
    period: { from: period.fromKey, to: period.toKey },
    totals: {
      revenue: totals.revenue,
      costOfSales: totals.costOfSales,
      grossProfit: totals.grossProfit,
      expenses: totals.expenses,
      contribution: totals.contribution,
      inventoryCost: totals.inventoryCost,
      inventoryRetail: totals.inventoryRetail,
      availableItems: totals.availableItems,
      availableWeightMg: totals.availableWeightMg,
      salesCount: totals.salesCount,
      purchasesCost: totals.purchasesCost,
      hasadCompleted: totals.hasadCompleted,
      hasadWeightMg: totals.hasadWeightMg,
      hasadOpen: totals.hasadOpen + totals.hasadInProgress,
      hasadPaidToCustomers: totals.hasadPaidToCustomers,
      hasadCollectedFromCustomers: totals.hasadCollectedFromCustomers,
      discounts: totals.discounts,
    },
    branches: list,
    trend: eachDay(period.fromKey, period.toKey).map((d) => ({ day: d, ...(byDay.get(d) ?? {}) })),
    inventoryByKarat: rows<Record<string, unknown>>(invR).map((r) => ({ karat: num(r.karat), items: num(r.items), weightMg: num(r.weight), cost: num(r.cost) })),
    salesByCategory: rows<Record<string, unknown>>(catR).map((r) => ({ category: String(r.category), items: num(r.items), revenue: num(r.revenue), profit: num(r.profit) })),
    attention: {
      pendingExpenses: num(rows<Record<string, unknown>>(pendingR)[0]?.n),
      pendingExpensesAmount: num(rows<Record<string, unknown>>(pendingR)[0]?.amount),
      transfersInTransit: num(rows<Record<string, unknown>>(transitR)[0]?.n),
      activeSessions: num(rows<Record<string, unknown>>(sessionsR)[0]?.n),
    },
  };
}
