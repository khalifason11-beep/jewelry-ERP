// LBL-2 (docs/plans/LBL-2.md §4–§6, D-lbl2-2…5): a draft opening line's label, printed before the seal (both projects).
//   * who: opening.enter (the branch manager of the branch, the General Manager); the cashier 403; another branch's
//     opening 404; a line of another opening 404;
//   * LBL-1's label: the size must be set (409 LABEL_SIZE_NOT_SET); the line's reserved barcode; copies 1–20;
//   * every print recorded in opening_label_prints (who, when, line, code, copies, FIRST then REPRINT without approval,
//     owner Q4) with one audit entry; an Idempotency-Key retry records nothing twice; append-only, and the trigger;
//   * the review: prints per line, the last one; how many lines are printed (owner Q5: the seal is not refused);
//   * a printed line is removed only with the confirmation (409 OPENING_LINE_LABEL_PRINTED otherwise, owner Q1); the
//     removal is audited; its code is listed as a gap (owner Q2); its prints stay and are in the report;
//   * the seal copies every print into the piece's history with its date and person; the first print after the seal
//     is a REPRINT; after the seal the draft print is 409 OPENING_SEALED; the report lists each print once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { createCategory } from '../src/modules/catalog/service';
import { loadActor } from '../src/modules/sessions/service';
import { labelPrintsOf, printLabels } from '../src/modules/labels/service';
import { printOpeningLineLabel } from '../src/modules/openings/labels';
import { addOpeningLine, createOpening, getOpening, removeOpeningLine } from '../src/modules/openings/service';
import { runReport } from '../src/modules/reports/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, reviewedOf, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gmHttp: ReturnType<typeof request.agent>;
let bmHttp: ReturnType<typeof request.agent>;
const actors: Record<'gm' | 'bmKrt' | 'bmOmd' | 'cashierKrt', Actor> = {} as never;
let gmSession: string;
let branch: Record<string, number>;
let type: { id: number; nameAr: string };
let karat: number;
let krt: number;
const PW = DEMO_PASSWORDS.GENERAL_MANAGER;
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e as { code?: string }).code ?? String(e));
const line = (net: number, description = 'LBL-2 print') => ({ categoryId: type.id, description, karat, condition: 'NEW' as const, grossWeightMg: net + 100, netWeightMg: net });
const draftRows = (lineId: number) => ctx.db.select().from(t.openingLabelPrints).where(eq(t.openingLabelPrints.openingLineId, lineId)).orderBy(asc(t.openingLabelPrints.id));
// After a write the settings cache is empty; on PGlite (one connection) a service that then reads the settings inside
// its own transaction (addOpeningLine → allowedKarats) would wait on that transaction. Reload it at once.
const setSize = async (changes: Record<string, unknown>) => {
  await ctx.db.transaction((tx) => ctx.settings.apply(tx, changes, { actor: { id: actors.gm.userId, username: 'general.manager' } }));
  await ctx.settings.get();
};
async function agent(username: string, role: keyof typeof DEMO_PASSWORDS) {
  const a = withIdempotencyKeys(request.agent(app));
  const r = await a.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  a.set('x-csrf-token', r.body.csrfToken);
  expect((await a.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS[role] })).status).toBe(200);
  return a;
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-11-14T09:00:00Z'), { pricingMode: 'RATE_COMPUTED' });
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gmHttp = await agent('general.manager', 'GENERAL_MANAGER');
  bmHttp = await agent('branch.manager.kh', 'BRANCH_MANAGER');
  for (const [k, username] of Object.entries({ gm: 'general.manager', bmKrt: 'branch.manager.kh', bmOmd: 'branch.manager.omd', cashierKrt: 'cashier.kh.01' })) {
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
    const [s] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.userId, u.id), eq(t.sessions.status, 'ACTIVE'))).orderBy(desc(t.sessions.loginAt)).limit(1);
    actors[k as keyof typeof actors] = (await loadActor(ctx.db, u.id, s?.id ?? null))!;
    if (k === 'gm') gmSession = s.id;
  }
  branch = Object.fromEntries((await ctx.db.select().from(t.branches)).map((x) => [x.code, x.id]));
  type = await createCategory(ctx, actors.gm, { nameAr: '[اختبار] خاتم ملصق LBL-2', name: '[Test] LBL-2 label ring' });
  karat = (await ctx.settings.get()).inventory.allowedKarats[0];
  krt = (await createOpening(ctx, actors.gm, { branchId: branch.KRT })).id;
}, 120_000);
afterAll(async () => handle?.close());

