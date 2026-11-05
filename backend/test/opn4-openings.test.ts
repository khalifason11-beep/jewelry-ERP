// OPN-4 (plan docs/plans/OPN-4.md, D-opn4-1…4): the branch manager enters the pieces of the own branch's opening (both
// projects).
//   * Every opening route × role: the General Manager; the branch manager of the branch; the branch manager of another
//     branch; the cashier; and a branch manager whose `opening.enter` grant was taken away (the "role without it").
//     Entry routes: 200 for the own branch; 404 for another branch's opening (read and write); 403 without the
//     permission. Start, seal, broken scrap and corrections: 403 for everyone but the General Manager.
//   * Who entered what: `enteredByName` / `enteredAt` on typed and imported lines; `byUser` adds up to the totals. A
//     branch manager may remove a line the General Manager typed (owner Q-a), audited.
//   * The seal (D-opn4-4): without the reviewed numbers 400; with stale ones 409 OPENING_CHANGED_SINCE_REVIEW and nothing
//     sealed; with the right ones sealed. A sealed opening is read-only for everyone, readable by its branch manager (Q-f).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { createCategory } from '../src/modules/catalog/service';
import { loadActor } from '../src/modules/sessions/service';
import { createOpening } from '../src/modules/openings/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

type Agent = ReturnType<typeof request.agent>;
let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
const ag: Record<'gm' | 'bmKrt' | 'bmOmd' | 'cashier', Agent> = {} as never;
let branch: Record<string, number>;
let krtOpening: number;
let omdOpening: number;
let type: { id: number; nameAr: string };
let karat: number;
let gmSession: string;
let gmUserId: number;
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const header = 'النوع / Type,الوصف / Description,العيار / Karat,الحالة / Condition,الوزن القائم (جم) / Gross weight (g),الوزن الصافي (جم) / Net weight (g)';
const sheet = (rows: string[]) => [header, ...rows].join('\r\n') + '\r\n';
const line = (net: number, description = 'OPN-4 line') => ({ categoryId: type.id, description, karat, condition: 'NEW', grossWeightMg: net + 100, netWeightMg: net });

async function login(username: string, role: keyof typeof DEMO_PASSWORDS) {
  const a = withIdempotencyKeys(request.agent(app));
  const r = await a.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  a.set('x-csrf-token', r.body.csrfToken);
  expect((await a.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS[role] })).status).toBe(200);
  return a;
}
/** Every opening route, for one opening: [label, request]. */
const routes = (id: number, lineId = 999_999) => ({
  entry: [
    ['GET /openings/:id', (a: Agent) => a.get(`/api/openings/${id}`)],
    ['GET /openings/:id/export', (a: Agent) => a.get(`/api/openings/${id}/export`)],
    ['POST /openings/:id/lines', (a: Agent) => a.post(`/api/openings/${id}/lines`).send(line(1_000, 'probe'))],
    ['POST /openings/:id/lines/:lineId/remove', (a: Agent) => a.post(`/api/openings/${id}/lines/${lineId}/remove`).send({})],
    ['POST /openings/:id/import', (a: Agent) => a.post(`/api/openings/${id}/import?fileName=probe.csv`).set('Content-Type', 'text/csv').send(sheet([`${type.nameAr},probe file ${randomUUID()},${karat},جديد,1.100,1.000`]))],
  ] as const,
  gmOnly: [
    ['POST /openings', (a: Agent) => a.post('/api/openings').send({ branchId: branch.PZU })],
    ['POST /openings/:id/seal', (a: Agent) => a.post(`/api/openings/${id}/seal`).send({ confirmPassword: 'x', expectedLines: 0, expectedNetWeightMg: 0 })],
    ['POST /openings/:id/scrap-lines', (a: Agent) => a.post(`/api/openings/${id}/scrap-lines`).send({ karat: 21, weightMg: 1_000 })],
    ['POST /openings/:id/scrap-lines/:lineId', (a: Agent) => a.post(`/api/openings/${id}/scrap-lines/${lineId}`).send({ karat: 21, weightMg: 1_000 })],
    ['POST /openings/:id/scrap-lines/:lineId/remove', (a: Agent) => a.post(`/api/openings/${id}/scrap-lines/${lineId}/remove`).send({})],
    ['POST /openings/:id/scrap-corrections', (a: Agent) => a.post(`/api/openings/${id}/scrap-corrections`).send({ changes: [{ karat: 21, weightMgChange: -1 }], reason: 'probe' })],
    ['POST /openings/:id/pieces/:itemId/correction', (a: Agent) => a.post(`/api/openings/${id}/pieces/${lineId}/correction`).send({ action: 'VOID', reason: 'probe' })],
    ['GET /openings/:id/pieces/:itemId/correction-preview', (a: Agent) => a.get(`/api/openings/${id}/pieces/${lineId}/correction-preview?action=VOID`)],
  ] as const,
});
const lineCount = async (id: number) => (await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, id))).length;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-10-20T09:00:00Z'), { pricingMode: 'RATE_COMPUTED' });
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  branch = Object.fromEntries((await ctx.db.select().from(t.branches)).map((b) => [b.code, b.id]));
  ag.gm = await login('general.manager', 'GENERAL_MANAGER');
  ag.bmKrt = await login('branch.manager.kh', 'BRANCH_MANAGER');
  ag.bmOmd = await login('branch.manager.omd', 'BRANCH_MANAGER');
  ag.cashier = await login('cashier.kh.01', 'CASHIER');
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  gmUserId = u.id;
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gmSession = s.id;
  const gm = (await loadActor(ctx.db, u.id, s.id))!;
  type = await createCategory(ctx, gm, { nameAr: '[اختبار] خاتم OPN-4', name: '[Test] OPN-4 ring' });
  karat = (await ctx.settings.get()).inventory.allowedKarats[0];
  for (const code of ['KRT', 'OMD']) {
    const [existing] = await ctx.db.select().from(t.openings).where(eq(t.openings.branchId, branch[code]));
    if (existing) throw new Error(`the fixture world already has an opening for ${code}`);
  }
  krtOpening = (await createOpening(ctx, gm, { branchId: branch.KRT })).id;
  omdOpening = (await createOpening(ctx, gm, { branchId: branch.OMD })).id;
}, 120_000);
afterAll(async () => handle?.close());

