// Print actions shared by the screens (D-print-*).

import type { InvoicePrintData, PrintLayout } from '@jerp/shared';
import { post } from '../lib/api';
import { printDocument } from '../lib/print';
import { InvoicePrint } from './documents';

export type PrintOutcome = { ok: true; copy: number | null } | { ok: false; error: unknown };

/**
 * Ask the server for the invoice (it decides original vs reprint, counts and audits), then print it.
 * Never throws: a failed print never affects the sale.
 */
export async function printSaleInvoice(saleId: number): Promise<PrintOutcome> {
  try {
    const r = await post<{ document: InvoicePrintData; layout: PrintLayout }>(`/sales/${saleId}/print`);
    const shown = await printDocument({ layout: r.layout, content: <InvoicePrint doc={r.document} layout={r.layout} /> });
    if (!shown) return { ok: false, error: new Error('The print window could not be opened. The sale is saved.') };
    return { ok: true, copy: r.document.copy?.n ?? null };
  } catch (error) {
    return { ok: false, error };
  }
}
