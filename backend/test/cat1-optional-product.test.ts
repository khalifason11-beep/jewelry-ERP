// CAT-1 (plan docs/plans/OPN-1.md §3, D-dec1-2): a piece is a type + a free-text description + karat + weights; the
// product is optional on every stock entry. Both projects.
//   * a supplier order line and a sellable scrap piece without a product: the piece has its type, karat and
//     description, and appears everywhere (inventory list and detail, search by description, purchase detail, sale,
//     invoice, transfer); a product given fixes the type and karat (a different one refused); a deactivated type and a
//     missing type are refused;
//   * description suggestions: the descriptions already used for a type, most used first;
//   * renaming a type (General Manager only; a duplicate 409): the sale lines keep the names they had (sale detail,
//     printed invoice, profit report by type); new sales and the inventory show the new name.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../src/bootstrap';
import type { Actor, Ctx } from '../src/core/context';
import { dayKey } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { createCategory, createProduct, descriptionSuggestions, renameCategory, setCategoryActive } from '../src/modules/catalog/service';
import { createPurchase, getPurchase, type PurchaseLine } from '../src/modules/purchases/service';
import { buyScrap } from '../src/modules/scrap/service';
import { createSale, getSale } from '../src/modules/sales/service';
import { printSale } from '../src/modules/print/service';
import { getItemDetail, pageItems } from '../src/modules/inventory/service';
import { runReport } from '../src/modules/reports/service';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let bm: Actor;
let cashier: Actor;
let krt: number;
let supplierId: number;
let today: string;
let fixedTag = true;
let typeA: { id: number; nameAr: string };
let refSeq = 0;

const actorOf = async (username: string) => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string }) => e);
const line = (extra: Partial<PurchaseLine>): PurchaseLine => ({ grossWeightMg: 4_100, netWeightMg: 4_000, purchaseCost: 700_000, makingCost: 20_000, otherCost: 0, ...(fixedTag ? { sellingPrice: 1_500_000 } : {}), ...extra });
const order = (lines: PurchaseLine[]) =>
  createPurchase(ctx, gm, { confirmOpenSupplierDebt: true, branchId: krt, supplierId, lines, makingChargeReference: `CAT1-REF-${++refSeq}`, makingChargeTransferDate: today });
const itemByCode = async (code: string) => (await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.code, code)))[0];

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  gm = await actorOf('general.manager');
  bm = await actorOf('branch.manager.kh');
  cashier = await actorOf('cashier.kh.01');
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  supplierId = (await ctx.db.select().from(t.suppliers))[0].id;
  const settings = await ctx.settings.get();
  today = dayKey(new Date(), settings.company.timezone);
  fixedTag = settings.pricing.mode === 'FIXED_TAG';
  typeA = await createCategory(ctx, gm, { nameAr: '[اختبار] خاتم بلا منتج', name: '[Test] Ring no product' });
});
afterAll(async () => handle?.close());

