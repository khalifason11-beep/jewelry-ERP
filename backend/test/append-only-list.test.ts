// CLN-1: the start-up list of append-only tables (APPEND_ONLY_TABLES, used by the runtime-role check at start-up and by
// the restore drill) must equal what the migrations actually lock. Both projects. The expected set is read twice, from
// two independent sources: the migrated database (every table whose jerp_forbid_modification trigger refuses UPDATE;
// ledger_accounts only refuses DELETE, its rows are not append-only) and the
// migration files (every table passed to jerp_lock_append_only). A table added to the migrations but not to the list
// (as gm_funding_events was, CSH-2) fails here.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { APPEND_ONLY_TABLES } from '../src/core/startup';
import { rows } from '../src/core/sql';
import { openTestDatabase } from './helpers';

/** What the list lacks and what it has too much, compared with the expected tables. */
export function listDrift(list: readonly string[], expected: readonly string[]): { missing: string[]; extra: string[] } {
  const have = new Set(list);
  const want = new Set(expected);
  return { missing: [...want].filter((x) => !have.has(x)).sort(), extra: [...have].filter((x) => !want.has(x)).sort() };
}

const MIGRATIONS = path.resolve(__dirname, '../../database/migrations');
const lockedByMigrations = () => {
  const text = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n');
  return [...new Set([...text.matchAll(/jerp_lock_append_only\('([a-z_]+)'\)/g)].map((m) => m[1]))].sort();
};

let handle: DatabaseHandle;
beforeAll(async () => {
  handle = await openTestDatabase();
});
afterAll(async () => handle?.close());

describe('APPEND_ONLY_TABLES equals what the migrations lock', () => {
  it('every table whose jerp_forbid_modification trigger refuses UPDATE in the migrated database is in the list, and nothing else', async () => {
    const res = await handle.db.execute(sql`
      SELECT DISTINCT c.relname AS "table"
      FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE p.proname = 'jerp_forbid_modification' AND NOT tg.tgisinternal AND (tg.tgtype::int & 16) <> 0`);
    const triggered = rows<{ table: string }>(res).map((r) => r.table).sort();
    expect(triggered.length).toBeGreaterThan(10);
    expect(listDrift(APPEND_ONLY_TABLES, triggered)).toEqual({ missing: [], extra: [] });
  });

  it('every table the migration files pass to jerp_lock_append_only is in the list, and nothing else', () => {
    expect(listDrift(APPEND_ONLY_TABLES, lockedByMigrations())).toEqual({ missing: [], extra: [] });
  });

  it('the comparison catches a table left out of the list (the CSH-2 gap)', () => {
    const without = APPEND_ONLY_TABLES.filter((x) => x !== 'gm_funding_events');
    expect(listDrift(without, lockedByMigrations())).toEqual({ missing: ['gm_funding_events'], extra: [] });
  });
});
