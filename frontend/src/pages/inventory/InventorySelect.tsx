// Branch manager inventory (Phase 4): the branch's pieces as cards, like the POS, with filters for
// origin (new / scrap), karat, category and weight range. Pieces can be ticked one by one and sent
// to another branch with ONE "Transfer selected" action: one transfer with every selected piece,
// following the usual IN_TRANSIT → RECEIVED lifecycle. Never shown at the cashier POS.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Truck, X } from 'lucide-react';
import { postOnce, get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { grams, karatLabel, money } from '../../lib/format';
import { useBranchDirectory, useCategories, useDebounced } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useActionKeys } from '../../lib/idempotency';
import type { ItemRow } from '../../lib/types';
import { Button, Dialog, Empty, ErrorState, Field, Input, ItemThumb, Select, Skeleton, Textarea } from '../../components/ui';

type Origin = '' | 'SUPPLIER_NEW' | 'SCRAP';

/** Grams typed by the user → milligrams (empty = no bound). */
const toMg = (g: string) => (g.trim() && Number.isFinite(Number(g)) ? Math.round(Number(g) * 1000) : undefined);

export function InventorySelect() {
  const { t, L } = useI18n();
  const { me } = useAuth();
  const branchId = me?.user.branch?.id;
  const categories = useCategories();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [origin, setOrigin] = useState<Origin>('');
  const [karat, setKarat] = useState<number | ''>('');
  const [category, setCategory] = useState('');
  const [minG, setMinG] = useState('');
  const [maxG, setMaxG] = useState('');
  const dMin = useDebounced(minG);
  const dMax = useDebounced(maxG);
  const [selected, setSelected] = useState<Map<number, ItemRow>>(new Map());
  const [sending, setSending] = useState(false);

  const items = useQuery({
    queryKey: ['inventory-cards', branchId, dq, origin, karat, category, dMin, dMax],
    queryFn: () =>
      get<{ items: ItemRow[]; total: number }>('/inventory/items', {
        branchId,
        q: dq,
        origin: origin || undefined,
        karat,
        category,
        minWeightMg: toMg(dMin),
        maxWeightMg: toMg(dMax),
        status: 'AVAILABLE',
        sort: 'code',
        limit: 500,
      }),
    enabled: !!branchId,
  });
  const list = items.data?.items ?? [];
  const toggle = (i: ItemRow) =>
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(i.id)) n.delete(i.id);
      else n.set(i.id, i);
      return n;
    });
  const selectAll = () => setSelected((s) => new Map([...s, ...list.map((i) => [i.id, i] as const)]));
  const weight = useMemo(() => [...selected.values()].reduce((s, i) => s + i.netWeightMg, 0), [selected]);

  return (
    <div className="flex min-h-[60vh] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Code, barcode or product…')} className="h-8 w-56 text-[13px]" />
        <div className="flex rounded-md border border-line-strong p-0.5" role="radiogroup" aria-label={t('Origin')}>
          {([['', t('All')], ['SUPPLIER_NEW', t('New')], ['SCRAP', t('Scrap')]] as [Origin, string][]).map(([v, label]) => (
            <button
              key={v || 'all'}
              role="radio"
              aria-checked={origin === v}
              onClick={() => setOrigin(v)}
              className={clsx('h-7 rounded px-3 text-[12.5px] font-medium', origin === v ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-canvas')}
            >
              {label}
            </button>
          ))}
        </div>
        <Select value={karat} onChange={(e) => setKarat(e.target.value ? Number(e.target.value) : '')} className="h-8 w-24 text-[13px]" aria-label={t('Karat')}>
          <option value="">{t('Karat')}</option>
          {(me?.allowedKarats ?? []).map((k) => <option key={k} value={k}>{karatLabel(k)}</option>)}
        </Select>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="h-8 w-36 text-[13px]" aria-label={t('Category')}>
          <option value="">{t('Category')}</option>
          {categories.data?.map((c) => <option key={c.code} value={c.code}>{L(c.name, c.nameAr)}</option>)}
        </Select>
        <div className="flex items-center gap-1 text-[12.5px] text-ink-600">
          <Input value={minG} onChange={(e) => setMinG(e.target.value)} inputMode="decimal" placeholder={t('Min g')} aria-label={t('Minimum weight (g)')} className="h-8 w-20 text-[13px] num" />
          <span>–</span>
          <Input value={maxG} onChange={(e) => setMaxG(e.target.value)} inputMode="decimal" placeholder={t('Max g')} aria-label={t('Maximum weight (g)')} className="h-8 w-20 text-[13px] num" />
        </div>
        <span className="ms-auto text-[12.5px] text-ink-500">{t('{n} available', { n: items.data?.total ?? 0 })}</span>
        <Button size="sm" onClick={selectAll} disabled={!list.length}>{t('Select all shown')}</Button>
      </div>

      <div className="flex-1 p-4">
        {!branchId ? (
          <Empty title={t('Select a branch')} />
        ) : items.isError ? (
          <ErrorState error={items.error} onRetry={() => items.refetch()} />
        ) : items.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
            {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="h-56" />)}
          </div>
        ) : !list.length ? (
          <Empty title={t('No items match these filters')} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3" data-testid="inventory-cards">
            {list.map((i) => (
              <SelectableCard key={i.id} item={i} checked={selected.has(i.id)} onToggle={() => toggle(i)} />
            ))}
          </div>
        )}
      </div>

      <div className={clsx('sticky bottom-0 flex items-center gap-3 border-t border-line bg-white/95 px-4 py-3 backdrop-blur', !selected.size && 'text-ink-500')}>
        <span className="text-[13.5px]">
          {t('{n} piece(s) selected', { n: selected.size })} · <span className="num">{grams(weight)}</span>
        </span>
        {selected.size > 0 && (
          <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setSelected(new Map())}>{t('Clear')}</Button>
        )}
        <Button variant="primary" className="ms-auto" icon={<Truck className="size-4" />} disabled={!selected.size} onClick={() => setSending(true)} data-testid="transfer-selected">
          {t('Transfer selected')}
        </Button>
      </div>

      {sending && branchId && (
        <TransferDialog
          fromBranchId={branchId}
          items={[...selected.values()]}
          onClose={() => setSending(false)}
          onSent={() => {
            setSending(false);
            setSelected(new Map());
          }}
        />
      )}
    </div>
  );
}

