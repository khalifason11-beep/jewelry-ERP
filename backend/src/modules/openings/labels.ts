// LBL-2 (docs/plans/LBL-2.md §4–§5, D-lbl2-3): the label of a DRAFT opening line, printed before the seal.
//
//   * The line already holds its piece's code and barcode (D-lbl2-1); the label is LBL-1's: one Code128 symbol of that
//     barcode at the General Manager's size (409 LABEL_SIZE_NOT_SET / LABEL_TOO_SMALL), 1–20 copies (phase 1: one line
//     at a time; no multi-select, no "print all", owner decision).
//   * Who: `opening.enter` (the branch manager of the branch, the General Manager; never the cashier); another
//     branch's opening answers 404. A reprint needs no approval (owner Q4); it is recorded and marked.
//   * Every print is recorded in the same transaction that hands the label out: `opening_label_prints` (append-only):
//     who, when, which line and code, copies, FIRST (the code was never printed) or REPRINT; one audit entry
//     LABELS_PRINTED. The opening row is locked (lockDraft, FOR UPDATE) as by every draft write, so a print never
//     interleaves with the line's removal or with the seal: the print of a removed line is 404, after the seal 409
//     OPENING_SEALED; the seal copies every print made before it (./service.ts).

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { LABEL_MAX_COPIES_ONE, type LabelPrintKind } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import type { TxIdempotency } from '../../core/idempotency';
import { assertLabelFits, labelSizeOf } from '../labels/service';
import { assertSeesOpening, lockDraft } from './service';

/** `POST /openings/:id/lines/:lineId/label`: the label of one draft line (copies 1–20), recorded. */
export async function printOpeningLineLabel(ctx: Ctx, actor: Actor, openingId: number, lineId: number, input: { copies: number }, opts: { idem?: TxIdempotency; at?: Date } = {}) {
  requirePerm(actor, 'opening.enter');
  await assertSeesOpening(ctx.db, actor, openingId);
  if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > LABEL_MAX_COPIES_ONE) throw badRequest('Copies: a whole number from 1 to {max}', { max: LABEL_MAX_COPIES_ONE });
  const { print } = await ctx.settings.get();
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const { branch } = await lockDraft(tx, openingId, actor);
    const [line] = await tx.select().from(t.openingLines).where(and(eq(t.openingLines.id, lineId), eq(t.openingLines.openingId, openingId)));
    if (!line) throw notFound('Opening line');
    if (!line.reservedCode || !line.reservedBarcode) throw new AppError(409, 'OPENING_CODES_MISSING', '{n} line(s) of the opening have no piece code: nothing was sealed', { n: 1 });
    const size = labelSizeOf(print);
    assertLabelFits(size, line.reservedBarcode, line.reservedCode);
    const [earlier] = await tx.select({ id: t.openingLabelPrints.id }).from(t.openingLabelPrints).where(eq(t.openingLabelPrints.code, line.reservedCode)).orderBy(desc(t.openingLabelPrints.id)).limit(1);
    const kind: LabelPrintKind = earlier ? 'REPRINT' : 'FIRST';
    const batchId = randomUUID();
    await tx.insert(t.openingLabelPrints).values({
      openingId,
      openingLineId: line.id,
      lineNo: line.lineNo,
      code: line.reservedCode,
      barcode: line.reservedBarcode,
      branchId: branch.id,
      copies: input.copies,
      kind,
      batchId,
      printedBy: actor.userId,
      sessionId: actor.sessionId ?? null,
      idempotencyKey: opts.idem?.key ?? null,
      createdAt: at,
    });
    await writeAudit(tx, actor, {
      action: 'LABELS_PRINTED',
      entityType: 'label_print',
      entityId: batchId,
      branchId: branch.id,
      at,
      key: 'Labels printed: {n} piece(s), {copies} label(s), {reprints} reprint(s)',
      params: { n: 1, copies: input.copies, reprints: kind === 'REPRINT' ? 1 : 0 },
      metadata: { source: 'OPENING_DRAFT', openingId, pieces: [{ code: line.reservedCode, lineNo: line.lineNo, copies: input.copies, kind }] },
    });
    const result = { batchId, size, labels: [{ lineId: line.id, lineNo: line.lineNo, code: line.reservedCode, barcode: line.reservedBarcode, copies: input.copies, kind }] };
    await opts.idem?.complete(tx, result);
    return result;
  });
}
