// PRC-1 (D-prc1-9): the General Manager's Prices page. Three rates per gram for every allowed karat (the selling rate of
// new pieces, the selling rate of used pieces, the scrap buying rate), how selling prices are worked out (mode and
// rounding step), and the history of every change with who and when. Moved out of Settings: /settings#rates and
// /settings#scrap-rates lead here.
// DEC-1 (RAT-1, D-dec1-11): each changed rate shows its percentage change before saving; a change above the warn
// threshold asks for a reason, above the confirm threshold for the reason and the password (the server checks the same).

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { CHANGE_REASON_MAX, CHANGE_REASON_MIN, computedPrice, formatChangeBp, rateChangeBp, rateChangeLevel, strictestLevel, type PricingSettingMode, type RateChangeLevel, type SystemSettings } from '@jerp/shared';
import { ApiError, get, post, put } from '../../lib/api';
import { currencyLabel, dateTime, grams, karatLabel, money } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Button, Card, CardHeader, Dialog, ErrorState, Field, Input, IntegerInput, MoneyInput, PageHeader, Select, SkeletonRows, Textarea } from '../../components/ui';
import { openWindowWith } from '../../lib/reauth';

type Kind = 'NEW' | 'USED';
interface RateNow {
  pricePerGram: number;
  effectiveAt: string;
}
export interface SellingRatesView {
  current: Record<string, RateNow>;
  used: Record<string, RateNow>;
  history: { id: number; karat: number; kind: Kind; pricePerGram: number; effectiveAt: string; setBy: string | null }[];
  pricing: { mode: PricingSettingMode; roundingStep: number };
  allowedKarats: number[];
  guard: Guard;
}
interface Guard {
  warnChangePercent: number;
  confirmChangePercent: number;
}
interface GuardFields {
  reason?: string;
  confirmPassword?: string;
}
interface ScrapRatesView {
  rates: { karat: number; pricePerGram: number; effectiveAt: string }[];
  history: { id: number; karat: number; pricePerGram: number; effectiveAt: string; setBy: string | null }[];
}
interface SettingsResponse {
  settings: SystemSettings;
  versions: Record<string, number>;
}

/** The example piece of the "how prices are worked out" line: 1 g (test value, as in the owner's example). */
const EXAMPLE_MG = 1_000;
const EPOCH = new Date(0).toISOString();

export function PricesPage() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['gold-rates'], queryFn: () => get<SellingRatesView>('/gold-rates') });
  const scrap = useQuery({ queryKey: ['scrap-rates'], queryFn: () => get<ScrapRatesView>('/scrap-rates') });
  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Prices')} />
      {q.isError ? (
        <Card padded={false}><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>
      ) : !q.data ? (
        <Card padded={false}><SkeletonRows rows={6} className="p-5" /></Card>
      ) : (
        <>
          <PricingCard view={q.data} />
          <div className="grid gap-5 xl:grid-cols-3">
            <SellingRatesCard view={q.data} kind="NEW" />
            <SellingRatesCard view={q.data} kind="USED" />
            <ScrapRatesCard karats={q.data.allowedKarats} guard={q.data.guard} query={scrap} />
          </div>
          <HistoryCard view={q.data} scrap={scrap.data} />
        </>
      )}
    </div>
  );
}

