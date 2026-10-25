// OPN-1 (plan docs/plans/OPN-1.md §4–§5, D-opn1-1..5): the opening balance of a branch. Both projects.
//   * one opening per branch (a second → 409); General Manager only (the branch manager and the cashier → 403);
//   * keyboard lines (type, karat, weights checked) and their removal while a draft;
//   * the CSV importer: a good file (semicolon, BOM, Arabic-Indic digits, the template's header), a bad file (every
//     error with its row and column, nothing written), the same file twice (nothing changes), a 300-row file over HTTP
//     with a replayed Idempotency-Key (same answer, once) and the same key with another file (422), the limits (5,000
//     rows, 1 MB), the template (an empty file → 422);
//   * the review (summary by karat and by type, paged and searchable lines) and the CSV export (the draft re-imports);
//   * sealing: refused on FIXED_TAG, without the password, for a General Manager without a passkey, without a fresh
//     passkey, for an empty draft; then every line is a piece (codes in the sheet's order, origin OPENING, cost NULL,
//     no tag price, ADJUSTMENT +1 at a NULL cost, no ledger entry), the stock weight grows by the sheet's totals, the
//     export lists the codes, an opening piece sells at the new-piece rate, and nothing can be added any more (409, and
//     the database triggers refuse it).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { readCsv } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createCategory, setCategoryActive } from '../src/modules/catalog/service';
import { createSale } from '../src/modules/sales/service';
import { stockWeight } from '../src/modules/stock/weight';
import { addOpeningLine, createOpening, exportOpeningCsv, getOpening, importOpeningCsv, openingTemplateCsv, removeOpeningLine, sealOpening } from '../src/modules/openings/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gmHttp: ReturnType<typeof request.agent>;
let gm: Actor; // with the session of gmHttp
let gmSession: string;
let cashierBhr: Actor;
let branch: Record<'KRT' | 'OMD' | 'BHR' | 'PZU', number>;
let typeA: { id: number; nameAr: string };
let typeB: { id: number; nameAr: string };
let k1: number;
let k2: number;

const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string; params?: Record<string, unknown>; details?: Record<string, unknown> }) => e);
const actorOf = async (username: string, sessionId: string | null = null): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, sessionId))!;
};
const csv = (s: string) => Buffer.from(s, 'utf8');
const lineCount = async (openingId: number) => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.openingLines).where(eq(t.openingLines.openingId, openingId)))[0].n);
const importCount = async (openingId: number) => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.openingImports).where(eq(t.openingImports.openingId, openingId)))[0].n);
/** The General Manager's passkey: a registered credential and the session's passkey confirmation (`at`, or none). */
async function passkey(state: { registered: boolean; confirmedAt: Date | null }) {
  await ctx.db.update(t.webauthnCredentials).set({ revokedAt: new Date(), revokedReason: 'test' }).where(eq(t.webauthnCredentials.userId, gm.userId));
  if (state.registered) {
    await ctx.db.insert(t.webauthnCredentials).values({ userId: gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  }
  await ctx.db.update(t.sessions).set({ passkeyReauthAt: state.confirmedAt, passkeyReauthUv: state.confirmedAt != null }).where(eq(t.sessions.id, gmSession));
}
const pricingMode = (mode: 'FIXED_TAG' | 'RATE_COMPUTED') => ctx.settings.apply(ctx.db, { 'pricing.mode': mode }, { actor: { id: null, username: 'test' } });
const sheet = (rows: string[], header = 'النوع / Type,الوصف / Description,العيار / Karat,الوزن القائم (جم) / Gross weight (g),الوزن الصافي (جم) / Net weight (g)') => [header, ...rows].join('\r\n') + '\r\n';

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
  const bs = await ctx.db.select().from(t.branches);
  branch = Object.fromEntries(bs.map((b) => [b.code, b.id])) as typeof branch;
  typeA = await createCategory(ctx, gm, { nameAr: '[اختبار] خاتم افتتاحي', name: '[Test] Opening ring' });
  typeB = await createCategory(ctx, gm, { nameAr: '[اختبار] سوار افتتاحي', name: '[Test] Opening bangle' });
  const allowed = (await ctx.settings.get()).inventory.allowedKarats;
  [k1, k2] = [allowed[0], allowed[allowed.length - 1]];
});
afterAll(async () => handle?.close());

