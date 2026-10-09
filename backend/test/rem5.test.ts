// REM-5 (migration 0016): the deprecated tables, columns and values are gone from a fresh database, and an
// upgrade from 0015 either succeeds (no legacy rows) or STOPS with the guard's message and changes nothing.
// Runs on PGlite and on real PostgreSQL. Legacy rows are written by raw SQL into a database migrated only up
// to 0015 (the shape they had then), with the deprecation triggers of 0013/0014 switched off for the insert.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, MIGRATIONS_DIR, type DatabaseHandle } from '@jerp/database';
import { dropTestDatabase, openTestDatabase, PG_MODE } from './helpers';

const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));
/** Run one or more statements (separated by `;`; none of these scripts has a `;` inside a string); returns the last result's rows. */
const run = async (h: DatabaseHandle, q: string) => {
  let last: Record<string, unknown>[] = [];
  for (const stmt of q.split(';').map((x) => x.trim()).filter(Boolean)) last = rowsOf<Record<string, unknown>>(await h.db.execute(sql.raw(stmt)));
  return last;
};
const errorText = (e: unknown) => {
  const err = e as Error & { cause?: Error };
  return `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
};

// ── a database migrated only up to 0015 ──
let upTo15Dir: string;
const dropAfter: (() => Promise<void>)[] = [];
beforeAll(() => {
  upTo15Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-mig15-'));
  fs.cpSync(MIGRATIONS_DIR, upTo15Dir, { recursive: true });
  const journalPath = path.join(upTo15Dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 15);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  for (const f of fs.readdirSync(upTo15Dir)) if (/^(\d{4})_/.test(f) && Number(f.slice(0, 4)) > 15) fs.rmSync(path.join(upTo15Dir, f));
});
afterAll(async () => {
  for (const f of dropAfter) await f();
  fs.rmSync(upTo15Dir, { recursive: true, force: true });
});

async function openAt15(): Promise<DatabaseHandle> {
  let handle: DatabaseHandle;
  if (!PG_MODE) handle = await createDatabase({ dataDir: 'memory://' });
  else {
    const { default: pg } = await import('pg');
    const base = process.env.TEST_DATABASE_URL!;
    const name = `jerp_r5_${process.pid}_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(base);
    url.pathname = `/${name}`;
    handle = await createDatabase({ url: url.toString() });
    dropAfter.push(async () => {
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await dropTestDatabase(a, name);
      await a.end();
    });
  }
  const { migrate } = PG_MODE ? await import('drizzle-orm/node-postgres/migrator') : await import('drizzle-orm/pglite/migrator');
  await migrate(handle.db as never, { migrationsFolder: upTo15Dir });
  return handle;
}
const appliedMigrations = async (h: DatabaseHandle) => Number((await run(h, 'SELECT count(*) AS n FROM drizzle.__drizzle_migrations'))[0].n);
const exists = async (h: DatabaseHandle, rel: string) => (await run(h, `SELECT to_regclass('${rel}') IS NOT NULL AS e`))[0].e === true;

/** Minimal reference rows at 0015: a role, a user, a branch (its ledger accounts come from a trigger), a type, a product, a piece. */
const BASE = `
  INSERT INTO roles (code, name, name_ar) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام') ON CONFLICT DO NOTHING;
  INSERT INTO users (username, full_name, role_id, password_hash) SELECT 'legacy.person', 'Legacy', id, 'x' FROM roles WHERE code = 'GENERAL_MANAGER';
  INSERT INTO branches (code, name, name_ar, city) VALUES ('LEG', 'Legacy', 'قديم', 'City');
  INSERT INTO categories (code, name_ar) VALUES ('T-001', 'نوع');
  INSERT INTO products (sku, name_ar, category_id, karat) SELECT 'P-001', 'منتج', id, 21 FROM categories;
  INSERT INTO jewelry_items (code, barcode, product_id, karat, gross_weight_mg, net_weight_mg, purchase_cost, total_cost, acquisition_cost, selling_price, branch_id, status, origin)
    SELECT 'J-1', 'J-1', p.id, 21, 5000, 5000, 1000, 1000, 1000, 2000, b.id, 'AVAILABLE', 'SCRAP' FROM products p, branches b;
`;
const off = (table: string) => `ALTER TABLE ${table} DISABLE TRIGGER USER;`;
const ids = `(SELECT id FROM branches WHERE code = 'LEG')`;
const uid = `(SELECT id FROM users WHERE username = 'legacy.person')`;
const item = `(SELECT id FROM jewelry_items WHERE code = 'J-1')`;
const WITHDRAWAL = `INSERT INTO hasad_withdrawals (external_id, hasad_customer_id, customer_name, entitled_weight_mg, entitlement_karat, branch_id, status, external_status, requested_at)
  VALUES ('HG-1', 'C-1', 'x', 5000, 21, ${ids}, 'COMPLETED', 'COMPLETED', now());`;
