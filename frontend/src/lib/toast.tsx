import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import clsx from 'clsx';
import { ApiError } from './api';

type Kind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  body?: string;
}

interface ToastApi {
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
  fromError: (e: unknown, title?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Kind, title: string, body?: string) => {
    const id = ++seq;
    setToasts((ts) => [...ts.slice(-3), { id, kind, title, body }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);
  const api: ToastApi = {
    success: (t, b) => push('success', t, b),
    error: (t, b) => push('error', t, b),
    info: (t, b) => push('info', t, b),
    fromError: (e, title = 'Action failed') => push('error', title, e instanceof ApiError || e instanceof Error ? e.message : String(e)),
  };
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="no-print pointer-events-none fixed bottom-4 end-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'pointer-events-auto flex items-start gap-3 rounded-lg border bg-white p-3.5 shadow-lg',
              t.kind === 'success' && 'border-emerald-200',
              t.kind === 'error' && 'border-rose-200',
              t.kind === 'info' && 'border-line',
            )}
          >
            {t.kind === 'success' ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
            ) : t.kind === 'error' ? (
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-rose-600" />
            ) : (
              <Info className="mt-0.5 size-5 shrink-0 text-ink-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-medium text-ink-900">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[13px] text-ink-500">{t.body}</div>}
            </div>
            <button className="text-ink-400 hover:text-ink-700" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error('ToastProvider missing');
  return v;
}
