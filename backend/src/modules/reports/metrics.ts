// Aggregations shared by dashboards and reports. Everything is computed from transactions
// and the ledger at query time — nothing is hard-coded or pre-summed.

import { sql } from 'drizzle-orm';
import type { Executor } from '@jerp/database';
import { rows, num } from '../../core/sql';

export interface Period {
  start: Date;
  end: Date;
  fromKey: string;
  toKey: string;
}

export interface BranchMetrics {
  branchId: number;
  salesCount: number;
  itemsSold: number;
  weightSoldMg: number;
  revenue: number;
  discounts: number;
  costOfSales: number;
  grossProfit: number;
  purchasesCount: number;
  purchasedItems: number;
  purchasesCost: number;
  expenses: number;
  pendingExpenses: number;
  contribution: number;
  hasadCompleted: number;
  hasadWeightMg: number;
  hasadItemsCost: number;
  hasadPaidToCustomers: number;
  hasadCollectedFromCustomers: number;
  hasadReceived: number;
  hasadCancelled: number;
  hasadOpen: number;
  hasadInProgress: number;
  availableItems: number;
  availableWeightMg: number;
  reservedItems: number;
  inventoryCost: number;
  inventoryRetail: number;
}

const iso = (d: Date) => d.toISOString();

export async function branchMetrics(exec: Executor, p: Period, branchId: number | null): Promise<Map<number, BranchMetrics>> {
  const bFilter = (col: string) => (branchId != null ? sql.raw(`AND ${col} = ${Number(branchId)}`) : sql``);

  const [branchesR, salesR, purchR, expR, hasadR, hasadReqR, invR] = await Promise.all([
    exec.execute(sql`SELECT id FROM branches WHERE is_active ${bFilter('id')} ORDER BY id`),
    exec.execute(sql`
      SELECT s.branch_id,
             count(*) AS sales_count,
             coalesce(sum(s.total),0) AS revenue,
             coalesce(sum(s.discount_total),0) AS discounts,
             coalesce(sum(s.cost_total),0) AS cost,
             coalesce(sum((SELECT count(*) FROM sale_items si WHERE si.sale_id = s.id)),0) AS items,
             coalesce(sum((SELECT sum(si.net_weight_mg) FROM sale_items si WHERE si.sale_id = s.id)),0) AS weight
      FROM sales s
      WHERE s.status = 'COMPLETED' AND s.created_at >= ${iso(p.start)} AND s.created_at < ${iso(p.end)} ${bFilter('s.branch_id')}
      GROUP BY s.branch_id`),
    exec.execute(sql`
      SELECT branch_id, count(*) AS cnt, coalesce(sum(item_count),0) AS items, coalesce(sum(total_cost),0) AS cost
      FROM purchases
      WHERE created_at >= ${iso(p.start)} AND created_at < ${iso(p.end)} ${bFilter('branch_id')}
      GROUP BY branch_id`),
    exec.execute(sql`
      SELECT branch_id,
             coalesce(sum(amount) FILTER (WHERE status = 'APPROVED'),0) AS approved,
             coalesce(sum(amount) FILTER (WHERE status = 'PENDING'),0) AS pending
      FROM expenses
      WHERE expense_date >= ${p.fromKey} AND expense_date <= ${p.toKey} ${bFilter('branch_id')}
      GROUP BY branch_id`),
    exec.execute(sql`
      SELECT r.branch_id,
             count(*) AS completed,
             coalesce(sum(r.delivered_weight_mg),0) AS weight,
             coalesce(sum(r.items_cost),0) AS items_cost,
             coalesce(sum(r.settlement_amount) FILTER (WHERE r.settlement_direction = 'BRANCH_PAYS_CUSTOMER'),0) AS paid,
             coalesce(sum(r.settlement_amount) FILTER (WHERE r.settlement_direction = 'CUSTOMER_PAYS_BRANCH'),0) AS collected
      FROM hasad_redemptions r
      WHERE r.status = 'COMPLETED' AND r.completed_at >= ${iso(p.start)} AND r.completed_at < ${iso(p.end)} ${bFilter('r.branch_id')}
      GROUP BY r.branch_id`),
    exec.execute(sql`
      SELECT branch_id,
             count(*) FILTER (WHERE received_at >= ${iso(p.start)} AND received_at < ${iso(p.end)}) AS received,
             count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_at >= ${iso(p.start)} AND cancelled_at < ${iso(p.end)}) AS cancelled,
             count(*) FILTER (WHERE status = 'READY_FOR_PICKUP') AS open,
             count(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress
      FROM hasad_withdrawals
      WHERE true ${bFilter('branch_id')}
      GROUP BY branch_id`),
    exec.execute(sql`
      SELECT branch_id,
             count(*) FILTER (WHERE status = 'AVAILABLE') AS available,
             coalesce(sum(net_weight_mg) FILTER (WHERE status IN ('AVAILABLE','RESERVED')),0) AS weight,
             count(*) FILTER (WHERE status = 'RESERVED') AS reserved,
             coalesce(sum(total_cost) FILTER (WHERE status IN ('AVAILABLE','RESERVED')),0) AS cost,
             coalesce(sum(selling_price) FILTER (WHERE status IN ('AVAILABLE','RESERVED')),0) AS retail
      FROM jewelry_items
      WHERE true ${bFilter('branch_id')}
      GROUP BY branch_id`),
  ]);

  const out = new Map<number, BranchMetrics>();
  for (const b of rows<{ id: number }>(branchesR)) {
    out.set(Number(b.id), {
      branchId: Number(b.id),
      salesCount: 0, itemsSold: 0, weightSoldMg: 0, revenue: 0, discounts: 0, costOfSales: 0, grossProfit: 0,
      purchasesCount: 0, purchasedItems: 0, purchasesCost: 0, expenses: 0, pendingExpenses: 0, contribution: 0,
      hasadCompleted: 0, hasadWeightMg: 0, hasadItemsCost: 0, hasadPaidToCustomers: 0, hasadCollectedFromCustomers: 0,
      hasadReceived: 0, hasadCancelled: 0, hasadOpen: 0, hasadInProgress: 0,
      availableItems: 0, availableWeightMg: 0, reservedItems: 0, inventoryCost: 0, inventoryRetail: 0,
    });
  }
  const get = (id: unknown) => out.get(Number(id));
  for (const r of rows<Record<string, unknown>>(salesR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.salesCount = num(r.sales_count); m.revenue = num(r.revenue); m.discounts = num(r.discounts);
    m.costOfSales = num(r.cost); m.itemsSold = num(r.items); m.weightSoldMg = num(r.weight);
  }
  for (const r of rows<Record<string, unknown>>(purchR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.purchasesCount = num(r.cnt); m.purchasedItems = num(r.items); m.purchasesCost = num(r.cost);
  }
  for (const r of rows<Record<string, unknown>>(expR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.expenses = num(r.approved); m.pendingExpenses = num(r.pending);
  }
  for (const r of rows<Record<string, unknown>>(hasadR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.hasadCompleted = num(r.completed); m.hasadWeightMg = num(r.weight); m.hasadItemsCost = num(r.items_cost);
    m.hasadPaidToCustomers = num(r.paid); m.hasadCollectedFromCustomers = num(r.collected);
  }
  for (const r of rows<Record<string, unknown>>(hasadReqR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.hasadReceived = num(r.received); m.hasadCancelled = num(r.cancelled); m.hasadOpen = num(r.open); m.hasadInProgress = num(r.in_progress);
  }
  for (const r of rows<Record<string, unknown>>(invR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.availableItems = num(r.available); m.availableWeightMg = num(r.weight); m.reservedItems = num(r.reserved);
    m.inventoryCost = num(r.cost); m.inventoryRetail = num(r.retail);
  }
  for (const m of out.values()) {
    m.grossProfit = m.revenue - m.costOfSales;
    m.contribution = m.grossProfit - m.expenses;
  }
  return out;
}

export function sumMetrics(list: BranchMetrics[]): Omit<BranchMetrics, 'branchId'> {
  const total = {} as Record<string, number>;
  for (const m of list) for (const [k, v] of Object.entries(m)) if (k !== 'branchId') total[k] = (total[k] ?? 0) + (v as number);
  return total as unknown as Omit<BranchMetrics, 'branchId'>;
}

export interface MovementSummary {
  branchId: number;
  opening: { items: number; weightMg: number; cost: number };
  lines: Record<string, { items: number; weightMg: number }>;
  closing: { items: number; weightMg: number; cost: number };
  /** Live count of items in AVAILABLE/RESERVED (only meaningful when the period ends now). */
  actual?: { items: number; weightMg: number };
}

/** Opening + movements − … = closing, per branch, derived from the ledger. */
export async function movementSummary(exec: Executor, p: Period, branchId: number | null): Promise<MovementSummary[]> {
  const bFilter = branchId != null ? sql.raw(`AND branch_id = ${Number(branchId)}`) : sql``;
  const [branchesR, openR, movR, closeR, actualR] = await Promise.all([
    exec.execute(sql`SELECT id FROM branches WHERE is_active ${branchId != null ? sql.raw(`AND id = ${Number(branchId)}`) : sql``} ORDER BY id`),
    exec.execute(sql`SELECT branch_id, coalesce(sum(direction),0) AS items, coalesce(sum(direction*net_weight_mg),0) AS weight, coalesce(sum(direction*cost_value),0) AS cost
                     FROM inventory_movements WHERE at < ${iso(p.start)} ${bFilter} GROUP BY branch_id`),
    exec.execute(sql`SELECT branch_id, type, direction, count(*) AS items, coalesce(sum(net_weight_mg),0) AS weight
                     FROM inventory_movements WHERE at >= ${iso(p.start)} AND at < ${iso(p.end)} ${bFilter} GROUP BY branch_id, type, direction`),
    exec.execute(sql`SELECT branch_id, coalesce(sum(direction),0) AS items, coalesce(sum(direction*net_weight_mg),0) AS weight, coalesce(sum(direction*cost_value),0) AS cost
                     FROM inventory_movements WHERE at < ${iso(p.end)} ${bFilter} GROUP BY branch_id`),
    exec.execute(sql`SELECT branch_id, count(*) AS items, coalesce(sum(net_weight_mg),0) AS weight FROM jewelry_items
                     WHERE status IN ('AVAILABLE','RESERVED') ${bFilter} GROUP BY branch_id`),
  ]);
  const zero = () => ({ items: 0, weightMg: 0, cost: 0 });
  const res = new Map<number, MovementSummary>();
  for (const b of rows<{ id: number }>(branchesR)) {
    res.set(Number(b.id), { branchId: Number(b.id), opening: zero(), lines: {}, closing: zero(), actual: { items: 0, weightMg: 0 } });
  }
  for (const r of rows<Record<string, unknown>>(openR)) {
    const m = res.get(Number(r.branch_id)); if (m) m.opening = { items: num(r.items), weightMg: num(r.weight), cost: num(r.cost) };
  }
  for (const r of rows<Record<string, unknown>>(closeR)) {
    const m = res.get(Number(r.branch_id)); if (m) m.closing = { items: num(r.items), weightMg: num(r.weight), cost: num(r.cost) };
  }
  for (const r of rows<Record<string, unknown>>(movR)) {
    const m = res.get(Number(r.branch_id)); if (!m) continue;
    const type = String(r.type);
    const key = type === 'ADJUSTMENT' ? (num(r.direction) > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT') : type;
    const cur = m.lines[key] ?? { items: 0, weightMg: 0 };
    m.lines[key] = { items: cur.items + num(r.items), weightMg: cur.weightMg + num(r.weight) };
  }
  for (const r of rows<Record<string, unknown>>(actualR)) {
    const m = res.get(Number(r.branch_id)); if (m) m.actual = { items: num(r.items), weightMg: num(r.weight) };
  }
  return [...res.values()];
}
