import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { ApiError } from '../lib/api';
import { homePath, useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Alert, Button, Field, Input } from '../components/ui';
import { Logo } from '../components/layout/AppShell';

// Clearly fake demo credentials (prototype only).
const DEMO_ACCOUNTS = [
  { username: 'general.manager', password: 'demo-gm-2026', role: 'General Manager', branch: 'All branches' },
  { username: 'branch.manager.kh', password: 'demo-bm-2026', role: 'Branch Manager', branch: 'Khartoum' },
  { username: 'cashier.kh.01', password: 'demo-cashier-2026', role: 'Cashier', branch: 'Khartoum' },
  { username: 'cashier.kh.02', password: 'demo-cashier-2026', role: 'Cashier', branch: 'Khartoum' },
  { username: 'branch.manager.omd', password: 'demo-bm-2026', role: 'Branch Manager', branch: 'Omdurman' },
  { username: 'cashier.omd.01', password: 'demo-cashier-2026', role: 'Cashier', branch: 'Omdurman' },
];

export function LoginPage() {
  const { me, login } = useAuth();
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to={me.user.mustChangePassword ? '/change-password' : homePath(me)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(username, password);
      navigate(res.user.mustChangePassword ? '/change-password' : homePath(res), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-ink-900 p-10 text-white lg:flex lg:flex-col">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, #c9a24b 1px, transparent 0)', backgroundSize: '22px 22px' }}
        />
        <Logo />
        <div className="relative mt-auto max-w-md">
          <div className="mb-4 h-px w-16 bg-gold-500" />
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
            Multi-branch jewelry retail,
            <br />
            <span className="text-gold-400">every piece accounted for.</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-300">
            Item-level inventory, point of sale, Hasad Gold withdrawals, branch profitability and a complete audit trail. One system for Khartoum, Omdurman, Bahri and Port Sudan.
          </p>
          <div className="mt-8 grid grid-cols-3 gap-4 border-t border-white/10 pt-6 text-[13px]">
            <div>
              <div className="font-semibold text-gold-300">Item-based</div>
              <div className="mt-0.5 text-ink-400">Every piece tracked from purchase to sale</div>
            </div>
            <div>
              <div className="font-semibold text-gold-300">Hasad-ready</div>
              <div className="mt-0.5 text-ink-400">Withdrawals settled by real weight</div>
            </div>
            <div>
              <div className="font-semibold text-gold-300">Auditable</div>
              <div className="mt-0.5 text-ink-400">Sessions and actions on record</div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col bg-white">
        <div className="flex justify-end p-4">
          <button onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} className="rounded-md px-2.5 py-1 text-[13px] text-ink-600 hover:bg-canvas">
            {lang === 'en' ? 'العربية' : 'English'}
          </button>
        </div>
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center px-6 pb-10">
          <div className="lg:hidden mb-8 rounded-lg bg-ink-900 p-4">
            <Logo />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-ink-950">{t('Sign in')}</h2>
          <p className="mt-1 text-sm text-ink-500">Use the account assigned to you by the General Manager.</p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <Field label="Username">
              <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. cashier.kh.01" required />
            </Field>
            <Field label="Password">
              <div className="relative">
                <Input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="pe-10" />
                <button type="button" onClick={() => setShow((s) => !s)} className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-ink-400 hover:text-ink-700" aria-label={show ? 'Hide password' : 'Show password'}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<LogIn className="size-4" />}>
              {t('Sign in')}
            </Button>
          </form>

          <div className="mt-8 rounded-lg border border-dashed border-gold-500/60 bg-gold-50/60 p-3">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-gold-700">
              <KeyRound className="size-3.5" /> Demo accounts — fictitious credentials
            </div>
            <div className="grid gap-1">
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.username}
                  type="button"
                  onClick={() => {
                    setUsername(a.username);
                    setPassword(a.password);
                  }}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-[12.5px] hover:bg-white"
                >
                  <span className="font-mono text-ink-800">{a.username}</span>
                  <span className="text-ink-500">
                    {a.role} · {a.branch}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-ink-400">
            <ShieldCheck className="size-3.5" /> Passwords are stored as salted scrypt hashes. Sign-ins are recorded in the audit log.
          </p>
        </div>
      </div>
    </div>
  );
}