describe('the label of a draft line (before the seal)', () => {
  it('refused until the label size is set (409 LABEL_SIZE_NOT_SET); nothing recorded', async () => {
    const l = await addOpeningLine(ctx, actors.bmKrt, krt, line(2_000));
    expect(await code(printOpeningLineLabel(ctx, actors.bmKrt, krt, l.id, { copies: 1 }))).toBe('LABEL_SIZE_NOT_SET');
    expect(await draftRows(l.id)).toEqual([]);
    await setSize({ 'print.labelWidthMm': 40, 'print.labelHeightMm': 12 });
  });

  it('who: the branch manager of the branch and the General Manager; the cashier 403; another branch 404; copies 1–20', async () => {
    const [l] = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, krt)).orderBy(asc(t.openingLines.lineNo)).limit(1);
    expect(await code(printOpeningLineLabel(ctx, actors.cashierKrt, krt, l.id, { copies: 1 }))).toBe('FORBIDDEN');
    expect(await code(printOpeningLineLabel(ctx, actors.bmOmd, krt, l.id, { copies: 1 }))).toBe('NOT_FOUND');
    for (const copies of [0, 21, 1.5]) expect(await code(printOpeningLineLabel(ctx, actors.bmKrt, krt, l.id, { copies }))).toBe('BAD_REQUEST');
    const omd = (await createOpening(ctx, actors.gm, { branchId: branch.OMD })).id;
    const other = await addOpeningLine(ctx, actors.gm, omd, line(1_000, 'OMD line'));
    expect(await code(printOpeningLineLabel(ctx, actors.bmKrt, krt, other.id, { copies: 1 }))).toBe('NOT_FOUND'); // a line of another opening
    expect(await draftRows(l.id)).toEqual([]);
    expect(await draftRows(other.id)).toEqual([]);
  });

  it('FIRST, then REPRINT without approval; each recorded with who, when, line, code, copies; one audit entry each', async () => {
    // A second line, never printed: the counts below must tell the two apart.
    const unprinted = await addOpeningLine(ctx, actors.bmKrt, krt, line(2_200, 'never printed here'));
    const [l] = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, krt)).orderBy(asc(t.openingLines.lineNo)).limit(1);
    const first = await printOpeningLineLabel(ctx, actors.bmKrt, krt, l.id, { copies: 3 }, { at: new Date('2026-11-14T10:00:00Z') });
    expect(first.size).toEqual({ widthMm: 40, heightMm: 12, marginMm: 1 });
    expect(first.labels).toEqual([{ lineId: l.id, lineNo: l.lineNo, code: l.reservedCode, barcode: l.reservedBarcode, copies: 3, kind: 'FIRST' }]);
    expect(l.reservedBarcode).toMatch(/^\d{12}$/);
    const again = await printOpeningLineLabel(ctx, actors.bmKrt, krt, l.id, { copies: 20 }, { at: new Date('2026-11-14T10:05:00Z') });
    expect(again.labels[0].kind).toBe('REPRINT');
    const rows = await draftRows(l.id);
    expect(rows.map((r) => [r.kind, r.copies, r.code, r.barcode, r.lineNo, r.branchId, r.printedBy, r.createdAt.toISOString()])).toEqual([
      ['FIRST', 3, l.reservedCode, l.reservedBarcode, l.lineNo, branch.KRT, actors.bmKrt.userId, '2026-11-14T10:00:00.000Z'],
      ['REPRINT', 20, l.reservedCode, l.reservedBarcode, l.lineNo, branch.KRT, actors.bmKrt.userId, '2026-11-14T10:05:00.000Z'],
    ]);
    const audits = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'LABELS_PRINTED'), sql`${t.auditLogs.entityId} IN (${first.batchId}, ${again.batchId})`)).orderBy(asc(t.auditLogs.id));
    expect(audits.map((a) => a.metadata)).toEqual([
      { source: 'OPENING_DRAFT', openingId: krt, pieces: [{ code: l.reservedCode, lineNo: l.lineNo, copies: 3, kind: 'FIRST' }] },
      { source: 'OPENING_DRAFT', openingId: krt, pieces: [{ code: l.reservedCode, lineNo: l.lineNo, copies: 20, kind: 'REPRINT' }] },
    ]);
    // The review: two prints on the line, the last one's time; one line of the draft printed (the seal is not refused
    // for the others, owner Q5).
    const o = await getOpening(ctx, actors.bmKrt, krt);
    const row = o.lines.rows.find((r) => r.id === l.id)!;
    expect([row.labelPrints, new Date(row.lastPrintedAt!).toISOString()]).toEqual([2, '2026-11-14T10:05:00.000Z']);
    expect(o.lines.rows.find((r) => r.id === unprinted.id)?.labelPrints).toBe(0);
    expect(o.summary.total.count).toBeGreaterThanOrEqual(2);
    expect(o.summary.labels).toEqual({ lines: o.summary.total.count, printed: 1 });
  });

  it('over HTTP with an Idempotency-Key: a retry answers the same and records nothing twice', async () => {
    const l = await addOpeningLine(ctx, actors.bmKrt, krt, line(2_500, 'idempotent'));
    const key = randomUUID();
    const a = await bmHttp.post(`/api/openings/${krt}/lines/${l.id}/label`).set('Idempotency-Key', key).send({ copies: 2 });
    const b = await bmHttp.post(`/api/openings/${krt}/lines/${l.id}/label`).set('Idempotency-Key', key).send({ copies: 2 });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect((await draftRows(l.id)).length).toBe(1);
    expect((await bmHttp.post(`/api/openings/${krt}/lines/${l.id}/label`).send({ copies: 21 })).status).toBe(400);
  });

  it('append-only, and the trigger: no UPDATE or DELETE; no second FIRST of a code; a code not on the line is refused', async () => {
    const [l] = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, krt)).orderBy(asc(t.openingLines.lineNo)).limit(1);
    const refused = (q: ReturnType<typeof sql>) => ctx.db.execute(q).then(() => false, () => true);
    expect(await refused(sql`UPDATE opening_label_prints SET copies = 1`)).toBe(true);
    expect(await refused(sql`DELETE FROM opening_label_prints`)).toBe(true);
    const ins = (kind: string, codeValue: string) =>
      sql`INSERT INTO opening_label_prints (opening_id, opening_line_id, line_no, code, barcode, branch_id, copies, kind, batch_id, printed_by)
          VALUES (${krt}, ${l.id}, ${l.lineNo}, ${codeValue}, ${l.reservedBarcode}, ${branch.KRT}, 1, ${kind}, 'b', ${actors.gm.userId})`;
    expect(await refused(ins('FIRST', l.reservedCode!))).toBe(true);
    expect(await refused(ins('REPRINT', 'J-1'))).toBe(true);
    expect(await refused(sql`INSERT INTO opening_label_prints (opening_id, opening_line_id, line_no, code, barcode, branch_id, copies, kind, batch_id, printed_by)
      VALUES (${krt}, ${l.id}, ${l.lineNo}, ${l.reservedCode}, ${l.reservedBarcode}, ${branch.OMD}, 1, 'REPRINT', 'b', ${actors.gm.userId})`)).toBe(true); // another branch
  });
});

