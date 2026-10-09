// Sign-in security (Phase 2fa): passkeys, recovery codes, recent sign-ins. Also the first-time setup
// screen that a required role (the General Manager by default) must complete before anything else.

import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Fingerprint, KeyRound, Laptop, LogOut, Plus, Printer, ShieldAlert, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { ApiError, del, errorText, get, post } from '../lib/api';
import { homePath, useAuth, type Me } from '../lib/auth';
import { dateTime, deviceText } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { createPasskey, hasBuiltInAuthenticator, PasskeyError, passkeyUnavailable, PROBLEM_TEXT, type PublicKeyCredentialCreationOptionsJSON } from '../lib/webauthn';
import { Alert, Badge, Button, Card, CardHeader, Dialog, ErrorState, Field, Input, Mono, PageHeader, SkeletonRows } from '../components/ui';
import { AuthFrame } from '../components/layout/AuthFrame';
import { printDocument } from '../lib/print';
import { RecoveryCodesPrint } from '../print/documents';

interface Passkey {
  id: number;
  nickname: string;
  createdAt: string;
  lastUsedAt: string | null;
  uvAtRegistration: boolean;
  backedUp: boolean;
  deviceType: string;
}

interface SignIn {
  id: number;
  at: string;
  method: 'PASSWORD' | 'PASSKEY' | 'RECOVERY_CODE';
  credentialNickname: string | null;
  browser: string | null;
  ipApprox: string | null;
  uv: boolean | null;
  newDevice: boolean;
}

const failText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof PasskeyError ? errorText(e) : fallback);

/** Plain-language result of the "user verification" flag. */
export function UvLabel({ uv }: { uv: boolean | null }) {
  const { t } = useI18n();
  if (uv === null) return <span className="text-ink-400">—</span>;
  return uv ? (
    <Badge tone="ok">{t('Verified you (fingerprint, face or PIN)')}</Badge>
  ) : (
    <Badge tone="warn">{t('Touch only (did not check who you are)')}</Badge>
  );
}

/** Register a passkey on this device (or the phone, through the browser's QR code). */
async function registerPasskey(nickname: string) {
  const { options } = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>('/auth/passkeys/register/options', { nickname });
  const response = await createPasskey(options);
  return post<{ id: number; nickname: string; uvAtRegistration: boolean }>('/auth/passkeys/register/verify', { response });
}

function NoPasskeyHere() {
  const { t } = useI18n();
  const problem = passkeyUnavailable();
  const [builtIn, setBuiltIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!problem) hasBuiltInAuthenticator().then(setBuiltIn);
  }, [problem]);
  if (problem) return <Alert tone="danger">{t(PROBLEM_TEXT[problem])}</Alert>;
  if (builtIn === false)
    return (
      <Alert tone="info">
        {t('This computer has no Windows Hello (fingerprint, face or PIN) set up. You can still use a USB security key, or your phone: the browser will offer these when you continue.')}
      </Alert>
    );
  return null;
}

function WhatToExpect() {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-line bg-canvas/60 p-4 text-[13px] leading-relaxed text-ink-700">
      <div className="mb-1.5 font-semibold text-ink-900">{t('What to expect')}</div>
      <ol className="list-decimal space-y-1 ps-5">
        <li>{t('A Windows Hello window opens (or the security-key window of your browser).')}</li>
        <li>{t('Touch the fingerprint reader, look at the camera, or type the Windows Hello PIN of this computer. It is not your system password.')}</li>
        <li>{t('That is all: next time you sign in, you type your password and confirm the same way.')}</li>
      </ol>
      <div className="mt-2 text-ink-500">{t('Your fingerprint or face never leaves this computer. The system only stores a public key.')}</div>
    </div>
  );
}

// ───────────────────────── first-time setup ─────────────────────────