describe('stock without a product', () => {
  it('a supplier order line: type + karat + description; the piece appears in the list, the detail, the search and the purchase', async () => {
    const po = await order([line({ categoryId: typeA.id, karat: 21, description: 'خاتم قديم رقم 77' })]);
    const item = await itemByCode(po.itemCodes[0]);
    expect([item.productId, item.categoryId, item.karat, item.description]).toEqual([null, typeA.id, 21, 'خاتم قديم رقم 77']);
    const listed = (await pageItems(ctx, gm, { branchId: krt, q: 'رقم 77' })).rows;
    expect(listed.map((r) => r.code)).toEqual([item.code]);
    expect(listed[0]).toMatchObject({ productNameAr: 'خاتم قديم رقم 77', categoryNameAr: typeA.nameAr, categoryId: typeA.id, sku: null });
    expect((await getItemDetail(ctx, gm, item.id)).item).toMatchObject({ code: item.code, productNameAr: 'خاتم قديم رقم 77' });
    expect((await pageItems(ctx, gm, { branchId: krt, categoryId: typeA.id })).rows.map((r) => r.code)).toContain(item.code);
    expect((await getPurchase(ctx, gm, po.id)).items[0]).toMatchObject({ code: item.code, productNameAr: 'خاتم قديم رقم 77', categoryId: typeA.id });
  });

  it('without a description the piece is named by its type; sold, its invoice line has the type name', async () => {
    const po = await order([line({ categoryId: typeA.id, karat: 21 })]);
    const code = po.itemCodes[0];
    const listed = (await pageItems(ctx, gm, { branchId: krt, q: code })).rows[0];
    expect(listed.productNameAr).toBe(typeA.nameAr);
    const item = await itemByCode(code);
    const sale = await createSale(ctx, cashier, { items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    const detail = await getSale(ctx, gm, sale.id);
    expect(detail.items[0]).toMatchObject({ productNameAr: typeA.nameAr, categoryNameAr: typeA.nameAr, description: null });
    expect((await printSale(ctx, gm, sale.id)).document.lines[0]).toMatchObject({ code, nameAr: typeA.nameAr });
  });

  it('a product still works (its type and karat); a different type or karat with it is refused', async () => {
    const product = await createProduct(ctx, gm, { nameAr: '[اختبار] منتج قط١', karat: 21, categoryId: typeA.id });
    const po = await order([line({ productId: product.id })]);
    const item = await itemByCode(po.itemCodes[0]);
    expect([item.productId, item.categoryId, item.karat]).toEqual([product.id, typeA.id, 21]);
    const other = (await ctx.db.select().from(t.categories).where(and(eq(t.categories.isActive, true)))).find((c) => c.id !== typeA.id)!;
    expect((await err(order([line({ productId: product.id, categoryId: other.id })])))?.status).toBe(400);
    expect((await err(order([line({ productId: product.id, karat: 18 })])))?.status).toBe(400);
  });

  it('refused: no type, no karat, a deactivated type, a description over 120 characters', async () => {
    expect((await err(order([line({ karat: 21 })])))?.key).toBe('Choose the item type');
    expect((await err(order([line({ categoryId: typeA.id })])))?.key).toBe('Choose the karat');
    expect((await err(order([line({ categoryId: typeA.id, karat: 21, description: 'x'.repeat(121) })])))?.status).toBe(400);
    const off = await createCategory(ctx, gm, { nameAr: '[اختبار] نوع موقوف قط١' });
    await setCategoryActive(ctx, gm, off.id, false, 'test');
    expect((await err(order([line({ categoryId: off.id, karat: 21 })])))?.status).toBe(400);
  });

  it('a sellable scrap piece without a product: its type and description', async () => {
    const p = await buyScrap(ctx, bm, { branchId: krt, kind: 'SELLABLE', karat: 21, grossWeightMg: 3_100, netWeightMg: 3_000, categoryId: typeA.id, description: 'خاتم مستعمل', paymentMethod: 'CASH', ...(fixedTag ? { sellingPrice: 900_000 } : {}) });
    const item = await itemByCode(p.itemCode!);
    expect([item.productId, item.categoryId, item.description, item.origin]).toEqual([null, typeA.id, 'خاتم مستعمل', 'SCRAP']);
    expect((await err(buyScrap(ctx, bm, { branchId: krt, kind: 'SELLABLE', karat: 21, grossWeightMg: 3_100, netWeightMg: 3_000, paymentMethod: 'CASH' })))?.key).toBe('Choose the item type');
    expect((await err(buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 1_000, netWeightMg: 1_000, categoryId: typeA.id, paymentMethod: 'CASH' })))?.status).toBe(400);
  });

  it('description suggestions: those already used for the type, most used first', async () => {
    await order([line({ categoryId: typeA.id, karat: 21, description: 'دبلة' }), line({ categoryId: typeA.id, karat: 21, description: 'دبلة' }), line({ categoryId: typeA.id, karat: 21, description: 'دبلة محفورة' })]);
    const all = await descriptionSuggestions(ctx, { categoryId: typeA.id });
    expect(all.indexOf('دبلة')).toBeLessThan(all.indexOf('دبلة محفورة'));
    expect(await descriptionSuggestions(ctx, { categoryId: typeA.id, q: 'محفورة' })).toEqual(['دبلة محفورة']);
  });
});

describe('renaming a type', () => {
  it('old sale lines keep their names (detail, invoice, profit report by type); new sales and the stock show the new name', async () => {
    const type = await createCategory(ctx, gm, { nameAr: '[اختبار] سوار قبل', name: '[Test] Bangle before' });
    const po = await order([line({ categoryId: type.id, karat: 21 }), line({ categoryId: type.id, karat: 21 })]);
    const [a, b] = await Promise.all(po.itemCodes.map(itemByCode));
    const oldSale = await createSale(ctx, cashier, { items: [{ itemId: a.id }], paymentMethod: 'CASH' });
    const report = async () => (await runReport(ctx, gm, 'profit', { group: 'category', from: today, to: today })).rows as { label: string; labelAr?: string; salesCount: number }[];
    const before = await report();
    expect(before.find((r) => r.labelAr === '[اختبار] سوار قبل')).toBeTruthy();

    expect((await err(renameCategory(ctx, bm, type.id, { nameAr: '[اختبار] سوار بعد' })))?.status).toBe(403);
    expect((await err(renameCategory(ctx, gm, type.id, { nameAr: typeA.nameAr })))?.status).toBe(409);
    await renameCategory(ctx, gm, type.id, { nameAr: '[اختبار] سوار بعد', name: '[Test] Bangle after' });

    const detail = await getSale(ctx, gm, oldSale.id);
    expect(detail.items[0]).toMatchObject({ categoryNameAr: '[اختبار] سوار قبل', categoryName: '[Test] Bangle before', productNameAr: '[اختبار] سوار قبل' });
    expect((await printSale(ctx, gm, oldSale.id)).document.lines[0].nameAr).toBe('[اختبار] سوار قبل');
    expect(await report()).toEqual(before);

    const newSale = await createSale(ctx, cashier, { items: [{ itemId: b.id }], paymentMethod: 'CASH' });
    expect((await getSale(ctx, gm, newSale.id)).items[0]).toMatchObject({ categoryNameAr: '[اختبار] سوار بعد' });
    const audit = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'ITEM_TYPE_RENAMED'));
    expect(audit.at(-1)?.metadata).toMatchObject({ before: { nameAr: '[اختبار] سوار قبل' }, after: { nameAr: '[اختبار] سوار بعد' } });
  });
});
