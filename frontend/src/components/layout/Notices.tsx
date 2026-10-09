// Shell notice area (UI-A2, D-ui-13): every security and system notice in one compact place between the top bar
// and the page, on every screen. One line per notice; at most two lines show, the others fold into "+ N more",
// which expands in place. Nothing can be dismissed while its cause remains: a notice leaves only when the person
// acts (It was me / This wasn't me) or the cause is fixed (a second passkey, a successful backup, a setting).
// Order (LOCK-1, D-lock-1): the security-locked accounts first (managers), then the new-sign-in alert (its "This
// wasn't me" can security-lock the account, D-2fa-13), both at the strongest level and never cut; then the other
// critical notices, then warnings, then information. Meaning colours as in R6.

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, DatabaseBackup, Lock, ShieldAlert, Smartphone } from 'lucide-react';
import { ApiError, errorText, get, post } from '../../lib/api';
import { markAccountLocked, useAuth } from '../../lib/auth';
import { dateTime, deviceText } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { Alert, Button, Dialog } from '../ui';

type Level = 'lock' | 'critical' | 'warning' | 'info';
export interface Notice {
  id: string;
  level: Level;
  icon: ReactNode;
  text: ReactNode;
  /** Plain text of the notice (tooltip and screen readers, when the line is cut). */
  plain: string;
  action?: ReactNode;
  testId: string;
}

/** Shown at once; the rest fold into "+ N more" (owner limit: two lines at 1366×768). */
export const VISIBLE_NOTICES = 2;
const ORDER: Record<Level, number> = { lock: 0, critical: 1, warning: 2, info: 3 };

interface BackupStatus {
  status: 'OK' | 'WARNING';
  backupAgeHours: number | null;
  verifyAgeHours: number | null;
  reasons: ('BACKUP_NEVER' | 'BACKUP_STALE' | 'VERIFY_NEVER' | 'VERIFY_STALE')[];
  maxAgeHours: number;
  maxVerifyAgeDays: number;
}

/** The notices that apply to the signed-in person right now (also used for the dot on the avatar). */
export function useNotices(onNotMe: () => void, onItWasMe: () => void): Notice[] {
  const { me, can } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  // Backups (GM, D-2c-6): ages and status only.
  const backup = useQuery({ queryKey: ['backup-status'], queryFn: () => get<BackupStatus>('/backups/status'), enabled: !!me && can('backups.view'), refetchInterval: 300_000 });
  if (!me) return [];
  const sf = me.secondFactor;
  const isGm = can('settings.manage');
  const out: Notice[] = [];

  // LOCK-1: accounts under a security lock. Only the operator console lifts it; the notice stays until then.
  if (me.lockedAccounts.length > 0) {
    const names = me.lockedAccounts.map((a) => `${(lang === 'ar' && a.fullNameAr) || a.fullName} (${a.username})`).join('، ');
    const plain =
      me.lockedAccounts.length === 1
        ? t('Account {names} is security-locked. Nobody can sign in to it until the system operator unlocks it on the server (operator console: unlock-security-lock).', { names })
        : t('Accounts {names} are security-locked. Nobody can sign in to them until the system operator unlocks them on the server (operator console: unlock-security-lock).', { names });
    out.push({
      id: 'security-locked',
      level: 'lock',
      icon: <Lock className="size-4" />,
      plain,
      text: <span data-testid="locked-accounts-text">{plain}</span>,
      action: can('users.view') ? (
        <button className="shrink-0 font-medium underline underline-offset-2" onClick={() => navigate('/users')}>
          {t('Users')}
        </button>
      ) : undefined,
      testId: 'security-locked-banner',
    });
  }

  const alert = sf.newDeviceAlert;
  if (alert) {
    const method = alert.method === 'PASSKEY' ? t('passkey “{nickname}”', { nickname: alert.credentialNickname ?? '—' }) : alert.method === 'RECOVERY_CODE' ? t('a recovery code') : t('the password only');
    const sentence = t('Signed in on {date} with {browser}, from about {ip}, using {method}. Was this you?', {
      date: dateTime(alert.at, lang),
      browser: alert.browser ? deviceText(alert.browser) : '—',
      ip: alert.ipApprox ?? '—',
      method,
    });
    out.push({
      id: 'new-sign-in',
      level: 'lock',
      icon: <ShieldAlert className="size-4" />,
      plain: `${t('New sign-in to your account')} · ${sentence}`,
      text: (
        <>
          <span className="font-semibold">{t('New sign-in to your account')}</span>
          {' · '}
          {sentence}
        </>
      ),
      action: (
        <span className="flex shrink-0 gap-2">
          <Button size="sm" onClick={onItWasMe} data-testid="it-was-me">{t('It was me')}</Button>
          <Button size="sm" variant="danger" onClick={onNotMe} data-testid="not-me">{t('This wasn’t me')}</Button>
        </span>
      ),
      testId: 'new-device-alert',
    });
  }
  if (isGm && me.appMode !== 'demo' && !sf.requiredRoles.includes('GENERAL_MANAGER')) {
    const plain = t('The second factor is OFF for the General Manager: a stolen password alone opens this account (Settings › Second factor).');
    out.push({ id: 'enforcement-off', level: 'critical', icon: <ShieldAlert className="size-4" />, plain, text: plain, testId: 'enforcement-off-banner' });
  }
  const b = backup.data;
  // Demo databases are disposable: no notice until a backup has ever been made there (D-2c-6).
  if (b && b.status !== 'OK' && !(me.appMode === 'demo' && b.reasons.every((r) => r.endsWith('_NEVER')))) {
    const lines = b.reasons.map((r) =>
      r === 'BACKUP_NEVER'
        ? t('No successful backup has been recorded.')
        : r === 'BACKUP_STALE'
          ? t('The last successful backup is {hours} hours old (limit: {max} hours).', { hours: Math.floor(b.backupAgeHours ?? 0), max: b.maxAgeHours })
          : r === 'VERIFY_NEVER'
            ? t('No restore drill has succeeded yet.')
            : t('The last successful restore drill is {days} days old (limit: {max} days).', { days: Math.floor((b.verifyAgeHours ?? 0) / 24), max: b.maxVerifyAgeDays }),
    );
    const plain = `${t('Backups need attention')}: ${lines.join(' ')}`;
    out.push({
      id: 'backup',
      level: 'warning',
      icon: <DatabaseBackup className="size-4" />,
      plain,
      text: (
        <>
          <span className="font-semibold">{t('Backups need attention')}</span> · {lines.join(' ')}
        </>
      ),
      testId: 'backup-banner',
    });
  }
  if (isGm && sf.userVerification === 'preferred') {
    const plain = t('Touch-only security keys are accepted: a passkey does not have to check a fingerprint, face or PIN (Settings › Second factor).');
    out.push({ id: 'uv-preferred', level: 'warning', icon: <ShieldAlert className="size-4" />, plain, text: plain, testId: 'uv-preferred-banner' });
  }
  if (sf.passkeys === 1 && sf.required) {
    const plain = t('You have only one passkey. Register a second device (your phone is ideal) so a lost or broken computer does not lock you out.');
    out.push({
      id: 'second-passkey',
      level: 'info',
      icon: <Smartphone className="size-4" />,
      plain,
      text: plain,
      action: (
        <button className="shrink-0 font-medium underline underline-offset-2" onClick={() => navigate('/security')}>
          {t('Add a device')}
        </button>
      ),
      testId: 'second-passkey-nag',
    });
  }
  return out.sort((a, z) => ORDER[a.level] - ORDER[z.level]);
}

