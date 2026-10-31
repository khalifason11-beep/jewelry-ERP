// DOC-2: the go-live reset (scripts/server/go-live-reset.sql, docs/runbooks/go-live-reset.md) on real PostgreSQL 16 with
// the three production roles (owner, runtime, backup), run with psql exactly as the runbook says.
//   * a TRIAL database built as docs/runbooks/first-deploy.md builds it, migrated and full of trial data;
//   * the script REFUSES, changing nothing, without the second database name, with names that differ, for a database
//     whose General Manager is not the trial one it was told about, with a missing role, and for a system database;
//   * with every guard holding: the database is empty again; `migrate` as the owner; the preflight has no FAIL (the
//     runtime role PASS with STRICT_DB_ROLES=true, the migration history readable); the bootstrap command creates the
//     real General Manager; /api/ready answers 200 on the runtime role; nothing of the trial is left; the backup role
//     reads every table (pg_dump succeeds);
//   * run again on a database left empty by a reset that stopped after the drop, it finishes the job.
// The test role needs CREATEDB and CREATEROLE (not superuser); it becomes a member of the test owner role so it may set
// the owner's default privileges (production runs the script as the `postgres` superuser, which needs nothing more).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext, openDatabase } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import { runtimeRoleProblems } from '../../src/core/startup';
import { rows } from '../../src/core/sql';
import { seedWorld } from '../fixtures/world';
import { dropTestDatabase, PG_MODE } from '../helpers';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/server/go-live-reset.sql');
const base = process.env.TEST_DATABASE_URL!;
const tag = randomBytes(4).toString('hex');
const OWNER = `jerp_owner_${tag}`;
const RUNTIME = `jerp_app_${tag}`;
const BACKUP = `jerp_backup_${tag}`;
const DB = `jerp_golive_${tag}`;
const PW = `Pw-${randomBytes(8).toString('hex')}`;
const TRIAL_GM = 'general.manager'; // the fixture world's General Manager plays the trial one
const urlFor = (user: string | null, db = DB) => {
  const u = new URL(base);
  if (user) {
    u.username = user;
    u.password = PW;
  }
  u.pathname = `/${db}`;
  return u.toString();
};

async function adminQuery(q: string, db = new URL(base).pathname.slice(1) || 'postgres') {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: urlFor(null, db) });
  await c.connect();
  try {
    return await c.query(q);
  } finally {
    await c.end();
  }
}
const one = async <T>(url: string, q: string) => {
  const h = await createDatabase({ url });
  try {
    return rows<T>(await h.db.execute(sql.raw(q)))[0];
  } finally {
    await h.close();
  }
};

