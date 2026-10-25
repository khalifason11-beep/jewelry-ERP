// OPN-FIX (plan docs/plans/OPN-FIX.md, D-opnfix-1…5): correcting or voiding a piece of a sealed opening. Both projects.
//   * who: `opening.correct`, General Manager only (403 for the branch manager and the cashier, on the write and the
//     preview); a reason, the password and a fresh passkey, as the seal;
//   * which piece: AVAILABLE pieces of that sealed opening, in any branch (the record and the audit name the branch it
//     is in); every refusal (not an opening piece, another opening, sold, in transit, unchanged, a karat not sold, bad
//     weights, FIXED_TAG for condition and karat, a missing rate) writes nothing;
//   * the preview gives the current and the new price and the valuation change, writes nothing, and agrees with the write;
//   * consistency: after a condition, karat or net-weight correction and a void, every reader (piece page, list, its
//     price sort and totals, the POS search, the inventory valuation, the branch metrics, the stock-weight report, the
//     inventory ledger) returns the corrected value, and nothing else moves; the cost stays unknown (NULL);
//   * idempotent replay; audit without the password; a property test over random correction sequences.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fc from 'fast-check';
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
import { createTransfer, receiveTransfer } from '../src/modules/transfers/service';
import { stockWeight } from '../src/modules/stock/weight';
import { ledgerStock } from '../src/modules/inventory/ledger';
import { currentSellingRates, pricingOf, rateKey } from '../src/modules/pricing/service';
import { branchMetrics } from '../src/modules/reports/metrics';
import { periodFor } from '../src/modules/dashboard/service';
import { addOpeningLine, createOpening, sealOpening } from '../src/modules/openings/service';
import { correctOpeningPiece } from '../src/modules/openings/corrections';
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
let krt: number;
let opening: number;
let k: number; // a karat with both rates
let k2: number; // another allowed karat with both rates
const pieces: Record<string, number> = {};

const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
type Err = { status?: number; code?: string; key?: string; params?: Record<string, unknown> } | null;
const err = async (p: Promise<unknown>): Promise<Err> => p.then(() => null, (e: Err) => e);
const actorOf = async (username: string, sessionId: string | null = null): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, sessionId))!;
};
const piece = async (id: number) => (await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, id)))[0];
const corrections = async () => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.openingPieceCorrections))[0].n);
const rate = async (karat: number, kind: GoldRateKind) => (await currentSellingRates(ctx.db)).get(rateKey(karat, kind))!.pricePerGram;
const step = async () => (await ctx.settings.get()).pricing.roundingStep;
const fresh = () => ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
const pricingMode = (mode: 'FIXED_TAG' | 'RATE_COMPUTED') => ctx.settings.apply(ctx.db, { 'pricing.mode': mode }, { actor: { id: null, username: 'test' } });
const correct = (itemId: number, body: object) => gmHttp.post(`/api/openings/${opening}/pieces/${itemId}/correction`).send({ reason: 'Weighed again', confirmPassword: PW, ...body });
const preview = (itemId: number, q: object) => gmHttp.get(`/api/openings/${opening}/pieces/${itemId}/correction-preview`).query(q);