const REDEMPTION = `INSERT INTO hasad_redemptions (number, withdrawal_id, branch_id, cashier_id, status, entitled_weight_mg)
  SELECT 'HR-1', id, ${ids}, ${uid}, 'COMPLETED', 5000 FROM hasad_withdrawals WHERE external_id = 'HG-1';`;
const MOCK_CUSTOMER = `INSERT INTO hasad_mock.customers (id, full_name, balance_mg) VALUES ('C-1', 'x', 1);`;

/** One legacy kind each: the setup SQL and the guard line that must name it. */
const LEGACY: { kind: string; sql: string; line: string }[] = [
  { kind: 'an expense', line: 'expenses (removed by REM-1): 1', sql: `${off('expenses')} INSERT INTO expenses (number, branch_id, category, amount, expense_date, description, status, created_by) VALUES ('EXP-1', ${ids}, 'OTHER', 1000, '2026-01-01', 'x', 'APPROVED', ${uid});` },
  { kind: 'a Hasad withdrawal', line: 'hasad_withdrawals (removed by REM-2): 1', sql: `${off('hasad_withdrawals')} ${WITHDRAWAL}` },
  { kind: 'a Hasad counter session', line: 'hasad_redemptions (removed by REM-2): 1', sql: `${off('hasad_withdrawals')} ${off('hasad_redemptions')} ${WITHDRAWAL} ${REDEMPTION}` },
  {
    kind: 'a Hasad counter-session line',
    line: 'hasad_redemption_items (removed by REM-2): 1',
    sql: `${off('hasad_withdrawals')} ${off('hasad_redemptions')} ${off('hasad_redemption_items')} ${WITHDRAWAL} ${REDEMPTION}
      INSERT INTO hasad_redemption_items (redemption_id, item_id, net_weight_mg, karat, unit_cost) SELECT id, ${item}, 5000, 21, 1000 FROM hasad_redemptions;`,
  },
  { kind: 'a weight-difference settlement', line: 'settlements: Hasad weight differences (removed by REM-2): 1', sql: `${off('settlements')} INSERT INTO settlements (number, type, branch_id, direction, weight_mg, rate_per_gram, amount, payment_method, confirmed_by) VALUES ('ST-1', 'HASAD_WEIGHT_DIFFERENCE', ${ids}, 'CUSTOMER_PAYS_BRANCH', 10, 1, 10, 'CASH', ${uid});` },
  { kind: 'a mock Hasad customer', line: 'hasad_mock.customers: 1', sql: `${off('hasad_mock.customers')} ${MOCK_CUSTOMER}` },
  { kind: 'a mock Hasad withdrawal', line: 'hasad_mock.withdrawals: 1', sql: `${off('hasad_mock.customers')} ${off('hasad_mock.withdrawals')} ${MOCK_CUSTOMER} INSERT INTO hasad_mock.withdrawals (id, customer_id, weight_mg, karat, branch_code, status, requested_at) VALUES ('W-1', 'C-1', 1, 21, 'LEG', 'PENDING', now());` },
  { kind: 'a mock Hasad API call', line: 'hasad_mock.api_calls: 1', sql: `${off('hasad_mock.api_calls')} INSERT INTO hasad_mock.api_calls (operation, response_status, duration_ms) VALUES ('x', 200, 1);` },
  { kind: 'an EXPENSE ledger entry', line: 'ledger_entries with event EXPENSE or HASAD_SETTLEMENT: 1', sql: `${off('ledger_entries')} INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, ref_type, ref_id) SELECT id, branch_id, -1000, 'EXPENSE', 'expense', 1 FROM ledger_accounts WHERE kind = 'CASH';` },
  { kind: 'a HASAD_REDEMPTION movement', line: 'inventory_movements of type HASAD_REDEMPTION: 1', sql: `INSERT INTO inventory_movements (item_id, branch_id, type, direction, net_weight_mg, cost_value) VALUES (${item}, ${ids}, 'HASAD_REDEMPTION', -1, 5000, 1000);` },
  { kind: 'a RESERVED history row', line: 'item_status_history through RESERVED or REDEEMED: 1', sql: `INSERT INTO item_status_history (item_id, from_status, to_status, branch_id) VALUES (${item}, 'AVAILABLE', 'RESERVED', ${ids});` },
  { kind: 'a REDEEMED piece', line: 'jewelry_items RESERVED or REDEEMED, or with a reservation: 1', sql: `UPDATE jewelry_items SET status = 'REDEEMED' WHERE code = 'J-1';` },
  { kind: 'a piece whose old cost columns differ', line: 'jewelry_items whose old cost columns differ from acquisition_cost or the supplier line: 1', sql: `UPDATE jewelry_items SET purchase_cost = 1500, total_cost = 1500 WHERE code = 'J-1';` },
  { kind: 'a removed audit action', line: 'audit_logs with a removed action: 1', sql: `INSERT INTO audit_logs (action, description) VALUES ('EXPENSE_CREATED', 'x');` },
  { kind: 'a Hasad branch code', line: 'branches with a Hasad branch code: 1', sql: `UPDATE branches SET hasad_branch_code = 'HB-1' WHERE code = 'LEG';` },
  { kind: 'a simulated session', line: 'sessions marked simulated (demo presence): 1', sql: `INSERT INTO sessions (id, user_id, is_simulated) VALUES ('s-legacy', ${uid}, true);` },
  {
    kind: 'a piece with two supplier lines',
    line: 'pieces with more than one supplier line (purchase_items): 1',
    sql: `INSERT INTO purchases (number, branch_id, item_count, total_net_weight_mg, total_cost, created_by) VALUES ('PO-1', ${ids}, 1, 5000, 1000, ${uid});
      INSERT INTO purchase_items (purchase_id, item_id, purchase_cost, making_cost, other_cost) SELECT id, ${item}, 1000, 0, 0 FROM purchases WHERE number = 'PO-1';
      INSERT INTO purchase_items (purchase_id, item_id, purchase_cost, making_cost, other_cost) SELECT id, ${item}, 1000, 0, 0 FROM purchases WHERE number = 'PO-1';`,
  },
];

