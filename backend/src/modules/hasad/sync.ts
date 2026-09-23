// Anti-corruption layer: translates Hasad's external withdrawal format into ERP records.
// Receiving a withdrawal NEVER touches inventory — no item is selected or reserved here.

import { eq, inArray } from 'drizzle-orm';
import { t } from '@jerp/database';
import { gramsStringToMg, HasadError, type HasadWithdrawal } from '@jerp/hasad';
import type { Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';

let lastSyncAt = 0;
let lastSyncError: string | null = null;
const SYNC_INTERVAL_MS = 4000;

export function mapExternal(w: HasadWithdrawal, branchId: number) {
  return {
    externalId: w.withdrawalId,
    hasadCustomerId: w.customer.customerId,
    customerName: w.customer.fullName,
    customerNameAr: w.customer.fullNameAr ?? null,
    customerPhone: w.customer.phone ?? null,
    customerNationalIdMasked: w.customer.nationalIdMasked ?? null,
    entitledWeightMg: gramsStringToMg(w.entitlement.weightGrams),
    entitlementKarat: w.entitlement.karat,
    branchId,
    externalStatus: w.status,
    pickupCode: w.pickupCode ?? null,
    requestedAt: new Date(w.requestedAt),
  };
}

/**
 * Pull new/updated withdrawal requests from Hasad (the future integration would also
 * receive webhooks; polling keeps the prototype self-contained).
 * Returns an error message when Hasad is unreachable — callers fall back to local data.
 */
export async function syncWithdrawals(ctx: Ctx, force = false): Promise<{ error: string | null; syncedAt: Date }> {
  if (!force && Date.now() - lastSyncAt < SYNC_INTERVAL_MS) return { error: lastSyncError, syncedAt: new Date(lastSyncAt) };
  lastSyncAt = Date.now();
  let remote: HasadWithdrawal[];
  try {
    remote = await ctx.hasad.listWithdrawals({ status: ['READY_FOR_PICKUP', 'IN_PROGRESS', 'CANCELLED'] });
    lastSyncError = null;
  } catch (e) {
    lastSyncError = e instanceof HasadError ? e.message : 'Hasad Gold is unreachable';
    return { error: lastSyncError, syncedAt: new Date(lastSyncAt) };
  }

  const branchRows = await ctx.db.select({ id: t.branches.id, code: t.branches.hasadBranchCode }).from(t.branches);
  const branchByCode = new Map(branchRows.filter((b) => b.code).map((b) => [b.code!, b.id]));
  const existing = remote.length
    ? await ctx.db
        .select({ id: t.hasadWithdrawals.id, externalId: t.hasadWithdrawals.externalId, status: t.hasadWithdrawals.status })
        .from(t.hasadWithdrawals)
        .where(inArray(t.hasadWithdrawals.externalId, remote.map((r) => r.withdrawalId)))
    : [];
  const known = new Map(existing.map((e) => [e.externalId, e]));

  for (const w of remote) {
    const branchId = branchByCode.get(w.branchCode);
    if (!branchId) continue; // unknown branch — would raise an integration alert in production
    const local = known.get(w.withdrawalId);
    if (!local) {
      if (w.status === 'CANCELLED') continue;
      await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(t.hasadWithdrawals)
          .values({ ...mapExternal(w, branchId), status: 'READY_FOR_PICKUP' })
          .returning();
        await writeAudit(tx, null, {
          action: 'HASAD_WITHDRAWAL_RECEIVED',
          entityType: 'hasad_withdrawal',
          entityId: row.externalId,
          branchId,
          description: `Withdrawal ${row.externalId} received from Hasad Gold: ${row.customerName}, ${w.entitlement.weightGrams} g entitlement. No inventory reserved.`,
        });
      });
    } else if (w.status === 'CANCELLED' && local.status === 'READY_FOR_PICKUP') {
      // Cancelled by the customer in the Hasad app.
      await ctx.db
        .update(t.hasadWithdrawals)
        .set({ status: 'CANCELLED', externalStatus: 'CANCELLED', cancelledAt: new Date(), cancelReason: w.cancellation?.reason ?? 'Cancelled in Hasad Gold', lastSyncedAt: new Date() })
        .where(eq(t.hasadWithdrawals.id, local.id));
    }
  }
  return { error: null, syncedAt: new Date(lastSyncAt) };
}

export function resetSyncState() {
  lastSyncAt = 0;
  lastSyncError = null;
}
