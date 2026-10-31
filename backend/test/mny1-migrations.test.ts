// MNY-1 migration 0038 on a database migrated up to 0037 that already holds branches, ledger entries (sales, an advance)
// and the three roles (both projects):
//   * nothing that exists changes (ledger entries and balances, role grants of other permissions);
//   * the permissions: the branch manager gets money_transfers.view, .send and .receive; the General Manager .view and
//     .receive, never .send (D-mny1-2); the cashier none;
//   * the ledger accepts the four MONEY_TRANSFER event types and still refuses an unknown one;
//   * `money_transfers`: its checks (receiver, amount, reason, bank reference iff BANK, values); only the status moves,
//     once, from IN_TRANSIT; no other column changes; never deleted;
//   * `money_transfer_events`: its shape per kind; one SENT and at most one closing step per transfer; append-only.

import { describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { DEFAULT_ROLE_PERMISSIONS, NOT_FOR_GENERAL_MANAGER } from '@jerp/shared';
import { one, openAt, run } from './migration-harness';

const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);

async function seed(h: DatabaseHandle) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const role = (code: string, rank: number) => id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('${code}', '${code}', '${code}', true, ${rank}) RETURNING id`);
  const gmRole = await role('GENERAL_MANAGER', 100);
  await role('BRANCH_MANAGER', 50);
  await role('CASHIER', 10);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const b = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPB', '[Test] B', '[اختبار] ب', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${gmRole}, 'x', false) RETURNING id`);
  const account = async (branch: number, kind: string) => Number((await one(h, `SELECT id FROM ledger_accounts WHERE branch_id = ${branch} AND kind = '${kind}'`)).id);
  const entry = (branch: number, kind: string, amount: number, type: string) =>
    account(branch, kind).then((acc) => run(h, `INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, ref_type, ref_id) VALUES (${acc}, ${branch}, ${amount}, '${type}', 'test', 1)`));
  await entry(a, 'CASH', 500_000, 'SALE');
  await entry(a, 'CASH', 200_000, 'GM_ADVANCE');
  await entry(a, 'OWED_TO_GM', 200_000, 'GM_ADVANCE');
  await entry(b, 'BANK', 300_000, 'SALE');
  return { gm, a, b, cash: await account(a, 'CASH') };
}

const snapshot = async (h: DatabaseHandle) => ({
  entries: await run(h, `SELECT id, account_id, branch_id, amount, event_type FROM ledger_entries ORDER BY id`),
  balances: await run(h, `SELECT a.branch_id, a.kind, coalesce(sum(e.amount), 0)::bigint AS b FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.branch_id, a.kind ORDER BY a.branch_id, a.kind`),
  grants: await run(h, `SELECT r.code, rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY r.code, rp.permission_code`),
});

