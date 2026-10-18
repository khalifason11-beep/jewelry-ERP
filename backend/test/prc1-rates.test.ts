// PRC-1 selling rates (D-prc1-2, D-prc1-7). Both projects.
//   * the General Manager sets a NEW and a USED selling rate per karat; any karat of inventory.allowedKarats (here 9, 12
//     and 14: no fixed 18/21/22/24 list), never one that is not allowed; only real changes are written, append-only,
//     audited with the kind; re-authentication is required;
//   * the rate screen data (current, used, history with kind and who) is the same for every role that reads it; only
//     the General Manager changes a rate (branch manager and cashier: 403);
//   * the first-steps "rates" step and A16 ask, in computed mode, for both selling rates and the scrap rate of every
//     allowed karat.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
let gm: Agent;

async function login(username: string, password: string): Promise<Agent> {
  const a = withIdempotencyKeys(request.agent(app));
  const res = await a.post('/api/auth/login').send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  a.set('x-csrf-token', res.body.csrfToken);
  return a;
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date(), { pricingMode: 'RATE_COMPUTED' });
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await login('general.manager', DEMO_PASSWORDS.GENERAL_MANAGER);
  expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
});
afterAll(async () => handle?.close());

const attentionCodes = async () => ((await gm.get('/api/attention')).body.signals as { code: string }[]).map((s) => s.code);

describe('selling rates for any allowed karat (9, 12, 14)', () => {
  it('the General Manager sets new and used rates for 9, 12 and 14 K; a karat that is not allowed is refused', async () => {
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [9, 12, 14] }, { actor: { id: null, username: 'test' } });
    const set = await gm.post('/api/gold-rates').send({ rates: { 9: 80_000, 12: 105_000, 14: 122_000 }, usedRates: { 9: 70_000, 12: 95_000, 14: 110_000 } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.allowedKarats).toEqual([9, 12, 14]);
    expect(Object.fromEntries(Object.entries(set.body.current).map(([k, v]) => [k, (v as { pricePerGram: number }).pricePerGram]))).toEqual({ 9: 80_000, 12: 105_000, 14: 122_000 });
    expect(Object.fromEntries(Object.entries(set.body.used).map(([k, v]) => [k, (v as { pricePerGram: number }).pricePerGram]))).toEqual({ 9: 70_000, 12: 95_000, 14: 110_000 });
    const notAllowed = await gm.post('/api/gold-rates').send({ usedRates: { 21: 150_000 } });
    expect(notAllowed.status).toBe(400);
    expect(notAllowed.body.error.params).toEqual({ karat: '21' });
    // The inventory karat filter follows the same setting: an allowed 9 K is a valid filter, a karat not allowed is not.
    expect((await gm.get('/api/inventory/items').query({ karat: 9 })).status).toBe(200);
    expect((await gm.get('/api/inventory/items').query({ karat: 21 })).status).toBe(400);
    const kinds = await ctx.db.select({ kind: t.goldRates.kind }).from(t.goldRates).where(eq(t.goldRates.karat, 14));
    expect(kinds.map((k) => k.kind).sort()).toEqual(['NEW', 'USED']);
  });

  it('only real changes are written; each change is audited with its kind; history shows kind and who', async () => {
    const before = (await ctx.db.select().from(t.goldRates)).length;
    expect((await gm.post('/api/gold-rates').send({ rates: { 9: 80_000 }, usedRates: { 9: 72_000 } })).status).toBe(200);
    expect((await ctx.db.select().from(t.goldRates)).length).toBe(before + 1);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'GOLD_RATE_CHANGED'), eq(t.auditLogs.entityId, '9K-USED'))).orderBy(desc(t.auditLogs.id));
    expect(audit).toMatchObject({ descriptionKey: '{karat} used-piece selling rate {from} → {to} per gram' });
    expect(audit.metadata).toMatchObject({ kind: 'USED', from: 70_000, to: 72_000 });
    const view = (await gm.get('/api/gold-rates')).body;
    expect(view.history[0]).toMatchObject({ karat: 9, kind: 'USED', pricePerGram: 72_000, setBy: expect.any(String) });
  });

  it('only the General Manager changes a rate; every signed-in role reads them', async () => {
    for (const [user, role] of [['branch.manager.kh', 'BRANCH_MANAGER'], ['cashier.kh.01', 'CASHIER']] as const) {
      const a = await login(user, DEMO_PASSWORDS[role]);
      expect((await a.post('/api/gold-rates').send({ usedRates: { 9: 1 } })).status, user).toBe(403);
      const view = await a.get('/api/gold-rates');
      expect(view.status).toBe(200);
      expect(view.body.used[9].pricePerGram).toBe(72_000);
    }
  });

  it('the rates step and A16 ask for both selling rates and the scrap rate of every allowed karat', async () => {
    // 9, 12 and 14 K have both selling rates but no scrap buying rate yet in the world for every one of them.
    const scrapKarats = new Set((await ctx.db.select({ k: t.scrapRates.karat }).from(t.scrapRates)).map((r) => r.k));
    const missingScrap = [9, 12, 14].filter((k) => !scrapKarats.has(k));
    if (missingScrap.length) {
      expect(await attentionCodes()).toContain('A16');
      expect((await gm.post('/api/scrap-rates').send({ rates: missingScrap.map((k) => ({ karat: k, pricePerGram: 60_000 + k * 1_000 })) })).status).toBe(200);
    }
    expect(await attentionCodes()).not.toContain('A16');
    // A new allowed karat without its used rate: A16 again, until it is set.
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [9, 12, 14, 18] }, { actor: { id: null, username: 'test' } });
    expect((await gm.post('/api/gold-rates').send({ rates: { 18: 150_000 } })).status).toBe(200);
    expect(await attentionCodes()).toContain('A16');
    expect((await gm.post('/api/gold-rates').send({ usedRates: { 18: 140_000 } })).status).toBe(200);
    expect(await attentionCodes()).not.toContain('A16');
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [21] }, { actor: { id: null, username: 'test' } });
  });
});
