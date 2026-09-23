import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { ItemStatus } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, notFound } from '../../core/errors';
import { changeStatus, itemQuery, lockItems, recordMovement } from './ledger';

const COST_FIELDS = ['purchaseCost', 'makingCost', 'otherCost', 'totalCost'] as const;

/** Users without `profit.view` never receive cost fields. */
export function redactCosts<T extends Record<string, unknown>>(actor: Actor, row: T): T {
  if (can(actor, 'profit.view')) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const f of COST_FIELDS) delete copy[f];
  return copy as T;
}

export interface ItemSearch {
  branchId?: number;
  q?: string;
  karat?: number;
  category?: string;
  status?: ItemStatus[];
  minWeightMg?: number;
  maxWeightMg?: number;
  sort?: 'code' | 'weight' | 'price' | 'recent' | 'closest';
  targetWeightMg?: number;
  limit?: number;
  offset?: number;
}

export async function searchItems(ctx: Ctx, actor: Actor, s: ItemSearch) {
  requireAny(actor, 'inventory.view', 'inventory.view_available');
  const scope = branchScope(actor, s.branchId);
  const fullView = can(actor, 'inventory.view');
  // Counter staff only see sellable (and reserved) stock of their branch.
  const statuses = fullView ? s.status : (s.status ?? ['AVAILABLE', 'RESERVED']).filter((x) => x === 'AVAILABLE' || x === 'RESERVED');

  const where: SQL[] = [];
  if (scope != null) where.push(eq(t.jewelryItems.branchId, scope));
  if (statuses?.length) where.push(inArray(t.jewelryItems.status, statuses));
  if (s.karat) where.push(eq(t.jewelryItems.karat, s.karat));
  if (s.category) where.push(eq(t.categories.code, s.category));
  if (s.minWeightMg) where.push(sql`${t.jewelryItems.netWeightMg} >= ${s.minWeightMg}`);
  if (s.maxWeightMg) where.push(sql`${t.jewelryItems.netWeightMg} <= ${s.maxWeightMg}`);
  if (s.q?.trim()) {
    const q = `%${s.q.trim()}%`;
    where.push(
      or(
        ilike(t.jewelryItems.code, q),
        ilike(t.jewelryItems.barcode, q),
        ilike(t.products.name, q),
        ilike(t.products.nameAr, q),
        ilike(t.products.sku, q),
        ilike(t.categories.name, q),
      )!,
    );
  }

  const order =
    s.sort === 'weight'
      ? [asc(t.jewelryItems.netWeightMg)]
      : s.sort === 'price'
        ? [asc(t.jewelryItems.sellingPrice)]
        : s.sort === 'recent'
          ? [desc(t.jewelryItems.createdAt)]
          : s.sort === 'closest' && s.targetWeightMg
            ? [sql`abs(${t.jewelryItems.netWeightMg} - ${s.targetWeightMg})`]
            : [asc(t.jewelryItems.code)];

  const limit = Math.min(s.limit ?? 500, 1000);
  const rowsAll = await itemQuery(ctx.db)
    .where(where.length ? and(...where) : undefined)
    .orderBy(...order)
    .limit(limit)
    .offset(s.offset ?? 0);

  const [{ count }] = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(t.jewelryItems)
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
    .where(where.length ? and(...where) : undefined);

  return { items: rowsAll.map((r) => redactCosts(actor, r)), total: Number(count) };
}

export async function getItemDetail(ctx: Ctx, actor: Actor, id: number) {
  requireAny(actor, 'inventory.view', 'inventory.view_available');
  const [item] = await itemQuery(ctx.db).where(eq(t.jewelryItems.id, id));
  if (!item) throw notFound('Item');
  branchScope(actor, item.branchId);
  if (!can(actor, 'inventory.view')) {
    return { item: redactCosts(actor, item), history: [], movements: [] };
  }
  const history = await ctx.db
    .select({
      id: t.itemStatusHistory.id,
      fromStatus: t.itemStatusHistory.fromStatus,
      toStatus: t.itemStatusHistory.toStatus,
      branchName: t.branches.name,
      refType: t.itemStatusHistory.refType,
      refId: t.itemStatusHistory.refId,
      refNumber: t.itemStatusHistory.refNumber,
      note: t.itemStatusHistory.note,
      at: t.itemStatusHistory.at,
      userName: t.users.fullName,
    })
    .from(t.itemStatusHistory)
    .innerJoin(t.branches, eq(t.branches.id, t.itemStatusHistory.branchId))
    .leftJoin(t.users, eq(t.users.id, t.itemStatusHistory.userId))
    .where(eq(t.itemStatusHistory.itemId, id))
    .orderBy(asc(t.itemStatusHistory.at), asc(t.itemStatusHistory.id));
  const movements = await ctx.db
    .select({
      id: t.inventoryMovements.id,
      type: t.inventoryMovements.type,
      direction: t.inventoryMovements.direction,
      branchName: t.branches.name,
      refType: t.inventoryMovements.refType,
      refId: t.inventoryMovements.refId,
      refNumber: t.inventoryMovements.refNumber,
      at: t.inventoryMovements.at,
      userName: t.users.fullName,
      note: t.inventoryMovements.note,
    })
    .from(t.inventoryMovements)
    .innerJoin(t.branches, eq(t.branches.id, t.inventoryMovements.branchId))
    .leftJoin(t.users, eq(t.users.id, t.inventoryMovements.userId))
    .where(eq(t.inventoryMovements.itemId, id))
    .orderBy(asc(t.inventoryMovements.at), asc(t.inventoryMovements.id));
  return { item: redactCosts(actor, item), history, movements };
}

