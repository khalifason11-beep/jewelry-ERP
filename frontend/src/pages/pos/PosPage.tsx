import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowRight,
  Ban,
  Banknote,
  Clock3,
  CreditCard,
  Landmark,
  Pause,
  PlayCircle,
  Printer,
  ScanBarcode,
  Search,
  ShoppingBag,
  Smartphone,
  Trash2,
  Wheat,
  X,
} from 'lucide-react';
import type { PaymentMethod } from '@jerp/shared';
import { get, postOnce } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { grams, karatLabel, money, relative } from '../../lib/format';
import { useBranches, useCategories, useDebounced } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import type { ItemRow } from '../../lib/types';
import { Button, Dialog, Empty, ErrorState, Input, ItemThumb, Select, Skeleton } from '../../components/ui';
import { InvoiceDocument, type SaleDetail } from '../../components/InvoiceDocument';
import { printSaleInvoice } from '../../print/actions';
import { useActionKeys } from '../../lib/idempotency';

interface CartLine {
  item: ItemRow;
  discount: number;
}
interface HeldSale {
  id: string;
  at: string;
  lines: CartLine[];
  customerName: string;
  customerPhone: string;
}

const PAY_ICON: Record<PaymentMethod, typeof Banknote> = { CASH: Banknote, BANK_TRANSFER: Landmark, CARD: CreditCard, MOBILE_WALLET: Smartphone, HASAD: Wheat };
/** What the counter offers when the setting is not loaded yet (D-4-6). */
const DEFAULT_POS_METHODS: PaymentMethod[] = ['CASH', 'BANK_TRANSFER', 'HASAD'];

