import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { PackageX, Pencil, RotateCcw, Truck } from 'lucide-react';
import { ITEM_STATUSES } from '@jerp/shared';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, karatLabel, money, pct, currencyLabel } from '../../lib/format';
import { useCategories, useDebounced } from '../../lib/hooks';
import { noteText } from '../../lib/audit';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import type { ItemRow } from '../../lib/types';
import { Button, Card, CardHeader, Dialog, ErrorState, Field, Input, ItemThumb, KeyValue, Loading, Mono, PageHeader, Select, StatusBadge, Textarea } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect } from '../../components/Filters';
import { Crumbs } from '../sales/SalesPages';
import { InventorySelect } from './InventorySelect';

export function InventoryTable({ branchId, initialStatus = 'AVAILABLE', toolbarExtra }: { branchId?: number; initialStatus?: string; toolbarExtra?: React.ReactNode }) {
  const { t, L } = useI18n();
  const { can, isGlobal, me } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState(initialStatus);
  const [karat, setKarat] = useState<number | ''>('');
  const [category, setCategory] = useState('');
  const [origin, setOrigin] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const categories = useCategories();
  const query = useQuery({
    queryKey: ['inventory', branchId, status, karat, category, origin, dq],
    queryFn: () => get<{ items: ItemRow[]; total: number }>('/inventory/items', { branchId, status, karat, categoryId: category || undefined, origin: origin || undefined, q: dq, limit: 1000 }),
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.items ?? [];
  const cost = can('profit.view');
  // UI-A2: an error is shown as an error (never as "no items"), and "nothing in stock" differs from "filters hide it".
  const filtered = !!(karat || category || origin || dq || status !== initialStatus);
  const clearFilters = () => {
    setStatus(initialStatus);
    setKarat('');
    setCategory('');
    setOrigin('');
    setQ('');
  };
  return (
    <DataTable
      query={query}
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/inventory/${r.id}`)}
      exportName="inventory"
      searchable={false}
      emptyTitle={filtered ? t('No items match these filters') : t('No pieces in stock')}
      emptyBody={filtered ? undefined : t('Receive a supplier order or buy scrap to add stock.')}
      emptyAction={
        filtered ? (
          <Button size="sm" onClick={clearFilters} data-testid="clear-filters">
            {t('Clear filters')}
          </Button>
        ) : undefined
      }
      toolbar={
        <>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Code, barcode or product…')} className="h-8 w-56 text-[13px]" />
          {toolbarExtra}
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-40 text-[13px]" aria-label={t('Status')}>
            <option value="">{t('All statuses')}</option>
            {ITEM_STATUSES.map((s) => <option key={s} value={s}>{t(s)}</option>)}
          </Select>
          <Select value={karat} onChange={(e) => setKarat(e.target.value ? Number(e.target.value) : '')} className="h-8 w-24 text-[13px]" aria-label={t('Karat')}>
            <option value="">{t('Karat')}</option>
            {/* REM-3: the karats this deployment sells (setting), not a hardcoded list. */}
            {(me?.allowedKarats ?? []).map((k) => <option key={k} value={k}>{karatLabel(k)}</option>)}
          </Select>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="h-8 w-36 text-[13px]" aria-label={t('Category')}>
            <option value="">{t('Category')}</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{L(c.name, c.nameAr)}</option>)}
          </Select>
          <Select value={origin} onChange={(e) => setOrigin(e.target.value)} className="h-8 w-32 text-[13px]" aria-label={t('Origin')}>
            <option value="">{t('New and scrap')}</option>
            <option value="SUPPLIER_NEW">{t('New')}</option>
            <option value="SCRAP">{t('Scrap')}</option>
          </Select>
        </>
      }
      columns={[
        { key: 'code', header: t('Item ID'), render: (r) => <Mono className="font-semibold text-ink-900">{r.code}</Mono> },
        { key: 'barcode', header: t('Barcode'), render: (r) => <Mono className="text-ink-500">{r.barcode}</Mono> },
        { key: 'productName', header: t('Product'), value: (r) => r.productName, render: (r) => L(r.productName, r.productNameAr) },
        { key: 'categoryName', header: t('Category'), render: (r) => L(r.categoryName, r.categoryNameAr) },
        { key: 'karat', header: t('Karat'), align: 'end', render: (r) => karatLabel(r.karat) },
        { key: 'origin', header: t('Origin'), value: (r) => t(r.origin), render: (r) => t(r.origin) },
        { key: 'netWeightMg', header: t('Net weight'), align: 'end', render: (r) => <span className="num">{grams(r.netWeightMg)}</span>, footer: grams(rows.reduce((s, r) => s + r.netWeightMg, 0)) },
        ...(cost
          ? [
              { key: 'purchaseCost', header: t('Purchase cost'), align: 'end' as const, render: (r: ItemRow) => <span className="num text-ink-600">{money(r.purchaseCost, false)}</span> },
              { key: 'totalCost', header: t('Total cost'), align: 'end' as const, render: (r: ItemRow) => <span className="num">{money(r.totalCost, false)}</span>, footer: money(rows.reduce((s, r) => s + (r.totalCost ?? 0), 0), false) },
            ]
          : []),
        { key: 'sellingPrice', header: t('Selling price'), align: 'end', render: (r) => <span className="font-medium num">{money(r.sellingPrice, false)}</span>, footer: money(rows.reduce((s, r) => s + r.sellingPrice, 0), false) },
        ...(isGlobal && !branchId ? [{ key: 'branchName', header: t('Branch'), render: (r: ItemRow) => L(r.branchName, r.branchNameAr) }] : []),
        { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
      ]}
    />
  );
}

export function InventoryPage() {
  const { t } = useI18n();
  const { can, isGlobal } = useAuth();
  const [sp, setSp] = useSearchParams();
  const branchId = sp.get('branchId') ? Number(sp.get('branchId')) : undefined;
  // Branch managers get the card view with multi-select transfer (Phase 4); the table stays one click away.
  const cardsAvailable = can('inventory.transfer') && !isGlobal;
  const [view, setView] = useState<'cards' | 'table'>(cardsAvailable ? 'cards' : 'table');
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Inventory')}
        subtitle={t('Item-level inventory. Each piece has its own ID, barcode, weights, cost components and lifecycle.')}
        actions={
          cardsAvailable && (
            <div className="flex rounded-md border border-line-strong p-0.5" role="radiogroup" aria-label={t('View')}>
              {([['cards', t('Select & transfer')], ['table', t('Table')]] as const).map(([v, label]) => (
                <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)} className={clsx('h-8 rounded px-3 text-[13px] font-medium', view === v ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-canvas')}>
                  {label}
                </button>
              ))}
            </div>
          )
        }
      />
      <Card padded={false}>
        {cardsAvailable && view === 'cards' ? (
          <InventorySelect />
        ) : (
          <InventoryTable
            branchId={branchId}
            toolbarExtra={<BranchSelect value={branchId} onChange={(v) => setSp(v ? { branchId: String(v) } : {}, { replace: true })} />}
          />
        )}
      </Card>
    </div>
  );
}

interface ItemDetail {
  item: ItemRow;
  history: { id: number; fromStatus: string | null; toStatus: string; branchName: string; refType: string | null; refId: number | null; refNumber: string | null; note: string | null; at: string; userName: string | null }[];
  movements: { id: number; type: string; direction: number; branchName: string; refType: string | null; refId: number | null; refNumber: string | null; at: string; userName: string | null; note: string | null }[];
}

function refLink(refType: string | null, refId: number | null, refNumber: string | null) {
  if (!refNumber) return '—';
  const to = refType === 'sale' ? `/sales/${refId}` : refType === 'purchase' ? `/purchases/${refId}` : refType === 'transfer' ? '/transfers' : null;
  return to ? (
    <Link to={to} className="font-mono text-[12px] text-gold-700 hover:underline" onClick={(e) => e.stopPropagation()}>
      {refNumber}
    </Link>
  ) : (
    <Mono>{refNumber}</Mono>
  );
}

export function ItemDetailPage() {
  const id = Number(useParams().id);
  const { t, L, lang } = useI18n();
  const { can, isGlobal } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['item', id], queryFn: () => get<ItemDetail>(`/inventory/items/${id}`) });
  const [priceOpen, setPriceOpen] = useState(false);
  const [adjust, setAdjust] = useState<null | 'MARK_DAMAGED' | 'RESTOCK' | 'RETURN_TO_SUPPLIER'>(null);
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const done = (msg: string) => {
    toast.success(msg);
    setPriceOpen(false);
    setAdjust(null);
    setReason('');
    qc.invalidateQueries();
  };
  const priceM = useMutation({ mutationFn: () => post(`/inventory/items/${id}/price`, { sellingPrice: Number(price), reason }), onSuccess: () => done(t('Price updated')), onError: (e) => toast.fromError(e) });
  const adjM = useMutation({ mutationFn: () => post(`/inventory/items/${id}/adjust`, { action: adjust, reason }), onSuccess: () => done(t('Inventory adjusted')), onError: (e) => toast.fromError(e) });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <div className="p-6"><ErrorState error={q.error} /></div>;
  const { item: i, history, movements } = q.data!;
  const margin = i.totalCost ? ((i.sellingPrice - i.totalCost) / i.sellingPrice) * 100 : null;
  const saleRef = history.find((h) => h.toStatus === 'SOLD');

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={
          <Crumbs
            items={[
              ...(isGlobal ? [{ label: t('Company'), to: '/overview' }, { label: L(i.branchName, i.branchNameAr), to: `/branches/${i.branchId}` }] : []),
              ...(saleRef?.refId ? [{ label: saleRef.refNumber ?? t('Sale'), to: `/sales/${saleRef.refId}` }] : [{ label: t('Inventory'), to: '/inventory' }]),
              { label: i.code },
            ]}
          />
        }
        title={
          <span className="flex items-center gap-3">
            {L(i.productName, i.productNameAr)} <Mono className="text-lg text-ink-500">{i.code}</Mono> <StatusBadge status={i.status} />
          </span>
        }
        subtitle={`${L(i.categoryName, i.categoryNameAr)} · ${karatLabel(i.karat)} · ${L(i.branchName, i.branchNameAr)}`}
        actions={
          <>
            {can('inventory.price_edit') && i.status === 'AVAILABLE' && (
              <Button icon={<Pencil className="size-4" />} onClick={() => { setPrice(String(i.sellingPrice)); setPriceOpen(true); }}>{t('Change price')}</Button>
            )}
            {can('inventory.adjust') && i.status === 'AVAILABLE' && (
              <Button icon={<PackageX className="size-4" />} onClick={() => setAdjust('MARK_DAMAGED')}>{t('Mark damaged')}</Button>
            )}
            {can('inventory.adjust') && i.status === 'DAMAGED' && (
              <Button icon={<RotateCcw className="size-4" />} onClick={() => setAdjust('RESTOCK')}>{t('Restock')}</Button>
            )}
            {can('inventory.adjust') && ['AVAILABLE', 'DAMAGED'].includes(i.status) && (
              <Button icon={<Truck className="size-4" />} onClick={() => setAdjust('RETURN_TO_SUPPLIER')}>{t('Return to supplier')}</Button>
            )}
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <Card>
            <div className="mb-4 flex gap-4">
              <ItemThumb category={i.categoryCode} karat={i.karat} size="lg" />
              <div className="min-w-0 text-[13px]">
                <div className="text-ink-500">{t('Barcode')}</div>
                <Mono className="text-sm">{i.barcode}</Mono>
                <div className="mt-2 text-ink-500">SKU</div>
                <Mono>{i.sku}</Mono>
              </div>
            </div>
            <KeyValue
              items={[
                { label: t('Gross weight'), value: grams(i.grossWeightMg) },
                { label: t('Net weight'), value: grams(i.netWeightMg) },
                { label: t('Selling price'), value: money(i.sellingPrice) },
                { label: t('Received'), value: dateTime(i.createdAt, lang) },
              ]}
            />
          </Card>
          {i.totalCost != null && (
            <Card>
              <div className="mb-3 text-[13px] font-semibold">{t('Cost & margin')}</div>
              <dl className="space-y-1.5 text-[13px]">
                {[
                  [t('Purchase cost'), i.purchaseCost],
                  [t('Making cost'), i.makingCost],
                  [t('Other cost'), i.otherCost],
                ].map(([l, v]) => (
                  <div key={String(l)} className="flex justify-between text-ink-600">
                    <dt>{l}</dt>
                    <dd className="num">{money(v as number)}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t border-line pt-1.5 font-semibold">
                  <dt>{t('Total cost')}</dt>
                  <dd className="num">{money(i.totalCost)}</dd>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <dt>{t('Expected gross profit')}</dt>
                  <dd className="num">
                    {money(i.sellingPrice - i.totalCost)} <span className="text-xs">({pct(margin)})</span>
                  </dd>
                </div>
              </dl>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          <Card padded={false}>
            <CardHeader title={t('Lifecycle')} subtitle={t('Every status change of this piece, with the document that caused it')} />
            {history.length === 0 ? (
              <div className="px-5 py-6 text-[13px] text-ink-500">{t('Lifecycle is visible to managers.')}</div>
            ) : (
              <ol className="px-5 py-4">
                {history.map((h, idx) => (
                  <li key={h.id} className="relative flex gap-4 pb-4 last:pb-0">
                    {idx < history.length - 1 && <span className="absolute start-[7px] top-4 h-full w-px bg-line-strong" />}
                    <span className={clsx('relative mt-1 size-[15px] shrink-0 rounded-full border-2 bg-white', idx === history.length - 1 ? 'border-gold-500' : 'border-ink-300')} />
                    <div className="min-w-0 flex-1 text-[13px]">
                      <div className="flex flex-wrap items-center gap-2">
                        {h.fromStatus && <><StatusBadge status={h.fromStatus} /><span className="inline-block text-ink-400 rtl:rotate-180">→</span></>}
                        <StatusBadge status={h.toStatus} />
                        {refLink(h.refType, h.refId, h.refNumber)}
                      </div>
                      <div className="mt-1 text-[12px] text-ink-500">
                        {dateTime(h.at, lang)} · {h.userName ?? t('System')} · {t(h.branchName)}
                        {h.note && <> · <span className="text-ink-700">{noteText(h.note)}</span></>}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          {movements.length > 0 && (
            <Card padded={false}>
              <CardHeader title={t('Inventory ledger')} subtitle={t('Stock movements recorded for this piece')} />
              <table className="w-full text-[13px]">
                <thead className="bg-[#f7f8fa] text-ink-500">
                  <tr>
                    <th className="px-5 py-2 text-start font-medium">{t('Time')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('Movement')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('Qty')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('Branch')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('Reference')}</th>
                    <th className="px-5 py-2 text-start font-medium">{t('User')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {movements.map((m) => (
                    <tr key={m.id}>
                      <td className="px-5 py-2">{dateTime(m.at, lang)}</td>
                      <td className="px-3 py-2"><StatusBadge status={m.type} /></td>
                      <td className={clsx('px-3 py-2 text-end font-mono', m.direction > 0 ? 'text-emerald-700' : 'text-rose-700')}>{m.direction > 0 ? '+1' : '−1'}</td>
                      <td className="px-3 py-2">{t(m.branchName)}</td>
                      <td className="px-3 py-2">{refLink(m.refType, m.refId, m.refNumber)}</td>
                      <td className="px-5 py-2">{m.userName ?? t('System')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>

      <Dialog
        open={priceOpen}
        onClose={() => setPriceOpen(false)}
        title={t('Change selling price · {code}', { code: i.code })}
        subtitle={t('Recorded as PRICE_CHANGED in the audit log. Past sales keep their original price.')}
        footer={<><Button onClick={() => setPriceOpen(false)}>{t('Cancel')}</Button><Button variant="primary" loading={priceM.isPending} disabled={!Number(price)} onClick={() => priceM.mutate()}>{t('Save')}</Button></>}
      >
        <div className="space-y-3">
          <Field label={t('New selling price ({currency})', { currency: currencyLabel() })} hint={i.totalCost != null ? t('Total cost {cost} · current price {price}', { cost: money(i.totalCost), price: money(i.sellingPrice) }) : undefined}>
            <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} className="num" />
          </Field>
          <Field label={t('Reason')}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('e.g. Gold rate increase')} />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={!!adjust}
        onClose={() => setAdjust(null)}
        title={adjust === 'MARK_DAMAGED' ? t('Mark as damaged') : adjust === 'RESTOCK' ? t('Return to sellable stock') : t('Return to supplier')}
        subtitle={t('Creates a ledger movement and an INVENTORY_ADJUSTMENT audit event.')}
        footer={<><Button onClick={() => setAdjust(null)}>{t('Cancel')}</Button><Button variant="primary" loading={adjM.isPending} disabled={reason.trim().length < 3} onClick={() => adjM.mutate()}>{t('Confirm')}</Button></>}
      >
        <Field label={t('Reason (required)')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
