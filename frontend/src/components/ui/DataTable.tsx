// Data table used by the list screens (sort, search, CSV, totals). Restyled with the UI-A1 tokens: white table on
// the grey card (mockup: white rows inside panels), 13 px headers, 15 px cells (R16).
// UI-A2 (D-ui-11): pass the list's `query` and the table shows its states itself, below a toolbar that never
// disappears: skeleton rows on the first load, the previous rows with a thin bar while a filter change reloads,
// the error (with Try again, no access or not found) in place of the rows, the `prompt` while the query waits
// for a choice, and the screen's own empty text with its next action.
// BE-7: with `server` (useServerList) the rows are one page of a list sorted, searched and counted on the server: the
// column sort and the search box ask the server, a pager shows the place in the list, and the CSV export walks every
// page of the filtered result.
import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Download, Search } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { Button } from './Button';
import { Input } from './Field';
import { Empty, ErrorState, SkeletonRows } from './States';
import { RefreshBar, viewState, type QueryLike } from './QueryState';
import type { ServerPaging } from '../../lib/paging';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Plain value used for sorting, searching and CSV export. */
  value?: (row: T) => unknown;
  render?: (row: T) => ReactNode;
  align?: 'start' | 'end' | 'center';
  className?: string;
  sortable?: boolean;
  /** Footer cell (totals). */
  footer?: ReactNode;
  csvHeader?: string;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  searchable = true,
  searchPlaceholder,
  initialSort,
  emptyTitle,
  emptyBody,
  emptyAction,
  query,
  prompt,
  exportName,
  toolbar,
  dense,
  maxHeight,
  rowClassName,
  server,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, i: number) => string | number;
  onRowClick?: (row: T) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** What is empty, in the screen's words (ANALYSIS §8). Required: there is no generic "Nothing to show". */
  emptyTitle: string;
  emptyBody?: ReactNode;
  /** The next action offered when the list is empty (only actions the person may take). */
  emptyAction?: ReactNode;
  /** The list's query: the table then shows loading, refresh, error and idle states itself. */
  query?: QueryLike<unknown>;
  /** Shown while `query` waits for a choice (a disabled query), e.g. "Choose a branch". */
  prompt?: ReactNode;
  exportName?: string;
  toolbar?: ReactNode;
  dense?: boolean;
  maxHeight?: string;
  rowClassName?: (row: T) => string | undefined;
  /** BE-7: a server-paged list (useServerList); the table then neither filters nor sorts the rows itself. */
  server?: ServerPaging<T>;
}) {
  const { t } = useI18n();
  const state = query ? viewState(query) : 'ready';
  const [localQ, setLocalQ] = useState('');
  const [localSort, setLocalSort] = useState(initialSort ?? null);
  const [exporting, setExporting] = useState(false);
  const q = server ? (server.search?.value ?? '') : localQ;
  const setQ = (v: string) => (server ? server.search?.onChange(v) : setLocalQ(v));
  const sort = server ? server.sort : localSort;
  const setSort = (s: { key: string; dir: 'asc' | 'desc' } | null) => (server ? server.onSort(s) : setLocalSort(s));
  const showSearch = searchable && (!server || !!server.search);

  const valueOf = (c: Column<T>, r: T) => (c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]);

  const filtered = useMemo(() => {
    if (server) return rows;
    let out = rows;
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      out = out.filter((r) => columns.some((c) => String(valueOf(c, r) ?? '').toLowerCase().includes(needle)));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        out = [...out].sort((a, b) => {
          const va = valueOf(col, a);
          const vb = valueOf(col, b);
          const cmp =
            typeof va === 'number' && typeof vb === 'number'
              ? va - vb
              : String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true });
          return sort.dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, sort, columns, server]);

  const exportCsv = async () => {
    // A server list exports every page of the filtered result, not the page on screen.
    let all: T[] = filtered;
    if (server) {
      setExporting(true);
      try {
        all = await server.exportAll();
      } finally {
        setExporting(false);
      }
    }
    const esc = (v: unknown) => {
      const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const header = columns.map((c) => esc(c.csvHeader ?? (typeof c.header === 'string' ? c.header : c.key))).join(',');
    const body = all.map((r) => columns.map((c) => esc(valueOf(c, r))).join(',')).join('\n');
    const blob = new Blob([`﻿${header}\n${body}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${exportName ?? 'export'}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const hasFooter = columns.some((c) => c.footer !== undefined);
  const alignCls = (a?: string) => (a === 'end' ? 'text-end' : a === 'center' ? 'text-center' : 'text-start');

  return (
    <div className="flex min-h-0 flex-col">
      {(showSearch || toolbar || exportName) && (
        <div className="no-print flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          {showSearch && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder ?? t('Search')} className="h-9 ps-8" aria-label={t('Search')} />
            </div>
          )}
          <div className="flex flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {state === 'ready' && (
            <span className="text-meta text-ink-3 num">
              {t((server ? server.total : filtered.length) === 1 ? '{n} row' : '{n} rows', { n: (server ? server.total : filtered.length).toLocaleString('en-US') })}
            </span>
          )}
          {exportName && (
            <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={exportCsv} disabled={exporting} data-testid="export-csv">
              {t('Export CSV')}
            </Button>
          )}
        </div>
      )}
      {query && <RefreshBar active={!!query.isPlaceholderData && query.isFetching} />}
      {state === 'loading' ? (
        <SkeletonRows rows={6} className="p-4" />
      ) : state === 'error' ? (
        <ErrorState error={query!.error} onRetry={() => query!.refetch()} />
      ) : state === 'idle' ? (
        <>{prompt ?? null}</>
      ) : filtered.length === 0 ? (
        <Empty title={q ? t('No results for “{q}”', { q }) : t(emptyTitle)} body={q ? t('Try a different search term.') : emptyBody} action={q ? undefined : emptyAction} />
      ) : (
        <div className="scroll-thin overflow-auto bg-surface" style={{ maxHeight }}>
          <table className="w-full border-collapse text-[15px]">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr>
                {columns.map((c) => {
                  const active = sort?.key === c.key;
                  // An action column has no header text: nothing to sort by, and a nameless sort button would fail axe.
                  const canSort = c.sortable !== false && c.header !== '' && (!server || c.key in server.sortKeys);
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className={clsx('whitespace-nowrap border-b border-line px-3 py-2 text-meta font-medium text-ink-3', alignCls(c.align), c.className)}
                      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      {canSort ? (
                        <button
                          className={clsx('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}
                          onClick={() => setSort(active ? (sort!.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' })}
                        >
                          {c.header}
                          {active ? sort!.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr
                  key={rowKey(r, i)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={clsx('border-b border-line/70 last:border-0', onRowClick && 'cursor-pointer hover:bg-panel', rowClassName?.(r))}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('px-3 text-ink', dense ? 'py-1.5' : 'py-2', alignCls(c.align), c.className ?? 'whitespace-nowrap')}>
                      {c.render ? c.render(r) : String(valueOf(c, r) ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {hasFooter && (
              <tfoot className="sticky bottom-0 bg-surface">
                <tr>
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('border-t border-line-strong px-3 py-2 font-semibold text-ink num', alignCls(c.align))}>
                      {c.footer}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {server?.page && server.total > server.page.size && state !== 'loading' && state !== 'error' && (
        <div className="no-print flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-meta text-ink-3" data-testid="pager">
          <span className="num">
            {t('{from}–{to} of {total}', {
              from: Math.min((server.page.number - 1) * server.page.size + 1, server.total).toLocaleString('en-US'),
              to: Math.min(server.page.number * server.page.size, server.total).toLocaleString('en-US'),
              total: server.total.toLocaleString('en-US'),
            })}
          </span>
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4 rtl:rotate-180" />} disabled={server.page.number <= 1} onClick={() => server.onPage(server.page!.number - 1)} aria-label={t('Previous page')} data-testid="page-prev" />
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4 rtl:rotate-180" />} disabled={server.page.number >= server.page.pages} onClick={() => server.onPage(server.page!.number + 1)} aria-label={t('Next page')} data-testid="page-next" />
        </div>
      )}
    </div>
  );
}
