// Production start-up checks (security item 2, docs/decisions.md D-1a-10).
// The server refuses to start in production when any check fails; demo mode only warns.

import { inArray, sql } from 'drizzle-orm';
import { t, type DB, type Executor } from '@jerp/database';
import { rows } from './sql';
import type { Config } from '../config';
import { verifyPassword } from '../auth/password';

const DEFAULT_DB_PASSWORDS = new Set(['', 'postgres', 'password', 'admin', 'root', 'changeme', 'secret', '123456', 'pass', 'test']);

/** Configuration problems that make a production start unsafe (pure; unit-tested). */
export function productionConfigProblems(cfg: Config): string[] {
  if (!cfg.production) return [];
  const problems: string[] = [];
  const checkUrl = (name: string, url: string) => {
    let password = '';
    try {
      password = decodeURIComponent(new URL(url).password);
    } catch {
      problems.push(`${name} is not a valid URL.`);
    }
    if (DEFAULT_DB_PASSWORDS.has(password.toLowerCase())) problems.push(`${name} uses an empty or well-known default password.`);
  };
  if (!cfg.databaseUrl) problems.push('DATABASE_URL is required in production (embedded PGlite is not allowed).');
  else checkUrl('DATABASE_URL', cfg.databaseUrl);
  if (cfg.migrationDatabaseUrl) checkUrl('MIGRATION_DATABASE_URL', cfg.migrationDatabaseUrl);
  if (!cfg.appOrigin) problems.push('APP_ORIGIN is required in production (e.g. https://erp.example.com).');
  else if (!/^https:\/\/[^/]+$/.test(cfg.appOrigin)) problems.push('APP_ORIGIN must be an https:// origin without a path.');
  if (!cfg.cookieSecure) problems.push('COOKIE_SECURE must not be false in production.');
  problems.push(...webauthnConfigProblems(cfg));
  return problems;
}

/**
 * Passkey relying party (D-2fa-2): the RP ID must be APP_ORIGIN's host or a registrable suffix of it,
 * otherwise no browser would accept the passkeys; initial setting values must be valid.
 */
export function webauthnConfigProblems(cfg: Config): string[] {
  const problems: string[] = [];
  if (cfg.webauthnUvInitial && !['required', 'preferred'].includes(cfg.webauthnUvInitial)) problems.push('WEBAUTHN_UV_INITIAL must be "required" or "preferred".');
  if (cfg.twoFactorRolesInitial) {
    for (const r of cfg.twoFactorRolesInitial.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!['GENERAL_MANAGER', 'BRANCH_MANAGER'].includes(r)) problems.push(`TWO_FACTOR_REQUIRED_ROLES_INITIAL: unknown role "${r}".`);
    }
  }
  if (!cfg.production) return problems;
  if (!cfg.appOrigin || !/^https:\/\//.test(cfg.appOrigin)) return problems; // already reported above
  const host = new URL(cfg.appOrigin).hostname.toLowerCase();
  const rp = (cfg.webauthnRpId ?? '').toLowerCase();
  if (!rp) problems.push('WEBAUTHN_RP_ID could not be derived from APP_ORIGIN.');
  else if (!(host === rp || host.endsWith(`.${rp}`))) problems.push(`WEBAUTHN_RP_ID "${rp}" is not the host of APP_ORIGIN or a parent domain of it ("${host}").`);
  else if (!rp.includes('.') && rp !== 'localhost') problems.push(`WEBAUTHN_RP_ID "${rp}" is not a registrable domain.`);
  return problems;
}

/**
 * The demo accounts and passwords that earlier versions published on the login page (REM-3 removed the
 * demo data, but a database created by an older version may still contain them). Production refuses
 * to start while any of them still accepts its published password.
 */
const PUBLISHED_DEMO_PASSWORDS = { GENERAL_MANAGER: 'demo-gm-2026', BRANCH_MANAGER: 'demo-bm-2026', CASHIER: 'demo-cashier-2026' } as const;
export const PUBLISHED_DEMO_ACCOUNTS: readonly { username: string; role: keyof typeof PUBLISHED_DEMO_PASSWORDS }[] = [
  { username: 'general.manager', role: 'GENERAL_MANAGER' },
  ...['kh', 'omd', 'bhr', 'pzu'].map((b) => ({ username: `branch.manager.${b}`, role: 'BRANCH_MANAGER' as const })),
  ...['kh.01', 'kh.02', 'omd.01', 'bhr.01', 'pzu.01'].map((b) => ({ username: `cashier.${b}`, role: 'CASHIER' as const })),
];

/** Accounts that still accept a published demo password (must be none in production). */
export async function demoCredentialsInUse(db: DB): Promise<string[]> {
  const rows = await db
    .select({ username: t.users.username, passwordHash: t.users.passwordHash, status: t.users.status })
    .from(t.users)
    .where(inArray(t.users.username, PUBLISHED_DEMO_ACCOUNTS.map((u) => u.username)));
  const found: string[] = [];
  for (const r of rows) {
    const role = PUBLISHED_DEMO_ACCOUNTS.find((u) => u.username === r.username)!.role;
    if (r.status === 'ACTIVE' && (await verifyPassword(PUBLISHED_DEMO_PASSWORDS[role], r.passwordHash))) found.push(r.username);
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

/** Tables whose rows may never be changed or removed (triggers + privileges, D-2a-4). */
export const APPEND_ONLY_TABLES = ['audit_logs', 'inventory_movements', 'item_status_history', 'gold_rates', 'settings_history', 'ledger_entries', 'cash_counts', 'scrap_rates', 'scrap_purchases', 'scrap_weight_entries', 'supplier_settlements', 'hasad_receivable_settlements', 'backup_runs'] as const;

export interface RoleProblem {
  table: string;
  owns: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
}

/**
 * What the CONNECTED (runtime) role could do to the append-only tables (D-2a-13). A role that owns a
 * table can drop its triggers or grant itself privileges back; a superuser bypasses privileges.
 * Returns one entry per table the role could alter, and whether the role is a superuser.
 */
export async function runtimeRoleProblems(exec: Executor, tables: readonly string[] = APPEND_ONLY_TABLES): Promise<{ role: string; superuser: boolean; tables: RoleProblem[] }> {
  const res = await exec.execute(sql`
    SELECT c.relname AS "table",
           pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
           has_table_privilege(c.oid, 'UPDATE') AS "update",
           has_table_privilege(c.oid, 'DELETE') AS "delete",
           has_table_privilege(c.oid, 'TRUNCATE') AS "truncate"
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN (${sql.join(tables.map((x) => sql`${x}`), sql`, `)})
    ORDER BY 1`);
  const [me] = rows<{ role: string; superuser: boolean }>(await exec.execute(sql`SELECT current_user AS role, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`));
  const list = rows<RoleProblem>(res).filter((r) => r.owns || r.update || r.delete || r.truncate);
  return { role: me.role, superuser: me.superuser, tables: list };
}