export async function changePrice(ctx: Ctx, actor: Actor, id: number, newPrice: number, reason: string) {
  requirePerm(actor, 'inventory.price_edit');
  if (newPrice <= 0) throw badRequest('Price must be positive');
  return ctx.db.transaction(async (tx) => {
    const [item] = await lockItems(tx, [id]);
    branchScope(actor, item.branchId);
    if (!['AVAILABLE', 'RESERVED'].includes(item.status)) throw badRequest(`Cannot reprice a ${item.status} item`);
    await tx.update(t.jewelryItems).set({ sellingPrice: newPrice, updatedAt: new Date() }).where(eq(t.jewelryItems.id, id));
    await writeAudit(tx, actor, {
      action: 'PRICE_CHANGED',
      entityType: 'item',
      entityId: item.code,
      branchId: item.branchId,
      description: `Selling price of ${item.code} changed ${item.sellingPrice.toLocaleString()} → ${newPrice.toLocaleString()} SDG. ${reason}`,
      metadata: { from: item.sellingPrice, to: newPrice, reason },
    });
    return { ok: true };
  });
}

export type AdjustAction = 'MARK_DAMAGED' | 'RESTOCK' | 'RETURN_TO_SUPPLIER';

export async function adjustItem(ctx: Ctx, actor: Actor, id: number, action: AdjustAction, reason: string, opts: { at?: Date } = {}) {
  const at = opts.at ?? new Date();
  requirePerm(actor, 'inventory.adjust');
  if (!reason?.trim()) throw badRequest('A reason is required for inventory adjustments');
  return ctx.db.transaction(async (tx) => {
    const [item] = await lockItems(tx, [id]);
    branchScope(actor, item.branchId);
    const ref = { refType: 'adjustment', refId: item.id, refNumber: `ADJ-${item.code}` };
    if (action === 'MARK_DAMAGED') {
      await changeStatus(tx, { item, to: 'DAMAGED', from: ['AVAILABLE'], userId: actor.userId, ref, note: reason, at });
      await recordMovement(tx, { item, type: 'DAMAGE', branchId: item.branchId, ref, userId: actor.userId, note: reason, at });
    } else if (action === 'RESTOCK') {
      await changeStatus(tx, { item, to: 'AVAILABLE', from: ['DAMAGED'], userId: actor.userId, ref, note: reason, at });
      await recordMovement(tx, { item, type: 'ADJUSTMENT', direction: 1, branchId: item.branchId, ref, userId: actor.userId, note: reason, at });
    } else if (action === 'RETURN_TO_SUPPLIER') {
      await changeStatus(tx, { item, to: 'RETURNED', from: ['AVAILABLE', 'DAMAGED'], userId: actor.userId, ref, note: reason, at });
      if (item.status === 'AVAILABLE') {
        await recordMovement(tx, { item, type: 'ADJUSTMENT', direction: -1, branchId: item.branchId, ref, userId: actor.userId, note: `Returned to supplier: ${reason}`, at });
      }
    } else throw badRequest('Unknown adjustment');
    await writeAudit(tx, actor, {
      action: 'INVENTORY_ADJUSTMENT',
      entityType: 'item',
      entityId: item.code,
      branchId: item.branchId,
      at,
      description: `${action.replaceAll('_', ' ').toLowerCase()} — ${item.code}: ${reason}`,
      metadata: { action, from: item.status },
    });
    return { ok: true };
  });
}

export async function listCategories(ctx: Ctx) {
  return ctx.db.select().from(t.categories).orderBy(t.categories.id);
}

export async function listProducts(ctx: Ctx, actor: Actor) {
  requirePerm(actor, 'purchases.create');
  return ctx.db
    .select({ id: t.products.id, sku: t.products.sku, name: t.products.name, nameAr: t.products.nameAr, karat: t.products.karat, categoryCode: t.categories.code })
    .from(t.products)
    .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
    .orderBy(t.products.name);
}
