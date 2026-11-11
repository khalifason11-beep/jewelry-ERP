// LBL-1 (docs/plans/LBL-1.md, D-lbl1-1…5): barcode labels of pieces.
//
//   * Read-only for the pieces: a label carries the piece's barcode (12 digits today) and the same digits under it;
//     no code is ever made or changed here.
//   * Who: the people who enter pieces and the opening balance (`opening.enter`: the branch manager of the branch and
//     the General Manager; never the cashier). A branch manager prints only the own branch's pieces (another branch's
//     piece answers 404, as a missing one).
//   * Every print is recorded in the same transaction that hands the labels out (`label_prints`, append-only): who,
//     when, which piece, how many copies, and whether it is the piece's first label or a reprint. The piece rows are
//     locked (FOR UPDATE, id order), so two prints of a never-printed piece at once record exactly one FIRST.
//   * The label size is the General Manager's setting: not set → 409 LABEL_SIZE_NOT_SET; a piece whose barcode does not
//     fit → 409 LABEL_TOO_SMALL (the size rule of shared/src/labels.ts).

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { t } from '@jerp/database';
import { LABEL_MAX_COPIES_BATCH, LABEL_MAX_COPIES_ONE, labelLayout, type LabelPrintKind, type LabelPrintSource } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, isGlobal, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import type { TxIdempotency } from '../../core/idempotency';
import { lockItems } from '../inventory/ledger';

export interface PrintLabelsInput {
  /** Some pieces, each with its copies (the piece page, the stock list)… */
  pieces?: { itemId: number; copies: number }[];
  /** …or every piece of a supplier order or of a sealed opening, `copies` each (D-lbl1-5). */
  document?: { type: 'PURCHASE' | 'OPENING'; id: number };
  copies?: number;
  source: LabelPrintSource;
}

/** The most pieces one document print hands out (a large opening is printed in one go up to this). */
export const LABEL_MAX_DOCUMENT_PIECES = 2000;

/**
 * The pieces of a supplier order or a sealed opening, in their order; scope-checked (another branch's document: 404).
 * For a branch manager, only the pieces that are in the branch now (a piece transferred since is labelled where it is).
 */
async function piecesOf(ctx: Ctx, actor: Actor, doc: NonNullable<PrintLabelsInput['document']>): Promise<number[]> {
  if (doc.type === 'PURCHASE') {
    const [p] = await ctx.db.select({ branchId: t.purchases.branchId }).from(t.purchases).where(eq(t.purchases.id, doc.id));
    if (!p) throw notFound('Purchase');
    assertSees(actor, p.branchId);
    const rows = await ctx.db
      .select({ itemId: t.purchaseItems.itemId, branchId: t.jewelryItems.branchId })
      .from(t.purchaseItems)
      .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.purchaseItems.itemId))
      .where(eq(t.purchaseItems.purchaseId, doc.id))
      .orderBy(asc(t.purchaseItems.id));
    return rows.filter((r) => isGlobal(actor) || r.branchId === actor.branchId).map((r) => r.itemId!);
  }
  const [o] = await ctx.db.select({ branchId: t.openings.branchId, status: t.openings.status }).from(t.openings).where(eq(t.openings.id, doc.id));
  if (!o) throw notFound('Opening');
  assertSees(actor, o.branchId);
  if (o.status !== 'SEALED') throw new AppError(409, 'OPENING_NOT_SEALED', 'The opening is not sealed yet: its pieces have no codes');
  const rows = await ctx.db
    .select({ itemId: t.openingLines.itemId, branchId: t.jewelryItems.branchId })
    .from(t.openingLines)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingLines.itemId))
    .where(and(eq(t.openingLines.openingId, doc.id), isNotNull(t.openingLines.itemId)))
    .orderBy(asc(t.openingLines.lineNo));
  return rows.filter((r) => isGlobal(actor) || r.branchId === actor.branchId).map((r) => r.itemId!);
}

/** A branch-bound person sees a piece of the own branch only; anything else is "not found". */
function assertSees(actor: Actor, branchId: number) {
  if (!isGlobal(actor) && actor.branchId !== branchId) throw notFound('Item');
}

