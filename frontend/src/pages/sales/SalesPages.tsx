import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ChevronRight, FileText, Printer } from 'lucide-react';
import { get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, karatLabel, money, pct } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Button, Card, CardHeader, DetailPending, Dialog, Field, KeyValue, Mono, PageHeader, StatusBadge, Textarea } from '../../components/ui';
import { useServerList } from '../../lib/paging';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect, DateRange, useRangeParams } from '../../components/Filters';
import type { SaleDetail } from '../../components/InvoiceDocument';
import { printSaleInvoice } from '../../print/actions';
import { useActionKeys } from '../../lib/idempotency';
import { PaymentLines, paymentLinesText, type PaymentLine } from '../../components/PaymentLines';

export interface SaleRow {
  id: number;
  number: string;
  createdAt: string;
  branchId: number;
  branchName: string;
  cashierId: number;
  cashierName: string;
  customerName: string | null;
  customerNameAr?: string | null;
  itemCount: number;
  weightMg: number;
  /** PRC-1: the rate per gram of the sale's lines when they share one (else null: fixed prices or several rates). */
  pricePerGram?: number | null;
  subtotal: number;
  discountTotal: number;
  total: number;
  costTotal?: number;
  /** OPN-1: lines of unknown cost (opening pieces) left out of cost and profit. */
  unknownCostLines?: number;
  grossProfit?: number | null;
  paymentMethod: string;
  /** FIX-2: the bank-transfer reference (Hasad: its transaction reference). */
  paymentRefTransaction?: string | null;
  /** PAY-1: one line per method. */
  payments?: PaymentLine[];
  status: string;
}

/** Table column → the sales list's server sort key (BE-7). */
const SALE_SORT_KEYS = { number: 'number', createdAt: 'date', branchName: 'branch', cashierName: 'cashier', total: 'total', grossProfit: 'grossProfit' };

