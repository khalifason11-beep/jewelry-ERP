import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Printer, Save, Trash2 } from 'lucide-react';
import { PAYMENT_METHODS, parseDecimalInput, parseIntegerInput, settingValue, type InvoiceFormat, type SettingKey, type SystemSettings } from '@jerp/shared';
import { del, get, put, upload } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useBranding } from '../../lib/branding';
import { currencyLabel, humanize } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { printDocument } from '../../lib/print';
import { CalibrationPrint } from '../../print/documents';
import { errorText as apiErrorText } from '../../lib/api';
import { Alert, Button, Card, CardHeader, DecimalInput, ErrorState, Field, Input, IntegerInput, MoneyInput, PageHeader, Select, SkeletonRows, Textarea } from '../../components/ui';

interface SettingsResponse {
  settings: SystemSettings;
  versions: Record<string, number>;
}

/** Karats offered in the "allowed karats" setting. */
const KARAT_CHOICES = [9, 12, 14, 18, 21, 22, 24];

export function SettingsPage() {
  // PRC-1 (D-prc1-9): /settings#rates and /settings#scrap-rates (bookmarks, older attention links) open the Prices page.
  const { hash } = useLocation();
  if (hash === '#rates' || hash === '#scrap-rates') return <Navigate to="/prices" replace />;
  return <SettingsForm />;
}

