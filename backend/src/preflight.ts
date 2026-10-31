// Server preflight (SAFE-1): the checks behind `node scripts/server/preflight.mjs`. READ-ONLY: every database connection
// is opened with default_transaction_read_only=on, nothing is migrated, created or written. Each check reports PASS,
// WARN, FAIL or SKIP with the fix; the launcher prints them and exits 1 on any FAIL. It reuses the server's own checks
// (startup.ts, readiness.ts, backups/status.ts), so a preflight PASS means the server's start-up checks pass too.

import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '@jerp/database';
import { loadConfig, type Config } from './config';
import { createContext } from './bootstrap';
import { rows } from './core/sql';
import { productionConfigProblems, runtimeRoleProblems } from './core/startup';
import { expectedMigrations, unprotectedAppendOnlyTables } from './core/readiness';
import { backupHealth } from './modules/backups/status';

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const MIN_PG = 160000;
const MAX_CLOCK_SKEW_MS = 5_000;
const GiB = 1024 ** 3;

/** The URL with every transaction read-only (enforced by PostgreSQL, not by this code). */
export function readOnlyUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set('options', '-c default_transaction_read_only=on');
  return u.toString();
}

const userOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).username) || '(default user)';
  } catch {
    return '(invalid URL)';
  }
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function connect(url: string): Promise<DatabaseHandle> {
  const h = await createDatabase({ url: readOnlyUrl(url), pool: { max: 1, statementTimeoutMs: 10_000, idleInTxTimeoutMs: 10_000, connectTimeoutMs: 5_000, idleTimeoutMs: 1_000 } });
  try {
    await h.db.execute(sql`SELECT 1`);
    return h;
  } catch (e) {
    await h.close().catch(() => undefined);
    throw e;
  }
}

function diskCheck(name: string, dir: string): Check {
  try {
    const s = fs.statfsSync(dir);
    const free = s.bavail * s.bsize;
    const gb = (free / GiB).toFixed(1);
    if (free < 1 * GiB) return { name, status: 'FAIL', detail: `${gb} GiB free on ${dir}`, fix: 'Free disk space (old backups, logs, npm cache) or grow the disk: at least 1 GiB, better 5 GiB.' };
    if (free < 5 * GiB) return { name, status: 'WARN', detail: `${gb} GiB free on ${dir} (less than 5 GiB)`, fix: 'Plan more disk space before the backups fill it.' };
    return { name, status: 'PASS', detail: `${gb} GiB free on ${dir}` };
  } catch (e) {
    return { name, status: 'FAIL', detail: `${dir}: ${message(e)}`, fix: 'Create the directory or correct the path.' };
  }
}

