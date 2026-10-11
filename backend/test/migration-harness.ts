// Shared harness for migration tests (CSH-2, MKC-1): a database migrated up to migration `last`, on PGlite or on a
// fresh real PostgreSQL database (dropped after the file), and small SQL helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, MIGRATIONS_DIR, type DatabaseHandle } from '@jerp/database';
import { dropTestDatabase, PG_MODE } from './helpers';

export const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));
export const run = async (h: DatabaseHandle, q: string) => {
  let last: Record<string, unknown>[] = [];
  for (const stmt of q.split(';').map((x) => x.trim()).filter(Boolean)) last = rowsOf<Record<string, unknown>>(await h.db.execute(sql.raw(stmt)));
  return last;
};
export const one = async (h: DatabaseHandle, q: string) => (await run(h, q))[0];
const dirs = new Map<number, string>();
const dropAfter: (() => Promise<void>)[] = [];

/** A copy of the migrations folder that stops after migration `last` (idx). */
export function upTo(last: number): string {
  if (dirs.has(last)) return dirs.get(last)!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jerp-mig${last}-`));
  fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= last);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  for (const f of fs.readdirSync(dir)) if (/^(\d{4})_/.test(f) && Number(f.slice(0, 4)) > last) fs.rmSync(path.join(dir, f));
  dirs.set(last, dir);
  return dir;
}

export async function openAt(last: number): Promise<DatabaseHandle> {
  let h: DatabaseHandle;
  if (!PG_MODE) h = await createDatabase({ dataDir: 'memory://' });
  else {
    const { default: pg } = await import('pg');
    const base = process.env.TEST_DATABASE_URL!;
    const name = `jerp_c2_${process.pid}_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(base);
    url.pathname = `/${name}`;
    h = await createDatabase({ url: url.toString() });
    dropAfter.push(async () => {
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await dropTestDatabase(a, name);
      await a.end();
    });
  }
  const { migrate } = PG_MODE ? await import('drizzle-orm/node-postgres/migrator') : await import('drizzle-orm/pglite/migrator');
  await migrate(h.db as never, { migrationsFolder: upTo(last) });
  return h;
}

afterAll(async () => {
  for (const f of dropAfter) await f();
  for (const d of dirs.values()) fs.rmSync(d, { recursive: true, force: true });
});
