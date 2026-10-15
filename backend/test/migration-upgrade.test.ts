// SAFE-1 part 2: a database created at an OLD schema version, holding realistic data, upgrades cleanly to the current
// schema. Both projects; the real-PostgreSQL run is the one that matters (it is what a server upgrade does).
//
// For each starting version (0015 = before REM-5's drops, 0019 = before CSH-2 and MKC-1): migrate to it, seed rows in
// the tables later migrations touch, snapshot counts and money/weight totals, apply ALL remaining migrations, then:
// row counts unchanged, totals and ledger balances identical, the append-only triggers present and still refusing
// UPDATE/DELETE, no constraint left NOT VALID, and the app answers /api/health on the upgraded database. A second
// migrate run is a no-op.
//
// The fixture holds no supplier orders on purpose: migration 0022 refuses, by design, any database with orders paid
// from branch money, which every order before 0022 is (D-mkc-5; tested in mkc1-migrations.test.ts). The other guards
// are respected the way real data would be: bank sales carry a reference (0018), scrap is paid in cash with its ledger
// entry (0021), the old item cost columns agree with acquisition_cost (0016).

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { MIGRATIONS_DIR, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { APPEND_ONLY_TABLES, unvalidatedConstraints } from '../src/core/startup';
import { one, openAt, rowsOf, run } from './migration-harness';

const columnsOf = async (h: DatabaseHandle, table: string) =>
  new Set(rowsOf<{ c: string }>(await h.db.execute(sql`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`)).map((r) => r.c));

/** INSERT the given columns that exist at this schema version; returns the new id. */
async function insert(h: DatabaseHandle, table: string, row: Record<string, unknown>, returning = 'id'): Promise<number> {
  const have = await columnsOf(h, table);
  const keys = Object.keys(row).filter((k) => have.has(k));
  const lit = (v: unknown) => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb` : `'${String(v).replace(/'/g, "''")}'`);
  const q = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((k) => lit(row[k])).join(', ')}) RETURNING ${returning}`;
  const r = await one(h, q);
  return Number(r[returning]);
}

const account = async (h: DatabaseHandle, branchId: number, kind: string) => Number((await one(h, `SELECT id FROM ledger_accounts WHERE branch_id = ${branchId} AND kind = '${kind}'`)).id);

async function seed(h: DatabaseHandle) {
  const role = await insert(h, 'roles', { code: 'GENERAL_MANAGER', name: 'General Manager', name_ar: 'المدير العام', is_system: true, rank: 100 });
  const role2 = await insert(h, 'roles', { code: 'CASHIER', name: 'Cashier', name_ar: 'كاشير', is_system: true, rank: 10 });
  const krt = await insert(h, 'branches', { code: 'UPA', name: '[Test] Branch A', name_ar: '[اختبار] فرع أ', city: '[Test] City' });
  const omd = await insert(h, 'branches', { code: 'UPB', name: '[Test] Branch B', name_ar: '[اختبار] فرع ب', city: '[Test] City' });
  const gm = await insert(h, 'users', { username: 'upgrade.alpha', full_name: '[Test] GM', role_id: role, password_hash: '$argon2id$v=19$m=19456,t=2,p=1$x$y', must_change_password: false });
  const cashier = await insert(h, 'users', { username: 'upgrade.bravo', full_name: '[Test] Cashier', role_id: role2, branch_id: krt, password_hash: '$argon2id$v=19$m=19456,t=2,p=1$x$z' });
  await insert(h, 'sessions', { id: 'sess-upgrade-1', user_id: gm, status: 'ACTIVE' }, 'id');
  await insert(h, 'sessions', { id: 'sess-upgrade-2', user_id: cashier, branch_id: krt, status: 'LOGGED_OUT' }, 'id');
  await insert(h, 'webauthn_credentials', { user_id: gm, credential_id: 'cred-upgrade-1', public_key: 'pk-bytes', nickname: 'Shop PC', uv_at_registration: true });
  await insert(h, 'recovery_codes', { user_id: gm, code_hash: 'h1', generated_at: '2026-01-01T00:00:00Z' });
  await insert(h, 'recovery_codes', { user_id: gm, code_hash: 'h2', generated_at: '2026-01-01T00:00:00Z' });
  await insert(h, 'settings', { key: 'company.nameEn', value: JSON.stringify('[Test] Company') }, 'key');
  await insert(h, 'gold_rates', { karat: 21, price_per_gram: 190_000, set_by: gm });
  await insert(h, 'scrap_rates', { karat: 21, price_per_gram: 150_000, set_by: gm });
  const cat = await insert(h, 'categories', { code: 'RING', name: 'Rings', name_ar: '[اختبار] خواتم' });
  const prod = await insert(h, 'products', { sku: 'UP-21-1', name: 'Ring', name_ar: '[اختبار] خاتم', category_id: cat, karat: 21 });
  await insert(h, 'suppliers', { name: '[Test] Supplier', name_ar: '[اختبار] مورد' });

  // Four pieces: two sold (cash, bank transfer), one available, one transferred to branch B.
  const items: number[] = [];
  for (let i = 0; i < 4; i++) {
    const cost = 800_000 + i * 10_000;
    const id = await insert(h, 'jewelry_items', {
      code: `J-9${i}`, barcode: `62810000999${i}`, product_id: prod, karat: 21, gross_weight_mg: 4_100 + i, net_weight_mg: 4_000 + i,
      purchase_cost: cost, making_cost: 0, other_cost: 0, total_cost: cost, acquisition_cost: cost, origin: 'OPENING', cost_is_estimated: false,
      selling_price: 1_200_000 + i * 10_000, branch_id: krt, status: i < 2 ? 'SOLD' : 'AVAILABLE',
    });
    items.push(id);
    await insert(h, 'item_status_history', { item_id: id, from_status: null, to_status: 'AVAILABLE', branch_id: krt, user_id: gm, note: 'opening' });
    await insert(h, 'inventory_movements', { item_id: id, branch_id: krt, type: 'ADJUSTMENT', direction: 1, net_weight_mg: 4_000 + i, cost_value: cost, user_id: gm, ref_type: 'opening', ref_id: id });
  }
  const sale = async (n: number, item: number, method: string, ref: string | null) => {
    const price = 1_200_000 + n * 10_000;
    const cost = 800_000 + n * 10_000;
    const s = await insert(h, 'sales', { number: `UPA-INV-00000${n + 1}`, branch_id: krt, cashier_id: cashier, subtotal: price, discount_total: 0, total: price, cost_total: cost, payment_method: method, status: 'COMPLETED', payment_ref_transaction: ref });
    await insert(h, 'sale_items', { sale_id: s, item_id: item, product_name: 'Ring', karat: 21, net_weight_mg: 4_000 + n, list_price: price, discount: 0, final_price: price, unit_cost: cost, acquisition_cost: cost, profit: price - cost, pricing_mode: 'FIXED_TAG' });
    await insert(h, 'item_status_history', { item_id: item, from_status: 'AVAILABLE', to_status: 'SOLD', branch_id: krt, user_id: cashier, ref_type: 'sale', ref_id: s });
    await insert(h, 'inventory_movements', { item_id: item, branch_id: krt, type: 'SALE', direction: -1, net_weight_mg: 4_000 + n, cost_value: cost, user_id: cashier, ref_type: 'sale', ref_id: s });
    await insert(h, 'ledger_entries', { account_id: await account(h, krt, method === 'CASH' ? 'CASH' : 'BANK'), branch_id: krt, amount: price, event_type: 'SALE', payment_method: method, ref_type: 'sale', ref_id: s, actor_id: cashier });
  };
  await sale(0, items[0], 'CASH', null);
  await sale(1, items[1], 'BANK_TRANSFER', 'TRF-UPGRADE-0001');

  // A cash scrap purchase of broken scrap, its pool weight and its ledger entry (guard 0021: they agree).
  const scrap = await insert(h, 'scrap_purchases', { number: 'UPA-SCR-000001', branch_id: krt, kind: 'BROKEN', karat: 21, gross_weight_mg: 2_000, net_weight_mg: 2_000, scrap_rate_per_gram: 150_000, agreed_rate_per_gram: 150_000, deviation_bp: 0, override_approved: false, amount: 300_000, payment_method: 'CASH', created_by: gm });
  await insert(h, 'scrap_weight_entries', { branch_id: krt, karat: 21, weight_mg: 2_000, event_type: 'SCRAP_PURCHASE', ref_type: 'scrap_purchase', ref_id: scrap, actor_id: gm });
  await insert(h, 'ledger_entries', { account_id: await account(h, krt, 'CASH'), branch_id: krt, amount: -300_000, event_type: 'SCRAP_PURCHASE', payment_method: 'CASH', ref_type: 'scrap_purchase', ref_id: scrap, actor_id: gm });

  // A received transfer of the fourth piece to branch B.
  const tr = await insert(h, 'transfers', { number: 'CO-TRF-000001', from_branch_id: krt, to_branch_id: omd, status: 'RECEIVED', created_by: gm, received_by: gm, received_at: '2026-01-02T10:00:00Z' });
  await run(h, `INSERT INTO transfer_items (transfer_id, item_id) VALUES (${tr}, ${items[3]})`);
  await run(h, `UPDATE jewelry_items SET branch_id = ${omd} WHERE id = ${items[3]}`);

  await insert(h, 'cash_counts', { branch_id: krt, business_day: '2026-01-02', counted_amount: 900_000, expected_amount: 900_000, counted_by: gm });
  for (const action of ['LOGIN', 'SALE_CREATED', 'SCRAP_PURCHASED']) await insert(h, 'audit_logs', { action, description: `${action} (upgrade fixture)`, user_id: gm, username: 'upgrade.alpha', branch_id: krt });
}

/** What must survive the upgrade unchanged: row counts of the seeded tables and the money / weight totals. */
async function facts(h: DatabaseHandle) {
  const tables = ['branches', 'users', 'sessions', 'webauthn_credentials', 'recovery_codes', 'categories', 'products', 'suppliers', 'jewelry_items', 'item_status_history', 'inventory_movements', 'sales', 'sale_items', 'ledger_entries', 'scrap_rates', 'scrap_purchases', 'scrap_weight_entries', 'transfers', 'transfer_items', 'cash_counts', 'audit_logs', 'gold_rates'];
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = Number((await one(h, `SELECT count(*) AS n FROM "${t}"`)).n);
  const n = async (q: string) => Number((await one(h, q)).v ?? 0);
  return {
    counts,
    salesTotal: await n(`SELECT sum(total) AS v FROM sales`),
    profit: await n(`SELECT sum(profit) AS v FROM sale_items`),
    acquisition: await n(`SELECT sum(acquisition_cost) AS v FROM jewelry_items`),
    netWeight: await n(`SELECT sum(net_weight_mg) AS v FROM jewelry_items`),
    poolWeight: await n(`SELECT sum(weight_mg) AS v FROM scrap_weight_entries`),
    scrapPaid: await n(`SELECT sum(amount) AS v FROM scrap_purchases`),
    balances: rowsOf<{ branch: string; kind: string; balance: string }>(await h.db.execute(sql.raw(`SELECT b.code AS branch, a.kind, coalesce(sum(e.amount), 0)::text AS balance FROM ledger_accounts a JOIN branches b ON b.id = a.branch_id LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY b.code, a.kind HAVING coalesce(sum(e.amount), 0) <> 0 ORDER BY 1, 2`))),
  };
}

const appliedCount = async (h: DatabaseHandle) => Number((await one(h, `SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)).n);
const refused = async (h: DatabaseHandle, q: string) => h.db.execute(sql.raw(q)).then(() => false, () => true);

