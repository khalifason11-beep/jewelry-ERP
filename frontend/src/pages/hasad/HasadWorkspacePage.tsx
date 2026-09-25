// Counter workspace for one Hasad Gold withdrawal: verify → pick → settle → complete.

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Coins,
  IdCard,
  KeyRound,
  Lock,
  Printer,
  Scale,
  Search,
  ShieldAlert,
  Undo2,
  UserRound,
  XCircle,
} from 'lucide-react';
import { calculateSettlement, PAYMENT_METHODS, type PaymentMethod, type AuditParams } from '@jerp/shared';
import { ApiError, del, errorText, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, grams, humanize, karatLabel, money, relative, signedGrams } from '../../lib/format';
import { useCategories, useDebounced, useGoldRates } from '../../lib/hooks';
import { auditText } from '../../lib/audit';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import type { ItemRow, Settlement, Withdrawal } from '../../lib/types';
import { Alert, Button, Card, CardHeader, Dialog, Empty, ErrorState, Field, Input, ItemThumb, Loading, Mono, Select, StatusBadge, Textarea } from '../../components/ui';

interface SelectedItem {
  redemptionItemId: number;
  id: number;
  code: string;
  barcode: string;
  productName: string;
  productNameAr: string;
  categoryCode: string;
  karat: number;
  grossWeightMg: number;
  netWeightMg: number;
  sellingPrice: number;
  status: string;
  reservedAt: string | null;
}

interface Detail {
  withdrawal: Omit<Withdrawal, 'branchName' | 'branchNameAr'> & { branchName: string; branchNameAr: string; branchCode: string };
  draft: { id: number; number: string; createdAt: string; customerVerified: boolean } | null;
  items: SelectedItem[];
  settlement: Settlement;
  reservationTimeoutMinutes: number;
  completed: null | {
    number: string;
    completedAt: string;
    cashierName: string;
    deliveredWeightMg: number;
    differenceMg: number;
    settlementDirection: string;
    settlementAmount: number;
    ratePerGram: number;
    items: { id: number; code: string; productName: string; productNameAr: string; karat: number; netWeightMg: number; unitCost?: number }[];
    settlement: { number: string; paymentMethod: string; amount: number } | null;
  };
  history: { id: number; number: string; status: string; createdAt: string; abortReason: string | null; cashierName: string }[];
  timeline: { at: string; action: string; description: string; descriptionKey: string | null; descriptionParams: AuditParams | null; userFullName: string }[];
}

