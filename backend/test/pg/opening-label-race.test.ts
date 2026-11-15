// Real PostgreSQL only (LBL-2, docs/plans/LBL-2.md §3.3 and §8): codes and labels of a draft opening at the same time.
//   * two people adding lines to one draft, a line in another draft, an import and another piece numbered at once:
//     every code distinct, every barcode its code's, none lost (the counter moved by exactly the numbers handed out);
//   * a label print racing the removal of the same line: either the print is recorded and the removal (without the
//     confirmation) is refused 409 OPENING_LINE_LABEL_PRINTED, or the removal wins and the print is 404; never a print
//     of a removed line;
//   * the seal racing a label print: either the print is recorded first and the seal copies it into the piece's
//     history, or the seal wins and the print is refused 409 OPENING_SEALED; never a draft print left uncopied.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Actor, Ctx } from '../../src/core/context';
import { nextItemCode } from '../../src/core/numbering';
import { loadActor } from '../../src/modules/sessions/service';
import { createCategory } from '../../src/modules/catalog/service';
import { createUser } from '../../src/modules/users/service';
import { addOpeningLine, createOpening, importOpeningCsv, removeOpeningLine, sealOpening } from '../../src/modules/openings/service';
import { printOpeningLineLabel } from '../../src/modules/openings/labels';
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
const counter = async () => Number((await ctx.db.select({ n: t.documentSequences.next }).from(t.documentSequences).where(eq(t.documentSequences.scope, 'ITEM')))[0].n);
let n = 0;
/** A new branch with its draft opening and its own branch manager. */
async function branchWithManager() {
  n += 1;
  const [b] = await ctx.db.insert(t.branches).values({ code: `LB${n}`, name: `Label race ${n}`, nameAr: `[اختبار] سباق الملصق ${n}`, city: 'X' }).returning();
  const u = await createUser(ctx, gm, { username: `lbl2.race.${n}`, fullName: `[Test] Label manager ${n}`, roleCode: 'BRANCH_MANAGER', branchId: b.id });
  const bm = (await loadActor(ctx.db, u.id, null))!;
  const opening = (await createOpening(ctx, gm, { branchId: b.id })).id;
  return { bm, opening };
}
const line = (net: number, description: string) => ({ categoryId: type.id, description, karat: k, condition: 'NEW' as const, grossWeightMg: net + 100, netWeightMg: net });

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-11-14T09:00:00Z'), { pricingMode: 'RATE_COMPUTED' });
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  expect((await request(app).post('/api/auth/login').send({ username: 'general.manager', password: PW })).status).toBe(200);
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
  const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
  gmSession = s.id;
  gm = (await loadActor(ctx.db, u.id, s.id))!;
  await ctx.db.insert(t.webauthnCredentials).values({ userId: u.id, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
  type = await createCategory(ctx, gm, { nameAr: '[اختبار] سباق الملصق', name: '[Test] Label race' });
  k = (await ctx.settings.get()).inventory.allowedKarats[0];
  await ctx.db.transaction((tx) => ctx.settings.apply(tx, { 'print.labelWidthMm': 40, 'print.labelHeightMm': 12 }, { actor: { id: gm.userId, username: 'general.manager' } }));
}, 120_000);
afterAll(async () => handle?.close());

