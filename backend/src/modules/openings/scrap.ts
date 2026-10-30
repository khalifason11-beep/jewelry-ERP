// OPN-3 (plan docs/plans/OPN-3.md, D-opn3-*): the broken scrap of an opening balance. General Manager only.
//
//   * Draft (`opening.manage`): lines typed in by keyboard (no CSV, owner Q7): any karat 1–24 (Q2), the net weight in
//     whole mg (Q3), an optional note of at most 120 characters (Q9); several lines of a karat (Q8). Added, edited and
//     removed while DRAFT, each audited; every write takes the opening row FOR UPDATE first, as the piece lines do, so a
//     line never slips in after the seal (the trigger of migration 0037 refuses it in the database too).
//   * Seal (openings/service.ts `sealOpening`, same transaction, same password and passkey): one OPENING movement per line
//     into the branch's pool (`postOpeningScrap`), under the pool lock. No money, no cost, no piece.
//   * Correction after the seal (`opening.correct`, Q6): a reason, the password in the request and a fresh passkey, as
//     OPN-FIX. One or two changes (a karat move is −X at one karat and +X at another, one transaction); each an
//     append-only row and an OPENING_CORRECTION movement. A decrease never takes the pool below 0 (409
//     SCRAP_POOL_SHORT) nor takes out more than the opening put in for that karat (409
//     OPENING_SCRAP_CORRECTION_TOO_LARGE). No time limit.

import { and, asc, eq, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { ap, correctionReason, pureGoldMg, sumInt } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import type { TxIdempotency } from '../../core/idempotency';
import { freshFactors, reauthRequired } from '../../auth/reauth';
import { requireConfirmation } from '../corrections/confirm';
import { lockPool, poolBalances, postWeight } from '../scrap/service';

/** The longest note of a scrap line (Q9). */
export const OPENING_SCRAP_NOTE_MAX = 120;

export interface OpeningScrapLineInput {
  karat: number;
  weightMg: number;
  note?: string | null;
}

export interface OpeningScrapCorrectionInput {
  /** One change, or two at different karats (a karat move). */
  changes: { karat: number; weightMgChange: number }[];
  reason?: string;
  confirmPassword?: string;
}

const sealedError = (branchCode: string) => new AppError(409, 'OPENING_SEALED', 'The opening of {branch} is sealed: nothing can be added or removed', { branch: branchCode });

/** The opening row FOR UPDATE and its branch; a sealed one → 409 (the draft writes). */
async function lockDraft(tx: Executor, id: number) {
  const [o] = await tx.select().from(t.openings).where(eq(t.openings.id, id)).for('update');
  if (!o) throw notFound('Opening');
  const [b] = await tx.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).where(eq(t.branches.id, o.branchId));
  if (o.status !== 'DRAFT') throw sealedError(b.code);
  return { opening: o, branch: b };
}

/** A line as typed: karat 1–24, weight a whole mg above 0, the note trimmed (empty = none, at most 120). */
function checkLine(l: OpeningScrapLineInput) {
  if (!Number.isInteger(l.karat) || l.karat < 1 || l.karat > 24) throw badRequest('The karat must be a whole number from 1 to 24');
  if (!Number.isSafeInteger(l.weightMg) || l.weightMg <= 0) throw badRequest('The weight must be above 0');
  const note = l.note?.trim() || null;
  if (note && note.length > OPENING_SCRAP_NOTE_MAX) throw badRequest('A note can have at most {max} characters', { max: OPENING_SCRAP_NOTE_MAX });
  return { karat: l.karat, weightMg: l.weightMg, note };
}

/** Totals by karat: lines, weight and the 24K equivalent (one `pureGoldMg` rounding per karat, as the pool view). */
function totalsByKarat(rows: { karat: number; weightMg: number; lines?: number }[]) {
  const byKarat = rows.map((r) => ({ karat: r.karat, lines: r.lines ?? 0, weightMg: r.weightMg, pureMg24: pureGoldMg(r.weightMg, r.karat) }));
  return { byKarat, lines: sumInt(byKarat.map((k) => k.lines)), weightMg: sumInt(byKarat.map((k) => k.weightMg)), pureMg24: sumInt(byKarat.map((k) => k.pureMg24)) };
}

