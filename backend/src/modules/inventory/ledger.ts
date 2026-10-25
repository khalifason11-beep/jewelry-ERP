// The only place where item status and the inventory ledger are written.
// Every sale, redemption, purchase, transfer and adjustment goes through here, so every
// stock change is traceable (status history + movement + reference document).

import { and, eq, inArray, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { MOVEMENT_DIRECTION, type ItemStatus, type MovementType } from '@jerp/shared';
import { conflict, notFound } from '../../core/errors';
import { liveRateSql, livePriceSql, type Pricing } from '../pricing/service';

export type ItemRow = typeof t.jewelryItems.$inferSelect;

export interface Ref {
  refType: string;
  refId: number;
  refNumber: string;
}

const nullableNumber = (v: unknown) => (v == null ? null : Number(v));

/** Selected columns for item listings (item + product + category + branch). */
/** Cost breakdown of a piece (GM only; redacted for other roles). Needs `purchase_items` LEFT JOINed on the item. */
export const costBreakdown = {
  // OPN-1: a piece of unknown cost (an opening piece) has no components either: NULL ("—"), never 0.
  purchaseCost: sql<number | null>`coalesce(${t.purchaseItems.purchaseCost}, ${t.jewelryItems.acquisitionCost})`.mapWith(nullableNumber),
  // MIS-1: a supplier piece's live making charge (kept equal to its line's effective making cost by a correction).
  makingCost: sql<number | null>`CASE WHEN ${t.jewelryItems.acquisitionCost} IS NULL THEN NULL WHEN ${t.purchaseItems.id} IS NULL THEN 0 ELSE ${t.jewelryItems.makingCharge} END`.mapWith(nullableNumber),
  otherCost: sql<number | null>`CASE WHEN ${t.jewelryItems.acquisitionCost} IS NULL THEN NULL ELSE coalesce(${t.purchaseItems.otherCost}, 0) END`.mapWith(nullableNumber),
  totalCost: t.jewelryItems.acquisitionCost,
};

/** CAT-1: the name of a piece in English and in Arabic (description, else product, else type). */
export const itemNameSql = sql<string>`coalesce(${t.jewelryItems.description}, nullif(btrim(${t.products.name}), ''), ${t.products.nameAr}, nullif(btrim(${t.categories.name}), ''), ${t.categories.nameAr})`;
export const itemNameArSql = sql<string>`coalesce(${t.jewelryItems.description}, ${t.products.nameAr}, ${t.categories.nameAr})`;

export const itemColumns = {
  id: t.jewelryItems.id,
  code: t.jewelryItems.code,
  barcode: t.jewelryItems.barcode,
  productId: t.jewelryItems.productId,
  // CAT-1: a piece is a type + a free-text description; the product is optional. The name shown is the description,
  // else the product's name, else the type's name (`productName*` keep their meaning for the screens).
  productName: itemNameSql,
  productNameAr: itemNameArSql,
  description: t.jewelryItems.description,
  sku: t.products.sku,
  categoryId: t.jewelryItems.categoryId,
  categoryCode: t.categories.code,
  categoryName: t.categories.name,
  categoryNameAr: t.categories.nameAr,
  karat: t.jewelryItems.karat,
  grossWeightMg: t.jewelryItems.grossWeightMg,
  netWeightMg: t.jewelryItems.netWeightMg,
  // REM-5: the cost breakdown comes from the supplier line (purchase_items); a piece without one (counter scrap)
  // cost its acquisition cost alone. `totalCost` is the acquisition cost.
  ...costBreakdown,
  origin: t.jewelryItems.origin,
  // OPN-2: which selling rate prices the piece (NEW or USED).
  rateKind: t.jewelryItems.rateKind,
  acquisitionCost: t.jewelryItems.acquisitionCost,
  makingCharge: t.jewelryItems.makingCharge,
  costIsEstimated: t.jewelryItems.costIsEstimated,
  supplierInvoiceRef: t.jewelryItems.supplierInvoiceRef,
  sellingPrice: t.jewelryItems.sellingPrice,
  branchId: t.jewelryItems.branchId,
  branchCode: t.branches.code,
  branchName: t.branches.name,
  branchNameAr: t.branches.nameAr,
  status: t.jewelryItems.status,
  createdAt: t.jewelryItems.createdAt,
  updatedAt: t.jewelryItems.updatedAt,
};

/**
 * The item list query. PRC-1: `sellingPrice` is the piece's LIVE price under the pricing mode (computed from the
 * current rate of its karat and kind, NULL without a rate; or the stored tag price) and `pricePerGram` the rate that
 * priced it (NULL with tag prices or without a rate).
 */
export function itemQuery(exec: Executor, p: Pricing) {
  return exec
    .select({ ...itemColumns, sellingPrice: livePriceSql(p), pricePerGram: liveRateSql(p) })
    .from(t.jewelryItems)
    .leftJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .innerJoin(t.categories, eq(t.categories.id, t.jewelryItems.categoryId))
    .innerJoin(t.branches, eq(t.branches.id, t.jewelryItems.branchId))
    .leftJoin(t.purchaseItems, eq(t.purchaseItems.itemId, t.jewelryItems.id));
}

export async function lockItems(exec: Executor, ids: number[]): Promise<ItemRow[]> {
  if (!ids.length) return [];
  // Locks are always taken in id order so two transactions locking overlapping sets cannot deadlock.
  const rowsAll = await exec.select().from(t.jewelryItems).where(inArray(t.jewelryItems.id, ids)).orderBy(t.jewelryItems.id).for('update');
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
}

/** Atomic, guarded status transition + lifecycle history row. */
export async function changeStatus(exec: Executor, c: StatusChange): Promise<ItemRow> {
  const at = c.at ?? new Date();
  const set: Partial<ItemRow> = { status: c.to, updatedAt: at };
  if (c.branchId) set.branchId = c.branchId;
  const updated = await exec
    .update(t.jewelryItems)
    .set(set)
    .where(and(eq(t.jewelryItems.id, c.item.id), inArray(t.jewelryItems.status, c.from)))
    .returning();
  if (!updated.length) {
    const [cur] = await exec.select({ status: t.jewelryItems.status }).from(t.jewelryItems).where(eq(t.jewelryItems.id, c.item.id));
    throw conflict('Item {code} is {status} (expected {expected})', { code: c.item.code, status: cur?.status ?? 'MISSING', expected: c.from.join(' / ') }, {
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
  item: Pick<ItemRow, 'id' | 'netWeightMg' | 'acquisitionCost'>;
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
    costValue: m.item.acquisitionCost,
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
      // OPN-1: the cost of the pieces of known cost; `unknownCostPieces` counts the others on hand.
      cost: sql<number>`coalesce(sum(${t.inventoryMovements.direction} * ${t.inventoryMovements.costValue}), 0)`,
      unknownCostPieces: sql<number>`coalesce(sum(${t.inventoryMovements.direction}) filter (where ${t.inventoryMovements.costValue} is null), 0)`,
    })
    .from(t.inventoryMovements)
    .where(
      and(
        branchId != null ? eq(t.inventoryMovements.branchId, branchId) : undefined,
        sql`${t.inventoryMovements.at} < ${at.toISOString()}`,
      ),
    );
  return { items: Number(res[0].items), weightMg: Number(res[0].weightMg), cost: Number(res[0].cost), unknownCostPieces: Number(res[0].unknownCostPieces) };
}