/** Shown full-screen while `me.secondFactor.enrollmentRequired`: register one passkey, then save the recovery codes. */
export function EnrollPage() {
  const { me, refresh, logout } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!me.secondFactor.enrollmentRequired) return <Navigate to={homePath(me)} replace />;
  const step = me.secondFactor.passkeys === 0 ? 'device' : 'codes';

  const register = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(nickname);
      await refresh();
    } catch (err) {
      setError(failText(err, t('Action failed')));
    } finally {
      setBusy(false);
    }
  };
  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      setCodes((await post<{ codes: string[] }>('/auth/recovery-codes')).codes);
    } catch (err) {
      setError(failText(err, t('Action failed')));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    await post('/auth/recovery-codes/acknowledge');
    const res = (await refresh()) as { data?: Me };
    navigate(homePath(res.data ?? me), { replace: true });
  };

  return (
    <AuthFrame width="lg">
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-full bg-gold-100 text-gold-700">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">{t('Protect your account with a passkey')}</h1>
            <p className="text-[13px] text-ink-500">
              {t('Step {n} of 2', { n: step === 'device' ? 1 : 2 })} · {step === 'device' ? t('Register this computer') : t('Save your recovery codes')}
            </p>
          </div>
        </div>
        {step === 'device' ? (
          <form onSubmit={register} className="grid gap-4" data-testid="enroll-device">
            <p className="text-[13px] leading-relaxed text-ink-600">
              {t('Your account can approve money, gold and user changes, so a password alone is not enough. From now on you will sign in with your password AND a passkey: this computer’s fingerprint, face or PIN (Windows Hello), a USB security key, or your phone.')}
            </p>
            <NoPasskeyHere />
            <WhatToExpect />
            <Field label={t('Name this device')} hint={t('So you can recognise it later, e.g. “Shop PC – office” or “My phone”.')}>
              <Input autoFocus value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={60} required data-testid="passkey-nickname" />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex items-center justify-between gap-2">
              <Button type="button" icon={<LogOut className="size-4" />} onClick={async () => { await logout(); navigate('/login'); }}>
                {t('Sign out')}
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!nickname.trim()} icon={<Fingerprint className="size-4" />} data-testid="register-passkey">
                {t('Register this device')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-4" data-testid="enroll-codes">
            <Alert tone="success">{t('Passkey registered. One last step.')}</Alert>
            <p className="text-[13px] leading-relaxed text-ink-600">
              {t('If this device is lost or broken, a recovery code lets you sign in once. Print them or write them down and keep them somewhere safe, away from the computer. They are shown only once.')}
            </p>
            {codes ? (
              <RecoveryCodesSheet codes={codes} onDone={finish} />
            ) : (
              <>
                {error && <Alert tone="danger">{error}</Alert>}
                <Button variant="primary" loading={busy} onClick={generate} icon={<KeyRound className="size-4" />} data-testid="generate-codes">
                  {t('Show my recovery codes')}
                </Button>
              </>
            )}
          </div>
        )}
      </Card>
    </AuthFrame>
  );
}

