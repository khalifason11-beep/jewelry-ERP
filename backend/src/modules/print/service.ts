// Invoice printing (D-print-*). The server decides whether a print is the ORIGINAL or a REPRINT,
// counts reprints atomically, audits them, and builds the printed data from a cost-free whitelist
// (`buildInvoicePrintData`): the browser only lays it out.
//
// - ORIGINAL: once per sale, by the cashier who completed it, in the same session (right after the
//   sale). No copy mark.
// - Anything else is a REPRINT: needs `sales.reprint` (branch and general managers), increments
//   `sales.reprint_count` in one UPDATE (no lost updates), is marked "COPY n" with the reprint date,
//   and writes an INVOICE_REPRINTED audit entry.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { buildInvoicePrintData, type InvoicePrintData, type PrintLayout } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, forbidden, notFound } from '../../core/errors';

export interface PrintResponse {
  document: InvoicePrintData;
  layout: PrintLayout;
}

export async function printLayout(ctx: Ctx): Promise<PrintLayout> {
  const { print } = await ctx.settings.get();
  return { format: print.invoiceFormat, receiptWidthMm: print.receiptWidthMm };
}

export async function printSale(ctx: Ctx, actor: Actor, id: number): Promise<PrintResponse> {
  requireAny(actor, 'sales.view', 'sales.view_own');
  // Only the columns a printed invoice shows: no cost column is even read.
  const [row] = await ctx.db
    .select({
      id: t.sales.id,
      number: t.sales.number,
      branchId: t.sales.branchId,
      cashierId: t.sales.cashierId,
      sessionId: t.sales.sessionId,
      createdAt: t.sales.createdAt,
      status: t.sales.status,
      voidReason: t.sales.voidReason,
      customerName: t.sales.customerName,
      customerNameAr: t.sales.customerNameAr,
      customerPhone: t.sales.customerPhone,
      subtotal: t.sales.subtotal,
      discountTotal: t.sales.discountTotal,
      total: t.sales.total,
      paymentMethod: t.sales.paymentMethod,
      paymentRefInvoice: t.sales.paymentRefInvoice,
      paymentRefTransaction: t.sales.paymentRefTransaction,
      originalPrintedAt: t.sales.originalPrintedAt,
      branchName: t.branches.name,
      branchNameAr: t.branches.nameAr,
      branchAddress: t.branches.address,
      branchPhone: t.branches.phone,
      cashierName: t.users.fullName,
      cashierNameAr: t.users.fullNameAr,
    })
    .from(t.sales)
    .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
    .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
    .where(eq(t.sales.id, id));
  if (!row) throw notFound('Sale');
  branchScope(actor, row.branchId);
  if (!can(actor, 'sales.view') && row.cashierId !== actor.userId) throw forbidden('You can only view your own sales');

  const lines = await ctx.db
    .select({
      code: t.jewelryItems.code,
      name: t.saleItems.productName,
      nameAr: t.products.nameAr,
      karat: t.saleItems.karat,
      netWeightMg: t.saleItems.netWeightMg,
      listPrice: t.saleItems.listPrice,
      discount: t.saleItems.discount,
      finalPrice: t.saleItems.finalPrice,
    })
    .from(t.saleItems)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.saleItems.itemId))
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .where(eq(t.saleItems.saleId, id))
    .orderBy(t.saleItems.id);

  const copy = await ctx.db.transaction(async (tx) => {
    // The original: the cashier who completed the sale, in that same session, once.
    const mayPrintOriginal = !row.originalPrintedAt && row.cashierId === actor.userId && !!actor.sessionId && row.sessionId === actor.sessionId;
    if (mayPrintOriginal) {
      const claimed = await tx
        .update(t.sales)
        .set({ originalPrintedAt: new Date() })
        .where(and(eq(t.sales.id, id), isNull(t.sales.originalPrintedAt)))
        .returning({ id: t.sales.id });
      if (claimed.length) return null;
    }
    if (!can(actor, 'sales.reprint')) {
      throw new AppError(403, 'REPRINT_NOT_ALLOWED', 'This invoice was already printed. Ask a manager to reprint it.');
    }
    const [r] = await tx
      .update(t.sales)
      .set({ reprintCount: sql`${t.sales.reprintCount} + 1` })
      .where(eq(t.sales.id, id))
      .returning({ n: t.sales.reprintCount });
    const printedAt = new Date();
    await writeAudit(tx, actor, {
      action: 'INVOICE_REPRINTED',
      entityType: 'sale',
      entityId: row.number,
      branchId: row.branchId,
      key: '{username} reprinted invoice {number} (copy {n})',
      params: { username: actor.username, number: row.number, n: r.n },
      metadata: { reprintCount: r.n },
    });
    return { n: r.n, printedAt };
  });

  const document = buildInvoicePrintData(
    {
      number: row.number,
      createdAt: row.createdAt,
      status: row.status,
      voidReason: row.voidReason,
      branch: { name: row.branchName, nameAr: row.branchNameAr, address: row.branchAddress, phone: row.branchPhone },
      cashier: { name: row.cashierName, nameAr: row.cashierNameAr },
      customer: { name: row.customerName, nameAr: row.customerNameAr, phone: row.customerPhone },
      subtotal: row.subtotal,
      discountTotal: row.discountTotal,
      total: row.total,
      paymentMethod: row.paymentMethod,
      hasadInvoiceRef: row.paymentRefInvoice,
      hasadTransactionRef: row.paymentRefTransaction,
      bankTransferRef: row.paymentRefTransaction,
      lines,
    },
    copy,
  );
  return { document, layout: await printLayout(ctx) };
}
