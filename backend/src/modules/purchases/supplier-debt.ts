// The gold the shop still owes each supplier (24K mg), with the number of open orders and the oldest one. One query,
// one source of truth: attention A6 (D-ui-17) and the SUP-1 warning on a new supplier order (D-sup-1) both read it.
// Weights, counts and dates only, never money (D-4-16).

import { sql } from 'drizzle-orm';
import type { Executor } from '@jerp/database';
import { num, rows } from '../../core/sql';

export interface SupplierGoldOwed {
  supplierId: number | null;
  supplier: string | null;
  supplierAr: string | null;
  /** Gold still owed over the supplier's open orders, in 24K mg. */
  pureMg24: number;
  /** Open orders (gold still owed > 0). */
  orders: number;
  oldestAt: Date;
  oldestPurchaseId: number;
  oldestNumber: string;
}

/**
 * Open supplier debt per supplier. `branchId` limits it to one branch's orders (a branch manager's attention list);
 * null means every branch (a supplier belongs to the company: the SUP-1 rule is company-wide). `supplierId` limits it to
 * one supplier.
 */
export async function supplierGoldOwed(exec: Executor, q: { branchId: number | null; supplierId?: number }): Promise<SupplierGoldOwed[]> {
  const r = rows<{ supplier_id: number | null; supplier: string | null; supplier_ar: string | null; owed: number | string; orders: number; oldest_at: Date | string; oldest_id: number; oldest_number: string }>(
    await exec.execute(sql`
      SELECT p.supplier_id, s.name AS supplier, s.name_ar AS supplier_ar,
             sum(p.gold_owed_mg_pure24) AS owed, count(*)::int AS orders, min(p.created_at) AS oldest_at,
             (array_agg(p.id ORDER BY p.created_at, p.id))[1] AS oldest_id,
             (array_agg(p.number ORDER BY p.created_at, p.id))[1] AS oldest_number
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.gold_owed_mg_pure24 > 0
        ${q.branchId == null ? sql`` : sql`AND p.branch_id = ${q.branchId}`}
        ${q.supplierId == null ? sql`` : sql`AND p.supplier_id = ${q.supplierId}`}
      GROUP BY p.supplier_id, s.name, s.name_ar`),
  );
  return r.map((o) => ({
    supplierId: o.supplier_id == null ? null : Number(o.supplier_id),
    supplier: o.supplier ?? null,
    supplierAr: o.supplier_ar ?? null,
    pureMg24: num(o.owed),
    orders: num(o.orders),
    oldestAt: new Date(o.oldest_at),
    oldestPurchaseId: Number(o.oldest_id),
    oldestNumber: o.oldest_number,
  }));
}

/** Whole days an order has been open, as A6 counts them. */
export const daysOpen = (since: Date, now = new Date()) => Math.floor((now.getTime() - since.getTime()) / 86_400_000);
