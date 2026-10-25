import { ap } from '@jerp/shared';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { ItemOrigin, ItemStatus } from '@jerp/shared';
import { assertSellableKarat } from '../../core/karats';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import { changeStatus, itemQuery, lockItems, recordMovement } from './ledger';
import { maxIdOf, runPaged, sumOf, type PageRequest, type SortSpec } from '../../core/paging';
import { livePriceSql, pricingOf, type Pricing } from '../pricing/service';

const COST_FIELDS = ['purchaseCost', 'makingCost', 'otherCost', 'totalCost', 'acquisitionCost', 'makingCharge', 'costIsEstimated'] as const;

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
  /** Item type id (CAT-0: generated type codes are not used as filters). */
  categoryId?: number;
  status?: ItemStatus[];
  minWeightMg?: number;
  maxWeightMg?: number;
  /** New (supplier) or sellable scrap; omitted = both (Phase 4). */
  origin?: ItemOrigin;
  sort?: 'code' | 'weight' | 'price' | 'recent' | 'closest';
  targetWeightMg?: number;
  limit?: number;
  offset?: number;
}

/** The filters of the inventory list (branch scope and the counter staff's "sellable only" included). */
function itemsWhere(actor: Actor, s: Omit<ItemSearch, 'sort' | 'limit' | 'offset'>): SQL[] {
  requireAny(actor, 'inventory.view', 'inventory.view_available');
  const scope = branchScope(actor, s.branchId);
  const fullView = can(actor, 'inventory.view');
  // Counter staff only see sellable stock of their branch.
  const statuses = fullView ? s.status : (s.status ?? ['AVAILABLE']).filter((x) => x === 'AVAILABLE');

  const where: SQL[] = [];
  if (scope != null) where.push(eq(t.jewelryItems.branchId, scope));
  // A counter request for a status it may not see keeps an empty status list: no rows, never all rows.
  if (statuses) where.push(statuses.length ? inArray(t.jewelryItems.status, statuses) : sql`false`);
  if (s.karat) where.push(eq(t.jewelryItems.karat, s.karat));
  if (s.categoryId) where.push(eq(t.categories.id, s.categoryId));
  if (s.minWeightMg) where.push(sql`${t.jewelryItems.netWeightMg} >= ${s.minWeightMg}`);
  if (s.maxWeightMg) where.push(sql`${t.jewelryItems.netWeightMg} <= ${s.maxWeightMg}`);
  if (s.origin) where.push(eq(t.jewelryItems.origin, s.origin));
  if (s.q?.trim()) {
    const q = `%${s.q.trim()}%`;
    where.push(
      or(
        ilike(t.jewelryItems.code, q),
        ilike(t.jewelryItems.barcode, q),
        // CAT-1: the free-text description (an old shop number may be written there) and the type's names.
        ilike(t.jewelryItems.description, q),
        ilike(t.categories.nameAr, q),
        ilike(t.products.name, q),
        ilike(t.products.nameAr, q),
        ilike(t.products.sku, q),
        ilike(t.categories.name, q),
      )!,
    );
  }
  return where;
}

const countItems = (exec: Ctx['db'], where: SQL | undefined) =>
  exec
    .select({ count: sql<number>`count(*)` })
    .from(t.jewelryItems)
    .leftJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .innerJoin(t.categories, eq(t.categories.id, t.jewelryItems.categoryId))
    .where(where);

