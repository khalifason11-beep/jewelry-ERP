// MKC-1 migration 0022 on a database migrated up to 0021 (both projects: PGlite and real PostgreSQL). Hand-written SQL
// proven statement by statement:
//   * the guard stops on any supplier order whose making charge was paid from branch money, counting each kind
//     (a: drawer, b: bank, c: a charge of 0 with a source, d: before Phase 4), and points to DEPLOYMENT "MKC-1";
//   * a stop changes NOTHING: no new column, the old check, and every role's purchases.create grant still there
//     (the permission deletion runs only after the guard passes, in the same transaction);
//   * a clean upgrade adds the two columns, validates the checks, and leaves purchases.create to the General Manager
//     alone (a custom role loses it too, owner decision Q9).

import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { PG_MODE } from './helpers';
import { one, openAt, run, upTo } from './migration-harness';

const BASE = `
  INSERT INTO roles (code, name, name_ar) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام') ON CONFLICT DO NOTHING;
  INSERT INTO roles (code, name, name_ar) VALUES ('BRANCH_MANAGER', 'Branch Manager', 'مدير فرع') ON CONFLICT DO NOTHING;
  INSERT INTO roles (code, name, name_ar) VALUES ('TRIAL_CUSTOM', 'Trial custom role', 'دور تجريبي') ON CONFLICT DO NOTHING;
  INSERT INTO permissions (code, description) VALUES ('purchases.create', 'Record purchases') ON CONFLICT DO NOTHING;
  INSERT INTO permissions (code, description) VALUES ('purchases.view', 'View purchases') ON CONFLICT DO NOTHING;
  INSERT INTO role_permissions (role_id, permission_code) SELECT id, 'purchases.create' FROM roles WHERE code IN ('GENERAL_MANAGER', 'BRANCH_MANAGER', 'TRIAL_CUSTOM') ON CONFLICT DO NOTHING;
  INSERT INTO role_permissions (role_id, permission_code) SELECT id, 'purchases.view' FROM roles WHERE code IN ('GENERAL_MANAGER', 'BRANCH_MANAGER') ON CONFLICT DO NOTHING;
  INSERT INTO users (username, full_name, role_id, password_hash) SELECT 'trial.person', 'Trial', id, 'x' FROM roles WHERE code = 'GENERAL_MANAGER';
  INSERT INTO branches (code, name, name_ar, city) VALUES ('TRL', 'Trial', 'تجربة', 'City')
`;
/** A supplier order of before MKC-1: its making charge paid from `from` (NULL = before Phase 4). */
const order = (number: string, from: 'CASH' | 'BANK' | null, paid: number | null) => `
  INSERT INTO purchases (number, branch_id, item_count, total_net_weight_mg, total_cost, created_by, making_charge_paid, making_charge_paid_from)
  SELECT '${number}', b.id, 1, 4000, 900000, u.id, ${paid === null ? 'NULL' : paid}, ${from === null ? 'NULL' : `'${from}'`}
  FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`;
