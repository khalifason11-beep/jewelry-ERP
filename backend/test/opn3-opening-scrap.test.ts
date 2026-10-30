// OPN-3 (plan docs/plans/OPN-3.md, D-opn3-*): broken scrap in the opening balance. Both projects.
//   * draft lines typed in (any karat 1–24, the net weight, an optional note ≤ 120; several of a karat), edited and
//     removed, each audited; refused values; General Manager only (the branch manager and the cashier → 403 on every
//     route); a draft line is never in the pool;
//   * the seal (same password and passkey): one OPENING movement per line into the branch's pool, no money; the stock
//     weight, the branch home and the company home count the opening scrap once; then nothing changes (409 and the
//     database trigger);
//   * an opening with broken scrap only seals, even on FIXED_TAG (the piece rules apply only to pieces); an empty one
//     does not; a supplier order of that branch is then settled with the opening scrap on day one;
//   * corrections after the seal (opening.correct, reason + password + passkey): + and −, a karat move in one
//     transaction, refused on a draft, beyond what the opening put in, below the pool's balance; audited;
//   * a property: for random draft lines, broken-scrap purchases and voids around one seal, the pool balance of every
//     karat = Σ its movements = purchases − voids + sealed lines, before and after the seal, and the stock weight's
//     broken scrap is that balance.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { pureGoldMg } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createCategory } from '../src/modules/catalog/service';
import { createOpening } from '../src/modules/openings/service';
import { addOpeningScrapLine, removeOpeningScrapLine, updateOpeningScrapLine } from '../src/modules/openings/scrap';
import { buyScrap, poolBalances } from '../src/modules/scrap/service';
import { voidScrapPurchase } from '../src/modules/scrap/void';
import { createPurchase } from '../src/modules/purchases/service';
import { settleWithScrap } from '../src/modules/supplier-settlements/service';
import { stockWeight } from '../src/modules/stock/weight';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gmHttp: ReturnType<typeof request.agent>;
let gm: Actor;
let gmSession: string;
let k: number; // an allowed karat with its rates (for the opening pieces)
let type: { id: number };

const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string }) => e);
const actorOf = async (username: string, sessionId: string | null = null): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, sessionId))!;
};
let branchNo = 0;
const newBranch = async () => {
  branchNo += 1;
  const [b] = await ctx.db.insert(t.branches).values({ code: `OS${branchNo}`, name: `Opening scrap ${branchNo}`, nameAr: `[اختبار] كسر افتتاحي ${branchNo}`, city: 'X' }).returning();
  return b;
};
const freshPasskey = () => ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
const seal = (id: number) => gmHttp.post(`/api/openings/${id}/seal`).send({ confirmPassword: PW });
const pool = async (branchId: number) => new Map((await poolBalances(ctx.db, branchId)).map((r) => [r.karat, r.weightMg]));
const movements = (branchId: number) =>
  ctx.db.select().from(t.scrapWeightEntries).where(eq(t.scrapWeightEntries.branchId, branchId)).orderBy(asc(t.scrapWeightEntries.id));
const ledgerCount = async () => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.ledgerEntries))[0].n);
const pricingMode = (mode: 'FIXED_TAG' | 'RATE_COMPUTED') => ctx.settings.apply(ctx.db, { 'pricing.mode': mode }, { actor: { id: null, username: 'test' } });
const auditCount = async (action: string) => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.auditLogs).where(eq(t.auditLogs.action, action)))[0].n);

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
  await ctx.db.insert(t.webauthnCredentials).values({ userId: gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  await freshPasskey();
  k = (await ctx.settings.get()).inventory.allowedKarats[0];
  type = await createCategory(ctx, gm, { nameAr: '[اختبار] قطعة مع كسر', name: '[Test] Piece with scrap' });
});
afterAll(async () => handle?.close());

