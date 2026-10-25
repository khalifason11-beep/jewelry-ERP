// OPN-FIX (plan docs/plans/OPN-FIX.md, D-opnfix-1…5): correcting or voiding a piece of a SEALED opening, after the seal.
//
//   * Who: `opening.correct` (General Manager only). A reason (3–200), the password in the request AND a fresh passkey
//     confirmation, as the seal (D-opnfix-2).
//   * Which piece: a line of that sealed opening (origin OPENING), AVAILABLE, in any branch (D-opnfix-3); sold, in
//     transit, damaged, returned or voided pieces are refused (409 OPENING_PIECE_NOT_AVAILABLE).
//   * What: CORRECT changes the condition (the rate kind), the karat and/or the weights; VOID makes the piece VOIDED.
//     Condition and karat need computed prices (409 OPENING_NEEDS_COMPUTED_PRICES on FIXED_TAG) and the current rate of
//     the new (karat, condition) (409 OPENING_RATES_MISSING). The cost stays unknown (NULL).
//   * How: one transaction. The Idempotency-Key is claimed first; the pricing lock (shared) then the piece row FOR UPDATE,
//     in the order a sale takes them, so a correction and a sale of the same piece run one after the other; every check
//     re-reads under those locks. Then the append-only correction row (with the branch the piece is in), the piece row
//     (the effective values), the movements (a net weight change: ADJUSTMENT −1 at the old weight, +1 at the new; a
//     void: −1), the status history (void) and the audit entry. The opening and its lines never change.
//   * Preview (D-opnfix-5): the same checks and the prices before/after from the live rates, read-only, no write.

import { and, asc, eq } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { ap, correctionReason, type GoldRateKind } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import { allowedKarats } from '../../core/karats';
import type { TxIdempotency } from '../../core/idempotency';
import { freshFactors, reauthRequired } from '../../auth/reauth';
import { requireConfirmation } from '../corrections/confirm';
import { changeStatus, lockItems, recordMovement } from '../inventory/ledger';
import { currentSellingRates, lockPricingShared, priceOf, pricingOf, rateKey, type CurrentRate, type Pricing } from '../pricing/service';

export type OpeningCorrectionAction = 'CORRECT' | 'VOID';

export interface OpeningCorrectionChange {
  action: OpeningCorrectionAction;
  condition?: GoldRateKind;
  karat?: number;
  grossWeightMg?: number;
  netWeightMg?: number;
}

export interface OpeningCorrectionInput extends OpeningCorrectionChange {
  reason?: string;
  confirmPassword?: string;
}

/** The values a correction is about: the piece's condition (its rate kind), karat and weights. */
export interface PieceValues {
  condition: GoldRateKind;
  karat: number;
  grossWeightMg: number;
  netWeightMg: number;
}

interface PieceRow {
  id: number;
  code: string;
  status: string;
  origin: string;
  branchId: number;
  karat: number;
  rateKind: string;
  grossWeightMg: number;
  netWeightMg: number;
  sellingPrice: number;
  acquisitionCost: number | null;
}

const valuesOf = (p: PieceRow): PieceValues => ({ condition: p.rateKind as GoldRateKind, karat: p.karat, grossWeightMg: p.grossWeightMg, netWeightMg: p.netWeightMg });

/** The opening this piece was sealed in (its line), or the refusal. */
async function openingOf(exec: Executor, openingId: number, piece: PieceRow) {
  const [line] = await exec
    .select({ openingId: t.openingLines.openingId, status: t.openings.status, branchId: t.openings.branchId, branchCode: t.branches.code, branchName: t.branches.name, branchNameAr: t.branches.nameAr })
    .from(t.openingLines)
    .innerJoin(t.openings, eq(t.openings.id, t.openingLines.openingId))
    .innerJoin(t.branches, eq(t.branches.id, t.openings.branchId))
    .where(eq(t.openingLines.itemId, piece.id));
  if (!line || line.openingId !== openingId || line.status !== 'SEALED' || piece.origin !== 'OPENING') {
    throw new AppError(409, 'NOT_AN_OPENING_PIECE', 'Piece {code} is not a piece of this sealed opening balance', { code: piece.code });
  }
  return line;
}

