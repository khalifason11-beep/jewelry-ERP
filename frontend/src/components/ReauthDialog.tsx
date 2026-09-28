// Step-up authentication prompt. When the API answers 403 REAUTH_REQUIRED (rate changes, role
// changes, inventory adjustments, settings…), api.ts calls the handler registered here; the user
// confirms their password and the original request is retried once.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ApiError, errorText, post, setReauthHandler } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Button, Dialog, Field, Input } from './ui';

export function ReauthDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
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
      finish(true);
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t('Action failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => finish(false)}
      title={t('Confirm your password')}
      subtitle={t('This action is protected. Enter your password to continue.')}
      footer={
        <>
          <Button onClick={() => finish(false)}>{t('Cancel')}</Button>
          <Button variant="primary" type="submit" form="reauth-form" loading={busy} disabled={!password} icon={<ShieldCheck className="size-4" />}>
            {t('Confirm')}
          </Button>
        </>
      }
    >
      <form id="reauth-form" onSubmit={submit} className="grid gap-3">
        <Field label={t('Password')}>
          <Input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  );
}
