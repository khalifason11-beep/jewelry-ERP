// MIS-1 (SCR-VOID, plan docs/plans/MIS-1.md §3): the General Manager voids a counter scrap purchase made by mistake.
// Both projects (the race between a sale and a void is in test/pg/scrap-void-race.test.ts).
//   * who: the General Manager only (scrap.void); the reason (3–200 after trimming, else 422) and the password (missing
//     → 403 CONFIRM_PASSWORD_REQUIRED; wrong → 403 REAUTH_FAILED, counted and audited);
//   * the money: every entry reversed (both parts of a split), dated now; the reconciliation's lines still add up to the
//     account movement on the purchase's day, the void's day and the day after;
//   * a sellable piece: only while AVAILABLE in the branch that bought it (sold, in transit → 409 naming the code and the
//     status); it becomes VOIDED with an ADJUSTMENT −1 at its cost, and stock count, weight and value reconcile; a piece
//     in a cart (carts live in the browser) is refused at the sale's confirmation afterwards;
//   * broken scrap: the pool must hold the weight (exactly enough passes, 1 mg short → 409 with the balance);
//   * a second void → 409; a replay of the same Idempotency-Key returns the first answer and voids once;
//   * the reads: the list's status filter, totals without the voided ones and how many were left out; the detail.
//   * both new tables refuse UPDATE and DELETE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { valueOfWeight } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { dayKey } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { balances, reconciliation } from '../src/modules/ledger/service';
import { ledgerStock } from '../src/modules/inventory/ledger';
import { buyScrap, getScrapPurchase, listScrapPurchases, poolBalances, scrapRates } from '../src/modules/scrap/service';
import { voidScrapPurchase } from '../src/modules/scrap/void';
import { createSale } from '../src/modules/sales/service';
import { createTransfer } from '../src/modules/transfers/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gmHttp: ReturnType<typeof request.agent>;
let gm: Actor; // with the session of gmHttp (the password check needs one)
let bm: Actor;
let cashier: Actor;
let krt: number;
let omd: number;
let productId: number;
let fixedTag = true;

const actorOf = async (username: string, sessionId: string | null = null): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, sessionId))!;
};
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const ok = { reason: 'Recorded by mistake', confirmPassword: PW };
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; params?: Record<string, unknown> }) => e);
const bal = async (branchId: number, kind: string) => (await balances(ctx.db, branchId)).find((b) => b.kind === kind)?.balance ?? 0;
const pool = async (branchId: number, karat: number) => (await poolBalances(ctx.db, branchId, karat))[0]?.weightMg ?? 0;
const broken = (mg: number, karat = 21, branchId = krt) => buyScrap(ctx, branchId === krt ? bm : gm, { branchId, kind: 'BROKEN', karat, grossWeightMg: mg, netWeightMg: mg, paymentMethod: 'CASH' });
const sellable = (mg = 3_000, branchId = krt) =>
  buyScrap(ctx, bm, { branchId, kind: 'SELLABLE', karat: 21, grossWeightMg: mg, netWeightMg: mg, productId, paymentMethod: 'CASH', ...(fixedTag ? { sellingPrice: 900_000 } : {}) });
const voidHttp = (id: number, body: object) => gmHttp.post(`/api/scrap-purchases/${id}/void`).send(body);
const recLinesAddUp = (r: Awaited<ReturnType<typeof reconciliation>>) => {
  expect(r.cashLines.reduce((s, l) => s + l.amount, 0)).toBe(r.cashMovement);
  expect(r.bankLines.reduce((s, l) => s + l.amount, 0)).toBe(r.bankMovement);
};

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gmHttp = withIdempotencyKeys(request.agent(app));
  const res = await gmHttp.post('/api/auth/login').send({ username: 'general.manager', password: PW });
  gmHttp.set('x-csrf-token', res.body.csrfToken);
  expect((await gmHttp.post('/api/auth/reauth').send({ password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gm = await actorOf('general.manager', s.id);
  bm = await actorOf('branch.manager.kh');
  cashier = await actorOf('cashier.kh.01');
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  omd = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'OMD')))[0].id;
  productId = (await ctx.db.select().from(t.products).where(and(eq(t.products.karat, 21), eq(t.products.isActive, true))).limit(1))[0].id;
  fixedTag = (await ctx.settings.get()).pricing.mode === 'FIXED_TAG';
});
afterAll(async () => handle?.close());