/**
 * The values after the change, checked (D-opnfix-1, D-opnfix-4). `rates` is read by the caller (under the pricing lock
 * for the write). Throws the refusal the write would give, so the preview shows it before the confirmation.
 */
async function target(ctx: Ctx, pricing: Pricing, rates: Map<string, CurrentRate>, piece: PieceRow, change: OpeningCorrectionChange): Promise<PieceValues> {
  if (piece.status !== 'AVAILABLE') {
    throw new AppError(
      409,
      'OPENING_PIECE_NOT_AVAILABLE',
      piece.status === 'TRANSFERRED'
        ? 'Piece {code} is in transit to another branch: receive it first, then correct it'
        : 'Piece {code} is {status}: only an available piece can be corrected',
      { code: piece.code, status: piece.status },
      { itemId: piece.id, status: piece.status },
    );
  }
  const before = valuesOf(piece);
  if (change.action === 'VOID') return before;
  const after: PieceValues = {
    condition: change.condition ?? before.condition,
    karat: change.karat ?? before.karat,
    grossWeightMg: change.grossWeightMg ?? before.grossWeightMg,
    netWeightMg: change.netWeightMg ?? before.netWeightMg,
  };
  if (after.condition === before.condition && after.karat === before.karat && after.grossWeightMg === before.grossWeightMg && after.netWeightMg === before.netWeightMg) {
    throw new AppError(422, 'OPENING_CORRECTION_UNCHANGED', 'The correction changes nothing: change the condition, the karat or a weight');
  }
  const allowed = await allowedKarats(ctx);
  if (after.karat !== before.karat && !allowed.includes(after.karat)) {
    throw badRequest('{karat}K is not sold here: sellable pieces must be {allowed}', { karat: after.karat, allowed: allowed.map((k) => `${k}K`).join(', ') });
  }
  if (!(after.netWeightMg > 0)) throw new AppError(422, 'VALIDATION', 'The net weight must be above 0');
  if (after.grossWeightMg < after.netWeightMg) throw new AppError(422, 'VALIDATION', 'The gross weight cannot be below the net weight');
  const priced = after.condition !== before.condition || after.karat !== before.karat;
  if (priced && pricing.mode !== 'RATE_COMPUTED') {
    throw new AppError(409, 'OPENING_NEEDS_COMPUTED_PRICES', 'Switch on computed prices (price per gram) before correcting the condition or the karat of an opening piece');
  }
  if (priced && !rates.get(rateKey(after.karat, after.condition))) {
    const k = `${after.karat}K`;
    throw new AppError(
      409,
      'OPENING_RATES_MISSING',
      after.condition === 'USED' ? 'Set the selling rate first: the used-piece rate of {usedKarats}' : 'Set the selling rate first: the new-piece rate of {newKarats}',
      { newKarats: after.condition === 'NEW' ? k : '', usedKarats: after.condition === 'USED' ? k : '' },
      { missing: [{ karat: after.karat, condition: after.condition }] },
    );
  }
  return after;
}

const priceFor = (pricing: Pricing, rates: Map<string, CurrentRate>, piece: PieceRow, v: PieceValues) =>
  priceOf(pricing, rates, { karat: v.karat, rateKind: v.condition, netWeightMg: v.netWeightMg, sellingPrice: piece.sellingPrice, code: piece.code });

