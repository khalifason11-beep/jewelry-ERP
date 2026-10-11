// CSH-2 migrations on a database migrated up to the previous migration (both projects; the append-only trigger
// checks of 0021 run on real PostgreSQL too). Hand-written SQL is proven here, statement by statement:
//   0020: existing branches receive an EMPTY OWED_TO_GM account (no ledger entry invented, D-2b-8), new branches get
//         one from the trigger, the two event types are allowed, the checks are validated, the GM gets the permissions.
//   0021: two guards stop the migration, changing nothing (a: a purchase that disagrees with its ledger entries; b: a
//         bank-paid purchase, which has no reference); otherwise the parts are backfilled from each row's own method,
//         the checks are validated and the append-only trigger is enabled again (an UPDATE is refused afterwards).

import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { PG_MODE } from './helpers';
import { one, openAt, run, upTo } from './migration-harness';

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

// ── 0021: split payment on scrap purchases, on a database at 0020 ──
const scrapRow = (number: string, method: string, amount: number) => `
  INSERT INTO scrap_purchases (number, branch_id, kind, karat, gross_weight_mg, net_weight_mg, scrap_rate_per_gram, agreed_rate_per_gram, deviation_bp, amount, payment_method, created_by)
    SELECT '${number}', b.id, 'BROKEN', 21, 1000, 1000, ${amount}, ${amount}, 0, ${amount}, '${method}', u.id FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`;
const scrapEntry = (number: string, kind: string, amount: number) => `
  INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, payment_method, ref_type, ref_id, ref_number)
    SELECT a.id, a.branch_id, ${amount}, 'SCRAP_PURCHASE', '${kind === 'CASH' ? 'CASH' : 'BANK_TRANSFER'}', 'scrap_purchase', p.id, p.number
    FROM scrap_purchases p JOIN ledger_accounts a ON a.branch_id = p.branch_id AND a.kind = '${kind}' WHERE p.number = '${number}'`;
const applied = async (h: DatabaseHandle) => Number((await one(h, 'SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).n);
const stopsWith = async (h: DatabaseHandle, text: string) => {
  const before = await applied(h);
  const e = await h.migrate().then(() => null, (x: unknown) => x);
  expect(e, 'migration 0021 must stop').not.toBeNull();
  const message = String((e as { cause?: Error }).cause?.message ?? (e as Error).message);
  expect(message).toContain(text);
  expect(message).toContain('Nothing was changed.');
  expect(await applied(h)).toBe(before);
  expect(Number((await one(h, `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'scrap_purchases' AND column_name = 'cash_amount'`)).n)).toBe(0);
};

describe('migration 0021 (CSH-2 piece A)', () => {
  beforeAll(() => {
    upTo(20);
  });

  it('guard (a): stops, changing nothing, when a purchase does not match its ledger entries', async () => {
    const h = await openAt(20);
    try {
      await run(h, BASE);
      await run(h, scrapRow('TRL-SCR-1', 'CASH', 95_000));
      await run(h, scrapEntry('TRL-SCR-1', 'BANK', -95_000)); // recorded as cash, but the money left the bank
      await stopsWith(h, 'do not match their entries in the money ledger');
    } finally {
      await h.close();
    }
  });

  it('guard (b): stops, changing nothing, on a bank-paid purchase (it has no bank reference)', async () => {
    const h = await openAt(20);
    try {
      await run(h, BASE);
      await run(h, scrapRow('TRL-SCR-2', 'BANK_TRANSFER', 80_000));
      await run(h, scrapEntry('TRL-SCR-2', 'BANK', -80_000));
      await stopsWith(h, 'paid by bank transfer have no bank reference');
    } finally {
      await h.close();
    }
  });

  it('upgrades a clean database: parts backfilled from the method, checks validated, the append-only trigger enabled again', async () => {
    const h = await openAt(20);
    try {
      await run(h, BASE);
      await run(h, scrapRow('TRL-SCR-3', 'CASH', 120_000));
      await run(h, scrapEntry('TRL-SCR-3', 'CASH', -120_000));
      await h.migrate();
      expect(await one(h, `SELECT cash_amount::int AS c, bank_amount::int AS b, bank_reference AS r, payment_method AS m FROM scrap_purchases WHERE number = 'TRL-SCR-3'`)).toEqual({ c: 120_000, b: 0, r: null, m: 'CASH' });
      for (const c of ['ck_scrap_purchases_payment_parts', 'ck_scrap_purchases_payment_label', 'ck_scrap_purchases_bank_reference', 'ck_scrap_purchases_payment_method']) {
        expect((await one(h, `SELECT convalidated AS v FROM pg_constraint WHERE conname = '${c}'`))?.v, c).toBe(true);
      }
      // The trigger is enabled again ('O' = fires on origin): an UPDATE of the append-only table is refused.
      expect((await one(h, `SELECT tgenabled AS e FROM pg_trigger WHERE tgname = 'scrap_purchases_append_only'`))?.e).toBe('O');
      const e = await run(h, `UPDATE scrap_purchases SET cash_amount = 0 WHERE number = 'TRL-SCR-3'`).then(() => null, (x: unknown) => x);
      expect(e, 'an UPDATE after the migration must be refused').not.toBeNull();
      expect(String((e as { cause?: Error })?.cause?.message ?? (e as Error)?.message)).toMatch(/append-only|permission denied/);
      // On real PostgreSQL the migrating role (not a superuser) holds no UPDATE privilege on the table again.
      if (PG_MODE) expect((await one(h, `SELECT has_table_privilege(current_user, 'scrap_purchases', 'UPDATE') AS u`))?.u).toBe(false);
      // A split row goes in; an inconsistent one does not.
      await run(h, `INSERT INTO scrap_purchases (number, branch_id, kind, karat, gross_weight_mg, net_weight_mg, scrap_rate_per_gram, agreed_rate_per_gram, deviation_bp, amount, payment_method, cash_amount, bank_amount, bank_reference, created_by)
        SELECT 'TRL-SCR-4', b.id, 'BROKEN', 21, 1000, 1000, 100000, 100000, 0, 100000, 'SPLIT', 60000, 40000, 'TRF-4', u.id FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`);
      const bad = await run(h, `INSERT INTO scrap_purchases (number, branch_id, kind, karat, gross_weight_mg, net_weight_mg, scrap_rate_per_gram, agreed_rate_per_gram, deviation_bp, amount, payment_method, cash_amount, bank_amount, created_by)
        SELECT 'TRL-SCR-5', b.id, 'BROKEN', 21, 1000, 1000, 100000, 100000, 0, 100000, 'SPLIT', 60000, 40000, u.id FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`).then(() => null, (x: unknown) => x);
      expect(bad, 'a bank part without its reference is refused').not.toBeNull();
    } finally {
      await h.close();
    }
  });
});