describe('who, the reason and the password', () => {
  it('the branch manager and the cashier are refused (403), even with a reason and the password', async () => {
    const p = await broken(1_000);
    for (const [user, role] of [['branch.manager.kh', 'BRANCH_MANAGER'], ['cashier.kh.01', 'CASHIER']] as const) {
      const agent = withIdempotencyKeys(request.agent(app));
      const r = await agent.post('/api/auth/login').send({ username: user, password: DEMO_PASSWORDS[role] });
      agent.set('x-csrf-token', r.body.csrfToken);
      await agent.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS[role] });
      const res = await agent.post(`/api/scrap-purchases/${p.id}/void`).send({ reason: 'not mine to void', confirmPassword: DEMO_PASSWORDS[role] });
      expect(res.status, role).toBe(403);
      expect(res.body.error.key).toMatch(/^(Missing permission|Requires one of)/);
    }
    expect((await err(voidScrapPurchase(ctx, bm, p.id, ok)))?.status).toBe(403);
    expect(await ctx.db.select().from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, p.id))).toEqual([]);
  });

  it('the reason: missing, 2 or 201 characters (after trimming) → 422; 3 and 200 pass', async () => {
    const p = await broken(1_000);
    for (const reason of [undefined, '', '  ab  ', 'x'.repeat(201), ` ${'y'.repeat(201)} `]) {
      const res = await voidHttp(p.id, { reason, confirmPassword: PW });
      expect(res.status, JSON.stringify(reason)).toBe(422);
      expect(res.body.error.code).toBe('CORRECTION_REASON_REQUIRED');
    }
    expect((await voidHttp(p.id, { reason: '  abc  ', confirmPassword: PW })).status).toBe(200);
    const [v] = await ctx.db.select().from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, p.id));
    expect(v.reason).toBe('abc');
    const q = await broken(1_000);
    const long = 'z'.repeat(200);
    expect((await voidHttp(q.id, { reason: ` ${long} `, confirmPassword: PW })).status).toBe(200);
    expect((await ctx.db.select().from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, q.id)))[0].reason).toBe(long);
  });

  it('the password: missing → 403 CONFIRM_PASSWORD_REQUIRED; wrong → 403 REAUTH_FAILED, counted and audited; nothing voided', async () => {
    const p = await broken(1_000);
    const missing = await voidHttp(p.id, { reason: 'Recorded by mistake' });
    expect([missing.status, missing.body.error.code]).toEqual([403, 'CONFIRM_PASSWORD_REQUIRED']);
    const [before] = await ctx.db.select().from(t.users).where(eq(t.users.id, gm.userId));
    const wrong = await voidHttp(p.id, { reason: 'Recorded by mistake', confirmPassword: 'not-the-password' });
    expect([wrong.status, wrong.body.error.code]).toEqual([403, 'REAUTH_FAILED']);
    const [after] = await ctx.db.select().from(t.users).where(eq(t.users.id, gm.userId));
    expect(after.failedLoginCount).toBe(before.failedLoginCount + 1);
    const audited = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.userId, gm.userId), eq(t.auditLogs.action, 'REAUTH_FAILED')));
    expect(audited.length).toBeGreaterThan(0);
    expect(await ctx.db.select().from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, p.id))).toEqual([]);
    // The right password clears the count.
    expect((await voidHttp(p.id, ok)).status).toBe(200);
    expect((await ctx.db.select().from(t.users).where(eq(t.users.id, gm.userId)))[0].failedLoginCount).toBe(0);
  });
});