let victim: Awaited<ReturnType<typeof addOpeningLine>>;
describe('removing a printed line (owner Q1, Q2)', () => {
  it('refused without the confirmation (409 OPENING_LINE_LABEL_PRINTED, with the code); with it, removed and audited', async () => {
    victim = await addOpeningLine(ctx, actors.bmKrt, krt, line(1_200, 'printed then removed'));
    await printOpeningLineLabel(ctx, actors.bmKrt, krt, victim.id, { copies: 1 });
    const e = (await removeOpeningLine(ctx, actors.bmKrt, krt, victim.id).then(() => null, (x) => x)) as { status: number; code: string; details: unknown };
    expect([e.status, e.code, e.details]).toEqual([409, 'OPENING_LINE_LABEL_PRINTED', { code: victim.code, labelPrints: 1 }]);
    expect((await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.id, victim.id))).length).toBe(1);
    // Over HTTP: the same refusal, then the confirmation.
    const http = await bmHttp.post(`/api/openings/${krt}/lines/${victim.id}/remove`).send({});
    expect([http.status, http.body.error.code]).toEqual([409, 'OPENING_LINE_LABEL_PRINTED']);
    const ok = await bmHttp.post(`/api/openings/${krt}/lines/${victim.id}/remove`).send({ confirmLabelPrinted: true });
    expect([ok.status, ok.body.removedCode]).toEqual([200, victim.code]);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'OPENING_LINE_REMOVED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit.metadata).toMatchObject({ line: { code: victim.code, labelPrints: 1 }, confirmedLabelPrinted: true });
    // An unprinted line needs no confirmation.
    const plain = await addOpeningLine(ctx, actors.bmKrt, krt, line(1_300, 'never printed'));
    expect(await code(removeOpeningLine(ctx, actors.bmKrt, krt, plain.id))).toBe('OK');
  });

  it('the removed codes are listed (the gaps), printed or not; the prints stay; a removed line cannot be printed', async () => {
    const o = await getOpening(ctx, actors.gm, krt);
    const removed = o.removedCodes.map((r) => [r.code, r.labelPrinted, r.removedByName]);
    expect(removed).toEqual(expect.arrayContaining([[victim.code, true, expect.any(String)]]));
    expect(o.removedCodes.map((r) => Number(r.code.slice(2)))).toEqual([...o.removedCodes.map((r) => Number(r.code.slice(2)))].sort((a, b) => a - b));
    expect(o.removedCodes.filter((r) => !r.labelPrinted).length).toBe(1);
    expect((await draftRows(victim.id)).length).toBe(1);
    expect(await code(printOpeningLineLabel(ctx, actors.bmKrt, krt, victim.id, { copies: 1 }))).toBe('NOT_FOUND');
    const rep = (await runReport(ctx, actors.gm, 'label-prints', { from: '2000-01-01', to: '2100-01-01' })) as unknown as { rows: { itemCode: string; source: string; itemId: number | null }[] };
    expect(rep.rows.filter((r) => r.itemCode === victim.code)).toEqual([expect.objectContaining({ source: 'OPENING_DRAFT', itemId: null })]);
  });
});

