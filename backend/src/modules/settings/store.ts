import { desc, eq, sql } from 'drizzle-orm';
import { t, type DB, type Executor } from '@jerp/database';
import { DEFAULT_SETTINGS, KARATS, type SystemSettings } from '@jerp/shared';

const KEY = 'system';

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' ? deepMerge(b, v) : v;
  }
  return out as T;
}

/** Cached settings (DB is the source of truth; cache is invalidated on write). */
export class SettingsStore {
  private cache: SystemSettings | null = null;

  constructor(private readonly db: DB) {}

  async get(): Promise<SystemSettings> {
    if (this.cache) return this.cache;
    const [row] = await this.db.select().from(t.settings).where(eq(t.settings.key, KEY));
    this.cache = deepMerge(DEFAULT_SETTINGS, row?.value ?? {});
    return this.cache;
  }

  async update(exec: Executor, patch: Partial<SystemSettings>, userId: number | null): Promise<SystemSettings> {
    const next = deepMerge(await this.get(), patch);
    await exec
      .insert(t.settings)
      .values({ key: KEY, value: next, updatedBy: userId })
      .onConflictDoUpdate({ target: t.settings.key, set: { value: next, updatedAt: new Date(), updatedBy: userId } });
    this.cache = next;
    return next;
  }

  invalidate() {
    this.cache = null;
  }

  /** Current gold price per gram for every karat. */
  async goldRates(exec: Executor = this.db): Promise<Record<number, { pricePerGram: number; effectiveAt: Date }>> {
    const rowsAll = await exec
      .select()
      .from(t.goldRates)
      .orderBy(t.goldRates.karat, desc(t.goldRates.effectiveAt), desc(t.goldRates.id));
    const out: Record<number, { pricePerGram: number; effectiveAt: Date }> = {};
    for (const r of rowsAll) if (!out[r.karat]) out[r.karat] = { pricePerGram: r.pricePerGram, effectiveAt: r.effectiveAt };
    for (const k of KARATS) if (!out[k]) out[k] = { pricePerGram: 0, effectiveAt: new Date(0) };
    return out;
  }

  async goldRateHistory(exec: Executor = this.db, limit = 40) {
    return exec
      .select({
        id: t.goldRates.id,
        karat: t.goldRates.karat,
        pricePerGram: t.goldRates.pricePerGram,
        effectiveAt: t.goldRates.effectiveAt,
        setBy: sql<string | null>`(select full_name from users u where u.id = ${t.goldRates.setBy})`,
      })
      .from(t.goldRates)
      .orderBy(desc(t.goldRates.effectiveAt), desc(t.goldRates.id))
      .limit(limit);
  }
}
