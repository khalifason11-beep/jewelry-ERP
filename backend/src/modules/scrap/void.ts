// MIS-1 (SCR-VOID, plan docs/plans/MIS-1.md §3): voiding a counter scrap purchase made by mistake. General Manager
// only (`scrap.void`), with a reason and the password (./confirm.ts).
//
// One transaction, the Idempotency-Key claimed inside it; every check after the locks:
//   1. the purchase's void lock (advisory, per purchase: `scrap_purchase_voids` is append-only, so no FOR UPDATE), then
//      a second void → 409 SCRAP_ALREADY_VOIDED (the UNIQUE purchase_id is the last line of defence);
//   2. SELLABLE: the piece row FOR UPDATE (the lock a sale takes too: of a sale and a void at once exactly one wins); it
//      must be AVAILABLE in the purchase's branch, else 409 SCRAP_PIECE_NOT_AVAILABLE naming the code and the status. The
//      piece → VOIDED (history row) with an ADJUSTMENT −1 movement at its cost, so count, weight and value drop;
//   3. BROKEN: the branch pool lock; the karat's balance must hold the net weight, else 409 SCRAP_POOL_SHORT with the
//      balance; a REVERSAL pool entry (−mg);
//   4. the money: every SCRAP_PURCHASE entry of the purchase reversed (both parts of a split), dated now;
//   5. the void row, and the audit (reason, amounts, piece or weight; never the password).

import { eq, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { ap } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, notFound } from '../../core/errors';
import type { TxIdempotency } from '../../core/idempotency';
import { changeStatus, lockItems, recordMovement } from '../inventory/ledger';
import { reverseRef } from '../ledger/service';
import { requireConfirmation, type ConfirmationInput } from '../corrections/confirm';
import { lockPool, poolBalances, postWeight } from './service';

/** pg advisory lock namespace of one purchase's void (the pool uses 7461). */
const VOID_LOCK = 7462;

export async function voidScrapPurchase(ctx: Ctx, actor: Actor, id: number, input: ConfirmationInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'scrap.void');
  const reason = await requireConfirmation(ctx, actor, input);
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${VOID_LOCK}, ${id})`);
    const [p] = await tx.select().from(t.scrapPurchases).where(eq(t.scrapPurchases.id, id));
    if (!p) throw notFound('Scrap purchase');
    const [already] = await tx.select({ id: t.scrapPurchaseVoids.id }).from(t.scrapPurchaseVoids).where(eq(t.scrapPurchaseVoids.purchaseId, id));
    if (already) throw new AppError(409, 'SCRAP_ALREADY_VOIDED', 'Scrap purchase {number} is already voided', { number: p.number });

    const ref = { refType: 'scrap_purchase', refId: p.id, refNumber: p.number };
    const by = { actor, idempotencyKey: opts.idem?.key };
    let itemCode: string | null = null;
    if (p.kind === 'SELLABLE') {
      const [item] = await lockItems(tx, [p.itemId!]);
      itemCode = item.code;
      if (item.status !== 'AVAILABLE' || item.branchId !== p.branchId) {
        const status = item.status === 'AVAILABLE' ? 'IN_ANOTHER_BRANCH' : item.status;
        throw new AppError(409, 'SCRAP_PIECE_NOT_AVAILABLE', 'Piece {code} is {status}: only a piece still available in the branch that bought it can be voided', { code: item.code, status }, { itemId: item.id, status: item.status, branchId: item.branchId });
      }
      await changeStatus(tx, { item, to: 'VOIDED', from: ['AVAILABLE'], userId: actor.userId, ref, note: `Scrap purchase voided: ${reason}`, at });
      await recordMovement(tx, { item, type: 'ADJUSTMENT', direction: -1, branchId: item.branchId, ref, userId: actor.userId, note: `Scrap purchase voided: ${reason}`, at });
    } else {
      await lockPool(tx, p.branchId);
      const balance = (await poolBalances(tx, p.branchId, p.karat))[0]?.weightMg ?? 0;
      if (balance < p.netWeightMg) {
        throw new AppError(409, 'SCRAP_POOL_SHORT', 'The {karat}K scrap pool of this branch holds {balanceMg} mg; voiding this purchase takes {weightMg} mg out of it', { karat: p.karat, balanceMg: balance, weightMg: p.netWeightMg }, { balanceMg: balance, neededMg: p.netWeightMg });
      }
      await postWeight(tx, { branchId: p.branchId, karat: p.karat, weightMg: -p.netWeightMg, eventType: 'REVERSAL', ref, note: reason, at }, by);
    }

    const reversed = await reverseRef(tx, ref, 'SCRAP_PURCHASE', 'REVERSAL', by, { note: reason, at });
    const [row] = await tx.insert(t.scrapPurchaseVoids).values({ purchaseId: p.id, reason, voidedBy: actor.userId, sessionId: actor.sessionId ?? null, createdAt: at }).returning();
    await writeAudit(tx, actor, {
      action: 'SCRAP_PURCHASE_VOIDED',
      entityType: 'scrap_purchase',
      entityId: p.number,
      branchId: p.branchId,
      at,
      key: p.kind === 'SELLABLE' ? 'Scrap {number} voided: piece {code} removed from stock, {amount} reversed. {reason}' : 'Scrap {number} voided: {weight} {karat} taken out of the scrap pool, {amount} reversed. {reason}',
      params: { number: p.number, code: itemCode ?? '', weight: ap.mg(p.netWeightMg), karat: ap.karat(p.karat), amount: ap.money(p.amount), reason },
      metadata: { purchaseId: p.id, kind: p.kind, reason, itemId: p.itemId, itemCode, before: { status: 'VALID', itemStatus: p.kind === 'SELLABLE' ? 'AVAILABLE' : null }, after: { status: 'VOIDED', itemStatus: p.kind === 'SELLABLE' ? 'VOIDED' : null }, amount: p.amount, cashAmount: p.cashAmount, bankAmount: p.bankAmount, netWeightMg: p.netWeightMg, reversedEntries: reversed },
    });
    const result = { id: p.id, number: p.number, status: 'VOIDED' as const, voidId: row.id, voidedAt: row.createdAt, reason, itemCode, reversedEntries: reversed };
    await opts.idem?.complete(tx, result);
    return result;
  });
}