export function HasadWorkspacePage() {
  const id = Number(useParams().id);
  const { t, L, lang } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ['hasad', 'detail', id], queryFn: () => get<Detail>(`/hasad/withdrawals/${id}`), refetchInterval: 20_000 });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['hasad'] });
    qc.invalidateQueries({ queryKey: ['pos-items'] });
  };

  const [cancelOpen, setCancelOpen] = useState(false);
  const [abortOpen, setAbortOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);

  if (q.isLoading) return <Loading />;
  if (q.isError) return <div className="p-6"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const d = q.data!;
  const w = d.withdrawal;
  const step = w.status === 'COMPLETED' ? 5 : w.status === 'IN_PROGRESS' ? (d.items.length ? 3 : 2) : 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="border-b border-line bg-white px-5 py-3.5">
        <div className="mb-1 flex items-center gap-1 text-[12.5px] text-ink-500">
          <Link to="/hasad" className="hover:text-ink-800">{t('Hasad Withdrawals')}</Link>
          <ChevronRight className="size-3.5 rtl:rotate-180" />
          <span className="font-mono">{w.externalId}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {L(w.customerName, w.customerNameAr)} <span className="font-mono text-base font-normal text-ink-500">· {w.externalId}</span>
          </h1>
          <StatusBadge status={w.status} />
          <div className="ms-auto flex gap-2">
            {w.status === 'IN_PROGRESS' && can('hasad.process') && (
              <Button icon={<Undo2 className="size-4" />} onClick={() => setAbortOpen(true)}>
                {t('Customer left — release')}
              </Button>
            )}
            {(w.status === 'READY_FOR_PICKUP' || w.status === 'IN_PROGRESS') && can('hasad.cancel') && (
              <Button variant="ghost" className="text-rose-700 hover:bg-rose-50 hover:text-rose-800" icon={<XCircle className="size-4" />} onClick={() => setCancelOpen(true)}>
                {t('Cancel request')}
              </Button>
            )}
          </div>
        </div>
        <Stepper step={step} status={w.status} />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-5 p-5 xl:grid-cols-[340px_1fr]">
          {/* Customer & entitlement */}
          <div className="space-y-4">
            <Card padded={false} className="overflow-hidden">
              <div className="bg-ink-900 px-5 py-4 text-white">
                <div className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-gold-300">{t('Entitled weight')}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-[34px] font-semibold tracking-tight text-gold-300 num">{(w.entitledWeightMg / 1000).toFixed(3)}</span>
                  <span className="text-ink-300">{t('g')} · {karatLabel(w.entitlementKarat)}</span>
                </div>
                <div className="mt-1 text-[12px] text-ink-400">{t('Balance accumulated in Hasad Gold (Haba units)')}</div>
              </div>
              <div className="space-y-3 p-5 text-[13px]">
                <Row icon={<UserRound />} label={t('Customer')} value={<>{L(w.customerName, w.customerNameAr)}<div className="font-mono text-[11.5px] text-ink-500">{w.hasadCustomerId}</div></>} />
                <Row icon={<IdCard />} label={t('National ID')} value={<Mono>{w.customerNationalIdMasked ?? '—'}</Mono>} />
                <Row icon={<KeyRound />} label={t('Phone')} value={w.customerPhone ?? '—'} />
                <Row icon={<Coins />} label={t('Branch')} value={L(w.branchName, w.branchNameAr)} />
                <Row icon={<Scale />} label={t('Requested')} value={<span title={dateTime(w.requestedAt, lang)}>{dateTime(w.requestedAt, lang)}</span>} />
              </div>
              <div className={clsx('border-t px-5 py-3 text-[12.5px]', d.items.length ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-line bg-canvas text-ink-600')}>
                <div className="flex items-center gap-2 font-medium">
                  <Lock className="size-3.5" /> {t('Inventory impact')}
                </div>
                <div className="mt-0.5">
                  {w.status === 'COMPLETED'
                    ? t('{n} piece(s) delivered and removed from stock (REDEEMED).', { n: d.completed?.items.length ?? 0 })
                    : d.items.length
                      ? t('{n} piece(s) RESERVED for this customer. Auto-release after {min} min of inactivity.', { n: d.items.length, min: d.reservationTimeoutMinutes })
                      : t('None. No piece is reserved until the customer chooses one.')}
                </div>
              </div>
            </Card>

            {d.timeline.length > 0 && (
              <Card padded={false}>
                <CardHeader title={t('Activity')} subtitle={t('From the audit log')} />
                <ol className="space-y-0 px-5 py-3">
                  {d.timeline.map((e, i) => (
                    <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-gold-500" />
                      <div className="min-w-0 text-[12.5px]">
                        <div className="font-medium text-ink-800">{humanize(e.action)}</div>
                        <div className="text-ink-600">{auditText(e)}</div>
                        <div className="text-[11px] text-ink-400">
                          {dateTime(e.at, lang)} · {e.userFullName}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </div>

          {/* Main work area */}
          <div className="min-w-0 space-y-4">
            {w.status === 'READY_FOR_PICKUP' && <OpenPanel detail={d} onOpened={invalidate} />}
            {w.status === 'IN_PROGRESS' && (
              <>
                <SettlementPanel detail={d} onComplete={() => setCompleteOpen(true)} onRelease={invalidate} />
                <CandidatePicker detail={d} onReserved={invalidate} />
              </>
            )}
            {w.status === 'COMPLETED' && d.completed && <CompletedPanel detail={d} />}
            {w.status === 'CANCELLED' && (
              <Card>
                <Empty icon={<CircleSlash className="size-5" />} title={t('This withdrawal was cancelled')} body={w.cancelReason ?? undefined} />
              </Card>
            )}
          </div>
        </div>
      </div>

      <ReasonDialog
        open={abortOpen}
        onClose={() => setAbortOpen(false)}
        title={t('Release reserved pieces?')}
        body={t('Use this when the customer leaves without taking a piece. All reserved pieces return to AVAILABLE; the Hasad request stays open for a later visit.')}
        defaultReason={t('Customer left without completing')}
        confirmLabel={t('Release & keep request open')}
        onConfirm={async (reason) => {
          await post(`/hasad/withdrawals/${id}/abort`, { reason });
          toast.success(t('Pieces released'), t('Reserved items are AVAILABLE again. The request is still open.'));
          invalidate();
        }}
      />
      <ReasonDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('Cancel withdrawal {id}?', { id: w.externalId })}
        body={t('The request is cancelled in Hasad Gold and cannot be resumed. Any reserved pieces return to AVAILABLE.')}
        confirmLabel={t('Cancel withdrawal')}
        danger
        onConfirm={async (reason) => {
          await post(`/hasad/withdrawals/${id}/cancel`, { reason });
          toast.success(t('{id} cancelled', { id: w.externalId }));
          invalidate();
        }}
      />
      {completeOpen && (
        <CompleteDialog
          detail={d}
          onClose={() => setCompleteOpen(false)}
          onDone={() => {
            setCompleteOpen(false);
            invalidate();
          }}
          onStale={() => q.refetch()}
        />
      )}
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 text-ink-400 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] text-ink-500">{label}</div>
        <div className="font-medium text-ink-900">{value}</div>
      </div>
    </div>
  );
}

function Stepper({ step, status }: { step: number; status: string }) {
  const { t } = useI18n();
  const steps = [t('Request received'), t('Customer verified'), t('Piece selected'), t('Settlement confirmed'), t('Delivered')];
  if (status === 'CANCELLED') return null;
  return (
    <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
      {steps.map((s, i) => {
        const n = i + 1;
        const done = n < step || step === 5;
        const current = n === step && step !== 5;
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              className={clsx(
                'grid size-5 place-items-center rounded-full text-[10.5px] font-semibold',
                done && 'bg-emerald-600 text-white',
                current && 'bg-gold-500 text-ink-950',
                !done && !current && 'bg-canvas text-ink-400 ring-1 ring-line-strong',
              )}
            >
              {done ? <Check className="size-3" /> : n}
            </span>
            <span className={clsx(current ? 'font-semibold text-ink-900' : done ? 'text-ink-700' : 'text-ink-400')}>{s}</span>
            {n < steps.length && <span className="mx-1 h-px w-6 bg-line-strong" />}
          </li>
        );
      })}
    </ol>
  );
}

function OpenPanel({ detail, onOpened }: { detail: Detail; onOpened: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [mode, setMode] = useState<'PICKUP_CODE' | 'ID_DOCUMENT'>('PICKUP_CODE');
  const [code, setCode] = useState('');
  const [idChecked, setIdChecked] = useState(false);
  const open = useMutation({
    mutationFn: () => post(`/hasad/withdrawals/${detail.withdrawal.id}/open`, { verification: mode, pickupCode: code }),
    onSuccess: () => {
      toast.success(t('Customer verified'), t('Let the customer choose a piece. Nothing is reserved yet.'));
      onOpened();
    },
    onError: (e) => toast.fromError(e, t('Could not open the request')),
  });
  return (
    <Card padded={false}>
      <CardHeader title={t('Customer arrived — open request')} subtitle={t('Verify the customer before showing pieces. Opening the request does not reserve any inventory.')} />
      <div className="grid gap-5 p-5 md:grid-cols-2">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('Verification method')}>
            {[
              { v: 'PICKUP_CODE' as const, label: t('Pickup code'), icon: <KeyRound className="size-4" /> },
              { v: 'ID_DOCUMENT' as const, label: t('National ID'), icon: <IdCard className="size-4" /> },
            ].map((o) => (
              <button
                key={o.v}
                role="radio"
                aria-checked={mode === o.v}
                onClick={() => setMode(o.v)}
                className={clsx('flex items-center justify-center gap-2 rounded-md border py-2.5 text-[13px] font-medium', mode === o.v ? 'border-ink-900 bg-ink-900 text-white' : 'border-line-strong hover:border-ink-400')}
              >
                {o.icon} {o.label}
              </button>
            ))}
          </div>
          {mode === 'PICKUP_CODE' ? (
            <Field label={t('6-digit pickup code shown in the customer’s Hasad app')} hint={t('Demo: HG-10025 → 482913 · HG-10027 → 640218')}>
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="••••••" className="h-11 text-center font-mono text-lg tracking-[0.5em]" />
            </Field>
          ) : (
            <label className="flex items-start gap-2.5 rounded-md border border-line p-3 text-[13px]">
              <input type="checkbox" checked={idChecked} onChange={(e) => setIdChecked(e.target.checked)} className="mt-0.5 size-4 accent-ink-900" />
              <span>
                {t('I checked the customer’s national ID. It matches {name} (ID ending {last4}).', {
                  name: detail.withdrawal.customerName,
                  last4: detail.withdrawal.customerNationalIdMasked?.slice(-4) ?? '',
                })}
              </span>
            </label>
          )}
          <Button
            variant="gold"
            size="lg"
            className="w-full"
            icon={<BadgeCheck className="size-5" />}
            disabled={mode === 'PICKUP_CODE' ? code.length !== 6 : !idChecked}
            loading={open.isPending}
            onClick={() => open.mutate()}
          >
            {t('Verify & start')}
          </Button>
        </div>
        <div className="rounded-lg bg-canvas p-4 text-[13px] text-ink-600">
          <div className="mb-2 font-semibold text-ink-800">{t('How the counter visit works')}</div>
          <ol className="list-decimal space-y-1.5 ps-4">
            <li>{t('Verify the customer. The request is locked in Hasad Gold.')}</li>
            <li>{t('The customer browses the branch’s available pieces.')}</li>
            <li>{t('A selected piece is reserved. Other cashiers cannot sell it.')}</li>
            <li>{t('The system compares the piece’s net weight with the {weight} entitlement.', { weight: grams(detail.withdrawal.entitledWeightMg) })}</li>
            <li>{t('Settle the difference in cash, confirm, and hand over the piece.')}</li>
          </ol>
        </div>
      </div>
    </Card>
  );
}

function DirectionBanner({ s }: { s: Settlement }) {
  const { t } = useI18n();
  if (s.direction === 'NONE')
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line bg-canvas px-4 py-3">
        <CheckCircle2 className="size-6 text-emerald-600" />
        <div>
          <div className="font-semibold">{t('Exact match. No settlement needed.')}</div>
          <div className="text-[12.5px] text-ink-500">{t('Delivered weight equals the entitlement.')}</div>
        </div>
      </div>
    );
  const branchPays = s.direction === 'BRANCH_PAYS_CUSTOMER';
  return (
    <div className={clsx('flex items-center gap-4 rounded-lg border px-4 py-3.5', branchPays ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50')}>
      <div className={clsx('grid size-11 shrink-0 place-items-center rounded-full', branchPays ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white')}>
        {branchPays ? <ArrowUpRight className="size-6" /> : <ArrowDownLeft className="size-6" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className={clsx('text-[12px] font-semibold uppercase tracking-wide', branchPays ? 'text-rose-700' : 'text-emerald-700')}>
          {branchPays ? t('Branch pays customer') : t('Customer pays branch')}
        </div>
        <div className="text-[13px] text-ink-700">
          {branchPays ? t('The piece weighs less than the entitlement.') : t('The piece weighs more than the entitlement.')}{' '}
          <span className="num" dir="ltr">
            {grams(s.absDifferenceMg)} × {money(s.ratePerGram)}/{t('g')}
          </span>
        </div>
      </div>
      <div className={clsx('text-end text-[26px] font-semibold tracking-tight num', branchPays ? 'text-rose-700' : 'text-emerald-700')}>{money(s.amount)}</div>
    </div>
  );
}

function SettlementPanel({ detail, onComplete, onRelease }: { detail: Detail; onComplete: () => void; onRelease: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const s = detail.settlement;
  const release = useMutation({
    mutationFn: (itemId: number) => del(`/hasad/withdrawals/${detail.withdrawal.id}/items/${itemId}`),
    onSuccess: () => {
      toast.info(t('Piece released'), t('It is AVAILABLE for sale again.'));
      onRelease();
    },
    onError: (e) => toast.fromError(e),
  });
  const max = Math.max(s.entitledWeightMg, s.deliveredWeightMg, 1);
  return (
    <Card padded={false}>
      <CardHeader
        title={t('Settlement')}
        subtitle={t('Session {number} · basis: {basis} · rate {rate} per gram', {
          number: detail.draft?.number ?? '',
          basis: s.basis === 'NET_WEIGHT' ? t('net gold weight') : t('pure-gold equivalent'),
          rate: money(s.ratePerGram),
        })}
      />
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label={t('Entitled weight')} value={grams(s.entitledWeightMg)} />
          <Metric label={t('Delivered weight')} value={detail.items.length ? grams(s.deliveredWeightMg) : '—'} />
          <Metric
            label={t('Difference')}
            value={detail.items.length ? signedGrams(s.differenceMg) : '—'}
            tone={!detail.items.length ? undefined : s.differenceMg < 0 ? 'rose' : s.differenceMg > 0 ? 'emerald' : undefined}
          />
        </div>
        {detail.items.length > 0 && (
          <div className="space-y-1.5" aria-hidden>
            <Bar label={t('Entitled')} value={s.entitledWeightMg} max={max} className="bg-ink-700" />
            <Bar label={t('Delivered')} value={s.deliveredWeightMg} max={max} className="bg-gold-500" />
          </div>
        )}
        {detail.items.length ? <DirectionBanner s={s} /> : <Alert tone="info">{t('Select a piece below. The settlement is calculated from its actual net weight.')}</Alert>}

        <div>
          <div className="mb-2 text-[13px] font-semibold text-ink-800">{t('Selected pieces')} · {t('reserved')}</div>
          {detail.items.length === 0 ? (
            <div className="rounded-md border border-dashed border-line-strong px-4 py-5 text-center text-[13px] text-ink-500">{t('No piece selected yet')}</div>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {detail.items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                  <ItemThumb category={i.categoryCode} karat={i.karat} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{L(i.productName, i.productNameAr)}</div>
                    <div className="font-mono text-[11.5px] text-ink-500">
                      {i.code} · {karatLabel(i.karat)} · {t('gross {weight}', { weight: grams(i.grossWeightMg) })} · {t('reserved {when}', { when: relative(i.reservedAt) })}
                    </div>
                  </div>
                  <div className="text-end">
                    <div className="font-semibold num">{grams(i.netWeightMg)}</div>
                    <div className="text-[11px] text-ink-500">{t('net')}</div>
                  </div>
                  <StatusBadge status={i.status} />
                  <Button size="sm" variant="ghost" onClick={() => release.mutate(i.id)} loading={release.isPending && release.variables === i.id}>
                    {t('Release')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="gold" size="lg" disabled={!detail.items.length} onClick={onComplete} icon={<CheckCircle2 className="size-5" />}>
            {t('Review settlement & complete')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'rose' | 'emerald' }) {
  return (
    <div className="rounded-md border border-line px-3.5 py-2.5">
      <div className="text-[12px] text-ink-500">{label}</div>
      <div className={clsx('mt-0.5 text-xl font-semibold num', tone === 'rose' && 'text-rose-700', tone === 'emerald' && 'text-emerald-700')}>{value}</div>
    </div>
  );
}

function Bar({ label, value, max, className }: { label: string; value: number; max: number; className: string }) {
  return (
    <div className="flex items-center gap-3 text-[12px]">
      <span className="w-16 text-ink-500">{label}</span>
      <div className="h-2.5 flex-1 rounded-full bg-canvas">
        <div className={clsx('h-full rounded-full', className)} style={{ width: `${(value / max) * 100}%` }} />
      </div>
      <span className="w-20 text-end font-medium num">{grams(value)}</span>
    </div>
  );
}

function CandidatePicker({ detail, onReserved }: { detail: Detail; onReserved: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [karat, setKarat] = useState<number | ''>('');
  const [category, setCategory] = useState('');
  const categories = useCategories();
  const rates = useGoldRates();
  const w = detail.withdrawal;
  const candidates = useQuery({
    queryKey: ['hasad', 'candidates', w.id, dq, karat, category],
    queryFn: () => get<ItemRow[]>(`/hasad/withdrawals/${w.id}/candidates`, { q: dq, karat, category }),
  });
  const reserve = useMutation({
    mutationFn: (itemId: number) => post(`/hasad/withdrawals/${w.id}/items`, { itemId }),
    onSuccess: (_d, itemId) => {
      const it = candidates.data?.find((c) => c.id === itemId);
      toast.success(t('{code} reserved for {name}', { code: it?.code ?? '', name: w.customerName }), t('Status AVAILABLE → RESERVED'));
      onReserved();
    },
    onError: (e) => {
      toast.fromError(e, t('Could not reserve'));
      candidates.refetch();
    },
  });

  // Preview of each piece on its own against the entitlement (no reservation happens here).
  // The server recalculates authoritatively once a piece is actually selected.
  const preview = useMemo(() => {
    return (c: ItemRow) =>
      calculateSettlement({
        entitledWeightMg: w.entitledWeightMg,
        entitlementKarat: w.entitlementKarat,
        items: [{ netWeightMg: c.netWeightMg, karat: c.karat }],
        ratePerGram: rates.data?.current[String(c.karat)]?.pricePerGram ?? 0,
        basis: detail.settlement.basis,
      });
  }, [detail.settlement.basis, rates.data, w.entitledWeightMg, w.entitlementKarat]);

  return (
    <Card padded={false}>
      <CardHeader
        title={t('Available pieces in this branch')}
        subtitle={
          detail.items.length
            ? t('Differences below compare each piece on its own with the entitlement. Selecting another piece adds it to the delivery.')
            : t('Sorted by closeness to the entitlement. Browsing does not reserve anything. Only selecting a piece does.')
        }
      />
      <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Scan or search…')} className="ps-8" />
        </div>
        <Select value={karat} onChange={(e) => setKarat(e.target.value ? Number(e.target.value) : '')} className="w-28">
          <option value="">{t('Karat')}</option>
          {[18, 21, 22, 24].map((k) => <option key={k} value={k}>{karatLabel(k)}</option>)}
        </Select>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-40">
          <option value="">{t('Category')}: {t('All')}</option>
          {categories.data?.map((c) => <option key={c.code} value={c.code}>{L(c.name, c.nameAr)}</option>)}
        </Select>
      </div>
      {candidates.isLoading ? (
        <Loading />
      ) : !candidates.data?.length ? (
        <Empty title={t('No available pieces match')} />
      ) : (
        <div className="grid gap-3 p-4 sm:grid-cols-2 2xl:grid-cols-3">
          {candidates.data.map((c) => {
            const p = preview(c);
            return (
              <div key={c.id} className="flex gap-3 rounded-lg border border-line p-3 hover:border-gold-400">
                <ItemThumb category={c.categoryCode} karat={c.karat} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{L(c.productName, c.productNameAr)}</div>
                  <div className="font-mono text-[11px] text-ink-500">{c.code} · {karatLabel(c.karat)}</div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-[15px] font-semibold num">{grams(c.netWeightMg)}</span>
                    <span className={clsx('text-[12px] font-medium num', p.differenceMg < 0 ? 'text-rose-700' : p.differenceMg > 0 ? 'text-emerald-700' : 'text-ink-500')}>
                      {signedGrams(p.differenceMg)}
                    </span>
                  </div>
                  <div className="text-[11.5px] text-ink-500">
                    {p.direction === 'NONE'
                      ? t('Exact match')
                      : p.direction === 'BRANCH_PAYS_CUSTOMER'
                        ? t('Branch pays ≈ {amount}', { amount: money(p.amount) })
                        : t('Customer pays ≈ {amount}', { amount: money(p.amount) })}
                  </div>
                </div>
                <Button size="sm" variant="primary" className="self-center" loading={reserve.isPending && reserve.variables === c.id} onClick={() => reserve.mutate(c.id)}>
                  {t('Select for customer')}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function CompleteDialog({ detail, onClose, onDone, onStale }: { detail: Detail; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const s = detail.settlement;
  const [ack, setAck] = useState(false);
  const [payment, setPayment] = useState<PaymentMethod>('CASH');
  const complete = useMutation({
    mutationFn: () =>
      post<{ redemptionNumber: string; settlementNumber: string | null }>(`/hasad/withdrawals/${detail.withdrawal.id}/complete`, {
        paymentMethod: payment,
        customerAcknowledged: ack,
        expectedDirection: s.direction,
        expectedAmount: s.amount,
      }),
    onSuccess: (r) => {
      toast.success(
        t('{id} completed', { id: detail.withdrawal.externalId }),
        r.settlementNumber
          ? t('Redemption {number} · settlement {settlement}. Pieces are now REDEEMED.', { number: r.redemptionNumber, settlement: r.settlementNumber })
          : t('Redemption {number}. Pieces are now REDEEMED.', { number: r.redemptionNumber }),
      );
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(t('Settlement changed'), errorText(e));
        onStale();
        onClose();
      } else toast.fromError(e, t('Completion failed'));
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Confirm settlement with the customer')}
      subtitle={`${detail.withdrawal.externalId} · ${detail.withdrawal.customerName}`}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>{t('Back')}</Button>
          <Button variant="gold" disabled={!ack} loading={complete.isPending} onClick={() => complete.mutate()} icon={<CheckCircle2 className="size-4" />}>
            {t('Complete withdrawal')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <table className="w-full text-[13px]">
          <tbody className="divide-y divide-line">
            {detail.items.map((i) => (
              <tr key={i.id}>
                <td className="py-2">{L(i.productName, i.productNameAr)} <Mono className="text-ink-500">{i.code}</Mono></td>
                <td className="py-2 text-end num">{grams(i.netWeightMg)}</td>
              </tr>
            ))}
            <tr><td className="py-2 text-ink-500">{t('Entitled weight')}</td><td className="py-2 text-end num">{grams(s.entitledWeightMg)}</td></tr>
            <tr><td className="py-2 text-ink-500">{t('Delivered weight')}</td><td className="py-2 text-end num">{grams(s.deliveredWeightMg)}</td></tr>
            <tr className="font-semibold"><td className="py-2">{t('Difference')}</td><td className="py-2 text-end num">{signedGrams(s.differenceMg)}</td></tr>
          </tbody>
        </table>
        <DirectionBanner s={s} />
        {s.direction !== 'NONE' && (
          <Field label={s.direction === 'BRANCH_PAYS_CUSTOMER' ? t('Paid to customer by') : t('Collected from customer by')}>
            <Select value={payment} onChange={(e) => setPayment(e.target.value as PaymentMethod)}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(m)}</option>)}
            </Select>
          </Field>
        )}
        <label className="flex items-start gap-2.5 rounded-md border border-gold-400 bg-gold-50 p-3 text-[13px]">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-ink-900" />
          <span>
            {s.direction === 'NONE'
              ? t('The customer has seen the weights and agrees to the settlement.')
              : s.direction === 'BRANCH_PAYS_CUSTOMER'
                ? t('The customer has seen the weights and agrees to the settlement of {amount} (paid to the customer).', { amount: money(s.amount) })
                : t('The customer has seen the weights and agrees to the settlement of {amount} (paid by the customer).', { amount: money(s.amount) })}
          </span>
        </label>
        <p className="flex items-center gap-1.5 text-[12px] text-ink-500">
          <ShieldAlert className="size-3.5" /> {t('Completing notifies Hasad Gold, marks the pieces REDEEMED and records the settlement. This cannot be undone at the counter.')}
        </p>
      </div>
    </Dialog>
  );
}

function CompletedPanel({ detail }: { detail: Detail }) {
  const { t, L, lang } = useI18n();
  const c = detail.completed!;
  const w = detail.withdrawal;
  return (
    <Card padded={false} className="print-area">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-600" /> {t('Withdrawal delivered')}
          </span>
        }
        subtitle={t('Redemption {number} · {when} · {cashier}', { number: c.number, when: dateTime(c.completedAt, lang), cashier: c.cashierName })}
        actions={<Button size="sm" icon={<Printer className="size-4" />} onClick={() => window.print()}>{t('Print')}</Button>}
      />
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label={t('Entitled weight')} value={grams(w.entitledWeightMg)} />
          <Metric label={t('Delivered weight')} value={grams(c.deliveredWeightMg)} />
          <Metric label={t('Difference')} value={signedGrams(c.differenceMg)} tone={c.differenceMg < 0 ? 'rose' : c.differenceMg > 0 ? 'emerald' : undefined} />
        </div>
        <DirectionBanner
          s={{
            entitledWeightMg: w.entitledWeightMg,
            deliveredWeightMg: c.deliveredWeightMg,
            differenceMg: c.differenceMg,
            absDifferenceMg: Math.abs(c.differenceMg),
            direction: c.settlementDirection as Settlement['direction'],
            ratePerGram: c.ratePerGram,
            amount: c.settlementAmount,
            basis: 'NET_WEIGHT',
            rateKarats: [],
          }}
        />
        <ul className="divide-y divide-line rounded-md border border-line">
          {c.items.map((i) => (
            <li key={i.id} className="flex items-center justify-between px-3 py-2.5 text-[13px]">
              <Link to={`/inventory/${i.id}`} className="hover:underline">
                {L(i.productName, i.productNameAr)} <Mono className="text-ink-500">{i.code}</Mono> · {karatLabel(i.karat)}
              </Link>
              <span className="flex items-center gap-3">
                <span className="num">{grams(i.netWeightMg)}</span>
                <StatusBadge status="REDEEMED" />
              </span>
            </li>
          ))}
        </ul>
        {c.settlement && (
          <div className="text-[12.5px] text-ink-500">
            {t('Settlement')} <Mono>{c.settlement.number}</Mono> · {t(c.settlement.paymentMethod)} · {money(c.settlement.amount)}
          </div>
        )}
      </div>
    </Card>
  );
}

function ReasonDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  defaultReason = '',
  danger,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  defaultReason?: string;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const toast = useToast();
  const { t } = useI18n();
  const [reason, setReason] = useState(defaultReason);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t('Back')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={reason.trim().length < 3}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason);
                onClose();
              } catch (e) {
                toast.fromError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-600">{body}</p>
      <Field label={t('Reason (recorded in the audit log)')}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}
