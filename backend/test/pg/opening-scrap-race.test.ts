// Real PostgreSQL only (OPN-3, plan docs/plans/OPN-3.md §8): the broken scrap of an opening against everything else that
// writes the same branch's pool, at once.
//   * the seal (one OPENING movement per scrap line) with broken-scrap purchases and a supplier settlement of the same
//     branch: every movement is kept (append-only rows under the pool lock), and the balance of every karat = Σ its
//     movements = sealed lines + purchases − settlements;
//   * draft lines added while the opening is sealed: each either lands before the seal (and is in the pool) or is refused
//     409 OPENING_SEALED; never a line without its pool movement;
//   * a correction and a settlement taking the same karat: both take the pool lock and re-read, so the pool never goes
//     below 0, whichever comes first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createCategory } from '../../src/modules/catalog/service';
import { createOpening, sealOpening } from '../../src/modules/openings/service';
import { addOpeningScrapLine, correctOpeningScrap } from '../../src/modules/openings/scrap';
import { buyScrap, poolBalances } from '../../src/modules/scrap/service';
import { createPurchase } from '../../src/modules/purchases/service';
import { settleWithScrap } from '../../src/modules/supplier-settlements/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let gmSession: string;
let type: { id: number };
let supplierId: number;
let k: number;
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));
let n = 0;
const newBranch = async () => {
  n += 1;
  const [b] = await ctx.db.insert(t.branches).values({ code: `OR${n}`, name: `Opening race ${n}`, nameAr: `[اختبار] سباق ${n}`, city: 'X' }).returning();
  return b.id;
};
const freshPasskey = () => ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
const moves = (branchId: number) => ctx.db.select().from(t.scrapWeightEntries).where(eq(t.scrapWeightEntries.branchId, branchId)).orderBy(asc(t.scrapWeightEntries.id));
const balanceOf = async (branchId: number, karat: number) => (await poolBalances(ctx.db, branchId, karat))[0]?.weightMg ?? 0;
const sumOf = async (branchId: number, karat: number) => (await moves(branchId)).filter((m) => m.karat === karat).reduce((s, m) => s + m.weightMg, 0);
const order = (branchId: number, mg: number) =>
  createPurchase(ctx, gm, { branchId, supplierId, supplierInvoiceNo: `OR-${randomUUID().slice(0, 8)}`, confirmOpenSupplierDebt: true, lines: [{ categoryId: type.id, karat: k, grossWeightMg: mg, netWeightMg: mg, purchaseCost: 1_000_000, makingCost: 0, otherCost: 0 }] });