describe('REM-5 on a fresh database', () => {
  let h: DatabaseHandle;
  beforeAll(async () => {
    h = await openTestDatabase();
  });
  afterAll(async () => h?.close());

  it('has none of the removed tables, schema, columns, triggers, function or settings row', async () => {
    for (const rel of ['expenses', 'hasad_withdrawals', 'hasad_redemptions', 'hasad_redemption_items', 'settlements']) expect(await exists(h, rel), rel).toBe(false);
    expect(await run(h, `SELECT 1 FROM pg_namespace WHERE nspname = 'hasad_mock'`)).toHaveLength(0);
    const cols = await run(h, `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND (
      (table_name = 'jewelry_items' AND column_name IN ('purchase_cost', 'making_cost', 'other_cost', 'total_cost', 'reservation_ref', 'reserved_at', 'reserved_by'))
      OR (table_name = 'sessions' AND column_name = 'is_simulated') OR (table_name = 'branches' AND column_name = 'hasad_branch_code'))`);
    expect(cols).toEqual([]);
    expect(await run(h, `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_ledger_entries_no_expense', 'trg_ledger_entries_no_hasad_settlement')`)).toEqual([]);
    expect(await run(h, `SELECT proname FROM pg_proc WHERE proname = 'jerp_refuse_deprecated_insert'`)).toEqual([]);
    expect(await run(h, `SELECT key FROM settings WHERE key = 'hasad.enabledPerBranch'`)).toEqual([]);
  });

  it('a piece has at most one supplier line: a second purchase_items row is refused (UNIQUE item_id)', async () => {
    await run(
      h,
      `INSERT INTO roles (code, name, name_ar) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام') ON CONFLICT DO NOTHING;
       INSERT INTO users (username, full_name, role_id, password_hash) SELECT 'unique.person', 'U', id, 'x' FROM roles WHERE code = 'GENERAL_MANAGER';
       INSERT INTO branches (code, name, name_ar, city) VALUES ('UNQ', 'U', 'ف', 'C');
       INSERT INTO categories (code, name_ar) VALUES ('T-901', 'نوع');
       INSERT INTO products (sku, name_ar, category_id, karat) SELECT 'P-901', 'منتج', id, 21 FROM categories WHERE code = 'T-901';
       INSERT INTO purchases (number, branch_id, item_count, total_net_weight_mg, total_cost, created_by)
         SELECT 'PO-901', b.id, 1, 5000, 1000, u.id FROM branches b, users u WHERE b.code = 'UNQ' AND u.username = 'unique.person';
       INSERT INTO jewelry_items (code, barcode, product_id, karat, gross_weight_mg, net_weight_mg, acquisition_cost, selling_price, branch_id, status)
         SELECT 'J-901', 'J-901', p.id, 21, 5000, 5000, 1000, 2000, b.id, 'AVAILABLE' FROM products p, branches b WHERE p.sku = 'P-901' AND b.code = 'UNQ';
       INSERT INTO purchase_items (purchase_id, item_id, purchase_cost, making_cost, other_cost)
         SELECT po.id, i.id, 1000, 0, 0 FROM purchases po, jewelry_items i WHERE po.number = 'PO-901' AND i.code = 'J-901'`,
    );
    const second = `INSERT INTO purchase_items (purchase_id, item_id, purchase_cost, making_cost, other_cost)
      SELECT po.id, i.id, 1000, 0, 0 FROM purchases po, jewelry_items i WHERE po.number = 'PO-901' AND i.code = 'J-901'`;
    const e = await run(h, second).then(() => null, (err: unknown) => err);
    expect(e, 'a second line for the same piece must be refused').not.toBeNull();
    expect(errorText(e)).toContain('purchase_items_item_id_unique');
    expect((await run(h, `SELECT count(*) AS n FROM purchase_items pi JOIN jewelry_items i ON i.id = pi.item_id WHERE i.code = 'J-901'`))[0].n).toBe(PG_MODE ? '1' : 1);
  });

  it('the narrowed CHECKs no longer accept the removed values; the kept ones are still there', async () => {
    const defs = Object.fromEntries(
      (await run(h, `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('ck_ledger_entries_event_type', 'ck_inventory_movements_type', 'ck_jewelry_items_status', 'ck_item_status_history_from_status', 'ck_item_status_history_to_status')`)).map((r) => [r.conname, String(r.def)]),
    );
    expect(Object.keys(defs)).toHaveLength(5);
    for (const [name, def] of Object.entries(defs)) expect(def, name).not.toMatch(/EXPENSE|HASAD_SETTLEMENT|HASAD_REDEMPTION|RESERVED|REDEEMED/);
    expect(defs.ck_ledger_entries_event_type).toMatch(/REVERSAL/);
    expect(defs.ck_ledger_entries_event_type).toMatch(/HASAD_RECEIVABLE_SETTLEMENT/);
  });
});