function SettingsForm() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const branding = useBranding();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsResponse>('/settings') });
  const [draft, setDraft] = useState<SystemSettings | null>(null);
  const [reason, setReason] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.data) setDraft(s.data.settings);
  }, [s.data]);

  const refreshAll = () => qc.invalidateQueries();

  /** Save the given keys: only values that differ from the server copy are sent, with their versions. */
  const save = useMutation({
    mutationFn: (keys: SettingKey[]) => {
      const current = s.data!.settings;
      const changes: Record<string, unknown> = {};
      for (const k of keys) {
        const next = settingValue(draft!, k);
        if (JSON.stringify(next) !== JSON.stringify(settingValue(current, k))) changes[k] = next;
      }
      if (!Object.keys(changes).length) return Promise.resolve(null);
      const expectedVersions = Object.fromEntries(Object.keys(changes).map((k) => [k, s.data!.versions[k] ?? 0]));
      return put<SettingsResponse>('/settings', { changes, expectedVersions, ...(reason.trim() ? { reason: reason.trim() } : {}) });
    },
    onSuccess: (res) => {
      if (res) toast.success(t('Settings saved'));
      setReason('');
      refreshAll();
    },
    onError: (e) => toast.fromError(e),
  });
  const uploadLogo = useMutation({
    mutationFn: (file: File) => upload('/branding/logo', file),
    onSuccess: () => {
      toast.success(t('Logo updated'));
      refreshAll();
    },
    onError: (e) => toast.fromError(e),
    onSettled: () => {
      if (fileRef.current) fileRef.current.value = '';
    },
  });
  const removeLogo = useMutation({
    mutationFn: () => del('/branding/logo'),
    onSuccess: () => {
      toast.success(t('Logo removed'));
      refreshAll();
    },
    onError: (e) => toast.fromError(e),
  });

  // UI-A2: a failed load is an error with Try again, never a spinner that turns forever (audit bug).
  if (!draft)
    return (
      <div className="p-5 lg:p-6">
        <PageHeader title={t('Settings')} />
        <Card padded={false}>
          {s.isError ? <ErrorState error={s.error} onRetry={() => s.refetch()} /> : <SkeletonRows rows={8} className="p-5" />}
        </Card>
      </div>
    );
  const set = <K extends keyof SystemSettings>(k: K, v: Partial<SystemSettings[K]>) => setDraft({ ...draft, [k]: { ...draft[k], ...v } });
  const saveBtn = (keys: SettingKey[], testId?: string) => (
    <Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={save.isPending && JSON.stringify(save.variables) === JSON.stringify(keys)} onClick={() => save.mutate(keys)} data-testid={testId}>
      {t('Save')}
    </Button>
  );
  const numberInput = (value: number, onChange: (n: number) => void, props: SettingNumberProps = {}) => <SettingNumber value={value} onChange={onChange} {...props} />;
  const checkbox = (checked: boolean, onChange: (v: boolean) => void, label: string) => (
    <label className="flex items-center gap-2 text-[13px]">
      <input type="checkbox" className="size-4 accent-ink-900" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Settings')} />
      <Card className="mb-5">
        <Field label={t('Reason (optional)')}>
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Card>
      <div className="grid gap-5 xl:grid-cols-2">
        {/* ── Company & branding ── */}
        <Card padded={false}>
          <CardHeader
            title={t('Company & branding')}
            help={t('Shown on the login page, the header, the browser title and printed invoices')}
            actions={saveBtn(['company.nameEn', 'company.nameAr', 'company.currencyLabelEn', 'company.currencyLabelAr', 'branding.invoiceFooterEn', 'branding.invoiceFooterAr', 'branding.loginTaglineAr', 'branding.loginTaglineEn'], 'save-company')}
          />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label={t('Company name (English)')}>
              <Input value={draft.company.nameEn} maxLength={80} onChange={(e) => set('company', { nameEn: e.target.value })} />
            </Field>
            <Field label={t('Company name (Arabic)')}>
              <Input value={draft.company.nameAr} maxLength={80} onChange={(e) => set('company', { nameAr: e.target.value })} />
            </Field>
            <Field label={t('Currency label (English)')}>
              <Input value={draft.company.currencyLabelEn} maxLength={12} onChange={(e) => set('company', { currencyLabelEn: e.target.value })} />
            </Field>
            <Field label={t('Currency label (Arabic)')}>
              <Input value={draft.company.currencyLabelAr} maxLength={12} onChange={(e) => set('company', { currencyLabelAr: e.target.value })} />
            </Field>
            {/* UI-A2 (D-ui-14): one line under the company name on the sign-in page; public, so nothing private. */}
            <Field label={t('Sign-in tagline (Arabic)')} hint={t('One line, up to 120 characters.')}>
              <Input value={draft.branding.loginTaglineAr} maxLength={120} onChange={(e) => set('branding', { loginTaglineAr: e.target.value })} data-testid="tagline-ar" />
            </Field>
            <Field label={t('Sign-in tagline (English)')}>
              <Input value={draft.branding.loginTaglineEn} maxLength={120} onChange={(e) => set('branding', { loginTaglineEn: e.target.value })} data-testid="tagline-en" />
            </Field>
            <Field label={t('Invoice footer (English)')} className="sm:col-span-2">
              <Textarea rows={2} value={draft.branding.invoiceFooterEn} maxLength={300} onChange={(e) => set('branding', { invoiceFooterEn: e.target.value })} />
            </Field>
            <Field label={t('Invoice footer (Arabic)')} className="sm:col-span-2">
              <Textarea rows={2} value={draft.branding.invoiceFooterAr} maxLength={300} onChange={(e) => set('branding', { invoiceFooterAr: e.target.value })} />
            </Field>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <div className="grid size-16 place-items-center overflow-hidden rounded-lg border border-line bg-canvas">
                {branding.logoUrl ? <img src={branding.logoUrl} alt={t('Company logo')} className="max-h-full max-w-full object-contain" /> : <span className="text-[11px] text-ink-400">{t('No logo')}</span>}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadLogo.mutate(f);
                }}
              />
              <Button size="sm" icon={<ImageUp className="size-4" />} loading={uploadLogo.isPending} onClick={() => fileRef.current?.click()}>
                {t('Upload logo')}
              </Button>
              {branding.logoUrl && (
                <Button size="sm" variant="ghost" className="text-rose-700" icon={<Trash2 className="size-4" />} loading={removeLogo.isPending} onClick={() => removeLogo.mutate()}>
                  {t('Remove logo')}
                </Button>
              )}
              <p className="w-full text-[12px] text-ink-500">{t('PNG, JPEG or WebP · at most 512 KB and 1024×1024 pixels')}</p>
            </div>
          </div>
        </Card>

        {/* PRC-1 (D-prc1-9): the gold and scrap rates moved to the Prices page (/prices); the old anchors lead there. */}

        {/* ── Business rules (client to confirm) ── */}
        <Card padded={false}>
          <CardHeader
            title={t('Business rules')}
            subtitle={t('Purchases, scrap and transfers')}
            actions={saveBtn(['purchases.supplierCreditEnabled', 'purchases.scrapPriceTolerancePct', 'purchases.requireGmApprovalForScrapOverride', 'transfers.pendingClaimStaleHours', 'inventory.allowedKarats', 'cash.countDifferenceTolerance', 'purchases.supplierDebtMaxAgeDays'], 'save-business-rules')}
          />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <div className="sm:col-span-2">{checkbox(draft.purchases.supplierCreditEnabled, (v) => set('purchases', { supplierCreditEnabled: v }), t('Allow supplier purchases on credit (creates a supplier payable)'))}</div>
            <Field label={t('Scrap price tolerance (%)')} help={t('How far a branch manager may deviate from today’s scrap rate')}>
              {numberInput(draft.purchases.scrapPriceTolerancePct, (n) => set('purchases', { scrapPriceTolerancePct: n }), { min: 0, max: 50, decimals: 2, unit: '%' })}
            </Field>
            <div className="self-end pb-2">{checkbox(draft.purchases.requireGmApprovalForScrapOverride, (v) => set('purchases', { requireGmApprovalForScrapOverride: v }), t('Deviations beyond the tolerance need General Manager approval'))}</div>
            <Field label={t('Flag pending transfers/claims after (hours)')}>
              {numberInput(draft.transfers.pendingClaimStaleHours, (n) => set('transfers', { pendingClaimStaleHours: n }), { min: 1, max: 720 })}
            </Field>
            {/* UI-B (D-ux-12): thresholds of the attention list. */}
            <Field label={t('Cash count: accepted difference ({currency})', { currency: currencyLabel() })} help={t('A count that differs from the expected cash by more than this appears under Needs attention. 0 = any difference.')}>
              <span data-testid="count-tolerance" className="block">{numberInput(draft.cash.countDifferenceTolerance, (n) => set('cash', { countDifferenceTolerance: n }), { min: 0, money: true })}</span>
            </Field>
            <Field label={t('Gold owed to a supplier: warn after (days)')} help={t('Older supplier gold debts appear as a warning under Needs attention.')}>
              <span data-testid="supplier-debt-days" className="block">{numberInput(draft.purchases.supplierDebtMaxAgeDays, (n) => set('purchases', { supplierDebtMaxAgeDays: n }), { min: 1, max: 3650 })}</span>
            </Field>
            <Field label={t('Allowed karats')} className="sm:col-span-2">
              <div className="flex flex-wrap gap-3">
                {KARAT_CHOICES.map((k) => (
                  <label key={k} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      className="size-4 accent-ink-900"
                      checked={draft.inventory.allowedKarats.includes(k)}
                      onChange={(e) =>
                        set('inventory', {
                          allowedKarats: e.target.checked ? [...draft.inventory.allowedKarats, k].sort((a, b) => a - b) : draft.inventory.allowedKarats.filter((x) => x !== k),
                        })
                      }
                    />
                    {k}K
                  </label>
                ))}
              </div>
            </Field>
          </div>
        </Card>


        {/* ── Sales ── */}
        <Card padded={false}>
          <CardHeader title={t('Sales')} actions={saveBtn(['sales.maxDiscountPercentByRole', 'sales.posPaymentMethods', 'sales.voidReauthAboveAmount'], 'save-sales')} />
          <div className="grid gap-3 p-5 sm:grid-cols-3">
            <Field label={t('Payment methods at the counter')} className="sm:col-span-3" help={t('What the cashier can choose at the POS. Hasad asks for the Hasad invoice number.')}>
              <div className="flex flex-wrap gap-4 pt-1">
                {PAYMENT_METHODS.map((m) =>
                  checkbox(
                    draft.sales.posPaymentMethods.includes(m),
                    (on) => set('sales', { posPaymentMethods: on ? PAYMENT_METHODS.filter((x) => x === m || draft.sales.posPaymentMethods.includes(x)) : draft.sales.posPaymentMethods.filter((x) => x !== m) }),
                    t(m),
                  ),
                )}
              </div>
            </Field>
            {Object.entries(draft.sales.maxDiscountPercentByRole).map(([role, v]) => (
              <Field key={role} label={t('Max discount · {role} (%)', { role: humanize(role) })}>
                <span data-testid={`max-discount-${role}`} className="block">
                  {numberInput(v, (n) => set('sales', { maxDiscountPercentByRole: { ...draft.sales.maxDiscountPercentByRole, [role]: n } }), { min: 0, max: 100, unit: '%' })}
                </span>
              </Field>
            ))}
            {/* SEC-2 (D-sec2-1): General Manager only, like every setting; saving it needs the password. */}
            <Field label={t('Ask for the password to cancel a sale above ({currency})', { currency: currencyLabel() })} hint={t('0 = every cancellation asks for the password again.')} className="sm:col-span-3">
              <span data-testid="void-reauth-amount" className="block max-w-xs">
                {numberInput(draft.sales.voidReauthAboveAmount, (n) => set('sales', { voidReauthAboveAmount: n }), { min: 0, money: true })}
              </span>
            </Field>
          </div>
        </Card>

        {/* ── Backups (Phase 2c) ── (anchor: the attention list's backup line links here, UI-B) */}
        <span id="backups" className="-mb-5 block scroll-mt-4" />
        <Card padded={false}>
          <CardHeader title={t('Backups')} help={t('The dashboard warns the General Manager when backups or restore drills are older than this.')} actions={saveBtn(['backup.maxAgeHours', 'backup.maxVerifyAgeDays'])} />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label={t('Warn after a backup is older than (hours)')}>
              {numberInput(draft.backup.maxAgeHours, (n) => set('backup', { maxAgeHours: n }), { min: 1, max: 336 })}
            </Field>
            <Field label={t('Warn after a restore drill is older than (days)')}>
              {numberInput(draft.backup.maxVerifyAgeDays, (n) => set('backup', { maxVerifyAgeDays: n }), { min: 1, max: 90 })}
            </Field>
          </div>
        </Card>

        {/* ── Security & sessions ── */}
        <Card padded={false}>
          <CardHeader
            title={t('Security & sessions')}
            actions={saveBtn(['security.idleMinutes', 'security.sessionAbsoluteHours', 'security.reauthWindowMinutes', 'security.sessionIdleMinutes', 'security.minPasswordLength', 'security.lockoutThreshold', 'security.lockoutBaseMinutes', 'security.lockoutMaxMinutes', 'security.allowSelfPasswordChange'])}
          />
          <div className="grid gap-3 p-5 sm:grid-cols-3">
            <Field label={t('Sign out after inactivity (minutes, all roles)')}>
              {numberInput(draft.security.idleMinutes, (n) => set('security', { idleMinutes: n }), { min: 5, max: 240 })}
            </Field>
            <Field label={t('Maximum session length (hours)')}>
              {numberInput(draft.security.sessionAbsoluteHours, (n) => set('security', { sessionAbsoluteHours: n }), { min: 1, max: 24 })}
            </Field>
            <Field label={t('Password re-confirmation valid for (minutes)')} hint={t('One confirmation covers every protected action for this many minutes (1–30, default 15).')}>
              {numberInput(draft.security.reauthWindowMinutes, (n) => set('security', { reauthWindowMinutes: n }), { min: 1, max: 30 })}
            </Field>
            <Field label={t('Shown as idle after (minutes)')}>
              {numberInput(draft.security.sessionIdleMinutes, (n) => set('security', { sessionIdleMinutes: n }), { min: 1 })}
            </Field>
            <Field label={t('Min. password length')}>
              {numberInput(draft.security.minPasswordLength, (n) => set('security', { minPasswordLength: n }), { min: 10 })}
            </Field>
            <Field label={t('Lock account after failed attempts')}>
              {numberInput(draft.security.lockoutThreshold, (n) => set('security', { lockoutThreshold: n }), { min: 3, max: 20 })}
            </Field>
            <Field label={t('First lock (minutes)')}>
              {numberInput(draft.security.lockoutBaseMinutes, (n) => set('security', { lockoutBaseMinutes: n }), { min: 1 })}
            </Field>
            <Field label={t('Longest lock (minutes)')}>
              {numberInput(draft.security.lockoutMaxMinutes, (n) => set('security', { lockoutMaxMinutes: n }), { min: 1 })}
            </Field>
            <div className="sm:col-span-3">
              {checkbox(draft.security.allowSelfPasswordChange, (v) => set('security', { allowSelfPasswordChange: v }), t('Allow users to change their own password at any time (off = centralized control; users only set one after a reset)'))}
            </div>
          </div>
        </Card>

        {/* ── Printing (D-print-*) ── */}
        <Card padded={false}>
          <CardHeader
            title={t('Printing')}
            help={t('Invoices are printed by the browser through the Windows printer driver (no special printer commands).')}
            actions={
              <>
                <Button
                  size="sm"
                  icon={<Printer className="size-4" />}
                  data-testid="test-print"
                  onClick={() => {
                    const layout = { format: draft.print.invoiceFormat, receiptWidthMm: draft.print.receiptWidthMm };
                    void printDocument({ layout, content: <CalibrationPrint layout={layout} /> });
                  }}
                >
                  {t('Test print')}
                </Button>
                {saveBtn(['print.invoiceFormat', 'print.receiptWidthMm', 'print.autoPrintAfterSale'])}
              </>
            }
          />
          <div className="grid gap-4 p-5 lg:grid-cols-2">
            <div className="grid content-start gap-3">
              <Field label={t('Invoice paper')}>
                <Select value={draft.print.invoiceFormat} onChange={(e) => set('print', { invoiceFormat: e.target.value as InvoiceFormat })} data-testid="print-format">
                  <option value="A4">{t('A4 (office printer)')}</option>
                  <option value="A5">{t('A5 (half page)')}</option>
                  <option value="RECEIPT">{t('Receipt (thermal roll)')}</option>
                </Select>
              </Field>
              <Field
                label={t('Receipt printable width (mm)')}
                help={t('The PRINTABLE width from the printer driver, not the roll width: usually 72 for an 80 mm roll and 48 for a 58 mm roll (48–80).')}
              >
                {numberInput(draft.print.receiptWidthMm, (n) => set('print', { receiptWidthMm: n }), { min: 48, max: 80 })}
              </Field>
              {checkbox(draft.print.autoPrintAfterSale, (v) => set('print', { autoPrintAfterSale: v }), t('Open printing by itself after every completed sale'))}
            </div>
            <details className="rounded-lg border border-line bg-canvas/60 p-4 text-[13px] leading-relaxed text-ink-700" data-testid="printer-steps">
              <summary className="cursor-pointer select-none font-semibold text-ink-900">{t('Setting up the printer on the shop PC')}</summary>
              <ol className="mt-1.5 list-decimal space-y-1 ps-5">
                <li>{t('In Windows, make the receipt (or invoice) printer the DEFAULT printer.')}</li>
                <li>{t('In the printer driver’s preferences, check the paper size: for an 80 mm roll the printable width is usually 72 mm. Enter that number above.')}</li>
                <li>{t('Press “Test print”: the ruler must reach both edges of the paper and nothing may be cut off. Adjust the width until it does.')}</li>
                <li>{t('For printing without the print window, open the system with the desktop shortcut prepared by the administrator (silent printing). Then there is no confirmation: check the paper, and use Reprint if something did not come out.')}</li>
              </ol>
            </details>
          </div>
        </Card>

        <span id="second-factor" className="-mb-5 block scroll-mt-4" />
        <SecondFactorCard />
      </div>
    </div>
  );
}

