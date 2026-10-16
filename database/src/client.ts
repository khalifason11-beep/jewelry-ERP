// Database client factory.
// * DATABASE_URL set  -> real PostgreSQL via node-postgres
// * otherwise         -> PGlite: real Postgres (WASM) embedded in-process, persisted to a folder
//                        (or in-memory for tests). Zero install for client demos.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as erpSchema from './schema';

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
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../migrations');

/**
 * Pool settings for real PostgreSQL (SAFE-1). The application's runtime pool gets explicit limits and timeouts
 * (env PG_*, backend/src/config.ts); migrations and CLIs use the defaults (no statement timeout).
 */
export interface PoolSettings {
  max?: number;
  /** Server-side statement_timeout per statement, ms (0 = none). */
  statementTimeoutMs?: number;
  /** Server-side idle_in_transaction_session_timeout, ms (0 = none). */
  idleInTxTimeoutMs?: number;
  /** How long to wait for a new connection, ms. */
  connectTimeoutMs?: number;
  /** How long an idle pooled connection is kept, ms. */
  idleTimeoutMs?: number;
}

/** What the pool reports when an idle connection dies (database restart, network loss). */
export type PoolErrorHandler = (err: Error) => void;

export interface CreateDatabaseOptions {
  url?: string;
  /** PGlite data directory. Use 'memory://' for an ephemeral database. */
  dataDir?: string;
  pool?: PoolSettings;
  /** Defaults to one JSON line on stderr. Never omitted: without a listener node-postgres crashes the process. */
  onPoolError?: PoolErrorHandler;
}

const defaultPoolError: PoolErrorHandler = (err) => {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'database connection lost (the pool replaces it on the next query)', err: { name: err.name, message: err.message, code: (err as { code?: unknown }).code } }) + '\n');
};

export async function createDatabase(opts: CreateDatabaseOptions = {}): Promise<DatabaseHandle> {
  if (opts.url) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const p = opts.pool ?? {};
    const pool = new Pool({
      connectionString: opts.url,
      max: p.max ?? 10,
      ...(p.statementTimeoutMs ? { statement_timeout: p.statementTimeoutMs } : {}),
      ...(p.idleInTxTimeoutMs ? { idle_in_transaction_session_timeout: p.idleInTxTimeoutMs } : {}),
      ...(p.connectTimeoutMs ? { connectionTimeoutMillis: p.connectTimeoutMs } : {}),
      ...(p.idleTimeoutMs ? { idleTimeoutMillis: p.idleTimeoutMs } : {}),
    });
    // SAFE-1: an idle connection that dies (the database restarts) is reported here. Without a listener node-postgres
    // raises it as an uncaught 'error' event and the whole process crashes; with it, the broken connection is dropped
    // and the next query opens a new one.
    pool.on('error', opts.onPoolError ?? defaultPoolError);
    const db = drizzle(pool, { schema }) as unknown as DB;
    return {
      db,
      driver: 'postgres',
      migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS_DIR }),
      close: () => pool.end(),
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
  };
}
