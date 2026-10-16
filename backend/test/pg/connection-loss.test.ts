// SAFE-1: the app survives a database restart without a manual restart. When every connection of the pool is killed
// (what a PostgreSQL restart does to them), the pool reports the lost idle connections to its error handler instead of
// crashing the process, and the next query works on a new connection. The runtime timeouts are real server-side limits.
// Real PostgreSQL only (test/pg).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '@jerp/database';
import { loadConfig } from '../../src/config';
import { openTestDatabase, PG_MODE } from '../helpers';

let base: DatabaseHandle & { url?: string };
let app: DatabaseHandle;
const poolErrors: Error[] = [];

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  base = await openTestDatabase();
  const pg = loadConfig({ APP_MODE: 'demo', VITEST: '1', PG_STATEMENT_TIMEOUT_MS: '500', PG_IDLE_IN_TX_TIMEOUT_MS: '700' } as NodeJS.ProcessEnv).pg;
  app = await createDatabase({ url: base.url, pool: { ...pg, max: 3 }, onPoolError: (e) => poolErrors.push(e) });
});
afterAll(async () => {
  await app?.close();
  await base?.close();
});

const one = async (h: DatabaseHandle, q: string) => ((await h.db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] }).rows[0];

describe('connection loss', () => {
  it('every pool connection killed: no crash, the error is reported, and the next queries work', async () => {
    // Open three connections so the pool holds idle ones.
    await Promise.all([1, 2, 3].map(() => one(app, 'SELECT pg_sleep(0.05)')));
    const dbName = String((await one(app, 'SELECT current_database() AS d')).d);
    const killed = await one(base, `SELECT count(pg_terminate_backend(pid)) AS n FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid() AND application_name = ''`);
    expect(Number(killed.n)).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(poolErrors.length).toBeGreaterThan(0);
    // The app recovers by itself.
    for (let i = 0; i < 5; i++) expect(Number((await one(app, 'SELECT 1 AS v')).v)).toBe(1);
  });

  it('the runtime pool has a server-side statement timeout and an idle-in-transaction timeout', async () => {
    expect(String((await one(app, 'SHOW statement_timeout')).statement_timeout)).toBe('500ms');
    expect(String((await one(app, 'SHOW idle_in_transaction_session_timeout')).idle_in_transaction_session_timeout)).toBe('700ms');
    const err = await app.db.execute(sql`SELECT pg_sleep(2)`).then(() => null, (e: { cause?: { code?: string }; code?: string }) => e);
    expect(err?.cause?.code ?? err?.code).toBe('57014'); // query_canceled
    expect(Number((await one(app, 'SELECT 1 AS v')).v)).toBe(1);
  });

  it('migrations and CLIs keep no statement timeout (they use the default pool)', async () => {
    expect(String((await one(base, 'SHOW statement_timeout')).statement_timeout)).toBe('0');
  });
});