interface Row { id: number; code: string; sellingPrice: number | null; netWeightMg: number; karat: number; rateKind: string }
/** Every reader of a piece's price and weight, for one branch. */
async function snapshot(branchId: number) {
  const list = new Map<number, Row>();
  for (let page = 1; ; page++) {
    const body = (await gmHttp.get('/api/inventory/items').query({ branchId, status: 'AVAILABLE', pageSize: 200, page })).body as { rows: Row[]; total: number };
    for (const r of body.rows) list.set(r.id, r);
    if (!body.rows.length || list.size >= body.total) break;
  }
  const sorted = (await gmHttp.get('/api/inventory/items').query({ branchId, status: 'AVAILABLE', sort: 'price', pageSize: 200 })).body.rows as Row[];
  const listTotal = (await gmHttp.get('/api/inventory/items').query({ branchId, status: 'AVAILABLE', pageSize: 1 })).body.totals.sellingPrice as number;
  const valuation = (await gmHttp.get('/api/reports/inventory').query({ branchId, status: 'AVAILABLE' })).body.totals.sellingPrice as number;
  const metrics = [...(await branchMetrics(ctx.db, await periodFor(ctx), branchId, await pricingOf(ctx))).values()][0];
  const sw = (await stockWeight(ctx.db, branchId)).byBranch.get(branchId)!;
  const ledger = await ledgerStock(ctx.db, branchId, new Date(Date.now() + 60_000));
  return { list, sorted, listTotal, valuation, retail: metrics.inventoryRetail, available: metrics.availableItems, stockWeightMg: sw.items.weightMg, byKarat: sw.items.byKarat ?? null, ledger };
}
const ascending = (rows: Row[]) => rows.every((r, i) => i === 0 || (rows[i - 1].sellingPrice ?? -1) <= (r.sellingPrice ?? -1));

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
  const branches = await ctx.db.select().from(t.branches).orderBy(asc(t.branches.id));
  bhr = branches.find((b) => b.code === 'BHR')!.id;
  krt = branches.find((b) => b.code === 'KRT')!.id;
  await ctx.db.insert(t.webauthnCredentials).values({ userId: gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  await fresh();
  const { inventory } = await ctx.settings.get();
  const rates = await currentSellingRates(ctx.db);
  // Two sold karats with both rates (the karat test needs two): the second one's rates are set here when the world has
  // none, so that test never skips.
  k = inventory.allowedKarats.find((x) => rates.has(rateKey(x, 'NEW')) && rates.has(rateKey(x, 'USED')))!;
  k2 = inventory.allowedKarats.find((x) => x !== k) ?? [18, 22, 24, 14, 12, 9, 10].find((x) => x !== k && !inventory.allowedKarats.includes(x))!;
  if (!inventory.allowedKarats.includes(k2)) await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [...inventory.allowedKarats, k2] }, { actor: { id: null, username: 'system' }, allowGuarded: true });
  const set = await gmHttp.post('/api/gold-rates').send({ rates: { [k2]: Math.round((await rate(k, 'NEW')) * 0.85) }, usedRates: { [k2]: Math.round((await rate(k, 'USED')) * 0.85) }, reason: 'test: rates of a second karat', confirmPassword: PW });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  // A sealed opening of BHR: one piece per scenario, all 10 g net of karat k, new.
  const type = await createCategory(ctx, gm, { nameAr: '[اختبار] قطعة للتصحيح', name: '[Test] Piece to correct' });
  opening = (await createOpening(ctx, gm, { branchId: bhr })).id;
  const names = ['condition', 'karat', 'weight', 'void', 'sold', 'transit', 'moved', 'replay', 'property', 'refusals'];
  for (const description of names) await addOpeningLine(ctx, gm, opening, { categoryId: type.id, description, karat: k, condition: 'NEW', grossWeightMg: 10_500, netWeightMg: 10_000 });
  await sealOpening(ctx, gm, opening, { confirmPassword: PW });
  const lines = await ctx.db.select({ d: t.openingLines.description, item: t.openingLines.itemId }).from(t.openingLines).where(eq(t.openingLines.openingId, opening));
  for (const l of lines) pieces[l.d!] = l.item!;
  // A sold piece, a piece in transit, a piece moved to KRT and received there.
  const shown = (await err(createSale(ctx, cashierBhr, { items: [{ itemId: pieces.sold }], paymentMethod: 'CASH' }))) as { details?: { lines: { listPrice: number }[] } };
  await createSale(ctx, cashierBhr, { items: [{ itemId: pieces.sold, listPrice: shown.details!.lines[0].listPrice }], paymentMethod: 'CASH' });
  await createTransfer(ctx, gm, { fromBranchId: bhr, toBranchId: krt, itemIds: [pieces.transit], courierName: 'Test courier' });
  const moved = await createTransfer(ctx, gm, { fromBranchId: bhr, toBranchId: krt, itemIds: [pieces.moved], courierName: 'Test courier' });
  await receiveTransfer(ctx, gm, moved.id);
});
afterAll(async () => handle?.close());