export function SalesTable({ branchId, from, to, mine, toolbar }: { branchId?: number; from: string; to: string; mine?: boolean; toolbar?: React.ReactNode }) {
  const { t, L, lang } = useI18n();
  const { can, isGlobal } = useAuth();
  const navigate = useNavigate();
  // Filters stay on screen across reloads: the table shows the states (UI-A2) and keeps the previous rows while a
  // new period or branch loads.
  // BE-7: one page at a time from the server; the footer totals cover the completed sales of the whole result.
  const { query: q, rows, totals, server } = useServerList<SaleRow>('sales', '/sales', { branchId, from, to, mine }, { sortKeys: SALE_SORT_KEYS, search: true });
  const sum = (k: string) => totals?.[k] ?? 0;
  const profit = can('profit.view');
  return (
    <DataTable
      query={q}
      rows={rows}
      server={server}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/sales/${r.id}`)}
      exportName="sales"
      toolbar={toolbar}
      emptyTitle={t('No sales in this period')}
      emptyBody={t('Choose another period above.')}
      rowClassName={(r) => (r.status === 'VOIDED' ? 'opacity-60' : undefined)}
      columns={[
        { key: 'number', header: t('Invoice'), render: (r) => <Mono className="font-semibold text-ink-900">{r.number}</Mono> },
        { key: 'createdAt', header: t('Date'), render: (r) => dateTime(r.createdAt, lang) },
        ...(isGlobal && !branchId ? [{ key: 'branchName', header: t('Branch'), render: (r: SaleRow) => t(r.branchName) }] : []),
        { key: 'cashierName', header: t('Cashier') },
        { key: 'customerName', header: t('Customer'), render: (r) => (r.customerName ? L(r.customerName, r.customerNameAr) : null) ?? <span className="text-ink-400">{t('Walk-in')}</span> },
        { key: 'itemCount', header: t('Items'), align: 'end', footer: sum('itemCount') },
        { key: 'weightMg', header: t('Net weight'), align: 'end', render: (r) => <span className="num">{grams(r.weightMg)}</span>, footer: grams(sum('weightMg')) },
        { key: 'pricePerGram', header: t('Price per gram'), align: 'end', sortable: false, render: (r) => <span className="num" data-testid="sale-per-gram">{money(r.pricePerGram, false)}</span> },
        { key: 'total', header: t('Total'), align: 'end', render: (r) => <span className="font-medium num">{money(r.total, false)}</span>, footer: money(sum('total'), false) },
        ...(profit
          ? [
              { key: 'costTotal', header: t('Cost'), align: 'end' as const, render: (r: SaleRow) => <span className="num text-ink-600">{money(r.costTotal, false)}</span>, footer: money(sum('costTotal'), false) },
              {
                key: 'grossProfit',
                header: t('Gross Profit'),
                align: 'end' as const,
                render: (r: SaleRow) => (
                  <span className="num text-emerald-700" title={r.unknownCostLines ? t('{n} line(s) of unknown cost not counted', { n: r.unknownCostLines }) : undefined}>
                    {money(r.grossProfit, false)}
                    {!!r.unknownCostLines && <span className="ms-1 text-ink-3">*</span>}
                  </span>
                ),
                // OPN-1: the profit of the lines of known cost; how many lines it leaves out (opening pieces).
                footer: (
                  <span data-testid="sales-footer-profit">
                    {money(totals ? (totals.grossProfit ?? null) : 0, false)}
                    {!!totals?.unknownCostLines && <span className="block text-[11.5px] font-normal text-ink-3">{t('{n} line(s) of unknown cost not counted', { n: totals.unknownCostLines })}</span>}
                  </span>
                ),
              },
            ]
          : []),
        {
          key: 'paymentMethod',
          header: t('Payment'),
          // FIX-2 / PAY-1: each payment line with its amount and reference (the CSV too, for the bank statement).
          value: (r) => paymentLinesText(r.payments, t) || t(r.paymentMethod),
          render: (r) => (
            <span className="block text-[12px] text-ink-600" data-testid="sales-payment">
              {r.payments && r.payments.length > 1 ? <PaymentLines lines={r.payments} testId="sales-payment-lines" /> : (
                <>
                  {t(r.paymentMethod)}
                  {r.paymentMethod === 'BANK_TRANSFER' && <span className="block font-mono text-[11px] text-ink-500">{r.paymentRefTransaction ?? '—'}</span>}
                </>
              )}
            </span>
          ),
        },
        { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
      ]}
    />
  );
}

export function SalesPage() {
  const { t } = useI18n();
  const { from, to, branchId, set } = useRangeParams(7);
  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Sales')} />
      <Card padded={false}>
        <SalesTable
          branchId={branchId}
          from={from}
          to={to}
          toolbar={
            <>
              <DateRange from={from} to={to} onChange={(r) => set(r)} />
              <BranchSelect value={branchId} onChange={(v) => set({ branchId: v })} />
            </>
          }
        />
      </Card>
    </div>
  );
}

export function Crumbs({ items }: { items: { label: React.ReactNode; to?: string }[] }) {
  const { t } = useI18n();
  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label={t('Breadcrumb')}>
      {items.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5 text-ink-300 rtl:rotate-180" />}
          {c.to ? (
            <Link to={c.to} className="hover:text-ink-900">
              {c.label}
            </Link>
          ) : (
            <span className="text-ink-700">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function SaleDetailPage() {
  const id = Number(useParams().id);
  const { t, L, lang } = useI18n();
  const { can, isGlobal, me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [printing, setPrinting] = useState(false);
  const q = useQuery({ queryKey: ['sale', id], queryFn: () => get<SaleDetail>(`/sales/${id}`) });
  const actionKeys = useActionKeys();
  const voidM = useMutation({
    mutationFn: () => postOnce(`/sales/${id}/void`, { reason }, actionKeys.for(`void:${id}`)),
    onSuccess: () => {
      actionKeys.rotate(`void:${id}`);
      toast.success(t('Sale cancelled'), t('The pieces are back in stock.'));
      setVoidOpen(false);
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  if (!q.data) return <DetailPending query={q} backTo={can('sales.view') ? '/sales' : '/me'} backLabel={can('sales.view') ? t('Back to sales') : t('Back to my activity')} notFoundTitle={t('This sale does not exist')} />;
  const s = q.data!;
  const profit = can('profit.view');
  // OPN-1: the margin of the lines of known cost (a line of unknown cost has no profit: "—").
  const knownRevenue = s.items.reduce((sum, i) => sum + (i.profit != null ? i.finalPrice : 0), 0);
  const margin = s.grossProfit != null && knownRevenue ? (s.grossProfit / knownRevenue) * 100 : null;

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={
          <Crumbs
            items={[
              ...(isGlobal ? [{ label: t('Company'), to: '/overview' }, { label: L(s.branchName, s.branchNameAr), to: `/branches/${s.branchId}` }] : []),
              { label: t('Sales'), to: can('sales.view') ? '/sales' : '/me' },
              { label: s.number },
            ]}
          />
        }
        title={
          <span className="flex items-center gap-3">
            <FileText className="size-5 text-ink-400" /> {t('Invoice')} <Mono className="text-xl">{s.number}</Mono> <StatusBadge status={s.status} />
          </span>
        }
        subtitle={`${dateTime(s.createdAt, lang)} · ${L(s.branchName, s.branchNameAr)} · ${L(s.cashierName, s.cashierNameAr)}`}
        actions={
          <>
            <Button
              icon={<Printer className="size-4" />}
              loading={printing}
              data-testid="sale-print"
              title={s.reprintCount ? t('Printed copies so far: {n}', { n: s.reprintCount }) : undefined}
              onClick={async () => {
                setPrinting(true);
                const r = await printSaleInvoice(s.id);
                setPrinting(false);
                if (!r.ok) toast.fromError(r.error, t('Printing failed'));
                qc.invalidateQueries({ queryKey: ['sale', id] });
              }}
            >
              {can('sales.reprint') && (s.originalPrintedAt || s.reprintCount) ? t('Reprint') : t('Print')}
            </Button>
            {can('sales.void') && s.status === 'COMPLETED' && (
              <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setVoidOpen(true)} data-testid="sale-void">{t('Cancel sale')}</Button>
            )}
          </>
        }
      />
      {s.status === 'VOIDED' && (
        <Alert tone="danger" className="mb-4" title={t('Cancelled {when} by {name}', { when: dateTime(s.voidedAt, lang), name: s.voidedByName ?? '' })}>
          {t('{reason}. The items were returned to stock.', { reason: s.voidReason ?? '' })}
        </Alert>
      )}
      {s.priceChangeReason && (
        <Alert tone="info" className="mb-4" title={t('Price changed at sale')}>
          <span data-testid="sale-price-change-reason">{t('Reason: {reason}', { reason: s.priceChangeReason })}</span>{' '}
          <span className="text-ink-500">{t('(internal: not printed on the invoice)')}</span>
        </Alert>
      )}
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card padded={false}>
          <CardHeader title={t('Items')} />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-[#f7f8fa] text-ink-500">
                <tr>
                  <th className="px-5 py-2 text-start font-medium">{t('Item')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Net weight')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Price per gram')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Price')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Discount')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Sold for')}</th>
                  {profit && (
                    <>
                      <th className="px-3 py-2 text-end font-medium">{t('Purchase')}</th>
                      <th className="px-3 py-2 text-end font-medium">{t('Making')}</th>
                      <th className="px-3 py-2 text-end font-medium">{t('Total cost')}</th>
                      <th className="px-5 py-2 text-end font-medium">{t('Profit')}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-2.5">
                      <Link to={`/inventory/${i.itemId}`} className="font-medium text-ink-900 hover:underline">{L(i.productName, i.productNameAr)}</Link>
                      <div className="font-mono text-[11px] text-ink-500">{i.itemCode} · {karatLabel(i.karat)} · {i.barcode}</div>
                    </td>
                    <td className="px-3 py-2.5 text-end num">{grams(i.netWeightMg)}</td>
                    <td className="px-3 py-2.5 text-end num">{money(i.priceRatePerGram, false)}</td>
                    <td className="px-3 py-2.5 text-end num">{money(i.listPrice, false)}</td>
                    <td className="px-3 py-2.5 text-end num">{i.discount ? money(i.discount, false) : '—'}</td>
                    <td className="px-3 py-2.5 text-end font-medium num">{money(i.finalPrice, false)}</td>
                    {profit && (
                      <>
                        <td className="px-3 py-2.5 text-end text-ink-600 num">{money(i.purchaseCost, false)}</td>
                        <td className="px-3 py-2.5 text-end text-ink-600 num">{money((i.makingCost ?? 0) + (i.otherCost ?? 0), false)}</td>
                        <td className="px-3 py-2.5 text-end num">{money(i.unitCost, false)}</td>
                        <td className="px-5 py-2.5 text-end font-medium text-emerald-700 num">{money(i.profit, false)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <KeyValue
              cols={2}
              items={[
                { label: t('Subtotal'), value: money(s.subtotal) },
                { label: t('Discount'), value: money(s.discountTotal) },
                { label: t('Total'), value: <span className="text-lg">{money(s.total)}</span> },
                // PAY-1: one row per payment line (method, amount, reference); FIX-2's bank reference is on its line.
                { label: t('Payment'), value: <PaymentLines lines={s.payments} testId="sale-payment-lines" /> },
                ...(profit
                  ? [
                      { label: t('Cost of sale'), value: money(s.costTotal) },
                      { label: t('Gross Profit'), value: <span className="text-emerald-700">{money(s.grossProfit)} <span className="text-xs text-ink-500">({pct(margin)})</span></span> },
                      ...(s.unknownCostLines
                        ? [{ label: t('Lines of unknown cost'), value: <span data-testid="sale-unknown-cost">{t('{n} line(s) of unknown cost not counted', { n: s.unknownCostLines })}</span> }]
                        : []),
                    ]
                  : []),
              ]}
            />
          </Card>
          <Card>
            <KeyValue
              cols={2}
              items={[
                { label: t('Customer'), value: s.customerName ? L(s.customerName, s.customerNameAr) : t('Walk-in') },
                { label: t('Phone'), value: s.customerPhone ?? '—' },
                { label: t('Cashier'), value: <>{L(s.cashierName, s.cashierNameAr)} <div className="font-mono text-[11px] font-normal text-ink-500">{s.cashierUsername}</div></> },
                { label: t('Timestamp'), value: dateTime(s.createdAt, lang) },
              ]}
            />
          </Card>
        </div>
      </div>

      <Dialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title={t('Cancel sale {number}?', { number: s.number })}
        subtitle={t('The sale stays on record as cancelled; its pieces go back to stock.')}
        footer={
          <>
            <Button onClick={() => setVoidOpen(false)}>{t('Back')}</Button>
            <Button variant="danger-solid" disabled={reason.trim().length < 3} loading={voidM.isPending} onClick={() => voidM.mutate()} data-testid="void-confirm">{t('Cancel sale')}</Button>
          </>
        }
      >
        <Field label={t('Reason (recorded in the audit log)')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('e.g. Customer returned the item the same day')} data-testid="void-reason" />
        </Field>
        {/* PAY-1 (owner Q4): the Hasad part was paid to the General Manager's account; the void returns none of it. */}
        {(() => {
          const toGm = (s.payments ?? []).filter((p) => p.method === 'HASAD').reduce((a, p) => a + p.amount, 0);
          const back = (s.payments ?? []).filter((p) => p.method !== 'HASAD');
          return (
            <>
              {back.length > 0 && toGm > 0 && (
                <p className="mt-2 text-meta text-ink-600" data-testid="void-refund-parts">
                  {t('Refunded by the branch: {parts}', { parts: back.map((p) => `${t(p.method)} ${money(p.amount, false)}`).join(' + ') })}
                </p>
              )}
              {toGm > 0 && (
                <Alert tone="warning" className="mt-2">
                  <span data-testid="void-hasad-note">
                    {t('{amount} of this sale was paid through Hasad to the General Manager\'s account. Cancelling does not return it: the General Manager refunds the customer through Hasad, outside the system.', { amount: money(toGm) })}
                  </span>
                </Alert>
              )}
            </>
          );
        })()}
        {/* SEC-2 (D-sec2-1): the server asks; this only says so in advance. */}
        {me && (me.voidReauthAboveAmount === 0 || s.total > me.voidReauthAboveAmount) && (
          <p className="mt-2 text-meta text-ink-500" data-testid="void-reauth-hint">{t('You will be asked for your password to confirm.')}</p>
        )}
      </Dialog>
    </div>
  );
}
