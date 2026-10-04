// Settings persistence: one row per registry key (shared/src/settings.ts) + append-only history.
// Reads fall back to the registry default when a key is missing or its stored value no longer
// validates (logged), so a bad row can never break the application.

import { desc, eq, inArray, sql } from 'drizzle-orm';
import { t, type DB, type Executor } from '@jerp/database';
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  SETTINGS_REGISTRY,
  crossFieldProblem,
  flattenSettings,
  isSettingKey,
  settingValue,
  withSetting,
  type SettingKey,
  type SystemSettings,
} from '@jerp/shared';
import { badRequest, conflict, forbidden } from '../../core/errors';
import { log } from '../../core/logger';

/**
 * With real PostgreSQL (possibly several app instances) the cache expires after a few seconds so
 * instances converge quickly (M-13). Embedded PGlite is single-process and single-connection: its
 * cache only changes on write, so a read can never wait on a transaction of the same request.
 */
export const POSTGRES_CACHE_TTL_MS = 5_000;

export interface SettingMeta {
  version: number;
  updatedAt: Date | null;
  updatedBy: number | null;
}

export interface SettingChange {
  key: SettingKey;
  from: unknown;
  to: unknown;
  version: number;
}

export interface ApplyOptions {
  /** Who made the change (null id = system/CLI). */
  actor: { id: number | null; username: string };
  reason?: string;
  /** Optimistic concurrency: the versions the editor saw; a mismatch is a 409. */
  expectedVersions?: Partial<Record<string, number>>;
  /** Demo-only keys (mock Hasad) cannot be changed outside APP_MODE=demo. */
  allowDemoOnly?: boolean;
  /** Guarded keys (second-factor policy) are applied only by their dedicated step-up flow, the seed or the first start. */
  allowGuarded?: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A JSON value for a jsonb column; JSON `null` must not become SQL NULL. */
const jsonb = (v: unknown) => (v === null ? sql`'null'::jsonb` : (v as object));

export class SettingsStore {
  private cache: { values: SystemSettings; meta: Record<string, SettingMeta>; at: number } | null = null;

  constructor(
    private readonly db: DB,
    private readonly cacheTtlMs = Number.POSITIVE_INFINITY,
  ) {}

