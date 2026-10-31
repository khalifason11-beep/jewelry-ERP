// Real PostgreSQL only (MNY-1, plan docs/plans/MNY-1.md §6): money transfers at the same moment.
//   * a double confirm (two calls at once): one confirms, the other answers 409 MONEY_TRANSFER_STATE; money lands once;
//   * a confirm and a cancel at once: exactly one wins; the money is either landed or back, never both, never neither;
//   * a send and a scrap purchase racing on a small drawer: both lock CASH; the drawer never goes below zero;
//   * A→B and B→A confirmed at once, several rounds: no deadlock, both land;
//   * a send to a branch and its deactivation at once: either the send is refused (inactive) or the deactivation is
//     refused (money in transit); never a transfer to an inactive branch;
//   * the same Idempotency-Key five times at once, for a send and for a confirm: one transfer, its entries once;
//   * every round: Σ CASH + BANK + FUNDS_IN_TRANSIT of the branches involved is unchanged (no exit here).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { recordAdvance } from '../../src/modules/funding/service';
import { balances } from '../../src/modules/ledger/service';
import { buyScrap } from '../../src/modules/scrap/service';
import { updateBranch } from '../../src/modules/branches/service';
import { cancelMoneyTransfer, confirmMoneyTransfer, sendMoneyTransfer } from '../../src/modules/money-transfers/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let bm: Record<'KRT' | 'OMD' | 'BHR', Actor>;
let br: Record<string, number>;
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));
const actorOf = async (username: string) => (await loadActor(ctx.db, (await ctx.db.select().from(t.users).where(eq(t.users.username, username)))[0].id, null))!;
const bal = async (branchId: number) => Object.fromEntries((await balances(ctx.db, branchId)).map((b) => [b.kind, b.balance])) as Record<string, number>;
const money = async (...ids: number[]) => {
  let s = 0;
  for (const id of ids) {
    const b = await bal(id);
    s += b.CASH + b.BANK + b.FUNDS_IN_TRANSIT;
  }
  return s;
};
const send = (from: 'KRT' | 'OMD' | 'BHR', to: number, amount: number) => sendMoneyTransfer(ctx, bm[from], { to: { branchId: to }, account: 'CASH', amount, reason: 'race test' });

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  gm = await actorOf('general.manager');
  bm = { KRT: await actorOf('branch.manager.kh'), OMD: await actorOf('branch.manager.omd'), BHR: await actorOf('branch.manager.bhr') };
  br = Object.fromEntries((await ctx.db.select().from(t.branches)).map((b) => [b.code, b.id]));
  for (const c of ['KRT', 'OMD', 'BHR']) await recordAdvance(ctx, gm, { branchId: br[c], account: 'CASH', amount: 5_000_000, reason: 'test: fund the drawer' });
});
afterAll(async () => handle?.close());