/** The inventory report's rows on screen: at most `s.limit` (RPT-2: the report says when it is cut). */
export async function searchItems(ctx: Ctx, actor: Actor, s: ItemSearch & { limit: number }) {
  const where = itemsWhere(actor, s);
  const p = await pricingOf(ctx);
  const order =
    s.sort === 'weight'
      ? [asc(t.jewelryItems.netWeightMg)]
      : s.sort === 'price'
        ? [asc(livePriceSql(p))]
        : s.sort === 'recent'
          ? [desc(t.jewelryItems.createdAt)]
          : s.sort === 'closest' && s.targetWeightMg
            ? [sql`abs(${t.jewelryItems.netWeightMg} - ${s.targetWeightMg})`]
            : [asc(t.jewelryItems.code)];

  const rowsAll = await itemQuery(ctx.db, p)
    .where(where.length ? and(...where) : undefined)
    .orderBy(...order)
    .limit(s.limit)
    .offset(s.offset ?? 0);

  const [{ count }] = await countItems(ctx.db, where.length ? and(...where) : undefined);
  return { items: rowsAll.map((r) => redactCosts(actor, r)), total: Number(count) };
}

/**
 * RPT-2: the inventory report's totals over the WHOLE filtered result. Purchase cost is the supplier line's, or the
 * acquisition cost for a piece without one (as on the rows); cost sums for `profit.view` only.
 */
export async function itemsReportAggregates(ctx: Ctx, actor: Actor, s: Omit<ItemSearch, 'sort' | 'limit' | 'offset'>) {
  const where = itemsWhere(actor, s);
  const p = await pricingOf(ctx);
  const [r] = await ctx.db
    .select({
      // The same joins as the rows (itemQuery), so the count is the number of rows the report lists.
      n: sql<number>`count(*)`.mapWith(Number),
      netWeightMg: sumOf(t.jewelryItems.netWeightMg),
      purchaseCost: sumOf(sql`coalesce(${t.purchaseItems.purchaseCost}, ${t.jewelryItems.acquisitionCost})`),
      totalCost: sumOf(t.jewelryItems.acquisitionCost),
      // OPN-1: the cost sums cover the pieces of known cost; this counts the others.
      unknownCostPieces: sql<number>`count(*) filter (where ${t.jewelryItems.acquisitionCost} is null)`.mapWith(Number),
      // PRC-1: the live price (a piece without a rate adds nothing; it shows "no rate" on its row).
      sellingPrice: sumOf(livePriceSql(p)),
    })
    .from(t.jewelryItems)
    .leftJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .innerJoin(t.categories, eq(t.categories.id, t.jewelryItems.categoryId))
    .innerJoin(t.branches, eq(t.branches.id, t.jewelryItems.branchId))
    .leftJoin(t.purchaseItems, eq(t.purchaseItems.itemId, t.jewelryItems.id))
    .where(where.length ? and(...where) : undefined);
  const totals: Record<string, number> = can(actor, 'profit.view')
    ? { netWeightMg: r.netWeightMg, purchaseCost: r.purchaseCost, totalCost: r.totalCost, unknownCostPieces: r.unknownCostPieces, sellingPrice: r.sellingPrice }
    : { netWeightMg: r.netWeightMg, sellingPrice: r.sellingPrice };
  return { rowCount: r.n, totals };
}

export const ITEM_SORT_KEYS = ['code', 'weight', 'price', 'recent', 'closest', 'karat', 'cost'] as const;
export type ItemSortKey = (typeof ITEM_SORT_KEYS)[number];
const itemSorts = (p: Pricing, targetWeightMg?: number): Record<ItemSortKey, SortSpec> => ({
  code: { by: t.jewelryItems.code, field: 'code', dir: 'asc' },
  weight: { by: t.jewelryItems.netWeightMg, field: 'netWeightMg', dir: 'asc' },
  // PRC-1: by the live price (pieces without a rate last ascending, PostgreSQL's NULL order).
  price: { by: livePriceSql(p), field: 'sellingPrice', dir: 'asc' },
  recent: { by: t.jewelryItems.createdAt, field: 'createdAt', dir: 'desc' },
  // Closest to a target weight (POS); without a target it is the weight order.
  closest: { by: targetWeightMg ? sql`abs(${t.jewelryItems.netWeightMg} - ${targetWeightMg})` : t.jewelryItems.netWeightMg, field: 'netWeightMg', dir: 'asc' },
  karat: { by: t.jewelryItems.karat, field: 'karat', dir: 'asc' },
  // GM only (BE-7): ordering by cost would reveal it.
  cost: { by: t.jewelryItems.acquisitionCost, field: 'acquisitionCost', dir: 'desc' },
});