const TONE: Record<Level, string> = {
  lock: 'border-crit bg-crit-bg text-crit ring-1 ring-crit/40',
  critical: 'border-crit/30 bg-crit-bg text-crit',
  warning: 'border-warn/30 bg-warn-bg text-warn',
  info: 'border-line bg-neutral-bg text-ink-2',
};

export function Notices() {
  const { me, refresh, logout } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [confirmNotMe, setConfirmNotMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alert = me?.secondFactor.newDeviceAlert;

  const itWasMe = async () => {
    if (!alert) return;
    await post(`/auth/sign-ins/${alert.id}/dismiss`).catch(() => undefined);
    await refresh();
  };
  const notMe = async () => {
    if (!alert) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ securityLocked?: boolean }>(`/auth/sign-ins/${alert.id}/not-me`);
      if (r?.securityLocked) markAccountLocked();
      await logout().catch(() => undefined);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t('Action failed'));
    } finally {
      setBusy(false);
    }
  };

  const notices = useNotices(() => setConfirmNotMe(true), itWasMe);
  const shown = expanded ? notices : notices.slice(0, VISIBLE_NOTICES);
  const hidden = notices.length - shown.length;

  return (
    <>
      {notices.length > 0 && (
        <section className="no-print grid gap-1.5 px-5 pt-3 lg:px-6" aria-label={t('Notices')} data-testid="notices">
          {shown.map((n) => (
            <div
              key={n.id}
              role={n.level === 'lock' || n.level === 'critical' ? 'alert' : 'status'}
              className={clsx('flex min-h-9 items-center gap-2.5 rounded-row border px-3 py-1.5 text-meta', TONE[n.level])}
              data-testid={n.testId}
              data-level={n.level}
            >
              <span className="shrink-0">{n.icon}</span>
              {/* The new-sign-in alert is never cut; the others keep to one line (full text on hover and for screen readers). */}
              <span className={clsx('min-w-0 flex-1 text-ink', n.level !== 'lock' && 'truncate')} title={n.level !== 'lock' ? n.plain : undefined}>
                {n.text}
              </span>
              {n.action}
            </div>
          ))}
          {(hidden > 0 || expanded) && notices.length > VISIBLE_NOTICES && (
            <button
              className="flex w-fit items-center gap-1 text-meta font-medium text-ink-2 hover:text-ink"
              aria-expanded={expanded}
              onClick={() => setExpanded((e) => !e)}
              data-testid="notices-more"
            >
              {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              {expanded ? t('Show fewer notices') : t('+ {n} more notices', { n: hidden })}
            </button>
          )}
        </section>
      )}
      <Dialog
        open={confirmNotMe}
        onClose={() => setConfirmNotMe(false)}
        title={t('Secure your account?')}
        footer={
          <>
            <Button onClick={() => setConfirmNotMe(false)}>{t('Cancel')}</Button>
            <Button variant="danger-solid" loading={busy} onClick={notMe} data-testid="not-me-confirm">{t('Yes, secure my account')}</Button>
          </>
        }
      >
        <div className="grid gap-2 text-[13px] text-ink-2">
          <p>{t('This signs out every session of your account (including this one), removes all your passkeys and makes you choose a new password.')}</p>
          {alert?.method === 'RECOVERY_CODE' ? (
            <Alert tone="danger" title={t('That sign-in used a recovery code: your account will be locked')}>
              <span data-testid="not-me-lock-warning">
                {t('Someone may have your recovery-code sheet. All remaining recovery codes stop working and the account is locked: nobody can sign in, not even you, until the system administrator restores it from the server and gives you a new one-time password. Then you choose a new password and register your passkeys and new recovery codes again.')}
              </span>
            </Alert>
          ) : (
            <p>{t('To get back in: sign in with your password and one of your recovery codes, set a new password, then register your passkeys again. If you also lost the recovery codes, ask the system operator to reset your second factor.')}</p>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </Dialog>
    </>
  );
}