const applied = async (h: DatabaseHandle) => Number((await one(h, 'SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).n);
const grants = async (h: DatabaseHandle) =>
  (await run(h, `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_code = 'purchases.create' ORDER BY r.code`)).map((r) => r.code);
const hasColumn = async (h: DatabaseHandle) =>
  Number((await one(h, `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'making_charge_reference'`)).n) > 0;

describe('migration 0022 (MKC-1)', () => {
  beforeAll(() => {
    upTo(21);
  });

  it('the guard stops on orders paid from branch money, counts each kind, points to DEPLOYMENT "MKC-1", and changes nothing', async () => {
    const h = await openAt(21);
    try {
      await run(h, BASE);
      await run(h, order('TRL-PO-1', 'CASH', 50_000)); // (a)
      await run(h, order('TRL-PO-2', 'CASH', 70_000)); // (a)
      await run(h, order('TRL-PO-3', 'BANK', 40_000)); // (b)
      await run(h, order('TRL-PO-4', 'CASH', 0)); // (c)
      await run(h, order('TRL-PO-5', null, null)); // (d)
      const before = await applied(h);
      const e = await h.migrate().then(() => null, (x: unknown) => x);
      expect(e, 'migration 0022 must stop').not.toBeNull();
      const message = String((e as { cause?: Error }).cause?.message ?? (e as Error).message);
      expect(message).toContain('Migration 0022 (MKC-1) stopped: this database holds 5 supplier order(s)');
      expect(message).toContain('2 paid from the drawer, 1 paid from the bank (no transfer reference), 1 with a charge of 0 and a branch source, 1 recorded before Phase 4.');
      expect(message).toContain('Nothing was changed.');
      const hint = String((e as { cause?: { hint?: string } }).cause?.hint ?? (e as { hint?: string }).hint ?? '');
      if (PG_MODE) expect(hint).toBe('docs/DEPLOYMENT.md, section "MKC-1".');
      // Nothing changed: no migration recorded, no column, the old check, and every grant still there.
      expect(await applied(h)).toBe(before);
      expect(await hasColumn(h)).toBe(false);
      expect(await grants(h)).toEqual(['BRANCH_MANAGER', 'GENERAL_MANAGER', 'TRIAL_CUSTOM']);
      expect(String((await one(h, `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ck_purchases_making_charge_paid_from'`))?.d)).toContain('CASH');
    } finally {
      await h.close();
    }
  });

  it('each kind alone stops it too', async () => {
    for (const [from, paid, text] of [
      ['CASH', 10_000, '1 paid from the drawer'],
      ['BANK', 10_000, '1 paid from the bank'],
      ['BANK', 0, '1 with a charge of 0 and a branch source'],
      [null, null, '1 recorded before Phase 4'],
    ] as const) {
      const h = await openAt(21);
      try {
        await run(h, BASE);
        await run(h, order('TRL-PO-9', from, paid));
        const e = await h.migrate().then(() => null, (x: unknown) => x);
        expect(String((e as { cause?: Error })?.cause?.message ?? (e as Error)?.message), String(from)).toContain(text);
        expect(await grants(h)).toContain('BRANCH_MANAGER');
      } finally {
        await h.close();
      }
    }
  });

  it('upgrades a database with no supplier order: columns, validated checks, purchases.create left to the General Manager only', async () => {
    const h = await openAt(21);
    try {
      await run(h, BASE);
      await h.migrate();
      expect(await hasColumn(h)).toBe(true);
      expect(await grants(h)).toEqual(['GENERAL_MANAGER']);
      // Other grants are untouched.
      expect((await run(h, `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_code = 'purchases.view' ORDER BY r.code`)).map((r) => r.code)).toEqual(['BRANCH_MANAGER', 'GENERAL_MANAGER']);
      for (const c of ['ck_purchases_making_charge_paid_from', 'ck_purchases_making_charge_transfer']) {
        expect((await one(h, `SELECT convalidated AS v FROM pg_constraint WHERE conname = '${c}'`))?.v, c).toBe(true);
      }
      const insert = (from: string, paid: number, ref: string | null, date: string | null) =>
        run(h, `INSERT INTO purchases (number, branch_id, item_count, total_net_weight_mg, total_cost, created_by, making_charge_paid, making_charge_paid_from, making_charge_reference, making_charge_transfer_date)
          SELECT 'TRL-PO-${Math.random().toString(36).slice(2, 8)}', b.id, 1, 4000, 900000, u.id, ${paid}, '${from}', ${ref ? `'${ref}'` : 'NULL'}, ${date ? `'${date}'` : 'NULL'}
          FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`).then(() => null, (x: Error & { cause?: Error }) => `${x.message} ${x.cause?.message ?? ''}`);
      expect(await insert('OWNER_PERSONAL', 50_000, 'TRF-0001', '2026-01-01')).toBeNull();
      expect(await insert('OWNER_PERSONAL', 0, null, null)).toBeNull();
      expect(await insert('CASH', 50_000, 'TRF-0002', '2026-01-01')).toContain('ck_purchases_making_charge_paid_from');
      expect(await insert('OWNER_PERSONAL', 50_000, null, '2026-01-01')).toContain('ck_purchases_making_charge_transfer');
      expect(await insert('OWNER_PERSONAL', 50_000, 'TRF-0003', null)).toContain('ck_purchases_making_charge_transfer');
      expect(await insert('OWNER_PERSONAL', 0, 'TRF-0004', '2026-01-01')).toContain('ck_purchases_making_charge_transfer');
    } finally {
      await h.close();
    }
  });
});
