// Scrap gold (Phase 4): buy gold from a customer at today's scrap rate (any karat for broken scrap,
// only sold karats for a sellable piece), paid in cash or by bank transfer; and the branch's
// broken-scrap pool (raw weight by karat and its 24K equivalent), which settles supplier gold.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Recycle, Scale } from 'lucide-react';
import { gramsToMg, valueOfWeight, type ScrapKind, type ScrapPaymentMethod } from '@jerp/shared';
import { get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, karatLabel, money } from '../../lib/format';
import { useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useActionKeys } from '../../lib/idempotency';
import { Alert, Button, Card, CardHeader, ErrorState, Field, Input, Kpi, Loading, Mono, PageHeader, Select } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';
import { NewButton, NewProductDialog } from '../../components/Catalog';
import type { Product } from '../../lib/types';

export interface ScrapRates {
  rates: { karat: number; pricePerGram: number; effectiveAt: string }[];
  tolerancePct: number;
  requireGmApproval: boolean;
}
interface PoolLine {
  karat: number;
  weightMg: number;
  pureMg24: number;
}
interface PoolView {
  branches: { branchId: number; branchName: string; branchNameAr: string; byKarat: PoolLine[]; weightMg: number; pureMg24: number }[];
  byKarat: PoolLine[];
  weightMg: number;
  pureMg24: number;
}
interface ScrapRow {
  id: number;
  number: string;
  branchName: string;
  kind: ScrapKind;
  karat: number;
  netWeightMg: number;
  scrapRatePerGram: number;
  agreedRatePerGram: number;
  deviationBp: number;
  overrideApproved: boolean;
  amount: number;
  paymentMethod: ScrapPaymentMethod;
  customerName: string | null;
  createdAt: string;
  createdByName: string;
}

