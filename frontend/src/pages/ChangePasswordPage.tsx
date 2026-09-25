import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { LockKeyhole } from 'lucide-react';
import { ApiError, errorText, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { homePath, useAuth } from '../lib/auth';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { Logo } from '../components/layout/AppShell';

/** Shown when an administrator created the account or reset the password. */
export function ChangePasswordPage() {
  const { me, refresh, logout } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(t('The new passwords do not match'));
    setBusy(true);
    setError(null);
    try {
      await post('/auth/change-password', { currentPassword: current, newPassword: next });
      const res = (await refresh()) as { data?: typeof me };
      navigate(homePath(res.data ?? me), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t('Action failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-ink-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-full bg-gold-100 text-gold-700">
              <LockKeyhole className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">{t('Set a new password')}</h1>
              <p className="text-[13px] text-ink-500">
                {me.user.fullName} · <span className="font-mono">{me.user.username}</span>
              </p>
            </div>
          </div>
          <Alert tone="gold" className="mb-4">
            {t('Your account uses a temporary password issued by the General Manager. Choose a personal password to continue. At least 8 characters, with letters and digits.')}
          </Alert>
          <form onSubmit={submit} className="space-y-3.5">
            <Field label={t('Temporary password')}>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
            </Field>
            <Field label={t('New password')}>
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
            </Field>
            <Field label={t('Confirm new password')}>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => logout().then(() => navigate('/login'))}>
                {t('Sign out')}
              </Button>
              <Button type="submit" variant="primary" className="flex-1" loading={busy}>
                {t('Save password & continue')}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
