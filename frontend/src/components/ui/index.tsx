// In-house component kit: small, consistent, accessible building blocks.

import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import clsx from 'clsx';
import { AlertTriangle, Inbox, Loader2, X } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

// ───────── Button ─────────
type Variant = 'primary' | 'gold' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }>(
  ({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-12 px-5 text-[15px]',
        variant === 'primary' && 'bg-ink-900 text-white hover:bg-ink-800',
        variant === 'gold' && 'bg-gold-500 text-ink-950 hover:bg-gold-400',
        variant === 'secondary' && 'border border-line-strong bg-white text-ink-800 hover:bg-canvas',
        variant === 'ghost' && 'text-ink-600 hover:bg-ink-900/5 hover:text-ink-900',
        variant === 'danger' && 'bg-rose-600 text-white hover:bg-rose-700',
        variant === 'success' && 'bg-emerald-600 text-white hover:bg-emerald-700',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// ───────── Form controls ─────────
const hasWidth = (c?: string) => !!c && /(^|\s)(w-|min-w-|max-w-|flex-1)/.test(c);
const control =
  'h-9 rounded-md border border-line-strong bg-white px-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/25 disabled:bg-canvas';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={clsx(control, !hasWidth(className) && 'w-full', className)} {...rest} />
));
Input.displayName = 'Input';

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(control, 'h-auto min-h-20 w-full py-2', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(control, 'pe-8', !hasWidth(className) && 'w-full', className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

// ───────── Surfaces ─────────
export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={clsx('rounded-lg border border-line bg-white shadow-[0_1px_2px_rgba(13,21,38,0.04)]', padded && 'p-5', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-start justify-between gap-4 border-b border-line px-5 py-3.5', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-ink-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumbs?: ReactNode }) {
  return (
    <div className="mb-5">
      {breadcrumbs && <div className="mb-2 text-[13px] text-ink-500">{breadcrumbs}</div>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink-950">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// ───────── Status badges ─────────
const STATUS_TONE: Record<string, string> = {
  AVAILABLE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  APPROVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  RECEIVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  PURCHASE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  TRANSFER_IN: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  RESERVED: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  PENDING: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  IN_PROGRESS: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  IN_TRANSIT: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  TRANSFERRED: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  IDLE: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  READY_FOR_PICKUP: 'bg-sky-50 text-sky-800 ring-sky-600/25',
  SOLD: 'bg-ink-900/5 text-ink-700 ring-ink-600/20',
  SALE: 'bg-ink-900/5 text-ink-700 ring-ink-600/20',
  REDEEMED: 'bg-gold-100 text-gold-700 ring-gold-600/30',
  HASAD_REDEMPTION: 'bg-gold-100 text-gold-700 ring-gold-600/30',
  DAMAGED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  DAMAGE: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  VOIDED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  CANCELLED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  REJECTED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  DISABLED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  REVOKED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  LOGIN_FAILED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  RETURNED: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  RETURN: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  BRANCH_PAYS_CUSTOMER: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  CUSTOMER_PAYS_BRANCH: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
};

export function Badge({ children, tone, className }: { children: ReactNode; tone?: string; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11.5px] font-medium ring-1 ring-inset', tone ?? 'bg-ink-900/5 text-ink-600 ring-ink-600/15', className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const { t } = useI18n();
  if (!status) return <span className="text-ink-400">—</span>;
  const label = t(status);
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      {label === status ? status.replaceAll('_', ' ') : label}
    </Badge>
  );
}

// ───────── States ─────────
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-ink-400', className)} />;
}

export function Loading({ label, className }: { label?: string; className?: string }) {
  const { t } = useI18n();
  return (
    <div className={clsx('flex items-center justify-center gap-3 py-16 text-sm text-ink-500', className)} role="status">
      <Spinner /> {label ?? t('Loading…')}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded bg-ink-900/[0.06]', className)} />;
}

export function Empty({ title, body, icon, action, className }: { title: string; body?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-3 grid size-11 place-items-center rounded-full bg-canvas text-ink-400">{icon ?? <Inbox className="size-5" />}</div>
      <div className="font-medium text-ink-800">{title}</div>
      {body && <div className="mt-1 max-w-sm text-[13px] text-ink-500">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t } = useI18n();
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)} role="alert">
      <div className="mb-3 grid size-11 place-items-center rounded-full bg-rose-50 text-rose-600">
        <AlertTriangle className="size-5" />
      </div>
      <div className="font-medium text-ink-800">{t('Something went wrong')}</div>
      <div className="mt-1 max-w-md text-[13px] text-ink-500">{msg}</div>
      {onRetry && (
        <Button className="mt-4" size="sm" onClick={onRetry}>
          {t('Try again')}
        </Button>
      )}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, icon, className }: { tone?: 'info' | 'warning' | 'danger' | 'success' | 'gold'; title?: ReactNode; children?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'flex gap-3 rounded-md border px-4 py-3 text-[13px]',
        tone === 'info' && 'border-sky-200 bg-sky-50 text-sky-900',
        tone === 'warning' && 'border-amber-200 bg-amber-50 text-amber-900',
        tone === 'danger' && 'border-rose-200 bg-rose-50 text-rose-900',
        tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
        tone === 'gold' && 'border-gold-300 bg-gold-50 text-ink-800',
        className,
      )}
    >
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={clsx(title && 'mt-0.5')}>{children}</div>}
      </div>
    </div>
  );
}

// ───────── Dialog ─────────
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button[data-autofocus]')?.focus(), 30);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/45 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className={clsx('w-full rounded-xl bg-white shadow-2xl', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-950">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-canvas hover:text-ink-700" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-canvas/60 px-5 py-3 rounded-b-xl">{footer}</div>}
      </div>
    </div>
  );
}