describe('a void happens once', () => {
  it('the same Idempotency-Key replays the first answer and voids once; a new key → 409 SCRAP_ALREADY_VOIDED', async () => {
    const p = await broken(1_500);
    const cash0 = await bal(krt, 'CASH');
    const key = randomUUID();
    const send = () => gmHttp.post(`/api/scrap-purchases/${p.id}/void`).set('Idempotency-Key', key).send(ok);
    const first = await send();
    const replay = await send();
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await ctx.db.select().from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, p.id))).toHaveLength(1);
    expect(await bal(krt, 'CASH')).toBe(cash0 + p.amount);
    const again = await voidHttp(p.id, ok);
    expect([again.status, again.body.error.code]).toEqual([409, 'SCRAP_ALREADY_VOIDED']);
    expect(await bal(krt, 'CASH')).toBe(cash0 + p.amount);
    expect((await voidHttp(999_999, ok)).status).toBe(404);
  });
});

describe('a sellable piece', () => {
  it('available in its branch: VOIDED, an ADJUSTMENT −1 at its cost; stock count, weight and value reconcile; the audit has the reason, not the password', async () => {
    const p = await sellable(3_100);
    const stock0 = await ledgerStock(ctx.db, krt, new Date(Date.now() + 60_000));
    const r = await voidScrapPurchase(ctx, gm, p.id, ok);
    expect(r).toMatchObject({ status: 'VOIDED', itemCode: p.itemCode });
    const [item] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, p.itemId!));
    expect(item.status).toBe('VOIDED');
    const moves = await ctx.db.select().from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, item.id)).orderBy(t.inventoryMovements.id);
    expect(moves.map((m) => [m.type, m.direction, m.costValue, m.netWeightMg])).toEqual([
      ['PURCHASE', 1, p.amount, 3_100],
      ['ADJUSTMENT', -1, p.amount, 3_100],
    ]);
    const stock1 = await ledgerStock(ctx.db, krt, new Date(Date.now() + 60_000));
    expect(stock1).toEqual({ items: stock0.items - 1, weightMg: stock0.weightMg - 3_100, cost: stock0.cost - p.amount, unknownCostPieces: stock0.unknownCostPieces });
    // The ledger's stock equals the AVAILABLE pieces (A15): count, weight and value at cost.
    const [avail] = await ctx.db
      .select({ n: sql<number>`count(*)`.mapWith(Number), w: sql<number>`coalesce(sum(net_weight_mg), 0)`.mapWith(Number), c: sql<number>`coalesce(sum(acquisition_cost), 0)`.mapWith(Number) })
      .from(t.jewelryItems)
      .where(and(eq(t.jewelryItems.branchId, krt), eq(t.jewelryItems.status, 'AVAILABLE')));
    expect([avail.n, avail.w, avail.c]).toEqual([stock1.items, stock1.weightMg, stock1.cost]);
    const history = await ctx.db.select().from(t.itemStatusHistory).where(eq(t.itemStatusHistory.itemId, item.id)).orderBy(t.itemStatusHistory.id);
    expect(history.at(-1)).toMatchObject({ fromStatus: 'AVAILABLE', toStatus: 'VOIDED', refType: 'scrap_purchase', refId: p.id });
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'SCRAP_PURCHASE_VOIDED'), eq(t.auditLogs.entityId, p.number)));
    expect(audit.userId).toBe(gm.userId);
    expect(audit.metadata).toMatchObject({ reason: 'Recorded by mistake', purchaseId: p.id, itemCode: p.itemCode, before: { status: 'VALID', itemStatus: 'AVAILABLE' }, after: { status: 'VOIDED', itemStatus: 'VOIDED' } });
    expect(JSON.stringify(audit)).not.toContain(PW);
    // A VOIDED piece is never sold.
    expect((await err(createSale(ctx, cashier, { items: [{ itemId: item.id }], paymentMethod: 'CASH' })))?.status).toBe(400);
  });

  it('after it was sold → 409 naming the code and SOLD; nothing changes', async () => {
    const p = await sellable();
    await createSale(ctx, cashier, { items: [{ itemId: p.itemId! }], paymentMethod: 'CASH' });
    const cash0 = await bal(krt, 'CASH');
    const e = await err(voidScrapPurchase(ctx, gm, p.id, ok));
    expect([e?.status, e?.code]).toEqual([409, 'SCRAP_PIECE_NOT_AVAILABLE']);
    expect(e?.params).toMatchObject({ code: p.itemCode, status: 'SOLD' });
    expect(await bal(krt, 'CASH')).toBe(cash0);
    expect(await ctx.db.select().from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, p.id))).toEqual([]);
  });

  it('in transit to another branch → 409 naming the code and TRANSFERRED', async () => {
    const p = await sellable();
    await createTransfer(ctx, gm, { fromBranchId: krt, toBranchId: omd, itemIds: [p.itemId!], courierName: 'Test courier' });
    const e = await err(voidScrapPurchase(ctx, gm, p.id, ok));
    expect([e?.status, e?.code]).toEqual([409, 'SCRAP_PIECE_NOT_AVAILABLE']);
    expect(e?.params).toMatchObject({ code: p.itemCode, status: 'TRANSFERRED' });
  });

  it('in a cashier\'s cart (the cart lives in the browser): the void passes, the sale is refused at confirmation', async () => {
    const p = await sellable();
    const cart = [{ itemId: p.itemId! }]; // what the POS holds: nothing on the server
    await voidScrapPurchase(ctx, gm, p.id, ok);
    const e = await err(createSale(ctx, cashier, { items: cart, paymentMethod: 'CASH' }));
    expect(e?.status).toBe(400);
    expect(e?.params).toMatchObject({ code: p.itemCode, status: 'VOIDED' });
  });
});