/** How a selling price is worked out: the mode and the rounding step (settings `pricing.*`, General Manager). */
function PricingCard({ view }: { view: SellingRatesView }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsResponse>('/settings') });
  const [mode, setMode] = useState<PricingSettingMode>(view.pricing.mode);
  const [step, setStep] = useState(String(view.pricing.roundingStep));
  const [warn, setWarn] = useState(String(view.guard.warnChangePercent));
  const [confirm, setConfirm] = useState(String(view.guard.confirmChangePercent));
  useEffect(() => {
    setMode(view.pricing.mode);
    setStep(String(view.pricing.roundingStep));
    setWarn(String(view.guard.warnChangePercent));
    setConfirm(String(view.guard.confirmChangePercent));
  }, [view.pricing.mode, view.pricing.roundingStep, view.guard.warnChangePercent, view.guard.confirmChangePercent]);
  const stepN = Number(step);
  const stepOk = Number.isInteger(stepN) && stepN >= 1 && stepN <= 1_000_000;
  const [warnN, confirmN] = [Number(warn), Number(confirm)];
  // DEC-1: whole percentages, 0 < warn < confirm ≤ 100 (the server checks the same).
  const guardOk = Number.isInteger(warnN) && Number.isInteger(confirmN) && warnN >= 1 && warnN < confirmN && confirmN <= 100;
  const save = useMutation({
    mutationFn: () => {
      const changes: Record<string, unknown> = {};
      if (mode !== view.pricing.mode) changes['pricing.mode'] = mode;
      if (stepN !== view.pricing.roundingStep) changes['pricing.roundingStep'] = stepN;
      if (warnN !== view.guard.warnChangePercent) changes['rates.warnChangePercent'] = warnN;
      if (confirmN !== view.guard.confirmChangePercent) changes['rates.confirmChangePercent'] = confirmN;
      if (!Object.keys(changes).length) return Promise.resolve(null);
      const expectedVersions = Object.fromEntries(Object.keys(changes).map((k) => [k, s.data?.versions[k] ?? 0]));
      return put('/settings', { changes, expectedVersions });
    },
    onSuccess: (r) => {
      if (r) toast.success(t('Settings saved'));
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  const firstRate = Object.values(view.current).find((r) => r.pricePerGram > 0)?.pricePerGram ?? 0;
  return (
    <Card padded={false} className="mb-5">
      <CardHeader
        title={t('How selling prices are worked out')}
        actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} disabled={!stepOk || !guardOk || !s.data} loading={save.isPending} onClick={() => save.mutate()} data-testid="save-pricing">{t('Save')}</Button>}
      />
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label={t('Selling prices')}
          help={
            <span data-testid="pricing-example">
              {mode === 'RATE_COMPUTED'
                ? firstRate > 0 && stepOk
                  ? t('Example: a piece of {weight} at {rate} per gram sells for {price}. When the rate changes, the price changes with it; a sale keeps the price it was sold at.', { weight: grams(EXAMPLE_MG), rate: money(firstRate), price: money(computedPrice(EXAMPLE_MG, firstRate, stepN) ?? 0) })
                  : t('Price = net weight × the rate per gram of the piece’s karat (new or used piece). No making charge is added.')
                : t('Each piece sells at the price typed when it was received; the rates below do not change it.')}
            </span>
          }
        >
          <Select value={mode} onChange={(e) => setMode(e.target.value as PricingSettingMode)} data-testid="pricing-mode">
            <option value="RATE_COMPUTED">{t('From the rate per gram (weight × rate)')}</option>
            <option value="FIXED_TAG">{t('Fixed price typed for each piece')}</option>
          </Select>
        </Field>
        <Field label={t('Round prices to ({currency})', { currency: currencyLabel() })} help={t('Applied once, after weight × rate. 1 = whole units, no further rounding.')}>
          <IntegerInput min={1} max={1_000_000} value={step} onValueChange={setStep} disabled={mode !== 'RATE_COMPUTED'} data-testid="pricing-step" />
        </Field>
        <Field label={t('Ask for a reason above (%)')} help={t('A rate edit that moves a rate by more than this asks for a written reason.')}>
          <IntegerInput min={1} max={99} value={warn} onValueChange={setWarn} invalid={!guardOk} data-testid="rate-warn-pct" />
        </Field>
        <Field label={t('Ask for the password too above (%)')} help={t('Above this, the reason and your password again. Must be more than the first number, at most 100.')}>
          <IntegerInput min={2} max={100} value={confirm} onValueChange={setConfirm} invalid={!guardOk} data-testid="rate-confirm-pct" />
        </Field>
      </div>
    </Card>
  );
}

