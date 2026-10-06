// Supplier settlement (Phase 4, D-4-4 / D-4-5): gold-for-gold only.
//
// A purchase order owes the supplier gold, measured in 24K-equivalent mg. The shop never initiates
// collection: when the supplier's representative visits, the branch manager settles part or all of
// the debt EXCLUSIVELY with broken-scrap weight from the branch pool. One transaction:
//   (a) − weight from the pool (scrap_weight_entries), (b) − its 24K equivalent from the order's
//   gold_owed_mg_pure24, (c) a supplier_settlements record.
// This module deliberately imports NOTHING from the money ledger: no settlement can touch CASH or
// BANK (a test asserts it). No currency conversion anywhere.

import { asc, eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { pureGoldMg } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import type { TxIdempotency } from '../../core/idempotency';
import { lockPool, poolBalances, postWeight } from '../scrap/service';

export interface SettlementInput {
  karat: number;
  weightMg: number;
  note?: string;
}

export async function settleWithScrap(ctx: Ctx, actor: Actor, purchaseId: number, input: SettlementInput, opts: { idem?: TxIdempotency; at?: Date } = {}) {
  requirePerm(actor, 'purchases.settle');
  if (!Number.isSafeInteger(input.weightMg) || input.weightMg <= 0) throw badRequest('Invalid value for {field}', { field: 'weightMg' });
  if (!Number.isInteger(input.karat) || input.karat < 1 || input.karat > 24) throw badRequest('Invalid value for {field}', { field: 'karat' });
  const at = opts.at ?? new Date();
  // The single pure-gold conversion of the system (D-2a-6).
  const pure = pureGoldMg(input.weightMg, input.karat);
  if (pure <= 0) throw badRequest('Invalid value for {field}', { field: 'weightMg' });

  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    // Row lock: concurrent settlements of one order are applied one after the other.
    const [order] = await tx.select().from(t.purchases).where(eq(t.purchases.id, purchaseId)).for('update');
    if (!order) throw notFound('Purchase');
    branchScope(actor, order.branchId);
    if (order.goldOwedMgPure24 == null) throw badRequest('This purchase was recorded before gold settlement existed and cannot be settled with scrap');
    if (order.goldOwedMgPure24 === 0) throw badRequest('This purchase is already fully settled');
    if (pure > order.goldOwedMgPure24) throw badRequest('This weight is more than the gold still owed on this purchase');

    // The pool: lock it, check the karat balance, take the weight out.
    await lockPool(tx, order.branchId);
    const [bal] = await poolBalances(tx, order.branchId, input.karat);
    if ((bal?.weightMg ?? 0) < input.weightMg) {
      throw badRequest('Not enough {karat}K broken scrap in the pool', { karat: input.karat });
    }
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, order.branchId));
    const number = await nextNumber(tx, branch.code, 'SST');
    const [s] = await tx
      .insert(t.supplierSettlements)
      .values({
        number,
        purchaseId: order.id,
        branchId: order.branchId,
        settledKarat: input.karat,
        settledWeightMg: input.weightMg,
        settledPureMg24: pure,
        actorId: actor.userId,
        sessionId: actor.sessionId,
        idempotencyKey: opts.idem?.key ?? null,
        note: input.note?.trim() || null,
        at,
      })
      .returning();
    await postWeight(
      tx,
      { branchId: order.branchId, karat: input.karat, weightMg: -input.weightMg, eventType: 'SUPPLIER_SETTLEMENT', ref: { refType: 'supplier_settlement', refId: s.id, refNumber: number }, note: `Purchase ${order.number}`, at },
      { actor, idempotencyKey: opts.idem?.key },
    );
    const owed = order.goldOwedMgPure24 - pure;
    await tx.update(t.purchases).set({ goldOwedMgPure24: owed }).where(eq(t.purchases.id, order.id));
    await writeAudit(tx, actor, {
      action: 'SUPPLIER_SETTLEMENT_RECORDED',
      entityType: 'purchase',
      entityId: order.number,
      branchId: order.branchId,
      at,
      key: owed === 0 ? 'Purchase {number} settled in full with broken scrap ({settlement})' : 'Purchase {number} partly settled with broken scrap ({settlement})',
      params: { number: order.number, settlement: number },
    });
    const result = { id: s.id, number, purchaseId: order.id, purchaseNumber: order.number, settledKarat: input.karat, settledWeightMg: input.weightMg, settledPureMg24: pure, goldOwedMgPure24: owed };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/**
 * Settlements of one order, oldest first, each with the gold still owed AFTER it (running balance,
 * SAFE: visible to the branch manager, D-4-13). The settled karat / weight / 24K stay COST.
 */
export async function settlementsFor(ctx: Ctx, purchaseId: number) {
  const [order] = await ctx.db.select({ debt: t.purchases.goldDebtMgPure24 }).from(t.purchases).where(eq(t.purchases.id, purchaseId));
  const list = await ctx.db
    .select({
      id: t.supplierSettlements.id,
      number: t.supplierSettlements.number,
      settledKarat: t.supplierSettlements.settledKarat,
      settledWeightMg: t.supplierSettlements.settledWeightMg,
      settledPureMg24: t.supplierSettlements.settledPureMg24,
      note: t.supplierSettlements.note,
      at: t.supplierSettlements.at,
      createdByName: t.users.fullName,
    })
    .from(t.supplierSettlements)
    .innerJoin(t.users, eq(t.users.id, t.supplierSettlements.actorId))
    .where(eq(t.supplierSettlements.purchaseId, purchaseId))
    .orderBy(asc(t.supplierSettlements.id));
  let owed = order?.debt ?? null;
  return list.map((s) => {
    owed = owed == null ? null : owed - s.settledPureMg24;
    return { ...s, owedAfterMgPure24: owed };
  });
}
