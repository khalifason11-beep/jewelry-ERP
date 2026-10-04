// Printed invoices (D-print-*). The ONLY shape a printed document is built from. It never carries
// cost, acquisition cost, profit, margin or gold-debt fields, for any role including the General
// Manager: excluded by the input type (such keys are typed `never`) and by a runtime sweep of both the
// input and the output (`assertPrintable`).

import { COST_RESPONSE_FIELDS } from './field-classification';
import type { InvoiceFormat } from './enums';

/** Field names a printed document may never contain (cost registry + gold debt). */
export function isPrintForbiddenField(name: string): boolean {
  return COST_RESPONSE_FIELDS.has(name) || /cost|profit|margin|owed|debt/i.test(name);
}

type CostKeys =
  | 'cost'
  | 'costs'
  | 'unitCost'
  | 'costTotal'
  | 'totalCost'
  | 'purchaseCost'
  | 'makingCost'
  | 'otherCost'
  | 'acquisitionCost'
  | 'grossProfit'
  | 'profit'
  | 'margin'
  | 'goldOwedMgPure24'
  | 'goldDebtMgPure24';
/** Any object that carries one of these keys is not assignable to a print input. */
type NoCost = { [K in CostKeys]?: never };

export interface PrintableSaleLine extends NoCost {
  code: string;
  name: string;
  nameAr: string | null;
  karat: number;
  netWeightMg: number;
  listPrice: number;
  discount: number;
  finalPrice: number;
}

export interface PrintableSale extends NoCost {
  number: string;
  createdAt: Date | string;
  status: string;
  voidReason: string | null;
  branch: { name: string; nameAr: string | null; address: string | null; phone: string | null } & NoCost;
  cashier: { name: string; nameAr: string | null } & NoCost;
  customer: { name: string | null; nameAr: string | null; phone: string | null } & NoCost;
  subtotal: number;
  discountTotal: number;
  total: number;
  paymentMethod: string;
  hasadInvoiceRef: string | null;
  hasadTransactionRef: string | null;
  lines: PrintableSaleLine[];
}

export interface InvoicePrintData {
  kind: 'INVOICE';
  number: string;
  issuedAt: string;
  status: string;
  voidReason: string | null;
  branch: { name: string; nameAr: string | null; address: string | null; phone: string | null };
  cashier: { name: string; nameAr: string | null };
  customer: { name: string | null; nameAr: string | null; phone: string | null };
  lines: { code: string; name: string; nameAr: string | null; karat: number; netWeightMg: number; listPrice: number; discount: number; finalPrice: number }[];
  netWeightMg: number;
  subtotal: number;
  discountTotal: number;
  total: number;
  paymentMethod: string;
  /** Only when the payment method is HASAD. */
  hasad: { invoiceRef: string | null; transactionRef: string | null } | null;
  /** null = the original; otherwise the reprint number and when it was printed. */
  copy: { n: number; printedAt: string } | null;
}

export interface PrintLayout {
  format: InvoiceFormat;
  /** RECEIPT: printable width in mm (48–80). */
  receiptWidthMm: number;
}

/** Throws if any key at any depth is a cost / profit / gold-debt field. */
export function assertPrintable(value: unknown, where = 'print data'): void {
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!v || typeof v !== 'object' || v instanceof Date) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isPrintForbiddenField(k)) throw new Error(`${where}: forbidden field ${path}.${k}`);
      walk(x, `${path}.${k}`);
    }
  };
  walk(value, '');
}

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

/**
 * Build the printed invoice. Fields are copied one by one from a whitelist (nothing is spread), and
 * both the input and the result are swept at run time.
 */
export function buildInvoicePrintData(sale: PrintableSale, copy: { n: number; printedAt: Date | string } | null = null): InvoicePrintData {
  assertPrintable(sale, 'print input');
  const lines = sale.lines.map((l) => ({
    code: l.code,
    name: l.name,
    nameAr: l.nameAr,
    karat: l.karat,
    netWeightMg: l.netWeightMg,
    listPrice: l.listPrice,
    discount: l.discount,
    finalPrice: l.finalPrice,
  }));
  const data: InvoicePrintData = {
    kind: 'INVOICE',
    number: sale.number,
    issuedAt: iso(sale.createdAt),
    status: sale.status,
    voidReason: sale.voidReason,
    branch: { name: sale.branch.name, nameAr: sale.branch.nameAr, address: sale.branch.address, phone: sale.branch.phone },
    cashier: { name: sale.cashier.name, nameAr: sale.cashier.nameAr },
    customer: { name: sale.customer.name, nameAr: sale.customer.nameAr, phone: sale.customer.phone },
    lines,
    netWeightMg: lines.reduce((s, l) => s + l.netWeightMg, 0),
    subtotal: sale.subtotal,
    discountTotal: sale.discountTotal,
    total: sale.total,
    paymentMethod: sale.paymentMethod,
    hasad: sale.paymentMethod === 'HASAD' ? { invoiceRef: sale.hasadInvoiceRef, transactionRef: sale.hasadTransactionRef } : null,
    copy: copy ? { n: copy.n, printedAt: iso(copy.printedAt) } : null,
  };
  assertPrintable(data, 'print output');
  return data;
}

/**
 * CSS @page rule for a layout. A4/A5: 10 mm margins (no browser header/footer fits in them).
 * RECEIPT: the printable width, no margin, and the HEIGHT OF THE CONTENT in mm. Chromium rejects
 * `size: <width> auto` (it is not valid CSS and falls back to US Letter), so the print module measures
 * the rendered receipt and passes its height here (D-print-3).
 */
export function pageRule(layout: PrintLayout, contentHeightMm?: number): string {
  if (layout.format === 'RECEIPT') {
    const h = Math.max(20, Math.ceil(contentHeightMm ?? 200));
    return `@page { size: ${layout.receiptWidthMm}mm ${h}mm; margin: 0; }`;
  }
  return `@page { size: ${layout.format}; margin: 10mm; }`;
}

/** Content width in mm for a layout (A4 210−20, A5 148−20). */
export function contentWidthMm(layout: PrintLayout): number {
  if (layout.format === 'RECEIPT') return layout.receiptWidthMm;
  return layout.format === 'A4' ? 190 : 128;
}
