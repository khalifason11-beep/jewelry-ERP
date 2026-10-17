// Scrap gold (Phase 4): buy gold from a customer at today's scrap rate (any karat for broken scrap,
// only sold karats for a sellable piece), paid from the drawer, by bank transfer, or part of each (CSH-2); and the branch's
// broken-scrap pool (raw weight by karat and its 24K equivalent), which settles supplier gold.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Recycle, Scale } from 'lucide-react';
import { parseIntegerInput, parseWeightInput, validBankReference, valueOfWeight, type ScrapKind, type ScrapPaymentMethod } from '@jerp/shared';
import { ApiError, errorText, get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, karatLabel, money } from '../../lib/format';
import { useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useActionKeys } from '../../lib/idempotency';
import { Alert, Button, Card, CardHeader, Empty, Field, Input, IntegerInput, Kpi, MoneyInput, Mono, PhoneInput, ReferenceInput, WeightInput, PageHeader, QueryState, Select, SkeletonRows } from '../../components/ui';
import { useServerList } from '../../lib/paging';
import { DataTable } from '../../components/ui/DataTable';
import { NewProductPanel, ProductPicker } from '../../components/ProductPicker';
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
  cashAmount: number;
  bankAmount: number;
  bankReference: string | null;
  customerName: string | null;
  createdAt: string;
  createdByName: string;
}

/** Money and references read left to right inside Arabic text (no sign flipping). */
const ltr = (s: string) => `\u2066${s}\u2069`;

/** CSH-2: how a purchase was paid — Cash, Bank transfer, or both parts — with the transfer reference. */
function PaidBy({ r }: { r: ScrapRow }) {
  const { t } = useI18n();
  const label =
    r.paymentMethod === 'SPLIT'
      ? t('Cash {cash} + bank {bank}', { cash: ltr(money(r.cashAmount, false)), bank: ltr(money(r.bankAmount, false)) })
      : t(r.paymentMethod);
  return (
    <span data-testid={`scrap-paid-by-${r.number}`}>
      {label}
      {r.bankReference && <span className="block font-mono text-[12px] text-ink-500">{ltr(r.bankReference)}</span>}
    </span>
  );
}

/** Table column → the scrap list's server sort key (BE-7). */
const SCRAP_SORT_KEYS = { number: 'number', createdAt: 'date', branchName: 'branch', netWeightMg: 'weight', amount: 'amount' };

