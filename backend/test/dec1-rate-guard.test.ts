// DEC-1 (RAT-1, D-dec1-11, D-dec1-13): the gold-rate edit guard. Both projects.
//   * change ≤ 10 %: allowed; > 10 % up to 30 %: a reason (422 without); > 30 %: a reason and the password in the
//     request (403 without; a wrong password is refused and counted like a re-confirmation);
//   * exact boundaries (10 % and 30 %, and 1 SDG either side), increase and decrease, the first rate of a karat;
//   * the same guard for the used-piece selling rate and the scrap buying rate; one refused change refuses the request;
//   * the thresholds are General Manager settings, validated 0 < warn < confirm ≤ 100, with history;
//   * every guarded change is audited with its percentage and reason.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { rateChangeBp, rateChangeLevel } from '@jerp/shared';
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
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const BASE = 100_000; // test value: 1 % = 1,000

async function login(username: string, password: string): Promise<Agent> {
  const a = withIdempotencyKeys(request.agent(app));
  const res = await a.post('/api/auth/login').send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  a.set('x-csrf-token', res.body.csrfToken);
  return a;
}
const setNew = (price: number, extra: object = {}) => gm.post('/api/gold-rates').send({ rates: { 21: price }, ...extra });
const setUsed = (price: number, extra: object = {}) => gm.post('/api/gold-rates').send({ usedRates: { 21: price }, ...extra });
const setScrap = (price: number, extra: object = {}) => gm.post('/api/scrap-rates').send({ rates: [{ karat: 21, pricePerGram: price }], ...extra });
const confirmAll = { reason: 'test: reset the rate', confirmPassword: PW };
const newRate = async () => (await gm.get('/api/gold-rates')).body.current['21'].pricePerGram as number;
const goldRows = async () => (await ctx.db.select().from(t.goldRates)).length;
const lastAudit = async (entityId: string) =>
  (await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.entityId, entityId)).orderBy(desc(t.auditLogs.id)).limit(1))[0];

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await login('general.manager', PW);
  expect((await gm.post('/api/auth/reauth').send({ password: PW })).status).toBe(200);
});
afterAll(async () => handle?.close());

describe('the decision is exact integer arithmetic', () => {
  it('levels at and around the thresholds; basis points', () => {
    expect(rateChangeLevel(null, 5, 10, 30)).toBe('FIRST');
    expect(rateChangeLevel(BASE, 110_000, 10, 30)).toBe('NONE');
    expect(rateChangeLevel(BASE, 110_001, 10, 30)).toBe('REASON');
    expect(rateChangeLevel(BASE, 130_000, 10, 30)).toBe('REASON');
    expect(rateChangeLevel(BASE, 130_001, 10, 30)).toBe('CONFIRM');
    expect(rateChangeLevel(BASE, 90_000, 10, 30)).toBe('NONE');
    expect(rateChangeLevel(BASE, 89_999, 10, 30)).toBe('REASON');
    expect(rateChangeLevel(BASE, 70_000, 10, 30)).toBe('REASON');
    expect(rateChangeLevel(BASE, 69_999, 10, 30)).toBe('CONFIRM');
    // A value where floating point would misjudge 10 %: 3 × 10 % of 333,333,33x.
    expect(rateChangeLevel(33_333_333, 36_666_666, 10, 30)).toBe('NONE');
    expect(rateChangeLevel(33_333_333, 36_666_667, 10, 30)).toBe('REASON');
    expect(rateChangeBp(BASE, 112_345)).toBe(1_235);
    expect(rateChangeBp(BASE, 87_655)).toBe(-1_235);
  });
});

