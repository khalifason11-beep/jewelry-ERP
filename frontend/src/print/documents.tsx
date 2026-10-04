// Printed documents (D-print-*). Laid out for the configured paper: A4 / A5 (table) or a thermal
// receipt (stacked lines at the printable width). Black on white, Western digits, the bundled
// Arabic font, long names wrap. Data comes from the server's cost-free print builder.

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import JsBarcode from 'jsbarcode';
import { contentWidthMm, type InvoicePrintData, type PrintLayout } from '@jerp/shared';
import { useBranding } from '../lib/branding';
import { dateTime, grams, karatLabel, money } from '../lib/format';
import { useI18n } from '../lib/i18n';

/** Code128 barcode as inline SVG (no script, no network: CSP-safe). */
export function Barcode({ value, className = 'pd-barcode' }: { value: string; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, { format: 'CODE128', displayValue: true, font: 'IBM Plex Mono', fontSize: 14, margin: 0, height: 48, width: 1.6 });
    } catch {
      /* unencodable value: leave the text below */
    }
  }, [value]);
  return <svg ref={ref} className={className} data-barcode={value} preserveAspectRatio="xMidYMid meet" />;
}

function Doc({ layout, children }: { layout: PrintLayout; children: ReactNode }) {
  const cls = layout.format === 'RECEIPT' ? 'pd pd-receipt' : layout.format === 'A5' ? 'pd pd-a5' : 'pd';
  return (
    <div className={cls} data-doc-format={layout.format}>
      {children}
    </div>
  );
}

