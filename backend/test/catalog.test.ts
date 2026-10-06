// CAT-0: item types, products and suppliers entered by people (docs/decisions.md D-cat0-*), so an
// empty production database can receive stock. Runs on PGlite AND real PostgreSQL.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fc from 'fast-check';
import { and, count, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { displayName, normalizeName } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { rows } from '../src/core/sql';
import { resetThrottleMemory } from '../src/auth/lockout';
import { bootstrapProduction } from '../src/modules/bootstrap/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS, keys = true): Promise<Agent> {
  const agent = keys ? withIdempotencyKeys(request.agent(app)) : request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const sqlNormalize = async (s: string) => rows<{ n: string }>(await ctx.db.execute(sql`SELECT jerp_normalize_name(${s}) AS n`))[0].n;
const line = (productId: number, net = 4_000) => ({ productId, grossWeightMg: net + 100, netWeightMg: net, purchaseCost: 1_000_000, makingCost: 50_000, otherCost: 0, sellingPrice: 1_500_000 });

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle.close());
beforeEach(() => resetThrottleMemory());

// ───────────────────────── normalization ─────────────────────────
// Characters people actually type differently: alef variants, ى/ي, tatweel, diacritics, zero-width marks,
// Arabic-Indic digits, presentation forms, Latin case and assorted spaces.
const ALPHABET = [
  'ا', 'أ', 'إ', 'آ', 'ٱ', 'ب', 'ت', 'ة', 'ه', 'ى', 'ي', 'خ', 'م', 'ل', 'ـ', 'َ', 'ُ', 'ِ', 'ّ', 'ْ', 'ٰ',
  '٠', '١', '٢', '۱', '۲', '0', '1', '2', 'ﻻ', 'ﺍ', 'A', 'b', 'G', 'z', ' ', '  ', '\t', ' ',
  String.fromCodePoint(0x200b), String.fromCodePoint(0x200c), String.fromCodePoint(0x200d), String.fromCodePoint(0x200e), String.fromCodePoint(0x200f), String.fromCodePoint(0xfeff),
];
const typed = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 18 }).map((a) => a.join(''));
// Invisible noise only: a space between two letters separates words, so it is not noise (spaces are
// tested as padding and as runs below).
const NOISE = ['ـ', String.fromCodePoint(0x200b), String.fromCodePoint(0x200c), String.fromCodePoint(0x200d), String.fromCodePoint(0x200e), String.fromCodePoint(0x200f), String.fromCodePoint(0xfeff)];

describe('name normalization (shared/src/names.ts = jerp_normalize_name)', () => {
  it('is idempotent', () => {
    fc.assert(fc.property(typed, (s) => normalizeName(normalizeName(s)) === normalizeName(s)), { numRuns: 2_000 });
  });

  it('two spellings that differ only by zero-width marks, tatweel, spaces or the digit script collide', () => {
    const arabicDigits = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCodePoint(0x0660 + Number(d)));
    const easternDigits = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCodePoint(0x06f0 + Number(d)));
    fc.assert(
      fc.property(fc.array(fc.constantFrom('خ', 'ا', 'ت', 'م', 'ل', 'س', 'ة', 'ه', '2', '1', ' '), { minLength: 1, maxLength: 10 }), fc.array(fc.constantFrom(...NOISE), { maxLength: 10 }), (letters, noise) => {
        const plain = letters.join('');
        const noisy = ' \t' + letters.map((c, i) => (c === ' ' ? '   ' : c + (noise[i] ?? ''))).join('') + '  ';
        return normalizeName(noisy) === normalizeName(plain) && normalizeName(arabicDigits(plain)) === normalizeName(plain) && normalizeName(easternDigits(plain)) === normalizeName(plain);
      }),
      { numRuns: 2_000 },
    );
    expect(normalizeName('أساور')).toBe(normalizeName('اساور'));
    expect(normalizeName('سلسلـــة')).toBe(normalizeName('سلسلة'));
    expect(normalizeName('مَحْبَس')).toBe(normalizeName('محبس'));
    expect(normalizeName('حلق ٢١')).toBe(normalizeName('حلق 21'));
    expect(normalizeName('Gold  RING')).toBe('gold ring');
    // Owner decision: ة and ه stay distinct.
    expect(normalizeName('سلسلة')).not.toBe(normalizeName('سلسله'));
  });

  it('the TypeScript helper gives exactly what the database computes', async () => {
    await fc.assert(fc.asyncProperty(typed, async (s) => (await sqlNormalize(s)) === normalizeName(s)), { numRuns: 300 });
  });

  it('display names fall back to the Arabic one when the English name is empty', () => {
    expect(displayName('en', null, 'محبس')).toBe('محبس');
    expect(displayName('en', '  ', 'محبس')).toBe('محبس');
    expect(displayName('en', 'Band', 'محبس')).toBe('Band');
    expect(displayName('ar', 'Band', 'محبس')).toBe('محبس');
  });
});

