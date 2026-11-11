// LBL-1 (docs/plans/LBL-1.md, D-lbl1-1, D-lbl1-3): printing labels is recorded (both projects).
//   * who: opening.enter (the branch manager of the branch, the General Manager); the cashier is refused (403); a
//     branch manager gets 404 for another branch's piece; the General Manager prints any branch's;
//   * the label size must be set (409 LABEL_SIZE_NOT_SET) and fit the piece's barcode (409 LABEL_TOO_SMALL);
//   * every print writes one append-only row per piece in the same transaction: who, when, which piece, copies, and
//     FIRST (never printed before) or REPRINT; one audit entry per print request;
//   * copies: 1–20 for one piece, 1–5 per piece in a batch; the same piece twice is refused;
//   * an Idempotency-Key retry records nothing twice;
//   * the piece's print history (newest first, who, when, copies, first or reprint), with the same scope;
//   * append-only: no UPDATE, DELETE; a second FIRST of a piece and a REPRINT of a never-printed piece are refused.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { labelPrintsOf, printLabels } from '../src/modules/labels/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
const actors: Record<string, Actor> = {};
const pieces: Record<string, { id: number; code: string; barcode: string }[]> = {};
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e as { code?: string }).code ?? String(e));
const rowsOf = async (itemId: number) => ctx.db.select().from(t.labelPrints).where(eq(t.labelPrints.itemId, itemId)).orderBy(asc(t.labelPrints.id));
const setSize = (changes: Record<string, unknown>) => ctx.db.transaction((tx) => ctx.settings.apply(tx, changes, { actor: { id: actors.gm.userId, username: 'general.manager' } }));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-11-10T09:00:00Z'));
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  for (const [k, username] of Object.entries({ gm: 'general.manager', bmKrt: 'branch.manager.kh', cashierKrt: 'cashier.kh.01', bmOmd: 'branch.manager.omd' })) {
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
    actors[k] = (await loadActor(ctx.db, u.id, null))!;
  }
  for (const b of ['KRT', 'OMD']) {
    const [br] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, b));
    pieces[b] = await ctx.db
      .select({ id: t.jewelryItems.id, code: t.jewelryItems.code, barcode: t.jewelryItems.barcode })
      .from(t.jewelryItems)
      .where(and(eq(t.jewelryItems.branchId, br.id), eq(t.jewelryItems.status, 'AVAILABLE')))
      .orderBy(asc(t.jewelryItems.id))
      .limit(8);
  }
}, 120_000);
afterAll(async () => handle?.close());