/** The selling rate per gram of new pieces (supplier and opening stock) or of used pieces (bought from customers). */
function SellingRatesCard({ view, kind }: { view: SellingRatesView; kind: Kind }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const current = kind === 'NEW' ? view.current : view.used;
  const initial = useMemo(() => Object.fromEntries(view.allowedKarats.map((k) => [k, current[k]?.pricePerGram ? String(current[k].pricePerGram) : ''])), [view.allowedKarats, current]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  useEffect(() => setDraft(initial), [initial]);
  const changed = Object.entries(draft).filter(([k, v]) => v.trim() && Number(v) > 0 && Number(v) !== (current[k]?.pricePerGram ?? 0));
  const prev = (k: number) => current[k]?.pricePerGram || null;
  const top = strictestLevel(changed.map(([k, v]) => rateChangeLevel(prev(Number(k)), Number(v), view.guard.warnChangePercent, view.guard.confirmChangePercent)));
  const [ask, setAsk] = useState<RateChangeLevel | null>(null);
  const m = useMutation({
    mutationFn: async (g: GuardFields) => {
      if (g.confirmPassword) await openWindowWith(g.confirmPassword); // UX-3: the guard's password opens the window too
      return post('/gold-rates', { [kind === 'NEW' ? 'rates' : 'usedRates']: Object.fromEntries(changed.map(([k, v]) => [k, Number(v)])), ...g });
    },
    onSuccess: () => {
      setAsk(null);
      toast.success(t('Gold rates updated'), t('New rates apply immediately.'));
      qc.invalidateQueries();
    },
    onError: (e) => guardError(e, setAsk, toast),
  });
  const tag = kind === 'NEW' ? 'gold-rate' : 'used-rate';
  return (
    <div data-testid={kind === 'NEW' ? 'rates-new' : 'rates-used'}>
      <Card padded={false}>
        <CardHeader
          title={kind === 'NEW' ? t('Selling rate · new pieces') : t('Selling rate · used pieces')}
          subtitle={kind === 'NEW' ? t('Pieces from suppliers and opening stock ({currency} per gram)', { currency: currencyLabel() }) : t('Pieces bought from customers and put on sale ({currency} per gram)', { currency: currencyLabel() })}
          actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} disabled={!changed.length} loading={m.isPending && !ask} onClick={() => (top === 'REASON' || top === 'CONFIRM' ? setAsk(top) : m.mutate({}))} data-testid={kind === 'NEW' ? 'save-gold-rates' : 'save-used-rates'}>{t('Save')}</Button>}
        />
        <RateRows
          karats={view.allowedKarats}
          draft={draft}
          onChange={(k, v) => setDraft({ ...draft, [k]: v })}
          since={(k) => (current[k]?.pricePerGram ? dateTime(current[k].effectiveAt, lang) : null)}
          prev={prev}
          guard={view.guard}
          testId={tag}
        />
      </Card>
      <RateGuardDialog level={ask} guard={view.guard} loading={m.isPending} onCancel={() => setAsk(null)} onConfirm={(g) => m.mutate(g)} />
    </div>
  );
}