/** What the correction would change, for the dialog's preview (D-opnfix-5): read-only, nothing is written. */
export async function previewOpeningCorrection(ctx: Ctx, actor: Actor, openingId: number, itemId: number, change: OpeningCorrectionChange) {
  requirePerm(actor, 'opening.correct');
  const [piece] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, itemId));
  if (!piece) throw notFound('Item');
  await openingOf(ctx.db, openingId, piece);
  const pricing = await pricingOf(ctx);
  const rates = await currentSellingRates(ctx.db);
  const after = await target(ctx, pricing, rates, piece, change);
  const before = valuesOf(piece);
  const p0 = priceFor(pricing, rates, piece, before);
  const p1 = change.action === 'VOID' ? null : priceFor(pricing, rates, piece, after);
  return {
    action: change.action,
    before: { ...before, sellingPrice: p0.sellingPrice, pricePerGram: p0.pricePerGram },
    after: change.action === 'VOID' ? null : { ...after, sellingPrice: p1!.sellingPrice, pricePerGram: p1!.pricePerGram },
    // The stock valuation (Σ live prices of the available pieces) moves by this much; a void takes the piece out.
    valuationChange: (p1?.sellingPrice ?? 0) - (p0.sellingPrice ?? 0),
    stockWeightChangeMg: change.action === 'VOID' ? -before.netWeightMg : after.netWeightMg - before.netWeightMg,
    stockCountChange: change.action === 'VOID' ? -1 : 0,
  };
}

