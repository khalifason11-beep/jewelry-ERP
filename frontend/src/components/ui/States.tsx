// Loading, empty, prompt, no-access, not-found and error states, and inline alerts (UI-A1, UI-A2 D-ui-11).
// Alerts use the R6 meaning colours only. Screens get these through QueryState / DataTable, so every screen shows
// the same state the same way.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Inbox, ListFilter, Loader2, SearchX, ShieldX } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { ApiError, errorText } from '../../lib/api';
import { Button } from './Button';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-ink-3', className)} aria-hidden />;
}

export function Loading({ label, className }: { label?: string; className?: string }) {
  const { t } = useI18n();
  return (
    <div className={clsx('flex items-center justify-center gap-3 py-16 text-meta text-ink-3', className)} role="status">
      <Spinner /> {label ?? t('Loading…')}
    </div>
  );
}

/** A placeholder block while data loads. The pulse stops when the person asks for reduced motion (index.css). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-row bg-neutral-bg', className)} aria-hidden />;
}

/** Placeholder rows for a list or table that is loading. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <div className={clsx('space-y-1.5', className)} role="status" aria-label={t('Loading…')} data-state="loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

/**
 * Says what is empty and offers the next action (R15). `no-access`: permission denied; `prompt`: a choice is needed
 * first (e.g. "Choose a branch"), neutral, never an alert; `not-found`: the record or page does not exist.
 */
export function Empty({
  title,
  body,
  icon,
  action,
  className,
  variant = 'empty',
}: {
  title: string;
  body?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  variant?: 'empty' | 'no-access' | 'prompt' | 'not-found';
}) {
  const icons = { empty: <Inbox className="size-5" />, 'no-access': <ShieldX className="size-5" />, prompt: <ListFilter className="size-5" />, 'not-found': <SearchX className="size-5" /> };
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)} data-state={variant}>
      <div className="mb-3 grid size-11 place-items-center rounded-full bg-panel text-ink-3">{icon ?? icons[variant]}</div>
      <div className="text-[15px] font-medium text-ink">{title}</div>
      {body && <div className="mt-1 max-w-sm text-meta text-ink-3">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * A failed load, in the block that failed (the page title, filters and shell stay). An API refusal (403) is shown
 * as no-access and a missing record (404) as not-found: neither is "something went wrong", and retrying cannot
 * help them. Every other error offers Try again.
 */
export function ErrorState({
  error,
  onRetry,
  className,
  notFoundTitle,
  notFoundAction,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  /** Title when the server answers 404, e.g. "This sale does not exist". */
  notFoundTitle?: string;
  notFoundAction?: ReactNode;
}) {
  const { t } = useI18n();
  if (error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN') {
    return (
      <Empty
        className={className}
        variant="no-access"
        title={t('You do not have access to this')}
        body={t('Your role does not include it. Ask the General Manager if you need access.')}
      />
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return <Empty className={className} variant="not-found" title={notFoundTitle ?? t('Not found')} action={notFoundAction} />;
  }
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)} role="alert" data-state="error">
      <div className="mb-3 grid size-11 place-items-center rounded-full bg-crit-bg text-crit">
        <AlertTriangle className="size-5" />
      </div>
      <div className="text-[15px] font-medium text-ink">{t('Could not load this information')}</div>
      <div className="mt-1 max-w-md text-meta text-ink-3">{errorText(error)}</div>
      {onRetry && (
        <Button className="mt-4" size="sm" onClick={onRetry} data-testid="state-retry">
          {t('Try again')}
        </Button>
      )}
    </div>
  );
}

const ALERT_TONE = {
  info: 'border-line bg-neutral-bg text-ink-2',
  warning: 'border-warn/25 bg-warn-bg text-warn',
  danger: 'border-crit/25 bg-crit-bg text-crit',
  success: 'border-ok/25 bg-ok-bg text-ok',
  // The accent: only for "current selection"-like notes (rare); text stays ink.
  gold: 'border-gold/40 bg-gold-soft text-ink',
} as const;

export function Alert({ tone = 'info', title, children, icon, className }: { tone?: keyof typeof ALERT_TONE; title?: ReactNode; children?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex gap-3 rounded-row border px-4 py-3 text-meta', ALERT_TONE[tone], className)}>
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={clsx(title && 'mt-0.5', 'text-ink-2')}>{children}</div>}
      </div>
    </div>
  );
}