// ───────────────────────── item types and products ─────────────────────────
describe('item types and products', () => {
  it('a branch manager creates a type (Arabic required, English optional) with a generated code; cashiers cannot', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const res = await bm.post('/api/categories').send({ nameAr: 'محابس' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ nameAr: 'محابس', name: null, isActive: true });
    expect(res.body.code).toMatch(/^T-\d{3,}$/);
    expect((await bm.post('/api/categories').send({ name: 'Only English' })).status).toBe(400);
    expect((await bm.post('/api/categories').send({ nameAr: ' ' })).status).toBe(400);
    const cashier = await login('cashier.kh.01', 'CASHIER');
    expect((await cashier.post('/api/categories').send({ nameAr: 'غوايش' })).status).toBe(403);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'ITEM_TYPE_CREATED'), eq(t.auditLogs.entityId, res.body.code)));
    expect(audit.description).toContain('محابس'); // the English rendering falls back to the Arabic name
  });

  it('refuses a second spelling of the same type and returns the existing one', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const first = (await bm.post('/api/categories').send({ nameAr: 'أساور ذهب ٢١', name: 'Bangles' })).body;
    for (const variant of ['اساور ذهب 21', '  أساور   ذهب ۲۱ ', `أسـاور ذهب${String.fromCodePoint(0x200b)} ٢١`, 'أساوِر ذهب ٢١']) {
      const dup = await bm.post('/api/categories').send({ nameAr: variant });
      expect(dup.status, variant).toBe(409);
      expect(dup.body.error.details.existing).toMatchObject({ id: first.id, nameAr: 'أساور ذهب ٢١' });
    }
    // ة and ه stay distinct (owner decision).
    expect((await bm.post('/api/categories').send({ nameAr: 'سلسلة' })).status).toBe(200);
    expect((await bm.post('/api/categories').send({ nameAr: 'سلسله' })).status).toBe(200);
  });

  it('a product needs an allowed karat and an active type; duplicates per name + karat + type are refused', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const type = (await bm.post('/api/categories').send({ nameAr: 'خواتم سادة' })).body;
    const other = (await bm.post('/api/categories').send({ nameAr: 'دبل' })).body;
    const p = await bm.post('/api/products').send({ nameAr: 'خاتم سادة', karat: 21, categoryId: type.id });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ nameAr: 'خاتم سادة', name: null, karat: 21, categoryId: type.id, isActive: true });
    expect(p.body.sku).toMatch(/^P-\d{6}$/);
    // Allowed karats: this deployment sells 21K only.
    const k18 = await bm.post('/api/products').send({ nameAr: 'خاتم سادة', karat: 18, categoryId: type.id });
    expect(k18.status).toBe(400);
    expect(k18.body.error.key).toBe('{karat}K is not sold here: sellable pieces must be {allowed}');
    // Same normalized name, karat and type → 409 with the existing product; another type is a different product.
    const dup = await bm.post('/api/products').send({ nameAr: 'خاتم  سـادة', karat: 21, categoryId: type.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.existing.id).toBe(p.body.id);
    expect((await bm.post('/api/products').send({ nameAr: 'خاتم سادة', karat: 21, categoryId: other.id })).status).toBe(200);
    expect((await bm.post('/api/products').send({ nameAr: 'خاتم', karat: 21, categoryId: 999_999 })).status).toBe(404);
  });

  it('a replayed idempotency key creates nothing new', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER', false);
    const key = randomUUID();
    const a = await bm.post('/api/categories').set('Idempotency-Key', key).send({ nameAr: 'تعاليق ناعمة' });
    const b = await bm.post('/api/categories').set('Idempotency-Key', key).send({ nameAr: 'تعاليق ناعمة' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect((await ctx.db.select({ n: count() }).from(t.categories).where(eq(t.categories.nameAr, 'تعاليق ناعمة')))[0].n).toBe(1);
  });

  it('only the General Manager deactivates and reactivates, with a reason; deactivated products receive no new stock but stock already in hand still sells', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const supplierId = (await ctx.db.select().from(t.suppliers).limit(1))[0].id;
    const type = (await bm.post('/api/categories').send({ nameAr: 'أطقم خفيفة' })).body;
    const prod = (await bm.post('/api/products').send({ nameAr: 'طقم خفيف', karat: 21, categoryId: type.id })).body;
    const po = await bm.post('/api/purchases').send({ supplierId, lines: [line(prod.id), line(prod.id, 5_000)] });
    expect(po.status, JSON.stringify(po.body)).toBe(200);

    expect((await bm.post(`/api/products/${prod.id}/deactivate`).send({ reason: 'not made any more' })).status).toBe(403);
    expect((await gm.post(`/api/products/${prod.id}/deactivate`).send({ reason: '' })).status).toBe(400);
    const off = await gm.post(`/api/products/${prod.id}/deactivate`).send({ reason: 'not made any more' });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    // Hidden from the forms, shown to the GM on request.
    expect((await bm.get('/api/products')).body.some((p: { id: number }) => p.id === prod.id)).toBe(false);
    expect((await gm.get('/api/products?includeInactive=true')).body.find((p: { id: number }) => p.id === prod.id).isActive).toBe(false);
    // No new stock …
    const refused = await bm.post('/api/purchases').send({ supplierId, lines: [line(prod.id)] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.key).toBe('{name} is deactivated and cannot receive new stock');
    // … but the pieces already in stock still sell.
    const items = (await cashier.get(`/api/inventory/items?categoryId=${type.id}&status=AVAILABLE`)).body.items;
    expect(items).toHaveLength(2);
    expect((await cashier.post('/api/sales').send({ items: [{ itemId: items[0].id }], paymentMethod: 'CASH' })).status).toBe(200);
    // Deactivating the TYPE blocks its products too; reactivation restores them.
    expect((await gm.post(`/api/products/${prod.id}/reactivate`).send({ reason: 'back in the range' })).status).toBe(200);
    expect((await gm.post(`/api/categories/${type.id}/deactivate`).send({ reason: 'merged into another type' })).status).toBe(200);
    expect((await bm.get('/api/categories')).body.some((c: { id: number }) => c.id === type.id)).toBe(false);
    expect((await bm.post('/api/purchases').send({ supplierId, lines: [line(prod.id)] })).status).toBe(400);
    expect((await bm.post('/api/products').send({ nameAr: 'طقم آخر', karat: 21, categoryId: type.id })).status).toBe(400);
    expect((await gm.post(`/api/categories/${type.id}/reactivate`).send({ reason: 'needed again' })).status).toBe(200);
    expect((await bm.post('/api/purchases').send({ supplierId, lines: [line(prod.id)] })).status).toBe(200);
    const actions = (await ctx.db.select().from(t.auditLogs).where(sql`${t.auditLogs.action} IN ('PRODUCT_DEACTIVATED','PRODUCT_REACTIVATED','ITEM_TYPE_DEACTIVATED','ITEM_TYPE_REACTIVATED')`)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['PRODUCT_DEACTIVATED', 'PRODUCT_REACTIVATED', 'ITEM_TYPE_DEACTIVATED', 'ITEM_TYPE_REACTIVATED']));
  });

  it('the inventory list filters by a newly created type (by id; generated codes are not filter keys)', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const supplierId = (await ctx.db.select().from(t.suppliers).limit(1))[0].id;
    const type = (await bm.post('/api/categories').send({ nameAr: 'غوايش مخرمة' })).body;
    const prod = (await bm.post('/api/products').send({ nameAr: 'غويشة مخرمة', karat: 21, categoryId: type.id })).body;
    expect((await bm.post('/api/purchases').send({ supplierId, lines: [line(prod.id), line(prod.id, 6_000), line(prod.id, 7_000)] })).status).toBe(200);
    const res = await bm.get(`/api/inventory/items?categoryId=${type.id}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.every((i: { productNameAr: string }) => i.productNameAr === 'غويشة مخرمة')).toBe(true);
    expect((await bm.get('/api/inventory/items?category=RING')).status).toBe(400); // the old code filter is gone
  });
});

// ───────────────────────── suppliers and supplier orders ─────────────────────────
describe('suppliers', () => {
  it('a branch manager creates a supplier inline (duplicates refused); a supplier order must name one', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const s = await bm.post('/api/suppliers').send({ nameAr: 'ورشة السوق العربي', phone: '+249 912 111 222' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ nameAr: 'ورشة السوق العربي', name: null });
    const dup = await bm.post('/api/suppliers').send({ nameAr: 'ورشة  السوق   العربى' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.existing.id).toBe(s.body.id);
    const cashier = await login('cashier.kh.01', 'CASHIER');
    expect((await cashier.post('/api/suppliers').send({ nameAr: 'مورد' })).status).toBe(403);

    const prodId = (await ctx.db.select().from(t.products).where(and(eq(t.products.karat, 21), eq(t.products.isActive, true))).limit(1))[0].id;
    const none = await bm.post('/api/purchases').send({ lines: [line(prodId)] });
    expect(none.status).toBe(400);
    expect(none.body.error.key).toBe('Select the supplier');
    expect((await bm.post('/api/purchases').send({ supplierId: 999_999, lines: [line(prodId)] })).status).toBe(404);
    const po = await bm.post('/api/purchases').send({ supplierId: s.body.id, lines: [line(prodId)] });
    expect(po.status).toBe(200);
    const detail = (await bm.get(`/api/purchases/${po.body.id}`)).body;
    expect(detail.supplierName).toBe('ورشة السوق العربي'); // English empty → Arabic
    expect(detail.supplierNameAr).toBe('ورشة السوق العربي');
    expect(detail.goldOwedMgPure24).toBeGreaterThan(0);
  });
});

// ───────────────────────── English name optional: every display falls back ─────────────────────────
describe('English name optional: displays fall back to the Arabic name', () => {
  it('purchase lines, sale snapshot, printed invoice, inventory report and movements show the Arabic name', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const supplierId = (await ctx.db.select().from(t.suppliers).limit(1))[0].id;
    const type = (await bm.post('/api/categories').send({ nameAr: 'كفوف' })).body;
    const prod = (await bm.post('/api/products').send({ nameAr: 'كف مشغول', karat: 21, categoryId: type.id })).body;
    const po = (await bm.post('/api/purchases').send({ supplierId, lines: [line(prod.id)] })).body;
    const detail = (await bm.get(`/api/purchases/${po.id}`)).body;
    expect(detail.items[0]).toMatchObject({ productName: 'كف مشغول', productNameAr: 'كف مشغول' });

    const [item] = (await cashier.get(`/api/inventory/items?categoryId=${type.id}`)).body.items;
    const sale = (await cashier.post('/api/sales').send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' })).body;
    const [snap] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sale.id));
    expect(snap.productName).toBe('كف مشغول');
    // The printed document (English and Arabic layouts use name / nameAr through the same fallback).
    const printed = await cashier.post(`/api/sales/${sale.id}/print`).send({});
    expect(printed.status, JSON.stringify(printed.body)).toBe(200);
    expect(printed.body.document.lines[0]).toMatchObject({ name: 'كف مشغول', nameAr: 'كف مشغول' });
    expect(displayName('en', printed.body.document.lines[0].name, printed.body.document.lines[0].nameAr)).toBe('كف مشغول');

    const inv = (await gm.get(`/api/reports/inventory?q=${encodeURIComponent(item.code)}`)).body;
    expect(inv.rows.find((r: { code: string }) => r.code === item.code)).toMatchObject({ productName: 'كف مشغول', categoryName: 'كفوف' });
    const moves = (await gm.get(`/api/reports/inventory-ledger?q=${encodeURIComponent(item.code)}`)).body;
    expect(moves.rows.length).toBeGreaterThan(0);
    expect(moves.rows.every((r: { productName: string }) => r.productName === 'كف مشغول')).toBe(true);
    // Sales by type on the company dashboard: one row per type, with both names.
    const dash = (await gm.get('/api/dashboard/company')).body;
    expect(dash.salesByCategory.find((c: { categoryAr: string }) => c.categoryAr === 'كفوف')).toMatchObject({ category: 'كفوف' });
    // Profit by type groups by the type itself and carries the Arabic companion for the report table.
    const profit = (await gm.get('/api/reports/profit?group=category')).body;
    expect(profit.rows.filter((r: { labelAr: string }) => r.labelAr === 'كفوف')).toEqual([expect.objectContaining({ label: 'كفوف', labelAr: 'كفوف' })]);
  });
});

// ───────────────────────── production bootstrap ─────────────────────────
describe('production bootstrap', () => {
  it('seeds no item types: their names come from the client (owner decision)', async () => {
    const fresh = await openTestDatabase();
    try {
      await bootstrapProduction(createContext(fresh), { username: 'samira.osman', fullName: 'Owner' });
      expect(await fresh.db.select().from(t.categories)).toHaveLength(0);
      expect(await fresh.db.select().from(t.products)).toHaveLength(0);
      expect(await fresh.db.select().from(t.suppliers)).toHaveLength(0);
    } finally {
      await fresh.close();
    }
  });
});

void branchId;
