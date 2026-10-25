// Catalog entry (CAT-0, docs/decisions.md D-cat0-*): item types (table `categories`; the UI says
// "Type"), products and suppliers, created by the General Manager or a branch manager — also inline from
// the purchase forms — so an empty production database can receive stock. Only the General Manager
// deactivates or reactivates types and products (with a reason); nothing is ever deleted.
//
// Duplicates: the database computes a normalized Arabic name (jerp_normalize_name, migration 0015) into
// columns with unique indexes. The service looks for the existing row first so it can answer 409 with
// it (the dialog then simply selects it); a concurrent request that slips past the check is still
// stopped by the unique index and gets the same 409.

import { and, asc, eq, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { ap, cleanName, normalizeName } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { can, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { assertSellableKarat } from '../../core/karats';
import { badRequest, conflict, notFound } from '../../core/errors';
import { nextSeq } from '../../core/numbering';

export interface NameInput {
  nameAr: string;
  name?: string | null;
}

/** Arabic name required (2–80 characters after cleaning), English optional. */
function cleanNames(input: NameInput) {
  const nameAr = cleanName(input.nameAr);
  const name = cleanName(input.name) || null;
  if (nameAr.length < 2 || normalizeName(nameAr).length < 2) throw badRequest('Enter the Arabic name (at least 2 characters)');
  if (nameAr.length > 80 || (name?.length ?? 0) > 80) throw badRequest('A name can have at most 80 characters');
  return { nameAr, name };
}

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
};

const categoryColumns = {
  id: t.categories.id,
  code: t.categories.code,
  name: t.categories.name,
  nameAr: t.categories.nameAr,
  isActive: t.categories.isActive,
};
const productColumns = {
  id: t.products.id,
  sku: t.products.sku,
  name: t.products.name,
  nameAr: t.products.nameAr,
  karat: t.products.karat,
  categoryId: t.products.categoryId,
  categoryCode: t.categories.code,
  categoryName: t.categories.name,
  categoryNameAr: t.categories.nameAr,
  isActive: t.products.isActive,
};
const supplierColumns = { id: t.suppliers.id, name: t.suppliers.name, nameAr: t.suppliers.nameAr, phone: t.suppliers.phone };

// ───────────────────────── item types ─────────────────────────

/** Types for the forms (active only) or, for the General Manager, every type with its state. */
export async function listCategories(ctx: Ctx, actor: Actor | null, q: { includeInactive?: boolean } = {}) {
  const all = q.includeInactive && actor && can(actor, 'catalog.manage');
  return ctx.db
    .select(categoryColumns)
    .from(t.categories)
    .where(all ? undefined : eq(t.categories.isActive, true))
    .orderBy(asc(t.categories.nameAr), asc(t.categories.id));
}

async function categoryByNorm(exec: Executor, norm: string) {
  const [row] = await exec.select(categoryColumns).from(t.categories).where(eq(t.categories.nameArNorm, norm));
  return row ?? null;
}

export async function createCategory(ctx: Ctx, actor: Actor, input: NameInput) {
  requirePerm(actor, 'catalog.create');
  const { nameAr, name } = cleanNames(input);
  const norm = normalizeName(nameAr);
  const existing = await categoryByNorm(ctx.db, norm);
  if (existing) throw conflict('This type already exists: {name}', { name: existing.nameAr }, { existing });
  try {
    return await ctx.db.transaction(async (tx) => {
      const code = `T-${String(await nextSeq(tx, 'CATEGORY')).padStart(3, '0')}`;
      const [row] = await tx.insert(t.categories).values({ code, name, nameAr, createdBy: actor.userId }).returning(categoryColumns);
      await writeAudit(tx, actor, {
        action: 'ITEM_TYPE_CREATED',
        entityType: 'category',
        entityId: row.code,
        key: 'Item type {code} created: {name}',
        params: { code: row.code, name: ap.text(row.name, row.nameAr) },
      });
      return row;
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await categoryByNorm(ctx.db, norm);
    throw conflict('This type already exists: {name}', { name: row?.nameAr ?? nameAr }, { existing: row });
  }
}

/**
 * CAT-1 (D-cat0-3): the General Manager renames a type. Safe for the past: every sale line keeps the names it had at the
 * sale (snapshots, migration 0026/0027), so invoices, reprints and the profit report by type do not change. Duplicates
 * are refused after normalization (409), as for a new type. Audited with the old and the new names.
 */
export async function renameCategory(ctx: Ctx, actor: Actor, id: number, input: NameInput) {
  requirePerm(actor, 'catalog.manage');
  const { nameAr, name } = cleanNames(input);
  const norm = normalizeName(nameAr);
  try {
    return await ctx.db.transaction(async (tx) => {
      const [cur] = await tx.select(categoryColumns).from(t.categories).where(eq(t.categories.id, id)).for('update');
      if (!cur) throw notFound('Item type');
      const clash = await categoryByNorm(tx, norm);
      if (clash && clash.id !== id) throw conflict('This type already exists: {name}', { name: clash.nameAr }, { existing: clash });
      if (cur.nameAr === nameAr && (cur.name ?? null) === name) throw badRequest('The name is unchanged');
      const [row] = await tx.update(t.categories).set({ nameAr, name }).where(eq(t.categories.id, id)).returning(categoryColumns);
      await writeAudit(tx, actor, {
        action: 'ITEM_TYPE_RENAMED',
        entityType: 'category',
        entityId: row.code,
        key: 'Item type {code} renamed: {from} → {to}',
        params: { code: row.code, from: ap.text(cur.name, cur.nameAr), to: ap.text(row.name, row.nameAr) },
        metadata: { before: { nameAr: cur.nameAr, name: cur.name }, after: { nameAr: row.nameAr, name: row.name } },
      });
      return row;
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await categoryByNorm(ctx.db, norm);
    throw conflict('This type already exists: {name}', { name: row?.nameAr ?? nameAr }, { existing: row });
  }
}

export async function setCategoryActive(ctx: Ctx, actor: Actor, id: number, active: boolean, reason: string) {
  requirePerm(actor, 'catalog.manage');
  const why = cleanName(reason);
  if (why.length < 3) throw badRequest('A reason is required');
  return ctx.db.transaction(async (tx) => {
    const [cur] = await tx.select(categoryColumns).from(t.categories).where(eq(t.categories.id, id)).for('update');
    if (!cur) throw notFound('Item type');
    if (cur.isActive === active) return cur;
    const [row] = await tx.update(t.categories).set({ isActive: active }).where(eq(t.categories.id, id)).returning(categoryColumns);
    await writeAudit(tx, actor, {
      action: active ? 'ITEM_TYPE_REACTIVATED' : 'ITEM_TYPE_DEACTIVATED',
      entityType: 'category',
      entityId: row.code,
      key: active ? 'Item type {code} ({name}) reactivated: {reason}' : 'Item type {code} ({name}) deactivated: {reason}',
      params: { code: row.code, name: ap.text(row.name, row.nameAr), reason: why },
    });
    return row;
  });
}

// ───────────────────────── products ─────────────────────────

/** Products for the forms (active only, optionally one karat) or, for the General Manager, all of them. */
export async function listProducts(ctx: Ctx, actor: Actor, q: { includeInactive?: boolean; karat?: number } = {}) {
  const all = q.includeInactive && can(actor, 'catalog.manage');
  const where = [all ? undefined : and(eq(t.products.isActive, true), eq(t.categories.isActive, true)), q.karat ? eq(t.products.karat, q.karat) : undefined].filter(Boolean);
  return ctx.db
    .select(productColumns)
    .from(t.products)
    .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(t.products.nameAr), asc(t.products.karat), asc(t.products.id));
}

async function productByKey(exec: Executor, norm: string, karat: number, categoryId: number) {
  const [row] = await exec
    .select(productColumns)
    .from(t.products)
    .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
    .where(and(eq(t.products.nameArNorm, norm), eq(t.products.karat, karat), eq(t.products.categoryId, categoryId)));
  return row ?? null;
}

export async function createProduct(ctx: Ctx, actor: Actor, input: NameInput & { karat: number; categoryId: number }) {
  requirePerm(actor, 'catalog.create');
  const { nameAr, name } = cleanNames(input);
  // A product is a sellable design: its karat must be one the business sells (D-4-1).
  await assertSellableKarat(ctx, input.karat);
  const [category] = await ctx.db.select(categoryColumns).from(t.categories).where(eq(t.categories.id, input.categoryId));
  if (!category) throw notFound('Item type');
  if (!category.isActive) throw badRequest('This type is deactivated');
  const norm = normalizeName(nameAr);
  const existing = await productByKey(ctx.db, norm, input.karat, input.categoryId);
  if (existing) throw conflict('This product already exists: {name}', { name: existing.nameAr }, { existing });
  try {
    return await ctx.db.transaction(async (tx) => {
      const sku = `P-${String(await nextSeq(tx, 'PRODUCT')).padStart(6, '0')}`;
      const [created] = await tx
        .insert(t.products)
        .values({ sku, name, nameAr, karat: input.karat, categoryId: input.categoryId, createdBy: actor.userId })
        .returning({ id: t.products.id });
      const [row] = await tx
        .select(productColumns)
        .from(t.products)
        .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
        .where(eq(t.products.id, created.id));
      await writeAudit(tx, actor, {
        action: 'PRODUCT_CREATED',
        entityType: 'product',
        entityId: row.sku,
        key: 'Product {code} created: {name}, {karat}, type {type}',
        params: { code: row.sku, name: ap.text(row.name, row.nameAr), karat: ap.karat(row.karat), type: ap.text(row.categoryName, row.categoryNameAr) },
      });
      return row;
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await productByKey(ctx.db, norm, input.karat, input.categoryId);
    throw conflict('This product already exists: {name}', { name: row?.nameAr ?? nameAr }, { existing: row });
  }
}

export async function setProductActive(ctx: Ctx, actor: Actor, id: number, active: boolean, reason: string) {
  requirePerm(actor, 'catalog.manage');
  const why = cleanName(reason);
  if (why.length < 3) throw badRequest('A reason is required');
  return ctx.db.transaction(async (tx) => {
    const [cur] = await tx.select({ id: t.products.id, isActive: t.products.isActive }).from(t.products).where(eq(t.products.id, id)).for('update');
    if (!cur) throw notFound('Product');
    if (cur.isActive !== active) await tx.update(t.products).set({ isActive: active }).where(eq(t.products.id, id));
    const [row] = await tx.select(productColumns).from(t.products).innerJoin(t.categories, eq(t.categories.id, t.products.categoryId)).where(eq(t.products.id, id));
    if (cur.isActive === active) return row;
    await writeAudit(tx, actor, {
      action: active ? 'PRODUCT_REACTIVATED' : 'PRODUCT_DEACTIVATED',
      entityType: 'product',
      entityId: row.sku,
      key: active ? 'Product {code} ({name}) reactivated: {reason}' : 'Product {code} ({name}) deactivated: {reason}',
      params: { code: row.sku, name: ap.text(row.name, row.nameAr), reason: why },
    });
    return row;
  });
}

/**
 * A product chosen for NEW stock (supplier purchase or sellable scrap) must be active and of an active
 * type; pieces already in stock are never affected by a deactivation.
 */
export async function assertProductsUsable(exec: Executor, productIds: number[]) {
  if (!productIds.length) return;
  const rows = await exec
    .select({ id: t.products.id, isActive: t.products.isActive, categoryActive: t.categories.isActive, nameAr: t.products.nameAr })
    .from(t.products)
    .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
    .where(sql`${t.products.id} IN ${productIds}`);
  for (const r of rows) {
    if (!r.isActive || !r.categoryActive) throw badRequest('{name} is deactivated and cannot receive new stock', { name: r.nameAr });
  }
}

// ───────────────────────── CAT-1: what a piece is ─────────────────────────

/** A new piece as typed: a type + an optional description + a karat; a product may still be named (optional). */
export interface PieceKindInput {
  productId?: number | null;
  categoryId?: number | null;
  karat?: number | null;
  description?: string | null;
}

export interface PieceKind {
  productId: number | null;
  categoryId: number;
  karat: number;
  description: string | null;
}

/** CAT-1: the description of a piece: trimmed, empty = none, at most 120 characters. */
export function cleanDescription(raw: string | null | undefined): string | null {
  const d = cleanName(raw ?? '');
  if (!d) return null;
  if ([...d].length > 120) throw badRequest('A description can have at most 120 characters');
  return d;
}

/**
 * CAT-1 (D-dec1-2): resolve the pieces of a stock entry (supplier order, sellable scrap, opening). With a product, the
 * type and the karat are the product's (a different one sent is refused); without, the type and the karat are required.
 * The type (and the product) must be active: deactivated ones receive no new stock. The karat check (allowed karats)
 * is the caller's, as before.
 */
export async function resolvePieceKinds(exec: Executor, inputs: PieceKindInput[]): Promise<PieceKind[]> {
  const productIds = [...new Set(inputs.map((i) => i.productId).filter((x): x is number => x != null))];
  const products = productIds.length ? await exec.select({ id: t.products.id, karat: t.products.karat, categoryId: t.products.categoryId }).from(t.products).where(sql`${t.products.id} IN ${productIds}`) : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  await assertProductsUsable(exec, productIds);
  const kinds = inputs.map((i): PieceKind => {
    const description = cleanDescription(i.description);
    if (i.productId != null) {
      const p = productById.get(i.productId);
      if (!p) throw notFound('Product');
      if (i.categoryId != null && i.categoryId !== p.categoryId) throw badRequest('The product is of another type');
      if (i.karat != null && i.karat !== p.karat) throw badRequest('The product is {pkarat}K but the piece is {karat}K', { pkarat: p.karat, karat: i.karat });
      return { productId: p.id, categoryId: p.categoryId, karat: p.karat, description };
    }
    if (i.categoryId == null) throw badRequest('Choose the item type');
    if (i.karat == null) throw badRequest('Choose the karat');
    return { productId: null, categoryId: i.categoryId, karat: i.karat, description };
  });
  const categoryIds = [...new Set(kinds.map((k) => k.categoryId))];
  const cats = await exec.select({ id: t.categories.id, isActive: t.categories.isActive, nameAr: t.categories.nameAr }).from(t.categories).where(sql`${t.categories.id} IN ${categoryIds}`);
  const catById = new Map(cats.map((c) => [c.id, c]));
  for (const id of categoryIds) {
    const c = catById.get(id);
    if (!c) throw notFound('Item type');
    if (!c.isActive) throw badRequest('{name} is deactivated and cannot receive new stock', { name: c.nameAr });
  }
  return kinds;
}

/**
 * CAT-1: descriptions already used for a type (the suggestions of the free-text field), most used first, at most 20.
 */
export async function descriptionSuggestions(ctx: Ctx, q: { categoryId?: number; q?: string }) {
  const where = [sql`${t.jewelryItems.description} IS NOT NULL`];
  if (q.categoryId) where.push(sql`${t.jewelryItems.categoryId} = ${q.categoryId}`);
  if (q.q?.trim()) where.push(sql`${t.jewelryItems.description} ILIKE ${`%${q.q.trim()}%`}`);
  const rows = await ctx.db
    .select({ description: t.jewelryItems.description, uses: sql<number>`count(*)`.mapWith(Number) })
    .from(t.jewelryItems)
    .where(and(...where))
    .groupBy(t.jewelryItems.description)
    .orderBy(sql`count(*) DESC`, asc(t.jewelryItems.description))
    .limit(20);
  return rows.map((r) => r.description as string);
}

// ───────────────────────── suppliers ─────────────────────────

export async function listSuppliers(ctx: Ctx) {
  return ctx.db.select(supplierColumns).from(t.suppliers).orderBy(asc(t.suppliers.nameAr), asc(t.suppliers.id));
}

async function supplierByNorm(exec: Executor, norm: string) {
  const [row] = await exec.select(supplierColumns).from(t.suppliers).where(eq(t.suppliers.nameNorm, norm));
  return row ?? null;
}

export async function createSupplier(ctx: Ctx, actor: Actor, input: NameInput & { phone?: string | null }) {
  requirePerm(actor, 'catalog.create');
  const { nameAr, name } = cleanNames(input);
  const phone = cleanName(input.phone) || null;
  const norm = normalizeName(nameAr);
  const existing = await supplierByNorm(ctx.db, norm);
  if (existing) throw conflict('This supplier already exists: {name}', { name: existing.nameAr ?? existing.name }, { existing });
  try {
    return await ctx.db.transaction(async (tx) => {
      const [row] = await tx.insert(t.suppliers).values({ name, nameAr, phone, createdBy: actor.userId }).returning(supplierColumns);
      await writeAudit(tx, actor, {
        action: 'SUPPLIER_CREATED',
        entityType: 'supplier',
        entityId: row.id,
        key: 'Supplier created: {name}',
        params: { name: ap.text(row.name, row.nameAr) },
      });
      return row;
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await supplierByNorm(ctx.db, norm);
    throw conflict('This supplier already exists: {name}', { name: row?.nameAr ?? nameAr }, { existing: row });
  }
}
