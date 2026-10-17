import { gramsToMg, parseMoneyInput, parseWeightInput, pureGoldMg, validBankReference } from '@jerp/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, karatLabel, money, todayKey } from '../../lib/format';
import { useBranches } from '../../lib/hooks';
import { tk, useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Button, Card, CardHeader, DateInput, DetailPending, Dialog, Field, Input, KeyValue, MoneyInput, Mono, ReferenceInput, WeightInput, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useServerList } from '../../lib/paging';
import { DataTable } from '../../components/ui/DataTable';
import { BranchSelect, DateRange, useRangeParams } from '../../components/Filters';
import { Crumbs } from '../sales/SalesPages';
import { useActionKeys } from '../../lib/idempotency';
import { NewButton, NewSupplierDialog, useProducts, useSuppliers } from '../../components/Catalog';
import { NewProductPanel, ProductPicker } from '../../components/ProductPicker';

interface Settlement {
  id: number;
  number: string;
  /** Operational gold weights (D-4-16): visible to the branch manager. */
  settledKarat: number;
  settledWeightMg: number;
  settledPureMg24: number;
  /** Gold still owed after this settlement (24K mg): operational, visible to the branch manager. */
  owedAfterMgPure24: number | null;
  note: string | null;
  at: string;
  createdByName: string;
}

interface PurchaseRow {
  id: number;
  number: string;
  createdAt: string;
  branchId: number;
  branchName: string;
  supplierName: string | null;
  supplierNameAr: string | null;
  supplierInvoiceNo: string | null;
  itemCount: number;
  totalNetWeightMg: number;
  totalCost: number;
  /** MKC-1: the owner's transfer reference (General Manager only; absent for everyone else). */
  makingChargeReference?: string | null;
  createdByName: string;
  status: string;
}

/** SUP-1: the gold still owed to a supplier, across every branch (weights, the oldest order and its age only). */
interface SupplierDebt {
  supplierId: number;
  pureMg24: number;
  orders: number;
  oldestNumber: string | null;
  oldestPurchaseId: number | null;
  days: number | null;
}

/** References and dates read left to right inside Arabic text. */
const ltr = (s: string) => `\u2066${s}\u2069`;

/** Table column → the purchases list's server sort key (BE-7). */
const PURCHASE_SORT_KEYS = { number: 'number', createdAt: 'date', branchName: 'branch', supplierName: 'supplier', totalNetWeightMg: 'weight', totalCost: 'totalCost' };