describe('REM-5 upgrade from 0015', () => {
  it.each(LEGACY)('stops on $kind and changes nothing', async ({ sql: setup, line }) => {
    const h = await openAt15();
    try {
      await run(h, BASE);
      await run(h, setup);
      const before = await appliedMigrations(h);
      const e = await h.migrate().then(() => null, (err: unknown) => err);
      expect(e, 'migration 0016 must stop').not.toBeNull();
      const text = errorText(e);
      expect(text).toContain('Migration 0016 (REM-5) stopped: this database still holds data from removed features:');
      expect(text).toContain(line);
      expect(text).toContain('Nothing was changed.');
      // Nothing changed: still at 0015, deprecated objects still there.
      expect(await appliedMigrations(h)).toBe(before);
      expect(before).toBe(16);
      expect(await exists(h, 'expenses')).toBe(true);
      expect((await run(h, `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'jewelry_items' AND column_name = 'total_cost'`))[0].n).toBe(PG_MODE ? '1' : 1);
    } finally {
      await h.close();
    }
  });

  it('stops on an old demo-like database with every legacy kind at once, listing each (message printed below)', async () => {
    const h = await openAt15();
    try {
      await run(h, BASE);
      // Every kind together (the counter-session line brings its withdrawal and session; the mock withdrawal its customer).
      const all = LEGACY.filter((l) => !['a Hasad withdrawal', 'a Hasad counter session', 'a mock Hasad customer'].includes(l.kind));
      for (const l of all) await run(h, l.sql);
      const e = await h.migrate().then(() => null, (err: unknown) => err);
      // The database's own error (drizzle wraps it; its message also quotes the failed SQL).
      const message = String((e as { cause?: Error }).cause?.message ?? (e as Error).message);
      console.log(`\n--- guard message (REM-5 legacy database) ---\n${message.trim()}\n---`);
      for (const l of LEGACY) expect(message, l.kind).toContain(l.line.replace(/: 1$/, ':'));
      expect(await appliedMigrations(h)).toBe(16);
    } finally {
      await h.close();
    }
  });

  it('upgrades a clean database and keeps the HASAD sale, its references, the receivable settlement and REVERSAL', async () => {
    const h = await openAt15();
    try {
      await run(h, BASE);
      await run(
        h,
        `INSERT INTO sales (number, branch_id, cashier_id, subtotal, total, cost_total, payment_method, payment_ref_invoice, payment_ref_transaction)
           VALUES ('S-1', ${ids}, ${uid}, 2000, 2000, 1000, 'HASAD', 'HS-INV-1', 'HS-TX-1');
         INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, payment_method, ref_type, ref_id, ref_number)
           SELECT id, branch_id, 2000, 'SALE', 'HASAD', 'sale', (SELECT id FROM sales WHERE number = 'S-1'), 'S-1' FROM ledger_accounts WHERE kind = 'HASAD_RECEIVABLE';
         INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, ref_type, ref_id, reverses_entry_id)
           SELECT account_id, branch_id, -2000, 'REVERSAL', 'sale', ref_id, id FROM ledger_entries WHERE ref_number = 'S-1';
         INSERT INTO hasad_receivable_settlements (number, branch_id, amount, actor_id) VALUES ('HRS-1', ${ids}, 500, ${uid});
         INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, ref_type, ref_id)
           SELECT id, branch_id, -500, 'HASAD_RECEIVABLE_SETTLEMENT', 'hasad_receivable_settlement', 1 FROM ledger_accounts WHERE kind = 'HASAD_RECEIVABLE';`,
      );
      expect((await run(h, `SELECT count(*) AS n FROM settings WHERE key = 'hasad.enabledPerBranch'`))[0].n).toBe(PG_MODE ? '1' : 1);
      await h.migrate();
      // Every migration of the repository (0016 and the later ones) applies on top of the clean 0015 database.
      expect(await appliedMigrations(h)).toBe(JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')).entries.length);
      const [sale] = await run(h, `SELECT payment_method, payment_ref_invoice, payment_ref_transaction FROM sales WHERE number = 'S-1'`);
      expect(sale).toEqual({ payment_method: 'HASAD', payment_ref_invoice: 'HS-INV-1', payment_ref_transaction: 'HS-TX-1' });
      const events = (await run(h, `SELECT event_type FROM ledger_entries ORDER BY id`)).map((r) => r.event_type);
      expect(events).toEqual(['SALE', 'REVERSAL', 'HASAD_RECEIVABLE_SETTLEMENT']);
      expect((await run(h, `SELECT count(*) AS n FROM hasad_receivable_settlements`))[0].n).toBe(PG_MODE ? '1' : 1);
      const [piece] = await run(h, `SELECT acquisition_cost, status FROM jewelry_items WHERE code = 'J-1'`);
      expect(piece).toEqual({ acquisition_cost: PG_MODE ? '1000' : 1000, status: 'AVAILABLE' });
      expect(await run(h, `SELECT key FROM settings WHERE key = 'hasad.enabledPerBranch'`)).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
