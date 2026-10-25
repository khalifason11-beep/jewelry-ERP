// OPN-1: a piece of UNKNOWN cost, as the sealing of an opening balance creates it (origin OPENING, acquisition cost
// NULL, an ADJUSTMENT +1 movement with a NULL cost value, no purchase line, no cash entry). The tests of c3 use it
// before the openings service exists; the sealing tests check that the service creates exactly this shape.

import { t } from '@jerp/database';
import type { Ctx } from '../../src/core/context';
import { nextItemCode } from '../../src/core/numbering';
import { recordMovement } from '../../src/modules/inventory/ledger';

export async function insertUnknownCostPiece(
  ctx: Ctx,
  p: { branchId: number; categoryId: number; karat: number; netWeightMg: number; sellingPrice: number; description?: string; userId: number | null },
) {
  return ctx.db.transaction(async (tx) => {
    const { code, barcode } = await nextItemCode(tx);
    const at = new Date();
    const [item] = await tx
      .insert(t.jewelryItems)
      .values({
        code,
        barcode,
        categoryId: p.categoryId,
        description: p.description ?? null,
        karat: p.karat,
        grossWeightMg: p.netWeightMg,
        netWeightMg: p.netWeightMg,
        origin: 'OPENING',
        acquisitionCost: null,
        sellingPrice: p.sellingPrice,
        branchId: p.branchId,
        status: 'AVAILABLE',
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    const ref = { refType: 'opening', refId: item.id, refNumber: `OPN-TEST-${item.code}` };
    await tx.insert(t.itemStatusHistory).values({ itemId: item.id, fromStatus: null, toStatus: 'AVAILABLE', branchId: p.branchId, ...ref, userId: p.userId, at });
    await recordMovement(tx, { item, type: 'ADJUSTMENT', direction: 1, branchId: p.branchId, ref, userId: p.userId, at });
    return item;
  });
}