describe('an opening per branch, General Manager only', () => {
  it('one per branch: a second → 409 OPENING_EXISTS; the branch manager and the cashier → 403', async () => {
    const o = await createOpening(ctx, gm, { branchId: branch.KRT });
    expect(o.status).toBe('DRAFT');
    const e = await err(createOpening(ctx, gm, { branchId: branch.KRT }));
    expect([e?.status, e?.code]).toEqual([409, 'OPENING_EXISTS']);
    for (const [user, role] of [['branch.manager.kh', 'BRANCH_MANAGER'], ['cashier.kh.01', 'CASHIER']] as const) {
      const agent = withIdempotencyKeys(request.agent(app));
      const r = await agent.post('/api/auth/login').send({ username: user, password: DEMO_PASSWORDS[role] });
      agent.set('x-csrf-token', r.body.csrfToken);
      expect((await agent.get('/api/openings')).status, role).toBe(403);
      expect((await agent.post('/api/openings').send({ branchId: branch.PZU })).status, role).toBe(403);
    }
    const list = (await gmHttp.get('/api/openings')).body.branches as { branchId: number; opening: { status: string } | null }[];
    expect(list.find((b) => b.branchId === branch.KRT)?.opening?.status).toBe('DRAFT');
    expect(list.find((b) => b.branchId === branch.PZU)?.opening).toBeNull();
  });

  it('keyboard lines: type, karat and weights checked; a draft line can be removed', async () => {
    const [o] = await ctx.db.select().from(t.openings).where(eq(t.openings.branchId, branch.KRT));
    const a = await addOpeningLine(ctx, gm, o.id, { categoryId: typeA.id, description: 'رقم قديم 12', karat: k1, grossWeightMg: 5_100, netWeightMg: 5_000 });
    expect(a.lineNo).toBe(1);
    const off = await createCategory(ctx, gm, { nameAr: '[اختبار] نوع موقوف افتتاحي' });
    await setCategoryActive(ctx, gm, off.id, false, 'test');
    expect((await err(addOpeningLine(ctx, gm, o.id, { categoryId: off.id, karat: k1, grossWeightMg: 1_000, netWeightMg: 1_000 })))?.status).toBe(400);
    expect((await err(addOpeningLine(ctx, gm, o.id, { categoryId: typeA.id, karat: 13, grossWeightMg: 1_000, netWeightMg: 1_000 })))?.status).toBe(400);
    expect((await err(addOpeningLine(ctx, gm, o.id, { categoryId: typeA.id, karat: k1, grossWeightMg: 900, netWeightMg: 1_000 })))?.key).toBe('The gross weight cannot be below the net weight');
    expect((await err(addOpeningLine(ctx, gm, o.id, { categoryId: typeA.id, karat: k1, grossWeightMg: 1_000, netWeightMg: 1_000, description: 'x'.repeat(121) })))?.status).toBe(400);
    const b = await addOpeningLine(ctx, gm, o.id, { categoryId: typeB.id, karat: k2, grossWeightMg: 2_000, netWeightMg: 2_000 });
    await removeOpeningLine(ctx, gm, o.id, b.id);
    expect(await lineCount(o.id)).toBe(1);
    const audit = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_LINE_REMOVED'));
    expect(audit.at(-1)?.metadata).toMatchObject({ line: { lineNo: 2, karat: k2, netWeightMg: 2_000 } });
  });
});

