import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ChevronRight, FileText, Printer } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, money, pct } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Button, Card, CardHeader, Dialog, ErrorState, Field, KeyValue, Loading, Mono, PageHeader, StatusBadge, Textarea } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect, DateRange, useRangeParams } from '../../components/Filters';
import { InvoiceDocument, type SaleDetail } from '../../components/InvoiceDocument';

export interface SaleRow {
  id: number;
  number: string;
  createdAt: string;
  branchId: number;
  branchName: string;
  cashierId: number;
  cashierName: string;
  customerName: string | null;
  itemCount: number;
  weightMg: number;
  subtotal: number;
  discountTotal: number;
  total: number;
  costTotal?: number;
  grossProfit?: number;
  paymentMethod: string;
  status: string;
}

export function SalesTable({ branchId, from, to, mine, toolbar }: { branchId?: number; from: string; to: string; mine?: boolean; toolbar?: React.ReactNode }) {
  const { t, lang } = useI18n();
  const { can, isGlobal } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['sales', branchId, from, to, mine], queryFn: () => get<SaleRow[]>('/sales', { branchId, from, to, mine }) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data!;
  const done = rows.filter((r) => r.status === 'COMPLETED');
  const profit = can('profit.view');
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/sales/${r.id}`)}
      exportName="sales"
      toolbar={toolbar}
      emptyTitle="No sales in this period"
      rowClassName={(r) => (r.status === 'VOIDED' ? 'opacity-60' : undefined)}
      columns={[
        { key: 'number', header: t('Invoice'), render: (r) => <Mono className="font-semibold text-ink-900">{r.number}</Mono> },
        { key: 'createdAt', header: t('Date'), render: (r) => dateTime(r.createdAt, lang) },
        ...(isGlobal && !branchId ? [{ key: 'branchName', header: t('Branch') }] : []),
        { key: 'cashierName', header: t('Cashier') },
        { key: 'customerName', header: t('Customer'), render: (r) => r.customerName ?? <span className="text-ink-400">Walk-in</span> },
        { key: 'itemCount', header: t('Items'), align: 'end', footer: done.reduce((s, r) => s + r.itemCount, 0) },
        { key: 'weightMg', header: t('Net weight'), align: 'end', render: (r) => <span className="num">{grams(r.weightMg)}</span>, footer: grams(done.reduce((s, r) => s + r.weightMg, 0)) },
        { key: 'total', header: t('Total'), align: 'end', render: (r) => <span className="font-medium num">{money(r.total, false)}</span>, footer: money(done.reduce((s, r) => s + r.total, 0), false) },
        ...(profit
          ? [
              { key: 'costTotal', header: 'Cost', align: 'end' as const, render: (r: SaleRow) => <span className="num text-ink-600">{money(r.costTotal, false)}</span>, footer: money(done.reduce((s, r) => s + (r.costTotal ?? 0), 0), false) },
              { key: 'grossProfit', header: t('Gross Profit'), align: 'end' as const, render: (r: SaleRow) => <span className="num text-emerald-700">{money(r.grossProfit, false)}</span>, footer: money(done.reduce((s, r) => s + (r.grossProfit ?? 0), 0), false) },
            ]
          : []),
        { key: 'paymentMethod', header: t('Payment'), render: (r) => <span className="text-[12px] text-ink-600">{t(r.paymentMethod)}</span> },
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
      <PageHeader title={t('Sales')} subtitle="Normal jewelry sales. Click an invoice for items, cost and profit." />
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
  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
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
  const { can, isGlobal } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [printOpen, setPrintOpen] = useState(false);
  const q = useQuery({ queryKey: ['sale', id], queryFn: () => get<SaleDetail>(`/sales/${id}`) });
  const voidM = useMutation({
    mutationFn: () => post(`/sales/${id}/void`, { reason }),
    onSuccess: () => {
      toast.success('Sale cancelled', 'Items returned to AVAILABLE with a RETURN movement.');
      setVoidOpen(false);
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <div className="p-6"><ErrorState error={q.error} /></div>;
  const s = q.data!;
  const profit = can('profit.view');
  const margin = s.grossProfit != null && s.total ? (s.grossProfit / s.total) * 100 : null;

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={
          <Crumbs
            items={[
              ...(isGlobal ? [{ label: 'Company', to: '/overview' }, { label: L(s.branchName, s.branchNameAr), to: `/branches/${s.branchId}` }] : []),
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
        subtitle={`${dateTime(s.createdAt, lang)} · ${L(s.branchName, s.branchNameAr)} · ${s.cashierName}`}
        actions={
          <>
            <Button icon={<Printer className="size-4" />} onClick={() => setPrintOpen(true)}>{t('Print')}</Button>
            {can('sales.void') && s.status === 'COMPLETED' && (
              <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setVoidOpen(true)}>Cancel sale</Button>
            )}
          </>
        }
      />
      {s.status === 'VOIDED' && (
        <Alert tone="danger" className="mb-4" title={`Cancelled ${dateTime(s.voidedAt, lang)} by ${s.voidedByName}`}>
          {s.voidReason}. The items were returned to stock.
        </Alert>
      )}
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card padded={false}>
          <CardHeader title={t('Items')} subtitle={profit ? 'Selling price vs item cost (purchase + making + other)' : undefined} />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-[#f7f8fa] text-ink-500">
                <tr>
                  <th className="px-5 py-2 text-start font-medium">{t('Item')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Net weight')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Price')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Discount')}</th>
                  <th className="px-3 py-2 text-end font-medium">Sold for</th>
                  {profit && (
                    <>
                      <th className="px-3 py-2 text-end font-medium">Purchase</th>
                      <th className="px-3 py-2 text-end font-medium">Making</th>
                      <th className="px-3 py-2 text-end font-medium">Total cost</th>
                      <th className="px-5 py-2 text-end font-medium">Profit</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-2.5">
                      <Link to={`/inventory/${i.itemId}`} className="font-medium text-ink-900 hover:underline">{i.productName}</Link>
                      <div className="font-mono text-[11px] text-ink-500">{i.itemCode} · {i.karat}K · {i.barcode}</div>
                    </td>
                    <td className="px-3 py-2.5 text-end num">{grams(i.netWeightMg)}</td>
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
                { label: t('Payment'), value: t(s.paymentMethod) },
                ...(profit
                  ? [
                      { label: 'Cost of sale', value: money(s.costTotal) },
                      { label: t('Gross Profit'), value: <span className="text-emerald-700">{money(s.grossProfit)} <span className="text-xs text-ink-500">({pct(margin)})</span></span> },
                    ]
                  : []),
              ]}
            />
          </Card>
          <Card>
            <KeyValue
              cols={2}
              items={[
                { label: t('Customer'), value: s.customerName ?? 'Walk-in' },
                { label: 'Phone', value: s.customerPhone ?? '—' },
                { label: t('Cashier'), value: <>{s.cashierName} <div className="font-mono text-[11px] font-normal text-ink-500">{s.cashierUsername}</div></> },
                { label: 'Timestamp', value: dateTime(s.createdAt, lang) },
              ]}
            />
          </Card>
        </div>
      </div>

      <Dialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title={`Cancel sale ${s.number}?`}
        subtitle="The sale stays on record as VOIDED. Items go back to AVAILABLE via a RETURN movement."
        footer={
          <>
            <Button onClick={() => setVoidOpen(false)}>{t('Back')}</Button>
            <Button variant="danger" disabled={reason.trim().length < 3} loading={voidM.isPending} onClick={() => voidM.mutate()}>Cancel sale</Button>
          </>
        }
      >
        <Field label="Reason (recorded in the audit log)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer returned the item the same day" />
        </Field>
      </Dialog>
      <Dialog open={printOpen} onClose={() => setPrintOpen(false)} title={`${t('Invoice')} ${s.number}`} width="max-w-3xl" footer={<Button variant="primary" icon={<Printer className="size-4" />} onClick={() => window.print()}>{t('Print')}</Button>}>
        <InvoiceDocument sale={s} />
      </Dialog>
      {printOpen && (
        <div className="hidden print:fixed print:inset-0 print:z-[200] print:block print:bg-white print:p-8">
          <InvoiceDocument sale={s} />
        </div>
      )}
    </div>
  );
}
