// BE-1 (docs/plans/UI-B.md §1, D-ui-17): the attention list. Each signal raises and clears; who sees what; thresholds
// come from the settings; no COST field for a branch manager; the number of SQL statements does not grow with the
// number of branches.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { COST_RESPONSE_FIELDS } from '@jerp/shared';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { addDays, dayKey } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { attentionFor, type Signal } from '../src/modules/attention/service';
import { createTransfer, receiveTransfer } from '../src/modules/transfers/service';
import { recordCount, reconciliation } from '../src/modules/ledger/service';
import { createSale } from '../src/modules/sales/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = request.agent(app) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const list = async (username: string, q: { branchId?: number } = {}) => (await attentionFor(ctx, await actorOf(username), q)).signals;
const codes = (s: Signal[]) => s.map((x) => x.code);
const of = (s: Signal[], code: string) => s.filter((x) => x.code === code);
const freshItems = async (code: string, n: number) =>
  ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, await branchId(code)), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(n);

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('the route: who may ask', () => {
  it('GM and branch manager yes; a branch manager for another branch no; a cashier no', async () => {
    expect((await (await login('general.manager', 'GENERAL_MANAGER')).get('/api/attention')).status).toBe(200);
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    expect((await bm.get('/api/attention')).status).toBe(200);
    expect((await bm.get(`/api/attention?branchId=${await branchId('OMD')}`)).status).toBe(403);
    expect((await (await login('cashier.kh.01', 'CASHIER')).get('/api/attention')).status).toBe(403);
  });

  it('a branch manager never receives a COST field, nor a company-level or GM-only signal', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const body = (await bm.get('/api/attention')).body;
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    };
    walk(body);
    for (const k of keys) expect(COST_RESPONSE_FIELDS.has(k), `COST field ${k}`).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/cost|profit|making/i);
    for (const s of body.signals as Signal[]) {
      expect(['A9', 'A10', 'A16', 'S2']).not.toContain(s.code);
      if (s.branchId != null) expect(s.branchId).toBe(await branchId('KRT'));
    }
  });
});

describe('A1 / A2 transfers', () => {
  it('A1 for the receiving branch and the GM (not the sender); late → A2 for both ends; received → gone', async () => {
    const [krt, omd] = [await branchId('KRT'), await branchId('OMD')];
    const items = await freshItems('KRT', 2);
    const tr = await createTransfer(ctx, await actorOf('branch.manager.kh'), { toBranchId: omd, itemIds: items.map((i) => i.id), courierName: 'مندوب' });
    expect(of(await list('branch.manager.omd'), 'A1').some((s) => s.branchId === omd)).toBe(true);
    expect(of(await list('general.manager'), 'A1').some((s) => s.branchId === omd)).toBe(true);
    expect(of(await list('branch.manager.kh'), 'A1').some((s) => s.branchId === omd)).toBe(false);

    await ctx.db.update(t.transfers).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(t.transfers.id, tr.id));
    for (const u of ['branch.manager.kh', 'branch.manager.omd', 'general.manager']) {
      const a2 = of(await list(u), 'A2').find((s) => s.id === `A2:${tr.id}`);
      expect(a2, u).toMatchObject({ severity: 'warning', params: { number: tr.number, hours: 25, items: 2 } });
    }
    // The threshold is the setting: 48 h makes it in transit again.
    await ctx.settings.update(ctx.db, { transfers: { pendingClaimStaleHours: 48 } }, null);
    expect(of(await list('general.manager'), 'A2').some((s) => s.id === `A2:${tr.id}`)).toBe(false);
    await ctx.settings.update(ctx.db, { transfers: { pendingClaimStaleHours: 24 } }, null);

    await receiveTransfer(ctx, await actorOf('branch.manager.omd'), tr.id);
    expect((await list('general.manager')).some((s) => s.id === `A2:${tr.id}`)).toBe(false);
    void krt;
  });
});

