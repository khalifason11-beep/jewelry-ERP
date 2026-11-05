// Real PostgreSQL only (OPN-4, D-opn4-2, D-opn4-4): several people enter one draft opening at the same time.
//   * a branch manager's lines, the General Manager's lines and a CSV import at once: every line is there, line numbers
//     stay unique and dense (the opening row lock serializes them);
//   * a branch manager's line racing the General Manager's seal with the numbers he reviewed: either the line came
//     first and the seal is refused 409 OPENING_CHANGED_SINCE_REVIEW (nothing sealed), or the seal came first and the
//     line is refused 409 OPENING_SEALED. Never a sealed opening with a piece the General Manager did not review.

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
import { createUser } from '../../src/modules/users/service';
import { addOpeningLine, createOpening, importOpeningCsv, sealOpening } from '../../src/modules/openings/service';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE, reviewedOf } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let gmSession: string;
let type: { id: number; nameAr: string };
let k: number;
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));
const header = 'النوع / Type,الوصف / Description,العيار / Karat,الحالة / Condition,الوزن القائم (جم) / Gross weight (g),الوزن الصافي (جم) / Net weight (g)';
let n = 0;
/** A new branch with its draft opening and its own branch manager (an actor of that branch). */
async function branchWithManager() {
  n += 1;
  const [b] = await ctx.db.insert(t.branches).values({ code: `OE${n}`, name: `Opening entry ${n}`, nameAr: `[اختبار] إدخال ${n}`, city: 'X' }).returning();
  const u = await createUser(ctx, gm, { username: `opn4.race.${n}`, fullName: `[Test] Entry manager ${n}`, roleCode: 'BRANCH_MANAGER', branchId: b.id });
  const bm = (await loadActor(ctx.db, u.id, null))!;
  const opening = (await createOpening(ctx, gm, { branchId: b.id })).id;
  return { branchId: b.id, bm, opening };
}
const line = (net: number, description: string) => ({ categoryId: type.id, description, karat: k, condition: 'NEW' as const, grossWeightMg: net + 100, netWeightMg: net });
const freshPasskey = () => ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-10-20T09:00:00Z'), { pricingMode: 'RATE_COMPUTED' });
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  expect((await request(app).post('/api/auth/login').send({ username: 'general.manager', password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gmSession = s.id;
  gm = (await loadActor(ctx.db, u.id, s.id))!;
  await ctx.db.insert(t.webauthnCredentials).values({ userId: u.id, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  type = await createCategory(ctx, gm, { nameAr: '[اختبار] سباق الإدخال', name: '[Test] Entry race' });
  k = (await ctx.settings.get()).inventory.allowedKarats[0];
}, 120_000);
afterAll(async () => handle?.close());

describe('several people entering one draft', () => {
  it('a branch manager, the General Manager and an import at once: every line there, line numbers unique and dense', async () => {
    for (let round = 0; round < 5; round++) {
      const { bm, opening } = await branchWithManager();
      const csv = Buffer.from([header, ...[1, 2, 3].map((i) => `${type.nameAr},file ${round}-${i},${k},جديد,1.100,1.000`)].join('\r\n') + '\r\n', 'utf8');
      const results = await Promise.allSettled([
        addOpeningLine(ctx, bm, opening, line(2_000, `bm ${round} a`)),
        addOpeningLine(ctx, gm, opening, line(3_000, `gm ${round}`)),
        importOpeningCsv(ctx, bm, opening, { fileName: `race-${round}.csv`, bytes: csv }),
        addOpeningLine(ctx, bm, opening, line(4_000, `bm ${round} b`)),
      ]);
      expect(results.map(codeOf), `round ${round}`).toEqual(['OK', 'OK', 'OK', 'OK']);
      const lines = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, opening)).orderBy(asc(t.openingLines.lineNo));
      expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(lines.filter((l) => l.createdBy === bm.userId).length).toBe(5);
      expect(lines.filter((l) => l.createdBy === gm.userId).length).toBe(1);
    }
  }, 240_000);

  it("a branch manager's line racing the seal: never a sealed piece the General Manager did not review", async () => {
    for (let round = 0; round < 6; round++) {
      const { bm, opening } = await branchWithManager();
      for (const i of [1, 2]) await addOpeningLine(ctx, bm, opening, line(1_000 * i, `before ${round}-${i}`));
      const reviewed = await reviewedOf(ctx.db, opening);
      await freshPasskey();
      const [sealCode, lateCode] = (
        await Promise.allSettled([sealOpening(ctx, gm, opening, { confirmPassword: PW, ...reviewed }), addOpeningLine(ctx, bm, opening, line(5_000, `late ${round}`))])
      ).map(codeOf);
      expect([`${sealCode}/${lateCode}`], `round ${round}`).toEqual([expect.stringMatching(/^(OK\/OPENING_SEALED|OPENING_CHANGED_SINCE_REVIEW\/OK)$/)]);
      const [o] = await ctx.db.select().from(t.openings).where(eq(t.openings.id, opening));
      const pieces = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, opening));
      if (o.status === 'SEALED') {
        expect(pieces.length).toBe(reviewed.expectedLines);
        expect(pieces.every((p) => p.itemId != null)).toBe(true);
      } else {
        expect(pieces.length).toBe(reviewed.expectedLines + 1);
        expect(pieces.every((p) => p.itemId == null)).toBe(true);
      }
    }
  }, 240_000);
});
