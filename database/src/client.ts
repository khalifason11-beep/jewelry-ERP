// Database client factory.
// * DATABASE_URL set  -> real PostgreSQL via node-postgres
// * otherwise         -> PGlite: real Postgres (WASM) embedded in-process, persisted to a folder
//                        (or in-memory for tests). Zero install for client demos.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as erpSchema from './schema';

// The mock Hasad tables (schema `hasad_mock`) are owned by /integrations/hasad; they are
// included in the generated migrations (see drizzle.config.ts) but not in this typed schema.
export const schema = { ...erpSchema };
export type Schema = typeof schema;
export type DB = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
/** Anything that can run queries: the root DB handle or an open transaction. */
export type Executor = DB | Tx;

export interface DatabaseHandle {
  db: DB;
  driver: 'postgres' | 'pglite';
  migrate(): Promise<void>;
  close(): Promise<void>;
  /** Drop and recreate every table (demo reset / tests). */
  wipe(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../migrations');

export interface CreateDatabaseOptions {
  url?: string;
  /** PGlite data directory. Use 'memory://' for an ephemeral database. */
  dataDir?: string;
}

export async function createDatabase(opts: CreateDatabaseOptions = {}): Promise<DatabaseHandle> {
  if (opts.url) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: opts.url, max: 10 });
    const db = drizzle(pool, { schema }) as unknown as DB;
    return {
      db,
      driver: 'postgres',
      migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS_DIR }),
      close: () => pool.end(),
      wipe: async () => {
        await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS hasad_mock CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
      },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const dataDir = opts.dataDir ?? 'memory://';
  if (!dataDir.startsWith('memory://')) {
    const fs = await import('node:fs');
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  }
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as DB;
  return {
    db,
    driver: 'pglite',
    migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => client.close(),
    wipe: async () => {
      await client.exec('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS hasad_mock CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
    },
  };
}
