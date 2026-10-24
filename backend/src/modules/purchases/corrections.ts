// MIS-1 (PUR-FIX, plan docs/plans/MIS-1.md §4, owner answer Q1 option B): the General Manager corrects a supplier order.
//
//   * MAKING_COST: ONE piece's making cost (its line). The order's making charge is the sum of the effective piece
//     values; there is no share rule. A SOLD piece is refused (409 PURCHASE_PIECE_SOLD naming its code): its sale line
//     keeps its cost snapshot. The piece row is locked (FOR UPDATE) before its status is read, the same lock a sale takes,
//     so a correction racing a sale has one winner: a sale confirmed after it snapshots the new cost, one confirmed
//     before keeps the old cost. An unsold piece's live acquisition_cost and making_charge change; while it is in stock
//     (AVAILABLE) two ADJUSTMENT movements (−1 at the old cost, +1 at the new) keep count, weight and value at cost
//     reconciled. A piece out of stock (damaged, in transit, returned) has already left the stock ledger at its old cost;
//     its next movement (restock, receipt) carries the new cost, so only the cost changes (D-mis1-7).
//   * MAKING_CHARGE_REFERENCE: the order's transfer reference (FIX-2 normalization); the same effective reference on
//     another order → 409 DUPLICATE_BANK_REFERENCE unless confirmed (audited).
//   * After either: an order's making charge above 0 carries a reference and 0 carries none (MKC-1, owner answer Q5):
//     422 MAKING_CHARGE_ZERO_WITH_REFERENCE / MAKING_CHARGE_NEEDS_REFERENCE. A correction that changes nothing → 422
//     CORRECTION_NO_CHANGE. The supplier gold debt is never touched.
//   * Effective value of a field = the latest correction of that (piece or order, field), else the original column.
//     `purchases` and `purchase_items` are never updated; `purchase_corrections` is append-only.

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { t, type Executor } from '@jerp/database';
import { ap, sumInt, validBankReference, type AuditParam, type PurchaseCorrectionField } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import type { TxIdempotency } from '../../core/idempotency';
import { lockItems, recordMovement } from '../inventory/ledger';
import { requireConfirmation, type ConfirmationInput } from '../corrections/confirm';

// ───────────────────────── effective values (SQL, for every reader) ─────────────────────────

// The outer table is always named in full ("purchase_items", "purchases"): in a one-table select Drizzle writes its
// columns without the table, and inside these correlated sub-queries a bare "id" would be the correction's own id.

/** A line's effective making cost (`purchase_items` in the outer query): its latest MAKING_COST correction, else the original. */
export const effectiveLineMakingSql = () =>
  sql<number>`coalesce((SELECT c.value_after::bigint FROM purchase_corrections c WHERE c.purchase_item_id = "purchase_items"."id" AND c.field = 'MAKING_COST' ORDER BY c.id DESC LIMIT 1), "purchase_items"."making_cost")`.mapWith(Number);

/** Σ over an order's lines (`purchases` in the outer query) of (effective − original) making cost. */
const orderMakingDelta = sql`(SELECT coalesce(sum(lc.v - pi.making_cost), 0) FROM purchase_items pi CROSS JOIN LATERAL (SELECT c.value_after::bigint AS v FROM purchase_corrections c WHERE c.purchase_item_id = pi.id AND c.field = 'MAKING_COST' ORDER BY c.id DESC LIMIT 1) lc WHERE pi.purchase_id = "purchases"."id")`;

/** An order's effective total cost (`purchases` in the outer query): the stored one plus the corrections. */
export const effectiveTotalCostSql = () => sql<number>`("purchases"."total_cost" + ${orderMakingDelta})`.mapWith(Number);

/** An order's effective making charge (`purchases` in the outer query); NULL for an order from before Phase 4. */
export const effectiveMakingChargeSql = () =>
  sql<number | null>`CASE WHEN "purchases"."making_charge_paid" IS NULL THEN NULL ELSE "purchases"."making_charge_paid" + ${orderMakingDelta} END`.mapWith((v) => (v == null ? null : Number(v)));

/** An order's effective transfer reference (`purchases` in the outer query): its latest correction, else the original. */
export const effectiveReferenceSql = () =>
  sql<string | null>`coalesce((SELECT c.value_after FROM purchase_corrections c WHERE c.purchase_id = "purchases"."id" AND c.field = 'MAKING_CHARGE_REFERENCE' ORDER BY c.id DESC LIMIT 1), "purchases"."making_charge_reference")`;

