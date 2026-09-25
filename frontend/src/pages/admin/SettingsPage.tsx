import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import type { SystemSettings } from '@jerp/shared';
import { get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, humanize, money } from '../../lib/format';
import { useGoldRates } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Loading, PageHeader, Select } from '../../components/ui';

export function SettingsPage() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { logout } = useAuth();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => get<SystemSettings>('/settings') });
  const rates = useGoldRates();
  const [draft, setDraft] = useState<SystemSettings | null>(null);
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({});
  const [resetOpen, setResetOpen] = useState(false);
  useEffect(() => {
    if (s.data) setDraft(s.data);
  }, [s.data]);
  useEffect(() => {
    if (rates.data) setRateDraft(Object.fromEntries(Object.entries(rates.data.current).map(([k, v]) => [k, String(v.pricePerGram)])));
  }, [rates.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<SystemSettings>) => put<SystemSettings>('/settings', patch),
    onSuccess: () => {
      toast.success(t('Settings saved'), t('Recorded as SETTINGS_CHANGED in the audit log.'));
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  const saveRates = useMutation({
    mutationFn: () => post('/gold-rates', { rates: Object.fromEntries(Object.entries(rateDraft).map(([k, v]) => [k, Number(v)])) }),
    onSuccess: () => {
      toast.success(t('Gold rates updated'), t('New rates apply immediately to Hasad settlements.'));
      qc.invalidateQueries();
    },
    onError: (e) => toast.fromError(e),
  });
  const reset = useMutation({
    mutationFn: () => post('/demo/reset'),
    onSuccess: async () => {
      toast.success(t('Demo data rebuilt'), t('Please sign in again.'));
      await logout().catch(() => undefined);
      window.location.href = '/login';
    },
    onError: (e) => toast.fromError(e),
  });

  if (!draft) return <Loading />;
  const set = <K extends keyof SystemSettings>(k: K, v: Partial<SystemSettings[K]>) => setDraft({ ...draft, [k]: { ...draft[k], ...v } });

  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Settings')} subtitle={t('Business rules the client will confirm. Configurable here, not hard-coded.')} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card padded={false}>
          <CardHeader title={t('Gold rates (SDG per gram)')} subtitle={t('Used to value Hasad weight differences and shown to cashiers')} actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={saveRates.isPending} onClick={() => saveRates.mutate()}>{t('Save rates')}</Button>} />
          <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
            {['18', '21', '22', '24'].map((k) => (
              <Field key={k} label={`${k}K`}>
                <Input type="number" value={rateDraft[k] ?? ''} onChange={(e) => setRateDraft({ ...rateDraft, [k]: e.target.value })} className="num" />
              </Field>
            ))}
          </div>
          <div className="scroll-thin max-h-48 overflow-y-auto border-t border-line">
            <table className="w-full text-[12.5px]">
              <tbody className="divide-y divide-line">
                {rates.data?.history.slice(0, 16).map((h) => (
                  <tr key={h.id}>
                    <td className="px-5 py-1.5 text-ink-500">{dateTime(h.effectiveAt, lang)}</td>
                    <td className="px-3 py-1.5">{h.karat}K</td>
                    <td className="px-3 py-1.5 text-end num">{money(h.pricePerGram)}</td>
                    <td className="px-5 py-1.5 text-ink-500">{h.setBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title={t('Hasad Gold settlement')} actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate({ hasad: draft.hasad })}>{t('Save')}</Button>} />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label={t('Weight comparison basis')} hint={t('Spec default: compare net gold weight directly')}>
              <Select value={draft.hasad.settlementBasis} onChange={(e) => set('hasad', { settlementBasis: e.target.value as SystemSettings['hasad']['settlementBasis'] })}>
                <option value="NET_WEIGHT">{t('Net gold weight')}</option>
                <option value="PURE_GOLD_EQUIVALENT">{t('Pure-gold equivalent (karat-adjusted)')}</option>
              </Select>
            </Field>
            <Field label={t('Rate used to value the difference')}>
              <Select value={draft.hasad.rateSource} onChange={(e) => set('hasad', { rateSource: e.target.value as SystemSettings['hasad']['rateSource'] })}>
                <option value="ITEM_KARAT">{t('Karat of the selected piece(s)')}</option>
                <option value="ENTITLEMENT_KARAT">{t('Karat of the entitlement')}</option>
              </Select>
            </Field>
            <Field label={t('Entitlement karat')}>
              <Select value={draft.hasad.entitlementKarat} onChange={(e) => set('hasad', { entitlementKarat: Number(e.target.value) })}>
                {[18, 21, 22, 24].map((k) => <option key={k} value={k}>{k}K</option>)}
              </Select>
            </Field>
            <Field label={t('Auto-release reserved pieces after (minutes)')}>
              <Input type="number" min={5} value={draft.hasad.reservationTimeoutMinutes} onChange={(e) => set('hasad', { reservationTimeoutMinutes: Number(e.target.value) })} />
            </Field>
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title={t('Sales & expenses')} actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate({ sales: draft.sales, expenses: draft.expenses })}>{t('Save')}</Button>} />
          <div className="grid gap-3 p-5 sm:grid-cols-3">
            {Object.entries(draft.sales.maxDiscountPercentByRole).map(([role, v]) => (
              <Field key={role} label={t('Max discount · {role} (%)', { role: humanize(role) })}>
                <Input type="number" min={0} max={100} value={v} onChange={(e) => set('sales', { maxDiscountPercentByRole: { ...draft.sales.maxDiscountPercentByRole, [role]: Number(e.target.value) } })} />
              </Field>
            ))}
            <Field label={t('Expense approval threshold (SDG)')} className="sm:col-span-3" hint={t('Expenses above this amount created by branch managers need General Manager approval')}>
              <Input type="number" value={draft.expenses.approvalThreshold} onChange={(e) => set('expenses', { approvalThreshold: Number(e.target.value) })} />
            </Field>
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title={t('Security & sessions')} actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate({ security: draft.security })}>{t('Save')}</Button>} />
          <div className="grid gap-3 p-5 sm:grid-cols-3">
            <Field label={t('Idle after (minutes)')}>
              <Input type="number" value={draft.security.sessionIdleMinutes} onChange={(e) => set('security', { sessionIdleMinutes: Number(e.target.value) })} />
            </Field>
            <Field label={t('Expire after inactivity (hours)')}>
              <Input type="number" value={draft.security.sessionExpiryHours} onChange={(e) => set('security', { sessionExpiryHours: Number(e.target.value) })} />
            </Field>
            <Field label={t('Min. password length')}>
              <Input type="number" value={draft.security.minPasswordLength} onChange={(e) => set('security', { minPasswordLength: Number(e.target.value) })} />
            </Field>
            <label className="flex items-center gap-2 text-[13px] sm:col-span-3">
              <input type="checkbox" className="size-4 accent-ink-900" checked={draft.security.allowSelfPasswordChange} onChange={(e) => set('security', { allowSelfPasswordChange: e.target.checked })} />
              {t('Allow users to change their own password at any time (off = centralized control; users only set one after a reset)')}
            </label>
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title={t('Mock Hasad Gold service')} subtitle={t('Demo controls for the simulated integration')} actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate({ mockHasad: draft.mockHasad })}>{t('Save')}</Button>} />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label={t('Simulated latency (ms)')}>
              <Input type="number" value={draft.mockHasad.latencyMs} onChange={(e) => set('mockHasad', { latencyMs: Number(e.target.value) })} />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
              <input type="checkbox" className="size-4 accent-rose-600" checked={draft.mockHasad.simulateOutage} onChange={(e) => set('mockHasad', { simulateOutage: e.target.checked })} />
              {t('Simulate Hasad outage (shows error handling)')}
            </label>
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title={t('Demo data')} />
          <div className="p-5">
            <Alert tone="warning" className="mb-3">
              {t('Rebuilds the entire demo database relative to the current date and time: branches, users, 30 days of transactions, Hasad requests. All current data and sessions are discarded.')}
            </Alert>
            <Button variant="danger" icon={<RotateCcw className="size-4" />} onClick={() => setResetOpen(true)}>{t('Reset demo data')}</Button>
          </div>
        </Card>
      </div>
      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t('Reset all demo data?')}
        subtitle={t('Everyone will be signed out.')}
        footer={<><Button onClick={() => setResetOpen(false)}>{t('Cancel')}</Button><Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>{t('Reset now')}</Button></>}
      >
        <p className="text-[13px] text-ink-600">{t('This takes a few seconds.')}</p>
      </Dialog>
    </div>
  );
}