describe('the CSV importer', () => {
  let omdOpening: number;
  beforeAll(async () => {
    omdOpening = (await createOpening(ctx, gm, { branchId: branch.OMD })).id;
  });

  it('a good file: semicolons, a BOM, Arabic-Indic digits, Arabic or English type names; the same file again changes nothing', async () => {
    const file = csv('﻿' + `النوع;الوصف;العيار;الوزن القائم;الوزن الصافي\r\n${typeA.nameAr};"قديم; ١٢";${k1};٥٫٢٥٠;5.000\r\n[Test] Opening bangle;;${k2}K;10;9.5\r\n\r\n`);
    const r = await importOpeningCsv(ctx, gm, omdOpening, { fileName: 'branch.csv', bytes: file });
    expect([r.duplicate, r.rowCount]).toEqual([false, 2]);
    const lines = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, omdOpening)).orderBy(asc(t.openingLines.lineNo));
    expect(lines.map((l) => [l.lineNo, l.categoryId, l.description, l.karat, l.grossWeightMg, l.netWeightMg, l.source])).toEqual([
      [1, typeA.id, 'قديم; ١٢', k1, 5_250, 5_000, 'IMPORT'],
      [2, typeB.id, null, k2, 10_000, 9_500, 'IMPORT'],
    ]);
    const again = await importOpeningCsv(ctx, gm, omdOpening, { fileName: 'renamed.csv', bytes: file });
    expect([again.duplicate, again.importId, again.rowCount]).toEqual([true, r.importId, 2]);
    expect([await lineCount(omdOpening), await importCount(omdOpening)]).toEqual([2, 1]);
  });

  it('a bad file: every error with its row and column; nothing is written', async () => {
    const before = [await lineCount(omdOpening), await importCount(omdOpening)];
    const bad = sheet([
      `${typeA.nameAr},ok,${k1},1.000,1.000`,
      `نوع غير موجود,,${k1},1,1`,
      `${typeA.nameAr},,13,1,1`,
      `${typeA.nameAr},,${k1},1.0001,1`,
      `${typeA.nameAr},,${k1},1,2`,
      `,,,,`,
      `,${'و'.repeat(121)},${k1},,1`,
    ]);
    const e = await err(importOpeningCsv(ctx, gm, omdOpening, { fileName: 'bad.csv', bytes: csv(bad) }));
    expect([e?.status, e?.code]).toEqual([422, 'OPENING_IMPORT_INVALID']);
    const errors = (e?.details as { errors: { line: number; column: string | null; key: string }[] }).errors;
    expect(errors.map((x) => [x.line, x.column])).toEqual([
      [3, 'type'],
      [4, 'karat'],
      [5, 'grossWeight'],
      [6, 'grossWeight'],
      [8, 'type'],
      [8, 'description'],
      [8, 'grossWeight'],
    ]);
    expect([await lineCount(omdOpening), await importCount(omdOpening)]).toEqual(before);
    // A header problem: a missing column, an unknown one.
    const e2 = await err(importOpeningCsv(ctx, gm, omdOpening, { fileName: 'h.csv', bytes: csv('Type,Colour,Karat,Net weight (g)\r\nx,y,21,1\r\n') }));
    expect((e2?.details as { errors: { line: number; key: string }[] }).errors.map((x) => [x.line, x.key])).toEqual([
      [1, 'Unknown column "{name}"'],
      [1, 'The column "{name}" is missing'],
    ]);
    // Not UTF-8, and broken quoting.
    expect((await err(importOpeningCsv(ctx, gm, omdOpening, { fileName: 'x.csv', bytes: Buffer.from([0x54, 0x79, 0xff, 0x0a]) })))?.code).toBe('OPENING_IMPORT_INVALID');
    expect((await err(importOpeningCsv(ctx, gm, omdOpening, { fileName: 'x.csv', bytes: csv(sheet([`"${typeA.nameAr},,21,1,1`])) })))?.code).toBe('OPENING_IMPORT_INVALID');
  });

  it('the template: its header imports (as an empty file, 422); limits: 5,000 rows, 1 MB', async () => {
    const template = (await gmHttp.get('/api/openings/template.csv')).text;
    expect(template).toBe(openingTemplateCsv());
    expect(readCsv(template).rows).toEqual([]);
    expect((await err(importOpeningCsv(ctx, gm, omdOpening, { fileName: 't.csv', bytes: csv(template) })))?.details).toMatchObject({ errors: [{ key: 'The file has no rows' }] });
    const many = sheet(Array.from({ length: 5_001 }, () => `${typeA.nameAr},,${k1},1,1`));
    expect((await err(importOpeningCsv(ctx, gm, omdOpening, { fileName: 'm.csv', bytes: csv(many) })))?.details).toMatchObject({ errors: [{ line: 5_002 }] });
    const big = await gmHttp.post(`/api/openings/${omdOpening}/import`).set('Content-Type', 'text/csv').send(Buffer.alloc(1024 * 1024 + 10, 0x41));
    expect([big.status, big.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    const json = await gmHttp.post(`/api/openings/${omdOpening}/import`).send({ rows: [] });
    expect(json.status).toBe(400);
  });

  it('a 300-row file over HTTP; the same Idempotency-Key replays the answer; the same key with another file → 422', async () => {
    const pzu = (await gmHttp.post('/api/openings').send({ branchId: branch.PZU })).body.id as number;
    const rows = Array.from({ length: 300 }, (_, i) => `${i % 2 ? typeA.nameAr : typeB.nameAr},قطعة ${i + 1},${i % 3 ? k1 : k2},${(2 + (i % 7) * 0.5).toFixed(3)},${(1.5 + (i % 7) * 0.5).toFixed(3)}`);
    const body = sheet(rows);
    const key = randomUUID();
    const send = (b: string, k = key) => gmHttp.post(`/api/openings/${pzu}/import?fileName=pzu.csv`).set('Content-Type', 'text/csv').set('Idempotency-Key', k).send(b);
    const first = await send(body);
    expect([first.status, first.body.rowCount, first.body.duplicate]).toEqual([200, 300, false]);
    const replay = await send(body);
    expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([200, 'true']);
    expect(replay.body).toEqual(first.body);
    expect((await send(sheet(rows.slice(0, 10)))).status).toBe(422);
    expect(await lineCount(pzu)).toBe(300);
    // The review: totals by karat and by type, the lines paged and searchable.
    const o = (await gmHttp.get(`/api/openings/${pzu}?pageSize=50&page=2`)).body;
    expect(o.summary.total.count).toBe(300);
    expect(o.summary.byKarat.reduce((s: number, k: { count: number }) => s + k.count, 0)).toBe(300);
    expect(o.summary.byType.map((x: { categoryId: number; count: number }) => [x.categoryId, x.count]).sort()).toEqual([[typeA.id, 150], [typeB.id, 150]].sort());
    expect([o.lines.total, o.lines.rows.length, o.lines.rows[0].lineNo]).toEqual([300, 50, 51]);
    const found = (await getOpening(ctx, gm, pzu, { q: 'قطعة 177' })).lines.rows;
    expect(found.map((l) => l.lineNo)).toEqual([177]);
    expect((await getOpening(ctx, gm, pzu, { karat: k2 })).lines.total).toBe(k1 === k2 ? 300 : 100);
    // The draft's export imports again into the same lines.
    const exported = await exportOpeningCsv(ctx, gm, pzu);
    const back = await importOpeningCsv(ctx, gm, (await createOpening(ctx, gm, { branchId: branch.BHR })).id, { fileName: exported.fileName, bytes: csv(exported.text) });
    expect(back.summary.total).toEqual(o.summary.total);
  });
});

