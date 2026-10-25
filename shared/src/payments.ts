// PAY-1 (D-pay1-1): a sale is paid by one or two payment lines, one per method, summing exactly to its total (whole
// SDG, no rounding). The server and the POS share these rules.

import { PAYMENT_ACCOUNT, type LedgerAccountKind, type PaymentMethod, type SalePaymentLabel } from './enums';

/** A sale has at most this many payment lines (owner, D-dec1-5). */
export const MAX_SALE_PAYMENTS = 2;

export interface SalePaymentLine {
  method: PaymentMethod;
  amount: number;
  /** HASAD: the Hasad invoice number. */
  refInvoice?: string | null;
  /** BANK_TRANSFER: the bank reference; HASAD: the optional transaction reference. */
  refTransaction?: string | null;
}

/** The label stored on the sale: the method of its one line, or SPLIT for two. */
export function salePaymentLabel(methods: readonly PaymentMethod[]): SalePaymentLabel {
  if (methods.length === 1) return methods[0];
  if (methods.length === MAX_SALE_PAYMENTS && methods[0] !== methods[1]) return 'SPLIT';
  throw new RangeError(`a sale has 1 or ${MAX_SALE_PAYMENTS} payment lines of different methods, got ${methods.join(', ') || 'none'}`);
}

/**
 * The POS's second line of a split: what is left of the total after the first part, or null when the first part is not
 * a whole amount strictly between 0 and the total (each part must be more than 0).
 */
export function splitRemainder(total: number, first: number): number | null {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(first) || first <= 0 || first >= total) return null;
  return total - first;
}

/** Σ amounts, exact (integers only). */
export function paymentsSum(lines: readonly Pick<SalePaymentLine, 'amount'>[]): number {
  let s = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount)) throw new RangeError(`payment amount must be a whole number, got ${l.amount}`);
    s += l.amount;
  }
  if (!Number.isSafeInteger(s)) throw new RangeError('payment sum out of range');
  return s;
}

/** The branch account a payment line moves, or null when it moves none (see PAYMENT_ACCOUNT). */
export const paymentAccount = (method: PaymentMethod): LedgerAccountKind | null => PAYMENT_ACCOUNT[method];