describe('A4 / A5 cash counts', () => {
  it('A4: a count that differs from the expected cash (beyond the tolerance) until a matching recount', async () => {
    const krt = await branchId('KRT');
    const bm = await actorOf('branch.manager.kh');
    const { company } = await ctx.settings.get();
    const day = dayKey(new Date(), company.timezone);
    const r = await reconciliation(ctx, bm, { branchId: krt, day });
    await recordCount(ctx, bm, { branchId: krt, day, countedAmount: r.expectedCash - 35_000 });
    const a4 = of(await list('branch.manager.kh'), 'A4')[0];
    expect(a4).toMatchObject({ branchId: krt, severity: 'warning', params: { amount: -35_000, day } });
    expect(of(await list('general.manager'), 'A4').some((s) => s.branchId === krt)).toBe(true);
    expect(of(await list('branch.manager.omd'), 'A4').some((s) => s.branchId === krt)).toBe(false);
    // Tolerance from the settings.
    await ctx.settings.update(ctx.db, { cash: { countDifferenceTolerance: 35_000 } }, null);
    expect(of(await list('branch.manager.kh'), 'A4')).toHaveLength(0);
    await ctx.settings.update(ctx.db, { cash: { countDifferenceTolerance: 0 } }, null);
    expect(of(await list('branch.manager.kh'), 'A4')).toHaveLength(1);
    await recordCount(ctx, bm, { branchId: krt, day, countedAmount: r.expectedCash });
    expect(of(await list('branch.manager.kh'), 'A4')).toHaveLength(0);
  });

  it('A5: yesterday had cash movements and no count; a count for yesterday clears it; no movements → nothing', async () => {
    const omd = await branchId('OMD');
    const bm = await actorOf('branch.manager.omd');
    const { company } = await ctx.settings.get();
    const yesterday = addDays(dayKey(new Date(), company.timezone), -1);
    const [item] = await freshItems('OMD', 1);
    const noon = new Date(`${yesterday}T09:00:00Z`);
    await createSale(ctx, await actorOf('cashier.omd.01'), { items: [{ itemId: item.id }], paymentMethod: 'CASH' }, { at: noon });
    const a5 = of(await list('branch.manager.omd'), 'A5')[0];
    expect(a5).toMatchObject({ branchId: omd, params: { day: yesterday } });
    const r = await reconciliation(ctx, bm, { branchId: omd, day: yesterday });
    await recordCount(ctx, bm, { branchId: omd, day: yesterday, countedAmount: r.expectedCash });
    expect(of(await list('branch.manager.omd'), 'A5')).toHaveLength(0);
  });
});

describe('A6 supplier gold owed (weight only)', () => {
  it('per supplier, warning beyond the age setting, info within; settled → gone; weights, never money', async () => {
    const before = of(await list('general.manager'), 'A6');
    expect(before.length).toBeGreaterThan(0);
    for (const s of before) {
      expect(Object.keys(s.params).sort()).toEqual(['days', 'orders', 'pureMg24', 'supplier', 'supplierAr']);
      expect(s.link).toMatch(/^\/purchases\/\d+$/);
    }
    await ctx.settings.update(ctx.db, { purchases: { supplierDebtMaxAgeDays: 3650 } }, null);
    expect(of(await list('general.manager'), 'A6').every((s) => s.severity === 'info')).toBe(true);
    await ctx.settings.update(ctx.db, { purchases: { supplierDebtMaxAgeDays: 1 } }, null);
    expect(of(await list('general.manager'), 'A6').some((s) => s.severity === 'warning')).toBe(true);
    await ctx.settings.update(ctx.db, { purchases: { supplierDebtMaxAgeDays: 30 } }, null);
    // A branch manager sees only the own branch's orders.
    const krtOwed = Number((await ctx.db.execute(sql`SELECT coalesce(sum(gold_owed_mg_pure24),0) AS s FROM purchases WHERE branch_id = ${await branchId('KRT')} AND gold_owed_mg_pure24 > 0`) as unknown as { rows?: { s: string }[] }).rows?.[0]?.s ?? 0);
    const bmTotal = of(await list('branch.manager.kh'), 'A6').reduce((a, s) => a + Number(s.params.pureMg24), 0);
    expect(bmTotal).toBe(krtOwed);
  });
});

describe('A9 backups: critical, for the GM only', () => {
  it('a stale backup is CRITICAL; fresh backup and drill clear it', async () => {
    const old = new Date(Date.now() - 100 * 3_600_000);
    await ctx.db.insert(t.backupRuns).values({ kind: 'BACKUP', status: 'SUCCESS', startedAt: old, finishedAt: old });
    const a9 = of(await list('general.manager'), 'A9')[0];
    expect(a9).toMatchObject({ severity: 'critical', branchId: null });
    expect(String(a9.params.reasons)).toContain('BACKUP_STALE');
    expect(of(await list('branch.manager.kh'), 'A9')).toHaveLength(0);
    // The GM's branch view leaves company-level signals out.
    expect(of(await list('general.manager', { branchId: await branchId('KRT') }), 'A9')).toHaveLength(0);
    const now = new Date();
    await ctx.db.insert(t.backupRuns).values([{ kind: 'BACKUP', status: 'SUCCESS', startedAt: now, finishedAt: now }, { kind: 'VERIFY', status: 'SUCCESS', startedAt: now, finishedAt: now }]);
    expect(of(await list('general.manager'), 'A9')).toHaveLength(0);
  });
});