describe('codes and labels of a draft at the same time', () => {
  it('two people, another draft, an import and another piece at once: every code distinct, none lost', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await branchWithManager();
      const b = await branchWithManager();
      const before = await counter();
      const csv = Buffer.from([header, ...[1, 2, 3].map((i) => `${type.nameAr},file ${round}-${i},${k},جديد,1.100,1.000`)].join('\r\n') + '\r\n', 'utf8');
      const rs = await Promise.allSettled([
        addOpeningLine(ctx, a.bm, a.opening, line(2_000, `bm ${round}`)),
        addOpeningLine(ctx, gm, a.opening, line(3_000, `gm ${round}`)),
        importOpeningCsv(ctx, a.bm, a.opening, { fileName: `race-${round}.csv`, bytes: csv }),
        addOpeningLine(ctx, b.bm, b.opening, line(4_000, `other ${round}`)),
        ctx.db.transaction((tx) => nextItemCode(tx)),
      ]);
      expect(rs.map(codeOf), `round ${round}`).toEqual(['OK', 'OK', 'OK', 'OK', 'OK']);
      const lines = await ctx.db
        .select({ code: t.openingLines.reservedCode, barcode: t.openingLines.reservedBarcode, importId: t.openingLines.importId, lineNo: t.openingLines.lineNo })
        .from(t.openingLines)
        .where(sql`${t.openingLines.openingId} IN (${a.opening}, ${b.opening})`)
        .orderBy(asc(t.openingLines.id));
      const other = (rs[4] as PromiseFulfilledResult<{ code: string }>).value.code;
      const nums = [...lines.map((l) => Number(l.code!.slice(2))), Number(other.slice(2))].sort((x, y) => x - y);
      // 7 numbers handed out, exactly the counter's move, no duplicate and no hole.
      expect(nums).toEqual(Array.from({ length: 7 }, (_, i) => before + i));
      expect(await counter()).toBe(before + 7);
      expect(lines.every((l) => l.barcode === `628100${l.code!.slice(2).padStart(6, '0')}`)).toBe(true);
      // The file's block is consecutive, in file order.
      const file = lines.filter((l) => l.importId != null).sort((x, y) => x.lineNo - y.lineNo).map((l) => Number(l.code!.slice(2)));
      expect(file).toEqual([file[0], file[0] + 1, file[0] + 2]);
    }
  }, 240_000);

  it('a label print racing the removal of the same line: never a print of a removed line', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const { bm, opening } = await branchWithManager();
      const l = await addOpeningLine(ctx, bm, opening, line(1_500, `race ${round}`));
      const [printCode, removeCode] = (await Promise.allSettled([printOpeningLineLabel(ctx, bm, opening, l.id, { copies: 1 }), removeOpeningLine(ctx, gm, opening, l.id)])).map(codeOf);
      const pair = `${printCode}/${removeCode}`;
      outcomes.add(pair);
      expect([pair], `round ${round}`).toEqual([expect.stringMatching(/^(OK\/OPENING_LINE_LABEL_PRINTED|NOT_FOUND\/OK)$/)]);
      const stillThere = (await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.id, l.id))).length === 1;
      const prints = await ctx.db.select().from(t.openingLabelPrints).where(eq(t.openingLabelPrints.openingLineId, l.id));
      expect([stillThere, prints.length], `round ${round}`).toEqual(printCode === 'OK' ? [true, 1] : [false, 0]);
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('the seal racing a label print: never a print before the seal left out of the piece history', async () => {
    for (let round = 0; round < 6; round++) {
      const { bm, opening } = await branchWithManager();
      const l1 = await addOpeningLine(ctx, bm, opening, line(1_000, `seal ${round} a`));
      await addOpeningLine(ctx, bm, opening, line(2_000, `seal ${round} b`));
      const reviewed = await reviewedOf(ctx.db, opening);
      await ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
      const [sealCode, printCode] = (await Promise.allSettled([sealOpening(ctx, gm, opening, { confirmPassword: PW, ...reviewed }), printOpeningLineLabel(ctx, bm, opening, l1.id, { copies: 2 })])).map(codeOf);
      expect([`${sealCode}/${printCode}`], `round ${round}`).toEqual([expect.stringMatching(/^OK\/(OK|OPENING_SEALED)$/)]);
      const drafts = await ctx.db.select().from(t.openingLabelPrints).where(eq(t.openingLabelPrints.openingId, opening));
      const [piece] = await ctx.db.select({ itemId: t.openingLines.itemId }).from(t.openingLines).where(eq(t.openingLines.id, l1.id));
      const history = await ctx.db.select().from(t.labelPrints).where(eq(t.labelPrints.itemId, piece.itemId!));
      if (printCode === 'OK') {
        expect(drafts.length).toBe(1);
        expect(history.map((h) => [h.kind, h.copies, h.draftPrintId, h.printedBy])).toEqual([['FIRST', 2, drafts[0].id, bm.userId]]);
      } else {
        expect([drafts.length, history.length]).toEqual([0, 0]);
      }
    }
  }, 240_000);
});