let ref = 0;
const buy = (branchId: number, mg: number) => {
  ref += 1;
  return buyScrap(ctx, gm, { branchId, kind: 'BROKEN', karat: 21, grossWeightMg: mg, netWeightMg: mg, paymentMethod: 'BANK_TRANSFER', bankReference: `ORACE${ref}X` });
};

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date(), { pricingMode: 'RATE_COMPUTED' });
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  expect((await request(app).post('/api/auth/login').send({ username: 'general.manager', password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gmSession = s.id;
  gm = (await loadActor(ctx.db, u.id, s.id))!;
  await ctx.db.insert(t.webauthnCredentials).values({ userId: u.id, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  type = await createCategory(ctx, gm, { nameAr: '[اختبار] سباق الكسر', name: '[Test] Scrap race' });
  supplierId = (await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1))[0].id;
  k = (await ctx.settings.get()).inventory.allowedKarats[0];
});
afterAll(async () => handle?.close());

describe('the seal and the other writers of the pool, at once', () => {
  it('seal + purchases + a settlement: every movement kept, the balance is the sum of the movements and of the records', async () => {
    for (let round = 0; round < 5; round++) {
      const b = await newBranch();
      const o = (await createOpening(ctx, gm, { branchId: b })).id;
      for (const mg of [10_000, 5_000, 2_500]) await addOpeningScrapLine(ctx, gm, o, { karat: 21, weightMg: mg });
      const po = await order(b, 40_000);
      await freshPasskey();
      const results = await Promise.allSettled([
        sealOpening(ctx, gm, o, { confirmPassword: PW }),
        buy(b, 3_000),
        buy(b, 4_000),
        settleWithScrap(ctx, gm, po.id, { karat: 21, weightMg: 6_000 }),
      ]);
      const [seal, p1, p2, settle] = results.map(codeOf);
      expect([seal, p1, p2], `round ${round}`).toEqual(['OK', 'OK', 'OK']);
      // The settlement either found enough 21K in the pool (after the seal or the purchases) or was refused: never half.
      expect(['OK', 'BAD_REQUEST']).toContain(settle);
      const all = await moves(b);
      expect(all.filter((m) => m.eventType === 'OPENING').map((m) => m.weightMg).sort((x, y) => x - y)).toEqual([2_500, 5_000, 10_000]);
      expect(all.filter((m) => m.eventType === 'SCRAP_PURCHASE').length).toBe(2);
      const settled = settle === 'OK' ? 6_000 : 0;
      expect(all.filter((m) => m.eventType === 'SUPPLIER_SETTLEMENT').map((m) => m.weightMg)).toEqual(settle === 'OK' ? [-6_000] : []);
      expect(await balanceOf(b, 21)).toBe(await sumOf(b, 21));
      expect(await balanceOf(b, 21)).toBe(17_500 + 7_000 - settled);
    }
  }, 240_000);

  it('lines added while the opening is sealed: each lands before the seal (in the pool) or is refused 409 OPENING_SEALED', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const b = await newBranch();
      const o = (await createOpening(ctx, gm, { branchId: b })).id;
      await addOpeningScrapLine(ctx, gm, o, { karat: 21, weightMg: 1_000 });
      await freshPasskey();
      const results = await Promise.allSettled([
        addOpeningScrapLine(ctx, gm, o, { karat: 21, weightMg: 2_000 }),
        sealOpening(ctx, gm, o, { confirmPassword: PW }),
        addOpeningScrapLine(ctx, gm, o, { karat: 18, weightMg: 3_000 }),
      ]);
      expect(codeOf(results[1])).toBe('OK');
      for (const r of [results[0], results[2]]) {
        expect(['OK', 'OPENING_SEALED']).toContain(codeOf(r));
        outcomes.add(codeOf(r));
      }
      const lines = await ctx.db.select().from(t.openingScrapLines).where(eq(t.openingScrapLines.openingId, o)).orderBy(asc(t.openingScrapLines.id));
      const opening = (await moves(b)).filter((m) => m.eventType === 'OPENING');
      expect(opening.map((m) => m.refId).sort((x, y) => x - y)).toEqual(lines.map((l) => l.id));
      expect(lines.length).toBe(1 + [results[0], results[2]].filter((r) => r.status === 'fulfilled').length);
    }
    // The seal's password check is slow, so the adds usually win; at least the allowed outcomes were seen.
    expect([...outcomes].every((x) => ['OK', 'OPENING_SEALED'].includes(x))).toBe(true);
  }, 240_000);

  it('a correction and a settlement taking the same karat: the pool never goes below 0', async () => {
    for (let round = 0; round < 5; round++) {
      const b = await newBranch();
      const o = (await createOpening(ctx, gm, { branchId: b })).id;
      await addOpeningScrapLine(ctx, gm, o, { karat: 21, weightMg: 10_000 });
      await freshPasskey();
      await sealOpening(ctx, gm, o, { confirmPassword: PW });
      const po = await order(b, 40_000);
      await freshPasskey();
      const [c, s] = await Promise.allSettled([
        correctOpeningScrap(ctx, gm, o, { changes: [{ karat: 21, weightMgChange: -7_000 }], reason: 'race test', confirmPassword: PW }),
        settleWithScrap(ctx, gm, po.id, { karat: 21, weightMg: 6_000 }),
      ]);
      const outcome = `${codeOf(c)}/${codeOf(s)}`;
      expect(['OK/BAD_REQUEST', 'SCRAP_POOL_SHORT/OK'], `round ${round}`).toContain(outcome);
      const bal = await balanceOf(b, 21);
      expect(bal).toBe(await sumOf(b, 21));
      expect(bal).toBe(outcome === 'OK/BAD_REQUEST' ? 3_000 : 4_000);
    }
  }, 240_000);
});
