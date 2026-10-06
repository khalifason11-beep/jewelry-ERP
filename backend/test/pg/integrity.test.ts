// Real PostgreSQL only: the two independent protection layers of the append-only ledgers.
//   1. privileges — the application role (non-superuser, runs the migrations) has no
//      UPDATE / DELETE / TRUNCATE on them (REVOKE in migration 0004)
//   2. triggers — even a role that is granted those privileges back is refused by the trigger

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import type { Ctx } from '../../src/core/context';
import { rows } from '../../src/core/sql';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

const LEDGERS = ['audit_logs', 'inventory_movements', 'item_status_history', 'gold_rates', 'settings_history'];
let handle: DatabaseHandle;
let ctx: Ctx;

const failure = async (statement: string) => {
  const e = await ctx.db.execute(sql.raw(statement)).then(() => null, (err: Error & { cause?: Error & { code?: string } }) => err);
  return e ? `${e.cause?.code ?? ''} ${e.message} ${e.cause?.message ?? ''}` : null;
};

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
});
afterAll(async () => handle?.close());

describe('append-only ledgers on real PostgreSQL', () => {
  it('runs as a non-superuser application role (so privileges apply)', async () => {
    const [me] = rows<{ super: boolean }>(await ctx.db.execute(sql`SELECT rolsuper AS super FROM pg_roles WHERE rolname = current_user`));
    expect(me.super).toBe(false);
  });

  it.each(LEDGERS)('layer 1 — %s: the app role has no UPDATE/DELETE/TRUNCATE privilege, only SELECT/INSERT', async (table) => {
    const [p] = rows<Record<string, boolean>>(
      await ctx.db.execute(sql.raw(`SELECT has_table_privilege('${table}', 'SELECT') AS sel, has_table_privilege('${table}', 'INSERT') AS ins,
        has_table_privilege('${table}', 'UPDATE') AS upd, has_table_privilege('${table}', 'DELETE') AS del, has_table_privilege('${table}', 'TRUNCATE') AS trunc`)),
    );
    expect(p).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false });
    for (const stmt of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
      expect(await failure(stmt), stmt).toMatch(/42501|permission denied/);
    }
  });

  it.each(LEDGERS)('layer 2 — %s: with the privileges granted back, the trigger still refuses', async (table) => {
    // The role owns the table, so it can grant itself the privileges back — exactly what an
    // attacker with the app's credentials could do. The trigger must still stop them.
    await ctx.db.execute(sql.raw(`GRANT UPDATE, DELETE, TRUNCATE ON ${table} TO CURRENT_USER`));
    try {
      for (const stmt of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        expect(await failure(stmt), stmt).toMatch(/append-only/);
      }
    } finally {
      await ctx.db.execute(sql.raw(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM CURRENT_USER`));
    }
    const [n] = rows<{ n: number }>(await ctx.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)));
    expect(n.n).toBeGreaterThan(0);
  });
});
