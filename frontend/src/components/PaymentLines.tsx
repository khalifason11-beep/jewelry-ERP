// PAY-1 (D-pay1-1): a sale's payment lines, one per method, with its amount and reference (the Hasad invoice number
// and optional transaction reference; the bank-transfer reference). Shown on the sale, the on-screen invoice and the
// sales list (whose CSV carries the same text).

import { money } from '../lib/format';
import { useI18n } from '../lib/i18n';

export interface PaymentLine {
  method: string;
  amount: number;
  refInvoice?: string | null;
  refTransaction?: string | null;
}

/** "Hasad 1,000,000 (HSD-1 / TX-9) + Cash 500,000": for a list cell and its CSV. */
export function paymentLinesText(lines: readonly PaymentLine[] | undefined, t: (k: string) => string): string {
  return (lines ?? [])
    .map((p) => {
      const ref = [p.refInvoice, p.refTransaction].filter(Boolean).join(' / ');
      return `${t(p.method)} ${money(p.amount, false)}${ref ? ` (${ref})` : ''}`;
    })
    .join(' + ');
}

/** One row per payment line. */
export function PaymentLines({ lines, testId = 'payment-lines' }: { lines: readonly PaymentLine[] | undefined; testId?: string }) {
  const { t } = useI18n();
  if (!lines?.length) return <span>—</span>;
  return (
    <ul className="space-y-0.5" data-testid={testId}>
      {lines.map((p) => (
        <li key={p.method} className="flex flex-wrap justify-between gap-x-3" data-testid="payment-line">
          <span>
            {t(p.method)}
            {p.method === 'HASAD' && p.refInvoice && <span className="ms-1 font-mono text-[11.5px] text-ink-500">{p.refInvoice}{p.refTransaction ? ` / ${p.refTransaction}` : ''}</span>}
            {p.method === 'BANK_TRANSFER' && <span className="ms-1 font-mono text-[11.5px] text-ink-500" data-testid="sale-bank-reference">{p.refTransaction ?? '—'}</span>}
          </span>
          <span className="num">{money(p.amount, false)}</span>
        </li>
      ))}
    </ul>
  );
}