describe('broken scrap', () => {
  it('the pool holds exactly the weight: voided, the pool back to 0; 1 mg short → 409 with the balance', async () => {
    const karat = 13; // no other entry in this pool: the test controls the balance
    expect(await pool(krt, karat)).toBe(0);
    await ctx.db.insert(t.scrapRates).values({ karat, pricePerGram: 90_000, setBy: gm.userId }); // test set-up
    const p = await broken(2_345, karat);
    expect(await pool(krt, karat)).toBe(2_345);
    await voidScrapPurchase(ctx, gm, p.id, ok);
    expect(await pool(krt, karat)).toBe(0);
    const reversal = await ctx.db.select().from(t.scrapWeightEntries).where(and(eq(t.scrapWeightEntries.refType, 'scrap_purchase'), eq(t.scrapWeightEntries.refId, p.id), eq(t.scrapWeightEntries.eventType, 'REVERSAL')));
    expect(reversal.map((x) => x.weightMg)).toEqual([-2_345]);

    const q = await broken(1_000, karat);
    // Test set-up: 1 mg of the pool leaves it (as a settlement would).
    await ctx.db.insert(t.scrapWeightEntries).values({ branchId: krt, karat, weightMg: -1, eventType: 'SUPPLIER_SETTLEMENT', refType: 'test', refId: 0 });
    const cash0 = await bal(krt, 'CASH');
    const e = await err(voidScrapPurchase(ctx, gm, q.id, ok));
    expect([e?.status, e?.code]).toEqual([409, 'SCRAP_POOL_SHORT']);
    expect(e?.params).toMatchObject({ karat, balanceMg: 999, weightMg: 1_000 });
    expect(await pool(krt, karat)).toBe(999);
    expect(await bal(krt, 'CASH')).toBe(cash0);
  });
});

