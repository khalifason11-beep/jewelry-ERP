// Surfaces and page structure (UI-A1). Cards are flat grey panels on the white page (owner answer Q3): no border, no
// shadow; hierarchy comes from the grey and the spacing (tokens.md). KPI tiles follow until UI-B redraws the homes.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { karatLabel } from '../../lib/format';

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={clsx('rounded-card bg-panel', padded && 'p-5', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-start justify-between gap-4 border-b border-line px-5 py-3.5', className)}>
      <div className="min-w-0">
        <h3 className="text-section font-semibold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-meta text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumbs?: ReactNode }) {
  return (
    <div className="mb-4">
      {breadcrumbs && <div className="mb-2 text-meta text-ink-3">{breadcrumbs}</div>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-title font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mt-0.5 text-meta text-ink-3">{subtitle}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

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
            '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[15px] font-medium transition-colors',
            // Gold marks the current selection (R5).
            value === t.value ? 'border-gold text-ink' : 'border-transparent text-ink-3 hover:text-ink',
          )}
        >
          {t.label}
          {t.count != null && <span className="rounded-full bg-neutral-bg px-1.5 text-meta text-ink-2 num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** KPI tile used by today's dashboards; UI-B replaces it with the mockups' Sales card + shared surface (D-ux-1). */
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
  /** `gold` is kept for compatibility but renders like `default`: gold is never a KPI fill (R5). */
  tone?: 'default' | 'gold' | 'dark';
  onClick?: () => void;
}) {
  const Comp = onClick ? 'button' : 'div';
  const dark = tone === 'dark';
  return (
    <Comp
      onClick={onClick}
      className={clsx(
        'group relative flex min-w-0 flex-col rounded-card p-4 text-start transition-colors',
        dark ? 'bg-navy text-white' : 'bg-panel',
        onClick && (dark ? 'cursor-pointer hover:bg-navy-2' : 'cursor-pointer hover:bg-neutral-bg'),
      )}
    >
      <div className={clsx('flex items-center justify-between gap-2 text-meta', dark ? 'text-on-navy-soft' : 'text-ink-2')}>
        <span className="truncate">{label}</span>
        {icon && <span className={clsx('shrink-0', dark ? 'text-gold' : 'text-ink-3')}>{icon}</span>}
      </div>
      <div className={clsx('mt-1 truncate text-kpi font-semibold num', dark ? 'text-white' : 'text-ink')}>{value}</div>
      {sub && <div className={clsx('mt-0.5 truncate text-meta', dark ? 'text-on-navy-soft' : 'text-ink-3')}>{sub}</div>}
    </Comp>
  );
}

export function Mono({ children, className, 'data-testid': testId }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  return (
    <span className={clsx('font-mono text-[13px]', className)} data-testid={testId}>
      {children}
    </span>
  );
}

export function KeyValue({ items, cols = 2 }: { items: { label: ReactNode; value: ReactNode }[]; cols?: number }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-3', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3', cols === 4 && 'sm:grid-cols-4')}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-meta text-ink-3">{it.label}</dt>
          <dd className="mt-0.5 truncate font-medium text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ItemThumb({ category, karat, size = 'md' }: { category: string; karat: number; size?: 'sm' | 'md' | 'lg' }) {
  // Placeholder artwork per category until real product photography is available (POS screen, UI-C1).
  const glyph: Record<string, string> = { RING: '◯', BRACELET: '◎', NECKLACE: '◡', EARRING: '◌', CHAIN: '∞', PENDANT: '◊', SET: '❖' };
  return (
    <div
      className={clsx(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-row bg-gradient-to-br from-ink-850 to-ink-700 text-gold-400',
        size === 'sm' && 'size-10 text-lg',
        size === 'md' && 'aspect-[4/3] w-full text-3xl',
        size === 'lg' && 'size-24 text-4xl',
      )}
      aria-hidden
    >
      <span className="opacity-90">{glyph[category] ?? '◇'}</span>
      <span className="absolute bottom-1 end-1 rounded bg-ink-950/60 px-1 text-[10px] font-semibold text-gold-300">{karatLabel(karat)}</span>
    </div>
  );
}