describe('gold-rate edit guard (new-piece selling rate)', () => {
  beforeEach(async () => {
    if ((await newRate()) !== BASE) expect((await setNew(BASE, confirmAll)).status).toBe(200);
  });

  it('increase: exactly +10 % passes without a reason; +10 % and 1 SDG needs one (422)', async () => {
    expect((await setNew(110_000)).status).toBe(200);
    expect((await setNew(BASE)).status).toBe(200); // −9.09 %
    const before = await goldRows();
    const r = await setNew(110_001);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'RATE_CHANGE_REASON_REQUIRED', params: { pct: 10 } });
    expect(r.body.error.details.changes[0]).toMatchObject({ karat: 21, kind: 'NEW', from: BASE, to: 110_001, changeBp: 1_000, level: 'REASON' });
    expect(await goldRows()).toBe(before);
    expect((await setNew(110_001, { reason: 'ab' })).status).toBe(422); // shorter than the SEC-2 minimum
    const ok = await setNew(110_001, { reason: 'Market moved up' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const audit = await lastAudit('21K');
    expect(audit.descriptionKey).toBe('{karat} gold rate {from} → {to} per gram ({change}%): {reason}');
    expect(audit.metadata).toMatchObject({ from: BASE, to: 110_001, changeBp: 1_000, guard: 'REASON', reason: 'Market moved up' });
  });

  it('increase: exactly +30 % needs only the reason; +30 % and 1 SDG needs the password too (403)', async () => {
    expect((await setNew(130_000, { reason: 'Market moved up' })).status).toBe(200);
    expect((await setNew(BASE, { reason: 'back to the base' })).status).toBe(200);
    const noPw = await setNew(130_001, { reason: 'Market moved up' });
    expect(noPw.status).toBe(403);
    expect(noPw.body.error).toMatchObject({ code: 'RATE_CHANGE_CONFIRM_REQUIRED', params: { pct: 30 } });
    // The password alone is not enough: the reason is still required (422).
    expect((await setNew(130_001, { confirmPassword: PW })).status).toBe(422);
    const ok = await setNew(130_001, { reason: 'Market moved up', confirmPassword: PW });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await lastAudit('21K')).metadata).toMatchObject({ changeBp: 3_000, guard: 'CONFIRM', reason: 'Market moved up' });
  });

  it('decrease is checked the same way: −10 % passes, −10 % and 1 SDG needs a reason, below −30 % the password', async () => {
    expect((await setNew(90_000)).status).toBe(200);
    expect((await setNew(BASE, { reason: 'back to the base' })).status).toBe(200); // +11.1 %
    expect((await setNew(89_999)).status).toBe(422);
    expect((await setNew(70_000, { reason: 'Market fell' })).status).toBe(200);
    expect((await setNew(BASE, confirmAll)).status).toBe(200); // +42.9 %
    expect((await setNew(69_999, { reason: 'Market fell' })).status).toBe(403);
    expect((await setNew(69_999, { reason: 'Market fell', confirmPassword: PW })).status).toBe(200);
    expect((await lastAudit('21K')).metadata).toMatchObject({ changeBp: -3_000, guard: 'CONFIRM' });
  });

  it('a wrong password is refused like a re-confirmation and writes nothing', async () => {
    const before = await goldRows();
    const r = await setNew(150_000, { reason: 'Market moved up', confirmPassword: 'not-the-password' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('REAUTH_FAILED');
    expect(await goldRows()).toBe(before);
    const failed = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'REAUTH_FAILED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(failed.length).toBe(1);
  });

  it('the first rate of a karat is not checked', async () => {
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [18, 21] }, { actor: { id: null, username: 'test' } });
    const r = await gm.post('/api/gold-rates').send({ rates: { 18: 5 }, usedRates: { 18: 999_999 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await lastAudit('18K')).metadata).toMatchObject({ guard: 'FIRST', changeBp: null });
    // The second edit of that karat is checked (5 → 6 is +20 %).
    expect((await gm.post('/api/gold-rates').send({ rates: { 18: 6 } })).status).toBe(422);
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [21] }, { actor: { id: null, username: 'test' } });
  });

  it('one refused change refuses the whole request (nothing written)', async () => {
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [18, 21] }, { actor: { id: null, username: 'test' } });
    const before = await goldRows();
    const r = await gm.post('/api/gold-rates').send({ rates: { 21: 101_000, 18: 50 } }); // 21K +1 %, 18K far above
    expect(r.status).toBe(403);
    expect(await goldRows()).toBe(before);
    await ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': [21] }, { actor: { id: null, username: 'test' } });
  });
});

