// LBL-2 (docs/plans/LBL-2.md §2–§3, D-lbl2-1): an opening line gets its piece code and barcode when it is added (both
// projects).
//   * a typed line takes the next code of the piece counter (core/numbering.ts); the answer, the line and the review
//     carry it; the audit names it;
//   * an imported file takes one consecutive block in file order; a refused file takes none (the counter does not move);
//     the same file twice takes nothing more;
//   * codes follow the order of entry: a piece numbered meanwhile elsewhere takes the number in between; a removed line's
//     code is never used again (the next line takes a higher one; the audit keeps the removed code);
//   * the code of a line never changes once set (the trigger refuses it);
//   * the seal makes every piece with exactly its line's code and barcode; a reserved code already used by a piece
//     refuses the seal (409 OPENING_CODE_TAKEN) and nothing is sealed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { nextItemCode } from '../src/core/numbering';
import { createCategory } from '../src/modules/catalog/service';
import { loadActor } from '../src/modules/sessions/service';
import { addOpeningLine, createOpening, getOpening, importOpeningCsv, removeOpeningLine } from '../src/modules/openings/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, reviewedOf, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gmHttp: ReturnType<typeof request.agent>;
let gm: Actor;
let bmKrt: Actor;
let gmSession: string;
let branch: Record<string, number>;
let type: { id: number; nameAr: string };
let karat: number;
let krt: number;
let omd: number;

const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const header = 'النوع / Type,الوصف / Description,العيار / Karat,الحالة / Condition,الوزن القائم (جم) / Gross weight (g),الوزن الصافي (جم) / Net weight (g)';
const sheet = (rows: string[]) => Buffer.from([header, ...rows].join('\r\n') + '\r\n', 'utf8');
const line = (net: number, description = 'LBL-2 line') => ({ categoryId: type.id, description, karat, condition: 'NEW' as const, grossWeightMg: net + 100, netWeightMg: net });
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; details?: Record<string, unknown> }) => e);
const num = (code: string) => Number(code.slice(2));
const counter = async () => Number((await ctx.db.select({ n: t.documentSequences.next }).from(t.documentSequences).where(eq(t.documentSequences.scope, 'ITEM')))[0].n);
const linesOf = (openingId: number) =>
  ctx.db
    .select({ id: t.openingLines.id, lineNo: t.openingLines.lineNo, code: t.openingLines.reservedCode, barcode: t.openingLines.reservedBarcode, itemId: t.openingLines.itemId })
    .from(t.openingLines)
    .where(eq(t.openingLines.openingId, openingId))
    .orderBy(asc(t.openingLines.lineNo));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-11-14T09:00:00Z'), { pricingMode: 'RATE_COMPUTED' });
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gmHttp = withIdempotencyKeys(request.agent(app));
  const res = await gmHttp.post('/api/auth/login').send({ username: 'general.manager', password: PW });
  gmHttp.set('x-csrf-token', res.body.csrfToken);
  expect((await gmHttp.post('/api/auth/reauth').send({ password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gmSession = s.id;
  gm = (await loadActor(ctx.db, u.id, s.id))!;
  const [b] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'branch.manager.kh'));
  bmKrt = (await loadActor(ctx.db, b.id, null))!;
  branch = Object.fromEntries((await ctx.db.select().from(t.branches)).map((x) => [x.code, x.id]));
  type = await createCategory(ctx, gm, { nameAr: '[اختبار] خاتم LBL-2', name: '[Test] LBL-2 ring' });
  karat = (await ctx.settings.get()).inventory.allowedKarats[0];
  krt = (await createOpening(ctx, gm, { branchId: branch.KRT })).id;
  omd = (await createOpening(ctx, gm, { branchId: branch.OMD })).id;
}, 120_000);
afterAll(async () => handle?.close());

