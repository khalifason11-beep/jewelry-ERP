// Production start-up checks (security item 2, docs/decisions.md D-1a-10).
// The server refuses to start in production when any check fails; demo mode only warns.

import { inArray, sql } from 'drizzle-orm';
import { t, type DB, type Executor } from '@jerp/database';
import { rows } from './sql';
import type { Config } from '../config';
import { verifyPassword } from '../auth/password';
import { DEMO_PASSWORDS, USERS } from '../seed/catalog';

const DEFAULT_DB_PASSWORDS = new Set(['', 'postgres', 'password', 'admin', 'root', 'changeme', 'secret', '123456', 'pass', 'test']);

/** Configuration problems that make a production start unsafe (pure; unit-tested). */
export function productionConfigProblems(cfg: Config): string[] {
  if (!cfg.production) return [];
  const problems: string[] = [];
  if (!cfg.databaseUrl) {
    problems.push('DATABASE_URL is required in production (embedded PGlite is not allowed).');
  } else {
    let password = '';
    try {
      password = decodeURIComponent(new URL(cfg.databaseUrl).password);
    } catch {
      problems.push('DATABASE_URL is not a valid URL.');
    }
    if (DEFAULT_DB_PASSWORDS.has(password.toLowerCase())) problems.push('DATABASE_URL uses an empty or well-known default password.');
  }
  if (!cfg.appOrigin) problems.push('APP_ORIGIN is required in production (e.g. https://erp.example.com).');
  else if (!/^https:\/\/[^/]+$/.test(cfg.appOrigin)) problems.push('APP_ORIGIN must be an https:// origin without a path.');
  if (!cfg.cookieSecure) problems.push('COOKIE_SECURE must not be false in production.');
  return problems;
}

/** Demo accounts that still accept their published demo password (must be none in production). */
export async function demoCredentialsInUse(db: DB): Promise<string[]> {
  const rows = await db
    .select({ username: t.users.username, passwordHash: t.users.passwordHash, status: t.users.status })
    .from(t.users)
    .where(inArray(t.users.username, USERS.map((u) => u.username)));
  const found: string[] = [];
  for (const r of rows) {
    const role = USERS.find((u) => u.username === r.username)!.role;
    if (r.status === 'ACTIVE' && (await verifyPassword(DEMO_PASSWORDS[role], r.passwordHash))) found.push(r.username);
  }
  return found;
}

/**
 * Integrity constraints that migration 0004 had to leave NOT VALID because existing rows violate
 * them (they are still enforced for every new or changed row). Reported at start-up so the
 * operator can correct the old rows and validate them (docs/decisions.md D-2a-2).
 */
export async function unvalidatedConstraints(exec: Executor): Promise<{ table: string; name: string }[]> {
  const res = await exec.execute(sql`SELECT conrelid::regclass::text AS "table", conname AS name FROM pg_constraint
                                     WHERE contype = 'c' AND conname LIKE 'ck\_%' AND NOT convalidated ORDER BY 1, 2`);
  return rows<{ table: string; name: string }>(res);
}