async function migrateAll(h: DatabaseHandle) {
  const { migrate } = h.driver === 'postgres' ? await import('drizzle-orm/node-postgres/migrator') : await import('drizzle-orm/pglite/migrator');
  await migrate(h.db as never, { migrationsFolder: MIGRATIONS_DIR });
}

describe.each([15, 19])('upgrade from migration %i with data', (from) => {
  it('keeps every row and every total, keeps the protections, boots, and a second migrate is a no-op', async () => {
    const h = await openAt(from);
    await seed(h);
    const before = await facts(h);
    expect(before.counts.sales).toBe(2);
    expect(before.balances.length).toBeGreaterThan(0);

    await migrateAll(h);
    const total = await appliedCount(h);
    const after = await facts(h);
    expect(after).toEqual(before);

    // The append-only protections are present on every table and still refuse changes.
    for (const t of APPEND_ONLY_TABLES) {
      const triggers = Number((await one(h, `SELECT count(*) AS n FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid WHERE c.relname = '${t}' AND p.proname = 'jerp_forbid_modification'`)).n);
      expect(triggers, t).toBeGreaterThanOrEqual(2);
    }
    expect(await refused(h, `UPDATE ledger_entries SET amount = amount + 1`)).toBe(true);
    expect(await refused(h, `DELETE FROM audit_logs`)).toBe(true);
    expect(await refused(h, `UPDATE branches SET city = city`)).toBe(false); // an ordinary table still accepts updates: the check is meaningful
    expect(await unvalidatedConstraints(h.db)).toEqual([]);

    // The app boots on the upgraded database.
    const app = createApp(createContext(h), loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);

    // A second run applies nothing and changes nothing.
    await migrateAll(h);
    expect(await appliedCount(h)).toBe(total);
    expect(await facts(h)).toEqual({ ...before, counts: { ...before.counts } });
  }, 180_000);
});