describe('sealing', () => {
  let bhr: number;
  let empty: number;
  beforeAll(async () => {
    bhr = (await ctx.db.select().from(t.openings).where(eq(t.openings.branchId, branch.BHR)))[0].id;
    const nb = await ctx.db.insert(t.branches).values({ code: 'OPNT', name: 'Opening test', nameAr: 'فرع اختبار الافتتاح', city: 'X' }).returning();
    empty = (await createOpening(ctx, gm, { branchId: nb[0].id })).id;
  });
  const seal = (id: number, body: object = { confirmPassword: PW }) => gmHttp.post(`/api/openings/${id}/seal`).send(body);

  it('refused: on FIXED_TAG (409), without the password, without a passkey (PASSKEY_REQUIRED), without a fresh one, an empty draft (422)', async () => {
    await passkey({ registered: true, confirmedAt: new Date() });
    await pricingMode('FIXED_TAG');
    expect((await seal(bhr)).body.error.code).toBe('OPENING_NEEDS_COMPUTED_PRICES');
    await pricingMode('RATE_COMPUTED');
    expect((await seal(bhr, {})).body.error.code).toBe('CONFIRM_PASSWORD_REQUIRED');
    await passkey({ registered: false, confirmedAt: null });
    const noKey = await seal(bhr);
    expect([noKey.status, noKey.body.error.code]).toEqual([403, 'PASSKEY_REQUIRED']);
    await passkey({ registered: true, confirmedAt: new Date(Date.now() - 60 * 60_000) });
    // The route's re-auth check sees a passkey without a fresh confirmation first (the service would say the same).
    const stale = await seal(bhr);
    expect([stale.status, stale.body.error.code]).toEqual([403, 'REAUTH_REQUIRED']);
    expect((await err(sealOpening(ctx, gm, bhr, { confirmPassword: PW })))?.code).toBe('REAUTH_REQUIRED');
    await passkey({ registered: true, confirmedAt: new Date() });
    expect((await seal(bhr, { confirmPassword: 'wrong password' })).status).toBe(403);
    expect((await seal(empty)).body.error.code).toBe('OPENING_EMPTY');
    expect((await ctx.db.select().from(t.openings).where(eq(t.openings.id, bhr)))[0].status).toBe('DRAFT');
    // Re-confirm the password for the next test (a wrong one does not end the window, but keep it plain).
    expect((await gmHttp.post('/api/auth/reauth').send({ password: PW })).status).toBe(200);
  });

  it('sealed: codes in the sheet order, cost unknown, no tag price, ADJUSTMENT +1 at NULL cost, no ledger entry; the stock weight grows by the sheet; then closed for good', async () => {
    await passkey({ registered: true, confirmedAt: new Date() });
    const kb = await addOpeningLine(ctx, gm, bhr, { categoryId: typeA.id, description: 'typed', karat: k1, grossWeightMg: 3_000, netWeightMg: 3_000 });
    const { summary } = await getOpening(ctx, gm, bhr);
    const weightBefore = (await stockWeight(ctx.db, branch.BHR)).byBranch.get(branch.BHR)!.items.weightMg;
    const ledgerBefore = Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.ledgerEntries))[0].n);
    const res = await seal(bhr);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'SEALED', pieces: summary.total.count, netWeightMg: summary.total.netWeightMg });

    const lines = await ctx.db
      .select({ lineNo: t.openingLines.lineNo, importId: t.openingLines.importId, item: t.jewelryItems })
      .from(t.openingLines)
      .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingLines.itemId))
      .where(eq(t.openingLines.openingId, bhr))
      .orderBy(asc(t.jewelryItems.id));
    expect(lines.length).toBe(summary.total.count);
    // The sheet's order first, the typed line last; consecutive codes.
    expect(lines.at(-1)?.lineNo).toBe(kb.lineNo);
    expect(lines.slice(0, -1).map((l) => l.lineNo)).toEqual([...lines.slice(0, -1).map((l) => l.lineNo)].sort((a, b) => a - b));
    const nums = lines.map((l) => Number(l.item.code.slice(2)));
    expect(nums).toEqual(nums.map((_, i) => nums[0] + i));
    expect(res.body.firstCode).toBe(lines[0].item.code);
    for (const { item } of lines) {
      expect([item.origin, item.acquisitionCost, item.sellingPrice, item.status, item.branchId, item.productId]).toEqual(['OPENING', null, 0, 'AVAILABLE', branch.BHR, null]);
      expect(item.barcode).toBe(`628100${item.code.slice(2).padStart(6, '0')}`);
    }
    const moves = await ctx.db.select().from(t.inventoryMovements).where(sql`${t.inventoryMovements.itemId} IN ${lines.map((l) => l.item.id)}`);
    expect(moves.length).toBe(lines.length);
    expect(moves.every((m) => m.type === 'ADJUSTMENT' && m.direction === 1 && m.costValue === null && m.refType === 'opening' && m.refId === bhr)).toBe(true);
    expect(Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.ledgerEntries))[0].n)).toBe(ledgerBefore);
    expect((await stockWeight(ctx.db, branch.BHR)).byBranch.get(branch.BHR)!.items.weightMg).toBe(weightBefore + summary.total.netWeightMg);
    expect((await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_SEALED'))).at(-1)?.metadata).toMatchObject({ pieces: summary.total.count, firstCode: lines[0].item.code });

    // The export lists the codes; an opening piece sells at the new-piece rate with an unknown cost.
    const exported = readCsv((await gmHttp.get(`/api/openings/${bhr}/export`)).text);
    expect(exported.rows.map((r) => r.cells[0])).toEqual(lines.map((l) => l.item.code));
    // The POS shows the price first (PRC-1: a sale without the price seen is refused with the current prices).
    const shown = (await err(createSale(ctx, cashierBhr, { items: [{ itemId: lines[0].item.id }], paymentMethod: 'CASH' }))) as { code?: string; details?: { lines: { listPrice: number }[] } };
    expect(shown.code).toBe('PRICES_CHANGED');
    const sale = await createSale(ctx, cashierBhr, { items: [{ itemId: lines[0].item.id, listPrice: shown.details!.lines[0].listPrice }], paymentMethod: 'CASH' });
    const [line] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.saleId, sale.id));
    expect([line.unitCost, line.profit, line.pricingMode]).toEqual([null, null, 'COMPUTED']);
    expect(line.finalPrice).toBeGreaterThan(0);

    // Closed for good: the service (409) and the database.
    for (const write of [
      () => addOpeningLine(ctx, gm, bhr, { categoryId: typeA.id, karat: k1, grossWeightMg: 1_000, netWeightMg: 1_000 }),
      () => removeOpeningLine(ctx, gm, bhr, kb.id),
      () => importOpeningCsv(ctx, gm, bhr, { fileName: 'late.csv', bytes: csv(sheet([`${typeA.nameAr},,${k1},1,1`])) }),
    ]) expect((await err(write()))?.code).toBe('OPENING_SEALED');
    expect((await seal(bhr)).body.error.code).toBe('OPENING_SEALED');
    await expect(ctx.db.update(t.openingLines).set({ netWeightMg: 1 }).where(eq(t.openingLines.openingId, bhr))).rejects.toThrow();
    await expect(ctx.db.delete(t.openingLines).where(eq(t.openingLines.openingId, bhr))).rejects.toThrow();
    await expect(ctx.db.update(t.openings).set({ status: 'DRAFT' }).where(eq(t.openings.id, bhr))).rejects.toThrow();
    await expect(ctx.db.delete(t.openings).where(eq(t.openings.id, bhr))).rejects.toThrow();
  });
});