/** BE-7: the inventory list, one page at a time (`GET /inventory/items`). */
/** `withTotals: false`: no footer sums (the report's CSV walk reads rows only; RPT-2). */
export async function pageItems(ctx: Ctx, actor: Actor, s: Omit<ItemSearch, 'sort' | 'limit' | 'offset'> & PageRequest<ItemSortKey>, opts: { withTotals?: boolean } = {}) {
  const where = itemsWhere(actor, s);
  const p = await pricingOf(ctx);
  return runPaged(actor, s, {
    sorts: itemSorts(p, s.targetWeightMg),
    defaultSort: 'code',
    id: t.jewelryItems.id,
    where,
    maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.jewelryItems.id) }).from(t.jewelryItems))[0].m),
    count: async (w) => Number((await countItems(ctx.db, w))[0].count),
    rows: async ({ where: w, orderBy, limit, offset }) =>
      (await itemQuery(ctx.db, p).where(w).orderBy(...orderBy).limit(limit).offset(offset)).map((r) => redactCosts(actor, r)),
    totals: opts.withTotals === false ? undefined : async (w) => {
      const [s] = await ctx.db
        .select({
          netWeightMg: sumOf(t.jewelryItems.netWeightMg),
          sellingPrice: sumOf(livePriceSql(p)),
          totalCost: sumOf(t.jewelryItems.acquisitionCost),
          // OPN-1: pieces of unknown cost, left out of the cost total.
          unknownCostPieces: sql<number>`count(*) filter (where ${t.jewelryItems.acquisitionCost} is null)`.mapWith(Number),
        })
        .from(t.jewelryItems)
        .leftJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
        .innerJoin(t.categories, eq(t.categories.id, t.jewelryItems.categoryId))
        .where(w);
      return can(actor, 'profit.view') ? s : { netWeightMg: s.netWeightMg, sellingPrice: s.sellingPrice };
    },
  });
}

export async function getItemDetail(ctx: Ctx, actor: Actor, id: number) {
  requireAny(actor, 'inventory.view', 'inventory.view_available');
  const [item] = await itemQuery(ctx.db, await pricingOf(ctx)).where(eq(t.jewelryItems.id, id));
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
  // PRC-1 (D-prc1-1): with computed prices a piece's price follows the rates; nobody types one.
  if ((await pricingOf(ctx)).mode === 'RATE_COMPUTED') {
    throw new AppError(409, 'PRICE_FOLLOWS_RATES', 'Prices follow the rates: change the rate on the Prices screen');
  }
  if (newPrice <= 0) throw badRequest('Price must be positive');
  return ctx.db.transaction(async (tx) => {
    const [item] = await lockItems(tx, [id]);
    branchScope(actor, item.branchId);
    if (item.status !== 'AVAILABLE') throw badRequest('Cannot reprice an item with status {status}', { status: item.status });
    // Karat restriction (D-4-1): only a karat this deployment sells can be priced for sale.
    await assertSellableKarat(ctx, item.karat);
    await tx.update(t.jewelryItems).set({ sellingPrice: newPrice, updatedAt: new Date() }).where(eq(t.jewelryItems.id, id));
    await writeAudit(tx, actor, {
      action: 'PRICE_CHANGED',
      entityType: 'item',
      entityId: item.code,
      branchId: item.branchId,
      key: 'Selling price of {code} changed {from} → {to}. {reason}',
      params: { code: item.code, from: ap.money(item.sellingPrice), to: ap.money(newPrice), reason },
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
      key: '{action} — {code}: {reason}',
      params: { action: ap.enum(action), code: item.code, reason },
      metadata: { action, from: item.status },
    });
    return { ok: true };
  });
}
