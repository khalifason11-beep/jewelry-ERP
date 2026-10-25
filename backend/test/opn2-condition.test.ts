// OPN-2 (plan docs/plans/OPN-2.md, D-opn2-1..4): the condition (new or used) of opening pieces. Both projects.
//   * every opening line has a condition, required with no default: a keyboard line without one (or another value) →
//     400, the database refuses a line without one; the CSV column is required, its values normalized (Arabic or
//     English, any case, feminine forms), a missing or unknown value is an error with its row and the column and the
//     whole file is refused;
//   * the review counts by karat and condition;
//   * sealing is refused (409 OPENING_RATES_MISSING, naming the karats) while a needed rate is missing, accepted once
//     set; each piece carries its line's condition as the rate that prices it;
//   * the pricing proof: a new and a used opening piece of the same karat and weight have different prices (detail,
//     list, valuation); changing only the used rate changes only the used pieces; a used opening piece sells at the
//     used rate with an unknown profit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { computedPrice, type GoldRateKind } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createCategory } from '../src/modules/catalog/service';
import { createSale } from '../src/modules/sales/service';
import { currentSellingRates, rateKey } from '../src/modules/pricing/service';
import { addOpeningLine, createOpening, exportOpeningCsv, getOpening, importOpeningCsv } from '../src/modules/openings/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gmHttp: ReturnType<typeof request.agent>;
let gm: Actor;
let gmSession: string;
let cashierBhr: Actor;
let bhr: number;
let type: { id: number; nameAr: string };
let k: number; // a karat with both a new-piece and a used-piece rate
let kx: number; // an allowed karat without any rate