/** Every check after APP_MODE (the launcher checks Node and APP_MODE before this module is loaded). */
export async function serverChecks(env: NodeJS.ProcessEnv, now = () => Date.now()): Promise<Check[]> {
  const out: Check[] = [];
  let cfg: Config;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    return [{ name: 'config', status: 'FAIL', detail: message(e), fix: 'Correct the variable in the environment file (docs/DEPLOYMENT.md section 2).' }];
  }

  // 1. The server's own production refusals.
  const problems = productionConfigProblems(cfg);
  if (problems.length) for (const p of problems) out.push({ name: 'config', status: 'FAIL', detail: p, fix: 'Set it in the environment file (docs/DEPLOYMENT.md section 2, .env.example).' });
  else out.push({ name: 'config', status: 'PASS', detail: `production configuration accepted (APP_ORIGIN ${cfg.appOrigin}, TRUST_PROXY ${env.TRUST_PROXY}, STRICT_DB_ROLES ${env.STRICT_DB_ROLES})` });

  // 2. The built frontend.
  const index = path.join(cfg.frontendDist, 'index.html');
  out.push(fs.existsSync(index) ? { name: 'frontend', status: 'PASS', detail: `built (${path.relative(cfg.rootDir, index)})` } : { name: 'frontend', status: 'FAIL', detail: 'frontend/dist/index.html is missing', fix: 'Run `npm run build`.' });

  // 3. Disk space where the app and the backups live.
  out.push(diskCheck('disk', cfg.rootDir));
  if (env.BACKUP_DIR) out.push(diskCheck('disk (backups)', env.BACKUP_DIR));

  // 4. The owner role (migrations), when separate.
  if (cfg.migrationDatabaseUrl) {
    try {
      const h = await connect(cfg.migrationDatabaseUrl);
      await h.close();
      out.push({ name: 'database (owner)', status: 'PASS', detail: `MIGRATION_DATABASE_URL connects as ${userOf(cfg.migrationDatabaseUrl)}` });
    } catch (e) {
      out.push({ name: 'database (owner)', status: 'FAIL', detail: `MIGRATION_DATABASE_URL: ${message(e)}`, fix: 'Check the host, password and that the owner role may CONNECT (docs/runbooks/first-deploy.md step 3).' });
    }
  }

  // 5. The runtime role and everything read through it.
  if (!cfg.databaseUrl) {
    out.push({ name: 'database', status: 'SKIP', detail: 'DATABASE_URL is not set (reported above)' });
    return out;
  }
  let h: DatabaseHandle;
  try {
    h = await connect(cfg.databaseUrl);
  } catch (e) {
    out.push({ name: 'database', status: 'FAIL', detail: `DATABASE_URL: ${message(e)}`, fix: 'Check that PostgreSQL runs, the host and password, and that the runtime role may CONNECT.' });
    return out;
  }
  try {
    const [info] = rows<{ v: string; n: string; at: Date }>(await h.db.execute(sql`SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n, now() AS at`));
    const pgOk = Number(info.n) >= MIN_PG;
    out.push({ name: 'database', status: pgOk ? 'PASS' : 'WARN', detail: `connects as ${userOf(cfg.databaseUrl)}, PostgreSQL ${info.v}`, ...(pgOk ? {} : { fix: 'PostgreSQL 16 is what the project is tested on.' }) });

    const skew = Math.abs(new Date(info.at).getTime() - now());
    out.push(skew <= MAX_CLOCK_SKEW_MS
      ? { name: 'clock', status: 'PASS', detail: `app and database clocks agree (${skew} ms apart); the app runs in UTC` }
      : { name: 'clock', status: 'FAIL', detail: `app and database clocks differ by ${Math.round(skew / 1000)} s`, fix: 'Turn on time synchronisation on both machines (e.g. `timedatectl set-ntp true`).' });

    // DOC-2: the runtime role reads the migration history (here and in /api/ready). Without USAGE on schema drizzle or
    // SELECT on its table, PostgreSQL only says "permission denied for schema drizzle"; name the two grants instead.
    // Read from the catalogs, which need no privilege on the schema itself.
    const [acl] = rows<{ schema: boolean; usage: boolean; table: boolean; select: boolean }>(
      await h.db.execute(sql`
        SELECT n.oid IS NOT NULL AS schema,
               coalesce(has_schema_privilege(n.oid, 'USAGE'), false) AS usage,
               c.oid IS NOT NULL AS table,
               coalesce(has_table_privilege(c.oid, 'SELECT'), false) AS select
        FROM (SELECT 1) one
        LEFT JOIN pg_namespace n ON n.nspname = 'drizzle'
        LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = '__drizzle_migrations'`),
    );
    if (acl.schema && (!acl.usage || (acl.table && !acl.select))) {
      const role = userOf(cfg.databaseUrl);
      const missing = [!acl.usage ? 'USAGE on schema drizzle' : null, acl.table && !acl.select ? 'SELECT on drizzle.__drizzle_migrations' : null].filter(Boolean).join(' and ');
      out.push({
        name: 'migrations',
        status: 'FAIL',
        detail: `${role} cannot read the migration history: it lacks ${missing} (the server's readiness check reads it too)`,
        fix: `As the owner role: GRANT USAGE ON SCHEMA drizzle TO ${role}; GRANT SELECT ON drizzle.__drizzle_migrations TO ${role}; (docs/runbooks/go-live-reset.md step 3 sets this up on a new database)`,
      });
      out.push({ name: 'runtime role', status: 'SKIP', detail: 'needs the migration history' });
      out.push({ name: 'append-only', status: 'SKIP', detail: 'needs the migration history' });
      out.push({ name: 'backups', status: 'SKIP', detail: 'needs the migration history' });
      return out;
    }

    const [{ present }] = rows<{ present: boolean }>(await h.db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`));
    const applied = present ? Number(rows<{ n: string }>(await h.db.execute(sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`))[0].n) : 0;
    const expected = expectedMigrations();
    if (applied === expected) out.push({ name: 'migrations', status: 'PASS', detail: `${applied} of ${expected} applied` });
    else if (applied < expected) out.push({ name: 'migrations', status: 'WARN', detail: `${applied} of ${expected} applied: ${expected - applied} will be applied by \`npm run migrate\` or at start-up`, fix: 'Expected before a first start or an update; run `npm run migrate` (owner role) after the backup.' });
    else out.push({ name: 'migrations', status: 'FAIL', detail: `the database has ${applied} migrations, this code knows ${expected}: the code is older than the database`, fix: 'Deploy the release that applied them, or restore the pre-update backup (docs/runbooks/rollback.md B).' });

    if (applied !== expected) {
      out.push({ name: 'runtime role', status: 'SKIP', detail: 'needs every migration applied' });
      out.push({ name: 'append-only', status: 'SKIP', detail: 'needs every migration applied' });
      out.push({ name: 'backups', status: 'SKIP', detail: 'needs every migration applied' });
      return out;
    }

    const role = await runtimeRoleProblems(h.db);
    if (!role.superuser && role.tables.length === 0) out.push({ name: 'runtime role', status: 'PASS', detail: `${role.role} cannot alter the audit log or the ledgers` });
    else {
      const what = role.superuser ? `${role.role} is a superuser` : `${role.role} could alter ${role.tables.length} append-only table(s): ${role.tables.map((x) => x.table).join(', ')}`;
      out.push({ name: 'runtime role', status: cfg.strictDbRoles ? 'FAIL' : 'WARN', detail: what + (cfg.strictDbRoles ? ' (the server refuses to start with STRICT_DB_ROLES=true)' : ''), fix: 'Separate owner and runtime roles (docs/DEPLOYMENT.md section 5), then STRICT_DB_ROLES=true.' });
    }

    const unprotected = await unprotectedAppendOnlyTables(h.db);
    out.push(unprotected.length === 0
      ? { name: 'append-only', status: 'PASS', detail: 'every append-only table has its enabled protection trigger' }
      : { name: 'append-only', status: 'FAIL', detail: `protection missing or disabled on: ${unprotected.join(', ')}`, fix: 'Do not start: re-enable the triggers as the owner (ALTER TABLE … ENABLE TRIGGER USER) and find out who disabled them.' });

    const backup = await backupHealth(createContext(h));
    const age = (x: number | null) => (x == null ? 'never' : `${x} h ago`);
    out.push(backup.status === 'OK'
      ? { name: 'backups', status: 'PASS', detail: `last backup ${age(backup.backupAgeHours)}, last restore drill ${age(backup.verifyAgeHours)}` }
      : { name: 'backups', status: 'WARN', detail: `${backup.reasons.join(', ')} (last backup ${age(backup.backupAgeHours)}, last restore drill ${age(backup.verifyAgeHours)})`, fix: 'Run `npm run backup`, and the restore drill on the drill machine (docs/runbooks/restore-drill.md).' });
  } catch (e) {
    out.push({ name: 'database', status: 'FAIL', detail: message(e), fix: 'Read the message; the database answered but a read failed.' });
  } finally {
    await h.close().catch(() => undefined);
  }
  return out;
}
