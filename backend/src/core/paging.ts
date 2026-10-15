// BE-7 (D-ux-15, docs/plans/BE-7.md): the one helper behind every server-paged list.
// Offset pages over `ORDER BY <allowed column> <dir>, id <dir>` (the unique id keeps equal values in one order), an
// exact total with the same WHERE (the caller's branch scope included), and a snapshot id so rows inserted while
// someone pages cannot appear twice. Sort keys come from a fixed list per route (zod refuses anything else with 400,
// nothing from the request reaches SQL); a key whose field is classified COST is refused (403) without `profit.view`.

import { z } from 'zod';
import { and, asc, desc, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { COST_RESPONSE_FIELDS, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, type Page, type SortDir } from '@jerp/shared';
import type { Actor } from './context';
import { forbidden } from './errors';

export interface SortSpec {
  /** The column or expression to order by (never built from request text). */
  by: SQL | AnyColumn;
  /** The response field it orders: a COST field makes the key GM-only. */
  field: string;
  dir: SortDir;
}

/** The paging part of a list's query string. `pageSize` above the maximum is clamped, not refused. */
export function pageQuerySchema<K extends string>(sortKeys: readonly [K, ...K[]]) {
  return {
    page: z.coerce.number().int().min(1).max(1_000_000).optional(),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .transform((n) => Math.min(n, PAGE_SIZE_MAX))
      .optional(),
    sort: z.enum(sortKeys).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    asOfId: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  };
}

export interface PageRequest<K extends string> {
  page?: number;
  pageSize?: number;
  sort?: K;
  dir?: SortDir;
  asOfId?: number;
}

export interface PagedList<K extends string, R> {
  sorts: Record<K, SortSpec>;
  defaultSort: K;
  /** The table's unique id: the tiebreaker and the snapshot. */
  id: AnyColumn;
  /** The list's filters (branch scope included). */
  where: SQL[];
  /** The highest id of the table (the snapshot, when the request has none). */
  maxId: () => Promise<number>;
  count: (where: SQL | undefined) => Promise<number>;
  rows: (q: { where: SQL | undefined; orderBy: SQL[]; limit: number; offset: number }) => Promise<R[]>;
  /** Sums over the whole filtered result (the table footer), when the list shows totals. */
  totals?: (where: SQL | undefined) => Promise<Record<string, number>>;
}

/** The sort the caller asked for, refused when it would order by a cost they may not see. */
export function resolveSort<K extends string>(actor: Actor, sorts: Record<K, SortSpec>, key: K, dir?: SortDir) {
  const spec = sorts[key];
  if (COST_RESPONSE_FIELDS.has(spec.field) && !actor.permissions.has('profit.view')) {
    throw forbidden('You cannot sort this list by cost');
  }
  return { key, spec, dir: dir ?? spec.dir };
}

export const orderFor = (by: SQL | AnyColumn, dir: SortDir) => (dir === 'asc' ? asc(by) : desc(by));

export async function runPaged<K extends string, R>(actor: Actor, req: PageRequest<K>, list: PagedList<K, R>): Promise<Page<R>> {
  const sort = resolveSort(actor, list.sorts, req.sort ?? list.defaultSort, req.dir);
  const size = Math.min(req.pageSize ?? PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const number = req.page ?? 1;
  const asOfId = req.asOfId ?? (await list.maxId());
  const where = and(...list.where, lte(list.id, asOfId));
  // The count, the page and the totals are independent reads of the same snapshot: run together, a search over every
  // row costs one scan's time instead of three in a row (BE-7 perf). PGlite serialises them on its one connection.
  const [total, rows, totals] = await Promise.all([
    list.count(where),
    list.rows({ where, orderBy: [orderFor(sort.spec.by, sort.dir), orderFor(list.id, sort.dir)], limit: size, offset: (number - 1) * size }),
    list.totals ? list.totals(where) : Promise.resolve(undefined),
  ]);
  const page = { number, size, pages: Math.max(1, Math.ceil(total / size)), sort: sort.key, dir: sort.dir, asOfId };
  return totals ? { rows, total, page, totals } : { rows, total, page };
}

/** `SELECT coalesce(max(id), 0)` for the snapshot. */
export const maxIdOf = (id: AnyColumn) => sql<number>`coalesce(max(${id}), 0)`;

/** `coalesce(sum(expr), 0)` as a number. */
export const sumOf = (expr: SQL | AnyColumn) => sql<number>`coalesce(sum(${expr}), 0)`.mapWith(Number);