/** Logo, company name, branch block. */
export function PrintHeader({ branch }: { branch?: { name: string; nameAr: string | null; address: string | null; phone: string | null } }) {
  const { L } = useI18n();
  const b = useBranding();
  return (
    <div className="pd-center">
      {b.logoUrl && <img src={b.logoUrl} alt="" className="pd-logo" />}
      <div className="pd-big">{L(b.company.nameEn, b.company.nameAr)}</div>
      {branch && (
        <>
          <div className="pd-strong">{L(branch.name, branch.nameAr)}</div>
          {(branch.address || branch.phone) && (
            <div className="pd-muted">
              {branch.address}
              {branch.address && branch.phone ? ' · ' : ''}
              {branch.phone && <span className="pd-num">{branch.phone}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function PrintFooter() {
  const { L } = useI18n();
  const b = useBranding();
  const text = L(b.invoiceFooterEn, b.invoiceFooterAr);
  return text ? (
    <>
      <div className="pd-rule" />
      <div className="pd-center pd-muted">{text}</div>
    </>
  ) : null;
}

function Row({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className={`pd-row${strong ? ' pd-big' : ''}`}>
      <span>{label}</span>
      <span className="pd-num">{value}</span>
    </div>
  );
}

/** Customer invoice: never any cost, profit or gold-debt field (the data cannot carry them). */
export function InvoicePrint({ doc, layout }: { doc: InvoicePrintData; layout: PrintLayout }) {
  const { t, L, lang } = useI18n();
  const receipt = layout.format === 'RECEIPT';
  return (
    <Doc layout={layout}>
      <PrintHeader branch={doc.branch} />
      <div className="pd-rule-solid" />
      <div className="pd-row">
        <span className="pd-strong">{t('Invoice')}</span>
        <span className="pd-mono pd-strong">{doc.number}</span>
      </div>
      <Row label={t('Date')} value={dateTime(doc.issuedAt, lang)} />
      {doc.copy && (
        <div className="pd-mark" data-testid="print-copy-mark">
          {t('COPY {n}', { n: doc.copy.n })}
          <div className="pd-muted">{t('Reprinted {date}', { date: dateTime(doc.copy.printedAt, lang) })}</div>
        </div>
      )}
      {doc.status === 'VOIDED' && <div className="pd-mark">{t('Cancelled: {reason}', { reason: doc.voidReason ?? '' })}</div>}
      <Row label={t('Customer')} value={<span>{doc.customer.name ? L(doc.customer.name, doc.customer.nameAr) : t('Walk-in customer')}</span>} />
      {doc.customer.phone && <Row label={t('Phone')} value={doc.customer.phone} />}
      <Row label={t('Cashier')} value={<span>{L(doc.cashier.name, doc.cashier.nameAr)}</span>} />
      <div className="pd-rule" />

      {receipt ? (
        <div>
          {doc.lines.map((l, i) => (
            <div key={i} className="pd-line">
              <div className="pd-strong">{L(l.name, l.nameAr)}</div>
              <div className="pd-row pd-muted">
                <span>
                  <span className="pd-mono">{l.code}</span> · {karatLabel(l.karat)} · <span className="pd-num">{grams(l.netWeightMg)}</span>
                </span>
                <span className="pd-num">{money(l.listPrice, false)}</span>
              </div>
              {l.discount > 0 && <Row label={t('Discount')} value={`−${money(l.discount, false)}`} />}
              {l.discount > 0 && <Row label={t('Total')} value={money(l.finalPrice, false)} />}
            </div>
          ))}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('Code')}</th>
              <th>{t('Description')}</th>
              <th>{t('Karat')}</th>
              <th className="pd-end">{t('Net weight')}</th>
              <th className="pd-end">{t('Price')}</th>
              <th className="pd-end">{t('Discount')}</th>
              <th className="pd-end">{t('Total')}</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, i) => (
              <tr key={i}>
                <td className="pd-mono">{l.code}</td>
                <td>{L(l.name, l.nameAr)}</td>
                <td>{karatLabel(l.karat)}</td>
                <td className="pd-end pd-num">{grams(l.netWeightMg)}</td>
                <td className="pd-end pd-num">{money(l.listPrice, false)}</td>
                <td className="pd-end pd-num">{l.discount ? `−${money(l.discount, false)}` : '—'}</td>
                <td className="pd-end pd-num">{money(l.finalPrice, false)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={receipt ? undefined : { width: '45%', marginInlineStart: 'auto', marginTop: '3mm' }}>
        <Row label={t('Net weight')} value={grams(doc.netWeightMg)} />
        <Row label={t('Subtotal')} value={money(doc.subtotal)} />
        {doc.discountTotal > 0 && <Row label={t('Discount')} value={`−${money(doc.discountTotal)}`} />}
        <div className="pd-rule-solid" />
        <Row label={t('Total')} value={money(doc.total)} strong />
        <Row label={t('Payment method')} value={<span>{t(doc.paymentMethod)}</span>} />
        {doc.hasad && (
          <>
            <Row label={t('Hasad invoice number')} value={<span className="pd-mono">{doc.hasad.invoiceRef ?? '—'}</span>} />
            {doc.hasad.transactionRef && <Row label={t('Hasad transaction reference')} value={<span className="pd-mono">{doc.hasad.transactionRef}</span>} />}
          </>
        )}
      </div>
      <Barcode value={doc.number} />
      <PrintFooter />
    </Doc>
  );
}

/** Recovery codes of the signed-in user (always A4; never sent anywhere). */
export function RecoveryCodesPrint({ codes, username }: { codes: string[]; username: string }) {
  const { t, lang } = useI18n();
  return (
    <Doc layout={{ format: 'A4', receiptWidthMm: 72 }}>
      <PrintHeader />
      <div className="pd-rule-solid" />
      <div className="pd-big">{t('Recovery codes')}</div>
      <div>
        {t('Account')}: <span className="pd-mono">{username}</span> · {dateTime(new Date(), lang)}
      </div>
      <div className="pd-muted">{t('Each code works once. Keep this sheet somewhere safe, away from the computer.')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3mm', margin: '6mm 0' }}>
        {codes.map((c) => (
          <div key={c} className="pd-mono pd-big pd-center" style={{ border: '1px solid #000', padding: '2mm' }}>
            {c}
          </div>
        ))}
      </div>
    </Doc>
  );
}

/** Calibration page (Settings › Printing › Test print): ruler, Arabic, digits, wrapping, logo, barcode. */
export function CalibrationPrint({ layout }: { layout: PrintLayout }) {
  const { t, lang } = useI18n();
  const width = contentWidthMm(layout);
  const ticks = Array.from({ length: Math.floor(width) + 1 }, (_, i) => i);
  return (
    <Doc layout={layout}>
      <PrintHeader />
      <div className="pd-rule-solid" />
      <div className="pd-strong pd-center">{t('Printer test page')}</div>
      <div className="pd-center pd-muted">
        {layout.format === 'RECEIPT' ? t('Receipt, printable width {mm} mm', { mm: layout.receiptWidthMm }) : layout.format} · {dateTime(new Date(), lang)}
      </div>
      <div className="pd-muted" style={{ marginTop: '2mm' }}>
        {t('The ruler must end exactly at the right and left edges of the paper. If the last numbers are cut off, the width is too large; if there is a blank strip, it is too small.')}
      </div>
      {/* Ruler: one tick per mm, longer every 5 mm, numbers every 10 mm. Always laid out left to right. */}
      {/* On a receipt the ruler cancels the 1.5 mm inner padding so it spans exactly the printable width. */}
      <div
        dir="ltr"
        data-testid="print-ruler"
        className={layout.format === 'RECEIPT' ? 'pd-ruler-bleed' : undefined}
        style={{ position: 'relative', width: `${width}mm`, height: '9mm', marginTop: '2mm', borderBottom: '1px solid #000' }}
      >
        {ticks.map((mm) => (
          <div key={mm} style={{ position: 'absolute', left: `${mm}mm`, bottom: 0, width: 0, height: mm % 10 === 0 ? '5mm' : mm % 5 === 0 ? '3.5mm' : '2mm', borderLeft: '0.3mm solid #000' }} />
        ))}
        {ticks
          .filter((mm) => mm % 10 === 0)
          .map((mm) => (
            <div key={`n${mm}`} className="pd-num pd-tick" data-mid={mm === 0 ? undefined : ''} style={{ left: `${mm}mm` }}>
              {mm}
            </div>
          ))}
      </div>
      <div className="pd-rule" />
      <div className="pd-strong">{t('Arabic text')}</div>
      <div>بسم الله الرحمن الرحيم — فاتورة بيع ذهب عيار 21، الوزن الصافي 12.345 جرام.</div>
      <div className="pd-strong" style={{ marginTop: '2mm' }}>{t('Digits')}</div>
      <div className="pd-num">0123456789 · 1,234,567.89 · 12.345 g</div>
      <div className="pd-strong" style={{ marginTop: '2mm' }}>{t('Long line (must wrap, not be cut)')}</div>
      <div>طقم ذهب عيار 21 مشغول يدوياً مع فصوص زركون ونقشة سودانية تقليدية — اسم منتج طويل جداً للتحقق من التفاف السطر داخل عرض الورقة.</div>
      <Barcode value="TEST-0123456789" />
      <PrintFooter />
    </Doc>
  );
}

export interface HasadReceiptData {
  number: string;
  completedAt: string;
  branch: { name: string; nameAr: string | null };
  cashierName: string;
  customer: { name: string; nameAr: string | null; externalId: string };
  entitledWeightMg: number;
  deliveredWeightMg: number;
  differenceMg: number;
  direction: string;
  ratePerGram: number;
  amount: number;
  settlement: { number: string; paymentMethod: string } | null;
  items: { code: string; name: string; nameAr: string | null; karat: number; netWeightMg: number }[];
}

/** Hasad Gold delivery receipt (signed by the customer). Built from a whitelist: no cost field. */
export function HasadReceiptPrint({ data, layout }: { data: HasadReceiptData; layout: PrintLayout }) {
  const { t, L, lang } = useI18n();
  const signed = (mg: number) => `${mg > 0 ? '+' : mg < 0 ? '−' : ''}${grams(Math.abs(mg))}`;
  return (
    <Doc layout={layout}>
      <PrintHeader branch={{ ...data.branch, address: null, phone: null }} />
      <div className="pd-rule-solid" />
      <div className="pd-row">
        <span className="pd-strong">{t('Hasad Gold delivery')}</span>
        <span className="pd-mono pd-strong">{data.number}</span>
      </div>
      <Row label={t('Date')} value={dateTime(data.completedAt, lang)} />
      <Row label={t('Customer')} value={<span>{L(data.customer.name, data.customer.nameAr)}</span>} />
      <Row label={t('Hasad request')} value={<span className="pd-mono">{data.customer.externalId}</span>} />
      <Row label={t('Cashier')} value={<span>{data.cashierName}</span>} />
      <div className="pd-rule" />
      {data.items.map((i, n) => (
        <div key={n} className="pd-line">
          <div className="pd-strong">{L(i.name, i.nameAr)}</div>
          <div className="pd-row pd-muted">
            <span>
              <span className="pd-mono">{i.code}</span> · {karatLabel(i.karat)}
            </span>
            <span className="pd-num">{grams(i.netWeightMg)}</span>
          </div>
        </div>
      ))}
      <div className="pd-rule" />
      <Row label={t('Entitled weight')} value={grams(data.entitledWeightMg)} />
      <Row label={t('Delivered weight')} value={grams(data.deliveredWeightMg)} />
      <Row label={t('Difference')} value={signed(data.differenceMg)} />
      {data.direction !== 'NONE' && (
        <>
          <Row label={t('Rate per gram')} value={money(data.ratePerGram, false)} />
          <Row label={t(data.direction)} value={money(data.amount)} strong />
        </>
      )}
      {data.settlement && <Row label={t('Settlement')} value={<span><span className="pd-mono">{data.settlement.number}</span> · {t(data.settlement.paymentMethod)}</span>} />}
      <div style={{ marginTop: '8mm' }} className="pd-row">
        <span>{t('Customer signature')}: ____________</span>
      </div>
      <Barcode value={data.number} />
      <PrintFooter />
    </Doc>
  );
}
