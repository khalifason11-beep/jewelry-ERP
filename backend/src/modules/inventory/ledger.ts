// The only place where item status and the inventory ledger are written.
// Every sale, redemption, purchase, transfer and adjustment goes through here, so every
// stock change is traceable (status history + movement + reference document).

import { and, eq, inArray, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { MOVEMENT_DIRECTION, type ItemStatus, type MovementType } from '@jerp/shared';
import { conflict, notFound } from '../../core/errors';

export type ItemRow = typeof t.jewelryItems.$inferSelect;

export interface Ref {
  refType: string;
  refId: number;
  refNumber: string;
}

/** Selected columns for item listings (item + product + category + branch). */
export const itemColumns = {
  id: t.jewelryItems.id,
  code: t.jewelryItems.code,
  barcode: t.jewelryItems.barcode,
  productId: t.jewelryItems.productId,
  productName: t.products.name,
  productNameAr: t.products.nameAr,
  sku: t.products.sku,
  categoryCode: t.categories.code,
  categoryName: t.categories.name,
  categoryNameAr: t.categories.nameAr,
  karat: t.jewelryItems.karat,
  grossWeightMg: t.jewelryItems.grossWeightMg,
  netWeightMg: t.jewelryItems.netWeightMg,
  purchaseCost: t.jewelryItems.purchaseCost,
  makingCost: t.jewelryItems.makingCost,
  otherCost: t.jewelryItems.otherCost,
  totalCost: t.jewelryItems.totalCost,
  sellingPrice: t.jewelryItems.sellingPrice,
  branchId: t.jewelryItems.branchId,
  branchCode: t.branches.code,
  branchName: t.branches.name,
  branchNameAr: t.branches.nameAr,
  status: t.jewelryItems.status,
  reservationRef: t.jewelryItems.reservationRef,
  reservedAt: t.jewelryItems.reservedAt,
  createdAt: t.jewelryItems.createdAt,
  updatedAt: t.jewelryItems.updatedAt,
};

export function itemQuery(exec: Executor) {
  return exec
    .select(itemColumns)
    .from(t.jewelryItems)
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
    .innerJoin(t.branches, eq(t.branches.id, t.jewelryItems.branchId));
}

export async function lockItems(exec: Executor, ids: number[]): Promise<ItemRow[]> {
  if (!ids.length) return [];
  const rowsAll = await exec.select().from(t.jewelryItems).where(inArray(t.jewelryItems.id, ids)).for('update');
  if (rowsAll.length !== new Set(ids).size) throw notFound('Item');
  return rowsAll;
}

export interface StatusChange {
  item: ItemRow;
  to: ItemStatus;
  /** Guard: the item must currently be in one of these statuses. */
  from: ItemStatus[];
  userId: number | null;
  ref?: Ref;
  note?: string;
  at?: Date;
  /** Move the item to another branch as part of the change (transfers). */
  branchId?: number;
  reservation?: { ref: string; userId: number } | null;
}

/** Atomic, guarded status transition + lifecycle history row. */
export async function changeStatus(exec: Executor, c: StatusChange): Promise<ItemRow> {
  const at = c.at ?? new Date();
  const set: Partial<ItemRow> = { status: c.to, updatedAt: at };
  if (c.branchId) set.branchId = c.branchId;
  if (c.reservation !== undefined) {
    set.reservationRef = c.reservation?.ref ?? null;
    set.reservedBy = c.reservation?.userId ?? null;
    set.reservedAt = c.reservation ? at : null;
  } else if (c.to !== 'RESERVED') {
    set.reservationRef = null;
    set.reservedBy = null;
    set.reservedAt = null;
  }
  const updated = await exec
    .update(t.jewelryItems)
    .set(set)
    .where(and(eq(t.jewelryItems.id, c.item.id), inArray(t.jewelryItems.status, c.from)))
    .returning();
  if (!updated.length) {
    const [cur] = await exec.select({ status: t.jewelryItems.status }).from(t.jewelryItems).where(eq(t.jewelryItems.id, c.item.id));
    throw conflict(`Item ${c.item.code} is ${cur?.status ?? 'missing'} (expected ${c.from.join(' or ')})`, {
      itemId: c.item.id,
      status: cur?.status,
    });
  }
  await exec.insert(t.itemStatusHistory).values({
    itemId: c.item.id,
    fromStatus: c.item.status,
    toStatus: c.to,
    branchId: updated[0].branchId,
    refType: c.ref?.refType ?? null,
    refId: c.ref?.refId ?? null,
    refNumber: c.ref?.refNumber ?? null,
    userId: c.userId,
    note: c.note ?? null,
    at,
  });
  return updated[0];
}

export interface Movement {
  item: Pick<ItemRow, 'id' | 'netWeightMg' | 'totalCost'>;
  type: MovementType;
  branchId: number;
  direction?: 1 | -1;
  fromBranchId?: number | null;
  toBranchId?: number | null;
  ref?: Ref;
  userId: number | null;
  note?: string;
  at?: Date;
}

export async function recordMovement(exec: Executor, m: Movement): Promise<void> {
  const direction = m.direction ?? MOVEMENT_DIRECTION[m.type];
  if (direction === 0) throw new Error(`Movement ${m.type} needs an explicit direction`);
  await exec.insert(t.inventoryMovements).values({
    itemId: m.item.id,
    branchId: m.branchId,
    type: m.type,
    direction,
    fromBranchId: m.fromBranchId ?? null,
    toBranchId: m.toBranchId ?? null,
    refType: m.ref?.refType ?? null,
    refId: m.ref?.refId ?? null,
    refNumber: m.ref?.refNumber ?? null,
    netWeightMg: m.item.netWeightMg,
    costValue: m.item.totalCost,
    userId: m.userId,
    note: m.note ?? null,
    at: m.at ?? new Date(),
  });
}

/** Stock on hand per branch derived from the ledger (as of `at`). */
export async function ledgerStock(exec: Executor, branchId: number | null, at: Date) {
  const res = await exec
    .select({
      items: sql<number>`coalesce(sum(${t.inventoryMovements.direction}), 0)`,
      weightMg: sql<number>`coalesce(sum(${t.inventoryMovements.direction} * ${t.inventoryMovements.netWeightMg}), 0)`,
      cost: sql<number>`coalesce(sum(${t.inventoryMovements.direction} * ${t.inventoryMovements.costValue}), 0)`,
    })
    .from(t.inventoryMovements)
    .where(
      and(
        branchId != null ? eq(t.inventoryMovements.branchId, branchId) : undefined,
        sql`${t.inventoryMovements.at} < ${at.toISOString()}`,
      ),
    );
  return { items: Number(res[0].items), weightMg: Number(res[0].weightMg), cost: Number(res[0].cost) };
}