describe('printing labels', () => {
  it('refused until the General Manager sets the label size (409 LABEL_SIZE_NOT_SET); nothing recorded', async () => {
    const p = pieces.KRT[0];
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: p.id, copies: 1 }], source: 'PIECE' }))).toBe('LABEL_SIZE_NOT_SET');
    expect(await rowsOf(p.id)).toEqual([]);
    await setSize({ 'print.labelWidthMm': 40, 'print.labelHeightMm': 12 });
  });

  it('the branch manager prints a piece of the branch: the barcode and the size handed out, FIRST recorded, then REPRINT', async () => {
    const p = pieces.KRT[0];
    const r = await printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: p.id, copies: 3 }], source: 'PIECE' });
    expect(r.size).toEqual({ widthMm: 40, heightMm: 12, marginMm: 1 });
    expect(r.labels).toEqual([{ itemId: p.id, code: p.code, barcode: p.barcode, copies: 3, kind: 'FIRST' }]);
    expect(p.barcode).toMatch(/^\d{12}$/);
    const again = await printLabels(ctx, actors.gm, { pieces: [{ itemId: p.id, copies: 1 }], source: 'STOCK_LIST' });
    expect(again.labels[0].kind).toBe('REPRINT');
    const rows = await rowsOf(p.id);
    expect(rows.map((x) => [x.kind, x.copies, x.source, x.printedBy])).toEqual([
      ['FIRST', 3, 'PIECE', actors.bmKrt.userId],
      ['REPRINT', 1, 'STOCK_LIST', actors.gm.userId],
    ]);
    expect(rows.every((x) => x.branchId === rows[0].branchId && x.createdAt instanceof Date)).toBe(true);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'LABELS_PRINTED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit).toMatchObject({ entityId: again.batchId });
    expect(JSON.stringify(audit.metadata)).toContain('REPRINT');
  });

  it('who: the cashier is refused; another branch’s piece is not found for a branch manager; the General Manager prints any', async () => {
    const krt = pieces.KRT[1];
    const omd = pieces.OMD[0];
    expect(await code(printLabels(ctx, actors.cashierKrt, { pieces: [{ itemId: krt.id, copies: 1 }], source: 'PIECE' }))).toBe('FORBIDDEN');
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: omd.id, copies: 1 }], source: 'PIECE' }))).toBe('NOT_FOUND');
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: krt.id, copies: 1 }, { itemId: omd.id, copies: 1 }], source: 'STOCK_LIST' }))).toBe('NOT_FOUND');
    expect(await rowsOf(krt.id)).toEqual([]);
    expect(await code(printLabels(ctx, actors.gm, { pieces: [{ itemId: omd.id, copies: 1 }], source: 'PIECE' }))).toBe('OK');
    expect(await code(printLabels(ctx, actors.bmOmd, { pieces: [{ itemId: omd.id, copies: 1 }], source: 'PIECE' }))).toBe('OK');
    expect((await rowsOf(omd.id)).map((x) => x.kind)).toEqual(['FIRST', 'REPRINT']);
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: 999_999, copies: 1 }], source: 'PIECE' }))).toBe('NOT_FOUND');
  });

  it('copies: 1–20 for one piece, 1–5 per piece in a batch; the same piece twice or none is refused', async () => {
    const [a, b] = [pieces.KRT[2], pieces.KRT[3]];
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: a.id, copies: 21 }], source: 'PIECE' }))).toBe('BAD_REQUEST');
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: a.id, copies: 0 }], source: 'PIECE' }))).toBe('BAD_REQUEST');
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: a.id, copies: 6 }, { itemId: b.id, copies: 1 }], source: 'STOCK_LIST' }))).toBe('BAD_REQUEST');
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: a.id, copies: 1 }, { itemId: a.id, copies: 1 }], source: 'STOCK_LIST' }))).toBe('BAD_REQUEST');
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [], source: 'STOCK_LIST' }))).toBe('BAD_REQUEST');
    const r = await printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: a.id, copies: 5 }, { itemId: b.id, copies: 2 }], source: 'STOCK_LIST' });
    expect(r.labels.map((l) => [l.code, l.copies, l.kind])).toEqual([[a.code, 5, 'FIRST'], [b.code, 2, 'FIRST']]);
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: a.id, copies: 20 }], source: 'PIECE' }))).toBe('OK');
  });

  it('a barcode that does not fit the label is refused (409 LABEL_TOO_SMALL with the minimum); nothing recorded', async () => {
    // A 13-digit barcode (the piece numbers after 999,999) needs 37.8 mm with 1 mm margins: copy a piece as the fixture.
    await setSize({ 'print.labelWidthMm': 33 });
    const [src] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, pieces.KRT[4].id));
    const { id: _id, code: _c, barcode: _b, ...rest } = src;
    const [long] = await ctx.db.insert(t.jewelryItems).values({ ...rest, code: 'J-1000001', barcode: '6281001000001' }).returning();
    const e = await printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: long.id, copies: 1 }], source: 'PIECE' }).catch((x) => x);
    expect(e.code).toBe('LABEL_TOO_SMALL');
    expect(e.details).toMatchObject({ minWidthMm: 37.8, code: 'J-1000001' });
    expect(await rowsOf(long.id)).toEqual([]);
    // Now the settings rule sees the longer barcode in stock too.
    expect(await code(setSize({ 'print.labelWidthMm': 35 }))).toBe('LABEL_TOO_SMALL');
    await setSize({ 'print.labelWidthMm': 40 });
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: long.id, copies: 1 }], source: 'PIECE' }))).toBe('OK');
  });

  it('an Idempotency-Key retry records nothing twice (HTTP)', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ username: 'branch.manager.kh', password: DEMO_PASSWORDS.BRANCH_MANAGER });
    expect(login.status).toBe(200);
    agent.set('x-csrf-token', login.body.csrfToken);
    const p = pieces.KRT[5];
    const key = randomUUID();
    const body = { pieces: [{ itemId: p.id, copies: 2 }], source: 'PIECE' };
    const first = await agent.post('/api/labels/print').set('Idempotency-Key', key).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post('/api/labels/print').set('Idempotency-Key', key).send(body);
    expect(again.status).toBe(200);
    expect(again.body.batchId).toBe(first.body.batchId);
    expect(await rowsOf(p.id)).toHaveLength(1);
    // The history route: own branch only; the cashier is refused.
    const hist = await agent.get(`/api/inventory/items/${p.id}/label-prints`);
    expect(hist.status).toBe(200);
    expect(hist.body).toMatchObject([{ kind: 'FIRST', copies: 2, source: 'PIECE', printedByName: expect.any(String) }]);
    expect((await agent.get(`/api/inventory/items/${pieces.OMD[0].id}/label-prints`)).status).toBe(404);
    const cashier = request.agent(app);
    const cl = await cashier.post('/api/auth/login').send({ username: 'cashier.kh.01', password: DEMO_PASSWORDS.CASHIER });
    cashier.set('x-csrf-token', cl.body.csrfToken);
    expect((await cashier.get(`/api/inventory/items/${p.id}/label-prints`)).status).toBe(403);
    expect((await cashier.post('/api/labels/print').set('Idempotency-Key', randomUUID()).send(body)).status).toBe(403);
  });

  it('the history: newest first, with who printed and whether it was a reprint', async () => {
    const p = pieces.KRT[0];
    const h = await labelPrintsOf(ctx, actors.bmKrt, p.id);
    expect(h.map((x) => x.kind)).toEqual(['REPRINT', 'FIRST']);
    expect(h[1]).toMatchObject({ copies: 3, source: 'PIECE' });
    expect(await code(labelPrintsOf(ctx, actors.bmOmd, p.id))).toBe('NOT_FOUND');
    expect(await code(labelPrintsOf(ctx, actors.cashierKrt, p.id))).toBe('FORBIDDEN');
  });

  it('append-only: no update, no delete; no second FIRST; no REPRINT of a piece never printed', async () => {
    const p = pieces.KRT[0];
    const [row] = await rowsOf(p.id);
    const refused = (q: ReturnType<typeof sql>) => ctx.db.execute(q).then(() => false, () => true);
    expect(await refused(sql`UPDATE label_prints SET copies = 9 WHERE id = ${row.id}`)).toBe(true);
    expect(await refused(sql`DELETE FROM label_prints WHERE id = ${row.id}`)).toBe(true);
    const ins = (itemId: number, kind: string) =>
      sql`INSERT INTO label_prints (item_id, branch_id, copies, kind, source, batch_id, printed_by) SELECT id, branch_id, 1, ${kind}, 'PIECE', 'x', ${actors.gm.userId} FROM jewelry_items WHERE id = ${itemId}`;
    expect(await refused(ins(p.id, 'FIRST'))).toBe(true);
    expect(await refused(ins(pieces.KRT[6].id, 'REPRINT'))).toBe(true);
    expect(await refused(sql`INSERT INTO label_prints (item_id, branch_id, copies, kind, source, batch_id, printed_by) SELECT id, branch_id, 21, 'FIRST', 'PIECE', 'x', ${actors.gm.userId} FROM jewelry_items WHERE id = ${pieces.KRT[6].id}`)).toBe(true);
    expect(await rowsOf(pieces.KRT[6].id)).toEqual([]);
  });
});

