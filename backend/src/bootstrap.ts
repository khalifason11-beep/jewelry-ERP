import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '@jerp/database';
import type { Ctx } from './core/context';
import { rows } from './core/sql';
import { createHasadIntegration } from './integrations';
import { POSTGRES_CACHE_TTL_MS, SettingsStore } from './modules/settings/store';

export function createContext(handle: DatabaseHandle): Ctx {
  const settings = new SettingsStore(handle.db, handle.driver === 'postgres' ? POSTGRES_CACHE_TTL_MS : Number.POSITIVE_INFINITY);
  const { hasad, mock } = createHasadIntegration(handle.db, settings);
  return { handle, db: handle.db, hasad, mockHasad: mock, settings };
}

export async function openDatabase(opts: { url?: string; dataDir?: string }) {
  const handle = await createDatabase(opts);
  await handle.migrate();
  return handle;
}

export async function isEmpty(ctx: Ctx): Promise<boolean> {
  const r = await ctx.db.execute(sql`SELECT count(*) AS n FROM users`);
  return Number(rows<{ n: number }>(r)[0].n) === 0;
}