/** What the branches pay customers for scrap, per gram (any karat can be bought as broken scrap). */
function ScrapRatesCard({ karats, guard, query }: { karats: number[]; guard: Guard; query: UseQueryResult<ScrapRatesView> }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');
  useEffect(() => {
    if (query.data) setDraft(Object.fromEntries(query.data.rates.map((r) => [String(r.karat), String(r.pricePerGram)])));
  }, [query.data]);
  // The allowed karats, plus any other karat that already has a scrap rate or is added here (1–24).
  const shown = [...new Set([...karats, ...Object.keys(draft).map(Number)])].sort((a, b) => a - b);
  const prev = (k: number) => query.data?.rates.find((r) => r.karat === k)?.pricePerGram ?? null;
  const filled = Object.entries(draft).filter(([, v]) => v.trim() && Number(v) > 0);
  const top = strictestLevel(filled.filter(([k, v]) => Number(v) !== prev(Number(k))).map(([k, v]) => rateChangeLevel(prev(Number(k)), Number(v), guard.warnChangePercent, guard.confirmChangePercent)));
  const [ask, setAsk] = useState<RateChangeLevel | null>(null);
  const m = useMutation({
    mutationFn: async (g: GuardFields) => {
      if (g.confirmPassword) await openWindowWith(g.confirmPassword); // UX-3: the guard's password opens the window too
      return post('/scrap-rates', { rates: filled.map(([k, v]) => ({ karat: Number(k), pricePerGram: Number(v) })), ...g });
    },
    onSuccess: () => {
      setAsk(null);
      toast.success(t('Scrap rates updated'));
      qc.invalidateQueries();
    },
    onError: (e) => guardError(e, setAsk, toast),
  });
  const extraN = Number(extra);
  return (
    <div data-testid="rates-scrap">
      <Card padded={false}>
        <CardHeader
          title={t('Scrap buying rate')}
          subtitle={t('What the branches pay customers for scrap gold ({currency} per gram)', { currency: currencyLabel() })}
          actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} disabled={!query.data} loading={m.isPending && !ask} onClick={() => (top === 'REASON' || top === 'CONFIRM' ? setAsk(top) : m.mutate({}))} data-testid="save-scrap-rates">{t('Save')}</Button>}
        />
        {query.isError && <ErrorState error={query.error} onRetry={() => query.refetch()} />}
        {!query.data && !query.isError && <SkeletonRows rows={3} className="p-5" />}
        {query.data && (
          <>
            <RateRows
              karats={shown}
              draft={draft}
              onChange={(k, v) => setDraft({ ...draft, [k]: v })}
              since={(k) => {
                const r = query.data!.rates.find((x) => x.karat === k);
                return r ? dateTime(r.effectiveAt, lang) : null;
              }}
              prev={prev}
              guard={guard}
              testId="scrap-rate"
            />
            <div className="flex items-end gap-2 border-t border-line px-5 py-3">
              <Field label={t('Add another karat (1–24)')}>
                <IntegerInput min={1} max={24} value={extra} onValueChange={setExtra} className="w-28" />
              </Field>
              <Button size="sm" disabled={!(Number.isInteger(extraN) && extraN >= 1 && extraN <= 24) || shown.includes(extraN)} onClick={() => { setDraft({ ...draft, [extraN]: '' }); setExtra(''); }}>
                {t('Add')}
              </Button>
            </div>
          </>
        )}
      </Card>
      <RateGuardDialog level={ask} guard={guard} loading={m.isPending} onCancel={() => setAsk(null)} onConfirm={(g) => m.mutate(g)} />
    </div>
  );
}

/** A server refusal of the edit guard opens the dialog (the page's own check normally does it first). */
function guardError(e: unknown, setAsk: (l: RateChangeLevel) => void, toast: ReturnType<typeof useToast>) {
  if (e instanceof ApiError && e.code === 'RATE_CHANGE_CONFIRM_REQUIRED') setAsk('CONFIRM');
  else if (e instanceof ApiError && e.code === 'RATE_CHANGE_REASON_REQUIRED') setAsk('REASON');
  else toast.fromError(e);
}