  private async load(exec: Executor) {
    const rows = await exec.select().from(t.settings).where(inArray(t.settings.key, SETTING_KEYS));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    let values = DEFAULT_SETTINGS;
    const meta: Record<string, SettingMeta> = {};
    for (const key of SETTING_KEYS) {
      const row = byKey.get(key);
      meta[key] = { version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
      if (!row) continue;
      const parsed = SETTINGS_REGISTRY[key].schema.safeParse(row.value);
      if (parsed.success) values = withSetting(values, key, parsed.data);
      else log.warn('stored setting is invalid; using the default', { key });
    }
    return { values, meta };
  }

  async get(): Promise<SystemSettings> {
    if (this.cache && Date.now() - this.cache.at < this.cacheTtlMs) return this.cache.values;
    const { values, meta } = await this.load(this.db);
    this.cache = { values, meta, at: Date.now() };
    return values;
  }

  async meta(): Promise<Record<string, SettingMeta>> {
    await this.get();
    return this.cache!.meta;
  }

  invalidate() {
    this.cache = null;
  }

  /**
   * Validate and apply dotted-key changes inside the caller's transaction: rows are locked,
   * versions bumped, and every real change is appended to `settings_history`.
   * Returns only the keys whose value actually changed.
   */
  async apply(exec: Executor, changes: Record<string, unknown>, opts: ApplyOptions): Promise<{ settings: SystemSettings; changed: SettingChange[] }> {
    const keys = Object.keys(changes);
    if (!keys.length) throw badRequest('Nothing to change');
    const parsed: Partial<Record<SettingKey, unknown>> = {};
    for (const key of keys) {
      if (!isSettingKey(key)) throw badRequest('Unknown setting: {key}', { key });
      const def = SETTINGS_REGISTRY[key] as { schema: typeof SETTINGS_REGISTRY[SettingKey]['schema']; demoOnly?: boolean; guarded?: boolean };
      if (def.demoOnly && !opts.allowDemoOnly) throw forbidden('This setting is only available in the demo');
      if (def.guarded && !opts.allowGuarded) throw forbidden('This setting is changed on the Security screen (password and passkey required)');
      const r = def.schema.safeParse(changes[key]);
      if (!r.success) throw badRequest('Invalid value for {field}', { field: key }, r.error.issues.map((i) => ({ path: [key, ...i.path].join('.'), code: i.code })));
      parsed[key] = r.data;
    }

    // Lock the affected rows, then validate the merged result (cross-field rules).
    await exec.select({ key: t.settings.key }).from(t.settings).where(inArray(t.settings.key, keys)).for('update');
    const current = await this.load(exec);
    let next = current.values;
    for (const [key, value] of Object.entries(parsed)) next = withSetting(next, key as SettingKey, value);
    const problem = crossFieldProblem(next);
    if (problem) throw badRequest('Invalid value for {field}', { field: problem.key });

    const changed: SettingChange[] = [];
    for (const [k, value] of Object.entries(parsed)) {
      const key = k as SettingKey;
      const from = settingValue(current.values, key);
      const meta = current.meta[key];
      const expected = opts.expectedVersions?.[key];
      if (expected !== undefined && expected !== meta.version) {
        throw conflict('Setting {key} was changed by someone else. Reload and try again.', { key });
      }
      if (same(from, value) && meta.version > 0) continue;
      const version = meta.version + 1;
      const stored = jsonb(value);
      await exec
        .insert(t.settings)
        .values({ key, value: stored, version, updatedBy: opts.actor.id, updatedAt: new Date() })
        .onConflictDoUpdate({ target: t.settings.key, set: { value: stored, version, updatedBy: opts.actor.id, updatedAt: new Date() } });
      await exec.insert(t.settingsHistory).values({
        key,
        oldValue: meta.version > 0 ? jsonb(from) : null,
        newValue: stored,
        version,
        actorId: opts.actor.id,
        actorUsername: opts.actor.username,
        reason: opts.reason?.trim() || null,
      });
      if (!same(from, value)) changed.push({ key, from, to: value, version });
    }
    this.invalidate();
    return { settings: next, changed };
  }

  /** Convenience for trusted code (seed, tests): nested patch → dotted changes. */
  async update(exec: Executor, patch: Partial<Record<keyof SystemSettings, Record<string, unknown>>>, userId: number | null) {
    const { settings } = await this.apply(exec, flattenSettings(patch), { actor: { id: userId, username: userId ? `user:${userId}` : 'system' }, allowDemoOnly: true });
    return settings;
  }

  /** Recent history of one key (newest first). */
  async history(exec: Executor, key: SettingKey, limit = 20) {
    return exec.select().from(t.settingsHistory).where(eq(t.settingsHistory.key, key)).orderBy(desc(t.settingsHistory.id)).limit(limit);
  }

  /** Current gold price per gram for every allowed karat. */
  async goldRates(exec: Executor = this.db): Promise<Record<number, { pricePerGram: number; effectiveAt: Date }>> {
    const { inventory } = await this.get();
    const rowsAll = await exec
      .select()
      .from(t.goldRates)
      .orderBy(t.goldRates.karat, desc(t.goldRates.effectiveAt), desc(t.goldRates.id));
    const out: Record<number, { pricePerGram: number; effectiveAt: Date }> = {};
    for (const r of rowsAll) if (!out[r.karat]) out[r.karat] = { pricePerGram: r.pricePerGram, effectiveAt: r.effectiveAt };
    for (const k of inventory.allowedKarats) if (!out[k]) out[k] = { pricePerGram: 0, effectiveAt: new Date(0) };
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