describe('every opening route × role (D-opn4-1, D-opn4-2)', () => {
  it('the list: the General Manager every branch, a branch manager the own branch only, the cashier 403', async () => {
    const ids = async (a: Agent) => ((await a.get('/api/openings')).body.branches as { branchId: number }[]).map((b) => b.branchId);
    expect(await ids(ag.gm)).toEqual(expect.arrayContaining([branch.KRT, branch.OMD, branch.BHR]));
    expect(await ids(ag.bmKrt)).toEqual([branch.KRT]);
    expect(await ids(ag.bmOmd)).toEqual([branch.OMD]);
    expect((await ag.cashier.get('/api/openings')).status).toBe(403);
    expect((await ag.bmKrt.get('/api/openings/template.csv')).status).toBe(200);
    expect((await ag.cashier.get('/api/openings/template.csv')).status).toBe(403);
  });

  it('entry routes: 200 for the own branch, 404 for another branch (read and write), 403 for the cashier', async () => {
    const before = { krt: await lineCount(krtOpening), omd: await lineCount(omdOpening) };
    for (const [label, call] of routes(omdOpening).entry) {
      const res = await call(ag.bmKrt);
      expect([res.status, res.body?.error?.code], `branch manager of KRT on OMD: ${label}`).toEqual([404, 'NOT_FOUND']);
      expect((await call(ag.cashier)).status, `cashier: ${label}`).toBe(403);
    }
    expect({ krt: await lineCount(krtOpening), omd: await lineCount(omdOpening) }).toEqual(before);
    // The own branch (the remove of a missing line is the only 404 here: the line, not the opening).
    for (const [label, call] of routes(krtOpening).entry) {
      const res = await call(ag.bmKrt);
      if (label === 'POST /openings/:id/lines/:lineId/remove') expect([res.status, res.body?.error?.key], label).toEqual([404, 'Opening line not found']);
      else expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
    }
    expect(await lineCount(krtOpening)).toBe(before.krt + 2); // one typed, one imported
  });

  it('start, seal, broken scrap and corrections: 403 for every role but the General Manager', async () => {
    for (const [label, call] of routes(krtOpening).gmOnly) {
      for (const who of ['bmKrt', 'bmOmd', 'cashier'] as const) {
        const res = await call(ag[who]);
        expect(res.status, `${who}: ${label} ${JSON.stringify(res.body).slice(0, 160)}`).toBe(403);
      }
    }
  });

  it('a branch manager without opening.enter (the grant taken away): 403 on every entry route', async () => {
    const [bm] = await ctx.db.select().from(t.roles).where(eq(t.roles.code, 'BRANCH_MANAGER'));
    await ctx.db.delete(t.rolePermissions).where(and(eq(t.rolePermissions.roleId, bm.id), eq(t.rolePermissions.permissionCode, 'opening.enter')));
    try {
      expect((await ag.bmKrt.get('/api/openings')).status).toBe(403);
      for (const [label, call] of routes(krtOpening).entry) expect((await call(ag.bmKrt)).status, label).toBe(403);
    } finally {
      await ctx.db.insert(t.rolePermissions).values({ roleId: bm.id, permissionCode: 'opening.enter' });
    }
    expect((await ag.bmKrt.get('/api/openings')).status).toBe(200);
  });
});