describe('printing a whole document; the report (D-lbl1-5)', () => {
  it('every piece of a supplier order, or of a sealed opening, in one print; scope; a draft opening refused', async () => {
    const [krt] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT'));
    const [po] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.branchId, krt.id)).orderBy(asc(t.purchases.id)).limit(1);
    // The order's pieces still in KRT (a piece transferred since is labelled where it is now).
    const poItems = (
      await ctx.db
        .select({ itemId: t.purchaseItems.itemId })
        .from(t.purchaseItems)
        .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.purchaseItems.itemId))
        .where(and(eq(t.purchaseItems.purchaseId, po.id), eq(t.jewelryItems.branchId, krt.id)))
        .orderBy(asc(t.purchaseItems.id))
    ).map((r) => r.itemId);
    const r = await printLabels(ctx, actors.bmKrt, { document: { type: 'PURCHASE', id: po.id }, copies: 2, source: 'PURCHASE' });
    expect(r.labels.map((l) => l.itemId)).toEqual(poItems);
    expect(r.labels.every((l) => l.copies === 2 && /^\d{12}$/.test(l.barcode))).toBe(true);
    const rows = await ctx.db.select().from(t.labelPrints).where(eq(t.labelPrints.batchId, r.batchId));
    expect(rows.length).toBe(poItems.length);
    expect(rows.every((x) => x.source === 'PURCHASE')).toBe(true);
    // Another branch's order: not found for its branch manager; the cashier: refused; copies above 5 for a batch.
    expect(await code(printLabels(ctx, actors.bmOmd, { document: { type: 'PURCHASE', id: po.id }, copies: 1, source: 'PURCHASE' }))).toBe('NOT_FOUND');
    expect(await code(printLabels(ctx, actors.cashierKrt, { document: { type: 'PURCHASE', id: po.id }, copies: 1, source: 'PURCHASE' }))).toBe('FORBIDDEN');
    if (poItems.length > 1) expect(await code(printLabels(ctx, actors.bmKrt, { document: { type: 'PURCHASE', id: po.id }, copies: 6, source: 'PURCHASE' }))).toBe('BAD_REQUEST');
    // Both a list and a document, or neither: refused.
    expect(await code(printLabels(ctx, actors.bmKrt, { pieces: [{ itemId: poItems[0], copies: 1 }], document: { type: 'PURCHASE', id: po.id }, source: 'PURCHASE' }))).toBe('BAD_REQUEST');
    expect(await code(printLabels(ctx, actors.bmKrt, { source: 'PURCHASE' }))).toBe('BAD_REQUEST');
    // An opening: refused while it is a draft; a missing one is not found.
    const [draft] = await ctx.db.insert(t.openings).values({ branchId: krt.id, createdBy: actors.gm.userId }).returning();
    expect(await code(printLabels(ctx, actors.bmKrt, { document: { type: 'OPENING', id: draft.id }, copies: 1, source: 'OPENING' }))).toBe('OPENING_NOT_SEALED');
    expect(await code(printLabels(ctx, actors.bmKrt, { document: { type: 'OPENING', id: 999_999 }, copies: 1, source: 'OPENING' }))).toBe('NOT_FOUND');
  });

  it('the report: every print with who, when, copies, first or reprint; a branch manager sees the own branch only', async () => {
    const { runReport } = await import('../src/modules/reports/service');
    const all = await runReport(ctx, actors.gm, 'label-prints', { from: '2000-01-01', to: '2100-01-01' });
    const krt = await runReport(ctx, actors.bmKrt, 'label-prints', { from: '2000-01-01', to: '2100-01-01' });
    const total = await ctx.db.select().from(t.labelPrints);
    expect(all.rows.length).toBe(total.length);
    expect(krt.rows.length).toBeGreaterThan(0);
    expect(krt.rows.length).toBeLessThan(all.rows.length);
    expect(new Set(krt.rows.map((r) => r.branchName)).size).toBe(1);
    expect(all.rows[0]).toMatchObject({ itemCode: expect.any(String), barcode: expect.stringMatching(/^\d{12,13}$/), printedByName: expect.any(String), kind: expect.stringMatching(/^(FIRST|REPRINT)$/) });
    expect((all.totals as Record<string, number>).copies).toBe(total.reduce((s, x) => s + x.copies, 0));
    const reprints = await runReport(ctx, actors.gm, 'label-prints', { from: '2000-01-01', to: '2100-01-01', status: 'REPRINT' });
    expect(reprints.rows.every((r) => r.kind === 'REPRINT')).toBe(true);
    expect(await code(runReport(ctx, actors.cashierKrt, 'label-prints', { from: '2000-01-01', to: '2100-01-01' }))).toBe('FORBIDDEN');
  });
});
