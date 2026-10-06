import { sql, type AnyColumn } from 'drizzle-orm';

/** Normalise `db.execute()` results across node-postgres and PGlite. */
export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export const num = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * A display name with the English name optional (CAT-0): the English name when it is not blank,
 * otherwise the Arabic one. For single-string outputs (report columns, CSV, list fields).
 */
export const nameOrAr = (en: AnyColumn, ar: AnyColumn) => sql<string>`coalesce(nullif(btrim(${en}), ''), ${ar})`;