describe('who entered what, and the seal (D-opn4-3, D-opn4-4)', () => {
  it('entered by: typed and imported lines carry their author; byUser adds up; a branch manager removes a GM line, audited', async () => {
    const gmLine = (await ag.gm.post(`/api/openings/${krtOpening}/lines`).send(line(2_000, 'typed by the GM'))).body;
    expect((await ag.bmKrt.post(`/api/openings/${krtOpening}/lines`).send(line(3_000, 'typed by the manager'))).status).toBe(200);
    const imported = await ag.bmKrt.post(`/api/openings/${krtOpening}/import?fileName=bm.csv`).set('Content-Type', 'text/csv').send(sheet([`${type.nameAr},from the file A,${karat},جديد,1.600,1.500`, `${type.nameAr},from the file B,${karat},مستعمل,2.600,2.500`]));
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    const o = (await ag.gm.get(`/api/openings/${krtOpening}`).query({ pageSize: 200 })).body;
    const by = (d: string) => o.lines.rows.find((r: { description: string }) => r.description === d);
    const [gmUser] = await ctx.db.select().from(t.users).where(eq(t.users.id, gmUserId));
    expect([by('typed by the GM').enteredByName, by('typed by the GM').source]).toEqual([gmUser.fullName, 'KEYBOARD']);
    expect([by('typed by the manager').source, by('from the file B').source]).toEqual(['KEYBOARD', 'IMPORT']);
    const [bmUser] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'branch.manager.kh'));
    expect(by('from the file A').enteredByName).toBe(bmUser.fullName);
    expect(Number.isNaN(Date.parse(by('from the file A').enteredAt))).toBe(false);
    const byUser = o.summary.byUser as { userId: number; count: number; netWeightMg: number }[];
    expect(byUser.reduce((s, u) => s + u.count, 0)).toBe(o.summary.total.count);
    expect(byUser.reduce((s, u) => s + u.netWeightMg, 0)).toBe(o.summary.total.netWeightMg);
    expect(byUser.find((u) => u.userId === gmUserId)?.count).toBeGreaterThanOrEqual(1);
    // Owner Q-a: the branch manager removes the line the General Manager typed; the audit says who.
    expect((await ag.bmKrt.post(`/api/openings/${krtOpening}/lines/${gmLine.id}/remove`).send({})).status).toBe(200);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'OPENING_LINE_REMOVED'), eq(t.auditLogs.entityId, String(krtOpening)))).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.userId).toBe(bmUser.id);
  });

  it('the seal checks what the General Manager reviewed: missing 400; stale 409 and nothing sealed; right numbers sealed', async () => {
    await ctx.db.insert(t.webauthnCredentials).values({ userId: gmUserId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
    await ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
    const reviewed = (await ag.gm.get(`/api/openings/${krtOpening}`)).body.summary.total;
    const missing = await ag.gm.post(`/api/openings/${krtOpening}/seal`).send({ confirmPassword: PW });
    expect([missing.status, missing.body.error.key]).toEqual([400, 'Review the opening before sealing: send the number of pieces and the net weight you reviewed']);
    // A line typed by the branch manager after the review.
    expect((await ag.bmKrt.post(`/api/openings/${krtOpening}/lines`).send(line(4_000, 'after the review'))).status).toBe(200);
    const stale = await ag.gm.post(`/api/openings/${krtOpening}/seal`).send({ confirmPassword: PW, expectedLines: reviewed.count, expectedNetWeightMg: reviewed.netWeightMg });
    expect([stale.status, stale.body.error.code, stale.body.error.details]).toEqual([409, 'OPENING_CHANGED_SINCE_REVIEW', { lines: reviewed.count + 1, netWeightMg: reviewed.netWeightMg + 4_000 }]);
    expect((await ctx.db.select().from(t.openings).where(eq(t.openings.id, krtOpening)))[0].status).toBe('DRAFT');
    const now = (await ag.gm.get(`/api/openings/${krtOpening}`)).body.summary.total;
    const sealed = await ag.gm.post(`/api/openings/${krtOpening}/seal`).send({ confirmPassword: PW, expectedLines: now.count, expectedNetWeightMg: now.netWeightMg });
    expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
    expect(sealed.body.pieces).toBe(now.count);
  });

  it('a sealed opening: readable by its branch manager (Q-f), read-only for everyone (409 OPENING_SEALED)', async () => {
    const view = await ag.bmKrt.get(`/api/openings/${krtOpening}`);
    expect([view.status, view.body.status]).toEqual([200, 'SEALED']);
    const [anyLine] = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, krtOpening)).orderBy(t.openingLines.id).limit(1);
    for (const a of [ag.bmKrt, ag.gm]) {
      expect((await a.post(`/api/openings/${krtOpening}/lines`).send(line(1_000, 'too late'))).body.error.code).toBe('OPENING_SEALED');
      expect((await a.post(`/api/openings/${krtOpening}/lines/${anyLine.id}/remove`).send({})).body.error.code).toBe('OPENING_SEALED');
      const late = await a.post(`/api/openings/${krtOpening}/import?fileName=late.csv`).set('Content-Type', 'text/csv').send(sheet([`${type.nameAr},late ${randomUUID()},${karat},جديد,1.100,1.000`]));
      expect(late.body.error.code).toBe('OPENING_SEALED');
    }
    expect((await ag.bmOmd.get(`/api/openings/${krtOpening}`)).status).toBe(404);
  });
});