describe('the money', () => {
  it('a split purchase: both parts reversed (one REVERSAL per entry), balances back; the reconciliation adds up', async () => {
    const amount = valueOfWeight(6_000, (await scrapRates(ctx.db))[21].pricePerGram);
    const cashAmount = Math.floor(amount / 4);
    const p = await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 6_000, netWeightMg: 6_000, cashAmount, bankAmount: amount - cashAmount, bankReference: 'MIS1 SPLIT 01' });
    const [cash0, bank0] = [await bal(krt, 'CASH'), await bal(krt, 'BANK')];
    const rec0 = await reconciliation(ctx, bm, { branchId: krt });
    await voidScrapPurchase(ctx, gm, p.id, ok);
    expect(await bal(krt, 'CASH')).toBe(cash0 + cashAmount);
    expect(await bal(krt, 'BANK')).toBe(bank0 + (amount - cashAmount));
    const entries = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'scrap_purchase'), eq(t.ledgerEntries.refId, p.id))).orderBy(t.ledgerEntries.id);
    const originals = entries.filter((e) => e.eventType === 'SCRAP_PURCHASE');
    const reversals = entries.filter((e) => e.eventType === 'REVERSAL');
    expect(originals).toHaveLength(2);
    expect(reversals.map((r) => [r.reversesEntryId, r.amount]).sort()).toEqual(originals.map((o) => [o.id, -o.amount]).sort());
    const rec1 = await reconciliation(ctx, bm, { branchId: krt });
    recLinesAddUp(rec1);
    const line = (rec: typeof rec0, kind: 'cashLines' | 'bankLines') => rec[kind].find((l) => l.line === 'SCRAP_PURCHASES')!.amount;
    expect(line(rec1, 'cashLines') - line(rec0, 'cashLines')).toBe(cashAmount);
    expect(line(rec1, 'bankLines') - line(rec0, 'bankLines')).toBe(amount - cashAmount);
    // The drill-down lists the reversals under the purchase (each account's rows still add up to its line).
    for (const [account, kind] of [['CASH', 'cashLines'], ['BANK', 'bankLines']] as const) {
      expect(rec1.scrapPurchases.filter((x) => x.account === account).reduce((s, x) => s + x.amount, 0)).toBe(line(rec1, kind));
    }
    expect(rec1.scrapPurchases.filter((x) => x.number === p.number).map((x) => x.amount).sort((a, z) => a - z)).toEqual(
      [-(amount - cashAmount), -cashAmount, cashAmount, amount - cashAmount].sort((a, z) => a - z),
    );
  });

  it('a purchase of an earlier day voided today: its day is unchanged, today shows the money back, the day after adds up', async () => {
    const { company } = await ctx.settings.get();
    const now = new Date();
    const earlier = new Date(now.getTime() - 3 * 86_400_000);
    const earlierDay = dayKey(earlier, company.timezone);
    const p = await buyScrap(ctx, gm, { branchId: omd, kind: 'BROKEN', karat: 21, grossWeightMg: 2_000, netWeightMg: 2_000, paymentMethod: 'CASH' }, { at: earlier });
    const dayOf0 = await reconciliation(ctx, gm, { branchId: omd, day: earlierDay });
    const today0 = await reconciliation(ctx, gm, { branchId: omd });
    await voidScrapPurchase(ctx, gm, p.id, ok, { at: now });
    const dayOf1 = await reconciliation(ctx, gm, { branchId: omd, day: earlierDay });
    const today1 = await reconciliation(ctx, gm, { branchId: omd });
    expect(dayOf1.cashLines).toEqual(dayOf0.cashLines); // the purchase stays on its own day
    recLinesAddUp(dayOf1);
    recLinesAddUp(today1);
    const scrapLine = (r: typeof today0) => r.cashLines.find((l) => l.line === 'SCRAP_PURCHASES')!.amount;
    expect(scrapLine(today1) - scrapLine(today0)).toBe(p.amount);
    expect(today1.expectedCash - today0.expectedCash).toBe(p.amount);
    const tomorrow = dayKey(new Date(now.getTime() + 86_400_000), company.timezone);
    const next = await reconciliation(ctx, gm, { branchId: omd, day: tomorrow });
    recLinesAddUp(next);
    expect(next.openingCash).toBe(today1.expectedCash);
  });
});