describe('draft broken-scrap lines', () => {
  let opening: number;
  let branchId: number;
  beforeAll(async () => {
    branchId = (await newBranch()).id;
    opening = (await createOpening(ctx, gm, { branchId })).id;
  });

  it('added (any karat 1–24, several of a karat, an optional note), edited and removed; audited; never in the pool while a draft', async () => {
    const added = await auditCount('OPENING_SCRAP_LINE_ADDED');
    const a = await gmHttp.post(`/api/openings/${opening}/scrap-lines`).send({ karat: 21, weightMg: 250_500, note: '  bag 1 ' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const b = await gmHttp.post(`/api/openings/${opening}/scrap-lines`).send({ karat: 21, weightMg: 1_000 });
    const c = await gmHttp.post(`/api/openings/${opening}/scrap-lines`).send({ karat: 9, weightMg: 3_333, note: '' });
    expect([b.status, c.status]).toEqual([200, 200]);
    expect(await auditCount('OPENING_SCRAP_LINE_ADDED')).toBe(added + 3);
    const o = (await gmHttp.get(`/api/openings/${opening}`)).body;
    expect(o.scrapLines.map((l: { lineNo: number; karat: number; weightMg: number; note: string | null }) => [l.lineNo, l.karat, l.weightMg, l.note])).toEqual([
      [1, 21, 250_500, 'bag 1'],
      [2, 21, 1_000, null],
      [3, 9, 3_333, null],
    ]);
    expect(o.summary.scrap).toEqual({
      byKarat: [
        { karat: 9, lines: 1, weightMg: 3_333, pureMg24: pureGoldMg(3_333, 9) },
        { karat: 21, lines: 2, weightMg: 251_500, pureMg24: pureGoldMg(251_500, 21) },
      ],
      lines: 3,
      weightMg: 254_833,
      pureMg24: pureGoldMg(3_333, 9) + pureGoldMg(251_500, 21),
    });
    expect(o.scrapCorrections).toEqual([]);
    expect(o.scrapNow).toBeNull();

    const e = await gmHttp.post(`/api/openings/${opening}/scrap-lines/${b.body.id}`).send({ karat: 18, weightMg: 2_000, note: 'bag 2' });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const same = await gmHttp.post(`/api/openings/${opening}/scrap-lines/${b.body.id}`).send({ karat: 18, weightMg: 2_000, note: 'bag 2' });
    expect([same.status, same.body.error.code]).toEqual([422, 'OPENING_LINE_UNCHANGED']);
    const [changed] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_SCRAP_LINE_CHANGED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(changed.metadata).toMatchObject({ before: { karat: 21, weightMg: 1_000, note: null }, after: { karat: 18, weightMg: 2_000, note: 'bag 2' } });
    const r = await gmHttp.post(`/api/openings/${opening}/scrap-lines/${c.body.id}/remove`).send({});
    expect(r.status).toBe(200);
    expect(await auditCount('OPENING_SCRAP_LINE_REMOVED')).toBeGreaterThan(0);
    expect((await gmHttp.get(`/api/openings/${opening}`)).body.scrapLines.map((l: { karat: number }) => l.karat)).toEqual([21, 18]);
    expect(await movements(branchId)).toEqual([]);
    expect((await gmHttp.get('/api/openings')).body.branches.find((x: { branchId: number }) => x.branchId === branchId).opening.scrapWeightMg).toBe(252_500);
  });

  it('refused values: karat 0 or 25, weight 0, a note over 120 characters, an unknown line', async () => {
    for (const body of [{ karat: 0, weightMg: 1 }, { karat: 25, weightMg: 1 }, { karat: 21, weightMg: 0 }, { karat: 21, weightMg: 1, note: 'x'.repeat(121) }, { karat: 21 }]) {
      const res = await gmHttp.post(`/api/openings/${opening}/scrap-lines`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await gmHttp.post(`/api/openings/${opening}/scrap-lines/999999/remove`).send({})).status).toBe(404);
    expect((await gmHttp.post(`/api/openings/${opening}/scrap-lines/999999`).send({ karat: 21, weightMg: 1 })).status).toBe(404);
  });

  it('General Manager only: the branch manager and the cashier get 403 on every route', async () => {
    const [line] = await ctx.db.select().from(t.openingScrapLines).where(eq(t.openingScrapLines.openingId, opening)).limit(1);
    for (const [user, role] of [['branch.manager.kh', 'BRANCH_MANAGER'], ['cashier.kh.01', 'CASHIER']] as const) {
      const agent = withIdempotencyKeys(request.agent(app));
      const r = await agent.post('/api/auth/login').send({ username: user, password: DEMO_PASSWORDS[role] });
      agent.set('x-csrf-token', r.body.csrfToken);
      expect((await agent.post(`/api/openings/${opening}/scrap-lines`).send({ karat: 21, weightMg: 1 })).status, role).toBe(403);
      expect((await agent.post(`/api/openings/${opening}/scrap-lines/${line.id}`).send({ karat: 21, weightMg: 5 })).status, role).toBe(403);
      expect((await agent.post(`/api/openings/${opening}/scrap-lines/${line.id}/remove`).send({})).status, role).toBe(403);
      expect((await agent.post(`/api/openings/${opening}/scrap-corrections`).send({ changes: [{ karat: 21, weightMgChange: 1 }], reason: 'x'.repeat(5), confirmPassword: 'x' })).status, role).toBe(403);
    }
  });

  it('a correction of a draft is refused (409 OPENING_NOT_SEALED)', async () => {
    await freshPasskey();
    const res = await gmHttp.post(`/api/openings/${opening}/scrap-corrections`).send({ changes: [{ karat: 21, weightMgChange: -1 }], reason: 'counted again', confirmPassword: PW });
    expect([res.status, res.body.error.code]).toEqual([409, 'OPENING_NOT_SEALED']);
  });
});

describe('the seal posts the broken scrap into the pool', () => {
  it('pieces and scrap: one OPENING movement per line, no money; the stock weight and the homes count it once; then nothing changes', async () => {
    const b = await newBranch();
    const o = (await createOpening(ctx, gm, { branchId: b.id })).id;
    expect((await gmHttp.post(`/api/openings/${o}/lines`).send({ categoryId: type.id, karat: k, condition: 'NEW', grossWeightMg: 5_000, netWeightMg: 5_000 })).status).toBe(200);
    const lines = [
      { karat: 21, weightMg: 100_000 },
      { karat: 21, weightMg: 20_500 },
      { karat: 18, weightMg: 7_250 },
    ];
    for (const l of lines) expect((await gmHttp.post(`/api/openings/${o}/scrap-lines`).send(l)).status).toBe(200);
    const ledger = await ledgerCount();
    const before = await stockWeight(ctx.db, b.id);
    expect(before.byBranch.get(b.id)).toBeUndefined();
    await freshPasskey();
    const res = await seal(o);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pieces).toBe(1);
    expect(res.body.scrap.weightMg).toBe(127_750);
    expect(res.body.scrap.byKarat.map((x: { karat: number; weightMg: number }) => [x.karat, x.weightMg])).toEqual([[18, 7_250], [21, 120_500]]);
    expect(await ledgerCount()).toBe(ledger);

    const moves = await movements(b.id);
    const sealedLines = await ctx.db.select().from(t.openingScrapLines).where(eq(t.openingScrapLines.openingId, o)).orderBy(asc(t.openingScrapLines.lineNo));
    expect(moves.map((m) => [m.eventType, m.karat, m.weightMg, m.refType, m.refId, m.refNumber])).toEqual(
      sealedLines.map((l) => ['OPENING', l.karat, l.weightMg, 'opening_scrap_line', l.id, `OPN-${b.code}`]),
    );
    expect(await pool(b.id)).toEqual(new Map([[18, 7_250], [21, 120_500]]));

    // The stock weight: pieces + pool, the opening scrap once; the branch and company homes show the same figure.
    const sw = (await stockWeight(ctx.db, b.id)).byBranch.get(b.id)!;
    expect(sw.brokenScrap.weightMg).toBe(127_750);
    expect(sw.brokenScrap.pureMg24).toBe(pureGoldMg(7_250, 18) + pureGoldMg(120_500, 21));
    expect(sw.items.weightMg).toBe(5_000);
    expect(sw.totalWeightMg).toBe(132_750);
    const company = (await gmHttp.get('/api/dashboard/company')).body;
    expect(company.branches.find((x: { code: string }) => x.code === b.code).brokenScrapWeightMg).toBe(127_750);
    const pv = (await gmHttp.get('/api/scrap-pool').query({ branchId: b.id })).body;
    expect(pv.weightMg).toBe(127_750);

    // Sealed: nothing is added, changed or removed (service and database).
    const [line] = sealedLines;
    expect((await gmHttp.post(`/api/openings/${o}/scrap-lines`).send({ karat: 21, weightMg: 1 })).body.error.code).toBe('OPENING_SEALED');
    expect((await gmHttp.post(`/api/openings/${o}/scrap-lines/${line.id}`).send({ karat: 21, weightMg: 1 })).body.error.code).toBe('OPENING_SEALED');
    expect((await gmHttp.post(`/api/openings/${o}/scrap-lines/${line.id}/remove`).send({})).body.error.code).toBe('OPENING_SEALED');
    await expect(ctx.db.update(t.openingScrapLines).set({ weightMg: 1 }).where(eq(t.openingScrapLines.id, line.id))).rejects.toThrow();
    await expect(ctx.db.delete(t.openingScrapLines).where(eq(t.openingScrapLines.id, line.id))).rejects.toThrow();
    // The sealed page: the scrap as sealed, and now (no correction yet).
    const page = (await gmHttp.get(`/api/openings/${o}`)).body;
    expect(page.scrapNow.weightMg).toBe(127_750);
    expect(page.summary.scrap.weightMg).toBe(127_750);
    // The audit of the seal names the scrap.
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_SEALED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.descriptionKey).toContain('broken scrap');
  });

  it('broken scrap only: sealed even on FIXED_TAG (the piece rules apply to pieces); an empty opening is refused (422)', async () => {
    const empty = (await createOpening(ctx, gm, { branchId: (await newBranch()).id })).id;
    await freshPasskey();
    const e = await seal(empty);
    expect([e.status, e.body.error.code]).toEqual([422, 'OPENING_EMPTY']);

    const b = await newBranch();
    const o = (await createOpening(ctx, gm, { branchId: b.id })).id;
    await addOpeningScrapLine(ctx, gm, o, { karat: 22, weightMg: 40_000 });
    await pricingMode('FIXED_TAG');
    try {
      await freshPasskey();
      const res = await seal(o);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect([res.body.pieces, res.body.firstCode, res.body.lastCode, res.body.scrap.weightMg]).toEqual([0, null, null, 40_000]);
    } finally {
      await pricingMode('RATE_COMPUTED');
    }
    expect(await pool(b.id)).toEqual(new Map([[22, 40_000]]));
  });

  it('day one: a supplier order of the branch is settled with the opening broken scrap', async () => {
    const b = await newBranch();
    const o = (await createOpening(ctx, gm, { branchId: b.id })).id;
    await addOpeningScrapLine(ctx, gm, o, { karat: 21, weightMg: 30_000 });
    await freshPasskey();
    expect((await seal(o)).status).toBe(200);
    const [supplier] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    const order = await createPurchase(ctx, gm, {
      branchId: b.id,
      supplierId: supplier.id,
      supplierInvoiceNo: 'OPN3-DAY-ONE',
      confirmOpenSupplierDebt: true,
      lines: [{ categoryId: type.id, karat: k, grossWeightMg: 10_000, netWeightMg: 10_000, purchaseCost: 1_000_000, makingCost: 0, otherCost: 0 }],
    });
    const s = await settleWithScrap(ctx, gm, order.id, { karat: 21, weightMg: 8_000 });
    expect(s.settledPureMg24).toBe(pureGoldMg(8_000, 21));
    expect(await pool(b.id)).toEqual(new Map([[21, 22_000]]));
  });
});