describe('the same guard for the used-piece rate and the scrap buying rate', () => {
  it('used-piece selling rate', async () => {
    await setUsed(BASE, confirmAll);
    expect((await setUsed(110_000)).status).toBe(200);
    expect((await setUsed(BASE)).status).toBe(200);
    expect((await setUsed(110_001)).body.error.code).toBe('RATE_CHANGE_REASON_REQUIRED');
    expect((await setUsed(130_001, { reason: 'Market moved up' })).body.error.code).toBe('RATE_CHANGE_CONFIRM_REQUIRED');
    expect((await setUsed(130_001, { reason: 'Market moved up', confirmPassword: PW })).status).toBe(200);
    expect((await lastAudit('21K-USED')).metadata).toMatchObject({ kind: 'USED', changeBp: 3_000, guard: 'CONFIRM' });
  });

  it('scrap buying rate', async () => {
    expect((await setScrap(BASE, confirmAll)).status).toBe(200);
    expect((await setScrap(110_000)).status).toBe(200);
    expect((await setScrap(BASE)).status).toBe(200);
    const r = await setScrap(110_001);
    expect(r.status).toBe(422);
    expect(r.body.error.details.changes[0]).toMatchObject({ kind: 'SCRAP', changeBp: 1_000 });
    expect((await setScrap(130_001, { reason: 'Market moved up' })).status).toBe(403);
    expect((await setScrap(130_001, { reason: 'Market moved up', confirmPassword: PW })).status).toBe(200);
    const a = await lastAudit('21K');
    expect(a.action).toBe('SCRAP_RATE_CHANGED');
    expect(a.descriptionKey).toBe('{karat} scrap buying rate {from} → {to} per gram ({change}%): {reason}');
    expect(a.metadata).toMatchObject({ changeBp: 3_000, guard: 'CONFIRM', reason: 'Market moved up' });
    // A scrap karat seen for the first time (any karat 1–24) is not checked.
    expect((await gm.post('/api/scrap-rates').send({ rates: [{ karat: 9, pricePerGram: 1 }] })).status).toBe(200);
  });
});

describe('the thresholds are General Manager settings', () => {
  const put = async (changes: Record<string, unknown>) => {
    const versions = (await gm.get('/api/settings')).body.versions;
    return gm.put('/api/settings').send({ changes, expectedVersions: Object.fromEntries(Object.keys(changes).map((k) => [k, versions[k] ?? 0])) });
  };

  it('defaults 10 and 30; validated 0 < warn < confirm ≤ 100', async () => {
    expect((await gm.get('/api/settings')).body.settings.rates).toMatchObject({ warnChangePercent: 10, confirmChangePercent: 30 });
    for (const bad of [{ 'rates.warnChangePercent': 0 }, { 'rates.warnChangePercent': 30 }, { 'rates.warnChangePercent': 40 }, { 'rates.confirmChangePercent': 101 }, { 'rates.confirmChangePercent': 10 }, { 'rates.warnChangePercent': 5.5 }]) {
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('changed with history; the guard follows the new values; only the General Manager may change them', async () => {
    const r = await put({ 'rates.warnChangePercent': 20, 'rates.confirmChangePercent': 40 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const hist = await ctx.db.select().from(t.settingsHistory).where(and(eq(t.settingsHistory.key, 'rates.warnChangePercent'))).orderBy(desc(t.settingsHistory.id)).limit(1);
    expect(hist[0]).toMatchObject({ newValue: 20 });
    await setNew(BASE, confirmAll);
    expect((await setNew(115_000)).status).toBe(200); // +15 %: under the new 20 %
    expect((await setNew(BASE)).status).toBe(200);
    expect((await setNew(135_000, { reason: 'Market moved up' })).status).toBe(200); // +35 %: under the new 40 %
    expect((await put({ 'rates.warnChangePercent': 10, 'rates.confirmChangePercent': 30 })).status).toBe(200);
    const bm = await login('branch.manager.kh', DEMO_PASSWORDS.BRANCH_MANAGER);
    expect((await bm.put('/api/settings').send({ changes: { 'rates.warnChangePercent': 50 } })).status).toBe(403);
  });
});
