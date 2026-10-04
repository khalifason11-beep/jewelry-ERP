// Step-up authentication prompt. When the API answers 403 REAUTH_REQUIRED (rate changes, role
// changes, inventory adjustments, settings…), api.ts calls the handler registered here; the user
// confirms their password and, if they have a passkey, the passkey too (D-2fa-7). The original
// request is then retried once.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import { ApiError, errorText, post, setReauthHandler, type ReauthNeeds } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { getPasskey, PasskeyError, type PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import { Alert, Button, Dialog, Field, Input } from './ui';

/** Confirm with a passkey on the signed-in session (opens the passkey half of the re-auth window). */
export async function confirmWithPasskey(): Promise<{ uv: boolean }> {
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/auth/reauth/passkey/options');
  const response = await getPasskey(options);
  return post<{ uv: boolean }>('/auth/reauth/passkey/verify', { response });
}

export function ReauthDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'password' | 'passkey'>('password');
  const [needs, setNeeds] = useState<ReauthNeeds>({ password: true, passkey: false });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      (n) =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
          setNeeds(n);
          setStep(n.password ? 'password' : 'passkey');
          setPassword('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    setPassword('');
    resolver.current?.(ok);
    resolver.current = null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reauth', { password });
      setPassword('');
      if (needs.passkey) setStep('passkey');
      else finish(true);
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t('Action failed'));
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmWithPasskey();
      finish(true);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof PasskeyError ? errorText(err) : t('Action failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => finish(false)}
      title={step === 'password' ? t('Confirm your password') : t('Confirm with your passkey')}
      subtitle={
        step === 'password'
          ? needs.passkey
            ? t('This action is protected. Enter your password, then confirm with your passkey.')
            : t('This action is protected. Enter your password to continue.')
          : t('Touch the fingerprint reader, look at the camera or enter the PIN of your passkey device.')
      }
      footer={
        <>
          <Button onClick={() => finish(false)}>{t('Cancel')}</Button>
          {step === 'password' ? (
            <Button variant="primary" type="submit" form="reauth-form" loading={busy} disabled={!password} icon={<ShieldCheck className="size-4" />}>
              {needs.passkey ? t('Next') : t('Confirm')}
            </Button>
          ) : (
            <Button variant="primary" onClick={passkey} loading={busy} icon={<Fingerprint className="size-4" />} data-testid="reauth-passkey">
              {t('Use my passkey')}
            </Button>
          )}
        </>
      }
    >
      {step === 'password' ? (
        <form id="reauth-form" onSubmit={submit} className="grid gap-3">
          <Field label={t('Password')}>
            <Input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="text-[13px] text-ink-600">{t('Your password is confirmed. One more step: your passkey.')}</p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}