export function PurchasesTable({ branchId, from, to, toolbar }: { branchId?: number; from: string; to: string; toolbar?: React.ReactNode }) {
  const { t, L, lang } = useI18n();
  const showCost = useAuth().can('profit.view');
  const navigate = useNavigate();
  // Filters stay on screen across reloads (UI-A2): the table shows the states and keeps the previous rows.
  // BE-7: one page at a time from the server; the footer totals cover the whole result.
  const { query: q, rows, totals, server } = useServerList<PurchaseRow>('purchases', '/purchases', { branchId, from, to }, { sortKeys: PURCHASE_SORT_KEYS, search: true });
  const sum = (k: string) => totals?.[k] ?? 0;
  return (
    <DataTable
      query={q}
      rows={rows}
      server={server}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/purchases/${r.id}`)}
      exportName="purchases"
      toolbar={toolbar}
      emptyTitle={t('No purchases in this period')}
      emptyBody={t('Choose another period above.')}
      columns={[
        { key: 'number', header: t('Purchase'), render: (r) => <Mono className="font-semibold text-ink-900">{r.number}</Mono> },
        { key: 'createdAt', header: t('Date'), render: (r) => dateTime(r.createdAt, lang) },
        { key: 'branchName', header: t('Branch'), render: (r) => t(r.branchName) },
        { key: 'supplierName', header: t('Supplier'), render: (r) => (r.supplierName || r.supplierNameAr ? L(r.supplierName, r.supplierNameAr) : '—') },
        { key: 'supplierInvoiceNo', header: t('Supplier invoice'), render: (r) => <Mono className="text-ink-500">{r.supplierInvoiceNo ?? '—'}</Mono> },
        { key: 'itemCount', header: t('Items'), align: 'end', footer: sum('itemCount') },
        { key: 'totalNetWeightMg', header: t('Net weight'), align: 'end', render: (r) => <span className="num">{grams(r.totalNetWeightMg)}</span>, footer: grams(sum('totalNetWeightMg')) },
        // Cost figures are General Manager only (the API omits them for everyone else).
        ...(showCost ? [{ key: 'totalCost', header: t('Total cost'), align: 'end' as const, render: (r: PurchaseRow) => <span className="font-medium num">{money(r.totalCost, false)}</span>, footer: money(sum('totalCost'), false) }] : []),
        // MKC-1: the owner's transfer reference for the making charge (General Manager only).
        ...(showCost ? [{ key: 'makingChargeReference', header: t('Transfer reference'), render: (r: PurchaseRow) => <Mono className="text-ink-500">{r.makingChargeReference ? ltr(r.makingChargeReference) : '—'}</Mono> }] : []),
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
        actions={can('purchases.create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)} data-testid="new-purchase">{t('New purchase')}</Button>}
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
/** UX-1 PART 3: the line fields, in their order, with a one-line hint each (D-4-4, MKC-1, SUP-1). */
const LINE_COLUMNS = [
  { key: 'product', label: tk('Product'), hint: tk('Type to search, or create it here.') },
  { key: 'gross', label: tk('Gross weight'), hint: tk('The whole piece, with any stones or other parts.') },
  { key: 'net', label: tk('Net gold weight'), hint: tk('Gold only: the weight that counts for the karat and for the gold owed to the supplier.') },
  { key: 'cost', label: tk('Purchase cost'), hint: tk('Your value of the piece for cost and profit; the supplier is paid in gold, not money.') },
  { key: 'making', label: tk('Making charge'), hint: tk('Paid by the owner from the owner’s personal account; needs the transfer reference.') },
  { key: 'other', label: tk('Other costs'), hint: tk('Any other cost of the piece, such as stones; part of its cost, no money moves.') },
  { key: 'price', label: tk('Selling price'), hint: tk('The price the branch sells the piece at.') },
] as const;
// One row per piece from 768 px (1366×768 included); stacked, two fields a row, on a narrow screen (no side scroll).
const LINE_GRID = 'grid grid-cols-2 gap-2 md:grid-cols-[minmax(10.5rem,1.4fr)_repeat(6,minmax(0,1fr))_2.25rem] md:items-start';
// PRC-1 (D-prc1-8): with computed prices the line has no selling price (the piece follows the new-piece rate).
const LINE_GRID_NO_PRICE = 'grid grid-cols-2 gap-2 md:grid-cols-[minmax(10.5rem,1.4fr)_repeat(5,minmax(0,1fr))_2.25rem] md:items-start';
const emptyLine = (): Line => ({ productId: '', gross: '', net: '', purchaseCost: '', makingCost: '', otherCost: '', sellingPrice: '' });

function NewPurchaseDialog({ onClose }: { onClose: () => void }) {
  const { me, isGlobal } = useAuth();
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const branches = useBranches();
  const products = useProducts();
  const suppliers = useSuppliers();
  // UX-1: a new product is created in a panel under its line (the type too, if needed) and selected; a new supplier
  // still opens on top of this form (CAT-0).
  const [creating, setCreating] = useState<{ line: number; name: string } | null>(null);
  const [newSupplier, setNewSupplier] = useState(false);
  const [branchId, setBranchId] = useState<number | ''>(me?.user.branch?.id ?? '');
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [invoiceNo, setInvoiceNo] = useState('');
  // MKC-1: the owner pays the making charge by bank transfer from the owner's personal account; the order records the
  // transfer reference and date (required when the charge is above 0). No branch money moves.
  const [transferRef, setTransferRef] = useState('');
  const [transferDate, setTransferDate] = useState(todayKey());
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  // SUP-1: a supplier allows one open order at a time. When gold is still owed to the chosen supplier (any branch), the
  // form says so before saving (weights, the order number and days only, never money) and the General Manager may
  // "record anyway"; the server asks the same (409 SUPPLIER_GOLD_OWED) and audits the confirmation. Never a block.
  const [confirmed, setConfirmed] = useState<{ duplicate: boolean; debt: boolean }>({ duplicate: false, debt: false });
  const debt = useQuery({
    queryKey: ['supplier-gold-owed', supplierId],
    queryFn: () => get<SupplierDebt>(`/suppliers/${supplierId}/gold-owed`),
    enabled: supplierId !== '',
  });
  const [serverDebt, setServerDebt] = useState<SupplierDebt | null>(null);
  const openDebt = serverDebt ?? (debt.data && debt.data.orders > 0 ? debt.data : null);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const tagPrices = me?.pricingMode === 'FIXED_TAG';
  const columns = LINE_COLUMNS.filter((c) => tagPrices || c.key !== 'price');
  const lineGrid = tagPrices ? LINE_GRID : LINE_GRID_NO_PRICE;
  // Only karats this deployment sells can be bought from a supplier (D-4-1).
  const sellable = products.data?.filter((p) => me?.allowedKarats.includes(p.karat));

  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.purchaseCost) || 0) + (Number(l.makingCost) || 0) + (Number(l.otherCost) || 0), 0);
  const making = lines.reduce((s, l) => s + (Number(l.makingCost) || 0), 0);
  const transferOk = making === 0 || (!!validBankReference(transferRef) && !!transferDate && transferDate <= todayKey());
  // UX-1: the receive button stays disabled with the first thing still missing, in plain words (same rules as before).
  const missing = ((): string | null => {
    if (isGlobal && !branchId) return t('Choose the receiving branch');
    if (!supplierId) return t('Choose the supplier');
    for (const [i, l] of lines.entries()) {
      const n = i + 1;
      const net = parseWeightInput(l.net);
      const gross = parseWeightInput(l.gross);
      if (!l.productId) return t('Piece {n}: choose the product', { n });
      if (!gross) return t('Piece {n}: enter the gross weight', { n });
      if (!net) return t('Piece {n}: enter the net gold weight', { n });
      if (gross < net) return t('Piece {n}: the net weight is more than the gross weight', { n });
      if (!parseMoneyInput(l.purchaseCost)) return t('Piece {n}: enter the purchase cost', { n });
      if (tagPrices && !parseMoneyInput(l.sellingPrice)) return t('Piece {n}: enter the selling price', { n });
    }
    if (making > 0 && !validBankReference(transferRef)) return t('Enter the transfer reference of the making charge');
    if (making > 0 && !transferDate) return t('Enter the transfer date');
    if (making > 0 && transferDate > todayKey()) return t('The transfer date cannot be in the future');
    return null;
  })();
  const valid = missing === null && transferOk;
  const netSum = lines.reduce((s, l) => s + (parseWeightInput(l.net) ?? 0), 0);

  // "Add another piece" copies the previous line's product (never weights or prices) and focuses its gross weight.
  const fields = useRef(new Map<string, HTMLInputElement | null>());
  const [focusLine, setFocusLine] = useState<number | null>(null);
  useEffect(() => {
    if (focusLine == null) return;
    fields.current.get(`gross-${focusLine}`)?.focus();
    setFocusLine(null);
  }, [focusLine]);
  const addPiece = () => {
    setLines((ls) => [...ls, { ...emptyLine(), productId: ls[ls.length - 1]?.productId ?? '' }]);
    setFocusLine(lines.length);
  };
  // Enter moves to the next field of the form (a product list open on an option picks it instead).
  const enterToNext = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (e.key !== 'Enter' || e.defaultPrevented || el.tagName !== 'INPUT') return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('input:not([disabled]):not([tabindex="-1"]), select:not([disabled])')];
    const next = all[all.indexOf(el) + 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const actionKeys = useActionKeys();
  const m = useMutation({
    mutationFn: (opts: { confirmDuplicate?: boolean; confirmDebt?: boolean } = {}) =>
      postOnce<{ id: number; number: string; itemCodes: string[] }>('/purchases', {
        branchId: branchId || undefined,
        supplierId: supplierId || undefined, // required (CAT-0); the button stays disabled without it
        supplierInvoiceNo: invoiceNo || undefined,
        ...(making > 0
          ? { makingChargeReference: validBankReference(transferRef) ?? transferRef, makingChargeTransferDate: transferDate, ...(opts.confirmDuplicate || confirmed.duplicate ? { confirmDuplicateReference: true } : {}) }
          : {}),
        ...(opts.confirmDebt || confirmed.debt ? { confirmOpenSupplierDebt: true } : {}),
        lines: lines.map((l) => ({
          productId: Number(l.productId),
          grossWeightMg: gramsToMg(l.gross),
          netWeightMg: gramsToMg(l.net),
          purchaseCost: Number(l.purchaseCost),
          makingCost: Number(l.makingCost) || 0,
          otherCost: Number(l.otherCost) || 0,
          ...(tagPrices ? { sellingPrice: Number(l.sellingPrice) } : {}),
        })),
      }, actionKeys.for('purchase')),
    onSuccess: (p) => {
      actionKeys.rotate('purchase');
      toast.success(t('Purchase {number} received', { number: p.number }), t('{n} piece(s) now AVAILABLE: {codes}', { n: p.itemCodes.length, codes: p.itemCodes.join('، ') }));
      qc.invalidateQueries();
      onClose();
      navigate(`/purchases/${p.id}`);
    },
    onError: (e) => {
      // MKC-1 (Q4): the same transfer reference is already on another order: ask before recording it (never a block).
      if (e instanceof ApiError && e.code === 'DUPLICATE_BANK_REFERENCE') {
        setDuplicateOf((e.details as { number?: string } | undefined)?.number ?? '—');
        return;
      }
      if (e instanceof ApiError && e.code === 'SUPPLIER_GOLD_OWED') {
        setServerDebt({ supplierId: Number(supplierId), ...(e.details as Omit<SupplierDebt, 'supplierId'>) });
        return;
      }
      toast.fromError(e);
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New purchase (stock receipt)')}
      subtitle={t('Pieces are created as PURCHASED → RECEIVED → AVAILABLE with a PURCHASE ledger movement.')}
      width="max-w-6xl"
      footer={
        <>
          <span className="me-auto text-[13px] text-ink-600">
            {t('{n} piece(s) · total cost', { n: lines.length })} <b className="num">{money(total)}</b>
            {' · '}
            {t('Making charge (paid by the owner)')} <b className="num">{money(making)}</b>
          </span>
          {missing && (
            <span className="text-meta text-ink-3" role="status" data-testid="purchase-missing">
              {missing}
            </span>
          )}
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate({})} data-testid="purchase-save">{t('Receive into stock')}</Button>
        </>
      }
    >
      <div onKeyDown={enterToNext}>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {isGlobal && (
          <Field label={t('Receiving branch')}>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')} data-testid="purchase-branch">
              <option value="">{t('Select…')}</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('Supplier')} hint={<NewButton testId="purchase-new-supplier" onClick={() => setNewSupplier(true)}>{t('New supplier')}</NewButton>}>
          <Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value ? Number(e.target.value) : ''); setServerDebt(null); setConfirmed((c) => ({ ...c, debt: false })); }} data-testid="purchase-supplier">
            <option value="">{suppliers.data?.length === 0 ? t('No suppliers yet: add one') : t('Select…')}</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{L(s.name, s.nameAr)}</option>)}
          </Select>
        </Field>
        <Field label={t('Supplier invoice no.')}>
          <ReferenceInput value={invoiceNo} onValueChange={setInvoiceNo} maxChars={60} data-testid="purchase-invoice-no" />
        </Field>
        <Field label={t('Making charge')}>
          <span className="block py-2 text-[13px] text-ink-700" data-testid="purchase-mkc-payer">{t('Paid by the owner, by bank transfer from the owner’s personal account')}</span>
        </Field>
        {making > 0 && (
          <>
            <Field label={t('Transfer reference')} hint={transferRef && !validBankReference(transferRef) ? t('4 to 40 letters or digits') : undefined}>
              <ReferenceInput value={transferRef} onValueChange={(v) => { setTransferRef(v); setDuplicateOf(null); }} data-testid="purchase-mkc-reference" />
            </Field>
            <Field label={t('Transfer date')}>
              <DateInput value={transferDate} max={todayKey()} onChange={setTransferDate} data-testid="purchase-mkc-date" />
            </Field>
          </>
        )}
      </div>
      <Alert tone="info" className="mb-3">
        {t('Gold for gold: the supplier is owed the pieces’ weight as 24K pure gold, settled later with broken scrap only. The making charge is the only money paid: the owner pays it by bank transfer, and no branch money moves.')}
      </Alert>
      {openDebt && (
        <Alert tone="warning" className="mb-3">
          <span className="flex flex-wrap items-center gap-3" data-testid="purchase-supplier-debt">
            <span>
              {openDebt.orders > 1
                ? t('We still owe this supplier {weight} of 24K over {orders} open orders; the oldest, {number}, has been open for {days} days.', { weight: ltr(grams(openDebt.pureMg24)), orders: ltr(String(openDebt.orders)), number: ltr(openDebt.oldestNumber ?? '—'), days: ltr(String(openDebt.days ?? 0)) })
                : t('We still owe this supplier {weight} of 24K from order {number}, open for {days} days.', { weight: ltr(grams(openDebt.pureMg24)), number: ltr(openDebt.oldestNumber ?? '—'), days: ltr(String(openDebt.days ?? 0)) })}{' '}
              {t('The supplier usually opens a new order only after it is settled. Record anyway?')}
            </span>
            <Button size="sm" disabled={!valid} onClick={() => { setConfirmed((c) => ({ ...c, debt: true })); m.mutate({ confirmDebt: true }); }} loading={m.isPending} data-testid="purchase-supplier-debt-confirm">{t('Record anyway')}</Button>
          </span>
        </Alert>
      )}
      {duplicateOf && (
        <Alert tone="warning" className="mb-3">
          <span className="flex flex-wrap items-center gap-3" data-testid="purchase-duplicate">
            {t('This transfer reference is already on supplier order {number}. Record it anyway?', { number: duplicateOf })}
            <Button size="sm" onClick={() => { setConfirmed((c) => ({ ...c, duplicate: true })); m.mutate({ confirmDuplicate: true }); }} loading={m.isPending} data-testid="purchase-duplicate-confirm">{t('Record anyway')}</Button>
          </span>
        </Alert>
      )}
      {!tagPrices && (
        <p className="mb-2 text-meta text-ink-3" data-testid="purchase-price-follows-rate">{t('No selling price to type: each piece sells at its net weight × today’s new-piece rate of its karat.')}</p>
      )}
      <div className={clsx(lineGrid, 'mb-1 border-b border-line pb-2')} data-testid="purchase-line-hints">
        {columns.map((c) => (
          <div key={c.key} className={clsx(c.key === 'product' && 'col-span-2 md:col-span-1')}>
            <span className="block text-meta font-medium text-ink-2">{t(c.label)}</span>
            <span id={`line-hint-${c.key}`} className="block text-[11.5px] leading-snug text-ink-3">{t(c.hint)}</span>
          </div>
        ))}
      </div>
      <div className="space-y-2 md:space-y-0">
        {lines.map((l, i) => {
          const field = (key: string) => ({ 'aria-describedby': `line-hint-${key}`, 'aria-label': `${t(LINE_COLUMNS.find((c) => c.key === key)!.label)} · ${t('Piece {n}', { n: i + 1 })}` });
          const mobileLabel = (key: string) => <span className="mb-1 block text-meta text-ink-2 md:hidden">{t(LINE_COLUMNS.find((c) => c.key === key)!.label)}</span>;
          return (
            <div key={i} role="group" aria-label={t('Piece {n}', { n: i + 1 })} className="rounded-control border border-line p-2 md:rounded-none md:border-0 md:p-0 md:py-1" data-testid={`purchase-line-${i}`}>
              <div className={lineGrid}>
                <div className="col-span-2 md:col-span-1">
                  {mobileLabel('product')}
                  <ProductPicker
                    compact
                    products={sellable}
                    value={l.productId}
                    onChange={(id) => upd(i, { productId: id })}
                    onCreate={(name) => setCreating({ line: i, name })}
                    testId={`line-product-${i}`}
                    aria-describedby="line-hint-product"
                  />
                </div>
                <div>{mobileLabel('gross')}<WeightInput compact ref={(el) => { fields.current.set(`gross-${i}`, el); }} value={l.gross} onValueChange={(v) => upd(i, { gross: v })} {...field('gross')} data-testid={`line-gross-${i}`} /></div>
                <div>{mobileLabel('net')}<WeightInput compact value={l.net} onValueChange={(v) => upd(i, { net: v })} {...field('net')} data-testid={`line-net-${i}`} /></div>
                <div>{mobileLabel('cost')}<MoneyInput compact value={l.purchaseCost} onValueChange={(v) => upd(i, { purchaseCost: v })} {...field('cost')} data-testid={`line-cost-${i}`} /></div>
                <div>{mobileLabel('making')}<MoneyInput compact placeholder="0" value={l.makingCost} onValueChange={(v) => upd(i, { makingCost: v })} {...field('making')} data-testid={`line-making-${i}`} /></div>
                <div>{mobileLabel('other')}<MoneyInput compact placeholder="0" value={l.otherCost} onValueChange={(v) => upd(i, { otherCost: v })} {...field('other')} data-testid={`line-other-${i}`} /></div>
                {tagPrices && <div>{mobileLabel('price')}<MoneyInput compact value={l.sellingPrice} onValueChange={(v) => upd(i, { sellingPrice: v })} {...field('price')} data-testid={`line-price-${i}`} /></div>}
                <div className="col-span-2 flex justify-end md:col-span-1 md:block">
                  <button
                    type="button"
                    onClick={() => { setLines((ls) => ls.filter((_, j) => j !== i)); setCreating(null); }}
                    disabled={lines.length === 1}
                    className="flex size-11 items-center justify-center rounded-control text-ink-400 hover:text-rose-600 disabled:opacity-30 md:size-9"
                    aria-label={t('Remove piece {n}', { n: i + 1 })}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
              {creating?.line === i && (
                <div className="mt-2">
                  <NewProductPanel
                    name={creating.name}
                    testId={`line-new-product-${i}`}
                    onCancel={() => setCreating(null)}
                    onCreated={(p) => {
                      upd(i, { productId: p.id });
                      setCreating(null);
                      setFocusLine(i);
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <Button size="sm" variant="ghost" className="h-11 md:h-8" icon={<Plus className="size-4" />} onClick={addPiece} data-testid="purchase-add-piece">{t('Add another piece')}</Button>
        <span className="text-[13px] text-ink-600" data-testid="purchase-net-sum">
          {t('Net weight of all pieces: {weight} — compare with the supplier’s invoice.', { weight: ltr(grams(netSum)) })}
        </span>
      </div>
      </div>
      {newSupplier && (
        <NewSupplierDialog
          onClose={() => setNewSupplier(false)}
          onCreated={(s) => {
            setSupplierId(s.id);
            setNewSupplier(false);
          }}
        />
      )}
    </Dialog>
  );
}

export function PurchaseDetailPage() {
  const id = Number(useParams().id);
  const { t, L, lang } = useI18n();
  const { isGlobal, can } = useAuth();
  const showCost = can('profit.view');
  const q = useQuery({
    queryKey: ['purchase', id],
    queryFn: () =>
      get<
        PurchaseRow & {
          notes: string | null;
          // COST (General Manager only).
          goldDebtMgPure24: number | null;
          // Operational (D-4-13): visible to the branch manager too.
          goldOwedMgPure24: number | null;
          makingChargePaid?: number | null;
          makingChargePaidFrom: 'OWNER_PERSONAL' | null;
          // MKC-1: the owner's transfer (General Manager only).
          makingChargeReference?: string | null;
          makingChargeTransferDate?: string | null;
          settlements: Settlement[];
          items: { itemId: number; code: string; productName: string; productNameAr: string; karat: number; netWeightMg: number; purchaseCost: number; makingCost: number; otherCost: number; sellingPrice: number | null; status: string }[];
        }
      >(`/purchases/${id}`),
  });
  if (!q.data) return <DetailPending query={q} backTo="/purchases" backLabel={t('Back to purchases')} notFoundTitle={t('This purchase does not exist')} />;
  const p = q.data!;
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={<Crumbs items={[...(isGlobal ? [{ label: t('Company'), to: '/overview' }, { label: p.branchName, to: `/branches/${p.branchId}` }] : []), { label: t('Purchases'), to: '/purchases' }, { label: p.number }]} />}
        title={<span>{t('Purchase')} <Mono className="text-xl">{p.number}</Mono></span>}
        subtitle={t('{when} · {branch} · received by {user}', { when: dateTime(p.createdAt, lang), branch: t(p.branchName), user: p.createdByName })}
      />
      <Card className="mb-5">
        <KeyValue
          cols={4}
          items={[
            { label: t('Supplier'), value: p.supplierName || p.supplierNameAr ? <span data-testid="purchase-supplier-name">{L(p.supplierName, p.supplierNameAr)}</span> : '—' },
            { label: t('Supplier invoice'), value: p.supplierInvoiceNo ?? '—' },
            { label: t('Items'), value: p.itemCount },
            { label: t('Making charge paid by'), value: p.makingChargePaidFrom ? <span data-testid="purchase-mkc-paid-by">{t('The owner (personal account)')}</span> : '—' },
            ...(showCost
              ? [
                  { label: t('Total cost'), value: money(p.totalCost) },
                  { label: t('Making charge paid'), value: p.makingChargePaid == null ? '—' : money(p.makingChargePaid) },
                  {
                    label: t('Owner’s transfer'),
                    value: p.makingChargeReference ? (
                      <span data-testid="purchase-mkc-transfer"><Mono>{ltr(p.makingChargeReference)}</Mono> · <span className="num">{ltr(p.makingChargeTransferDate ?? '')}</span></span>
                    ) : '—',
                  },
                ]
              : []),
            // Gold weights are operational (D-4-13, D-4-16): visible to the branch manager too.
            { label: t('Gold owed to the supplier (24K)'), value: p.goldDebtMgPure24 == null ? '—' : <span data-testid="gold-debt">{grams(p.goldDebtMgPure24)}</span> },
            {
              label: t('Still owed (24K)'),
              value:
                p.goldOwedMgPure24 == null ? (
                  t('Recorded before gold settlement')
                ) : p.goldOwedMgPure24 === 0 ? (
                  <span className="font-semibold text-emerald-700">{t('Fully settled')}</span>
                ) : (
                  <span className="font-semibold num" data-testid="gold-owed">{grams(p.goldOwedMgPure24)}</span>
                ),
            },
          ]}
        />
      </Card>
      <SettlementsCard purchaseId={p.id} branchId={p.branchId} settlements={p.settlements} owed={p.goldOwedMgPure24} />
      <Card padded={false}>
        <CardHeader title={t('Pieces received')} subtitle={t('Current status shows where each piece is now')} />
        <table className="w-full text-[13px]">
          <thead className="bg-[#f7f8fa] text-ink-500">
            <tr>
              <th className="px-5 py-2 text-start font-medium">{t('Item')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Net weight')}</th>
              {showCost && (
                <>
                  <th className="px-3 py-2 text-end font-medium">{t('Purchase')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Making')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Other')}</th>
                </>
              )}
              <th className="px-3 py-2 text-end font-medium">{t('Selling price')}</th>
              <th className="px-5 py-2 text-start font-medium">{t('Now')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {p.items.map((i) => (
              <tr key={i.itemId}>
                <td className="px-5 py-2.5"><Link to={`/inventory/${i.itemId}`} className="hover:underline"><Mono className="font-semibold">{i.code}</Mono> · {L(i.productName, i.productNameAr)} · {karatLabel(i.karat)}</Link></td>
                <td className="px-3 py-2.5 text-end num">{grams(i.netWeightMg)}</td>
                {showCost && (
                  <>
                    <td className="px-3 py-2.5 text-end num">{money(i.purchaseCost, false)}</td>
                    <td className="px-3 py-2.5 text-end num">{money(i.makingCost, false)}</td>
                    <td className="px-3 py-2.5 text-end num">{money(i.otherCost, false)}</td>
                  </>
                )}
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

/**
 * Supplier settlement (D-4-5): when the supplier's representative visits, the branch manager hands
 * over broken scrap from the branch pool. Weight and karat ONLY: there is no amount, no cash and no
 * bank option anywhere on this form, and the API refuses any such field.
 */
function SettlementsCard({ purchaseId, branchId, settlements, owed }: { purchaseId: number; branchId: number; settlements: Settlement[]; owed?: number | null }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const canSettle = can('purchases.settle') && owed !== 0;
  return (
    <Card padded={false} className="mb-5">
      <CardHeader title={t('Supplier settlements (broken scrap)')} subtitle={t('Gold owed to the supplier is settled only with broken-scrap weight from this branch’s pool. Never with cash or bank.')} />
      {settlements.length ? (
        <table className="w-full text-[13px]">
          <thead className="bg-[#f7f8fa] text-ink-500">
            <tr>
              <th className="px-5 py-2 text-start font-medium">{t('Settlement')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('Date')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Karat')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Weight')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('24K equivalent')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('Still owed after')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('Recorded by')}</th>
              <th className="px-5 py-2 text-start font-medium">{t('Note')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {settlements.map((s) => (
              <tr key={s.id}>
                <td className="px-5 py-2"><Mono className="font-semibold">{s.number}</Mono></td>
                <td className="px-3 py-2">{dateTime(s.at, lang)}</td>
                <td className="px-3 py-2 text-end">{karatLabel(s.settledKarat)}</td>
                <td className="px-3 py-2 text-end num">{grams(s.settledWeightMg)}</td>
                <td className="px-3 py-2 text-end num">{grams(s.settledPureMg24)}</td>
                <td className="px-3 py-2 text-end font-medium num">{s.owedAfterMgPure24 != null ? grams(s.owedAfterMgPure24) : '—'}</td>
                <td className="px-3 py-2">{s.createdByName}</td>
                <td className="px-5 py-2 text-ink-600">{s.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-5 py-3 text-[13px] text-ink-500">{t('No settlements yet.')}</p>
      )}
      {canSettle && <SettleForm purchaseId={purchaseId} branchId={branchId} owed={owed ?? null} />}
    </Card>
  );
}

interface PoolView {
  branches: { branchId: number; byKarat: { karat: number; weightMg: number; pureMg24: number }[] }[];
}

function SettleForm({ purchaseId, branchId, owed }: { purchaseId: number; branchId: number; owed: number | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const actionKeys = useActionKeys();
  const pool = useQuery({ queryKey: ['scrap-pool', branchId], queryFn: () => get<PoolView>('/scrap-pool', { branchId }) });
  const inPool = pool.data?.branches.find((b) => b.branchId === branchId)?.byKarat ?? [];
  const [karat, setKarat] = useState<number | ''>('');
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const scope = `settle:${purchaseId}`;
  const m = useMutation({
    mutationFn: () => postOnce<{ number: string }>(`/purchases/${purchaseId}/settlements`, { karat, weightMg: mg, note: note.trim() || undefined }, actionKeys.for(scope)),
    onSuccess: (r) => {
      actionKeys.rotate(scope);
      toast.success(t('Settlement {number} recorded', { number: r.number }), t('The scrap weight left the branch pool.'));
      setWeight('');
      setNote('');
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  const available = inPool.find((x) => x.karat === karat)?.weightMg ?? 0;
  const mg = parseWeightInput(weight) ?? 0;
  // Preview with the same single pure-gold helper the server uses.
  const pure = karat !== '' && mg > 0 ? pureGoldMg(mg, karat) : 0;
  const tooMuch = owed != null && pure > owed;
  const valid = karat !== '' && mg > 0 && mg <= available && !tooMuch;
  return (
    <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-[160px_160px_1fr_auto] sm:items-end" data-testid="settlement-form">
      <Field label={t('Scrap karat')}>
        <Select value={karat} onChange={(e) => setKarat(e.target.value ? Number(e.target.value) : '')}>
          <option value="">{t('Select…')}</option>
          {inPool.map((x) => (
            <option key={x.karat} value={x.karat}>{t('{karat} · {weight} in the pool', { karat: karatLabel(x.karat), weight: grams(x.weightMg) })}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('Weight handed over (g)')}>
        <WeightInput value={weight} onValueChange={setWeight} data-testid="settlement-weight" />
      </Field>
      <Field label={t('Note (optional)')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={t('e.g. representative’s name')} />
      </Field>
      <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>
        {t('Record settlement')}
      </Button>
      {pure > 0 && owed != null && (
        <p className={'text-[12.5px] sm:col-span-4 ' + (tooMuch ? 'text-rose-700' : 'text-ink-600')} data-testid="settle-preview">
          {tooMuch
            ? t('This weight is more than the gold still owed on this purchase')
            : t('Settles {pure} (24K). Still owed after: {left}', { pure: grams(pure), left: grams(owed - pure) })}
        </p>
      )}
      {!pool.isLoading && !inPool.length && <p className="text-[12.5px] text-amber-700 sm:col-span-4">{t('The branch scrap pool is empty: buy broken scrap first.')}</p>}
    </div>
  );
}
