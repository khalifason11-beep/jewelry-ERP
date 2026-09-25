import { Gem } from 'lucide-react';
import { dateTime, grams, karatLabel, money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';

export interface SaleDetail {
  id: number;
  number: string;
  createdAt: string;
  branchId: number;
  branchName: string;
  branchNameAr: string;
  branchCode: string;
  branchAddress: string | null;
  branchPhone: string | null;
  cashierId: number;
  cashierName: string;
  cashierNameAr?: string | null;
  cashierUsername: string;
  customerName: string | null;
  customerPhone: string | null;
  subtotal: number;
  discountTotal: number;
  total: number;
  costTotal?: number;
  grossProfit?: number;
  paymentMethod: string;
  status: string;
  voidedAt: string | null;
  voidReason: string | null;
  voidedByName: string | null;
  items: {
    id: number;
    itemId: number;
    itemCode: string;
    barcode: string;
    productName: string;
    productNameAr?: string | null;
    karat: number;
    netWeightMg: number;
    grossWeightMg: number;
    listPrice: number;
    discount: number;
    finalPrice: number;
    unitCost?: number;
    purchaseCost?: number;
    makingCost?: number;
    otherCost?: number;
    profit?: number;
  }[];
}

/** Printable customer invoice (no cost or profit information). */
export function InvoiceDocument({ sale }: { sale: SaleDetail }) {
  const { t, L, lang } = useI18n();
  const { me } = useAuth();
  const weight = sale.items.reduce((s, i) => s + i.netWeightMg, 0);
  return (
    <div className="print-area mx-auto max-w-[720px] bg-white text-[13px] text-ink-900">
      <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-lg bg-ink-900">
            <Gem className="size-5 text-gold-400" />
          </div>
          <div>
            <div className="text-lg font-semibold">{L(me?.company.name, me?.company.nameAr)}</div>
            <div className="text-ink-500">{L(sale.branchName, sale.branchNameAr)}</div>
            <div className="text-xs text-ink-500">
              {sale.branchAddress} · {sale.branchPhone}
            </div>
          </div>
        </div>
        <div className="text-end">
          <div className="text-xs uppercase tracking-wider text-ink-500">{t('Invoice')}</div>
          <div className="font-mono text-base font-semibold">{sale.number}</div>
          <div className="text-xs text-ink-500">{dateTime(sale.createdAt, lang)}</div>
        </div>
      </div>
      {sale.status === 'VOIDED' && (
        <div className="mt-3 rounded border-2 border-rose-600 px-3 py-2 text-center font-semibold uppercase tracking-wider text-rose-700">
          {t('Cancelled: {reason}', { reason: sale.voidReason ?? '' })}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 py-4 text-[12.5px]">
        <div>
          <div className="text-ink-500">{t('Customer')}</div>
          <div className="font-medium">{sale.customerName || t('Walk-in customer')}</div>
          {sale.customerPhone && <div className="text-ink-500">{sale.customerPhone}</div>}
        </div>
        <div className="text-end">
          <div className="text-ink-500">{t('Cashier')}</div>
          <div className="font-medium">{L(sale.cashierName, sale.cashierNameAr)}</div>
          <div className="text-ink-500">
            {t('Payment')}: {t(sale.paymentMethod)}
          </div>
        </div>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-ink-900/20 text-[11.5px] uppercase tracking-wide text-ink-500">
            <th className="py-2 text-start font-medium">{t('Item')}</th>
            <th className="py-2 text-start font-medium">{t('Karat')}</th>
            <th className="py-2 text-end font-medium">{t('Net weight')}</th>
            <th className="py-2 text-end font-medium">{t('Price')}</th>
            <th className="py-2 text-end font-medium">{t('Discount')}</th>
            <th className="py-2 text-end font-medium">{t('Total')}</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((i) => (
            <tr key={i.id} className="border-b border-ink-900/10">
              <td className="py-2">
                <div className="font-medium">{L(i.productName, i.productNameAr)}</div>
                <div className="font-mono text-[11px] text-ink-500">
                  {i.itemCode} · {i.barcode}
                </div>
              </td>
              <td className="py-2">{karatLabel(i.karat)}</td>
              <td className="py-2 text-end num">{grams(i.netWeightMg)}</td>
              <td className="py-2 text-end num">{money(i.listPrice, false)}</td>
              <td className="py-2 text-end num">{i.discount ? `−${money(i.discount, false)}` : '—'}</td>
              <td className="py-2 text-end font-medium num">{money(i.finalPrice, false)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex justify-end">
        <div className="w-64 space-y-1.5">
          <div className="flex justify-between text-ink-600">
            <span>{t('Net weight')}</span>
            <span className="num">{grams(weight)}</span>
          </div>
          <div className="flex justify-between text-ink-600">
            <span>{t('Subtotal')}</span>
            <span className="num">{money(sale.subtotal)}</span>
          </div>
          {sale.discountTotal > 0 && (
            <div className="flex justify-between text-ink-600">
              <span>{t('Discount')}</span>
              <span className="num">−{money(sale.discountTotal)}</span>
            </div>
          )}
          <div className="flex justify-between border-t-2 border-ink-900 pt-2 text-base font-semibold">
            <span>{t('Total')}</span>
            <span className="num">{money(sale.total)}</span>
          </div>
        </div>
      </div>
      <div className="mt-8 border-t border-dashed border-ink-900/20 pt-3 text-center text-[11px] text-ink-500">
        {t('Thank you for your purchase · Prices include making charges · Prototype document, not a tax invoice')}
      </div>
    </div>
  );
}
