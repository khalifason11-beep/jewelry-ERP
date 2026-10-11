// Real PostgreSQL only: separate owner (migrations) and runtime (app) roles — D-2a-13.
// Builds the setup exactly as docs/DEPLOYMENT.md describes, runs the migrations as the owner,
// connects as the runtime role, and proves the runtime role cannot touch the append-only history:
// no UPDATE/DELETE/TRUNCATE, cannot disable or drop the triggers, cannot switch triggers off with
// session_replication_role, cannot grant itself the privileges back.
// The test role (TEST_DATABASE_URL) needs CREATEDB and CREATEROLE; it must not be a superuser.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { openDatabase, runMigrations } from '../../src/bootstrap';
import { APPEND_ONLY_TABLES, runtimeRoleProblems } from '../../src/core/startup';
import { rows } from '../../src/core/sql';
import { dropTestDatabase, PG_MODE } from '../helpers';

const base = process.env.TEST_DATABASE_URL!;
const tag = randomBytes(4).toString('hex');
const OWNER = `jerp_owner_${tag}`;
const RUNTIME = `jerp_app_${tag}`;
const DB = `jerp_roles_${tag}`;
const PW = `Pw-${randomBytes(8).toString('hex')}`;
const urlFor = (user: string, db = DB) => {
  const u = new URL(base);
  u.username = user;
  u.password = PW;
  u.pathname = `/${db}`;
  return u.toString();
};
let app: DatabaseHandle;
let owner: DatabaseHandle;

async function adminQuery(q: string, db = 'postgres') {
  const { default: pg } = await import('pg');
  const u = new URL(base);
  u.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return await c.query(q);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  // 1. Roles and database (docs/DEPLOYMENT.md, "Separate owner and runtime roles").
  await adminQuery(`CREATE ROLE ${OWNER} LOGIN PASSWORD '${PW}'`);
  await adminQuery(`CREATE ROLE ${RUNTIME} LOGIN PASSWORD '${PW}'`);
  await adminQuery(`CREATE DATABASE ${DB}`);
  await adminQuery(`GRANT CONNECT, CREATE ON DATABASE ${DB} TO ${OWNER}; GRANT CONNECT ON DATABASE ${DB} TO ${RUNTIME}`);
  await adminQuery(`GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER}; GRANT USAGE ON SCHEMA public TO ${RUNTIME}`, DB);
  // 2. Run as the OWNER before the first migration: future tables are usable by the runtime role.
  const { default: pg } = await import('pg');
  const o = new pg.Client({ connectionString: urlFor(OWNER) });
  await o.connect();
  await o.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME}`);
  await o.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME}`);
  await o.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${RUNTIME}`);
  await o.end();
  // 3. Migrate as the owner, run the app as the runtime role (what server.ts does with MIGRATION_DATABASE_URL).
  await runMigrations({ url: urlFor(OWNER) });
  app = await openDatabase({ url: urlFor(RUNTIME), migrationUrl: urlFor(OWNER) });
  owner = await openDatabase({ url: urlFor(OWNER) });
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
  await dropTestDatabase({ query: adminQuery }, DB);
  await adminQuery(`DROP ROLE IF EXISTS ${RUNTIME}`);
  await adminQuery(`DROP ROLE IF EXISTS ${OWNER}`);
});

const failure = async (db: DatabaseHandle, statement: string) => {
  const e = await db.db.execute(sql.raw(statement)).then(() => null, (err: Error & { cause?: Error & { code?: string } }) => err);
  return e ? `${e.cause?.code ?? ''} ${e.message} ${e.cause?.message ?? ''}` : null;
};

describe('separate owner and runtime roles on real PostgreSQL', () => {
  it('the runtime role owns nothing and cannot alter any append-only table (start-up check passes)', async () => {
    const r = await runtimeRoleProblems(app.db);
    expect(r.role).toBe(RUNTIME);
    expect(r.superuser).toBe(false);
    expect(r.tables).toEqual([]);
  });

  it('the owner role is flagged by the start-up check (it could drop the triggers)', async () => {
    const r = await runtimeRoleProblems(owner.db);
    expect(r.tables.map((x) => x.table).sort()).toEqual([...APPEND_ONLY_TABLES].sort());
    expect(r.tables.every((x) => x.owns)).toBe(true);
  });

  it('the runtime role can do its normal work (read, insert, update ordinary tables)', async () => {
    await app.db.insert(t.auditLogs).values({ action: 'LOGIN', description: 'role test', username: 'x' });
    await app.db.insert(t.settings).values({ key: 'role.test', value: 1 });
    await app.db.update(t.settings).set({ value: 2 }).where(sql`key = 'role.test'`);
    expect((await app.db.select().from(t.auditLogs)).length).toBeGreaterThan(0);
  });

  it.each(APPEND_ONLY_TABLES)('%s: runtime role cannot change rows, disable/drop triggers, bypass them, or re-grant itself', async (table) => {
    for (const stmt of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
      expect(await failure(app, stmt), stmt).toMatch(/42501|permission denied/);
    }
    const [trigger] = rows<{ name: string }>(await owner.db.execute(sql.raw(`SELECT tgname AS name FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND NOT tgisinternal LIMIT 1`)));
    expect(await failure(app, `ALTER TABLE ${table} DISABLE TRIGGER ${trigger.name}`)).toMatch(/42501|must be owner/);
    expect(await failure(app, `ALTER TABLE ${table} DISABLE TRIGGER ALL`)).toMatch(/42501|must be owner/);
    expect(await failure(app, `DROP TRIGGER ${trigger.name} ON ${table}`)).toMatch(/42501|must be owner/);
    expect(await failure(app, `SET session_replication_role = replica`)).toMatch(/42501|permission denied/);
    // A non-owner's GRANT is not an error in PostgreSQL ("no privileges were granted"): check the effect.
    await failure(app, `GRANT UPDATE, DELETE, TRUNCATE ON ${table} TO ${RUNTIME}`);
    const [p] = rows<{ upd: boolean; del: boolean; trunc: boolean }>(
      await app.db.execute(sql.raw(`SELECT has_table_privilege('${table}', 'UPDATE') AS upd, has_table_privilege('${table}', 'DELETE') AS del, has_table_privilege('${table}', 'TRUNCATE') AS trunc`)),
    );
    expect(p).toEqual({ upd: false, del: false, trunc: false });
    // …and the triggers are still enabled.
    const [state] = rows<{ enabled: string }>(await owner.db.execute(sql.raw(`SELECT tgenabled AS enabled FROM pg_trigger WHERE tgname = '${trigger.name}'`)));
    expect(state.enabled).toBe('O');
  });
});