function SelectableCard({ item, checked, onToggle }: { item: ItemRow; checked: boolean; onToggle: () => void }) {
  const { t, L } = useI18n();
  return (
    <label
      className={clsx(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-white text-start transition-all',
        checked ? 'border-gold-500 ring-2 ring-gold-500/30' : 'border-line hover:border-gold-400 hover:shadow-md',
      )}
    >
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={onToggle} aria-label={t('Select {code}', { code: item.code })} />
      <span
        className={clsx(
          'absolute end-2 top-2 z-10 flex size-5 items-center justify-center rounded border',
          checked ? 'border-ink-900 bg-ink-900 text-white' : 'border-line-strong bg-white',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-gold-500',
        )}
        aria-hidden
      >
        {checked && <Check className="size-3.5" />}
      </span>
      <div className="p-2 pb-0">
        <ItemThumb category={item.categoryCode} karat={item.karat} />
      </div>
      <div className="flex flex-1 flex-col p-3 pt-2.5">
        <div className="line-clamp-1 text-[13.5px] font-medium text-ink-900">{L(item.productName, item.productNameAr)}</div>
        <div className="font-mono text-[11px] text-ink-500">{item.code}</div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-600">
          <span className="rounded bg-canvas px-1.5 py-0.5 font-medium">{karatLabel(item.karat)}</span>
          <span className="num">{grams(item.netWeightMg)}</span>
          {item.origin === 'SCRAP' && <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800">{t('Scrap')}</span>}
        </div>
        <div className="mt-auto pt-2 text-[15px] font-semibold text-ink-950 num">{money(item.sellingPrice, false)}</div>
      </div>
    </label>
  );
}

function TransferDialog({ fromBranchId, items, onClose, onSent }: { fromBranchId: number; items: ItemRow[]; onClose: () => void; onSent: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const directory = useBranchDirectory();
  const [to, setTo] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const actionKeys = useActionKeys();
  const m = useMutation({
    // ONE transfer holding every selected piece.
    mutationFn: () => postOnce<{ id: number; number: string }>('/transfers', { toBranchId: to, itemIds: items.map((i) => i.id), notes: notes.trim() || undefined }, actionKeys.for('transfer')),
    onSuccess: (r) => {
      actionKeys.rotate('transfer');
      toast.success(t('Transfer {number} sent', { number: r.number }), t('{n} piece(s) are now in transit.', { n: items.length }));
      qc.invalidateQueries();
      onSent();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Transfer {n} piece(s)', { n: items.length })}
      footer={
        <>
          <Link to="/transfers" className="me-auto text-[13px] text-gold-700 hover:underline">{t('Transfer history')}</Link>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!to} loading={m.isPending} onClick={() => m.mutate()} data-testid="send-transfer">{t('Send transfer')}</Button>
        </>
      }
    >
      <Field label={t('To')}>
        <Select value={to} onChange={(e) => setTo(e.target.value ? Number(e.target.value) : '')} aria-label={t('Destination branch')}>
          <option value="">{t('Select…')}</option>
          {directory.data?.filter((b) => b.id !== fromBranchId).map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
        </Select>
      </Field>
      <ul className="scroll-thin mt-3 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line text-[13px]">
        {items.map((i) => (
          <li key={i.id} className="flex items-center gap-3 px-3 py-1.5">
            <span className="w-20 font-mono text-[12px]">{i.code}</span>
            <span className="flex-1 truncate">{L(i.productName, i.productNameAr)} · {karatLabel(i.karat)}</span>
            <span className="num">{grams(i.netWeightMg)}</span>
          </li>
        ))}
      </ul>
      <Field label={t('Notes')} className="mt-3">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </Field>
    </Dialog>
  );
}
