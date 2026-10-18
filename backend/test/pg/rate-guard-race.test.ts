// Real PostgreSQL only (DEC-1, RAT-1, D-dec1-13): two rate edits at once cannot both pass against a stale previous value.
//   From 100,000 (test value), A sets +9 % (109,000) and B sets −9 % (91,000): each is allowed against 100,000, but
//   whichever runs second moves the rate by more than 10 % from the first one's result and needs a reason. The guard
//   compares inside the transaction, after the lock that serialises rate edits, so exactly one edit passes and the
//   other answers 422; the history holds one new row. Gold selling rates and scrap buying rates, several rounds.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { setSellingRates } from '../../src/modules/pricing/service';
import { setScrapRates } from '../../src/modules/scrap/service';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
const BASE = 100_000;
const statusOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 200 : (r.reason as { status?: number }).status);

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  gm = (await loadActor(ctx.db, u.id, null))!;
});
afterAll(async () => handle?.close());

// Back to the base rate: inserted directly, as the test's own set-up (no guard involved).
const resetGold = () => ctx.db.insert(t.goldRates).values({ karat: 21, kind: 'NEW', pricePerGram: BASE, setBy: gm.userId });
const resetScrap = () => ctx.db.insert(t.scrapRates).values({ karat: 21, pricePerGram: BASE, setBy: gm.userId });

describe('a rate edit racing another rate edit', () => {
  it('gold selling rate: of +9 % and −9 % at once, exactly one passes, the other needs a reason (422)', async () => {
    for (let round = 0; round < 5; round++) {
      await resetGold();
      const rs = await Promise.allSettled([setSellingRates(ctx, gm, { NEW: { 21: 109_000 } }), setSellingRates(ctx, gm, { NEW: { 21: 91_000 } })]);
      const codes = rs.map(statusOf).sort();
      expect(codes, `round ${round}`).toEqual([200, 422]);
      const [latest] = await ctx.db.select().from(t.goldRates).where(and(eq(t.goldRates.karat, 21), eq(t.goldRates.kind, 'NEW'))).orderBy(desc(t.goldRates.effectiveAt), desc(t.goldRates.id)).limit(1);
      const winner = rs.findIndex((r) => r.status === 'fulfilled');
      expect(latest.pricePerGram).toBe(winner === 0 ? 109_000 : 91_000);
    }
  }, 60_000);

  it('scrap buying rate: the same', async () => {
    for (let round = 0; round < 5; round++) {
      await resetScrap();
      const rs = await Promise.allSettled([setScrapRates(ctx, gm, { 21: 109_000 }), setScrapRates(ctx, gm, { 21: 91_000 })]);
      expect(rs.map(statusOf).sort(), `round ${round}`).toEqual([200, 422]);
    }
  }, 60_000);
});
