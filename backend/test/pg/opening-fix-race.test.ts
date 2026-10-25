// Real PostgreSQL only (OPN-FIX, D-opnfix-1…5): a correction of a sealed opening's piece racing a sale of that piece, a
// void racing a sale, and two corrections of the same piece at once.
//   The correction takes the pricing lock (shared) and then the piece row FOR UPDATE, in the order a sale takes them,
//   and reads the piece's status and values under those locks. So exactly one order of events happens:
//   * correction vs sale: the sale first (the piece is SOLD at the old price; the correction answers 409
//     OPENING_PIECE_NOT_AVAILABLE and writes nothing), or the correction first (the sale, priced as the cashier saw it,
//     answers 409 PRICES_CHANGED; the piece is AVAILABLE with its new condition);
//   * void vs sale: the sale first (the void is refused), or the void first (the sale is refused); never both;
//   * two corrections: they run one after the other; the second one's "before" is the first one's "after", the piece
//     equals the last "after" and its ledger weight equals its net weight.
// Several rounds, both orders (the correction checks the password, a slow hash, before its transaction: on odd rounds
// the sale starts later).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createCategory } from '../../src/modules/catalog/service';
import { createSale } from '../../src/modules/sales/service';
import { addOpeningLine, createOpening, sealOpening } from '../../src/modules/openings/service';
import { correctOpeningPiece } from '../../src/modules/openings/corrections';
import { currentSellingRates, rateKey } from '../../src/modules/pricing/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let gmSession: string;
let cashier: Actor;
let opening: number;
let pieces: number[] = [];
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const ROUNDS = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));
const piece = async (id: number) => (await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, id)))[0];
const rowsOf = async (id: number) => ctx.db.select().from(t.openingPieceCorrections).where(eq(t.openingPieceCorrections.itemId, id)).orderBy(asc(t.openingPieceCorrections.id));
/** The price the POS shows first (PRC-1: a sale without it is refused with the current prices). */
async function shownPrice(itemId: number) {
  const e = await createSale(ctx, cashier, { items: [{ itemId }], paymentMethod: 'CASH' }).then(() => null, (x: { details?: { lines: { listPrice: number }[] } }) => x);
  return e!.details!.lines[0].listPrice;
}
const fresh = () => ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date(), { pricingMode: 'RATE_COMPUTED' });
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  expect((await request(app).post('/api/auth/login').send({ username: 'general.manager', password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gmSession = s.id;
  gm = (await loadActor(ctx.db, u.id, s.id))!;
  const [c] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'cashier.bhr.01'));
  cashier = (await loadActor(ctx.db, c.id, null))!;
  await ctx.db.insert(t.webauthnCredentials).values({ userId: gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  await fresh();
  const bhr = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'BHR')))[0].id;
  const { inventory } = await ctx.settings.get();
  const rates = await currentSellingRates(ctx.db);
  const k = inventory.allowedKarats.find((x) => rates.has(rateKey(x, 'NEW')) && rates.has(rateKey(x, 'USED')))!;
  const type = await createCategory(ctx, gm, { nameAr: '[اختبار] قطعة سباق', name: '[Test] Race piece' });
  opening = (await createOpening(ctx, gm, { branchId: bhr })).id;
  for (let i = 0; i < ROUNDS * 3; i++) await addOpeningLine(ctx, gm, opening, { categoryId: type.id, description: `race ${i}`, karat: k, condition: 'NEW', grossWeightMg: 8_500, netWeightMg: 8_000 });
  await sealOpening(ctx, gm, opening, { confirmPassword: PW });
  pieces = (await ctx.db.select({ id: t.openingLines.itemId }).from(t.openingLines).where(eq(t.openingLines.openingId, opening)).orderBy(asc(t.openingLines.lineNo))).map((r) => r.id!);
});
afterAll(async () => handle?.close());