/** The broken scrap of an opening as entered (or as sealed): by karat, with the 24K equivalent. */
export async function scrapSummaryOf(exec: Executor, openingId: number) {
  const rows = await exec
    .select({
      karat: t.openingScrapLines.karat,
      lines: sql<number>`count(*)`.mapWith(Number),
      weightMg: sql<number>`coalesce(sum(${t.openingScrapLines.weightMg}), 0)`.mapWith(Number),
    })
    .from(t.openingScrapLines)
    .where(eq(t.openingScrapLines.openingId, openingId))
    .groupBy(t.openingScrapLines.karat)
    .orderBy(asc(t.openingScrapLines.karat));
  return totalsByKarat(rows);
}

/** Every scrap line of an opening, in entry order (a branch has a few). */
export async function scrapLinesOf(exec: Executor, openingId: number) {
  return exec
    .select({
      id: t.openingScrapLines.id,
      lineNo: t.openingScrapLines.lineNo,
      karat: t.openingScrapLines.karat,
      weightMg: t.openingScrapLines.weightMg,
      note: t.openingScrapLines.note,
      createdAt: t.openingScrapLines.createdAt,
      updatedAt: t.openingScrapLines.updatedAt,
    })
    .from(t.openingScrapLines)
    .where(eq(t.openingScrapLines.openingId, openingId))
    .orderBy(asc(t.openingScrapLines.lineNo));
}

/** The corrections after the seal, oldest first, with who made them. */
export async function scrapCorrectionsOf(exec: Executor, openingId: number) {
  return exec
    .select({
      id: t.openingScrapCorrections.id,
      karat: t.openingScrapCorrections.karat,
      weightMgChange: t.openingScrapCorrections.weightMgChange,
      reason: t.openingScrapCorrections.reason,
      createdAt: t.openingScrapCorrections.createdAt,
      correctedByName: t.users.fullName,
    })
    .from(t.openingScrapCorrections)
    .innerJoin(t.users, eq(t.users.id, t.openingScrapCorrections.correctedBy))
    .where(eq(t.openingScrapCorrections.openingId, openingId))
    .orderBy(asc(t.openingScrapCorrections.id));
}

/** What the opening put into the pool per karat: its sealed lines plus its corrections (the limit of a decrease). */
async function contributionByKarat(exec: Executor, openingId: number): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  for (const k of (await scrapSummaryOf(exec, openingId)).byKarat) m.set(k.karat, k.weightMg);
  for (const c of await exec.select({ karat: t.openingScrapCorrections.karat, w: t.openingScrapCorrections.weightMgChange }).from(t.openingScrapCorrections).where(eq(t.openingScrapCorrections.openingId, openingId))) {
    m.set(c.karat, (m.get(c.karat) ?? 0) + c.w);
  }
  return m;
}

/** A sealed opening's broken scrap now: the sealed lines plus the corrections, per karat (karats at 0 left out). */
export async function scrapNowOf(exec: Executor, openingId: number) {
  const m = await contributionByKarat(exec, openingId);
  return totalsByKarat([...m].filter(([, w]) => w !== 0).sort((a, b) => a[0] - b[0]).map(([karat, weightMg]) => ({ karat, weightMg })));
}

async function nextLineNo(tx: Executor, openingId: number) {
  const [r] = await tx.select({ n: sql<number>`coalesce(max(${t.openingScrapLines.lineNo}), 0)`.mapWith(Number) }).from(t.openingScrapLines).where(eq(t.openingScrapLines.openingId, openingId));
  return r.n + 1;
}