/** `POST /openings/:id/pieces/:itemId/correction`: correct or void one piece of a sealed opening. */
export async function correctOpeningPiece(ctx: Ctx, actor: Actor, openingId: number, itemId: number, input: OpeningCorrectionInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'opening.correct');
  // D-opnfix-2: the reason first (a refused reason never spends a password attempt), then the password and the passkey,
  // in the seal's order.
  if (correctionReason(input.reason) == null || !input.confirmPassword) await requireConfirmation(ctx, actor, input);
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  if (!f.hasPasskey) throw new AppError(403, 'PASSKEY_REQUIRED', 'Register a passkey first: correcting an opening piece needs your passkey');
  if (!f.passkey) throw reauthRequired(f);
  const reason = await requireConfirmation(ctx, actor, input);
  const at = opts.at ?? new Date();
  const pricing = await pricingOf(ctx);
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    // The order a sale takes its locks: pricing (shared), then the piece row.
    await lockPricingShared(tx);
    const [piece] = await lockItems(tx, [itemId]);
    const opening = await openingOf(tx, openingId, piece);
    const rates = await currentSellingRates(tx);
    const before = valuesOf(piece);
    const after = await target(ctx, pricing, rates, piece, input);
    const [branch] = await tx.select({ code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).where(eq(t.branches.id, piece.branchId));
    const [row] = await tx
      .insert(t.openingPieceCorrections)
      .values({
        itemId: piece.id,
        openingId,
        branchId: piece.branchId,
        kind: input.action,
        conditionBefore: before.condition,
        conditionAfter: after.condition,
        karatBefore: before.karat,
        karatAfter: after.karat,
        grossWeightMgBefore: before.grossWeightMg,
        grossWeightMgAfter: after.grossWeightMg,
        netWeightMgBefore: before.netWeightMg,
        netWeightMgAfter: after.netWeightMg,
        reason,
        correctedBy: actor.userId,
        sessionId: actor.sessionId ?? null,
        createdAt: at,
      })
      .returning({ id: t.openingPieceCorrections.id });
    const ref = { refType: 'opening_correction', refId: row.id, refNumber: `OPN-${opening.branchCode}` };
    if (input.action === 'VOID') {
      await changeStatus(tx, { item: piece, to: 'VOIDED', from: ['AVAILABLE'], userId: actor.userId, ref, note: reason, at });
      // The piece leaves the stock: count −1, weight −net, at its (unknown) cost.
      await recordMovement(tx, { item: { id: piece.id, netWeightMg: piece.netWeightMg, acquisitionCost: null }, type: 'ADJUSTMENT', direction: -1, branchId: piece.branchId, ref, userId: actor.userId, note: reason, at });
    } else {
      const weightMoves = after.netWeightMg !== before.netWeightMg;
      if (weightMoves) {
        await recordMovement(tx, { item: { id: piece.id, netWeightMg: before.netWeightMg, acquisitionCost: null }, type: 'ADJUSTMENT', direction: -1, branchId: piece.branchId, ref, userId: actor.userId, note: reason, at });
      }
      await tx
        .update(t.jewelryItems)
        .set({ rateKind: after.condition, karat: after.karat, grossWeightMg: after.grossWeightMg, netWeightMg: after.netWeightMg, updatedAt: at })
        .where(and(eq(t.jewelryItems.id, piece.id), eq(t.jewelryItems.status, 'AVAILABLE')));
      if (weightMoves) {
        await recordMovement(tx, { item: { id: piece.id, netWeightMg: after.netWeightMg, acquisitionCost: null }, type: 'ADJUSTMENT', direction: 1, branchId: piece.branchId, ref, userId: actor.userId, note: reason, at });
      }
    }
    const p0 = priceFor(pricing, rates, piece, before);
    const p1 = input.action === 'VOID' ? null : priceFor(pricing, rates, piece, after);
    await writeAudit(tx, actor, {
      action: input.action === 'VOID' ? 'OPENING_PIECE_VOIDED' : 'OPENING_PIECE_CORRECTED',
      entityType: 'jewelry_item',
      entityId: piece.id,
      branchId: piece.branchId,
      at,
      key: input.action === 'VOID' ? 'Opening piece {code} (opening of {openingBranch}) voided in {branch}: {reason}' : 'Opening piece {code} (opening of {openingBranch}) corrected in {branch}: {reason}',
      params: { code: piece.code, openingBranch: ap.text(opening.branchName, opening.branchNameAr), branch: ap.text(branch.name, branch.nameAr), reason },
      metadata: {
        correctionId: row.id,
        openingId,
        openingBranchId: opening.branchId,
        branchId: piece.branchId,
        kind: input.action,
        before,
        after,
        sellingPriceBefore: p0.sellingPrice,
        sellingPriceAfter: p1?.sellingPrice ?? null,
        reason,
        passkeyUv: f.passkeyUv,
      },
    });
    const result = { id: row.id, itemId: piece.id, code: piece.code, kind: input.action, branchId: piece.branchId, before, after, sellingPriceBefore: p0.sellingPrice, sellingPriceAfter: p1?.sellingPrice ?? null };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** The corrections of a piece (the piece page) or of an opening (its page), newest last. Every value is SAFE. */
export async function openingCorrectionsOf(exec: Executor, where: { itemId?: number; openingId?: number }) {
  return exec
    .select({
      id: t.openingPieceCorrections.id,
      itemId: t.openingPieceCorrections.itemId,
      code: t.jewelryItems.code,
      openingId: t.openingPieceCorrections.openingId,
      kind: t.openingPieceCorrections.kind,
      branchId: t.openingPieceCorrections.branchId,
      branchName: t.branches.name,
      branchNameAr: t.branches.nameAr,
      conditionBefore: t.openingPieceCorrections.conditionBefore,
      conditionAfter: t.openingPieceCorrections.conditionAfter,
      karatBefore: t.openingPieceCorrections.karatBefore,
      karatAfter: t.openingPieceCorrections.karatAfter,
      grossWeightMgBefore: t.openingPieceCorrections.grossWeightMgBefore,
      grossWeightMgAfter: t.openingPieceCorrections.grossWeightMgAfter,
      netWeightMgBefore: t.openingPieceCorrections.netWeightMgBefore,
      netWeightMgAfter: t.openingPieceCorrections.netWeightMgAfter,
      reason: t.openingPieceCorrections.reason,
      correctedByName: t.users.fullName,
      createdAt: t.openingPieceCorrections.createdAt,
    })
    .from(t.openingPieceCorrections)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.openingPieceCorrections.itemId))
    .innerJoin(t.branches, eq(t.branches.id, t.openingPieceCorrections.branchId))
    .innerJoin(t.users, eq(t.users.id, t.openingPieceCorrections.correctedBy))
    .where(
      and(
        where.itemId != null ? eq(t.openingPieceCorrections.itemId, where.itemId) : undefined,
        where.openingId != null ? eq(t.openingPieceCorrections.openingId, where.openingId) : undefined,
      ),
    )
    .orderBy(asc(t.openingPieceCorrections.id));
}
