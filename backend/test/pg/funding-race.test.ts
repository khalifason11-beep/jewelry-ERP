// Real PostgreSQL only (CSH-2, D-csh-4): the amount a branch owes the General Manager can never go below zero, however
// requests interleave. Every check on a balance runs under lockAccounts (rows locked in ascending account id).
//   * many parallel repayments: the total repaid never exceeds what was owed;
//   * a repayment racing the correction of an advance: never both when together they exceed what is owed;
//   * a repayment from the drawer racing an advance to the drawer and the bank (overlapping locks): no deadlock.
// The drawer's no-negative rule (piece C) adds its own races in this file's sibling once it exists.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { correctFunding, owedOf, recordAdvance, recordRepayment } from '../../src/modules/funding/service';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

const ROUNDS = 8;
let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;

const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const fulfilled = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === 'fulfilled').length;
const reasons = (rs: PromiseSettledResult<unknown>[]) =>
  rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.key ?? r.reason?.message ?? r.reason));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  gm = (await loadActor(ctx.db, u.id, null))!;
});
afterAll(async () => handle?.close());

describe('the amount owed to the General Manager never goes below zero', () => {
  it('ten parallel repayments of 30% each: at most three succeed; owed ends at 0 or above, exactly debt − repaid', async () => {
    const krt = await branchId('KRT');
    for (let round = 0; round < ROUNDS; round++) {
      const owed0 = await owedOf(ctx, krt);
      // Bring the debt to a known 1,000,000 first (repay what is owed, then advance).
      if (owed0 > 0) await recordRepayment(ctx, gm, { branchId: krt, account: 'BANK', amount: owed0, reason: 'Reset for the race', bankReference: `RESET-${round}` });
      await recordAdvance(ctx, gm, { branchId: krt, account: 'BANK', amount: 1_000_000, reason: 'Race funding', bankReference: `RACE-${round}` });
      const rs = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => recordRepayment(ctx, gm, { branchId: krt, account: 'BANK', amount: 300_000, reason: `Parallel repayment ${i}`, bankReference: `PAR-${round}-${i}` })),
      );
      expect(fulfilled(rs), `round ${round}`).toBe(3);
      expect(reasons(rs).every((r) => /more than the branch owes/.test(r)), reasons(rs).join(' | ')).toBe(true);
      expect(await owedOf(ctx, krt)).toBe(100_000);
    }
  });

  it('a repayment racing the correction of an advance: never both when together they exceed what is owed', async () => {
    const omd = await branchId('OMD');
    for (let round = 0; round < ROUNDS; round++) {
      const owed0 = await owedOf(ctx, omd);
      if (owed0 > 0) await recordRepayment(ctx, gm, { branchId: omd, account: 'BANK', amount: owed0, reason: 'Reset for the race', bankReference: `RST-${round}` });
      const a = await recordAdvance(ctx, gm, { branchId: omd, account: 'BANK', amount: 600_000, reason: 'Advance to correct', bankReference: `ADV-${round}` });
      // Owed = 600,000. A repayment of 400,000 and the correction of the 600,000 advance cannot both happen.
      const rs = await Promise.allSettled([
        recordRepayment(ctx, gm, { branchId: omd, account: 'BANK', amount: 400_000, reason: 'Repayment in the race', bankReference: `REP-${round}` }),
        correctFunding(ctx, gm, a.id, { reason: 'Correction in the race' }),
      ]);
      expect(fulfilled(rs), `round ${round}: ${reasons(rs).join(' | ')}`).toBe(1);
      const owed = await owedOf(ctx, omd);
      expect(owed).toBeGreaterThanOrEqual(0);
      expect([0, 200_000]).toContain(owed);
    }
  });

  it('overlapping locks (drawer + owed vs bank + owed) never deadlock: 40 mixed operations all finish', async () => {
    const bhr = await branchId('BHR');
    await recordAdvance(ctx, gm, { branchId: bhr, account: 'CASH', amount: 5_000_000, reason: 'Big float for the race' });
    const ops = Array.from({ length: 40 }, (_, i) =>
      i % 4 === 0
        ? recordAdvance(ctx, gm, { branchId: bhr, account: 'BANK', amount: 1_000, reason: `Bank advance ${i}`, bankReference: `MIX-${i}` })
        : i % 4 === 1
          ? recordRepayment(ctx, gm, { branchId: bhr, account: 'CASH', amount: 1_000, reason: `Cash repayment ${i}` })
          : i % 4 === 2
            ? recordAdvance(ctx, gm, { branchId: bhr, account: 'CASH', amount: 1_000, reason: `Cash advance ${i}` })
            : recordRepayment(ctx, gm, { branchId: bhr, account: 'BANK', amount: 1_000, reason: `Bank repayment ${i}`, bankReference: `MIX-${i}` }),
    );
    const rs = await Promise.allSettled(ops);
    expect(reasons(rs).filter((r) => /deadlock/i.test(r))).toEqual([]);
    expect(fulfilled(rs)).toBe(40);
  });
});