/** The latest other order whose EFFECTIVE transfer reference is `reference` (the MKC-1 duplicate warning). */
export async function orderWithReference(exec: Executor, reference: string, exceptId?: number): Promise<{ id: number; number: string } | undefined> {
  const [dup] = await exec
    .select({ id: t.purchases.id, number: t.purchases.number })
    .from(t.purchases)
    .where(and(sql`${effectiveReferenceSql()} = ${reference}`, exceptId != null ? sql`${t.purchases.id} <> ${exceptId}` : undefined))
    .orderBy(desc(t.purchases.id))
    .limit(1);
  return dup;
}

// ───────────────────────── the correction ─────────────────────────

export interface PurchaseCorrectionInput extends ConfirmationInput {
  field: PurchaseCorrectionField;
  /** MAKING_COST only: the line (purchase_items.id) of the piece. */
  purchaseItemId?: number;
  /** MAKING_COST: whole SDG ≥ 0. MAKING_CHARGE_REFERENCE: the new transfer reference. */
  newValue: number | string;
  confirmDuplicateReference?: boolean;
}

const MAX_MONEY = 1_000_000_000_000;

export async function correctPurchase(ctx: Ctx, actor: Actor, purchaseId: number, input: PurchaseCorrectionInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'purchases.correct');
  // The shape of the value first (400), then the reason (422) and the password (403), as every MIS-1 correction.
  let newCost: number | null = null;
  let newRef: string | null = null;
  if (input.field === 'MAKING_COST') {
    if (input.purchaseItemId == null) throw badRequest('Choose the piece whose making cost is corrected');
    if (typeof input.newValue !== 'number' || !Number.isSafeInteger(input.newValue) || input.newValue < 0 || input.newValue > MAX_MONEY) {
      throw badRequest('Invalid value for {field}', { field: 'newValue' });
    }
    newCost = input.newValue;
  } else if (input.field === 'MAKING_CHARGE_REFERENCE') {
    if (input.purchaseItemId != null) throw badRequest('A transfer reference belongs to the order, not to a piece');
    newRef = validBankReference(typeof input.newValue === 'string' ? input.newValue : undefined);
    if (!newRef) throw badRequest('Enter the bank transfer reference (4 to 40 letters or digits)');
  } else throw badRequest('Invalid value for {field}', { field: 'field' });
  const reason = await requireConfirmation(ctx, actor, input);
  const at = opts.at ?? new Date();

  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    // The order row serialises its corrections (purchases is not append-only: FOR UPDATE is allowed).
    const [p] = await tx.select().from(t.purchases).where(eq(t.purchases.id, purchaseId)).for('update');
    if (!p) throw notFound('Purchase');
    branchScope(actor, p.branchId);
    const lines = await tx
      .select({ id: t.purchaseItems.id, itemId: t.purchaseItems.itemId, purchaseCost: t.purchaseItems.purchaseCost, otherCost: t.purchaseItems.otherCost, making: effectiveLineMakingSql() })
      .from(t.purchaseItems)
      .where(eq(t.purchaseItems.purchaseId, p.id))
      .orderBy(asc(t.purchaseItems.id));
    const [refRow] = await tx.select({ ref: effectiveReferenceSql() }).from(t.purchases).where(eq(t.purchases.id, p.id));
    const refBefore = refRow.ref;
    const totalBefore = sumInt(lines.map((l) => l.making));
    const ref = { refType: 'purchase', refId: p.id, refNumber: p.number };
    let before: string | null;
    let after: string;
    let audit: { key: string; params: Record<string, AuditParam>; metadata: Record<string, unknown> };
    let duplicateOf: string | null = null;

    if (input.field === 'MAKING_COST') {
      const line = lines.find((l) => l.id === input.purchaseItemId);
      if (!line) throw notFound('Purchase line');
      // The piece row first (FOR UPDATE), then its status: the lock a sale takes too.
      const [item] = await lockItems(tx, [line.itemId]);
      if (item.status === 'SOLD') {
        throw new AppError(409, 'PURCHASE_PIECE_SOLD', 'Piece {code} is already sold: its cost stays as it was on the sale', { code: item.code }, { itemId: item.id });
      }
      if (newCost === line.making) throw new AppError(422, 'CORRECTION_NO_CHANGE', 'This correction changes nothing');
      const totalAfter = totalBefore - line.making + newCost!;
      requireReferenceRule(totalAfter, refBefore);
      const oldCost = item.acquisitionCost;
      const newPieceCost = line.purchaseCost + newCost! + line.otherCost;
      const [updated] = await tx.update(t.jewelryItems).set({ acquisitionCost: newPieceCost, makingCharge: newCost!, updatedAt: at }).where(eq(t.jewelryItems.id, item.id)).returning();
      const inStock = item.status === 'AVAILABLE';
      if (inStock) {
        const note = `Making cost corrected on ${p.number}: ${reason}`;
        await recordMovement(tx, { item, type: 'ADJUSTMENT', direction: -1, branchId: item.branchId, ref, userId: actor.userId, note, at });
        await recordMovement(tx, { item: updated, type: 'ADJUSTMENT', direction: 1, branchId: item.branchId, ref, userId: actor.userId, note, at });
      }
      before = String(line.making);
      after = String(newCost);
      audit = {
        key: 'Supplier order {number}: making cost of piece {code} corrected {from} → {to}. {reason}',
        params: { number: p.number, code: item.code, from: ap.money(line.making), to: ap.money(newCost!), reason },
        metadata: { purchaseId: p.id, field: input.field, purchaseItemId: line.id, itemId: item.id, itemCode: item.code, itemStatus: item.status, reason, before: { makingCost: line.making, pieceCost: oldCost, orderMakingCharge: totalBefore }, after: { makingCost: newCost, pieceCost: newPieceCost, orderMakingCharge: totalAfter }, stockAdjusted: inStock },
      };
    } else {
      if (newRef === refBefore) throw new AppError(422, 'CORRECTION_NO_CHANGE', 'This correction changes nothing');
      if (totalBefore === 0) throw new AppError(422, 'MAKING_CHARGE_NONE', 'This order has no making charge, so it has no transfer reference to correct');
      const dup = await orderWithReference(tx, newRef!, p.id);
      if (dup && !input.confirmDuplicateReference) {
        throw new AppError(409, 'DUPLICATE_BANK_REFERENCE', 'This transfer reference is already on supplier order {number}. Record it anyway?', { number: dup.number }, { number: dup.number, reference: newRef });
      }
      duplicateOf = dup?.number ?? null;
      before = refBefore;
      after = newRef!;
      audit = {
        key: 'Supplier order {number}: transfer reference corrected {from} → {to}. {reason}',
        params: { number: p.number, from: refBefore ?? '', to: newRef!, reason },
        metadata: { purchaseId: p.id, field: input.field, reason, before: { reference: refBefore }, after: { reference: newRef }, ...(duplicateOf ? { duplicateReferenceOf: duplicateOf } : {}) },
      };
    }

    const [row] = await tx
      .insert(t.purchaseCorrections)
      .values({ purchaseId: p.id, purchaseItemId: input.field === 'MAKING_COST' ? input.purchaseItemId! : null, field: input.field, valueBefore: before, valueAfter: after, reason, confirmedDuplicate: duplicateOf != null, correctedBy: actor.userId, sessionId: actor.sessionId ?? null, createdAt: at })
      .returning();
    await writeAudit(tx, actor, { action: 'PURCHASE_CORRECTED', entityType: 'purchase', entityId: p.number, branchId: p.branchId, at, ...audit });
    const result = { id: p.id, number: p.number, correctionId: row.id, field: row.field, valueBefore: row.valueBefore, valueAfter: row.valueAfter, createdAt: row.createdAt };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** MKC-1 after a correction: a making charge above 0 carries a transfer reference, 0 carries none (owner answer Q5). */