/**
 * Second factor rules (D-2fa-2, D-2fa-3): guarded settings, changed only here, with the password AND
 * a fresh passkey. Switching user verification back to "required" needs a passkey that verified you.
 */
function SecondFactorCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { me, refresh } = useAuth();
  const sf = me?.secondFactor;
  const [uv, setUv] = useState<'required' | 'preferred'>(sf?.userVerification ?? 'required');
  const [roles, setRoles] = useState<string[]>(sf?.requiredRoles ?? []);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (sf) {
      setUv(sf.userVerification);
      setRoles(sf.requiredRoles);
    }
  }, [sf?.userVerification, sf?.requiredRoles.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!sf) return null;
  const dirty = uv !== sf.userVerification || roles.slice().sort().join(',') !== sf.requiredRoles.slice().sort().join(',');
  const toggle = (r: string, on: boolean) => setRoles((cur) => (on ? [...new Set([...cur, r])] : cur.filter((x) => x !== r)));

  const saveRules = async () => {
    setBusy(true);
    setError(null);
    try {
      await put('/security/second-factor', {
        ...(uv !== sf.userVerification ? { userVerification: uv } : {}),
        ...(roles.slice().sort().join(',') !== sf.requiredRoles.slice().sort().join(',') ? { requiredRoles: roles } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success(t('Second-factor rules saved'));
      setReason('');
      await refresh();
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const option = (value: 'required' | 'preferred', title: string, body: string) => (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${uv === value ? 'border-gold-500 bg-gold-50/50' : 'border-line'}`}>
      <input type="radio" name="uv" className="mt-1 accent-gold-600" checked={uv === value} onChange={() => setUv(value)} data-testid={`uv-${value}`} />
      <span>
        <span className="block text-[13.5px] font-medium">{title}</span>
        <span className="block text-[12.5px] leading-relaxed text-ink-500">{body}</span>
      </span>
    </label>
  );

  return (
    <Card padded={false}>
      <CardHeader
        title={t('Second factor (passkeys)')}
        subtitle={t('Changes need your password and your passkey, and are recorded in the audit log.')}
        actions={
          <Button size="sm" variant="primary" icon={<Save className="size-4" />} disabled={!dirty} loading={busy} onClick={saveRules} data-testid="save-second-factor">
            {t('Save')}
          </Button>
        }
      />
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <div className="grid gap-2">
          <div className="text-[13px] font-semibold">{t('What a passkey must check')}</div>
          {option('required', t('Fingerprint, face or PIN (recommended)'), t('The device must check who you are: Windows Hello, a phone, or a security key with a PIN. Someone who picks up the key cannot use it alone.'))}
          {option('preferred', t('A touch is enough'), t('Also accepts simple USB keys that only need a touch. Anyone holding the key plus the password can sign in. Accepted risk: do not leave the key plugged in, buy two keys, and review this when branches are added.'))}
        </div>
        <div className="grid content-start gap-2">
          <div className="text-[13px] font-semibold">{t('Who must use a passkey')}</div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 accent-gold-600" checked={roles.includes('GENERAL_MANAGER')} onChange={(e) => toggle('GENERAL_MANAGER', e.target.checked)} data-testid="role-GENERAL_MANAGER" />
            {t('General Manager')}
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 accent-gold-600" checked={roles.includes('BRANCH_MANAGER')} onChange={(e) => toggle('BRANCH_MANAGER', e.target.checked)} data-testid="role-BRANCH_MANAGER" />
            {t('Branch Manager')}
          </label>
          <div className="text-[12px] text-ink-500">{t('Cashiers never need one. A role added here must register a passkey at its next sign-in.')}</div>
          {!roles.includes('GENERAL_MANAGER') && <Alert tone="danger">{t('Without a passkey for the General Manager, a stolen password alone opens the most powerful account.')}</Alert>}
          <Field label={t('Reason (optional)')}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </div>
        {error && <div className="lg:col-span-2"><Alert tone="danger">{error}</Alert></div>}
      </div>
    </Card>
  );
}

interface SettingNumberProps {
  min?: number;
  max?: number;
  /** Decimals allowed (only the scrap tolerance %); whole numbers otherwise. */
  decimals?: number;
  /** An amount in the currency (shown with the currency label). */
  money?: boolean;
  unit?: string;
}

/**
 * UX-1: a numeric setting typed in a kit number field. The text is kept as typed; the draft receives the number, or
 * NaN while the field is empty or incomplete, which the server refuses with the setting's name (never a silent 0).
 */
function SettingNumber({ value, onChange, min, max, decimals = 0, money: isMoney, unit }: SettingNumberProps & { value: number; onChange: (n: number) => void }) {
  const parse = (s: string) => (decimals ? parseDecimalInput(s, decimals) : parseIntegerInput(s));
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '');
  useEffect(() => {
    if (Number.isFinite(value) && parse(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const change = (s: string) => {
    setText(s);
    onChange(parse(s) ?? NaN);
  };
  if (isMoney) return <MoneyInput value={text} onValueChange={change} min={min} max={max} />;
  if (decimals) return <DecimalInput value={text} onValueChange={change} min={min} max={max} decimals={decimals} unit={unit} />;
  return <IntegerInput value={text} onValueChange={change} min={min} max={max} unit={unit} />;
}
