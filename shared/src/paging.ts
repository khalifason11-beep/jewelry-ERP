// BE-7 (D-ux-15): one response shape for every server-paged list, and the walk the CSV export uses.
// Offset pages over a stable order (the sort column, then the unique id) and a snapshot id: page 1 answers `asOfId`,
// later pages send it back, so a row added while someone pages cannot appear twice (docs/plans/BE-7.md).

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export type SortDir = 'asc' | 'desc';

export interface PageInfo {
  /** 1-based page number, as requested (a page beyond the last answers no rows). */
  number: number;
  size: number;
  /** Number of pages for `total` (at least 1). */
  pages: number;
  sort: string;
  dir: SortDir;
  /** Highest id visible to this listing; send it back on the next pages and the export. */
  asOfId: number;
}

export interface Page<T> {
  rows: T[];
  /** Every row matching the filters (and the caller's branch scope), not only this page. */
  total: number;
  page: PageInfo;
  /**
   * Sums over every row matching the filters (not only this page), for the lists whose table shows totals. Cost sums
   * carry their COST field names, so the response filter removes them for anyone without `profit.view`.
   */
  totals?: Record<string, number | null>;
}

/** The query parameters that select a page (added to the list's own filters). */
export interface PageParams {
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: SortDir;
  asOfId?: number;
}

/**
 * Every row of a filtered list, page by page at the largest size, with the same sort and the snapshot of the first
 * page: what the CSV export writes. `fetchPage` must apply the same filters each time.
 */
export async function fetchAllPages<T>(fetchPage: (p: PageParams) => Promise<Page<T>>, params: PageParams = {}): Promise<T[]> {
  const first = await fetchPage({ ...params, page: 1, pageSize: PAGE_SIZE_MAX });
  const out = [...first.rows];
  const { asOfId, pages, sort, dir } = first.page;
  for (let n = 2; n <= pages; n++) {
    const next = await fetchPage({ ...params, page: n, pageSize: PAGE_SIZE_MAX, sort, dir, asOfId });
    out.push(...next.rows);
  }
  return out;
}