export function ScrapPage() {
  const { t, L, lang } = useI18n();
  const { me, isGlobal } = useAuth();
  const branches = useBranches();
  const [branchId, setBranchId] = useState<number | undefined>(me?.user.branch?.id ?? undefined);
  const pool = useQuery({ queryKey: ['scrap-pool', branchId ?? 'all'], queryFn: () => get<PoolView>('/scrap-pool', { branchId }) });
  const list = useQuery({ queryKey: ['scrap-purchases', branchId ?? 'all'], queryFn: () => get<ScrapRow[]>('/scrap-purchases', { branchId }) });

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Scrap gold')}
        subtitle={t('Buy gold from customers at today’s scrap rate. Broken scrap goes into the branch pool, which is how suppliers are paid in gold.')}
        actions={
          isGlobal && (
            <Select value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : undefined)} className="h-9 w-48" aria-label={t('Branch')}>
              <option value="">{t('All branches')}</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
            </Select>
          )
        }
      />

      <Card padded={false} className="mb-5">
        <CardHeader title={t('Broken-scrap pool')} subtitle={t('Weight held per karat (never an inventory item). Counted in the branch’s total stock weight.')} />
        <div className="p-5">
          {pool.isLoading ? <Loading /> : pool.isError ? <ErrorState error={pool.error} onRetry={() => pool.refetch()} /> : <PoolSummary pool={pool.data!} />}
        </div>
      </Card>

      {branchId != null && <BuyForm branchId={branchId} />}

      <Card padded={false} className="mt-5">
        <CardHeader title={t('Scrap bought')} />
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <DataTable
            rows={list.data!}
            rowKey={(r) => r.id}
            exportName="scrap-purchases"
            emptyTitle={t('No scrap bought yet')}
            columns={[
              { key: 'number', header: t('Number'), render: (r) => <Mono className="font-semibold text-ink-900">{r.number}</Mono> },
              { key: 'createdAt', header: t('Date'), render: (r) => dateTime(r.createdAt, lang) },
              ...(isGlobal && branchId == null ? [{ key: 'branchName', header: t('Branch'), render: (r: ScrapRow) => t(r.branchName) }] : []),
              { key: 'kind', header: t('Type'), value: (r) => t(r.kind), render: (r) => t(r.kind) },
              { key: 'karat', header: t('Karat'), align: 'end', render: (r) => karatLabel(r.karat) },
              { key: 'netWeightMg', header: t('Weight'), align: 'end', render: (r) => <span className="num">{grams(r.netWeightMg)}</span> },
              { key: 'agreedRatePerGram', header: t('Price per gram'), align: 'end', render: (r) => <span className="num">{money(r.agreedRatePerGram, false)}</span> },
              { key: 'deviationBp', header: t('vs scrap rate'), align: 'end', render: (r) => <span className="num">{(r.deviationBp / 100).toFixed(2)}%{r.overrideApproved ? ` · ${t('GM')}` : ''}</span> },
              { key: 'amount', header: t('Paid'), align: 'end', render: (r) => <span className="font-medium num">{money(r.amount, false)}</span> },
              { key: 'paymentMethod', header: t('Paid by'), value: (r) => t(r.paymentMethod), render: (r) => t(r.paymentMethod) },
              { key: 'customerName', header: t('Customer'), render: (r) => r.customerName ?? '—' },
              { key: 'createdByName', header: t('Bought by') },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function PoolSummary({ pool }: { pool: PoolView }) {
  const { t } = useI18n();
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={t('Broken scrap held')} value={grams(pool.weightMg)} icon={<Scale className="size-4" />} />
        <Kpi label={t('As 24K pure gold')} value={grams(pool.pureMg24)} tone="dark" icon={<Recycle className="size-4" />} />
      </div>
      {pool.byKarat.length ? (
        <table className="mt-4 w-full max-w-xl text-[13px]" data-testid="scrap-pool">
          <thead className="text-ink-500">
            <tr>
              <th className="py-1.5 text-start font-medium">{t('Karat')}</th>
              <th className="py-1.5 text-end font-medium">{t('Weight')}</th>
              <th className="py-1.5 text-end font-medium">{t('24K equivalent')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {pool.byKarat.map((l) => (
              <tr key={l.karat}>
                <td className="py-1.5">{karatLabel(l.karat)}</td>
                <td className="py-1.5 text-end num">{grams(l.weightMg)}</td>
                <td className="py-1.5 text-end num">{grams(l.pureMg24)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-3 text-[13px] text-ink-500">{t('The pool is empty.')}</p>
      )}
    </>
  );
}

function BuyForm({ branchId }: { branchId: number }) {
  const { t, L } = useI18n();
  const { me, can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const actionKeys = useActionKeys();
  const rates = useQuery({ queryKey: ['scrap-rates'], queryFn: () => get<ScrapRates>('/scrap-rates') });
  const products = useQuery({ queryKey: ['products'], queryFn: () => get<Product[]>('/products'), enabled: can('purchases.create') || can('scrap.buy') });
  const [newProduct, setNewProduct] = useState(false);
  const [kind, setKind] = useState<ScrapKind>('BROKEN');
  const [karat, setKarat] = useState<number | ''>('');
  const [gross, setGross] = useState('');
  const [net, setNet] = useState('');
  const [agreed, setAgreed] = useState('');
  const [payment, setPayment] = useState<ScrapPaymentMethod>('CASH');
  const [productId, setProductId] = useState<number | ''>('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerIdRef, setCustomerIdRef] = useState('');
  const [note, setNote] = useState('');

  // Broken scrap: any karat 1–24 typed in. A sellable piece: only a karat this deployment sells (D-4-1).
  const sellKarats = me?.allowedKarats ?? [];
  const rate = rates.data?.rates.find((r) => r.karat === karat)?.pricePerGram ?? 0;
  const agreedRate = agreed ? Number(agreed) : rate;
  const netMg = net ? gramsToMg(net) : 0;
  const amount = netMg > 0 && agreedRate > 0 ? valueOfWeight(netMg, agreedRate) : 0;
  const deviationPct = rate > 0 ? (Math.abs(agreedRate - rate) / rate) * 100 : 0;
  const tolerance = rates.data?.tolerancePct ?? 0;
  const beyond = rate > 0 && deviationPct > tolerance;
  const needsGm = beyond && !!rates.data?.requireGmApproval && !can('scrap.override');
  const piecesProducts = useMemo(() => products.data?.filter((p) => p.karat === karat) ?? [], [products.data, karat]);
  const valid =
    karat !== '' && rate > 0 && netMg > 0 && (!gross || gramsToMg(gross) >= netMg) && agreedRate > 0 && !needsGm &&
    (kind === 'BROKEN' || (productId !== '' && Number(sellingPrice) > 0));

  const reset = () => {
    setGross('');
    setNet('');
    setAgreed('');
    setProductId('');
    setSellingPrice('');
    setCustomerName('');
    setCustomerPhone('');
    setCustomerIdRef('');
    setNote('');
  };
  const m = useMutation({
    mutationFn: () =>
      postOnce<{ number: string; amount: number; itemCode: string | null }>(
        '/scrap-purchases',
        {
          branchId,
          kind,
          karat,
          grossWeightMg: gross ? gramsToMg(gross) : netMg,
          netWeightMg: netMg,
          agreedRatePerGram: agreed ? Number(agreed) : undefined,
          paymentMethod: payment,
          ...(kind === 'SELLABLE' ? { productId, sellingPrice: Number(sellingPrice) } : {}),
          customerName: customerName.trim() || undefined,
          customerPhone: customerPhone.trim() || undefined,
          customerIdRef: customerIdRef.trim() || undefined,
          note: note.trim() || undefined,
        },
        actionKeys.for('scrap'),
      ),
    onSuccess: (r) => {
      actionKeys.rotate('scrap');
      toast.success(
        t('Scrap {number} bought', { number: r.number }),
        r.itemCode ? t('Piece {code} is now AVAILABLE for sale. Paid {amount}.', { code: r.itemCode, amount: money(r.amount) }) : t('Added to the broken-scrap pool. Paid {amount}.', { amount: money(r.amount) }),
      );
      reset();
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });

  return (
    <Card padded={false}>
      <CardHeader title={t('Buy scrap from a customer')} subtitle={t('The customer is paid now, from the drawer or by bank transfer.')} />
      <div className="space-y-4 p-5">
        <div className="flex rounded-md border border-line-strong p-0.5 sm:w-fit" role="radiogroup" aria-label={t('Type')}>
          {(['BROKEN', 'SELLABLE'] as const).map((k) => (
            <button
              key={k}
              role="radio"
              aria-checked={kind === k}
              onClick={() => { setKind(k); setKarat(''); setProductId(''); }}
              data-testid={`scrap-kind-${k}`}
              className={'h-8 rounded px-4 text-[13px] font-medium ' + (kind === k ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-canvas')}
            >
              {k === 'BROKEN' ? t('Broken scrap (to the pool)') : t('Sellable piece (to inventory)')}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('Karat')} hint={kind === 'BROKEN' ? t('Any karat from 1 to 24') : undefined}>
            {kind === 'BROKEN' ? (
              <Input
                type="number"
                min={1}
                max={24}
                step={1}
                value={karat}
                onChange={(e) => {
                  const k = Number(e.target.value);
                  setKarat(e.target.value && Number.isInteger(k) && k >= 1 && k <= 24 ? k : '');
                  setAgreed('');
                }}
                className="num"
                aria-label={t('Karat')}
              />
            ) : (
              <Select value={karat} onChange={(e) => { setKarat(e.target.value ? Number(e.target.value) : ''); setAgreed(''); setProductId(''); }} data-testid="scrap-karat">
                <option value="">{t('Select…')}</option>
                {sellKarats.map((k) => <option key={k} value={k}>{karatLabel(k)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('Gross weight (g)')}>
            <Input type="number" min={0} step="0.001" value={gross} onChange={(e) => setGross(e.target.value)} className="num" data-testid="scrap-gross" />
          </Field>
          <Field label={t('Net weight (g)')}>
            <Input type="number" min={0} step="0.001" value={net} onChange={(e) => setNet(e.target.value)} className="num" data-testid="scrap-net" />
          </Field>
          <Field label={t('Paid by')}>
            <Select value={payment} onChange={(e) => setPayment(e.target.value as ScrapPaymentMethod)}>
              <option value="CASH">{t('CASH')}</option>
              <option value="BANK_TRANSFER">{t('BANK_TRANSFER')}</option>
            </Select>
          </Field>
          <Field label={t('Today’s scrap rate')} hint={karat !== '' && !rate ? t('No scrap buying rate is set for this karat') : undefined}>
            <Input value={rate ? money(rate, false) : '—'} readOnly className="num bg-canvas" />
          </Field>
          <Field label={t('Agreed price per gram')} hint={rate ? t('Within {pct}% of the scrap rate the branch manager decides', { pct: tolerance }) : undefined}>
            <Input type="number" min={0} step={500} value={agreed} placeholder={rate ? String(rate) : ''} onChange={(e) => setAgreed(e.target.value)} className="num" />
          </Field>
          {kind === 'SELLABLE' && (
            <>
              <Field label={t('Product')} hint={can('catalog.create') && karat !== '' ? <NewButton testId="scrap-new-product" onClick={() => setNewProduct(true)}>{t('New product')}</NewButton> : undefined}>
                <Select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')} disabled={karat === ''} data-testid="scrap-product">
                  <option value="">{karat !== '' && piecesProducts.length === 0 ? t('No products yet: create one') : t('Select…')}</option>
                  {piecesProducts.map((p) => <option key={p.id} value={p.id}>{L(p.name, p.nameAr)}</option>)}
                </Select>
              </Field>
              <Field label={t('Selling price')}>
                <Input type="number" min={0} value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} className="num" data-testid="scrap-selling-price" />
              </Field>
              {newProduct && karat !== '' && (
                <NewProductDialog
                  karat={karat}
                  onClose={() => setNewProduct(false)}
                  onCreated={(p) => {
                    setProductId(p.id);
                    setNewProduct(false);
                  }}
                />
              )}
            </>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('Customer name')}>
            <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={120} />
          </Field>
          <Field label={t('Phone')}>
            <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} maxLength={30} />
          </Field>
          <Field label={t('ID document number')}>
            <Input value={customerIdRef} onChange={(e) => setCustomerIdRef(e.target.value)} maxLength={60} />
          </Field>
          <Field label={t('Note (optional)')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
        </div>
        {beyond && (
          <Alert tone={needsGm ? 'warning' : 'gold'}>
            {needsGm
              ? t('This price is {pct}% away from today’s scrap rate; beyond {tolerance}% it needs General Manager approval', { pct: deviationPct.toFixed(2), tolerance })
              : t('{pct}% away from today’s scrap rate: recorded as a General Manager decision.', { pct: deviationPct.toFixed(2) })}
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <span className="text-[13.5px] text-ink-600">
            {t('To pay the customer')}: <b className="text-lg text-ink-950 num">{money(amount)}</b>
          </span>
          <Button variant="gold" className="ms-auto" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()} data-testid="scrap-buy">
            {t('Buy and pay')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
