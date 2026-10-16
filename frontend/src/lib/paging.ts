// BE-7 (D-ux-15): a list read from the server one page at a time. Filters, sort and search change → back to page 1
// and a new snapshot; later pages send the snapshot id of page 1, so a row added meanwhile cannot appear twice.
// The CSV export walks every page with the same filters (fetchAllPages), so it still writes the whole result.
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchAllPages, PAGE_SIZE_DEFAULT, type Page, type SortDir } from '@jerp/shared';
import { get } from './api';
import { useDebounced } from './hooks';

export interface ServerPaging<T> {
  page?: Page<T>['page'];
  total: number;
  onPage: (n: number) => void;
  /** Table column key → the list's server sort key (only these columns sort). */
  sortKeys: Record<string, string>;
  sort: { key: string; dir: SortDir } | null;
  onSort: (s: { key: string; dir: SortDir } | null) => void;
  /** Present when the list searches on the server. */
  search?: { value: string; onChange: (v: string) => void };
  /** Every row of the filtered result, for the CSV export. */
  exportAll: () => Promise<T[]>;
}

export function useServerList<T>(
  name: string,
  path: string,
  filters: Record<string, unknown>,
  opts: { sortKeys: Record<string, string>; search?: boolean; pageSize?: number; enabled?: boolean },
) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const base = { ...filters, ...(opts.search && dq.trim() ? { q: dq.trim() } : {}), ...(sort ? { sort: opts.sortKeys[sort.key], dir: sort.dir } : {}) };
  const baseKey = JSON.stringify(base);
  // The page and the snapshot belong to one set of filters: a change of filters starts again at page 1.
  const [at, setAt] = useState<{ key: string; page: number; asOfId?: number }>({ key: baseKey, page: 1 });
  const current = at.key === baseKey ? at : { key: baseKey, page: 1 };
  const params = { ...base, page: current.page, pageSize: opts.pageSize ?? PAGE_SIZE_DEFAULT, ...(current.page > 1 && current.asOfId ? { asOfId: current.asOfId } : {}) };
  const query = useQuery({
    queryKey: [name, params],
    queryFn: () => get<Page<T>>(path, params),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
  const data = query.data;
  const server: ServerPaging<T> = {
    page: data?.page,
    total: data?.total ?? 0,
    onPage: (n) => setAt({ key: baseKey, page: n, asOfId: current.page === 1 ? data?.page.asOfId : current.asOfId }),
    sortKeys: opts.sortKeys,
    sort,
    onSort: setSort,
    ...(opts.search ? { search: { value: q, onChange: setQ } } : {}),
    exportAll: () => fetchAllPages((p) => get<Page<T>>(path, { ...base, ...p })),
  };
  return { query, rows: data?.rows ?? [], totals: data?.totals, server };
}