describe('who may correct, and how they confirm', () => {
  it('the branch manager and the cashier: 403 on the correction and the preview', async () => {
    for (const [user, role] of [['branch.manager.bhr', 'BRANCH_MANAGER'], ['cashier.bhr.01', 'CASHIER']] as const) {
      const agent = withIdempotencyKeys(request.agent(app));
      const r = await agent.post('/api/auth/login').send({ username: user, password: DEMO_PASSWORDS[role] });
      agent.set('x-csrf-token', r.body.csrfToken);
      expect((await agent.post(`/api/openings/${opening}/pieces/${pieces.refusals}/correction`).send({ action: 'VOID', reason: 'not mine', confirmPassword: DEMO_PASSWORDS[role] })).status, role).toBe(403);
      expect((await agent.get(`/api/openings/${opening}/pieces/${pieces.refusals}/correction-preview`).query({ action: 'VOID' })).status, role).toBe(403);
    }
  });

  it('a reason, the password and a fresh passkey are required; each refusal writes nothing', async () => {
    const before = [await corrections(), await piece(pieces.refusals)];
    expect((await correct(pieces.refusals, { action: 'VOID', reason: ' x ' })).body.error.code).toBe('CORRECTION_REASON_REQUIRED');
    expect((await correct(pieces.refusals, { action: 'VOID', confirmPassword: undefined })).body.error.code).toBe('CONFIRM_PASSWORD_REQUIRED');
    expect((await correct(pieces.refusals, { action: 'VOID', confirmPassword: 'wrong password' })).status).toBe(403);
    expect((await gmHttp.post('/api/auth/reauth').send({ password: PW })).status).toBe(200);
    await ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(Date.now() - 60 * 60_000) }).where(eq(t.sessions.id, gmSession));
    expect((await err(correctOpeningPiece(ctx, gm, opening, pieces.refusals, { action: 'VOID', reason: 'stale passkey', confirmPassword: PW })))?.code).toBe('REAUTH_REQUIRED');
    await ctx.db.update(t.webauthnCredentials).set({ revokedAt: new Date(), revokedReason: 'test' }).where(eq(t.webauthnCredentials.userId, gm.userId));
    expect((await err(correctOpeningPiece(ctx, gm, opening, pieces.refusals, { action: 'VOID', reason: 'no passkey', confirmPassword: PW })))?.code).toBe('PASSKEY_REQUIRED');
    await ctx.db.insert(t.webauthnCredentials).values({ userId: gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
    await fresh();
    expect([await corrections(), await piece(pieces.refusals)]).toEqual(before);
  });
});

describe('which pieces and which values', () => {
  it('refused: another opening or not an opening piece, sold, in transit, unchanged, a karat not sold, bad weights; nothing written', async () => {
    const before = [await corrections(), await piece(pieces.refusals)];
    const supplier = (await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.origin, 'SUPPLIER_NEW'), eq(t.jewelryItems.status, 'AVAILABLE'))).orderBy(asc(t.jewelryItems.id)).limit(1))[0];
    expect((await correct(supplier.id, { action: 'VOID' })).body.error.code).toBe('NOT_AN_OPENING_PIECE');
    const other = (await ctx.db.select().from(t.openings).where(eq(t.openings.branchId, krt)))[0] ?? (await createOpening(ctx, gm, { branchId: krt }));
    expect((await gmHttp.post(`/api/openings/${other.id}/pieces/${pieces.refusals}/correction`).send({ action: 'VOID', reason: 'wrong opening', confirmPassword: PW })).body.error.code).toBe('NOT_AN_OPENING_PIECE');
    const sold = await correct(pieces.sold, { action: 'CORRECT', condition: 'USED' });
    expect([sold.status, sold.body.error.code, sold.body.error.params.status]).toEqual([409, 'OPENING_PIECE_NOT_AVAILABLE', 'SOLD']);
    const transit = await correct(pieces.transit, { action: 'VOID' });
    expect([transit.status, transit.body.error.code]).toEqual([409, 'OPENING_PIECE_NOT_AVAILABLE']);
    expect(transit.body.error.message).toMatch(/receive it first/);
    expect((await correct(pieces.refusals, { action: 'CORRECT', condition: 'NEW', karat: k })).body.error.code).toBe('OPENING_CORRECTION_UNCHANGED');
    expect((await correct(pieces.refusals, { action: 'CORRECT', karat: 13 })).status).toBe(400);
    expect((await correct(pieces.refusals, { action: 'CORRECT', netWeightMg: 11_000 })).status).toBe(422);
    expect((await correct(pieces.refusals, { action: 'CORRECT', netWeightMg: 0 })).status).toBe(400);
    expect([await corrections(), await piece(pieces.refusals)]).toEqual(before);
  });

  it('FIXED_TAG refuses condition and karat corrections, allows weights; a missing rate is refused (OPENING_RATES_MISSING)', async () => {
    await pricingMode('FIXED_TAG');
    expect((await correct(pieces.refusals, { action: 'CORRECT', condition: 'USED' })).body.error.code).toBe('OPENING_NEEDS_COMPUTED_PRICES');
    expect((await correct(pieces.refusals, { action: 'CORRECT', karat: k2 })).body.error.code).toBe('OPENING_NEEDS_COMPUTED_PRICES');
    const w = await correct(pieces.refusals, { action: 'CORRECT', grossWeightMg: 10_600 });
    expect([w.status, w.body.kind]).toEqual([200, 'CORRECT']);
    await pricingMode('RATE_COMPUTED');
    // A karat that is sold but has no rate yet.
    const { inventory } = await ctx.settings.get();
    const rates = await currentSellingRates(ctx.db);
    const kx = [9, 10, 12, 14, 15, 16, 20].find((x) => !inventory.allowedKarats.includes(x) && !rates.has(rateKey(x, 'NEW')))!;
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [...inventory.allowedKarats, kx] }, { actor: { id: null, username: 'system' }, allowGuarded: true });
    const missing = await correct(pieces.refusals, { action: 'CORRECT', karat: kx });
    expect([missing.status, missing.body.error.code, missing.body.error.params]).toEqual([409, 'OPENING_RATES_MISSING', { newKarats: `${kx}K`, usedKarats: '' }]);
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': inventory.allowedKarats }, { actor: { id: null, username: 'system' }, allowGuarded: true });
  });
});

