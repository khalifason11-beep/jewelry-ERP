// Step-up authentication prompt. When the API answers 403 REAUTH_REQUIRED (rate changes, role changes, inventory
// adjustments, settings…), api.ts asks through one gate (lib/api.ts `stepUp`): one dialog at a time, shared by every
// request that needs it. UX-3: one step: the password, then the passkey prompt at once for users who have one (a
// "Use my passkey" button only when the browser would not open it by itself, or when only the passkey is missing).
// Each request that waited is then retried by itself (no second click).

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import { ApiError, errorText, post, setReauthHandler, type ReauthNeeds } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { confirmWithPasskey } from '../lib/reauth';
import { PasskeyError } from '../lib/webauthn';
import { Alert, Button, Dialog, Field, Input } from './ui';

export { confirmWithPasskey } from '../lib/reauth';

export function ReauthDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [needs, setNeeds] = useState<ReauthNeeds>({ password: true, passkey: false });
  /** The password part is done (or was not needed): what is left is the passkey. */
  const [passwordDone, setPasswordDone] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      (n) =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setNeeds(n);
          setPasswordDone(!n.password);
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reauth', { password });
      setPassword('');
      setPasswordDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t('Action failed'));
      setBusy(false);
      return;
    }
    setBusy(false);
    // Same click: the passkey prompt follows at once (no "Next" step).
    if (needs.passkey) await passkey();
    else finish(true);
  };

  const passkeyOnly = passwordDone && needs.passkey;
  return (
    <Dialog
      open={open}
      onClose={() => finish(false)}
      title={t('Confirm it is you')}
      subtitle={passkeyOnly ? t('Confirm with your passkey.') : needs.passkey ? t('Enter your password, then confirm with your passkey.') : t('Enter your password to continue.')}
      footer={
        <>
          <Button onClick={() => finish(false)}>{t('Cancel')}</Button>
          {passkeyOnly ? (
            <Button variant="primary" onClick={passkey} loading={busy} icon={<Fingerprint className="size-4" />} data-testid="reauth-passkey">
              {t('Use my passkey')}
            </Button>
          ) : (
            <Button variant="primary" type="submit" form="reauth-form" loading={busy} disabled={!password} icon={<ShieldCheck className="size-4" />} data-testid="reauth-confirm">
              {t('Confirm')}
            </Button>
          )}
        </>
      }
    >
      {!passkeyOnly && (
        <form id="reauth-form" onSubmit={submit} className="grid gap-3">
          <Field label={t('Password')}>
            <Input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="reauth-password" />
          </Field>
        </form>
      )}
      {error && <Alert tone="danger" className={passkeyOnly ? '' : 'mt-3'}>{error}</Alert>}
    </Dialog>
  );
}
