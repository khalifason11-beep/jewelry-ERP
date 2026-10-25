// Aggregations shared by dashboards and reports. Everything is computed from transactions
// and the ledger at query time — nothing is hard-coded or pre-summed.

import { sql } from 'drizzle-orm';
import type { Executor } from '@jerp/database';
import { rows, num } from '../../core/sql';
import { livePriceSql, type Pricing } from '../pricing/service';
import { effectiveTotalCostSql } from '../purchases/corrections';

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
  /** Cost of the sold lines of KNOWN cost (OPN-1). */
  costOfSales: number;
  /** Profit of the sold lines of known cost; NULL when the period has sales and none of known cost ("—", never 0). */
  grossProfit: number | null;
  /** Revenue of the sold lines of known cost: the base of the margin. */
  knownCostRevenue: number;
  /** Sold lines left out of cost and profit because their cost is unknown (opening pieces). */
  unknownCostLines: number;
  purchasesCount: number;
  purchasedItems: number;
  purchasesCost: number;
  availableItems: number;
  availableWeightMg: number;
  /** Cost of the available pieces of known cost; `unknownCostPieces` counts the others. */
  inventoryCost: number;
  unknownCostPieces: number;
  inventoryRetail: number;
}

const iso = (d: Date) => d.toISOString();