export async function printLabels(ctx: Ctx, actor: Actor, input: PrintLabelsInput, opts: { idem?: TxIdempotency; at?: Date } = {}) {
  requirePerm(actor, 'opening.enter');
  if (!!input.pieces === !!input.document) throw badRequest('Choose the pieces to print');
  if (input.document) {
    const docIds = await piecesOf(ctx, actor, input.document);
    if (docIds.length > LABEL_MAX_DOCUMENT_PIECES) throw badRequest('At most {max} pieces at once', { max: LABEL_MAX_DOCUMENT_PIECES });
    input = { ...input, pieces: docIds.map((itemId) => ({ itemId, copies: input.copies ?? 1 })) };
  }
  const pieces = input.pieces!;
  const ids = pieces.map((p) => p.itemId);
  if (!ids.length) throw badRequest('Choose the pieces to print');
  if (new Set(ids).size !== ids.length) throw badRequest('The same piece appears twice');
  // Owner Q10: up to 20 copies of one piece; up to 5 per piece in a batch.
  const max = ids.length === 1 ? LABEL_MAX_COPIES_ONE : LABEL_MAX_COPIES_BATCH;
  for (const p of pieces) {
    if (!Number.isInteger(p.copies) || p.copies < 1 || p.copies > max) throw badRequest('Copies: a whole number from 1 to {max}', { max });
  }
  const { print } = await ctx.settings.get();
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const items = await lockItems(tx, ids).catch(() => {
      throw notFound('Item');
    });
    // Another branch's piece is "not found" before anything else is said about it.
    for (const i of items) assertSees(actor, i.branchId);
    if (print.labelWidthMm == null || print.labelHeightMm == null) {
      throw new AppError(409, 'LABEL_SIZE_NOT_SET', 'Set the label size in Settings first (General Manager)');
    }
    const size = { widthMm: print.labelWidthMm, heightMm: print.labelHeightMm, marginMm: print.labelMarginMm };
    for (const i of items) {
      const layout = labelLayout(size, i.barcode);
      if (!layout.ok) {
        throw new AppError(409, 'LABEL_TOO_SMALL', 'This label is too small for a scannable barcode: it needs at least {minWidth} × {minHeight} mm', { minWidth: layout.minWidthMm, minHeight: layout.minHeightMm }, { minWidthMm: layout.minWidthMm, minHeightMm: layout.minHeightMm, code: i.code });
      }
    }
    const printed = new Set((await tx.select({ itemId: t.labelPrints.itemId }).from(t.labelPrints).where(inArray(t.labelPrints.itemId, ids))).map((r) => r.itemId));
    const batchId = randomUUID();
    const byId = new Map(items.map((i) => [i.id, i]));
    const labels = pieces.map((p) => {
      const i = byId.get(p.itemId)!;
      const kind: LabelPrintKind = printed.has(i.id) ? 'REPRINT' : 'FIRST';
      return { itemId: i.id, code: i.code, barcode: i.barcode, branchId: i.branchId, copies: p.copies, kind };
    });
    await tx.insert(t.labelPrints).values(
      labels.map((l) => ({ itemId: l.itemId, branchId: l.branchId, copies: l.copies, kind: l.kind, source: input.source, batchId, printedBy: actor.userId, sessionId: actor.sessionId, idempotencyKey: opts.idem?.key ?? null, createdAt: at })),
    );
    const reprints = labels.filter((l) => l.kind === 'REPRINT');
    const copies = labels.reduce((s, l) => s + l.copies, 0);
    const branches = [...new Set(labels.map((l) => l.branchId))];
    await writeAudit(tx, actor, {
      action: 'LABELS_PRINTED',
      entityType: 'label_print',
      entityId: batchId,
      branchId: branches.length === 1 ? branches[0] : null,
      at,
      key: 'Labels printed: {n} piece(s), {copies} label(s), {reprints} reprint(s)',
      params: { n: labels.length, copies, reprints: reprints.length },
      metadata: { source: input.source, pieces: labels.map((l) => ({ code: l.code, copies: l.copies, kind: l.kind })) },
    });
    const result = { batchId, size, labels: labels.map(({ branchId: _b, ...l }) => l) };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** The label prints of one piece, newest first (who, when, how many, first or reprint). */
export async function labelPrintsOf(ctx: Ctx, actor: Actor, itemId: number) {
  requirePerm(actor, 'opening.enter');
  const [item] = await ctx.db.select({ id: t.jewelryItems.id, branchId: t.jewelryItems.branchId }).from(t.jewelryItems).where(eq(t.jewelryItems.id, itemId));
  if (!item) throw notFound('Item');
  assertSees(actor, item.branchId);
  branchScope(actor, item.branchId);
  return ctx.db
    .select({ id: t.labelPrints.id, kind: t.labelPrints.kind, source: t.labelPrints.source, copies: t.labelPrints.copies, printedByName: t.users.fullName, printedByNameAr: t.users.fullNameAr, createdAt: t.labelPrints.createdAt })
    .from(t.labelPrints)
    .innerJoin(t.users, eq(t.users.id, t.labelPrints.printedBy))
    .where(eq(t.labelPrints.itemId, itemId))
    .orderBy(desc(t.labelPrints.id));
}