describe('migration 0038 (MNY-1) on a database at 0037 with money in the ledger', () => {
  it('changes nothing that exists; grants, checks, triggers and append-only hold', async () => {
    const h = await openAt(37);
    try {
      const s = await seed(h);
      const before = await snapshot(h);
      await h.migrate();
      const after = await snapshot(h);
      expect(after.entries).toEqual(before.entries);
      expect(after.balances).toEqual(before.balances);
      const isMoney = (g: Record<string, unknown>) => String(g.permission_code).startsWith('money_transfers.');
      expect(after.grants.filter((g) => !isMoney(g))).toEqual(before.grants);
      expect(after.grants.filter(isMoney).map((g) => `${g.code} ${g.permission_code}`)).toEqual([
        'BRANCH_MANAGER money_transfers.receive',
        'BRANCH_MANAGER money_transfers.send',
        'BRANCH_MANAGER money_transfers.view',
        'GENERAL_MANAGER money_transfers.receive',
        'GENERAL_MANAGER money_transfers.view',
      ]);

      // The ledger: the four new event types, and nothing else.
      const ledger = (type: string) => `INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, ref_type, ref_id) VALUES (${s.cash}, ${s.a}, 1, '${type}', 'money_transfer', 1)`;
      for (const type of ['MONEY_TRANSFER_SENT', 'MONEY_TRANSFER_RECEIVED', 'MONEY_TRANSFER_TO_GM']) expect(await refused(h, ledger(type)), type).toBe(false);
      expect(await refused(h, ledger('MONEY_TRANSFER_LOST'))).toBe(true);
      // A cancel must reverse an entry; a send may not.
      const lastId = Number((await one(h, `SELECT max(id) AS id FROM ledger_entries`)).id);
      const reversing = (type: string, rev: string) => `INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, ref_type, ref_id, reverses_entry_id) VALUES (${s.cash}, ${s.a}, -1, '${type}', 'money_transfer', 1, ${rev})`;
      expect(await refused(h, reversing('MONEY_TRANSFER_CANCELLED', 'NULL'))).toBe(true);
      expect(await refused(h, reversing('MONEY_TRANSFER_SENT', String(lastId)))).toBe(true);
      expect(await refused(h, reversing('MONEY_TRANSFER_CANCELLED', String(lastId)))).toBe(false);

      // The head of a transfer.
      let n = 0;
      const transfer = (o: Partial<Record<string, string | number>>) => {
        n += 1;
        const v = { from: s.a, kind: `'BRANCH'`, to: s.b, account: `'CASH'`, amount: 100_000, reason: `'advance for the day'`, ref: 'NULL', status: `'IN_TRANSIT'`, ...o };
        return `INSERT INTO money_transfers (number, from_branch_id, to_kind, to_branch_id, source_account, amount, reason, bank_reference, status, created_by)
                VALUES ('UPA-MT-${String(n).padStart(6, '0')}', ${v.from}, ${v.kind}, ${v.to}, ${v.account}, ${v.amount}, ${v.reason}, ${v.ref}, ${v.status}, ${s.gm}) RETURNING id`;
      };
      expect(await refused(h, transfer({ to: s.a }))).toBe(true); // to itself
      expect(await refused(h, transfer({ kind: `'GM'` }))).toBe(true); // to the GM with a branch
      expect(await refused(h, transfer({ to: 'NULL' }))).toBe(true); // to a branch without one
      expect(await refused(h, transfer({ kind: `'HQ'`, to: 'NULL' }))).toBe(true);
      expect(await refused(h, transfer({ amount: 0 }))).toBe(true);
      expect(await refused(h, transfer({ reason: `'  x '` }))).toBe(true);
      expect(await refused(h, transfer({ reason: `'${'x'.repeat(301)}'` }))).toBe(true);
      expect(await refused(h, transfer({ account: `'BANK'` }))).toBe(true); // BANK without its reference
      expect(await refused(h, transfer({ ref: `'REF1234'` }))).toBe(true); // a reference on CASH
      expect(await refused(h, transfer({ status: `'DISPUTED'` }))).toBe(true);
      const t1 = Number((await one(h, transfer({}))).id);
      const t2 = Number((await one(h, transfer({ kind: `'GM'`, to: 'NULL', account: `'BANK'`, ref: `'REF1234'` }))).id);
      expect(await refused(h, `UPDATE money_transfers SET amount = 1 WHERE id = ${t1}`)).toBe(true);
      expect(await refused(h, `UPDATE money_transfers SET reason = 'another reason' WHERE id = ${t1}`)).toBe(true);
      expect(await refused(h, `UPDATE money_transfers SET to_branch_id = NULL, to_kind = 'GM' WHERE id = ${t1}`)).toBe(true);
      expect(await refused(h, `UPDATE money_transfers SET status = 'RECEIVED' WHERE id = ${t1}`)).toBe(false);
      expect(await refused(h, `UPDATE money_transfers SET status = 'CANCELLED' WHERE id = ${t1}`)).toBe(true); // final
      expect(await refused(h, `UPDATE money_transfers SET status = 'IN_TRANSIT' WHERE id = ${t1}`)).toBe(true);
      expect(await refused(h, `UPDATE money_transfers SET status = 'CANCELLED' WHERE id = ${t2}`)).toBe(false);
      expect(await refused(h, `DELETE FROM money_transfers WHERE id = ${t2}`)).toBe(true);
      expect(await refused(h, `TRUNCATE money_transfers CASCADE`)).toBe(true);

      // The steps.
      const step = (o: Partial<Record<string, string | number>>) => {
        const v = { t: t1, kind: `'SENT'`, account: 'NULL', ref: 'NULL', reason: 'NULL', ...o };
        return `INSERT INTO money_transfer_events (transfer_id, kind, account, bank_reference, reason, actor_id) VALUES (${v.t}, ${v.kind}, ${v.account}, ${v.ref}, ${v.reason}, ${s.gm})`;
      };
      expect(await refused(h, step({ kind: `'DISPUTED'` }))).toBe(true);
      expect(await refused(h, step({ account: `'CASH'` }))).toBe(true); // SENT with an account
      expect(await refused(h, step({}))).toBe(false);
      expect(await refused(h, step({}))).toBe(true); // a second SENT
      expect(await refused(h, step({ kind: `'RECEIVED'`, account: `'BANK'` }))).toBe(true); // BANK without its reference
      expect(await refused(h, step({ kind: `'CANCELLED'` }))).toBe(true); // a cancel without its reason
      expect(await refused(h, step({ kind: `'RECEIVED'`, account: `'CASH'` }))).toBe(false);
      expect(await refused(h, step({ kind: `'CANCELLED'`, reason: `'sent by mistake'` }))).toBe(true); // already closed
      expect(await refused(h, step({ t: t2 }))).toBe(false);
      expect(await refused(h, step({ t: t2, kind: `'RECEIVED'` }))).toBe(false); // the General Manager confirms: no account
      expect(await refused(h, `UPDATE money_transfer_events SET reason = 'x'`)).toBe(true);
      expect(await refused(h, `DELETE FROM money_transfer_events`)).toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe('D-mny1-2: the default role grants', () => {
  it('the General Manager never holds money_transfers.send; the branch manager holds all three; the cashier none', () => {
    expect(NOT_FOR_GENERAL_MANAGER).toEqual(['money_transfers.send']);
    for (const p of NOT_FOR_GENERAL_MANAGER) expect(DEFAULT_ROLE_PERMISSIONS.GENERAL_MANAGER).not.toContain(p);
    expect(DEFAULT_ROLE_PERMISSIONS.GENERAL_MANAGER).toEqual(expect.arrayContaining(['money_transfers.view', 'money_transfers.receive']));
    expect(DEFAULT_ROLE_PERMISSIONS.BRANCH_MANAGER).toEqual(expect.arrayContaining(['money_transfers.view', 'money_transfers.send', 'money_transfers.receive']));
    expect(DEFAULT_ROLE_PERMISSIONS.CASHIER.filter((p) => p.startsWith('money_transfers.'))).toEqual([]);
  });
});