describe('a correction of a sealed opening piece, racing', () => {
  it('a sale of the piece: exactly one order of events, and the piece and the sale agree with it', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      await fresh();
      const id = pieces[round];
      const listPrice = await shownPrice(id);
      const fix = correctOpeningPiece(ctx, gm, opening, id, { action: 'CORRECT', condition: 'USED', reason: 'race test', confirmPassword: PW });
      if (round % 2) await sleep(5 + round * 15);
      const [f, s] = await Promise.allSettled([fix, createSale(ctx, cashier, { items: [{ itemId: id, listPrice }], paymentMethod: 'CASH' })]);
      const outcome = `${codeOf(f)}/${codeOf(s)}`;
      seen.add(outcome);
      const p = await piece(id);
      const rows = await rowsOf(id);
      if (codeOf(s) === 'OK') {
        // The sale first: sold at the price the cashier saw; the correction refused and wrote nothing.
        expect(outcome, `round ${round}`).toBe('OPENING_PIECE_NOT_AVAILABLE/OK');
        expect([p.status, p.rateKind, rows.length]).toEqual(['SOLD', 'NEW', 0]);
        const [line] = await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, id));
        expect(line.listPrice).toBe(listPrice);
      } else {
        // The correction first: the sale refused (the price moved); the piece AVAILABLE and used.
        expect(outcome, `round ${round}`).toBe('OK/PRICES_CHANGED');
        expect([p.status, p.rateKind, rows.length]).toEqual(['AVAILABLE', 'USED', 1]);
        expect((await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, id))).length).toBe(0);
      }
    }
    // Both orders should appear across the rounds; if the machine only ever produced one, say so (not a failure).
    if (seen.size < 2) console.warn(`opening-fix race: only one order of events was seen in ${ROUNDS} rounds: ${[...seen].join(', ')}`);
  }, 300_000);

  it('a void racing a sale: never both', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await fresh();
      const id = pieces[ROUNDS + round];
      const listPrice = await shownPrice(id);
      const voiding = correctOpeningPiece(ctx, gm, opening, id, { action: 'VOID', reason: 'race test', confirmPassword: PW });
      if (round % 2) await sleep(5 + round * 15);
      const [v, s] = await Promise.allSettled([voiding, createSale(ctx, cashier, { items: [{ itemId: id, listPrice }], paymentMethod: 'CASH' })]);
      const p = await piece(id);
      expect([codeOf(v), codeOf(s)].filter((c) => c === 'OK').length, `round ${round}: ${codeOf(v)}/${codeOf(s)}`).toBe(1);
      expect(p.status).toBe(codeOf(v) === 'OK' ? 'VOIDED' : 'SOLD');
      const moves = Number((await ctx.db.select({ n: sql<number>`coalesce(sum(${t.inventoryMovements.direction}), 0)` }).from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, id)))[0].n);
      expect(moves, 'the piece left the stock exactly once').toBe(0);
    }
  }, 300_000);

  it('two corrections of the same piece at once: one after the other, chained, the ledger agrees', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await fresh();
      const id = pieces[2 * ROUNDS + round];
      const [a, b] = await Promise.allSettled([
        correctOpeningPiece(ctx, gm, opening, id, { action: 'CORRECT', condition: 'USED', reason: 'race test A', confirmPassword: PW }),
        correctOpeningPiece(ctx, gm, opening, id, { action: 'CORRECT', netWeightMg: 7_500, grossWeightMg: 8_000, reason: 'race test B', confirmPassword: PW }),
      ]);
      expect([codeOf(a), codeOf(b)], `round ${round}`).toEqual(['OK', 'OK']);
      const rows = await rowsOf(id);
      expect(rows.length).toBe(2);
      const [first, second] = rows;
      expect([second.conditionBefore, second.karatBefore, second.netWeightMgBefore, second.grossWeightMgBefore]).toEqual([first.conditionAfter, first.karatAfter, first.netWeightMgAfter, first.grossWeightMgAfter]);
      const p = await piece(id);
      expect([p.rateKind, p.netWeightMg, p.grossWeightMg, p.acquisitionCost]).toEqual(['USED', 7_500, 8_000, null]);
      const ledger = (await ctx.db.select({ w: sql<number>`coalesce(sum(${t.inventoryMovements.direction} * ${t.inventoryMovements.netWeightMg}), 0)`, n: sql<number>`coalesce(sum(${t.inventoryMovements.direction}), 0)` }).from(t.inventoryMovements).where(eq(t.inventoryMovements.itemId, id)))[0];
      expect([Number(ledger.n), Number(ledger.w)]).toEqual([1, 7_500]);
    }
  }, 300_000);
});
