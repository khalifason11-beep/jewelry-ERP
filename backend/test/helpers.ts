import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@jerp/database';
import { openDatabase } from '../src/bootstrap';

/** The `postgres` vitest project runs every suite against real PostgreSQL (vitest.config.ts). */
export const PG_MODE = process.env.JERP_TEST_DRIVER === 'postgres';

/**
 * A migrated, empty database for one test file: in-memory PGlite by default, or — in the
 * `postgres` project — a fresh database created from TEST_DATABASE_URL and dropped on close().
 */
export async function openTestDatabase(): Promise<DatabaseHandle & { url?: string }> {
  if (!PG_MODE) return openDatabase({ dataDir: 'memory://' });
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required for the postgres test project');
  const name = `jerp_t_${process.pid}_${randomBytes(4).toString('hex')}`;
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const handle = await openDatabase({ url: url.toString() });
  return {
    ...handle,
    url: url.toString(),
    close: async () => {
      await handle.close();
      const drop = new pg.Client({ connectionString: base });
      await drop.connect();
      await dropTestDatabase(drop, name);
      await drop.end();
    },
  };
}

/**
 * Drop a test database once its own connections are closed. A plain DROP first: it cancels an autovacuum worker that
 * may still be busy on the database (tests fill it heavily). `WITH (FORCE)` would instead try to terminate that worker,
 * which runs as the bootstrap superuser, and our test role is deliberately not a superuser, so PostgreSQL refuses
 * ("permission denied to terminate process", seen intermittently). FORCE only when a client connection is really
 * left open (object_in_use, 55006), for the tests that connect as other roles.
 */
export async function dropTestDatabase(client: { query: (q: string) => Promise<unknown> }, name: string): Promise<void> {
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
  } catch (e) {
    if ((e as { code?: string }).code !== '55006') throw e;
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

/** A fresh Idempotency-Key for every request the agent sends (a test can still `.set()` its own). */
export function withIdempotencyKeys<A extends { use(fn: (req: { set(name: string, value: string): unknown }) => void): A }>(agent: A): A {
  return agent.use((req) => {
    req.set('Idempotency-Key', randomUUID());
  });
}

/**
 * OPN-4 (D-opn4-4): what the General Manager reviewed before sealing (the seal dialog sends the same two numbers from
 * the opening's summary): the draft's line count and net weight now.
 */
export async function reviewedOf(exec: Pick<DatabaseHandle['db'], 'select'>, openingId: number): Promise<{ expectedLines: number; expectedNetWeightMg: number }> {
  const { t } = await import('@jerp/database');
  const { eq, sql } = await import('drizzle-orm');
  const [r] = await exec
    .select({ n: sql<number>`count(*)`.mapWith(Number), net: sql<number>`coalesce(sum(${t.openingLines.netWeightMg}), 0)`.mapWith(Number) })
    .from(t.openingLines)
    .where(eq(t.openingLines.openingId, openingId));
  return { expectedLines: r.n, expectedNetWeightMg: r.net };
}
