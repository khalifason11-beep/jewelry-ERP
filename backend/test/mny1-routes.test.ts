// MNY-1 over HTTP (both projects): the routes, the guard and the Idempotency-Key.
//   * a branch manager sends, the receiving branch manager confirms into the drawer, both through the API; no re-auth
//     is asked at any step (decision 7), even with an expired window;
//   * the same key twice replays the first answer and moves money once; the same key with another body is 422;
//   * the General Manager: 403 on send (no permission), sees every transfer, confirms only one addressed to him;
//   * a cashier: 403 on every route; a branch manager of a third branch: 404 on the transfer, 403 on another branch's list.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { recordAdvance } from '../src/modules/funding/service';
import { balances } from '../src/modules/ledger/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
const agents: Record<string, Agent> = {};
let br: Record<string, number>;

const login = async (username: string, role: keyof typeof DEMO_PASSWORDS, keys = true) => {
  const a = keys ? withIdempotencyKeys(request.agent(app)) : request.agent(app);
  const r = await a.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  a.set('x-csrf-token', r.body.csrfToken);
  return a;
};
const cash = async (branchId: number) => (await balances(ctx.db, branchId)).find((b) => b.kind === 'CASH')!.balance;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  br = Object.fromEntries((await ctx.db.select().from(t.branches)).map((b) => [b.code, b.id]));
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const gm = (await loadActor(ctx.db, u.id, null))!;
  await recordAdvance(ctx, gm, { branchId: br.KRT, account: 'CASH', amount: 1_000_000, reason: 'test: fund the drawer' });
  agents.gm = await login('general.manager', 'GENERAL_MANAGER');
  agents.krt = await login('branch.manager.kh', 'BRANCH_MANAGER');
  agents.omd = await login('branch.manager.omd', 'BRANCH_MANAGER');
  agents.bhr = await login('branch.manager.bhr', 'BRANCH_MANAGER');
  agents.cashier = await login('cashier.kh.01', 'CASHIER');
  // Every window expired: no step of a transfer may ask for a re-confirmation (owner, decision 7).
  await ctx.db.update(t.sessions).set({ reauthAt: null, passkeyReauthAt: null });
});
afterAll(async () => handle?.close());

describe('money transfers over HTTP', () => {
  it('send and confirm with no re-auth; the drawers move once', async () => {
    const [k0, o0] = [await cash(br.KRT), await cash(br.OMD)];
    const sent = await agents.krt.post('/api/money-transfers').send({ to: { branchId: br.OMD }, account: 'CASH', amount: 40_000, reason: 'advance for the day' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const id = sent.body.id;
    const list = (await agents.omd.get('/api/money-transfers').query({ direction: 'IN', status: 'IN_TRANSIT' })).body;
    expect(list.rows.some((r: { id: number }) => r.id === id)).toBe(true);
    const ok = await agents.omd.post(`/api/money-transfers/${id}/confirm`).send({ account: 'CASH' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect([await cash(br.KRT) - k0, await cash(br.OMD) - o0]).toEqual([-40_000, 40_000]);
    const detail = (await agents.gm.get(`/api/money-transfers/${id}`)).body;
    expect([detail.status, detail.landedAccount, detail.events.length]).toEqual(['RECEIVED', 'CASH', 2]);
  });

  it('the same Idempotency-Key replays the answer and moves money once; another body with it is 422', async () => {
    const plain = await login('branch.manager.kh', 'BRANCH_MANAGER', false);
    const k0 = await cash(br.KRT);
    const body = { to: { branchId: br.BHR }, account: 'CASH', amount: 7_000, reason: 'twice by mistake' };
    const key = randomUUID();
    const a = await plain.post('/api/money-transfers').set('Idempotency-Key', key).send(body);
    const b = await plain.post('/api/money-transfers').set('Idempotency-Key', key).send(body);
    expect([a.status, b.status, a.body.id === b.body.id]).toEqual([200, 200, true]);
    expect(await cash(br.KRT) - k0).toBe(-7_000);
    const c = await plain.post('/api/money-transfers').set('Idempotency-Key', key).send({ ...body, amount: 8_000 });
    expect(c.status).toBe(422);
    expect((await agents.krt.post(`/api/money-transfers/${a.body.id}/cancel`).send({ reason: 'sent by mistake' })).status).toBe(200);
  });

  it('the General Manager: no send; sees every transfer; confirms only his', async () => {
    expect((await agents.gm.post('/api/money-transfers').send({ to: { branchId: br.OMD }, account: 'CASH', amount: 1_000, reason: 'from the GM' })).status).toBe(403);
    const toBranch = (await agents.krt.post('/api/money-transfers').send({ to: { branchId: br.OMD }, account: 'CASH', amount: 1_000, reason: 'to OMD' })).body;
    const toGm = (await agents.krt.post('/api/money-transfers').send({ to: { generalManager: true }, account: 'CASH', amount: 2_000, reason: 'takings for the GM' })).body;
    expect((await agents.gm.post(`/api/money-transfers/${toBranch.id}/confirm`).send({ account: 'CASH' })).status).toBe(403);
    expect((await agents.gm.post(`/api/money-transfers/${toBranch.id}/cancel`).send({ reason: 'the GM cancels' })).status).toBe(403);
    const all = (await agents.gm.get('/api/money-transfers').query({ pageSize: 200 })).body.rows.map((r: { id: number }) => r.id);
    expect(all).toEqual(expect.arrayContaining([toBranch.id, toGm.id]));
    const mine = (await agents.gm.get('/api/money-transfers').query({ direction: 'IN', status: 'IN_TRANSIT' })).body.rows;
    expect(mine.map((r: { id: number }) => r.id)).toEqual([toGm.id]);
    expect((await agents.gm.post(`/api/money-transfers/${toGm.id}/confirm`).send({})).status).toBe(200);
    expect((await agents.omd.post(`/api/money-transfers/${toBranch.id}/confirm`).send({ account: 'CASH' })).status).toBe(200);
  });

  it('a cashier: 403 everywhere; a third branch: 404 on the transfer, 403 on another branch list', async () => {
    const tr = (await agents.krt.post('/api/money-transfers').send({ to: { branchId: br.OMD }, account: 'CASH', amount: 1_000, reason: 'third branch test' })).body;
    for (const r of [
      () => agents.cashier.get('/api/money-transfers'),
      () => agents.cashier.get(`/api/money-transfers/${tr.id}`),
      () => agents.cashier.post('/api/money-transfers').send({ to: { branchId: br.OMD }, account: 'CASH', amount: 1, reason: 'cashier' }),
      () => agents.cashier.post(`/api/money-transfers/${tr.id}/confirm`).send({ account: 'CASH' }),
      () => agents.cashier.post(`/api/money-transfers/${tr.id}/cancel`).send({ reason: 'cashier' }),
    ]) {
      expect((await r()).status).toBe(403);
    }
    expect((await agents.bhr.get(`/api/money-transfers/${tr.id}`)).status).toBe(404);
    expect((await agents.bhr.post(`/api/money-transfers/${tr.id}/confirm`).send({ account: 'CASH' })).status).toBe(404);
    expect((await agents.bhr.get('/api/money-transfers').query({ branchId: br.KRT })).status).toBe(403);
    expect((await agents.krt.post(`/api/money-transfers/${tr.id}/cancel`).send({ reason: 'test over' })).status).toBe(200);
  });
});
