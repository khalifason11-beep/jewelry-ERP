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
import { desc, eq, inArray } from 'drizzle-orm';
import { t } from '@jerp/database';
import { LABEL_MAX_COPIES_BATCH, LABEL_MAX_COPIES_ONE, labelLayout, type LabelPrintKind, type LabelPrintSource } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, isGlobal, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import type { TxIdempotency } from '../../core/idempotency';
import { lockItems } from '../inventory/ledger';

export interface PrintLabelsInput {
  pieces: { itemId: number; copies: number }[];
  source: LabelPrintSource;
}

/** A branch-bound person sees a piece of the own branch only; anything else is "not found". */
function assertSees(actor: Actor, branchId: number) {
  if (!isGlobal(actor) && actor.branchId !== branchId) throw notFound('Item');
}

export async function printLabels(ctx: Ctx, actor: Actor, input: PrintLabelsInput, opts: { idem?: TxIdempotency; at?: Date } = {}) {
  requirePerm(actor, 'opening.enter');
  const ids = input.pieces.map((p) => p.itemId);
  if (!ids.length) throw badRequest('Choose the pieces to print');
  if (new Set(ids).size !== ids.length) throw badRequest('The same piece appears twice');
  // Owner Q10: up to 20 copies of one piece; up to 5 per piece in a batch.
  const max = ids.length === 1 ? LABEL_MAX_COPIES_ONE : LABEL_MAX_COPIES_BATCH;
  for (const p of input.pieces) {
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
    const labels = input.pieces.map((p) => {
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

