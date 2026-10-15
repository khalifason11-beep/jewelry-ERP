// Readiness (SAFE-1). /api/health says the process is up (liveness). /api/ready says it can serve: the database answers,
// every migration of this release is applied, and every append-only table still has its protecting trigger. A reverse
// proxy or uptime monitor sends traffic only while it is ready, and an update is checked with it after the restart.
// The public answer is the status only; what failed is written to the log, never sent.

import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { MIGRATIONS_DIR } from '@jerp/database';
import type { Ctx } from './context';
import { rows } from './sql';
import { APPEND_ONLY_TABLES } from './startup';

/** Number of migrations this release ships (the drizzle journal). */
export function expectedMigrations(dir = MIGRATIONS_DIR): number {
  return (JSON.parse(fs.readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;
}

const EXPECTED = expectedMigrations();
const TIMEOUT_MS = 3_000;

export async function readiness(ctx: Ctx): Promise<{ ready: boolean; problems: string[] }> {
  const problems: string[] = [];
  const check = async () => {
    await ctx.db.execute(sql`SELECT 1`);
    const applied = Number(rows<{ n: string }>(await ctx.db.execute(sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`))[0].n);
    if (applied !== EXPECTED) problems.push(`migrations applied: ${applied}, this release expects ${EXPECTED}`);
    const protectedTables = rows<{ t: string }>(
      await ctx.db.execute(sql`
        SELECT DISTINCT c.relname AS t FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
        WHERE p.proname = 'jerp_forbid_modification' AND NOT tg.tgisinternal AND tg.tgenabled <> 'D' AND (tg.tgtype::int & 16) <> 0`),
    ).map((r) => r.t);
    const missing = APPEND_ONLY_TABLES.filter((t) => !protectedTables.includes(t));
    if (missing.length) problems.push(`append-only protection missing or disabled on: ${missing.join(', ')}`);
  };
  try {
    await Promise.race([check(), new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${TIMEOUT_MS} ms`)), TIMEOUT_MS).unref())]);
  } catch (e) {
    problems.push(`database: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ready: problems.length === 0, problems };
}