describe('every reader returns the corrected value; nothing else moves', () => {
  it('the condition (NEW → USED): the preview, then the piece page, list, sort, totals, POS search, valuation and homes', async () => {
    const id = pieces.condition;
    const s0 = await snapshot(bhr);
    const [rowsBefore, pieceBefore, movesBefore] = [await corrections(), await piece(id), (await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, id))).length];
    const p = (await preview(id, { action: 'CORRECT', condition: 'USED' })).body;
    // The preview wrote nothing (no Idempotency-Key needed, no row, the piece and its movements unchanged).
    expect([await corrections(), await piece(id), (await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, id))).length]).toEqual([rowsBefore, pieceBefore, movesBefore]);
    const [newPrice, usedPrice] = [computedPrice(10_000, await rate(k, 'NEW'), await step())!, computedPrice(10_000, await rate(k, 'USED'), await step())!];
    expect(p).toMatchObject({ before: { condition: 'NEW', sellingPrice: newPrice }, after: { condition: 'USED', sellingPrice: usedPrice }, valuationChange: usedPrice - newPrice, stockWeightChangeMg: 0, stockCountChange: 0 });
    const n0 = await corrections();
    const r = await correct(id, { action: 'CORRECT', condition: 'USED', reason: 'It is a used piece' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: 'CORRECT', sellingPriceBefore: newPrice, sellingPriceAfter: usedPrice, branchId: bhr });
    expect(await corrections()).toBe(n0 + 1);
    const s1 = await snapshot(bhr);
    const delta = usedPrice - newPrice;
    expect(s1.list.get(id)).toMatchObject({ rateKind: 'USED', sellingPrice: usedPrice });
    for (const [rid, row] of s1.list) if (rid !== id) expect(row.sellingPrice, row.code).toBe(s0.list.get(rid)!.sellingPrice);
    expect([s1.listTotal - s0.listTotal, s1.valuation - s0.valuation, s1.retail - s0.retail]).toEqual([delta, delta, delta]);
    expect([s1.stockWeightMg, s1.ledger.items, s1.ledger.weightMg]).toEqual([s0.stockWeightMg, s0.ledger.items, s0.ledger.weightMg]);
    expect(ascending(s1.sorted)).toBe(true);
    expect((await gmHttp.get(`/api/inventory/items/${id}`)).body.item).toMatchObject({ rateKind: 'USED', sellingPrice: usedPrice, pricePerGram: await rate(k, 'USED'), totalCost: null });
    const cashier = withIdempotencyKeys(request.agent(app));
    const login = await cashier.post('/api/auth/login').send({ username: 'cashier.bhr.01', password: DEMO_PASSWORDS.CASHIER });
    cashier.set('x-csrf-token', login.body.csrfToken);
    const code = s1.list.get(id)!.code;
    expect(((await cashier.get('/api/inventory/items').query({ q: code })).body.rows as Row[]).find((x) => x.code === code)?.sellingPrice).toBe(usedPrice);
    expect((await piece(id)).acquisitionCost).toBeNull();
  });

  it('the karat: the price follows the new karat, the stock-weight report moves the weight from one karat to the other', async () => {
    expect(k2).not.toBe(k);
    const id = pieces.karat;
    const sw0 = (await stockWeight(ctx.db, bhr)).byBranch.get(bhr)!;
    const r = await correct(id, { action: 'CORRECT', karat: k2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sellingPriceAfter).toBe(computedPrice(10_000, await rate(k2, 'NEW'), await step()));
    const sw1 = (await stockWeight(ctx.db, bhr)).byBranch.get(bhr)!;
    expect(sw1.items.weightMg).toBe(sw0.items.weightMg);
    const at = (s: typeof sw0, karat: number) => s.items.byKarat.find((x: { karat: number }) => x.karat === karat)?.weightMg ?? 0;
    expect([at(sw1, k) - at(sw0, k), at(sw1, k2) - at(sw0, k2)]).toEqual([-10_000, 10_000]);
  });

  it('the net weight: ADJUSTMENT −1 at the old weight and +1 at the new, both at an unknown cost; the price and the stock weight follow', async () => {
    const id = pieces.weight;
    const s0 = await snapshot(bhr);
    const p = (await preview(id, { action: 'CORRECT', netWeightMg: 9_250, grossWeightMg: 9_700 })).body;
    const r = await correct(id, { action: 'CORRECT', netWeightMg: 9_250, grossWeightMg: 9_700 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s1 = await snapshot(bhr);
    expect(s1.stockWeightMg - s0.stockWeightMg).toBe(-750);
    expect([s1.ledger.items - s0.ledger.items, s1.ledger.weightMg - s0.ledger.weightMg]).toEqual([0, -750]);
    expect(s1.valuation - s0.valuation).toBe(p.valuationChange);
    const moves = await ctx.db.select().from(t.inventoryMovements).where(and(eq(t.inventoryMovements.itemId, id), eq(t.inventoryMovements.refType, 'opening_correction'))).orderBy(asc(t.inventoryMovements.id));
    expect(moves.map((m) => [m.type, m.direction, m.netWeightMg, m.costValue])).toEqual([['ADJUSTMENT', -1, 10_000, null], ['ADJUSTMENT', 1, 9_250, null]]);
    expect(await piece(id)).toMatchObject({ netWeightMg: 9_250, grossWeightMg: 9_700, acquisitionCost: null });
  });

  it('a void: VOIDED, ADJUSTMENT −1, out of every list and total; a sale of it is refused', async () => {
    const id = pieces.void;
    const s0 = await snapshot(bhr);
    const p = (await preview(id, { action: 'VOID' })).body;
    expect(p).toMatchObject({ after: null, stockCountChange: -1, stockWeightChangeMg: -10_000 });
    const r = await correct(id, { action: 'VOID', reason: 'Entered twice' });
    expect([r.status, r.body.kind]).toEqual([200, 'VOID']);
    const s1 = await snapshot(bhr);
    expect(s1.list.has(id)).toBe(false);
    expect([s1.available - s0.available, s1.stockWeightMg - s0.stockWeightMg, s1.ledger.items - s0.ledger.items, s1.valuation - s0.valuation]).toEqual([-1, -10_000, -1, p.valuationChange]);
    expect((await piece(id)).status).toBe('VOIDED');
    expect((await err(createSale(ctx, cashierBhr, { items: [{ itemId: id, listPrice: 1 }], paymentMethod: 'CASH' })))?.status).toBe(400);
    expect((await correct(id, { action: 'VOID' })).body.error.code).toBe('OPENING_PIECE_NOT_AVAILABLE');
  });

  it('a piece now in another branch: corrected; the record and the audit name both branches', async () => {
    const id = pieces.moved;
    const r = await correct(id, { action: 'CORRECT', condition: 'USED' });
    expect([r.status, r.body.branchId]).toEqual([200, krt]);
    const [row] = await ctx.db.select().from(t.openingPieceCorrections).where(eq(t.openingPieceCorrections.itemId, id));
    expect([row.branchId, row.openingId]).toEqual([krt, opening]);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_PIECE_CORRECTED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.metadata).toMatchObject({ branchId: krt, openingBranchId: bhr, correctionId: row.id, kind: 'CORRECT', before: { condition: 'NEW' }, after: { condition: 'USED' } });
    expect(JSON.stringify(audit)).not.toContain(PW);
    // The piece page lists its corrections.
    const detail = (await gmHttp.get(`/api/inventory/items/${id}`)).body;
    expect(detail.openingId).toBe(opening);
    expect(detail.openingCorrections.map((c: { kind: string; branchId: number }) => [c.kind, c.branchId])).toEqual([['CORRECT', krt]]);
  });

  it('the same Idempotency-Key replays the answer; the correction happens once', async () => {
    const key = randomUUID();
    const send = () => gmHttp.post(`/api/openings/${opening}/pieces/${pieces.replay}/correction`).set('Idempotency-Key', key).send({ action: 'CORRECT', condition: 'USED', reason: 'replay check', confirmPassword: PW });
    const first = await send();
    const again = await send();
    expect(first.status).toBe(200);
    expect([again.status, again.headers['idempotent-replayed']]).toEqual([200, 'true']);
    expect(again.body).toEqual(first.body);
    expect((await ctx.db.select().from(t.openingPieceCorrections).where(eq(t.openingPieceCorrections.itemId, pieces.replay))).length).toBe(1);
  });
});