const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string; params?: Record<string, unknown>; details?: Record<string, unknown> }) => e);
const actorOf = async (username: string, sessionId: string | null = null): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, sessionId))!;
};
const csv = (s: string) => Buffer.from(s, 'utf8');
const lineCount = async (openingId: number) => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.openingLines).where(eq(t.openingLines.openingId, openingId)))[0].n);
const sheet = (rows: string[]) => ['Type,Description,Karat,Condition,Gross weight (g),Net weight (g)', ...rows].join('\r\n') + '\r\n';
const rate = async (karat: number, kind: GoldRateKind) => (await currentSellingRates(ctx.db)).get(rateKey(karat, kind))?.pricePerGram;
const setRates = async (body: object) => {
  const r = await gmHttp.post('/api/gold-rates').send({ reason: 'test: set the rates', confirmPassword: PW, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
interface Row { id: number; code: string; karat: number; origin: string; rateKind: string; netWeightMg: number; sellingPrice: number | null }
/** Every available piece of BHR, as the inventory list shows it. */
async function bhrStock(): Promise<Map<number, Row>> {
  const out = new Map<number, Row>();
  for (let page = 1; ; page++) {
    const body = (await gmHttp.get('/api/inventory/items').query({ branchId: bhr, status: 'AVAILABLE', pageSize: 200, page })).body as { rows: Row[]; total: number };
    for (const r of body.rows) out.set(r.id, r);
    if (!body.rows.length || out.size >= body.total) return out;
  }
}
const valuation = async () => (await gmHttp.get('/api/reports/inventory').query({ branchId: bhr, status: 'AVAILABLE' })).body.totals.sellingPrice as number;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date(), { pricingMode: 'RATE_COMPUTED' });
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gmHttp = withIdempotencyKeys(request.agent(app));
  const res = await gmHttp.post('/api/auth/login').send({ username: 'general.manager', password: PW });
  gmHttp.set('x-csrf-token', res.body.csrfToken);
  expect((await gmHttp.post('/api/auth/reauth').send({ password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gmSession = s.id;
  gm = await actorOf('general.manager', s.id);
  cashierBhr = await actorOf('cashier.bhr.01');
  bhr = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'BHR')))[0].id;
  type = await createCategory(ctx, gm, { nameAr: '[اختبار] قطعة بحالتها', name: '[Test] Piece with a condition' });
  // Sealing needs the General Manager's fresh passkey (OPN-1, D-opn1-4).
  await ctx.db.insert(t.webauthnCredentials).values({ userId: gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  await ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
  const { inventory } = await ctx.settings.get();
  const rates = await currentSellingRates(ctx.db);
  k = inventory.allowedKarats.find((x) => rates.has(rateKey(x, 'NEW')) && rates.has(rateKey(x, 'USED')))!;
  // Rates are append-only: make a karat sellable that has no rate at all (as attention.test does for scrap rates).
  kx = [9, 10, 12, 14, 15, 16, 20].find((x) => !inventory.allowedKarats.includes(x) && !rates.has(rateKey(x, 'NEW')) && !rates.has(rateKey(x, 'USED')))!;
  await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [...inventory.allowedKarats, kx] }, { actor: { id: null, username: 'system' }, allowGuarded: true });
});
afterAll(async () => handle?.close());

describe('the condition is required, with no default', () => {
  let krtOpening: number;
  beforeAll(async () => {
    krtOpening = (await createOpening(ctx, gm, { branchId: (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id })).id;
  });

  it('keyboard: a line without a condition, or with another value → 400; the database refuses a line without one', async () => {
    const line = { categoryId: type.id, karat: k, grossWeightMg: 1_000, netWeightMg: 1_000 };
    for (const body of [line, { ...line, condition: '' }, { ...line, condition: 'OLD' }, { ...line, condition: 'new' }]) {
      const r = await gmHttp.post(`/api/openings/${krtOpening}/lines`).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await lineCount(krtOpening)).toBe(0);
    await expect(ctx.db.insert(t.openingLines).values({ openingId: krtOpening, lineNo: 1, categoryId: type.id, karat: k, grossWeightMg: 1_000, netWeightMg: 1_000, source: 'KEYBOARD', createdBy: gm.userId })).rejects.toThrow();
    await expect(ctx.db.insert(t.openingLines).values({ openingId: krtOpening, lineNo: 1, categoryId: type.id, karat: k, condition: 'OLD', grossWeightMg: 1_000, netWeightMg: 1_000, source: 'KEYBOARD', createdBy: gm.userId })).rejects.toThrow();
    const ok = await gmHttp.post(`/api/openings/${krtOpening}/lines`).send({ ...line, condition: 'USED' });
    expect(ok.status).toBe(200);
    expect((await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.id, ok.body.id)))[0].condition).toBe('USED');
  });

  it('CSV: the values are normalized (Arabic or English, any case, feminine forms)', async () => {
    const words = ['جديد', 'جديدة', 'جديده', 'NEW', ' new ', 'مستعمل', 'مستعملة', 'مستعمله', 'Used', 'USED'];
    const before = await lineCount(krtOpening);
    const r = await importOpeningCsv(ctx, gm, krtOpening, { fileName: 'words.csv', bytes: csv(sheet(words.map((w, i) => `${type.nameAr},w${i},${k},${w},1,1`))) });
    expect(r.rowCount).toBe(words.length);
    const lines = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.importId, r.importId)).orderBy(asc(t.openingLines.lineNo));
    expect(lines.map((l) => l.condition)).toEqual(['NEW', 'NEW', 'NEW', 'NEW', 'NEW', 'USED', 'USED', 'USED', 'USED', 'USED']);
    expect(await lineCount(krtOpening)).toBe(before + words.length);
  });

  it('CSV: a missing or unknown value is an error with its row and the column; the file is refused; a missing column too', async () => {
    const before = await lineCount(krtOpening);
    const bad = sheet([`${type.nameAr},a,${k},جديد,1,1`, `${type.nameAr},b,${k},,1,1`, `${type.nameAr},c,${k},قديم,1,1`, `${type.nameAr},d,${k},مستعمل,1,1`, `${type.nameAr},e,${k},N,1,1`]);
    const e = await err(importOpeningCsv(ctx, gm, krtOpening, { fileName: 'bad.csv', bytes: csv(bad) }));
    expect([e?.status, e?.code]).toEqual([422, 'OPENING_IMPORT_INVALID']);
    const errors = (e?.details as { errors: { line: number; column: string | null; key: string; params?: Record<string, unknown> }[] }).errors;
    expect(errors.map((x) => [x.line, x.column, x.key, x.params?.value])).toEqual([
      [3, 'condition', 'Choose the condition: new or used', undefined],
      [4, 'condition', 'Unknown condition "{value}": write new or used (جديد or مستعمل)', 'قديم'],
      [6, 'condition', 'Unknown condition "{value}": write new or used (جديد or مستعمل)', 'N'],
    ]);
    expect(await lineCount(krtOpening)).toBe(before);
    const noColumn = await err(importOpeningCsv(ctx, gm, krtOpening, { fileName: 'old.csv', bytes: csv(`Type,Karat,Net weight (g)\r\n${type.nameAr},${k},1\r\n`) }));
    expect((noColumn?.details as { errors: { line: number; key: string; params?: { name?: string } }[] }).errors.map((x) => [x.line, x.key, x.params?.name])).toContainEqual([1, 'The column "{name}" is missing', 'الحالة / Condition']);
    expect(await lineCount(krtOpening)).toBe(before);
  });

  it('the review counts by karat and condition; the export carries the condition and imports again', async () => {
    const o = await getOpening(ctx, gm, krtOpening);
    const by = o.summary.byKaratCondition.map((x) => [x.karat, x.condition, x.count]);
    expect(by).toEqual([[k, 'NEW', 5], [k, 'USED', 6]]);
    expect(o.summary.byKaratCondition.reduce((s, x) => s + x.netWeightMg, 0)).toBe(o.summary.total.netWeightMg);
    const exported = await exportOpeningCsv(ctx, gm, krtOpening);
    expect(exported.text.split('\r\n')[0]).toContain('Condition');
    const omd = (await createOpening(ctx, gm, { branchId: (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'OMD')))[0].id })).id;
    const back = await importOpeningCsv(ctx, gm, omd, { fileName: exported.fileName, bytes: csv(exported.text) });
    expect(back.summary.byKaratCondition).toEqual(o.summary.byKaratCondition);
  });
});

