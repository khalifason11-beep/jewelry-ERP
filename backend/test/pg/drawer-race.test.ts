// Real PostgreSQL only (CSH-2 piece C, D-csh-8): the drawer never goes below zero, however requests interleave. The
// BLOCK check reads the drawer under its row lock (lockAccounts), so outflows racing on one drawer are checked one after
// the other: of several payments that each fit the drawer but not together, only as many as fit go through.
// (MKC-1: scrap cash parts racing repayments from the drawer; supplier making charges no longer touch the drawer.)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { valueOfWeight } from '@jerp/shared';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { balances } from '../../src/modules/ledger/service';
import { createBranch } from '../../src/modules/branches/service';
import { buyScrap, scrapRates } from '../../src/modules/scrap/service';
import { recordAdvance, recordRepayment } from '../../src/modules/funding/service';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

const ROUNDS = 8;
let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let branchId: number;

const drawer = async () => (await balances(ctx.db, branchId)).find((b) => b.kind === 'CASH')!.balance;
const fulfilled = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === 'fulfilled').length;
const reasons = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.code ?? r.reason?.message ?? r.reason));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  gm = (await loadActor(ctx.db, u.id, null))!;
  branchId = (await createBranch(ctx, gm, { code: 'RCE', name: 'Race branch', nameAr: 'فرع السباق', city: 'Test' })).id;
});
afterAll(async () => handle?.close());

describe('the drawer never goes below zero', () => {
  // MKC-1: a supplier making charge no longer leaves the drawer, so the second outflow kind in the race is a repayment to
  // the General Manager from the drawer (it locks OWED_TO_GM and CASH, the scrap purchase CASH alone: overlapping locks).
  it('two scrap purchases and two repayments of 600,000 racing on a drawer of 1,000,000: exactly one goes through', async () => {
    // Enough owed that only the drawer can refuse a repayment (test values).
    await recordAdvance(ctx, gm, { branchId, account: 'BANK', amount: 50_000_000, reason: 'Race: owed headroom', bankReference: 'RACE-OWED-1' });
    const rate = (await scrapRates(ctx.db))[21].pricePerGram;
    const mg = 10_000;
    const amount = valueOfWeight(mg, rate);
    expect(amount).toBeGreaterThan(600_000);
    for (let round = 0; round < ROUNDS; round++) {
      // Bring the drawer to exactly 1,000,000 (test values).
      const top = 1_000_000 - (await drawer());
      if (top > 0) await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: top, reason: `Race float ${round}` });
      expect(await drawer()).toBe(1_000_000);
      const scrap = (i: number) =>
        buyScrap(ctx, gm, { branchId, kind: 'BROKEN', karat: 21, grossWeightMg: mg, netWeightMg: mg, cashAmount: 600_000, bankAmount: amount - 600_000, bankReference: `RACE-${round}-${i}` });
      const repay = (i: number) => recordRepayment(ctx, gm, { branchId, account: 'CASH', amount: 600_000, reason: `Race repayment ${round}-${i}` });
      const rs = await Promise.allSettled([scrap(1), repay(1), scrap(2), repay(2)]);
      expect(fulfilled(rs), `round ${round}: ${reasons(rs).join(' | ')}`).toBe(1);
      expect(reasons(rs).every((r) => r === 'DRAWER_SHORT'), reasons(rs).join(' | ')).toBe(true);
      expect(await drawer()).toBe(400_000);
    }
  });
});