describe('A10 / A11 / A12 security', () => {
  it('A10 new-device sign-ins (GM only; a manager account makes it a warning)', async () => {
    const [bm] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'branch.manager.bhr'));
    await ctx.db.insert(t.signInEvents).values({ userId: bm.id, method: 'PASSWORD', newDevice: true });
    expect(of(await list('general.manager'), 'A10')[0]).toMatchObject({ severity: 'warning', params: { managers: 1 } });
    expect(of(await list('branch.manager.bhr'), 'A10')).toHaveLength(0);
  });

  it('A11 failed sign-ins: GM all; a branch manager the own branch only', async () => {
    await request(app).post('/api/auth/login').send({ username: 'cashier.kh.02', password: 'wrong-password-1' });
    expect(of(await list('general.manager'), 'A11')[0]?.count).toBeGreaterThan(0);
    expect(of(await list('branch.manager.kh'), 'A11')[0]?.count).toBeGreaterThan(0);
    expect(of(await list('branch.manager.pzu'), 'A11')).toHaveLength(0);
  });

  it('A12 temporarily locked accounts, own branch for a manager; a security-locked one is left to the shell notice', async () => {
    await ctx.db.update(t.users).set({ lockedUntil: new Date(Date.now() + 3_600_000) }).where(eq(t.users.username, 'cashier.pzu.01'));
    expect(of(await list('branch.manager.pzu'), 'A12')[0]?.count).toBe(1);
    expect(of(await list('branch.manager.kh'), 'A12')).toHaveLength(0);
    await ctx.db.update(t.users).set({ securityLockedAt: new Date(), securityLockReason: 'test' }).where(eq(t.users.username, 'cashier.pzu.01'));
    expect(of(await list('branch.manager.pzu'), 'A12')).toHaveLength(0);
    await ctx.db.update(t.users).set({ lockedUntil: null, securityLockedAt: null, securityLockReason: null }).where(eq(t.users.username, 'cashier.pzu.01'));
  });
});

describe('A15 stock reconciliation, A16 rates', () => {
  it('A15: a piece whose status changed without its movement is CRITICAL for its branch; corrected → gone', async () => {
    const bhr = await branchId('BHR');
    expect(of(await list('general.manager'), 'A15')).toHaveLength(0);
    const [item] = await freshItems('BHR', 1);
    await ctx.db.update(t.jewelryItems).set({ status: 'DAMAGED' }).where(eq(t.jewelryItems.id, item.id));
    expect(of(await list('branch.manager.bhr'), 'A15')[0]).toMatchObject({ severity: 'critical', branchId: bhr, params: { pieces: -1 } });
    expect(of(await list('branch.manager.kh'), 'A15')).toHaveLength(0);
    await ctx.db.update(t.jewelryItems).set({ status: 'AVAILABLE' }).where(eq(t.jewelryItems.id, item.id));
    expect(of(await list('general.manager'), 'A15')).toHaveLength(0);
  });

  it('A16: a missing scrap rate for a sellable karat is CRITICAL (GM only)', async () => {
    expect(of(await list('general.manager'), 'A16')).toHaveLength(0);
    // Rates are append-only: make a karat sellable that has no scrap rate, then put the setting back.
    const { inventory } = await ctx.settings.get();
    const rated = new Set((await ctx.db.select({ k: t.scrapRates.karat }).from(t.scrapRates)).map((r) => r.k));
    const unrated = [9, 10, 12, 14, 15, 16, 20].find((k) => !rated.has(k))!;
    const set = (allowedKarats: number[]) => ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': allowedKarats }, { actor: { id: null, username: 'system' }, allowGuarded: true });
    await set([...inventory.allowedKarats, unrated]);
    expect(of(await list('general.manager'), 'A16')[0]).toMatchObject({ severity: 'critical' });
    expect(of(await list('branch.manager.kh'), 'A16')).toHaveLength(0);
    await set(inventory.allowedKarats);
    expect(of(await list('general.manager'), 'A16')).toHaveLength(0);
  });

  it('S2: touch-only keys accepted (GM only)', async () => {
    await ctx.settings.apply(ctx.db, { 'security.webauthnUserVerification': 'preferred' }, { actor: { id: null, username: 'system' }, allowGuarded: true });
    expect(of(await list('general.manager'), 'S2')).toHaveLength(1);
    expect(of(await list('branch.manager.kh'), 'S2')).toHaveLength(0);
    await ctx.settings.apply(ctx.db, { 'security.webauthnUserVerification': 'required' }, { actor: { id: null, username: 'system' }, allowGuarded: true });
    expect(of(await list('general.manager'), 'S2')).toHaveLength(0);
  });
});

describe('order and cost of the query', () => {
  it('ordered by severity (critical first)', async () => {
    const s = await list('general.manager');
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < s.length; i++) expect(rank[s[i - 1].severity]).toBeLessThanOrEqual(rank[s[i].severity]);
  });

  it('the number of SQL statements does not grow with the number of branches', async () => {
    const count = async () => {
      let n = 0;
      const orig = ctx.db.execute.bind(ctx.db);
      (ctx.db as unknown as { execute: typeof orig }).execute = ((q: Parameters<typeof orig>[0]) => (n++, orig(q))) as typeof orig;
      try {
        await attentionFor(ctx, await actorOf('general.manager'));
      } finally {
        (ctx.db as unknown as { execute: typeof orig }).execute = orig;
      }
      return n;
    };
    const before = await count();
    for (let i = 0; i < 4; i++) {
      await ctx.db.insert(t.branches).values({ code: `XT${i}`, name: `Extra ${i}`, nameAr: `فرع إضافي ${i}`, city: 'City' });
    }
    expect(await count()).toBe(before);
    expect(codes(await list('general.manager')).length).toBeGreaterThan(0);
  });
});