export function PosPage() {
  const { me, can, isGlobal } = useAuth();
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);

  const branches = useBranches();
  const [branchId, setBranchId] = useState<number | undefined>(me?.user.branch?.id);
  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0].id);
  }, [branches.data, branchId]);

  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [karat, setKarat] = useState<number | ''>('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<'code' | 'weight' | 'price' | 'recent'>('recent');
  const categories = useCategories();

  const items = useQuery({
    queryKey: ['pos-items', branchId, dq, karat, category, sort],
    queryFn: () => get<{ items: ItemRow[]; total: number }>('/inventory/items', { branchId, q: dq, karat, categoryId: category || undefined, sort, status: 'AVAILABLE,RESERVED', limit: 300 }),
    enabled: !!branchId,
  });

  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [payment, setPayment] = useState<PaymentMethod>('CASH');
  // Hasad: the cashier types the Hasad invoice number (required) and transaction reference.
  const [hasadInvoice, setHasadInvoice] = useState('');
  const [hasadTxn, setHasadTxn] = useState('');
  const payMethods = me?.posPaymentMethods?.length ? me.posPaymentMethods : DEFAULT_POS_METHODS;
  const sellableKarats = me?.allowedKarats ?? [];
  const [invoice, setInvoice] = useState<SaleDetail | null>(null);
  // Printing (D-print-4): never blocks or undoes the sale; the original prints once.
  const [printing, setPrinting] = useState(false);
  const [printedId, setPrintedId] = useState<number | null>(null);
  const printInvoice = async (saleId: number) => {
    setPrinting(true);
    const r = await printSaleInvoice(saleId);
    setPrinting(false);
    if (r.ok) setPrintedId(saleId);
    else toast.fromError(r.error, t('Printing failed. The sale is saved; a manager can reprint the invoice.'));
  };
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showHeld, setShowHeld] = useState(false);

  const heldKey = `jerp.held.${me?.user.id}`;
  const [held, setHeld] = useState<HeldSale[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(heldKey) ?? '[]');
    } catch {
      return [];
    }
  });
  const saveHeld = (h: HeldSale[]) => {
    setHeld(h);
    try {
      localStorage.setItem(heldKey, JSON.stringify(h));
    } catch {
      /* storage unavailable — held sales live for this session only */
    }
  };

  const maxPct = me?.maxDiscountPercent ?? 0;
  const canDiscount = can('sales.discount') && maxPct > 0;
  const inCart = useMemo(() => new Set(cart.map((l) => l.item.id)), [cart]);
  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, l) => s + l.item.sellingPrice, 0);
    const discount = cart.reduce((s, l) => s + l.discount, 0);
    return { subtotal, discount, total: subtotal - discount, weight: cart.reduce((s, l) => s + l.item.netWeightMg, 0) };
  }, [cart]);

  const add = (item: ItemRow) => {
    if (item.status !== 'AVAILABLE') return toast.info(t('{code} is reserved', { code: item.code }), t('It cannot be sold until it is available again.'));
    if (inCart.has(item.id)) return toast.info(t('{code} is already in the cart', { code: item.code }));
    setCart((c) => [...c, { item, discount: 0 }]);
  };
  const remove = (id: number) => setCart((c) => c.filter((l) => l.item.id !== id));
  const reset = () => {
    setCart([]);
    setCustomerName('');
    setCustomerPhone('');
    setPayment('CASH');
    setHasadInvoice('');
    setHasadTxn('');
  };

  // Barcode scanners type the code and press Enter.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const term = q.trim().toLowerCase();
    const exact = items.data?.items.find((i) => i.barcode === term || i.code.toLowerCase() === term);
    const only = items.data?.items.length === 1 ? items.data.items[0] : undefined;
    const hit = exact ?? only;
    if (hit) {
      add(hit);
      setQ('');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const actionKeys = useActionKeys();
  const complete = useMutation({
    mutationFn: () =>
      postOnce<SaleDetail>('/sales', {
        branchId,
        items: cart.map((l) => ({ itemId: l.item.id, discount: l.discount })),
        paymentMethod: payment,
        ...(payment === 'HASAD' ? { paymentRefInvoice: hasadInvoice.trim(), paymentRefTransaction: hasadTxn.trim() || undefined } : {}),
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
      }, actionKeys.for('sale')),
    onSuccess: (sale) => {
      actionKeys.rotate('sale');
      toast.success(`${t('Sale completed')} · ${sale.number}`, t('{total}: {n} item(s) marked SOLD', { total: money(sale.total), n: sale.items.length }));
      setInvoice(sale);
      if (me?.print.autoPrintAfterSale) void printInvoice(sale.id);
      reset();
      qc.invalidateQueries({ queryKey: ['pos-items'] });
      qc.invalidateQueries({ queryKey: ['my-sales'] });
    },
    onError: (e) => {
      toast.fromError(e, t('Sale not completed'));
      qc.invalidateQueries({ queryKey: ['pos-items'] });
    },
  });

  const hold = () => {
    if (!cart.length) return;
    saveHeld([...held, { id: crypto.randomUUID?.() ?? String(Date.now()), at: new Date().toISOString(), lines: cart, customerName, customerPhone }]);
    reset();
    toast.info(t('Sale held'), t('Find it under “Held sales” to resume. Items are not reserved while held.'));
  };

  const branchName = me?.user.branch ? L(me.user.branch.name, me.user.branch.nameAr) : L(branches.data?.find((b) => b.id === branchId)?.name, branches.data?.find((b) => b.id === branchId)?.nameAr);

  return (
    <div className="flex h-full min-h-0">
      {/* ───────── Main: product search/grid ───────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-line bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {isGlobal && (
              <Select value={branchId ?? ''} onChange={(e) => { setBranchId(Number(e.target.value)); setCart([]); }} className="w-44" aria-label={t('Branch')}>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>
                ))}
              </Select>
            )}
            <div className="relative min-w-[260px] flex-1">
              <ScanBarcode className="pointer-events-none absolute start-3 top-1/2 size-[18px] -translate-y-1/2 text-ink-400" />
              <Input
                ref={searchRef}
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={t('Scan barcode or search by name, code…')}
                className="h-10 ps-10 text-[14px]"
                aria-label={t('Search products')}
              />
              <kbd className="absolute end-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-canvas px-1.5 text-[11px] text-ink-500 sm:block">/</kbd>
            </div>
            <Select value={karat} onChange={(e) => setKarat(e.target.value ? Number(e.target.value) : '')} className="h-10 w-32" aria-label={t('Karat')}>
              <option value="">{t('Karat')}: {t('All')}</option>
              {sellableKarats.map((k) => (
                <option key={k} value={k}>{karatLabel(k)}</option>
              ))}
            </Select>
            <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="h-10 w-36" aria-label={t('Sort')}>
              <option value="recent">{t('Newest first')}</option>
              <option value="code">{t('By code')}</option>
              <option value="weight">{t('By weight')}</option>
              <option value="price">{t('By price')}</option>
            </Select>
          </div>
          <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">
            <Chip active={!category} onClick={() => setCategory('')}>{t('All')}</Chip>
            {categories.data?.map((c) => (
              <Chip key={c.id} active={category === String(c.id)} onClick={() => setCategory(String(c.id))}>{L(c.name, c.nameAr)}</Chip>
            ))}
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
          {items.isLoading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3">
              {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-56" />)}
            </div>
          ) : items.isError ? (
            <ErrorState error={items.error} onRetry={() => items.refetch()} />
          ) : !items.data?.items.length ? (
            !q && karat === '' && !category ? (
              // REM-3: no filter is active, so the branch simply has no stock yet (not "no match").
              <div data-testid="pos-no-stock">
                <Empty
                  icon={<ShoppingBag className="size-5" />}
                  title={t('No pieces in this branch yet')}
                  body={can('purchases.create') ? t('Receive a supplier order or buy scrap to add stock.') : t('Ask your branch manager to receive stock.')}
                />
              </div>
            ) : (
              <Empty icon={<Search className="size-5" />} title={t('No matching pieces')} body={q ? t('Nothing in {branch} matches “{q}”.', { branch: branchName, q }) : t('No pieces match these filters.')} />
            )
          ) : (
            <>
              <div className="mb-2 text-xs text-ink-500 num">
                {t('{n} pieces', { n: items.data.total })} · {branchName}
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3">
                {items.data.items.map((i) => (
                  <ProductCard key={i.id} item={i} inCart={inCart.has(i.id)} onAdd={() => add(i)} />
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {/* ───────── Cart / invoice ───────── */}
      <aside className="flex w-[380px] shrink-0 flex-col border-s border-line bg-white xl:w-[410px]">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold">{t('Current sale')}</div>
            <div className="text-xs text-ink-500">
              {branchName} · {me?.user.fullName}
            </div>
          </div>
          <Button size="sm" variant="ghost" icon={<Clock3 className="size-4" />} onClick={() => setShowHeld(true)} disabled={!held.length}>
            {t('Held sales')} {held.length > 0 && <span className="rounded-full bg-gold-100 px-1.5 text-[11px] text-gold-700">{held.length}</span>}
          </Button>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {cart.length === 0 ? (
            <Empty icon={<ShoppingBag className="size-5" />} title={t('Cart is empty')} body={t('Scan or click a piece to add it.')} className="h-full" />
          ) : (
            <ul className="divide-y divide-line">
              {cart.map((l) => (
                <li key={l.item.id} className="px-4 py-3">
                  <div className="flex gap-3">
                    <ItemThumb category={l.item.categoryCode} karat={l.item.karat} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{L(l.item.productName, l.item.productNameAr)}</div>
                          <div className="font-mono text-[11.5px] text-ink-500">
                            {l.item.code} · {karatLabel(l.item.karat)} · {grams(l.item.netWeightMg)}
                          </div>
                        </div>
                        <button onClick={() => remove(l.item.id)} className="rounded p-1 text-ink-400 hover:bg-rose-50 hover:text-rose-600" aria-label={t('Remove {code}', { code: l.item.code })}>
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        {canDiscount ? (
                          <label className="flex items-center gap-1.5 text-xs text-ink-500">
                            {t('Discount')}
                            <Input
                              type="number"
                              min={0}
                              step={1000}
                              value={l.discount || ''}
                              placeholder="0"
                              onChange={(e) => {
                                const max = Math.floor((l.item.sellingPrice * maxPct) / 100);
                                const v = Math.max(0, Math.min(max, Number(e.target.value) || 0));
                                setCart((c) => c.map((x) => (x.item.id === l.item.id ? { ...x, discount: v } : x)));
                              }}
                              className="h-7 w-24 px-2 text-xs num"
                              aria-label={t('Discount for {code}', { code: l.item.code })}
                            />
                            <span className="text-[11px]">{t('max {pct}%', { pct: maxPct })}</span>
                          </label>
                        ) : (
                          <span />
                        )}
                        <div className="text-end">
                          {l.discount > 0 && <div className="text-[11px] text-ink-400 line-through num">{money(l.item.sellingPrice, false)}</div>}
                          <div className="font-semibold num">{money(l.item.sellingPrice - l.discount)}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-line bg-canvas/60 px-4 py-3">
          <div className="grid grid-cols-2 gap-2">
            <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder={t('Customer name (optional)')} className="h-8 text-[13px]" />
            <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder={t('Phone (optional)')} className="h-8 text-[13px]" />
          </div>
          <div className={clsx('mt-2 grid gap-1.5', payMethods.length === 3 ? 'grid-cols-3' : 'grid-cols-4')} role="radiogroup" aria-label={t('Payment method')} data-testid="pos-payment-methods">
            {payMethods.map((m) => {
              const Icon = PAY_ICON[m];
              return (
                <button
                  key={m}
                  role="radio"
                  aria-checked={payment === m}
                  onClick={() => setPayment(m)}
                  className={clsx(
                    'flex flex-col items-center gap-0.5 rounded-md border py-1.5 text-[11px] font-medium',
                    payment === m ? 'border-ink-900 bg-ink-900 text-white' : 'border-line-strong bg-white text-ink-600 hover:border-ink-400',
                  )}
                >
                  <Icon className={clsx('size-4', payment === m && 'text-gold-400')} />
                  {t(m)}
                </button>
              );
            })}
          </div>
          {payment === 'HASAD' && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Input value={hasadInvoice} onChange={(e) => setHasadInvoice(e.target.value)} maxLength={80} placeholder={t('Hasad invoice number')} aria-label={t('Hasad invoice number')} className="h-8 text-[13px]" />
              <Input value={hasadTxn} onChange={(e) => setHasadTxn(e.target.value)} maxLength={80} placeholder={t('Transaction reference (optional)')} aria-label={t('Transaction reference (optional)')} className="h-8 text-[13px]" />
            </div>
          )}
          <dl className="mt-3 space-y-1 text-[13px]">
            <div className="flex justify-between text-ink-600">
              <dt>{t('{n} pieces', { n: cart.length })} · {t('Net weight')}</dt>
              <dd className="num">{grams(totals.weight)}</dd>
            </div>
            <div className="flex justify-between text-ink-600">
              <dt>{t('Subtotal')}</dt>
              <dd className="num">{money(totals.subtotal)}</dd>
            </div>
            {totals.discount > 0 && (
              <div className="flex justify-between text-ink-600">
                <dt>{t('Discount')}</dt>
                <dd className="num">−{money(totals.discount)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between border-t border-line-strong pt-2">
              <dt className="font-semibold">{t('Total')}</dt>
              <dd className="text-2xl font-semibold tracking-tight num">{money(totals.total)}</dd>
            </div>
          </dl>
          <Button variant="gold" size="lg" className="mt-3 w-full text-[15px]" disabled={!cart.length || !branchId || (payment === 'HASAD' && !hasadInvoice.trim())} loading={complete.isPending} onClick={() => complete.mutate()}>
            {t('Complete Sale')} <ArrowRight className="size-4 rtl:rotate-180" />
          </Button>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Button size="sm" icon={<Pause className="size-4" />} onClick={hold} disabled={!cart.length}>{t('Hold')}</Button>
            <Button size="sm" icon={<Ban className="size-4" />} onClick={() => setConfirmCancel(true)} disabled={!cart.length}>{t('Cancel')}</Button>
            <Button size="sm" icon={<Printer className="size-4" />} onClick={() => invoice && setInvoice({ ...invoice })} disabled={!invoice}>{t('Print')}</Button>
          </div>
        </div>
      </aside>

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={t('Cancel this sale?')}
        subtitle={t('The cart will be cleared. Nothing has been recorded yet, so inventory is unaffected.')}
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>{t('Keep sale')}</Button>
            <Button variant="danger" data-autofocus onClick={() => { reset(); setConfirmCancel(false); }}>{t('Clear cart')}</Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-600">{t('{n} item(s), {total}.', { n: cart.length, total: money(totals.total) })}</p>
      </Dialog>

      <Dialog open={showHeld} onClose={() => setShowHeld(false)} title={t('Held sales')} subtitle={t('Held carts are stored on this device and do not reserve stock.')} width="max-w-xl">
        {held.length === 0 ? (
          <Empty title={t('No held sales')} />
        ) : (
          <ul className="divide-y divide-line">
            {held.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium">{h.customerName || t('Walk-in customer')} · {t('{n} item(s)', { n: h.lines.length })}</div>
                  <div className="text-xs text-ink-500">{h.lines.map((l) => l.item.code).join('، ')} · {t('held {when}', { when: relative(h.at) })}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => saveHeld(held.filter((x) => x.id !== h.id))} aria-label={t('Discard held sale')}><X className="size-4" /></Button>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<PlayCircle className="size-4" />}
                    onClick={() => {
                      setCart(h.lines);
                      setCustomerName(h.customerName);
                      setCustomerPhone(h.customerPhone);
                      saveHeld(held.filter((x) => x.id !== h.id));
                      setShowHeld(false);
                    }}
                  >
                    {t('Resume')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <Dialog
        open={!!invoice}
        onClose={() => setInvoice(null)}
        title={`${t('Sale completed')} · ${invoice?.number ?? ''}`}
        subtitle={t('Items are now SOLD and removed from available stock.')}
        width="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setInvoice(null)}>{t('New sale')}</Button>
            <Button
              variant="primary"
              icon={<Printer className="size-4" />}
              loading={printing}
              disabled={!invoice || (printedId === invoice.id && !can('sales.reprint'))}
              onClick={() => invoice && void printInvoice(invoice.id)}
              data-testid="pos-print"
            >
              {invoice && printedId === invoice.id ? t('Reprint') : t('Print')}
            </Button>
          </>
        }
      >
        {invoice && <InvoiceDocument sale={invoice} />}
      </Dialog>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'h-7 shrink-0 rounded-full border px-3 text-[12.5px] font-medium transition-colors',
        active ? 'border-ink-900 bg-ink-900 text-white' : 'border-line-strong bg-white text-ink-600 hover:border-ink-400',
      )}
    >
      {children}
    </button>
  );
}

function ProductCard({ item, inCart, onAdd }: { item: ItemRow; inCart: boolean; onAdd: () => void }) {
  const { t, L } = useI18n();
  const reserved = item.status === 'RESERVED';
  return (
    <button
      onClick={onAdd}
      disabled={reserved}
      data-testid="pos-product"
      className={clsx(
        'group flex flex-col overflow-hidden rounded-lg border bg-white text-start transition-all',
        inCart ? 'border-gold-500 ring-2 ring-gold-500/30' : 'border-line hover:border-gold-400 hover:shadow-md',
        reserved && 'cursor-not-allowed opacity-60',
      )}
      title={reserved ? t('Reserved: not available for sale') : t('Add {code}', { code: item.code })}
    >
      <div className="p-2 pb-0">
        <ItemThumb category={item.categoryCode} karat={item.karat} />
      </div>
      <div className="flex flex-1 flex-col p-3 pt-2.5">
        <div className="line-clamp-1 text-[13.5px] font-medium text-ink-900">{L(item.productName, item.productNameAr)}</div>
        <div className="font-mono text-[11px] text-ink-500">{item.code}</div>
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-600">
          <span className="rounded bg-canvas px-1.5 py-0.5 font-medium">{karatLabel(item.karat)}</span>
          <span className="num">{grams(item.netWeightMg)}</span>
        </div>
        <div className="mt-auto flex items-end justify-between pt-2">
          <span className="text-[15px] font-semibold text-ink-950 num">{money(item.sellingPrice, false)}</span>
          {reserved ? (
            <span className="text-[11px] font-medium text-amber-700">{t('Reserved')}</span>
          ) : inCart ? (
            <span className="text-[11px] font-medium text-gold-700">{t('In cart')}</span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-700">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {t('Available')}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