/** The runbook's command (step 3), with the given -v variables. */
function reset(vars: Record<string, string>) {
  const args = [base, '-X', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', SCRIPT];
  const r = spawnSync('psql', args, { encoding: 'utf8', timeout: 120_000 });
  if (r.error) throw r.error; // psql missing: the test fails, it never skips
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const OK = { db: DB, db_confirm: DB, trial_gm: TRIAL_GM, owner: OWNER, runtime: RUNTIME, backup: BACKUP };

const PROD = (over: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    APP_MODE: 'production',
    DATABASE_URL: urlFor(RUNTIME),
    MIGRATION_DATABASE_URL: urlFor(OWNER),
    APP_ORIGIN: 'https://erp.example.com',
    TRUST_PROXY: '1',
    STRICT_DB_ROLES: 'true',
    BACKUP_DIR: undefined,
    ...over,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined || k.startsWith('VITEST')) delete env[k];
  return env as NodeJS.ProcessEnv;
};
const tables = async () => Number((await one<{ n: string }>(urlFor(OWNER), `SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`)).n);
const trialUsers = async () => Number((await one<{ n: string }>(urlFor(OWNER), `SELECT count(*) AS n FROM users`)).n);

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  // The roles (first-deploy.md step 3), and the test role's membership of the owner (see the header).
  for (const r of [OWNER, RUNTIME]) await adminQuery(`CREATE ROLE ${r} LOGIN PASSWORD '${PW}'`);
  await adminQuery(`CREATE ROLE ${BACKUP} LOGIN PASSWORD '${PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await adminQuery(`GRANT ${OWNER} TO CURRENT_USER`);
  // The TRIAL database exactly as the first deployment built it.
  await adminQuery(`CREATE DATABASE ${DB}`);
  await adminQuery(`GRANT CONNECT, CREATE ON DATABASE ${DB} TO ${OWNER}`);
  await adminQuery(`GRANT CONNECT ON DATABASE ${DB} TO ${RUNTIME}, ${BACKUP}`);
  await adminQuery(`GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER}`, DB);
  await adminQuery(`GRANT USAGE ON SCHEMA public TO ${RUNTIME}`, DB);
  const owner = await createDatabase({ url: urlFor(OWNER) });
  for (const q of [
    `ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME}`,
    `ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME}`,
    `ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${RUNTIME}`,
  ])
    await owner.db.execute(sql.raw(q));
  await owner.close();
  const trial = await openDatabase({ url: urlFor(OWNER), migrationUrl: urlFor(OWNER) });
  await seedWorld(createContext(trial), new Date('2026-10-20T09:00:00Z'));
  await trial.close();
}, 300_000);

afterAll(async () => {
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await dropTestDatabase(admin, DB).catch(() => undefined);
  await admin.end();
  for (const r of [BACKUP, RUNTIME, OWNER]) {
    await adminQuery(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
  }
});

describe('go-live reset', () => {
  it('refuses, changing nothing, unless every guard holds', async () => {
    const before = { tables: await tables(), users: await trialUsers() };
    expect(before.users).toBeGreaterThan(1);
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...OK, db_confirm: undefined as unknown as string }, /REFUSED: type the database name a second time/],
      [{ ...OK, db_confirm: `${DB}x` }, /REFUSED: the two database names differ/],
      [{ ...OK, trial_gm: 'someone.else' }, /REFUSED: in the database .* the user someone\.else is not a General Manager: this is not the trial database you named/],
      [{ ...OK, trial_gm: 'cashier.kh.01' }, /is not a General Manager/],
      [{ ...OK, owner: `jerp_missing_${tag}` }, /REFUSED: the three roles must exist and differ/],
      [{ ...OK, backup: RUNTIME }, /REFUSED: the three roles must exist and differ/],
      [{ ...OK, db: 'postgres', db_confirm: 'postgres' }, /REFUSED: the target postgres is a system database/],
      [{ ...OK, db: `${DB};drop`, db_confirm: `${DB};drop` }, /REFUSED: database and role names must be plain/],
    ];
    for (const [vars, why] of cases) {
      const r = reset(Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined)));
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(why);
      expect(r.out).toMatch(/go-live reset REFUSED: nothing was changed/);
      expect({ tables: await tables(), users: await trialUsers() }).toEqual(before);
    }
  }, 300_000);

  it('with every guard: an empty database with every grant, then migrate, preflight, bootstrap, ready; nothing of the trial left', async () => {
    const r = reset(OK);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`The TRIAL database ${DB} of General Manager ${TRIAL_GM.replace('.', '\\.')} is dropped now: \\d+ users`));
    expect(r.out).toMatch(/DONE: the database .* is empty/);
    expect(await tables()).toBe(0);
    const drizzle = await one<{ owner: string }>(urlFor(OWNER), `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'drizzle'`);
    expect(drizzle.owner).toBe(OWNER);

    // Step 4: migrate as the owner, then the preflight.
    const migrated = await openDatabase({ url: urlFor(OWNER), migrationUrl: urlFor(OWNER) });
    await migrated.close();
    const pre = spawnSync(process.execPath, ['scripts/server/preflight.mjs'], { cwd: ROOT, env: PROD(), encoding: 'utf8', timeout: 120_000 });
    const preOut = `${pre.stdout}${pre.stderr}`;
    // Every check passes, except the built-frontend check where frontend/dist does not exist (a test checkout: CI's
    // test job and the gate copy build it after the tests); that line says nothing about the reset.
    const built = fs.existsSync(path.join(ROOT, 'frontend/dist/index.html'));
    const fails = preOut.split('\n').filter((l) => /^FAIL/.test(l) && (built || !/^FAIL\s+frontend\s/.test(l)));
    expect(fails, preOut).toEqual([]);
    expect(pre.status, preOut).toBe(built ? 0 : 1);
    expect(preOut).toMatch(/^PASS\s+migrations\s+(\d+) of \1 applied/m);
    expect(preOut).toMatch(new RegExp(`^PASS\\s+runtime role\\s+${RUNTIME} cannot alter the audit log or the ledgers`, 'm'));
    expect(preOut).toMatch(/^PASS\s+append-only/m);

    // The strict-role start-up checks, read by the runtime role itself.
    const runtime = await createDatabase({ url: urlFor(RUNTIME) });
    try {
      const role = await runtimeRoleProblems(runtime.db);
      expect(role).toMatchObject({ superuser: false, tables: [] });
      const owned = rows<{ n: string }>(await runtime.db.execute(sql`SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'drizzle') AND pg_get_userbyid(c.relowner) = current_user`))[0];
      expect(Number(owned.n)).toBe(0);
    } finally {
      await runtime.close();
    }

    // Step 5: the bootstrap command of the runbook (English name only; the Arabic name is typed later in the app).
    const boot = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), ['src/bootstrap-cli.ts', '--username', 'khalid.osman', '--full-name', 'Khalid Osman'], { cwd: path.join(ROOT, 'backend'), env: PROD(), encoding: 'utf8', timeout: 120_000 });
    const bootOut = `${boot.stdout}${boot.stderr}`;
    expect(boot.status, bootOut).toBe(0);
    expect(bootOut).toMatch(/General Manager "khalid\.osman" created\. Branches created: none\./);
    expect(bootOut).toMatch(/One-time password \(shown once, must be changed at first sign-in\): \S{12,}/);
    const refused = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), ['src/bootstrap-cli.ts', '--username', 'test.admin.user', '--full-name', 'Someone'], { cwd: path.join(ROOT, 'backend'), env: PROD(), encoding: 'utf8', timeout: 120_000 });
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(/Bootstrap failed: .*role-style/);

    // Step 6: the app on the runtime role is ready.
    const app = await createDatabase({ url: urlFor(RUNTIME) });
    try {
      const cfg = loadConfig({ ...PROD(), VITEST: '1' } as NodeJS.ProcessEnv);
      const res = await request(createApp(createContext(app), cfg)).get('/api/ready');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ ready: true });
    } finally {
      await app.close();
    }

    // Nothing of the trial is left (read by the backup role, read-only).
    const left = await one<Record<string, string>>(
      urlFor(BACKUP),
      `SELECT (SELECT string_agg(username, ',') FROM users) AS users,
              (SELECT count(*) FROM branches) AS branches, (SELECT count(*) FROM gold_rates) AS rates,
              (SELECT count(*) FROM scrap_rates) AS scrap_rates, (SELECT count(*) FROM jewelry_items) AS pieces,
              (SELECT count(*) FROM sales) AS sales, (SELECT count(*) FROM ledger_entries) AS ledger,
              (SELECT count(*) FROM audit_logs WHERE action <> 'BOOTSTRAP_COMPLETED') AS audit`,
    );
    expect(left).toEqual({ users: 'khalid.osman', branches: '0', rates: '0', scrap_rates: '0', pieces: '0', sales: '0', ledger: '0', audit: '0' });

    // Step 7: the backup role reads every table, as `npm run backup` does with pg_dump.
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-golive-')), 'db.dump');
    const dump = spawnSync('pg_dump', ['--format=custom', '--file', out, urlFor(BACKUP)], { encoding: 'utf8', timeout: 120_000 });
    expect(dump.status, `${dump.stdout}${dump.stderr}`).toBe(0);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }, 600_000);

  it('a database left empty by a reset that stopped after the drop is finished by running the same command again', async () => {
    await adminQuery(`DROP DATABASE ${DB} WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE ${DB}`);
    const r = reset(OK);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/holds no table .* it is created again/);
    expect(r.out).toMatch(/DONE: the database/);
    // The grants are back: the owner can migrate and the runtime role can read the migration history.
    const migrated = await openDatabase({ url: urlFor(OWNER), migrationUrl: urlFor(OWNER) });
    await migrated.close();
    const runtime = await createDatabase({ url: urlFor(RUNTIME) });
    try {
      const n = rows<{ n: string }>(await runtime.db.execute(sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`))[0];
      expect(Number(n.n)).toBeGreaterThan(30);
    } finally {
      await runtime.close();
    }
  }, 300_000);
});
