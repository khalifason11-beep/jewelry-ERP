// DEMO ONLY: give a demo database created before Phase 2b the ledger entries its history implies
// (sales, voids, Hasad settlements), so the drawer and the reconciliation match
// the demo data. Production and real data are NEVER backfilled with invented entries: the books of a
// real company start at the opening balance (Phase 3). Guarded at three levels: the caller only runs
// in demo mode, this function refuses outside APP_MODE=demo, and it does nothing if any entry exists.

import { asc, count, isNotNull, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { PaymentMethod } from '@jerp/shared';
import { config } from '../config';
import type { Ctx } from '../core/context';
import { accountKindFor, post, reverseRef } from '../modules/ledger/service';

const NOTE = 'Demo history (entries recreated for a demo database created before the ledger)';

export async function backfillDemoLedger(ctx: Ctx): Promise<{ entries: number }> {
  if (config.appMode !== 'demo') throw new Error('The demo ledger backfill never runs outside APP_MODE=demo');
  return ctx.db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(t.ledgerEntries);
    if (n > 0) return { entries: 0 };
    const by = { actor: null };
    for (const s of await tx.select().from(t.sales).orderBy(asc(t.sales.id))) {
      const method = s.paymentMethod as PaymentMethod;
      const ref = { refType: 'sale', refId: s.id, refNumber: s.number };
      await post(tx, [{ branchId: s.branchId, kind: accountKindFor(method), amount: s.total, eventType: 'SALE', paymentMethod: method, ref, note: NOTE, at: s.createdAt }], by);
      if (s.status === 'VOIDED') await reverseRef(tx, ref, 'SALE', 'SALE_VOID', by, { note: NOTE, at: s.voidedAt ?? s.createdAt });
    }
    for (const st of await tx.select().from(t.settlements).where(isNotNull(t.settlements.redemptionId)).orderBy(asc(t.settlements.id))) {
      const method = st.paymentMethod as PaymentMethod;
      await post(
        tx,
        [{
          branchId: st.branchId,
          kind: accountKindFor(method),
          amount: st.direction === 'BRANCH_PAYS_CUSTOMER' ? -st.amount : st.amount,
          eventType: 'HASAD_SETTLEMENT',
          paymentMethod: method,
          ref: { refType: 'hasad_redemption', refId: st.redemptionId!, refNumber: st.number },
          note: NOTE,
          at: st.confirmedAt,
        }],
        by,
      );
    }
    const [{ m }] = await tx.select({ m: sql<number>`count(*)::int` }).from(t.ledgerEntries);
    return { entries: Number(m) };
  });
}