describe('the reads', () => {
  it('the list: VOIDED with who, when and why; the status filter; totals of the valid ones and how many were left out', async () => {
    const day = dayKey(new Date(), (await ctx.settings.get()).company.timezone);
    const a = await broken(1_111, 21, omd);
    const b = await broken(2_222, 21, omd);
    await voidScrapPurchase(ctx, gm, b.id, { reason: 'Wrong customer', confirmPassword: PW });
    const all = await listScrapPurchases(ctx, gm, { branchId: omd, from: day, to: day });
    const rowB = all.rows.find((x) => x.id === b.id)!;
    expect(rowB).toMatchObject({ status: 'VOIDED', voidReason: 'Wrong customer', voidedByName: expect.any(String) });
    expect(rowB.voidedAt).toBeTruthy();
    expect(all.rows.find((x) => x.id === a.id)).toMatchObject({ status: 'VALID', voidedAt: null, voidReason: null });
    const validRows = all.rows.filter((x) => x.status === 'VALID');
    expect(all.totals).toEqual({
      count: validRows.length,
      netWeightMg: validRows.reduce((s, x) => s + x.netWeightMg, 0),
      amount: validRows.reduce((s, x) => s + x.amount, 0),
      voidedExcluded: all.rows.length - validRows.length,
    });
    const voided = await listScrapPurchases(ctx, gm, { branchId: omd, from: day, to: day, status: 'VOIDED' });
    expect(voided.rows.every((x) => x.status === 'VOIDED')).toBe(true);
    expect(voided.totals).toMatchObject({ count: 0, amount: 0, voidedExcluded: voided.rows.length });
    const valid = await listScrapPurchases(ctx, gm, { branchId: omd, from: day, to: day, status: 'VALID' });
    expect(valid.rows.some((x) => x.id === b.id)).toBe(false);
    expect(valid.total + voided.total).toBe(all.total);
    // Over HTTP too (the filter is validated).
    expect((await gmHttp.get('/api/scrap-purchases').query({ status: 'VOIDED' })).status).toBe(200);
    expect((await gmHttp.get('/api/scrap-purchases').query({ status: 'GONE' })).status).toBe(400);
  });

  it('the detail: the void, the piece and the money entries with their reversals', async () => {
    const p = await sellable();
    await voidScrapPurchase(ctx, gm, p.id, ok);
    const d = await getScrapPurchase(ctx, gm, p.id);
    expect(d).toMatchObject({ status: 'VOIDED', voidReason: 'Recorded by mistake', itemCode: p.itemCode, itemStatus: 'VOIDED' });
    expect(d.money.map((m) => [m.eventType, m.amount])).toEqual([
      ['SCRAP_PURCHASE', -p.amount],
      ['REVERSAL', p.amount],
    ]);
    const res = await gmHttp.get(`/api/scrap-purchases/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VOIDED');
    expect((await gmHttp.get('/api/scrap-purchases/999999')).status).toBe(404);
  });
});

describe('append-only', () => {
  it('scrap_purchase_voids and purchase_corrections refuse UPDATE and DELETE', async () => {
    const refused = (q: string) => ctx.db.execute(sql.raw(q)).then(() => false, () => true);
    // A row in each table, so the row triggers have something to refuse (test set-up, written directly).
    const [line] = await ctx.db.select().from(t.purchaseItems).limit(1);
    await ctx.db.insert(t.purchaseCorrections).values({ purchaseId: line.purchaseId, purchaseItemId: line.id, field: 'MAKING_COST', valueBefore: String(line.makingCost), valueAfter: String(line.makingCost), reason: 'append-only probe', correctedBy: gm.userId });
    expect(await refused(`UPDATE scrap_purchase_voids SET reason = 'changed'`)).toBe(true);
    expect(await refused(`DELETE FROM scrap_purchase_voids`)).toBe(true);
    expect(await refused(`UPDATE purchase_corrections SET reason = 'changed'`)).toBe(true);
    expect(await refused(`DELETE FROM purchase_corrections`)).toBe(true);
    // A void naming no scrap purchase is refused by its trigger (there is no foreign key, D-mis1-3).
    expect(await refused(`INSERT INTO scrap_purchase_voids (purchase_id, reason, voided_by) VALUES (999999, 'no such purchase', ${gm.userId})`)).toBe(true);
  });
});
