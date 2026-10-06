import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '@jerp/database';
import type { Ctx } from './core/context';
import { rows } from './core/sql';
import { POSTGRES_CACHE_TTL_MS, SettingsStore } from './modules/settings/store';

export function createContext(handle: DatabaseHandle): Ctx {
  const settings = new SettingsStore(handle.db, handle.driver === 'postgres' ? POSTGRES_CACHE_TTL_MS : Number.POSITIVE_INFINITY);
  return { handle, db: handle.db, settings };
}

/**
 * Open the application database, migrated. With `migrationUrl` (MIGRATION_DATABASE_URL), the
 * migrations run over a separate, short-lived connection as the owner role, and the returned
 * handle uses `url` (the runtime role) — D-2a-13.
 */
export async function openDatabase(opts: { url?: string; dataDir?: string; migrationUrl?: string }) {
  if (opts.migrationUrl && opts.url) {
    await runMigrations({ url: opts.migrationUrl });
    return createDatabase({ url: opts.url });
  }
  const handle = await createDatabase(opts);
  await handle.migrate();
  return handle;
}

/** Run pending migrations and close the connection (npm run migrate, start-up). */
export async function runMigrations(opts: { url?: string; dataDir?: string }) {
  const owner = await createDatabase(opts);
  try {
    await owner.migrate();
  } finally {
    await owner.close();
  }
}

export async function isEmpty(ctx: Ctx): Promise<boolean> {
  const r = await ctx.db.execute(sql`SELECT count(*) AS n FROM users`);
  return Number(rows<{ n: number }>(r)[0].n) === 0;
}