/** `pricing`: PRC-1, the retail value of the stock is the sum of the pieces' LIVE prices (a piece without a rate adds 0). */
export async function branchMetrics(exec: Executor, p: Period, branchId: number | null, pricing: Pricing): Promise<Map<number, BranchMetrics>> {
  const bFilter = (col: string) => (branchId != null ? sql.raw(`AND ${col} = ${Number(branchId)}`) : sql``);

  // UI-B (D-ui-21): grouped queries only. The pieces and weight sold come from one join of the period's sales with
  // their lines (it used to be a sub-query per sale, 16 s on 60,000 sales).
  const [branchesR, salesR, linesR, purchR, invR] = await Promise.all([
    exec.execute(sql`SELECT id FROM branches WHERE is_active ${bFilter('id')} ORDER BY id`),
    exec.execute(sql`
      SELECT s.branch_id,
             count(*) AS sales_count,
             coalesce(sum(s.total),0) AS revenue,
             coalesce(sum(s.discount_total),0) AS discounts,
             coalesce(sum(s.cost_total),0) AS cost
      FROM sales s
      WHERE s.status = 'COMPLETED' AND s.created_at >= ${iso(p.start)} AND s.created_at < ${iso(p.end)} ${bFilter('s.branch_id')}
      GROUP BY s.branch_id`),
    exec.execute(sql`
      SELECT s.branch_id, count(*) AS items, coalesce(sum(si.net_weight_mg),0) AS weight,
             count(*) FILTER (WHERE si.unit_cost IS NULL) AS unknown_lines,
             coalesce(sum(si.final_price) FILTER (WHERE si.unit_cost IS NULL),0) AS unknown_revenue
      FROM sales s JOIN sale_items si ON si.sale_id = s.id
      WHERE s.status = 'COMPLETED' AND s.created_at >= ${iso(p.start)} AND s.created_at < ${iso(p.end)} ${bFilter('s.branch_id')}
      GROUP BY s.branch_id`),
    exec.execute(sql`
      SELECT branch_id, count(*) AS cnt, coalesce(sum(item_count),0) AS items, coalesce(sum(${effectiveTotalCostSql()}),0) AS cost
      FROM purchases
      WHERE created_at >= ${iso(p.start)} AND created_at < ${iso(p.end)} ${bFilter('branch_id')}
      GROUP BY branch_id`),
    exec.execute(sql`
      SELECT branch_id,
             count(*) FILTER (WHERE status = 'AVAILABLE') AS available,
             coalesce(sum(net_weight_mg) FILTER (WHERE status = 'AVAILABLE'),0) AS weight,
             coalesce(sum(acquisition_cost) FILTER (WHERE status = 'AVAILABLE'),0) AS cost,
             count(*) FILTER (WHERE status = 'AVAILABLE' AND acquisition_cost IS NULL) AS unknown_pieces,
             coalesce(sum(${livePriceSql(pricing)}) FILTER (WHERE status = 'AVAILABLE'),0) AS retail
      FROM jewelry_items
      WHERE true ${bFilter('branch_id')}
      GROUP BY branch_id`),
  ]);

  const out = new Map<number, BranchMetrics>();
  for (const b of rows<{ id: number }>(branchesR)) {
    out.set(Number(b.id), {
      branchId: Number(b.id),
      ...ZERO_METRICS,
    });
  }
  const get = (id: unknown) => out.get(Number(id));
  for (const r of rows<Record<string, unknown>>(salesR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.salesCount = num(r.sales_count); m.revenue = num(r.revenue); m.discounts = num(r.discounts);
    m.costOfSales = num(r.cost);
  }
  for (const r of rows<Record<string, unknown>>(linesR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.itemsSold = num(r.items); m.weightSoldMg = num(r.weight);
    m.unknownCostLines = num(r.unknown_lines); m.knownCostRevenue = -num(r.unknown_revenue);
  }
  for (const r of rows<Record<string, unknown>>(purchR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.purchasesCount = num(r.cnt); m.purchasedItems = num(r.items); m.purchasesCost = num(r.cost);
  }
  for (const r of rows<Record<string, unknown>>(invR)) {
    const m = get(r.branch_id); if (!m) continue;
    m.availableItems = num(r.available); m.availableWeightMg = num(r.weight);
    m.inventoryCost = num(r.cost); m.unknownCostPieces = num(r.unknown_pieces); m.inventoryRetail = num(r.retail);
  }
  for (const m of out.values()) {
    // knownCostRevenue held −(revenue of the unknown lines) until the sales row was read.
    m.knownCostRevenue += m.revenue;
    m.grossProfit = m.itemsSold > 0 && m.unknownCostLines === m.itemsSold ? null : m.knownCostRevenue - m.costOfSales;
  }
  return out;
}

const ZERO_METRICS: Omit<BranchMetrics, 'branchId'> = {
  salesCount: 0, itemsSold: 0, weightSoldMg: 0, revenue: 0, discounts: 0, costOfSales: 0, grossProfit: 0, knownCostRevenue: 0,
  unknownCostLines: 0, purchasesCount: 0, purchasedItems: 0, purchasesCost: 0, availableItems: 0, availableWeightMg: 0,
  inventoryCost: 0, unknownCostPieces: 0, inventoryRetail: 0,
};

/**
 * Totals over branches; with no branches every figure is 0 (an empty company shows zeros, not "—"). A NULL gross profit
 * (no sold line of known cost) adds nothing; the total is NULL only when every branch's is.
 */
export function sumMetrics(list: BranchMetrics[]): Omit<BranchMetrics, 'branchId'> {
  const total = { ...ZERO_METRICS } as Record<string, number | null>;
  for (const m of list) for (const [k, v] of Object.entries(m)) if (k !== 'branchId' && v != null) total[k] = (total[k] ?? 0) + (v as number);
  if (list.length && list.every((m) => m.grossProfit == null)) total.grossProfit = null;
  return total as unknown as Omit<BranchMetrics, 'branchId'>;
}

/** Margin in % of the revenue of the lines of known cost; NULL when there is no profit to show. */
export const marginOf = (grossProfit: number | null, knownCostRevenue: number) =>
  grossProfit == null ? null : knownCostRevenue ? (grossProfit / knownCostRevenue) * 100 : 0;

export interface MovementSummary {
  branchId: number;
  /** `cost`: of the pieces of known cost only; `unknownCostPieces` counts the others (OPN-1). */
  opening: { items: number; weightMg: number; cost: number; unknownCostPieces: number };
  lines: Record<string, { items: number; weightMg: number }>;
  closing: { items: number; weightMg: number; cost: number; unknownCostPieces: number };
  /** Live count of items in stock, AVAILABLE (only meaningful when the period ends now). */
  actual?: { items: number; weightMg: number };
}

/** Opening + movements − … = closing, per branch, derived from the ledger. */
export async function movementSummary(exec: Executor, p: Period, branchId: number | null): Promise<MovementSummary[]> {
  const bFilter = branchId != null ? sql.raw(`AND branch_id = ${Number(branchId)}`) : sql``;
  const [branchesR, openR, movR, closeR, actualR] = await Promise.all([
    exec.execute(sql`SELECT id FROM branches WHERE is_active ${branchId != null ? sql.raw(`AND id = ${Number(branchId)}`) : sql``} ORDER BY id`),
    exec.execute(sql`SELECT branch_id, coalesce(sum(direction),0) AS items, coalesce(sum(direction*net_weight_mg),0) AS weight, coalesce(sum(direction*cost_value),0) AS cost,
                            coalesce(sum(direction) FILTER (WHERE cost_value IS NULL),0) AS unknown
                     FROM inventory_movements WHERE at < ${iso(p.start)} ${bFilter} GROUP BY branch_id`),
    exec.execute(sql`SELECT branch_id, type, direction, count(*) AS items, coalesce(sum(net_weight_mg),0) AS weight
                     FROM inventory_movements WHERE at >= ${iso(p.start)} AND at < ${iso(p.end)} ${bFilter} GROUP BY branch_id, type, direction`),
    exec.execute(sql`SELECT branch_id, coalesce(sum(direction),0) AS items, coalesce(sum(direction*net_weight_mg),0) AS weight, coalesce(sum(direction*cost_value),0) AS cost,
                            coalesce(sum(direction) FILTER (WHERE cost_value IS NULL),0) AS unknown
                     FROM inventory_movements WHERE at < ${iso(p.end)} ${bFilter} GROUP BY branch_id`),
    exec.execute(sql`SELECT branch_id, count(*) AS items, coalesce(sum(net_weight_mg),0) AS weight FROM jewelry_items
                     WHERE status = 'AVAILABLE' ${bFilter} GROUP BY branch_id`),
  ]);
  const zero = () => ({ items: 0, weightMg: 0, cost: 0, unknownCostPieces: 0 });
  const res = new Map<number, MovementSummary>();
  for (const b of rows<{ id: number }>(branchesR)) {
    res.set(Number(b.id), { branchId: Number(b.id), opening: zero(), lines: {}, closing: zero(), actual: { items: 0, weightMg: 0 } });
  }
  for (const r of rows<Record<string, unknown>>(openR)) {
    const m = res.get(Number(r.branch_id)); if (m) m.opening = { items: num(r.items), weightMg: num(r.weight), cost: num(r.cost), unknownCostPieces: num(r.unknown) };
  }
  for (const r of rows<Record<string, unknown>>(closeR)) {
    const m = res.get(Number(r.branch_id)); if (m) m.closing = { items: num(r.items), weightMg: num(r.weight), cost: num(r.cost), unknownCostPieces: num(r.unknown) };
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
