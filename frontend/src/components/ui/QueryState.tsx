// One way to show a block's data states on every screen (UI-A2, D-ui-11):
//   loading   first load: a skeleton in the block; the page title, filters and actions around it stay
//   idle      the query waits for a choice (disabled): the `prompt` ("Choose a branch …"), never "no data"
//   error     ErrorState in the block (403 → no access, 404 → not found, otherwise Try again)
//   ready     the children; a filter change keeps the previous data (keepPreviousData) with a thin bar on top
// An error during a background refresh keeps the data on screen with a one-line warning.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useI18n } from '../../lib/i18n';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Layout';
import { ErrorState, SkeletonRows } from './States';

/** What QueryState needs from a TanStack Query result. */
export interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  isPlaceholderData?: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => unknown;
}

export type ViewState = 'loading' | 'idle' | 'error' | 'ready';

export function viewState(q: QueryLike<unknown>): ViewState {
  if (q.data !== undefined) return 'ready';
  if (q.isError) return 'error';
  // A disabled query (waiting for a branch, a date…) has no data and does not fetch.
  if (q.fetchStatus === 'idle') return 'idle';
  return 'loading';
}

/** The thin "updating" bar shown while a filter change refetches (the previous data stays). */
export function RefreshBar({ active }: { active: boolean }) {
  const { t } = useI18n();
  if (!active) return null;
  return (
    <div className="relative h-0.5 w-full overflow-hidden bg-neutral-bg" role="status" aria-label={t('Updating…')} data-state="refreshing">
      <div className="absolute inset-y-0 w-1/3 animate-[refresh_1.1s_ease-in-out_infinite] bg-navy" />
    </div>
  );
}

export function QueryState<T>({
  query,
  children,
  loading,
  prompt,
  notFoundTitle,
  notFoundAction,
  className,
}: {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
  /** Placeholder while loading (default: skeleton rows). */
  loading?: ReactNode;
  /** Shown while the query waits for a choice (disabled). */
  prompt?: ReactNode;
  notFoundTitle?: string;
  notFoundAction?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const state = viewState(query);
  if (state === 'loading') return <div className={clsx('p-4', className)}>{loading ?? <SkeletonRows rows={4} />}</div>;
  if (state === 'idle') return <>{prompt ?? null}</>;
  if (state === 'error')
    return <ErrorState className={className} error={query.error} onRetry={() => query.refetch()} notFoundTitle={notFoundTitle} notFoundAction={notFoundAction} />;
  return (
    <>
      <RefreshBar active={!!query.isPlaceholderData && query.isFetching} />
      {query.isError && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-meta text-warn" role="status" data-state="stale">
          {t('Could not refresh; showing the last data loaded.')}
          <button className="font-medium underline underline-offset-2" onClick={() => query.refetch()}>
            {t('Try again')}
          </button>
        </div>
      )}
      {children(query.data as T)}
    </>
  );
}

/**
 * A detail page (sale, purchase, piece, branch) before its record is there: the way back stays on screen, the
 * block shows a skeleton, the error with Try again, "This … does not exist" (404) or no-access (403).
 */
export function DetailPending({ query, backTo, backLabel, notFoundTitle }: { query: QueryLike<unknown>; backTo: string; backLabel: string; notFoundTitle: string }) {
  const navigate = useNavigate();
  const back = (
    <Button size="sm" onClick={() => navigate(backTo)} data-testid="back-to-list">
      {backLabel}
    </Button>
  );
  return (
    <div className="p-5 lg:p-6">
      <div className="mb-4">
        <Button size="sm" variant="ghost" icon={<ArrowLeft className="size-4 rtl:rotate-180" />} onClick={() => navigate(backTo)}>
          {backLabel}
        </Button>
      </div>
      <Card padded={false}>
        {viewState(query) === 'error' ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} notFoundTitle={notFoundTitle} notFoundAction={back} />
        ) : (
          <SkeletonRows rows={6} className="p-5" />
        )}
      </Card>
    </div>
  );
}