export function ScrapPage() {
  const { t, L, lang } = useI18n();
  const { me, isGlobal } = useAuth();
  const branches = useBranches();
  const [branchId, setBranchId] = useState<number | undefined>(me?.user.branch?.id ?? undefined);
  const pool = useQuery({ queryKey: ['scrap-pool', branchId ?? 'all'], queryFn: () => get<PoolView>('/scrap-pool', { branchId }) });
  // BE-7: one page at a time from the server.
  const list = useServerList<ScrapRow>('scrap-purchases', '/scrap-purchases', { branchId }, { sortKeys: SCRAP_SORT_KEYS, search: true });

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
          <QueryState query={pool} loading={<SkeletonRows rows={3} />}>
            {(p) => <PoolSummary pool={p} />}
          </QueryState>
        </div>
      </Card>

      {branchId != null ? (
        <BuyForm branchId={branchId} />
      ) : (
        // UI-A2: "All branches" cannot buy; say so instead of hiding the form without a word.
        <Card padded={false}>
          <Empty variant="prompt" title={t('Choose a branch to buy scrap')} body={t('Scrap is bought for one branch: pick it in the branch selector above.')} />
        </Card>
      )}

      <Card padded={false} className="mt-5">
        <CardHeader title={t('Scrap bought')} />
        <DataTable
          query={list.query}
          rows={list.rows}
          server={list.server}
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
            { key: 'paymentMethod', header: t('Paid by'), value: (r) => (r.paymentMethod === 'SPLIT' ? `${t('CASH')} ${r.cashAmount} + ${t('BANK_TRANSFER')} ${r.bankAmount}` : t(r.paymentMethod)) + (r.bankReference ? ` ${r.bankReference}` : ''), render: (r) => <PaidBy r={r} /> },
            { key: 'customerName', header: t('Customer'), render: (r) => r.customerName ?? '—' },
            { key: 'createdByName', header: t('Bought by') },
          ]}
        />
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
  const { t } = useI18n();
  const { me, can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const actionKeys = useActionKeys();
  const rates = useQuery({ queryKey: ['scrap-rates'], queryFn: () => get<ScrapRates>('/scrap-rates') });
  const products = useQuery({ queryKey: ['products'], queryFn: () => get<Product[]>('/products'), enabled: can('purchases.create') || can('scrap.buy') });
  // UX-1: a new product is created in a panel in the form (its karat fixed to the piece's), then selected.
  const [creating, setCreating] = useState<string | null>(null);
  const [kind, setKind] = useState<ScrapKind>('BROKEN');
  const [karat, setKarat] = useState<number | ''>('');
  // Broken scrap: the karat as typed (UX-1 number field); `karat` holds it once it is a whole number from 1 to 24.
  const [karatText, setKaratText] = useState('');
  const [gross, setGross] = useState('');
  const [net, setNet] = useState('');
  const [agreed, setAgreed] = useState('');
  // CSH-2: the cash part is typed (empty = all in cash); the bank part fills itself with the rest unless edited.
  const [cashPart, setCashPart] = useState('');
  const [bankPart, setBankPart] = useState<string | null>(null);
  const [bankRef, setBankRef] = useState('');
  // CSH-2 (Q7): the drawer's refusal (the shortfall and what to do) stays on the form until the payment changes.
  const [drawerShort, setDrawerShort] = useState<string | null>(null);
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
  const netMg = parseWeightInput(net) ?? 0;
  const grossMg = parseWeightInput(gross);
  const amount = netMg > 0 && agreedRate > 0 ? valueOfWeight(netMg, agreedRate) : 0;
  const deviationPct = rate > 0 ? (Math.abs(agreedRate - rate) / rate) * 100 : 0;
  const tolerance = rates.data?.tolerancePct ?? 0;
  const beyond = rate > 0 && deviationPct > tolerance;
  const needsGm = beyond && !!rates.data?.requireGmApproval && !can('scrap.override');
  const cash = cashPart === '' ? amount : Math.max(0, Math.floor(Number(cashPart)));
  const bank = bankPart == null ? Math.max(0, amount - cash) : Math.max(0, Math.floor(Number(bankPart)));
  const partsOk = amount > 0 && cash + bank === amount;
  const refOk = bank === 0 || !!validBankReference(bankRef);
  const piecesProducts = useMemo(() => products.data?.filter((p) => p.karat === karat) ?? [], [products.data, karat]);
  const valid =
    karat !== '' && rate > 0 && netMg > 0 && (grossMg == null || grossMg >= netMg) && agreedRate > 0 && !needsGm && partsOk && refOk &&
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
    setCashPart('');
    setBankPart(null);
    setBankRef('');
    setDrawerShort(null);
  };
  const m = useMutation({
    mutationFn: () =>
      postOnce<{ number: string; amount: number; itemCode: string | null }>(
        '/scrap-purchases',
        {
          branchId,
          kind,
          karat,
          grossWeightMg: grossMg ?? netMg,
          netWeightMg: netMg,
          agreedRatePerGram: agreed ? Number(agreed) : undefined,
          cashAmount: cash,
          bankAmount: bank,
          ...(bank > 0 ? { bankReference: validBankReference(bankRef) ?? bankRef } : {}),
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
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DRAWER_SHORT') setDrawerShort(errorText(e));
      else toast.fromError(e);
    },
  });

  return (
    <Card padded={false}>
      <CardHeader title={t('Buy scrap from a customer')} subtitle={t('The customer is paid now: from the drawer, by bank transfer, or part of each.')} />
      <div className="space-y-4 p-5">
        <div className="flex rounded-md border border-line-strong p-0.5 sm:w-fit" role="radiogroup" aria-label={t('Type')}>
          {(['BROKEN', 'SELLABLE'] as const).map((k) => (
            <button
              key={k}
              role="radio"
              aria-checked={kind === k}
              onClick={() => { setKind(k); setKarat(''); setKaratText(''); setProductId(''); }}
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
              <IntegerInput
                min={1}
                max={24}
                value={karatText}
                onValueChange={(v) => {
                  const k = parseIntegerInput(v);
                  setKaratText(v);
                  setKarat(k != null && k >= 1 && k <= 24 ? k : '');
                  setAgreed('');
                }}
                aria-label={t('Karat')}
                data-testid="scrap-karat-any"
              />
            ) : (
              <Select value={karat} onChange={(e) => { setKarat(e.target.value ? Number(e.target.value) : ''); setAgreed(''); setProductId(''); }} data-testid="scrap-karat">
                <option value="">{t('Select…')}</option>
                {sellKarats.map((k) => <option key={k} value={k}>{karatLabel(k)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('Gross weight (g)')}>
            <WeightInput value={gross} onValueChange={setGross} data-testid="scrap-gross" />
          </Field>
          <Field label={t('Net weight (g)')}>
            <WeightInput value={net} onValueChange={(v) => { setNet(v); setDrawerShort(null); }} data-testid="scrap-net" />
          </Field>
          <Field label={t('Today’s scrap rate')} hint={karat !== '' && !rate ? t('No scrap buying rate is set for this karat') : undefined}>
            <Input value={rate ? money(rate, false) : '—'} readOnly className="num bg-canvas" />
          </Field>
          <Field label={t('Agreed price per gram')} hint={rate ? t('Within {pct}% of the scrap rate the branch manager decides', { pct: tolerance }) : undefined}>
            <MoneyInput value={agreed} placeholder={rate ? String(rate) : ''} onValueChange={setAgreed} data-testid="scrap-agreed" />
          </Field>
          {kind === 'SELLABLE' && (
            <>
              <Field label={t('Product')} hint={karat === '' ? t('Choose the karat first') : undefined}>
                <ProductPicker
                  products={piecesProducts}
                  value={productId}
                  onChange={setProductId}
                  onCreate={karat === '' ? undefined : setCreating}
                  disabled={karat === ''}
                  testId="scrap-product"
                />
              </Field>
              <Field label={t('Selling price')}>
                <MoneyInput value={sellingPrice} onValueChange={setSellingPrice} data-testid="scrap-selling-price" />
              </Field>
              {creating != null && karat !== '' && (
                <div className="sm:col-span-2 lg:col-span-4">
                  <NewProductPanel
                    name={creating}
                    karat={karat}
                    testId="scrap-new-product"
                    onCancel={() => setCreating(null)}
                    onCreated={(p) => {
                      setProductId(p.id);
                      setCreating(null);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
        {/* UX-1: the customer's identity has no financial effect and nothing in it is required (the API keeps the
            fields; SCR-1 decides their future): one closed section. */}
        <details className="group rounded-control border border-line" data-testid="scrap-customer">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-[13.5px] font-medium text-ink-2" data-testid="scrap-customer-toggle">
            {t('Customer details (optional)')}
          </summary>
        <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('Customer name')}>
            <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={120} data-testid="scrap-customer-name" />
          </Field>
          <Field label={t('Phone')}>
            <PhoneInput value={customerPhone} onValueChange={setCustomerPhone} data-testid="scrap-customer-phone" />
          </Field>
          <Field label={t('ID document number')}>
            <ReferenceInput value={customerIdRef} onValueChange={setCustomerIdRef} maxChars={60} data-testid="scrap-customer-id" />
          </Field>
          <Field label={t('Note (optional)')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="scrap-note" />
          </Field>
        </div>
        </details>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="scrap-payment">
          <Field label={t('Paid from the drawer')} hint={t('Leave empty to pay it all in cash')}>
            <MoneyInput
              value={cashPart}
              placeholder={amount ? String(amount) : ''}
              onValueChange={(v) => { setCashPart(v); setBankPart(null); setDrawerShort(null); }}
              data-testid="scrap-cash-part"
            />
          </Field>
          <Field label={t('Paid by bank transfer')} hint={bankPart == null ? t('The rest of the amount') : undefined}>
            <MoneyInput value={bankPart ?? String(bank)} onValueChange={(v) => { setBankPart(v); setDrawerShort(null); }} data-testid="scrap-bank-part" />
          </Field>
          {bank > 0 && (
            <Field label={t('Bank transfer reference')} hint={bankRef && !refOk ? t('4 to 40 letters or digits') : undefined}>
              <ReferenceInput value={bankRef} onValueChange={setBankRef} data-testid="scrap-bank-ref" />
            </Field>
          )}
        </div>
        {amount > 0 && !partsOk && (
          <Alert tone="warning">
            <span data-testid="scrap-parts-mismatch">
              {t('The cash and bank parts must add up to the amount paid ({amount}); they add up to {sum}', { amount: ltr(money(amount, false)), sum: ltr(money(cash + bank, false)) })}
            </span>
          </Alert>
        )}
        {drawerShort && (
          <Alert tone="warning">
            <span data-testid="scrap-drawer-short">{drawerShort}</span>
          </Alert>
        )}
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
          <Button variant="primary" className="ms-auto" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()} data-testid="scrap-buy">
            {t('Buy and pay')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
