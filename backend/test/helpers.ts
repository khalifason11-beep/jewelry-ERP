import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@jerp/database';
import { openDatabase } from '../src/bootstrap';

/** The `postgres` vitest project runs every suite against real PostgreSQL (vitest.config.ts). */
export const PG_MODE = process.env.JERP_TEST_DRIVER === 'postgres';

/**
 * A migrated, empty database for one test file: in-memory PGlite by default, or — in the
 * `postgres` project — a fresh database created from TEST_DATABASE_URL and dropped on close().
 */
export async function openTestDatabase(): Promise<DatabaseHandle> {
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
    close: async () => {
      await handle.close();
      const drop = new pg.Client({ connectionString: base });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await drop.end();
    },
  };
}

/** A fresh Idempotency-Key for every request the agent sends (a test can still `.set()` its own). */
export function withIdempotencyKeys<A extends { use(fn: (req: { set(name: string, value: string): unknown }) => void): A }>(agent: A): A {
  return agent.use((req) => {
    req.set('Idempotency-Key', randomUUID());
  });
}
