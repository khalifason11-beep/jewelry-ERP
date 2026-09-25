import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Search } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { Button, Empty, Input } from './index';

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
  emptyTitle = 'Nothing to show',
  emptyBody,
  exportName,
  toolbar,
  dense,
  maxHeight,
  rowClassName,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, i: number) => string | number;
  onRowClick?: (row: T) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  emptyTitle?: string;
  emptyBody?: ReactNode;
  exportName?: string;
  toolbar?: ReactNode;
  dense?: boolean;
  maxHeight?: string;
  rowClassName?: (row: T) => string | undefined;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(initialSort ?? null);

  const valueOf = (c: Column<T>, r: T) => (c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]);

  const filtered = useMemo(() => {
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
  }, [rows, q, sort, columns]);

  const exportCsv = () => {
    const esc = (v: unknown) => {
      const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const header = columns.map((c) => esc(c.csvHeader ?? (typeof c.header === 'string' ? c.header : c.key))).join(',');
    const body = filtered.map((r) => columns.map((c) => esc(valueOf(c, r))).join(',')).join('\n');
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
      {(searchable || toolbar || exportName) && (
        <div className="no-print flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          {searchable && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder ?? t('Search')} className="h-8 ps-8" aria-label={t('Search')} />
            </div>
          )}
          <div className="flex flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          <span className="text-xs text-ink-500 num">{t(filtered.length === 1 ? '{n} row' : '{n} rows', { n: filtered.length.toLocaleString('en-US') })}</span>
          {exportName && (
            <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={exportCsv}>
              {t('Export CSV')}
            </Button>
          )}
        </div>
      )}
      {filtered.length === 0 ? (
        <Empty title={q ? t('No results for “{q}”', { q }) : t(emptyTitle)} body={q ? t('Try a different search term.') : emptyBody} />
      ) : (
        <div className="scroll-thin overflow-auto" style={{ maxHeight }}>
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-[#f7f8fa]">
              <tr>
                {columns.map((c) => {
                  const active = sort?.key === c.key;
                  const canSort = c.sortable !== false;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className={clsx('whitespace-nowrap border-b border-line px-3 py-2 font-medium text-ink-500', alignCls(c.align), c.className)}
                      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      {canSort ? (
                        <button
                          className={clsx('inline-flex items-center gap-1 hover:text-ink-900', active && 'text-ink-900')}
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
                  className={clsx('border-b border-line/70 last:border-0', onRowClick && 'cursor-pointer hover:bg-gold-50/60', rowClassName?.(r))}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('px-3 text-ink-800', dense ? 'py-1.5' : 'py-2.5', alignCls(c.align), c.className ?? 'whitespace-nowrap')}>
                      {c.render ? c.render(r) : String(valueOf(c, r) ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {hasFooter && (
              <tfoot className="sticky bottom-0 bg-[#f7f8fa]">
                <tr>
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('border-t border-line-strong px-3 py-2 font-semibold text-ink-900 num', alignCls(c.align))}>
                      {c.footer}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