describe('sealing needs the rate of every karat and condition; the pieces are priced by their condition', () => {
  let opening: number;
  const seal = () => gmHttp.post(`/api/openings/${opening}/seal`).send({ confirmPassword: PW });
  const pieces = async () =>
    ctx.db
      .select({ lineNo: t.openingLines.lineNo, condition: t.openingLines.condition, description: t.openingLines.description, item: t.jewelryItems })
      .from(t.openingLines)
      .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingLines.itemId))
      .where(eq(t.openingLines.openingId, opening))
      .orderBy(asc(t.openingLines.lineNo));

  beforeAll(async () => {
    opening = (await createOpening(ctx, gm, { branchId: bhr })).id;
    // A new and a used piece of the same karat and weight; a new and a used piece of a karat with no rate yet.
    for (const [description, karat, condition] of [['new piece', k, 'NEW'], ['used piece', k, 'USED'], ['new kx', kx, 'NEW'], ['used kx', kx, 'USED']] as const) {
      await addOpeningLine(ctx, gm, opening, { categoryId: type.id, description, karat, condition, grossWeightMg: 10_500, netWeightMg: 10_000 });
    }
  });

  it('refused (409 OPENING_RATES_MISSING, naming the karats) while a needed rate is missing; accepted once set', async () => {
    const both = await seal();
    expect([both.status, both.body.error.code, both.body.error.params]).toEqual([409, 'OPENING_RATES_MISSING', { newKarats: `${kx}K`, usedKarats: `${kx}K` }]);
    expect(both.body.error.details.missing).toEqual([{ karat: kx, condition: 'NEW' }, { karat: kx, condition: 'USED' }]);
    await setRates({ rates: { [kx]: 3_000_000 } });
    const used = await seal();
    expect([used.status, used.body.error.code, used.body.error.params]).toEqual([409, 'OPENING_RATES_MISSING', { newKarats: '', usedKarats: `${kx}K` }]);
    expect(used.body.error.message).toBe(`Set the selling rate first: the used-piece rate of ${kx}K`);
    expect((await ctx.db.select().from(t.openings).where(eq(t.openings.id, opening)))[0].status).toBe('DRAFT');
    expect((await pieces()).length).toBe(0);
    await setRates({ usedRates: { [kx]: 2_500_000 } });
    const ok = await seal();
    expect([ok.status, ok.body.status]).toEqual([200, 'SEALED']);
    const ps = await pieces();
    expect(ps.map((p) => [p.description, p.item.origin, p.item.rateKind, p.item.acquisitionCost])).toEqual([
      ['new piece', 'OPENING', 'NEW', null],
      ['used piece', 'OPENING', 'USED', null],
      ['new kx', 'OPENING', 'NEW', null],
      ['used kx', 'OPENING', 'USED', null],
    ]);
    // The sealed export shows the condition each piece is priced at.
    const exported = (await gmHttp.get(`/api/openings/${opening}/export`)).text.split('\r\n');
    expect(exported.slice(1, 5).map((l) => l.split(',')[5])).toEqual(['جديد', 'مستعمل', 'جديد', 'مستعمل']);
  });

  it('the pricing proof: same karat and weight, different prices (detail, list, valuation); only the used rate moves only the used pieces', async () => {
    const [newPiece, usedPiece] = (await pieces()).map((p) => p.item);
    const step = (await ctx.settings.get()).pricing.roundingStep;
    const expected = async (kind: GoldRateKind) => computedPrice(10_000, (await rate(k, kind))!, step);
    const detail = async (id: number) => (await gmHttp.get(`/api/inventory/items/${id}`)).body.item as { sellingPrice: number; pricePerGram: number; rateKind: string };
    expect(await detail(newPiece.id)).toMatchObject({ sellingPrice: await expected('NEW'), pricePerGram: await rate(k, 'NEW'), rateKind: 'NEW' });
    expect(await detail(usedPiece.id)).toMatchObject({ sellingPrice: await expected('USED'), pricePerGram: await rate(k, 'USED'), rateKind: 'USED' });
    expect(await expected('NEW')).not.toBe(await expected('USED'));
    const list = await bhrStock();
    expect([list.get(newPiece.id)?.sellingPrice, list.get(usedPiece.id)?.sellingPrice]).toEqual([await expected('NEW'), await expected('USED')]);

    // Change only the used rate of k.
    const valueBefore = await valuation();
    const newRateBefore = await rate(k, 'NEW');
    await setRates({ usedRates: { [k]: (await rate(k, 'USED'))! + 500_000 } });
    expect(await rate(k, 'NEW')).toBe(newRateBefore);
    const after = await bhrStock();
    expect((await detail(usedPiece.id)).sellingPrice).toBe(await expected('USED'));
    expect((await detail(newPiece.id)).sellingPrice).toBe(list.get(newPiece.id)?.sellingPrice);
    let delta = 0;
    for (const [id, a] of after) {
      const b = list.get(id)!;
      const moved = a.sellingPrice !== b.sellingPrice;
      // Exactly the used pieces of karat k move: the used opening piece and the sellable scrap of that karat.
      expect(moved, `${a.code} ${a.origin} ${a.rateKind} ${a.karat}K`).toBe(a.rateKind === 'USED' && a.karat === k);
      delta += (a.sellingPrice ?? 0) - (b.sellingPrice ?? 0);
    }
    expect(after.get(usedPiece.id)!.sellingPrice).not.toBe(list.get(usedPiece.id)!.sellingPrice);
    expect(await valuation()).toBe(valueBefore + delta);
  });

  it('a used opening piece sells at the used rate, with an unknown cost and profit', async () => {
    const usedPiece = (await pieces())[1].item;
    const usedRate = (await rate(k, 'USED'))!;
    const shown = (await err(createSale(ctx, cashierBhr, { items: [{ itemId: usedPiece.id }], paymentMethod: 'CASH' }))) as { code?: string; details?: { lines: { listPrice: number }[] } };
    expect(shown.code).toBe('PRICES_CHANGED');
    const listPrice = shown.details!.lines[0].listPrice;
    expect(listPrice).toBe(computedPrice(10_000, usedRate, (await ctx.settings.get()).pricing.roundingStep));
    const sale = await createSale(ctx, cashierBhr, { items: [{ itemId: usedPiece.id, listPrice }], paymentMethod: 'CASH' });
    const [line] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sale.id));
    expect([line.priceRatePerGram, line.listPrice, line.unitCost, line.profit, line.pricingMode]).toEqual([usedRate, listPrice, null, null, 'COMPUTED']);
  });
});