/** `POST /openings/:id/scrap-lines`: one line of broken scrap typed in (draft only). */
export async function addOpeningScrapLine(ctx: Ctx, actor: Actor, id: number, input: OpeningScrapLineInput, opts: { idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  const l = checkLine(input);
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { branch } = await lockDraft(tx, id);
    const lineNo = await nextLineNo(tx, id);
    const [row] = await tx.insert(t.openingScrapLines).values({ openingId: id, lineNo, karat: l.karat, weightMg: l.weightMg, note: l.note, createdBy: actor.userId }).returning({ id: t.openingScrapLines.id });
    await writeAudit(tx, actor, {
      action: 'OPENING_SCRAP_LINE_ADDED',
      entityType: 'opening',
      entityId: id,
      branchId: branch.id,
      key: 'Opening of {branch}: broken scrap line {line} added, {karat} {weight}',
      params: { branch: branch.code, line: lineNo, karat: ap.karat(l.karat), weight: ap.mg(l.weightMg) },
      metadata: { lineId: row.id, lineNo, karat: l.karat, weightMg: l.weightMg, note: l.note },
    });
    const result = { id: row.id, lineNo, openingId: id };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** `POST /openings/:id/scrap-lines/:lineId`: a draft line's karat, weight and note changed (audited before → after). */
export async function updateOpeningScrapLine(ctx: Ctx, actor: Actor, id: number, lineId: number, input: OpeningScrapLineInput, opts: { idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  const l = checkLine(input);
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { branch } = await lockDraft(tx, id);
    const [line] = await tx.select().from(t.openingScrapLines).where(and(eq(t.openingScrapLines.id, lineId), eq(t.openingScrapLines.openingId, id)));
    if (!line) throw notFound('Opening line');
    if (line.karat === l.karat && line.weightMg === l.weightMg && line.note === l.note) {
      throw new AppError(422, 'OPENING_LINE_UNCHANGED', 'Nothing changed: change the karat, the weight or the note');
    }
    await tx.update(t.openingScrapLines).set({ karat: l.karat, weightMg: l.weightMg, note: l.note, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(t.openingScrapLines.id, lineId));
    await writeAudit(tx, actor, {
      action: 'OPENING_SCRAP_LINE_CHANGED',
      entityType: 'opening',
      entityId: id,
      branchId: branch.id,
      key: 'Opening of {branch}: broken scrap line {line} changed, {karatBefore} {weightBefore} → {karat} {weight}',
      params: { branch: branch.code, line: line.lineNo, karatBefore: ap.karat(line.karat), weightBefore: ap.mg(line.weightMg), karat: ap.karat(l.karat), weight: ap.mg(l.weightMg) },
      metadata: { lineId, lineNo: line.lineNo, before: { karat: line.karat, weightMg: line.weightMg, note: line.note }, after: l },
    });
    const result = { id: lineId, lineNo: line.lineNo, openingId: id };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** `POST /openings/:id/scrap-lines/:lineId/remove`: a draft line out (audited with what it held). */
export async function removeOpeningScrapLine(ctx: Ctx, actor: Actor, id: number, lineId: number, opts: { idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.manage');
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { branch } = await lockDraft(tx, id);
    const [line] = await tx.select().from(t.openingScrapLines).where(and(eq(t.openingScrapLines.id, lineId), eq(t.openingScrapLines.openingId, id)));
    if (!line) throw notFound('Opening line');
    await tx.delete(t.openingScrapLines).where(eq(t.openingScrapLines.id, lineId));
    await writeAudit(tx, actor, {
      action: 'OPENING_SCRAP_LINE_REMOVED',
      entityType: 'opening',
      entityId: id,
      branchId: branch.id,
      key: 'Opening of {branch}: broken scrap line {line} removed, {karat} {weight}',
      params: { branch: branch.code, line: line.lineNo, karat: ap.karat(line.karat), weight: ap.mg(line.weightMg) },
      metadata: { line: { lineNo: line.lineNo, karat: line.karat, weightMg: line.weightMg, note: line.note } },
    });
    const result = { ok: true as const, removedLineNo: line.lineNo };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/**
 * Inside the seal's transaction (the opening row already locked, still DRAFT): every scrap line → one OPENING movement
 * into the branch's pool at its karat, under the pool lock. Returns the scrap totals as sealed.
 */
export async function postOpeningScrap(
  tx: Executor,
  actor: Actor,
  opening: { id: number; branchId: number },
  branchCode: string,
  at: Date,
  idempotencyKey: string | null | undefined,
) {
  const lines = await tx.select().from(t.openingScrapLines).where(eq(t.openingScrapLines.openingId, opening.id)).orderBy(asc(t.openingScrapLines.lineNo));
  if (lines.length) {
    await lockPool(tx, opening.branchId);
    for (const l of lines) {
      await postWeight(
        tx,
        { branchId: opening.branchId, karat: l.karat, weightMg: l.weightMg, eventType: 'OPENING', ref: { refType: 'opening_scrap_line', refId: l.id, refNumber: `OPN-${branchCode}` }, note: l.note ?? 'Opening balance', at },
        { actor, idempotencyKey },
      );
    }
  }
  return scrapSummaryOf(tx, opening.id);
}

/** The number of scrap lines of an opening (the seal's "empty" check, before the transaction). */
export async function scrapLineCount(exec: Executor, openingId: number) {
  const [r] = await exec.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(t.openingScrapLines).where(eq(t.openingScrapLines.openingId, openingId));
  return r.n;
}

/** The changes of a correction, checked: one, or two at different karats; each karat 1–24, each change a whole mg ≠ 0. */
function checkChanges(changes: OpeningScrapCorrectionInput['changes']) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 2) throw badRequest('Give one change, or two for a karat move');
  for (const c of changes) {
    if (!Number.isInteger(c.karat) || c.karat < 1 || c.karat > 24) throw badRequest('The karat must be a whole number from 1 to 24');
    if (!Number.isSafeInteger(c.weightMgChange) || c.weightMgChange === 0) throw badRequest('The change must be a weight other than 0');
  }
  if (changes.length === 2 && changes[0].karat === changes[1].karat) throw badRequest('A karat move needs two different karats');
  return changes;
}

/** `POST /openings/:id/scrap-corrections`: correct the broken scrap of a sealed opening (Q6). */
export async function correctOpeningScrap(ctx: Ctx, actor: Actor, id: number, input: OpeningScrapCorrectionInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.correct');
  const changes = checkChanges(input.changes);
  // As OPN-FIX (D-opnfix-2): the reason first (a refused reason never spends a password attempt), then the passkey and
  // the password.
  if (correctionReason(input.reason) == null || !input.confirmPassword) await requireConfirmation(ctx, actor, input);
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  if (!f.hasPasskey) throw new AppError(403, 'PASSKEY_REQUIRED', 'Register a passkey first: correcting the opening balance needs your passkey');
  if (!f.passkey) throw reauthRequired(f);
  const reason = await requireConfirmation(ctx, actor, input);
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [o] = await tx.select().from(t.openings).where(eq(t.openings.id, id));
    if (!o) throw notFound('Opening');
    const [branch] = await tx.select({ code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).where(eq(t.branches.id, o.branchId));
    if (o.status !== 'SEALED') throw new AppError(409, 'OPENING_NOT_SEALED', 'The opening of {branch} is not sealed yet: change its lines instead', { branch: branch.code });
    // Every change of the pool takes its lock; the checks below read under it.
    await lockPool(tx, o.branchId);
    const put = await contributionByKarat(tx, id);
    for (const c of changes.filter((x) => x.weightMgChange < 0)) {
      const out = -c.weightMgChange;
      // First what the opening put in for the karat (the rule of an opening correction), then what the pool holds now
      // (a supplier may have taken part of it since).
      const opened = put.get(c.karat) ?? 0;
      if (opened < out) {
        throw new AppError(409, 'OPENING_SCRAP_CORRECTION_TOO_LARGE', 'The opening put {openedMg} mg of {karat}K broken scrap into the pool; a correction cannot take out more ({weightMg} mg)', { karat: c.karat, openedMg: opened, weightMg: out }, { openedMg: opened, neededMg: out });
      }
      const balance = (await poolBalances(tx, o.branchId, c.karat))[0]?.weightMg ?? 0;
      if (balance < out) {
        throw new AppError(409, 'SCRAP_POOL_SHORT', 'The {karat}K scrap pool of this branch holds {balanceMg} mg; this correction takes {weightMg} mg out of it', { karat: c.karat, balanceMg: balance, weightMg: out }, { balanceMg: balance, neededMg: out });
      }
    }
    const made: { id: number; karat: number; weightMgChange: number }[] = [];
    for (const c of changes) {
      const [row] = await tx
        .insert(t.openingScrapCorrections)
        .values({ openingId: id, branchId: o.branchId, karat: c.karat, weightMgChange: c.weightMgChange, reason, correctedBy: actor.userId, sessionId: actor.sessionId ?? null, createdAt: at })
        .returning({ id: t.openingScrapCorrections.id });
      await postWeight(
        tx,
        { branchId: o.branchId, karat: c.karat, weightMg: c.weightMgChange, eventType: 'OPENING_CORRECTION', ref: { refType: 'opening_scrap_correction', refId: row.id, refNumber: `OPN-${branch.code}` }, note: reason, at },
        { actor, idempotencyKey: opts.idem?.key },
      );
      made.push({ id: row.id, karat: c.karat, weightMgChange: c.weightMgChange });
    }
    const describe = ap.list(made.map((c) => ap.phrase(c.weightMgChange > 0 ? '{karat} +{weight}' : '{karat} −{weight}', { karat: ap.karat(c.karat), weight: ap.mg(Math.abs(c.weightMgChange)) })));
    await writeAudit(tx, actor, {
      action: 'OPENING_SCRAP_CORRECTED',
      entityType: 'opening',
      entityId: id,
      branchId: o.branchId,
      at,
      key: 'Broken scrap of the opening of {branch} corrected ({changes}): {reason}',
      params: { branch: ap.text(branch.name, branch.nameAr), changes: describe, reason },
      metadata: { openingId: id, changes: made, reason, passkeyUv: f.passkeyUv },
    });
    const result = { openingId: id, changes: made, scrapNow: await scrapNowOf(tx, id) };
    await opts.idem?.complete(tx, result);
    return result;
  });
}