/** Asks for the reason (and, above the confirm threshold, the password) of a large rate change. */
function RateGuardDialog({ level, guard, loading, onCancel, onConfirm }: { level: RateChangeLevel | null; guard: Guard; loading: boolean; onCancel: () => void; onConfirm: (g: GuardFields) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (!level) {
      setReason('');
      setPassword('');
    }
  }, [level]);
  const needsPassword = level === 'CONFIRM';
  const ok = reason.trim().length >= CHANGE_REASON_MIN && (!needsPassword || password.length > 0);
  return (
    <Dialog
      open={level === 'REASON' || level === 'CONFIRM'}
      onClose={onCancel}
      size="sm"
      title={t('A large rate change')}
      subtitle={
        needsPassword
          ? t('This moves a rate by more than {pct}%: write the reason and enter your password again.', { pct: guard.confirmChangePercent })
          : t('This moves a rate by more than {pct}%: write the reason. It is kept in the audit log.', { pct: guard.warnChangePercent })
      }
      footer={
        <>
          <Button onClick={onCancel}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!ok} loading={loading} onClick={() => onConfirm({ reason: reason.trim(), ...(needsPassword ? { confirmPassword: password } : {}) })} data-testid="rate-guard-confirm">
            {t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="rate-guard">
        <Field label={t('Reason for the change')} hint={t('At least {n} characters.', { n: CHANGE_REASON_MIN })}>
          <Textarea rows={2} value={reason} maxLength={CHANGE_REASON_MAX} onChange={(e) => setReason(e.target.value)} data-testid="rate-guard-reason" />
        </Field>
        {needsPassword && (
          <Field label={t('Your password')}>
            <Input type="password" autoComplete="current-password" value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} data-testid="rate-guard-password" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function RateRows({ karats, draft, onChange, since, prev, guard, testId }: { karats: number[]; draft: Record<string, string>; onChange: (k: number, v: string) => void; since: (k: number) => string | null; prev: (k: number) => number | null; guard: Guard; testId: string }) {
  const { t } = useI18n();
  // DEC-1: the change against the current rate, before saving (exact basis points; the level decides the tone).
  const change = (k: number) => {
    const next = Number(draft[k]);
    const from = prev(k);
    if (!draft[k]?.trim() || !(next > 0) || from == null || next === from) return null;
    const level = rateChangeLevel(from, next, guard.warnChangePercent, guard.confirmChangePercent);
    return { bp: rateChangeBp(from, next)!, level };
  };
  return (
    <div className="divide-y divide-line">
      {karats.map((k) => {
        const when = since(k);
        return (
          <div key={k} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 px-5 py-2.5">
            <span className="text-[13.5px] font-semibold text-ink-1">{karatLabel(k)}</span>
            <div>
              <MoneyInput value={draft[k] ?? ''} onValueChange={(v) => onChange(k, v)} aria-label={karatLabel(k)} data-testid={`${testId}-${k}`} />
              <span className={'mt-0.5 block text-[11.5px] ' + (when ? 'text-ink-3' : 'font-medium text-rose-700')} data-testid={`${testId}-${k}-since`}>
                {when ? t('Since {when}', { when }) : t('No rate: pieces of this karat cannot be sold')}
              </span>
              {(() => {
                const c = change(k);
                if (!c) return null;
                const tone = c.level === 'CONFIRM' ? 'font-medium text-rose-700' : c.level === 'REASON' ? 'font-medium text-amber-700' : 'text-ink-3';
                return (
                  <span className={'block text-[11.5px] num ' + tone} data-testid={`${testId}-${k}-change`} data-level={c.level}>
                    {t('{change}% from the current rate', { change: formatChangeBp(c.bp) })}
                    {c.level === 'REASON' && ` · ${t('needs a reason')}`}
                    {c.level === 'CONFIRM' && ` · ${t('needs a reason and your password')}`}
                  </span>
                );
              })()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Every rate change, newest first: selling rates (new and used) and scrap buying rates, with who and when. */
function HistoryCard({ view, scrap }: { view: SellingRatesView; scrap: ScrapRatesView | undefined }) {
  const { t, lang } = useI18n();
  const rows = [
    ...view.history.map((h) => ({ key: `g${h.id}`, when: h.effectiveAt, karat: h.karat, what: h.kind === 'NEW' ? t('Selling rate · new pieces') : t('Selling rate · used pieces'), rate: h.pricePerGram, by: h.setBy })),
    ...(scrap?.history ?? []).map((h) => ({ key: `s${h.id}`, when: h.effectiveAt, karat: h.karat, what: t('Scrap buying rate'), rate: h.pricePerGram, by: h.setBy })),
  ]
    .sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0))
    .slice(0, 40);
  return (
    <div className="mt-5" data-testid="rates-history">
      <Card padded={false}>
        <CardHeader title={t('Rate history')} />
        {rows.length === 0 ? (
          <Alert tone="info" className="m-5">{t('No rate has been set yet.')}</Alert>
        ) : (
          <div className="scroll-thin max-h-96 overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-meta text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 text-start font-medium">{t('When')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('Rate')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('Karat')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Price per gram')}</th>
                  <th className="px-5 py-2 text-start font-medium">{t('Set by')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="px-5 py-1.5 text-ink-500">{r.when === EPOCH ? '—' : dateTime(r.when, lang)}</td>
                    <td className="px-3 py-1.5">{r.what}</td>
                    <td className="px-3 py-1.5">{karatLabel(r.karat)}</td>
                    <td className="px-3 py-1.5 text-end num">{money(r.rate)}</td>
                    <td className="px-5 py-1.5 text-ink-500">{r.by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