describe('corrections after the seal (opening.correct, reason + password + passkey)', () => {
  let o: number;
  let branchId: number;
  beforeAll(async () => {
    const b = await newBranch();
    branchId = b.id;
    o = (await createOpening(ctx, gm, { branchId })).id;
    await addOpeningScrapLine(ctx, gm, o, { karat: 21, weightMg: 50_000 });
    await addOpeningScrapLine(ctx, gm, o, { karat: 18, weightMg: 10_000 });
    await freshPasskey();
    expect((await seal(o)).status).toBe(200);
  });
  const correct = (changes: { karat: number; weightMgChange: number }[], extra: object = {}) =>
    gmHttp.post(`/api/openings/${o}/scrap-corrections`).send({ changes, reason: 'counted again', confirmPassword: PW, ...extra });

  it('refused without a reason, without the password, with a stale passkey, with two changes of one karat or a change of 0', async () => {
    await freshPasskey();
    expect((await correct([{ karat: 21, weightMgChange: -1_000 }], { reason: 'x' })).body.error.code).toBe('CORRECTION_REASON_REQUIRED');
    expect((await correct([{ karat: 21, weightMgChange: -1_000 }], { confirmPassword: undefined })).body.error.code).toBe('CONFIRM_PASSWORD_REQUIRED');
    expect((await correct([{ karat: 21, weightMgChange: 0 }])).status).toBe(400);
    expect((await correct([{ karat: 21, weightMgChange: 1 }, { karat: 21, weightMgChange: -1 }])).status).toBe(400);
    expect((await correct([])).status).toBe(400);
    await ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(Date.now() - 60 * 60_000) }).where(eq(t.sessions.id, gmSession));
    expect((await correct([{ karat: 21, weightMgChange: -1_000 }])).body.error.code).toBe('REAUTH_REQUIRED');
    expect(await ctx.db.select().from(t.openingScrapCorrections).where(eq(t.openingScrapCorrections.openingId, o))).toEqual([]);
  });

  it('− and +, and a karat move in one transaction: correction rows, OPENING_CORRECTION movements, audit, the scrap now', async () => {
    await freshPasskey();
    const minus = await correct([{ karat: 21, weightMgChange: -2_500 }]);
    expect(minus.status, JSON.stringify(minus.body)).toBe(200);
    const plus = await correct([{ karat: 22, weightMgChange: 4_000 }]);
    expect(plus.status, JSON.stringify(plus.body)).toBe(200);
    const move = await correct([{ karat: 18, weightMgChange: -3_000 }, { karat: 21, weightMgChange: 3_000 }]);
    expect(move.status, JSON.stringify(move.body)).toBe(200);
    expect(await pool(branchId)).toEqual(new Map([[18, 7_000], [21, 50_500], [22, 4_000]]));
    const moves = (await movements(branchId)).filter((m) => m.eventType === 'OPENING_CORRECTION');
    expect(moves.map((m) => [m.karat, m.weightMg, m.refType])).toEqual([
      [21, -2_500, 'opening_scrap_correction'],
      [22, 4_000, 'opening_scrap_correction'],
      [18, -3_000, 'opening_scrap_correction'],
      [21, 3_000, 'opening_scrap_correction'],
    ]);
    const page = (await gmHttp.get(`/api/openings/${o}`)).body;
    expect(page.scrapCorrections.map((c: { karat: number; weightMgChange: number; reason: string }) => [c.karat, c.weightMgChange, c.reason])).toEqual([
      [21, -2_500, 'counted again'],
      [22, 4_000, 'counted again'],
      [18, -3_000, 'counted again'],
      [21, 3_000, 'counted again'],
    ]);
    expect(page.scrapNow.byKarat.map((x: { karat: number; weightMg: number }) => [x.karat, x.weightMg])).toEqual([[18, 7_000], [21, 50_500], [22, 4_000]]);
    // The sealed totals stay as sealed.
    expect(page.summary.scrap.weightMg).toBe(60_000);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_SCRAP_CORRECTED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.metadata).toMatchObject({ openingId: o, reason: 'counted again', changes: [{ karat: 18, weightMgChange: -3_000 }, { karat: 21, weightMgChange: 3_000 }] });
  });

  it('never more out than the opening put in for the karat (409), never below the pool balance (409); nothing written', async () => {
    await freshPasskey();
    // 22K: the opening put in 0 + 4,000 by correction; 4,001 out is too much.
    const tooMuch = await correct([{ karat: 22, weightMgChange: -4_001 }]);
    expect([tooMuch.status, tooMuch.body.error.code]).toEqual([409, 'OPENING_SCRAP_CORRECTION_TOO_LARGE']);
    // 24K: never in this opening.
    expect((await correct([{ karat: 24, weightMgChange: -1 }])).body.error.code).toBe('OPENING_SCRAP_CORRECTION_TOO_LARGE');
    // 21K: a supplier took 45,000 of the 50,500; taking 6,000 out would go below 0.
    const [supplier] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
    const order = await createPurchase(ctx, gm, { branchId, supplierId: supplier.id, supplierInvoiceNo: 'OPN3-SHORT', confirmOpenSupplierDebt: true, lines: [{ categoryId: type.id, karat: k, grossWeightMg: 60_000, netWeightMg: 60_000, purchaseCost: 1_000_000, makingCost: 0, otherCost: 0 }] });
    await settleWithScrap(ctx, gm, order.id, { karat: 21, weightMg: 45_000 });
    const short = await correct([{ karat: 21, weightMgChange: -6_000 }]);
    expect([short.status, short.body.error.code]).toEqual([409, 'SCRAP_POOL_SHORT']);
    // A move where one half is refused writes neither half.
    const half = await correct([{ karat: 18, weightMgChange: 6_000 }, { karat: 21, weightMgChange: -6_000 }]);
    expect(half.body.error.code).toBe('SCRAP_POOL_SHORT');
    expect(await pool(branchId)).toEqual(new Map([[18, 7_000], [21, 5_500], [22, 4_000]]));
    expect((await ctx.db.select().from(t.openingScrapCorrections).where(eq(t.openingScrapCorrections.openingId, o))).length).toBe(4);
  });
});