/** The 10 codes, shown once, with copy/print and an explicit "I saved them". */
function RecoveryCodesSheet({ codes, onDone }: { codes: string[]; onDone: () => Promise<void> | void }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-dashed border-gold-500/60 bg-gold-50/60 p-4" dir="ltr" data-testid="recovery-codes">
        {codes.map((c) => (
          <Mono key={c} className="text-center text-[15px] tracking-wider">{c}</Mono>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          onClick={async () => {
            await navigator.clipboard?.writeText(codes.join('\n')).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? t('Copied') : t('Copy')}
        </Button>
        <Button
          icon={<Printer className="size-4" />}
          onClick={() => void printDocument({ layout: { format: 'A4', receiptWidthMm: 72 }, content: <RecoveryCodesPrint codes={codes} username={me?.user.username ?? ''} /> })}
        >
          {t('Print')}
        </Button>
      </div>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5 size-4 accent-gold-600" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="codes-saved" />
        {t('I saved these codes somewhere safe. I understand they will not be shown again.')}
      </label>
      <Button
        variant="primary"
        disabled={!saved}
        loading={busy}
        data-testid="codes-done"
        onClick={async () => {
          setBusy(true);
          try {
            await onDone();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('Continue')}
      </Button>
    </div>
  );
}

// ───────────────────────── management ─────────────────────────

export function SecurityPage() {
  const { me, refresh } = useAuth();
  const { t, lang } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['passkeys'], queryFn: () => get<Passkey[]>('/auth/passkeys') });
  const signIns = useQuery({ queryKey: ['sign-ins'], queryFn: () => get<SignIn[]>('/auth/sign-ins') });
  const [adding, setAdding] = useState(false);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!me) return null;
  const sf = me.secondFactor;
  const reload = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['passkeys'] }), qc.invalidateQueries({ queryKey: ['sign-ins'] }), refresh()]);
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(nickname);
      toast.success(t('Passkey registered'), nickname);
      setAdding(false);
      setNickname('');
      await reload();
    } catch (err) {
      setError(failText(err, t('Action failed')));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await del(`/auth/passkeys/${removing.id}`);
      toast.success(t('Passkey removed'), removing.nickname);
      setRemoving(null);
      await reload();
    } catch (err) {
      setError(failText(err, t('Action failed')));
    } finally {
      setBusy(false);
    }
  };
  const regenerate = async () => {
    try {
      setCodes((await post<{ codes: string[] }>('/auth/recovery-codes')).codes);
    } catch (err) {
      toast.error(failText(err, t('Action failed')));
    }
  };
  const list = keys.data ?? [];
  const lastOfRequired = sf.required && list.length <= 1;

  return (
    <div className="p-5 lg:p-6">
      <PageHeader title={t('Sign-in security')} subtitle={t('Passkeys, recovery codes and recent sign-ins of your own account')} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card padded={false}>
          <CardHeader
            title={t('Passkeys')}
            subtitle={sf.required ? t('Your role must sign in with a passkey. Keep at least two devices registered.') : t('Optional for your role: a passkey makes your account much harder to break into.')}
            actions={
              <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => { setAdding(true); setError(null); }} data-testid="add-passkey">
                {t('Add a device')}
              </Button>
            }
          />
          {/* UI-A2: a failed load is an error, never "No passkey registered yet" (audit bug). */}
          {keys.data === undefined && keys.isError ? (
            <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
          ) : keys.data === undefined ? (
            <SkeletonRows rows={2} className="p-5" />
          ) : list.length === 0 ? (
            <div className="p-5 text-[13px] text-ink-500">{t('No passkey registered yet.')}</div>
          ) : (
            <ul className="divide-y divide-line" data-testid="passkey-list">
              {list.map((k) => (
                <li key={k.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="grid size-9 place-items-center rounded-full bg-canvas text-ink-600">{k.backedUp ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{k.nickname}</div>
                    <div className="text-[12px] text-ink-500">
                      {t('Added {date}', { date: dateTime(k.createdAt, lang) })} · {k.lastUsedAt ? t('Last used {date}', { date: dateTime(k.lastUsedAt, lang) }) : t('Never used to sign in')}
                    </div>
                    <div className="mt-1"><UvLabel uv={k.uvAtRegistration} /></div>
                  </div>
                  <Button
                    size="sm"
                    icon={<Trash2 className="size-4" />}
                    disabled={lastOfRequired}
                    title={lastOfRequired ? t('This is your last passkey: register another device before removing it') : undefined}
                    onClick={() => { setRemoving(k); setError(null); }}
                    data-testid={`remove-passkey-${k.id}`}
                  >
                    {t('Remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {lastOfRequired && list.length === 1 && (
            <div className="px-5 pb-4">
              <Alert tone="info">{t('Your only passkey cannot be removed. Register a second device first (your phone is ideal); then you can remove either one.')}</Alert>
            </div>
          )}
        </Card>

        <Card padded={false}>
          <CardHeader
            title={t('Recovery codes')}
            subtitle={t('For signing in once when your passkey device is lost')}
            actions={
              <Button size="sm" icon={<KeyRound className="size-4" />} onClick={regenerate} data-testid="regenerate-codes">
                {sf.recoveryCodesAcknowledged ? t('Make new codes') : t('Create codes')}
              </Button>
            }
          />
          <div className="grid gap-2 p-5 text-[13px] text-ink-600">
            {sf.recoveryCodesAcknowledged ? (
              <div>{t('{n} of 10 unused codes left.', { n: sf.recoveryCodesRemaining })}</div>
            ) : (
              <Alert tone="warning">{t('You have no saved recovery codes. Create them now and keep them somewhere safe.')}</Alert>
            )}
            <div className="text-ink-500">{t('Making new codes cancels all the old ones. It needs your password and your passkey.')}</div>
          </div>
        </Card>

        <Card padded={false} className="xl:col-span-2">
          <CardHeader title={t('Recent sign-ins')} subtitle={t('The last 10 sign-ins to your account. If one is not yours, use “This wasn’t me” in the alert or tell the General Manager.')} />
          {signIns.data === undefined ? (
            signIns.isError ? <ErrorState error={signIns.error} onRetry={() => signIns.refetch()} /> : <SkeletonRows rows={3} className="p-5" />
          ) : signIns.data.length === 0 ? (
            <p className="px-5 py-4 text-meta text-ink-3">{t('No sign-ins recorded yet.')}</p>
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="sign-ins">
              <thead className="bg-canvas text-start text-[12px] text-ink-500">
                <tr>
                  <th className="px-5 py-2 text-start font-medium">{t('When')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('How')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('Browser')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('Approximate address')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('Identity check')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(signIns.data ?? []).map((s) => (
                  <tr key={s.id}>
                    <td className="px-5 py-2">
                      {dateTime(s.at, lang)} {s.newDevice && <Badge tone="warn">{t('New device')}</Badge>}
                    </td>
                    <td className="px-3 py-2">{s.method === 'PASSKEY' ? t('Passkey “{nickname}”', { nickname: s.credentialNickname ?? '—' }) : s.method === 'RECOVERY_CODE' ? t('Recovery code') : t('Password only')}</td>
                    <td className="px-3 py-2">{s.browser ? deviceText(s.browser) : '—'}</td>
                    <td className="px-3 py-2"><span dir="ltr"><Mono>{s.ipApprox ?? '—'}</Mono></span></td>
                    <td className="px-3 py-2"><UvLabel uv={s.uv} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </Card>

        <Card className="xl:col-span-2">
          <div className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold"><Smartphone className="size-4 text-ink-500" /> {t('Register your phone as a second device')}</div>
          <ol className="list-decimal space-y-1 ps-5 text-[13px] leading-relaxed text-ink-700">
            <li>{t('Turn on Bluetooth on this computer and on the phone, and keep the phone near the computer.')}</li>
            <li>{t('Press “Add a device”, name it (e.g. “My phone”) and continue.')}</li>
            <li>{t('In the window that opens, choose “iPhone, iPad or Android device” (or “Use a phone or tablet”). A QR code appears.')}</li>
            <li>{t('Scan the QR code with the phone’s camera and confirm with the phone’s fingerprint, face or screen lock.')}</li>
            <li>{t('Next time, at the passkey step, you can choose the phone the same way if the computer is not available.')}</li>
          </ol>
        </Card>
      </div>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('Add a device')}
        subtitle={t('You will confirm your password and your current passkey first.')}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{t('Cancel')}</Button>
            <Button variant="primary" type="submit" form="add-passkey-form" loading={busy} disabled={!nickname.trim()} icon={<Fingerprint className="size-4" />} data-testid="add-passkey-confirm">
              {t('Register')}
            </Button>
          </>
        }
      >
        <form id="add-passkey-form" onSubmit={add} className="grid gap-3">
          <NoPasskeyHere />
          <Field label={t('Name this device')} hint={t('So you can recognise it later, e.g. “Shop PC – office” or “My phone”.')}>
            <Input autoFocus value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={60} required data-testid="add-passkey-nickname" />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
        </form>
      </Dialog>

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t('Remove this passkey?')}
        subtitle={removing?.nickname}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{t('Cancel')}</Button>
            <Button variant="danger-solid" loading={busy} onClick={remove} data-testid="remove-passkey-confirm">
              {t('Remove')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 text-[13px] text-ink-600">
          <p>{t('That device will no longer be able to sign in to your account. You will confirm your password and a passkey first.')}</p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </Dialog>

      <Dialog open={!!codes} onClose={() => undefined} title={t('Your new recovery codes')} subtitle={t('The old codes no longer work.')}>
        {codes && (
          <RecoveryCodesSheet
            codes={codes}
            onDone={async () => {
              await post('/auth/recovery-codes/acknowledge');
              setCodes(null);
              await reload();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// ───────────────────────── banners (inside the app shell) ─────────────────────────

/**
 * Persistent security notices: a sign-in from a new device (with "It was me" / "This wasn't me"),
 * a nag until a second passkey exists, and — for the General Manager — when touch-only keys are
 * accepted or the second factor is not enforced for the General Manager (not in demo mode).
 */
export function SecurityBanners() {
  const { me, can, refresh, logout } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [confirmNotMe, setConfirmNotMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const sf = me.secondFactor;
  const alert = sf.newDeviceAlert;
  const isGm = can('settings.manage');

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
      await post(`/auth/sign-ins/${alert.id}/not-me`);
      await logout().catch(() => undefined);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(failText(err, t('Action failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2 px-5 pt-4 empty:hidden lg:px-6">
      {alert && (
        <Alert tone="danger" icon={<ShieldAlert className="size-4" />} title={t('New sign-in to your account')}>
          <div data-testid="new-device-alert" className="grid gap-2">
            <div>
              {t('Signed in on {date} with {browser}, from about {ip}, using {method}. Was this you?', {
                date: dateTime(alert.at, lang),
                browser: alert.browser ? deviceText(alert.browser) : '—',
                ip: alert.ipApprox ?? '—',
                method: alert.method === 'PASSKEY' ? t('passkey “{nickname}”', { nickname: alert.credentialNickname ?? '—' }) : alert.method === 'RECOVERY_CODE' ? t('a recovery code') : t('the password only'),
              })}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={itWasMe} data-testid="it-was-me">{t('It was me')}</Button>
              <Button size="sm" variant="danger" onClick={() => setConfirmNotMe(true)} data-testid="not-me">{t('This wasn’t me')}</Button>
            </div>
          </div>
        </Alert>
      )}
      {sf.passkeys === 1 && sf.required && (
        <Alert tone="info" icon={<Smartphone className="size-4" />}>
          <span data-testid="second-passkey-nag">
            {t('You have only one passkey. Register a second device (your phone is ideal) so a lost or broken computer does not lock you out.')}{' '}
            <button className="font-medium underline underline-offset-2" onClick={() => navigate('/security')}>{t('Add a device')}</button>
          </span>
        </Alert>
      )}
      {isGm && sf.userVerification === 'preferred' && (
        <Alert tone="warning" icon={<ShieldAlert className="size-4" />}>
          <span data-testid="uv-preferred-banner">{t('Touch-only security keys are accepted: a passkey does not have to check a fingerprint, face or PIN (Settings › Second factor).')}</span>
        </Alert>
      )}
      {isGm && me.appMode !== 'demo' && !sf.requiredRoles.includes('GENERAL_MANAGER') && (
        <Alert tone="danger" icon={<ShieldAlert className="size-4" />}>
          <span data-testid="enforcement-off-banner">{t('The second factor is OFF for the General Manager: a stolen password alone opens this account (Settings › Second factor).')}</span>
        </Alert>
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
        <div className="grid gap-2 text-[13px] text-ink-600">
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
    </div>
  );
}