describe('the seal copies the prints into the piece history', () => {
  it('every print with its date and person, in order; the next print is a REPRINT; the draft print is closed; the report lists each once', async () => {
    const printed = await ctx.db.select().from(t.openingLabelPrints).where(eq(t.openingLabelPrints.openingId, krt)).orderBy(asc(t.openingLabelPrints.id));
    const kept = printed.filter((p) => p.openingLineId !== victim.id);
    await ctx.db.insert(t.webauthnCredentials).values({ userId: actors.gm.userId, credentialId: randomUUID(), publicKey: 'test-key', nickname: 'Test key', uvAtRegistration: true });
    await ctx.db.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: true }).where(eq(t.sessions.id, gmSession));
    const res = await gmHttp.post(`/api/openings/${krt}/seal`).send({ confirmPassword: PW, ...(await reviewedOf(ctx.db, krt)) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.labelsCopied).toBe(kept.length);
    // The first line: its two prints, with their dates and person, as the piece's history.
    const [first] = await ctx.db.select().from(t.openingLines).where(eq(t.openingLines.openingId, krt)).orderBy(asc(t.openingLines.lineNo)).limit(1);
    const history = await labelPrintsOf(ctx, actors.bmKrt, first.itemId!);
    expect(history.map((h) => [h.kind, h.copies, h.source, new Date(h.createdAt).toISOString()])).toEqual([
      ['REPRINT', 20, 'OPENING', '2026-11-14T10:05:00.000Z'],
      ['FIRST', 3, 'OPENING', '2026-11-14T10:00:00.000Z'],
    ]);
    const copies = await ctx.db.select().from(t.labelPrints).where(sql`${t.labelPrints.draftPrintId} IS NOT NULL`).orderBy(asc(t.labelPrints.id));
    expect(copies.map((c) => [c.draftPrintId, c.kind, c.copies, c.printedBy, c.createdAt.toISOString(), c.batchId])).toEqual(kept.map((p) => [p.id, p.kind, p.copies, p.printedBy, p.createdAt.toISOString(), p.batchId]));
    // After the seal: LBL-1 works unchanged; the piece was printed already, so the next print is a REPRINT.
    const after = await printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: first.itemId!, copies: 1 }], source: 'PIECE' });
    expect(after.labels[0]).toMatchObject({ code: first.reservedCode, barcode: first.reservedBarcode, kind: 'REPRINT' });
    expect(await code(printOpeningLineLabel(ctx, actors.bmKrt, krt, first.id, { copies: 1 }))).toBe('OPENING_SEALED');
    // The sealed opening still lists the removed codes (a reviewer can explain the gaps).
    expect((await getOpening(ctx, actors.gm, krt)).removedCodes.map((r) => r.code)).toContain(victim.code);
    // The report: each draft print once, as the piece's (OPENING) once copied; the removed line's as OPENING_DRAFT.
    const rep = (await runReport(ctx, actors.gm, 'label-prints', { from: '2000-01-01', to: '2100-01-01' })) as unknown as { rows: { itemCode: string; source: string; kind: string }[] };
    const ofFirst = rep.rows.filter((r) => r.itemCode === first.reservedCode);
    expect(ofFirst.map((r) => [r.source, r.kind])).toEqual([['PIECE', 'REPRINT'], ['OPENING', 'REPRINT'], ['OPENING', 'FIRST']]);
    expect(rep.rows.filter((r) => r.source === 'OPENING_DRAFT').map((r) => r.itemCode)).toEqual([victim.code]);
  });
});
