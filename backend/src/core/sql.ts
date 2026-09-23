/** Normalise `db.execute()` results across node-postgres and PGlite. */
export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export const num = (v: unknown): number => (v == null ? 0 : Number(v));
