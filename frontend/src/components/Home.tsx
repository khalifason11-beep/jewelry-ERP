// Building blocks of the role homes (UI-B, mockups gm-home.html and bm-home.html, D-ux-1, D-ui-19..21): the Sales
// card on its own dark surface, one light surface for the other level-1 figures, the "Needs attention" panel
// (`/api/attention`, the same list as the top bar's control), and the 14-day sales line of level 2.
// Every figure comes from the server as it is; nothing here computes money.

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { MoneyLineChart } from './charts';
import { AttentionLines, useAttention } from './Attention';
import { ErrorState, Panel, PanelHeader, Skeleton, SkeletonRows } from './ui';
import { useI18n } from '../lib/i18n';

/** The home's period, remembered per person in this browser (D-ux-2). Today by default. */
export function useRememberedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const read = (): T => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v && allowed.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const [v, setV] = useState<T>(read);
  return [
    v,
    (n: T) => {
      setV(n);
      try {
        localStorage.setItem(key, n);
      } catch {
        /* storage unavailable: the choice holds for this visit only */
      }
    },
  ];
}

/** Sales, its own dark card (D-ux-1). */
export function SalesCard({ label, value, sub, testId = 'home-sales' }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-center rounded-card bg-navy px-[18px] py-3.5 text-white" data-testid={testId}>
      <div className="truncate text-meta text-on-navy-soft">{label}</div>
      <div className="mt-0.5 truncate text-kpi font-semibold num" data-testid={`${testId}-value`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-meta text-on-navy-soft">{sub}</div>}
    </div>
  );
}

export interface Figure {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  testId: string;
}

/** The other level-1 figures on one light surface, divided by thin lines (mockup `.group`). */
export function FigureSurface({ figures }: { figures: Figure[] }) {
  return (
    <div className={clsx('grid rounded-card bg-panel sm:grid-cols-3', figures.length === 5 && 'xl:grid-cols-5')} data-testid="home-figures">
      {figures.map((f, i) => (
        <div key={f.testId} className={clsx('min-w-0 px-[18px] py-3.5', i > 0 && 'border-t border-line sm:border-t-0 sm:border-s', i === 3 && 'sm:border-s-0 xl:border-s', i >= 3 && 'sm:border-t xl:border-t-0')} data-testid={f.testId}>
          <div className="truncate text-meta text-ink-2">{f.label}</div>
          <div className="mt-0.5 truncate text-kpi font-semibold text-ink num">{f.value}</div>
          {f.sub && <div className="mt-0.5 truncate text-meta text-ink-3">{f.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** Level 1's figures while they load: the same shapes, so nothing jumps. */
export function FiguresSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_3fr]" data-state="loading">
      <Skeleton className="h-[92px] rounded-card" />
      <Skeleton className="h-[92px] rounded-card" />
    </div>
  );
}

/**
 * "Needs attention" on a home (id `attention`, the target of the top bar's "Open the list on my home"): up to five
 * lines, then "Show all" expanding in place; "No urgent actions." when there is nothing. A failed load is an error
 * in this panel only; the rest of the home still renders.
 */
export function AttentionPanel({ branchId, className }: { branchId?: number | null; className?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const q = useAttention(branchId);
  const [all, setAll] = useState(false);
  const signals = q.data?.signals ?? [];
  const shown = all ? signals : signals.slice(0, 5);
  return (
    <div id="attention" className={clsx('scroll-mt-4', className)}>
      <Panel label={t('Needs attention')} className="h-full">
        <div data-testid="home-attention">
          <PanelHeader
            title={t('Needs attention')}
            count={q.data ? signals.length : undefined}
            action={
              signals.length > 5 ? (
                <button className="font-medium hover:text-ink" aria-expanded={all} onClick={() => setAll((a) => !a)} data-testid="attention-show-all">
                  {all ? t('Show fewer') : t('Show all')}
                </button>
              ) : undefined
            }
          />
          {q.isLoading ? (
            <SkeletonRows rows={3} />
          ) : q.isError && !q.data ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-6" />
          ) : signals.length === 0 ? (
            <div className="rounded-row bg-surface px-3 py-3 text-meta text-ink-3" data-testid="attention-none">
              {t('No urgent actions.')}
            </div>
          ) : (
            <AttentionLines tone="panel" signals={shown} onOpen={(s) => navigate(s.link)} testId="home-attention-line" />
          )}
        </div>
      </Panel>
    </div>
  );
}

/** Level 2: the sales of the last 14 days ending on the period's last day, one line (UI-B Q9). */
export function SalesLinePanel({ data, title, action, footer }: { data: { day: string; revenue: number }[]; title: string; action?: ReactNode; footer?: ReactNode }) {
  const { t } = useI18n();
  return (
    <Panel label={title}>
      <div data-testid="home-sales-line">
        <PanelHeader title={title} action={action} />
        <div className="rounded-row bg-surface px-1 pb-1 pt-2">
          <MoneyLineChart data={data} series={[{ key: 'revenue', label: t('Sales'), color: 'var(--color-navy)' }]} height={180} />
        </div>
        {footer && <div className="px-1 pt-2 text-meta text-ink-2">{footer}</div>}
      </div>
    </Panel>
  );
}

/** A label and its value on one line (mockup `.kv`). */
export function KvRow({ label, value, className, testId }: { label: ReactNode; value: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={clsx('flex items-center justify-between gap-3 border-t border-line px-1 py-1.5 text-meta first:border-t-0', className)} data-testid={testId}>
      <span className="text-ink-2">{label}</span>
      <span className="text-ink num">{value}</span>
    </div>
  );
}