// ───────── Tabs ─────────
export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div className={clsx('flex gap-1 overflow-x-auto border-b border-line', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors',
            value === t.value ? 'border-gold-500 text-ink-950' : 'border-transparent text-ink-500 hover:text-ink-800',
          )}
        >
          {t.label}
          {t.count != null && <span className="rounded-full bg-canvas px-1.5 text-[11px] text-ink-600 num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ───────── KPI tile ─────────
export function Kpi({
  label,
  value,
  sub,
  icon,
  tone = 'default',
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'gold' | 'dark';
  onClick?: () => void;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={clsx(
        'group relative flex min-w-0 flex-col rounded-lg border p-4 text-start transition-colors',
        tone === 'default' && 'border-line bg-white',
        tone === 'gold' && 'border-gold-300 bg-gold-50',
        tone === 'dark' && 'border-ink-800 bg-ink-900 text-white',
        onClick && 'cursor-pointer hover:border-gold-400',
      )}
    >
      <div className={clsx('flex items-center justify-between gap-2 text-[12.5px] font-medium', tone === 'dark' ? 'text-ink-300' : 'text-ink-500')}>
        <span className="truncate">{label}</span>
        {icon && <span className={clsx('shrink-0', tone === 'dark' ? 'text-gold-400' : 'text-ink-400')}>{icon}</span>}
      </div>
      <div className={clsx('mt-2 truncate text-[22px] font-semibold tracking-tight num', tone === 'dark' ? 'text-white' : 'text-ink-950')}>{value}</div>
      {sub && <div className={clsx('mt-1 truncate text-xs', tone === 'dark' ? 'text-ink-300' : 'text-ink-500')}>{sub}</div>}
    </Comp>
  );
}

// ───────── Misc ─────────
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono text-[12.5px]', className)}>{children}</span>;
}

export function KeyValue({ items, cols = 2 }: { items: { label: ReactNode; value: ReactNode }[]; cols?: number }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-3', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3', cols === 4 && 'sm:grid-cols-4')}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-ink-500">{it.label}</dt>
          <dd className="mt-0.5 truncate font-medium text-ink-900">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ItemThumb({ category, karat, size = 'md' }: { category: string; karat: number; size?: 'sm' | 'md' | 'lg' }) {
  // Placeholder artwork per category until real product photography is available.
  const glyph: Record<string, string> = { RING: '◯', BRACELET: '◎', NECKLACE: '◡', EARRING: '◌', CHAIN: '∞', PENDANT: '◊', SET: '❖' };
  return (
    <div
      className={clsx(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-ink-850 to-ink-700 text-gold-400',
        size === 'sm' && 'size-10 text-lg',
        size === 'md' && 'aspect-[4/3] w-full text-3xl',
        size === 'lg' && 'size-24 text-4xl',
      )}
      aria-hidden
    >
      <span className="opacity-90">{glyph[category] ?? '◇'}</span>
      <span className="absolute bottom-1 end-1 rounded bg-ink-950/60 px-1 text-[10px] font-semibold text-gold-300">{karat}K</span>
    </div>
  );
}