describe('money transfers racing', () => {
  it('a double confirm: one wins, the other 409; money lands once', async () => {
    for (let round = 0; round < 6; round++) {
      const m0 = await money(br.KRT, br.OMD);
      const o0 = (await bal(br.OMD)).CASH;
      const tr = await send('KRT', br.OMD, 10_000);
      const results = await Promise.allSettled([confirmMoneyTransfer(ctx, bm.OMD, tr.id, { account: 'CASH' }), confirmMoneyTransfer(ctx, bm.OMD, tr.id, { account: 'CASH' })]);
      expect(results.map(codeOf).sort(), `round ${round}`).toEqual(['MONEY_TRANSFER_STATE', 'OK']);
      expect((await bal(br.OMD)).CASH - o0).toBe(10_000);
      expect(await money(br.KRT, br.OMD)).toBe(m0);
    }
  }, 120_000);

  it('a confirm and a cancel at once: exactly one wins', async () => {
    for (let round = 0; round < 8; round++) {
      const m0 = await money(br.KRT, br.OMD);
      const [k0, o0] = [(await bal(br.KRT)).CASH, (await bal(br.OMD)).CASH];
      const tr = await send('KRT', br.OMD, 20_000);
      const pair = [confirmMoneyTransfer(ctx, bm.OMD, tr.id, { account: 'CASH' }), cancelMoneyTransfer(ctx, bm.KRT, tr.id, { reason: 'race test' })];
      const outcome = (await Promise.allSettled(round % 2 ? pair : pair.reverse())).map(codeOf);
      const confirmed = round % 2 ? outcome[0] === 'OK' : outcome[1] === 'OK';
      expect(outcome.filter((c) => c === 'OK').length, `round ${round}`).toBe(1);
      expect(outcome.filter((c) => c === 'MONEY_TRANSFER_STATE').length).toBe(1);
      const [k1, o1] = [(await bal(br.KRT)).CASH, (await bal(br.OMD)).CASH];
      expect([k1 - k0, o1 - o0]).toEqual(confirmed ? [-20_000, 20_000] : [0, 0]);
      expect((await bal(br.KRT)).FUNDS_IN_TRANSIT).toBeGreaterThanOrEqual(0);
      expect(await money(br.KRT, br.OMD)).toBe(m0);
    }
  }, 120_000);

  it('a send and a scrap purchase on a small drawer: the drawer never goes below zero', async () => {
    for (let round = 0; round < 5; round++) {
      // Bring BHR's drawer down to 30,000 with a transfer it then keeps in transit.
      const drawer = (await bal(br.BHR)).CASH;
      const parked = drawer > 30_000 ? await send('BHR', br.KRT, drawer - 30_000) : null;
      const results = await Promise.allSettled([
        send('BHR', br.OMD, 20_000),
        buyScrap(ctx, bm.BHR, { branchId: br.BHR, kind: 'BROKEN', karat: 21, grossWeightMg: 1_000, netWeightMg: 1_000, paymentMethod: 'CASH', agreedRatePerGram: 20_000 }),
      ]);
      const after = (await bal(br.BHR)).CASH;
      expect(after, `round ${round}: ${results.map(codeOf).join('/')}`).toBeGreaterThanOrEqual(0);
      for (const r of results) if (r.status === 'rejected') expect(['DRAWER_SHORT', 'BAD_REQUEST', 'FORBIDDEN']).toContain(codeOf(r));
      if (parked) await cancelMoneyTransfer(ctx, bm.BHR, parked.id, { reason: 'race test cleanup' });
    }
  }, 120_000);

  it('A→B and B→A confirmed at once: no deadlock', async () => {
    for (let round = 0; round < 6; round++) {
      const m0 = await money(br.KRT, br.OMD);
      const ab = await send('KRT', br.OMD, 5_000);
      const ba = await send('OMD', br.KRT, 3_000);
      const results = await Promise.allSettled([confirmMoneyTransfer(ctx, bm.OMD, ab.id, { account: 'CASH' }), confirmMoneyTransfer(ctx, bm.KRT, ba.id, { account: 'CASH' })]);
      expect(results.map(codeOf), `round ${round}`).toEqual(['OK', 'OK']);
      expect(await money(br.KRT, br.OMD)).toBe(m0);
    }
  }, 120_000);

  it('a send to a branch and its deactivation at once: never a transfer to an inactive branch', async () => {
    for (let round = 0; round < 6; round++) {
      await ctx.db.update(t.branches).set({ isActive: true }).where(eq(t.branches.id, br.PZU));
      const results = await Promise.allSettled([send('KRT', br.PZU, 1_000), updateBranch(ctx, gm, br.PZU, { isActive: false })]);
      const [s, d] = results.map(codeOf);
      expect([`${s}/${d}`], `round ${round}`).toEqual([expect.stringMatching(/^(OK\/BRANCH_HAS_MONEY_IN_TRANSIT|BAD_REQUEST\/OK)$/)]);
      const [pzu] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, br.PZU));
      const inTransitToPzu = (await ctx.db.select().from(t.moneyTransfers).where(eq(t.moneyTransfers.toBranchId, br.PZU))).filter((x) => x.status === 'IN_TRANSIT');
      expect(pzu.isActive ? true : inTransitToPzu.length === 0).toBe(true);
      for (const tr of inTransitToPzu) await cancelMoneyTransfer(ctx, bm.KRT, tr.id, { reason: 'race test cleanup' });
    }
    await ctx.db.update(t.branches).set({ isActive: true }).where(eq(t.branches.id, br.PZU));
  }, 120_000);

  it('the same Idempotency-Key five times at once: one transfer, one confirmation, the entries once', async () => {
    const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
    const agentOf = async (username: string) => {
      const agent = request.agent(app);
      const login = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS.BRANCH_MANAGER });
      expect(login.status).toBe(200);
      agent.set('x-csrf-token', login.body.csrfToken);
      return agent;
    };
    const [krt, omd] = [await agentOf('branch.manager.kh'), await agentOf('branch.manager.omd')];
    const m0 = await money(br.KRT, br.OMD);
    const key = randomUUID();
    const body = { to: { branchId: br.OMD }, account: 'CASH', amount: 7_000, reason: 'five times at once' };
    const sends = await Promise.all([1, 2, 3, 4, 5].map(() => krt.post('/api/money-transfers').set('Idempotency-Key', key).send(body)));
    for (const r of sends) expect([200, 409]).toContain(r.status);
    const sent = sends.filter((r) => r.status === 200);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(new Set(sent.map((r) => r.body.id)).size).toBe(1);
    const id = sent[0].body.id as number;
    expect((await ctx.db.select().from(t.moneyTransfers).where(eq(t.moneyTransfers.reason, 'five times at once')))).toHaveLength(1);
    const ckey = randomUUID();
    const confirms = await Promise.all([1, 2, 3, 4, 5].map(() => omd.post(`/api/money-transfers/${id}/confirm`).set('Idempotency-Key', ckey).send({ account: 'CASH' })));
    for (const r of confirms) expect([200, 409]).toContain(r.status);
    expect(confirms.some((r) => r.status === 200)).toBe(true);
    const entries = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'money_transfer'), eq(t.ledgerEntries.refId, id)));
    expect(entries.map((e) => e.eventType).sort()).toEqual(['MONEY_TRANSFER_RECEIVED', 'MONEY_TRANSFER_RECEIVED', 'MONEY_TRANSFER_SENT', 'MONEY_TRANSFER_SENT']);
    expect((await ctx.db.select().from(t.moneyTransferEvents).where(eq(t.moneyTransferEvents.transferId, id))).map((e) => e.kind).sort()).toEqual(['RECEIVED', 'SENT']);
    expect(await money(br.KRT, br.OMD)).toBe(m0);
  }, 120_000);
});
