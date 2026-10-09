import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Fingerprint, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { ApiError, errorText, post } from '../lib/api';
import { getPasskey, PasskeyError, type PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import { homePath, sessionEnded, useAuth, type Me, type PendingSignIn } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { AuthFrame } from '../components/layout/AuthFrame';

export function LoginPage() {
  const { me, login } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSignIn | null>(null);

  if (me) return <Navigate to={me.user.mustChangePassword ? '/change-password' : homePath(me)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(username, password);
      if ('status' in res) {
        setPassword('');
        setPending(res);
        return;
      }
      navigate(res.user.mustChangePassword ? '/change-password' : homePath(res), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t('Sign-in failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame languageSwitch>
      <Card className="p-7">
        {pending ? (
          <SecondStep pending={pending} onBack={() => { setPending(null); setError(null); }} />
        ) : (
          <>
            {sessionEnded() && (
              <Alert tone="info" className="mb-4">
                <span data-testid="session-ended">{t('Your session ended. Sign in again.')}</span>
              </Alert>
            )}
            <h1 className="text-title font-semibold text-ink">{t('Sign in')}</h1>
            <p className="mt-1 text-meta text-ink-3">{t('Use the account assigned to you by the General Manager.')}</p>

            <form onSubmit={submit} className="mt-6 space-y-4">
              <Field label={t('Username')}>
                <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('e.g. cashier.kh.01')} required className="bg-surface" />
              </Field>
              <Field label={t('Password')}>
                <div className="relative">
                  <Input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="bg-surface pe-10" />
                  <button type="button" onClick={() => setShow((s) => !s)} className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-ink-3 hover:text-ink" aria-label={show ? t('Hide password') : t('Show password')}>
                    {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>
              {error && <Alert tone="danger">{error}</Alert>}
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<LogIn className="size-4" />}>
                {t('Sign in')}
              </Button>
            </form>
          </>
        )}
      </Card>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-[12px] text-ink-3">
        <ShieldCheck className="size-3.5" /> {t('Passwords are stored as Argon2id hashes. Sign-ins are recorded in the audit log.')}
      </p>
    </AuthFrame>
  );
}

/**
 * Second step of the sign-in (Phase 2fa): the password was right; now the passkey (Windows Hello,
 * a security key or the phone) or, if the device is lost, one recovery code.
 */
function SecondStep({ pending, onBack }: { pending: PendingSignIn; onBack: () => void }) {
  const { t } = useI18n();
  const { signedIn } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'PASSKEY' | 'RECOVERY_CODE'>(pending.methods.includes('PASSKEY') ? 'PASSKEY' : 'RECOVERY_CODE');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (me: Me) => {
    signedIn(me);
    navigate(me.user.mustChangePassword ? '/change-password' : homePath(me), { replace: true });
  };
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'LOGIN_PENDING_EXPIRED') {
      onBack();
      return;
    }
    setError(err instanceof ApiError || err instanceof PasskeyError ? errorText(err) : t('Sign-in failed'));
  };

  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/auth/login/passkey/options');
      const response = await getPasskey(options);
      done(await post<Me>('/auth/login/passkey/verify', { response }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const withCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      done(await post<Me>('/auth/login/recovery', { code }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    await post('/auth/login/cancel').catch(() => undefined);
    onBack();
  };

  return (
    <div data-testid="second-step">
      <h1 className="text-title font-semibold text-ink">{t('Confirm it is you')}</h1>
      <p className="mt-1 text-meta text-ink-3">{t('Your password is correct. Now confirm with your passkey: the fingerprint, face or PIN of this computer (Windows Hello), your security key, or your phone.')}</p>
      {mode === 'PASSKEY' ? (
        <div className="mt-7 space-y-4">
          <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={withPasskey} icon={<Fingerprint className="size-4" />} data-testid="use-passkey">
            {t('Use my passkey')}
          </Button>
          {error && <Alert tone="danger">{error}</Alert>}
          <button type="button" className="text-[13px] text-ink-600 underline-offset-2 hover:underline" onClick={() => { setMode('RECOVERY_CODE'); setError(null); }}>
            {t('Lost your device? Use a recovery code')}
          </button>
        </div>
      ) : (
        <form onSubmit={withCode} className="mt-7 space-y-4">
          <Field label={t('Recovery code')} hint={t('One of the 10 codes you saved when you set up your passkey. Each code works once.')}>
            <Input autoFocus autoComplete="one-time-code" dir="ltr" className="font-mono tracking-wider" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" required data-testid="recovery-code" />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<KeyRound className="size-4" />}>
            {t('Sign in with the code')}
          </Button>
          {pending.methods.includes('PASSKEY') && (
            <button type="button" className="text-[13px] text-ink-600 underline-offset-2 hover:underline" onClick={() => { setMode('PASSKEY'); setError(null); }}>
              {t('Use my passkey instead')}
            </button>
          )}
        </form>
      )}
      <div className="mt-6 border-t border-line pt-4">
        <button type="button" className="text-[13px] text-ink-500 hover:text-ink-800" onClick={cancel}>
          {t('Back to the password')}
        </button>
      </div>
    </div>
  );
}