describe('codes when a line is added (D-lbl2-1)', () => {
  it('a typed line takes the next code of the piece counter; the answer, the review and the audit carry it', async () => {
    const before = await counter();
    const a = await addOpeningLine(ctx, bmKrt, krt, line(2_000));
    expect(a.code).toBe(`J-${before}`);
    expect(a.barcode).toBe(`628100${String(before).padStart(6, '0')}`);
    expect(await counter()).toBe(before + 1);
    const o = await getOpening(ctx, bmKrt, krt);
    expect(o.lines.rows.map((r) => [r.lineNo, r.code, r.barcode, r.itemId])).toEqual([[a.lineNo, a.code, a.barcode, null]]);
    // The review's search finds a draft line by its code.
    expect((await getOpening(ctx, bmKrt, krt, { q: a.code })).lines.rows.map((r) => r.id)).toEqual([a.id]);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_LINE_ADDED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.metadata).toMatchObject({ code: a.code, barcode: a.barcode });
  });

  it('an imported file takes one consecutive block in file order; a refused file takes none; the same file again takes nothing', async () => {
    const before = await counter();
    const refused = await err(importOpeningCsv(ctx, bmKrt, krt, { fileName: 'bad.csv', bytes: sheet([`${type.nameAr},ok,${karat},جديد,1.100,1.000`, `${type.nameAr},bad,${karat},جديد,1.000,2.000`]) }));
    expect(refused?.code).toBe('OPENING_IMPORT_INVALID');
    expect(await counter()).toBe(before);
    const file = sheet([1, 2, 3, 4].map((i) => `${type.nameAr},ملف ${i},${karat},جديد,1.${i}00,1.000`));
    const imp = await importOpeningCsv(ctx, bmKrt, krt, { fileName: 'four.csv', bytes: file });
    expect([imp.firstCode, imp.lastCode]).toEqual([`J-${before}`, `J-${before + 3}`]);
    const lines = (await linesOf(krt)).slice(-4);
    const descriptions = (await ctx.db.select({ id: t.openingLines.id, d: t.openingLines.description }).from(t.openingLines).where(eq(t.openingLines.importId, imp.importId)).orderBy(asc(t.openingLines.lineNo))).map((r) => r.d);
    expect(descriptions).toEqual(['ملف 1', 'ملف 2', 'ملف 3', 'ملف 4']);
    expect(lines.map((l) => l.code)).toEqual([0, 1, 2, 3].map((i) => `J-${before + i}`));
    expect(lines.every((l) => l.barcode === `628100${String(num(l.code!)).padStart(6, '0')}`)).toBe(true);
    const again = await importOpeningCsv(ctx, bmKrt, krt, { fileName: 'four.csv', bytes: file });
    expect(again.duplicate).toBe(true);
    expect(await counter()).toBe(before + 4);
  });

  it('codes follow the order of entry: a piece numbered meanwhile takes the number in between; two openings never share a code', async () => {
    const a = await addOpeningLine(ctx, gm, omd, line(1_500, 'OMD 1'));
    const elsewhere = await nextItemCode(ctx.db); // e.g. a supplier order saved between two lines
    const b = await addOpeningLine(ctx, bmKrt, krt, line(1_600, 'KRT after'));
    expect([num(a.code), num(elsewhere.code), num(b.code)]).toEqual([num(a.code), num(a.code) + 1, num(a.code) + 2]);
    const all = await ctx.db.select({ code: t.openingLines.reservedCode }).from(t.openingLines).where(sql`${t.openingLines.reservedCode} IS NOT NULL`).orderBy(asc(t.openingLines.id));
    expect(new Set(all.map((r) => r.code)).size).toBe(all.length);
  });

  it('a removed line takes its code with it: never used again; the audit keeps the code', async () => {
    const victim = await addOpeningLine(ctx, bmKrt, krt, line(1_700, 'to remove'));
    await removeOpeningLine(ctx, bmKrt, krt, victim.id);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_LINE_REMOVED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.metadata).toMatchObject({ line: { lineNo: victim.lineNo, code: victim.code, barcode: victim.barcode } });
    // The next line takes the same line number (the place on the screen) but a new, higher code.
    const next = await addOpeningLine(ctx, bmKrt, krt, line(1_800, 'after the removal'));
    expect(next.lineNo).toBe(victim.lineNo);
    expect(num(next.code)).toBeGreaterThan(num(victim.code));
    expect((await linesOf(krt)).some((l) => l.code === victim.code)).toBe(false);
  });

  it('the code of a line never changes once set (the database refuses it)', async () => {
    const [l] = await linesOf(krt);
    const changed = await ctx.db.execute(sql`UPDATE opening_lines SET reserved_code = 'J-1', reserved_barcode = '628100000001' WHERE id = ${l.id}`).then(() => 'changed', () => 'refused');
    expect(changed).toBe('refused');
    const half = await ctx.db.execute(sql`UPDATE opening_lines SET reserved_barcode = NULL WHERE id = ${l.id}`).then(() => 'changed', () => 'refused');
    expect(half).toBe('refused');
    expect((await linesOf(krt))[0].code).toBe(l.code);
  });
});

describe('the seal uses exactly the reserved codes', () => {
  async function passkeyNow() {
    await ctx.db.insert(t.webauthnCredentials).values({ userId: gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
    await ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
  }
  const seal = async (openingId: number) => gmHttp.post(`/api/openings/${openingId}/seal`).send({ confirmPassword: PW, ...(await reviewedOf(ctx.db, openingId)) });

  it('a reserved code that is already a piece refuses the seal (409 OPENING_CODE_TAKEN); nothing is sealed', async () => {
    await passkeyNow();
    const [first] = await linesOf(omd);
    // A piece with that code (impossible through the counter: made by hand here).
    const [some] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.branchId, branch.OMD)).orderBy(asc(t.jewelryItems.id)).limit(1);
    await ctx.db.execute(sql`UPDATE jewelry_items SET code = ${first.code} WHERE id = ${some.id}`);
    const res = await seal(omd);
    expect([res.status, res.body.error?.code, res.body.error?.details?.codes]).toEqual([409, 'OPENING_CODE_TAKEN', [first.code]]);
    expect((await ctx.db.select().from(t.openings).where(eq(t.openings.id, omd)))[0].status).toBe('DRAFT');
    await ctx.db.execute(sql`UPDATE jewelry_items SET code = ${some.code} WHERE id = ${some.id}`);
  });

  it('every piece has exactly its line code and barcode; firstCode and lastCode are the lowest and the highest', async () => {
    const reserved = await linesOf(krt);
    const before = await counter();
    const res = await seal(krt);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await counter()).toBe(before); // the seal numbers nothing
    const sealed = await ctx.db
      .select({ lineId: t.openingLines.id, code: t.jewelryItems.code, barcode: t.jewelryItems.barcode })
      .from(t.openingLines)
      .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingLines.itemId))
      .where(eq(t.openingLines.openingId, krt))
      .orderBy(asc(t.openingLines.lineNo));
    expect(sealed.map((s) => [s.lineId, s.code, s.barcode])).toEqual(reserved.map((r) => [r.id, r.code, r.barcode]));
    const nums = reserved.map((r) => num(r.code!));
    expect([res.body.firstCode, res.body.lastCode]).toEqual([`J-${Math.min(...nums)}`, `J-${Math.max(...nums)}`]);
    // The review of the sealed opening shows the same codes.
    expect((await getOpening(ctx, gm, krt)).lines.rows.map((r) => r.code)).toEqual(reserved.map((r) => r.code));
  });
});
