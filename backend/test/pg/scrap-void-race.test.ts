// Real PostgreSQL only (MIS-1, SCR-VOID): a sale of a sellable scrap piece and the void of its purchase, at once.
//   Both lock the piece row (FOR UPDATE) before they check its status, so exactly one wins: either the piece is SOLD and
//   the void answers 409 SCRAP_PIECE_NOT_AVAILABLE, or it is VOIDED and the sale is refused. Never both, never neither.
//   Several rounds; the money and the piece agree with the winner each time. Also two voids of one broken-scrap purchase
//   at once: one passes, the other answers 409 SCRAP_ALREADY_VOIDED, and the money is reversed once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { buyScrap } from '../../src/modules/scrap/service';
import { voidScrapPurchase } from '../../src/modules/scrap/void';
import { createSale } from '../../src/modules/sales/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let bm: Actor;
let cashier: Actor;
let krt: number;
let productId: number;
let fixedTag = true;
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const ok = { reason: 'Race test', confirmPassword: PW };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));

const actor = async (username: string, sessionId: string | null = null) => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, sessionId))!;
};

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  // The password check needs a real session: sign in once over HTTP and act with that session.
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  expect((await request(app).post('/api/auth/login').send({ username: 'general.manager', password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gm = await actor('general.manager', s.id);
  bm = await actor('branch.manager.kh');
  cashier = await actor('cashier.kh.01');
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  productId = (await ctx.db.select().from(t.products).where(and(eq(t.products.karat, 21), eq(t.products.isActive, true))).limit(1))[0].id;
  fixedTag = (await ctx.settings.get()).pricing.mode === 'FIXED_TAG';
});
afterAll(async () => handle?.close());

describe('a sale and a void of the same piece at once', () => {
  it('exactly one wins, every round, and the piece and the money agree with it', async () => {
    const winners = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const p = await buyScrap(ctx, bm, { branchId: krt, kind: 'SELLABLE', karat: 21, grossWeightMg: 2_500, netWeightMg: 2_500, productId, paymentMethod: 'CASH', ...(fixedTag ? { sellingPrice: 800_000 } : {}) });
      const sale = () => createSale(ctx, cashier, { items: [{ itemId: p.itemId! }], paymentMethod: 'CASH' });
      const voiding = () => voidScrapPurchase(ctx, gm, p.id, ok);
      // The void checks the password before its transaction (a slow hash): on odd rounds the sale starts later, so both
      // orders reach the piece lock.
      const v0 = voiding();
      if (round % 2) await sleep(5 + round * 15);
      const [s, v] = await Promise.allSettled([sale(), v0]);
      const outcome = `${codeOf(s)}/${codeOf(v)}`;
      expect(['OK/SCRAP_PIECE_NOT_AVAILABLE', 'BAD_REQUEST/OK'], `round ${round}`).toContain(outcome);
      const [item] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, p.itemId!));
      const voids = await ctx.db.select().from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, p.id));
      const reversals = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'scrap_purchase'), eq(t.ledgerEntries.refId, p.id), eq(t.ledgerEntries.eventType, 'REVERSAL')));
      if (outcome.startsWith('OK/')) {
        expect([item.status, voids.length, reversals.length]).toEqual(['SOLD', 0, 0]);
        winners.add('sale');
      } else {
        expect([item.status, voids.length, reversals.length]).toEqual(['VOIDED', 1, 1]);
        expect(await ctx.db.select().from(t.saleItems).where(eq(t.saleItems.itemId, item.id))).toEqual([]);
        winners.add('void');
      }
    }
    expect(winners.size, 'both a sale and a void won at least once').toBe(2);
  }, 120_000);

  it('two voids of one purchase at once: one passes, the other 409 SCRAP_ALREADY_VOIDED; reversed once', async () => {
    for (let round = 0; round < 5; round++) {
      const p = await buyScrap(ctx, bm, { branchId: krt, kind: 'BROKEN', karat: 21, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'CASH' });
      const rs = await Promise.allSettled([voidScrapPurchase(ctx, gm, p.id, ok), voidScrapPurchase(ctx, gm, p.id, ok)]);
      expect(rs.map(codeOf).sort(), `round ${round}`).toEqual(['OK', 'SCRAP_ALREADY_VOIDED']);
      const reversals = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'scrap_purchase'), eq(t.ledgerEntries.refId, p.id), eq(t.ledgerEntries.eventType, 'REVERSAL')));
      expect(reversals).toHaveLength(1);
      const pool = await ctx.db.select().from(t.scrapWeightEntries).where(and(eq(t.scrapWeightEntries.refType, 'scrap_purchase'), eq(t.scrapWeightEntries.refId, p.id), eq(t.scrapWeightEntries.eventType, 'REVERSAL')));
      expect(pool).toHaveLength(1);
    }
  }, 60_000);
});