function requireReferenceRule(total: number, reference: string | null) {
  if (total === 0 && reference != null) {
    throw new AppError(422, 'MAKING_CHARGE_ZERO_WITH_REFERENCE', 'The order’s making charge would become 0 while it has a transfer reference: a making charge of 0 has no transfer');
  }
  if (total > 0 && reference == null) {
    throw new AppError(422, 'MAKING_CHARGE_NEEDS_REFERENCE', 'The order would have a making charge without a transfer reference: correct the reference first');
  }
}

// ───────────────────────── the history ─────────────────────────

const corrector = alias(t.users, 'corrector');

/** An order's corrections, oldest first, with who, when, why and the piece's code. */
export async function correctionsOf(exec: Executor, purchaseId: number) {
  return exec
    .select({
      id: t.purchaseCorrections.id,
      field: t.purchaseCorrections.field,
      purchaseItemId: t.purchaseCorrections.purchaseItemId,
      itemCode: t.jewelryItems.code,
      valueBefore: t.purchaseCorrections.valueBefore,
      valueAfter: t.purchaseCorrections.valueAfter,
      reason: t.purchaseCorrections.reason,
      confirmedDuplicate: t.purchaseCorrections.confirmedDuplicate,
      correctedByName: corrector.fullName,
      createdAt: t.purchaseCorrections.createdAt,
    })
    .from(t.purchaseCorrections)
    .innerJoin(corrector, eq(corrector.id, t.purchaseCorrections.correctedBy))
    .leftJoin(t.purchaseItems, eq(t.purchaseItems.id, t.purchaseCorrections.purchaseItemId))
    .leftJoin(t.jewelryItems, eq(t.jewelryItems.id, t.purchaseItems.itemId))
    .where(eq(t.purchaseCorrections.purchaseId, purchaseId))
    .orderBy(asc(t.purchaseCorrections.id));
}