describe('property: any sequence of corrections', () => {
  it('leaves the piece equal to the last "after", the ledger weight equal to the pieces, the cost unknown', async () => {
    const id = pieces.property;
    const { inventory } = await ctx.settings.get();
    const rates = await currentSellingRates(ctx.db);
    const karats = inventory.allowedKarats.filter((x) => rates.has(rateKey(x, 'NEW')) && rates.has(rateKey(x, 'USED')));
    await fc.assert(
      fc.asyncProperty(
        fc.record({ condition: fc.constantFrom<GoldRateKind>('NEW', 'USED'), karat: fc.constantFrom(...karats), net: fc.integer({ min: 1, max: 50_000 }), extra: fc.integer({ min: 0, max: 5_000 }) }),
        async (v) => {
          const cur = await piece(id);
          const r = await correctOpeningPiece(ctx, gm, opening, id, { action: 'CORRECT', condition: v.condition, karat: v.karat, netWeightMg: v.net, grossWeightMg: v.net + v.extra, reason: 'property test', confirmPassword: PW }).then(
            (x) => x,
            (e: Err) => e,
          );
          const unchanged = cur.rateKind === v.condition && cur.karat === v.karat && cur.netWeightMg === v.net && cur.grossWeightMg === v.net + v.extra;
          if (unchanged) {
            expect((r as Err)?.code).toBe('OPENING_CORRECTION_UNCHANGED');
            return;
          }
          const after = await piece(id);
          const [last] = await ctx.db.select().from(t.openingPieceCorrections).where(eq(t.openingPieceCorrections.itemId, id)).orderBy(desc(t.openingPieceCorrections.id)).limit(1);
          expect([after.rateKind, after.karat, after.netWeightMg, after.grossWeightMg, after.acquisitionCost]).toEqual([last.conditionAfter, last.karatAfter, last.netWeightMgAfter, last.grossWeightMgAfter, null]);
          const ledger = (await ctx.db.select({ w: sql<number>`coalesce(sum(${t.inventoryMovements.direction} * ${t.inventoryMovements.netWeightMg}), 0)`, n: sql<number>`coalesce(sum(${t.inventoryMovements.direction}), 0)` }).from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, id)))[0];
          expect([Number(ledger.n), Number(ledger.w)]).toEqual([1, after.netWeightMg]);
        },
      ),
      { numRuns: 25 },
    );
  }, 300_000);
});
