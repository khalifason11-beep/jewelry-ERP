import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, money } from '../../lib/format';
import { useBranches, useGoldRates } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Button, Card, CardHeader, Dialog, ErrorState, Field, Input, KeyValue, Loading, Mono, PageHeader, Select, StatusBadge } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect, DateRange, useRangeParams } from '../../components/Filters';
import { Crumbs } from '../sales/SalesPages';

interface PurchaseRow {
  id: number;
  number: string;
  createdAt: string;
  branchId: number;
  branchName: string;
  supplierName: string | null;
  supplierInvoiceNo: string | null;
  itemCount: number;
  totalNetWeightMg: number;
  totalCost: number;
  createdByName: string;
  status: string;
}

export function PurchasesTable({ branchId, from, to, toolbar }: { branchId?: number; from: string; to: string; toolbar?: React.ReactNode }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['purchases', branchId, from, to], queryFn: () => get<PurchaseRow[]>('/purchases', { branchId, from, to }) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data!;
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/purchases/${r.id}`)}
      exportName="purchases"
      toolbar={toolbar}
      emptyTitle={t('No purchases in this period')}
      columns={[
        { key: 'number', header: t('Purchase'), render: (r) => <Mono className="font-semibold text-ink-900">{r.number}</Mono> },
        { key: 'createdAt', header: t('Date'), render: (r) => dateTime(r.createdAt, lang) },
        { key: 'branchName', header: t('Branch'), render: (r) => t(r.branchName) },
        { key: 'supplierName', header: t('Supplier') },
        { key: 'supplierInvoiceNo', header: t('Supplier invoice'), render: (r) => <Mono className="text-ink-500">{r.supplierInvoiceNo ?? '—'}</Mono> },
        { key: 'itemCount', header: t('Items'), align: 'end', footer: rows.reduce((s, r) => s + r.itemCount, 0) },
        { key: 'totalNetWeightMg', header: t('Net weight'), align: 'end', render: (r) => <span className="num">{grams(r.totalNetWeightMg)}</span>, footer: grams(rows.reduce((s, r) => s + r.totalNetWeightMg, 0)) },
        { key: 'totalCost', header: t('Total cost'), align: 'end', render: (r) => <span className="font-medium num">{money(r.totalCost, false)}</span>, footer: money(rows.reduce((s, r) => s + r.totalCost, 0), false) },
        { key: 'createdByName', header: t('Received by') },
      ]}
    />
  );
}

export function PurchasesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { from, to, branchId, set } = useRangeParams(30);
  const [open, setOpen] = useState(false);
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Purchases')}
        subtitle={t('Stock received from suppliers. Each line creates one uniquely identified piece.')}
        actions={can('purchases.create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>{t('New purchase')}</Button>}
      />
      <Card padded={false}>
        <PurchasesTable branchId={branchId} from={from} to={to} toolbar={<><DateRange from={from} to={to} onChange={(r) => set(r)} /><BranchSelect value={branchId} onChange={(v) => set({ branchId: v })} /></>} />
      </Card>
      {open && <NewPurchaseDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

interface Line {
  productId: number | '';
  gross: string;
  net: string;
  purchaseCost: string;
  makingCost: string;
  otherCost: string;
  sellingPrice: string;
}
const emptyLine = (): Line => ({ productId: '', gross: '', net: '', purchaseCost: '', makingCost: '', otherCost: '0', sellingPrice: '' });

function NewPurchaseDialog({ onClose }: { onClose: () => void }) {
  const { me, isGlobal } = useAuth();
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const branches = useBranches();
  const rates = useGoldRates();
  const products = useQuery({ queryKey: ['products'], queryFn: () => get<{ id: number; sku: string; name: string; nameAr: string; karat: number; categoryCode: string }[]>('/products') });
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => get<{ id: number; name: string }[]>('/suppliers') });
  const [branchId, setBranchId] = useState<number | ''>(me?.user.branch?.id ?? '');
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);

  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const suggest = (i: number, l: Line) => {
    // Pre-fill purchase cost from the current gold rate (editable).
    const p = products.data?.find((x) => x.id === l.productId);
    const net = Number(l.net);
    if (!p || !net) return;
    const rate = rates.data?.current[String(p.karat)]?.pricePerGram ?? 0;
    const purchase = Math.round((net * rate) / 1000) * 1000;
    const making = Math.round((net * 10_000) / 1000) * 1000;
    upd(i, { purchaseCost: String(purchase), makingCost: String(making), sellingPrice: String(Math.round(((purchase + making) * 1.22) / 5000) * 5000) });
  };
  const valid = lines.every((l) => l.productId && Number(l.net) > 0 && Number(l.gross) >= Number(l.net) && Number(l.purchaseCost) > 0 && Number(l.sellingPrice) > 0) && (branchId || !isGlobal);
  const total = lines.reduce((s, l) => s + (Number(l.purchaseCost) || 0) + (Number(l.makingCost) || 0) + (Number(l.otherCost) || 0), 0);

  const m = useMutation({
    mutationFn: () =>
      post<{ id: number; number: string; itemCodes: string[] }>('/purchases', {
        branchId: branchId || undefined,
        supplierId: supplierId || undefined,
        supplierInvoiceNo: invoiceNo || undefined,
        lines: lines.map((l) => ({
          productId: Number(l.productId),
          grossWeightMg: Math.round(Number(l.gross) * 1000),
          netWeightMg: Math.round(Number(l.net) * 1000),
          purchaseCost: Number(l.purchaseCost),
          makingCost: Number(l.makingCost) || 0,
          otherCost: Number(l.otherCost) || 0,
          sellingPrice: Number(l.sellingPrice),
        })),
      }),
    onSuccess: (p) => {
      toast.success(t('Purchase {number} received', { number: p.number }), t('{n} piece(s) now AVAILABLE: {codes}', { n: p.itemCodes.length, codes: p.itemCodes.join('، ') }));
      qc.invalidateQueries();
      onClose();
      navigate(`/purchases/${p.id}`);
    },
    onError: (e) => toast.fromError(e),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New purchase (stock receipt)')}
      subtitle={t('Pieces are created as PURCHASED → RECEIVED → AVAILABLE with a PURCHASE ledger movement.')}
      width="max-w-5xl"
      footer={
        <>
          <span className="me-auto text-[13px] text-ink-600">
            {t('{n} piece(s) · total cost', { n: lines.length })} <b className="num">{money(total)}</b>
          </span>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>{t('Receive into stock')}</Button>
        </>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {isGlobal && (
          <Field label={t('Receiving branch')}>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">{t('Select…')}</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('Supplier')}>
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">—</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label={t('Supplier invoice no.')}>
          <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        </Field>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="text-ink-500">
            <tr>
              <th className="pb-1.5 text-start font-medium">{t('Product')}</th>
              <th className="pb-1.5 text-start font-medium">{t('Gross g')}</th>
              <th className="pb-1.5 text-start font-medium">{t('Net g')}</th>
              <th className="pb-1.5 text-start font-medium">{t('Purchase cost')}</th>
              <th className="pb-1.5 text-start font-medium">{t('Making')}</th>
              <th className="pb-1.5 text-start font-medium">{t('Other')}</th>
              <th className="pb-1.5 text-start font-medium">{t('Selling price')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pe-2">
                  <Select value={l.productId} onChange={(e) => upd(i, { productId: e.target.value ? Number(e.target.value) : '' })} className="h-8 min-w-48 text-[12.5px]">
                    <option value="">{t('Select…')}</option>
                    {products.data?.map((p) => <option key={p.id} value={p.id}>{L(p.name, p.nameAr)} · {p.karat}K</option>)}
                  </Select>
                </td>
                <td className="py-1 pe-2"><Input type="number" step="0.001" value={l.gross} onChange={(e) => upd(i, { gross: e.target.value })} className="h-8 w-20 text-[12.5px]" /></td>
                <td className="py-1 pe-2"><Input type="number" step="0.001" value={l.net} onChange={(e) => upd(i, { net: e.target.value })} onBlur={() => !l.purchaseCost && suggest(i, l)} className="h-8 w-20 text-[12.5px]" /></td>
                <td className="py-1 pe-2"><Input type="number" value={l.purchaseCost} onChange={(e) => upd(i, { purchaseCost: e.target.value })} className="h-8 w-28 text-[12.5px]" /></td>
                <td className="py-1 pe-2"><Input type="number" value={l.makingCost} onChange={(e) => upd(i, { makingCost: e.target.value })} className="h-8 w-24 text-[12.5px]" /></td>
                <td className="py-1 pe-2"><Input type="number" value={l.otherCost} onChange={(e) => upd(i, { otherCost: e.target.value })} className="h-8 w-20 text-[12.5px]" /></td>
                <td className="py-1 pe-2"><Input type="number" value={l.sellingPrice} onChange={(e) => upd(i, { sellingPrice: e.target.value })} className="h-8 w-28 text-[12.5px]" /></td>
                <td className="py-1">
                  <button onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1} className="p-1 text-ink-400 hover:text-rose-600 disabled:opacity-30" aria-label={t('Remove line')}>
                    <Trash2 className="size-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="size-4" />} onClick={() => setLines((ls) => [...ls, emptyLine()])}>{t('Add piece')}</Button>
      <p className="mt-2 text-[12px] text-ink-500">{t('Tip: enter the net weight and the costs are pre-filled from today’s gold rate. All values stay editable.')}</p>
    </Dialog>
  );
}

export function PurchaseDetailPage() {
  const id = Number(useParams().id);
  const { t, lang } = useI18n();
  const { isGlobal } = useAuth();
  const q = useQuery({
    queryKey: ['purchase', id],
    queryFn: () =>
      get<PurchaseRow & { notes: string | null; items: { itemId: number; code: string; productName: string; karat: number; netWeightMg: number; purchaseCost: number; makingCost: number; otherCost: number; sellingPrice: number; status: string }[] }>(`/purchases/${id}`),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <div className="p-6"><ErrorState error={q.error} /></div>;
  const p = q.data!;
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={<Crumbs items={[...(isGlobal ? [{ label: t('Company'), to: '/overview' }, { label: p.branchName, to: `/branches/${p.branchId}` }] : []), { label: t('Purchases'), to: '/purchases' }, { label: p.number }]} />}
        title={<span>{t('Purchase')} <Mono className="text-xl">{p.number}</Mono></span>}
        subtitle={t('{when} · {branch} · received by {user}', { when: dateTime(p.createdAt, lang), branch: t(p.branchName), user: p.createdByName })}
      />
      <Card className="mb-5">
        <KeyValue cols={4} items={[{ label: t('Supplier'), value: p.supplierName ?? '—' }, { label: t('Supplier invoice'), value: p.supplierInvoiceNo ?? '—' }, { label: t('Items'), value: p.itemCount }, { label: t('Total cost'), value: money(p.totalCost) }]} />
      </Card>
      <Card padded={false}>
        <CardHeader title={t('Pieces received')} subtitle={t('Current status shows where each piece is now')} />
        <table className="w-full text-[13px]">
          <thead className="bg-[#f7f8fa] text-ink-500">
            <tr>
              <th className="px-5 py-2 text-start font-medium">{t('Item')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Net weight')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Purchase')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Making')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Other')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Selling price')}</th>
              <th className="px-5 py-2 text-start font-medium">{t('Now')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {p.items.map((i) => (
              <tr key={i.itemId}>
                <td className="px-5 py-2.5"><Link to={`/inventory/${i.itemId}`} className="hover:underline"><Mono className="font-semibold">{i.code}</Mono> · {i.productName} · {i.karat}K</Link></td>
                <td className="px-3 py-2.5 text-end num">{grams(i.netWeightMg)}</td>
                <td className="px-3 py-2.5 text-end num">{money(i.purchaseCost, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(i.makingCost, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(i.otherCost, false)}</td>
                <td className="px-3 py-2.5 text-end num">{money(i.sellingPrice, false)}</td>
                <td className="px-5 py-2.5"><StatusBadge status={i.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