describe('property: the pool equals the sum of its movements, before and after the seal', () => {
  it('random draft lines, broken-scrap purchases and voids around one seal', async () => {
    const rated = (await ctx.db.select({ karat: t.scrapRates.karat }).from(t.scrapRates).orderBy(asc(t.scrapRates.karat))).map((r) => r.karat);
    const karats = [...new Set(rated)].slice(0, 3);
    expect(karats.length).toBeGreaterThan(0);
    type Op = { kind: 'line'; karat: number; mg: number } | { kind: 'edit'; i: number; mg: number } | { kind: 'remove'; i: number } | { kind: 'buy'; karat: number; mg: number } | { kind: 'void'; i: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant('line' as const), karat: fc.constantFrom(...karats, 1, 24), mg: fc.integer({ min: 1, max: 50_000 }) }),
      fc.record({ kind: fc.constant('edit' as const), i: fc.nat(5), mg: fc.integer({ min: 1, max: 50_000 }) }),
      fc.record({ kind: fc.constant('remove' as const), i: fc.nat(5) }),
      fc.record({ kind: fc.constant('buy' as const), karat: fc.constantFrom(...karats), mg: fc.integer({ min: 1_000, max: 20_000 }) }),
      fc.record({ kind: fc.constant('void' as const), i: fc.nat(5) }),
    );
    let ref = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 8 }), fc.array(op, { maxLength: 4 }), async (beforeSeal, afterSeal) => {
        const b = await newBranch();
        const o = (await createOpening(ctx, gm, { branchId: b.id })).id;
        const lines: number[] = [];
        const purchases: { id: number; voided: boolean }[] = [];
        const apply = async (x: Op, sealed: boolean) => {
          if (x.kind === 'line' && !sealed) lines.push((await addOpeningScrapLine(ctx, gm, o, { karat: x.karat, weightMg: x.mg })).id);
          if (x.kind === 'edit' && !sealed && lines.length) {
            const id = lines[x.i % lines.length];
            const [l] = await ctx.db.select().from(t.openingScrapLines).where(eq(t.openingScrapLines.id, id));
            if (l.weightMg !== x.mg) await updateOpeningScrapLine(ctx, gm, o, id, { karat: l.karat, weightMg: x.mg, note: l.note });
          }
          if (x.kind === 'remove' && !sealed && lines.length) await removeOpeningScrapLine(ctx, gm, o, lines.splice(x.i % lines.length, 1)[0]);
          if (x.kind === 'buy') {
            ref += 1;
            const p = await buyScrap(ctx, gm, { branchId: b.id, kind: 'BROKEN', karat: x.karat, grossWeightMg: x.mg, netWeightMg: x.mg, paymentMethod: 'BANK_TRANSFER', bankReference: `OPN3REF${ref}` });
            purchases.push({ id: p.id, voided: false });
          }
          if (x.kind === 'void' && purchases.some((p) => !p.voided)) {
            const open = purchases.filter((p) => !p.voided);
            const p = open[x.i % open.length];
            await voidScrapPurchase(ctx, gm, p.id, { reason: 'property test', confirmPassword: PW });
            p.voided = true;
          }
        };
        // Expected per karat from the business records, never from the pool itself.
        const expected = async (withLines: boolean) => {
          const m = new Map<number, number>();
          const add = (karat: number, mg: number) => m.set(karat, (m.get(karat) ?? 0) + mg);
          for (const p of purchases) if (!p.voided) {
            const [row] = await ctx.db.select().from(t.scrapPurchases).where(eq(t.scrapPurchases.id, p.id));
            add(row.karat, row.netWeightMg);
          }
          if (withLines) for (const l of await ctx.db.select().from(t.openingScrapLines).where(eq(t.openingScrapLines.openingId, o))) add(l.karat, l.weightMg);
          return new Map([...m].filter(([, w]) => w !== 0).sort((a, c) => a[0] - c[0]));
        };
        const check = async (withLines: boolean) => {
          const balances = await pool(b.id);
          const sums = new Map<number, number>();
          for (const mv of await movements(b.id)) sums.set(mv.karat, (sums.get(mv.karat) ?? 0) + mv.weightMg);
          expect(balances).toEqual(new Map([...sums].filter(([, w]) => w !== 0)));
          expect(balances).toEqual(await expected(withLines));
          const sw = (await stockWeight(ctx.db, b.id)).byBranch.get(b.id);
          expect(sw?.brokenScrap.weightMg ?? 0).toBe([...balances.values()].reduce((s, w) => s + w, 0));
        };
        for (const x of beforeSeal) await apply(x, false);
        await check(false); // draft lines never count
        const hasLines = lines.length > 0;
        if (hasLines) {
          await freshPasskey();
          const res = await seal(o);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
        }
        for (const x of afterSeal) await apply(x, hasLines);
        await check(hasLines);
      }),
      { numRuns: 12, seed: 3037, endOnFailure: true },
    );
  }, 300_000);
});

describe('errors stay errors', () => {
  it('an unknown opening → 404', async () => {
    expect((await gmHttp.post('/api/openings/999999/scrap-lines').send({ karat: 21, weightMg: 1 })).status).toBe(404);
    const e = await err(addOpeningScrapLine(ctx, gm, 999_999, { karat: 21, weightMg: 1 }));
    expect(e?.status).toBe(404);
  });
});
