// CSH-2 migrations on a database migrated up to the previous migration (both projects; the append-only trigger
// checks of 0021 run on real PostgreSQL too). Hand-written SQL is proven here, statement by statement:
//   0020: existing branches receive an EMPTY OWED_TO_GM account (no ledger entry invented, D-2b-8), new branches get
//         one from the trigger, the two event types are allowed, the checks are validated, the GM gets the permissions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, MIGRATIONS_DIR, type DatabaseHandle } from '@jerp/database';
import { dropTestDatabase, PG_MODE } from './helpers';

const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));
const run = async (h: DatabaseHandle, q: string) => {
  let last: Record<string, unknown>[] = [];
  for (const stmt of q.split(';').map((x) => x.trim()).filter(Boolean)) last = rowsOf<Record<string, unknown>>(await h.db.execute(sql.raw(stmt)));
  return last;
};
const one = async (h: DatabaseHandle, q: string) => (await run(h, q))[0];
const dirs = new Map<number, string>();
const dropAfter: (() => Promise<void>)[] = [];

/** A copy of the migrations folder that stops after migration `last` (idx). */
function upTo(last: number): string {
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

async function openAt(last: number): Promise<DatabaseHandle> {
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

const BASE = `
  INSERT INTO roles (code, name, name_ar) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام') ON CONFLICT DO NOTHING;
  INSERT INTO roles (code, name, name_ar) VALUES ('BRANCH_MANAGER', 'Branch Manager', 'مدير فرع') ON CONFLICT DO NOTHING;
  INSERT INTO users (username, full_name, role_id, password_hash) SELECT 'trial.person', 'Trial', id, 'x' FROM roles WHERE code = 'GENERAL_MANAGER';
  INSERT INTO branches (code, name, name_ar, city) VALUES ('TRL', 'Trial', 'تجربة', 'City')
`;

beforeAll(() => {
  upTo(19);
});

describe('migration 0020 (CSH-2 piece B)', () => {
  it('gives every existing branch an empty OWED_TO_GM account and invents no ledger entry', async () => {
    const h = await openAt(19);
    try {
      await run(h, BASE);
      // A drawer with history before the upgrade (a cash sale entry).
      await run(
        h,
        `INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, payment_method, ref_type, ref_id)
           SELECT a.id, a.branch_id, 50000, 'SALE', 'CASH', 'sale', 1 FROM ledger_accounts a JOIN branches b ON b.id = a.branch_id WHERE b.code = 'TRL' AND a.kind = 'CASH'`,
      );
      const entriesBefore = Number((await one(h, 'SELECT count(*) AS n FROM ledger_entries')).n);
      await h.migrate();
      const kinds = (await run(h, `SELECT a.kind FROM ledger_accounts a JOIN branches b ON b.id = a.branch_id WHERE b.code = 'TRL' ORDER BY a.kind`)).map((r) => r.kind);
      expect(kinds).toEqual(['BANK', 'CASH', 'FUNDS_IN_TRANSIT', 'HASAD_RECEIVABLE', 'OWED_TO_GM']);
      expect(Number((await one(h, 'SELECT count(*) AS n FROM ledger_entries')).n)).toBe(entriesBefore);
      // A new branch gets the account from the trigger.
      await run(h, `INSERT INTO branches (code, name, name_ar, city) VALUES ('NEW', 'New', 'جديد', 'City')`);
      expect(Number((await one(h, `SELECT count(*) AS n FROM ledger_accounts a JOIN branches b ON b.id = a.branch_id WHERE b.code = 'NEW' AND a.kind = 'OWED_TO_GM'`)).n)).toBe(1);
      // The replaced checks are validated and allow the new values.
      for (const c of ['ck_ledger_accounts_kind', 'ck_ledger_entries_event_type', 'ck_gm_funding_events_kind', 'ck_gm_funding_events_bank_reference']) {
        expect((await one(h, `SELECT convalidated AS v FROM pg_constraint WHERE conname = '${c}'`))?.v, c).toBe(true);
      }
      await run(
        h,
        `INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, ref_type, ref_id)
           SELECT a.id, a.branch_id, 1000, 'GM_ADVANCE', 'gm_funding_event', 1 FROM ledger_accounts a JOIN branches b ON b.id = a.branch_id WHERE b.code = 'TRL' AND a.kind = 'OWED_TO_GM'`,
      );
      // The General Manager role holds the two new permissions; the branch manager role does not.
      const perms = (await run(h, `SELECT r.code, rp.permission_code AS p FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_code LIKE 'funding.%' ORDER BY 1, 2`)).map((r) => `${r.code}:${r.p}`);
      expect(perms).toEqual(['GENERAL_MANAGER:funding.manage', 'GENERAL_MANAGER:funding.view']);
      // The funding table is append-only, and a correction must match its original.
      await run(h, `INSERT INTO gm_funding_events (number, branch_id, kind, account, amount, reason, actor_id) SELECT 'TRL-GMA-000001', b.id, 'ADVANCE', 'CASH', 1000, 'Float', u.id FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`);
      expect(await run(h, `UPDATE gm_funding_events SET amount = 2 WHERE number = 'TRL-GMA-000001'`).then(() => null, (e: unknown) => e)).not.toBeNull();
      const bad = await run(
        h,
        `INSERT INTO gm_funding_events (number, branch_id, kind, account, amount, reason, actor_id, reverses_event_id)
           SELECT 'TRL-GMX-000001', b.id, 'REVERSAL', 'CASH', 999, 'Wrong amount', u.id, (SELECT id FROM gm_funding_events WHERE number = 'TRL-GMA-000001') FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`,
      ).then(() => null, (e: unknown) => e);
      expect(String((bad as { cause?: Error })?.cause?.message ?? (bad as Error)?.message)).toMatch(/same branch, account and amount/);
    } finally {
      await h.close();
    }
  });
});
