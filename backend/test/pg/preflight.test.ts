// SAFE-1: the server preflight (scripts/server/preflight.mjs) reports PASS/WARN/FAIL per check with the fix, exits 1 on
// any FAIL, and never writes: its connections are read-only, and an empty database stays empty. Real PostgreSQL only.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '@jerp/database';
import { readOnlyUrl } from '../../src/preflight';
import { dropTestDatabase, openTestDatabase, PG_MODE } from '../helpers';

const ROOT = path.resolve(__dirname, '../../..');
let base: DatabaseHandle & { url?: string };
let emptyUrl: string;
let emptyName: string;

const PROD = (over: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, APP_MODE: 'production', DATABASE_URL: base.url, APP_ORIGIN: 'https://erp.example.com', TRUST_PROXY: '1', STRICT_DB_ROLES: 'false', MIGRATION_DATABASE_URL: undefined, BACKUP_DIR: undefined, VITEST: undefined, ...over };
  for (const k of Object.keys(env)) if (env[k] === undefined || k.startsWith('VITEST')) delete env[k];
  return env as NodeJS.ProcessEnv;
};
const preflight = (env: NodeJS.ProcessEnv) => {
  const r = spawnSync(process.execPath, ['scripts/server/preflight.mjs'], { cwd: ROOT, env, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const line = (out: string, name: string) => out.split('\n').find((l) => new RegExp(`^(PASS|WARN|FAIL|SKIP)\\s+${name}\\s`).test(l)) ?? `(no "${name}" line)\n${out}`;

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  base = await openTestDatabase();
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  emptyName = `jerp_t_pre_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${emptyName}`);
  await admin.end();
  const u = new URL(base.url!);
  u.pathname = `/${emptyName}`;
  emptyUrl = u.toString();
});
afterAll(async () => {
  await base?.close();
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await dropTestDatabase(admin, emptyName);
  await admin.end();
});

describe('preflight', () => {
  it('a migrated database: every database check passes; one role is a WARN, not a FAIL, with STRICT_DB_ROLES=false', () => {
    const { out } = preflight(PROD());
    expect(line(out, 'node')).toMatch(/^PASS/);
    expect(line(out, 'app mode')).toMatch(/^PASS/);
    expect(line(out, 'config')).toMatch(/^PASS .*production configuration accepted/);
    expect(line(out, 'database')).toMatch(/^PASS .*connects as .*PostgreSQL/);
    expect(line(out, 'clock')).toMatch(/^PASS/);
    expect(line(out, 'migrations')).toMatch(/^PASS\s+migrations\s+(\d+) of \1 applied/);
    expect(line(out, 'runtime role')).toMatch(/^WARN .*could alter/);
    expect(line(out, 'append-only')).toMatch(/^PASS/);
    expect(line(out, 'backups')).toMatch(/^WARN .*BACKUP_NEVER/);
    expect(out).toMatch(/fix: Separate owner and runtime roles/);
    expect(out).toMatch(/^preflight: \d+ PASS, \d+ WARN, \d+ FAIL, 0 SKIP/m);
  }, 120_000);

  it('the same role with STRICT_DB_ROLES=true is a FAIL (the server would refuse), and the exit code is 1', () => {
    const { code, out } = preflight(PROD({ STRICT_DB_ROLES: 'true', MIGRATION_DATABASE_URL: base.url }));
    expect(line(out, 'database \\(owner\\)')).toMatch(/^PASS/);
    expect(line(out, 'runtime role')).toMatch(/^FAIL .*refuses to start/);
    expect(code).toBe(1);
    expect(out).toMatch(/NOT READY: fix every FAIL/);
  }, 120_000);

  it('missing decisions and a missing APP_MODE are reported with their fix', () => {
    const missing = preflight(PROD({ TRUST_PROXY: undefined, STRICT_DB_ROLES: undefined }));
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/^FAIL\s+config\s+TRUST_PROXY must be set/m);
    expect(missing.out).toMatch(/^FAIL\s+config\s+STRICT_DB_ROLES must be set/m);
    const noMode = preflight(PROD({ APP_MODE: undefined }));
    expect(noMode.code).toBe(1);
    expect(line(noMode.out, 'app mode')).toMatch(/^FAIL .*APP_MODE is not set/);
    expect(noMode.out).toMatch(/fix: Set APP_MODE=production/);
  }, 120_000);

  it('an unreachable database is a FAIL with the fix, not a crash', () => {
    const { code, out } = preflight(PROD({ DATABASE_URL: 'postgresql://jerp_app:Unused-Pw-2026@127.0.0.1:1/jewelry_erp' }));
    expect(code).toBe(1);
    expect(line(out, 'database')).toMatch(/^FAIL .*DATABASE_URL/);
    expect(out).toMatch(/fix: Check that PostgreSQL runs/);
  }, 120_000);

  it('read-only: an empty database reports the pending migrations and stays empty', async () => {
    const { out } = preflight(PROD({ DATABASE_URL: emptyUrl }));
    expect(line(out, 'migrations')).toMatch(/^WARN\s+migrations\s+0 of \d+ applied/);
    expect(line(out, 'append-only')).toMatch(/^SKIP/);
    const h = await createDatabase({ url: emptyUrl });
    try {
      const r = (await h.db.execute(sql`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`)) as unknown as { rows: { n: number }[] };
      expect(r.rows[0].n).toBe(0);
      expect(((await h.db.execute(sql`SELECT to_regnamespace('drizzle') AS s`)) as unknown as { rows: { s: unknown }[] }).rows[0].s).toBeNull();
    } finally {
      await h.close();
    }
  }, 120_000);

  it('its connections refuse writes (enforced by PostgreSQL)', async () => {
    const h = await createDatabase({ url: readOnlyUrl(base.url!) });
    try {
      const err = await h.db.execute(sql`CREATE TABLE preflight_must_not_exist (x int)`).then(() => null, (e: Error & { cause?: { code?: string; message?: string } }) => e.cause ?? e);
      expect(err).toMatchObject({ code: '25006' }); // read_only_sql_transaction
      expect(String((err as Error).message)).toMatch(/read-only transaction/);
    } finally {
      await h.close();
    }
  });
});
