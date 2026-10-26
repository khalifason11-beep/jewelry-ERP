// PAY-1 migrations on a database migrated up to 0032 holding real sales (both projects; the general upgrade from older
// versions is in migration-upgrade.test.ts):
//   0033: the append-only table `sale_payments`, its checks, and the SPLIT label of sales.payment_method;
//   0034: one payment line per existing sale (its method, its whole total, its references, its time). Two guards stop
//         the upgrade, changing nothing: (a) a sale that disagrees with its SALE ledger entries; (b) a sale that cannot
//         make a valid line. A sale recorded before the ledger (no entry) is converted from its own method.
//   0035: at commit, every sale has 1–2 lines summing to its total and its label follows them (constraint trigger);
//         the sale's own reference checks are replaced by the lines' check.
//   0036: HSD-2. It stops, changing nothing, on any Hasad receivable history (an entry on the account, a settlement
//         record or entry, a settlement in the audit log: owner Q5); otherwise the empty receivable accounts, the
//         settlement table, the event type and the permission are removed.

import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { PERMISSIONS } from '@jerp/shared';
import { createContext } from '../src/bootstrap';
import type { Actor } from '../src/core/context';
import { printSale } from '../src/modules/print/service';
import { PG_MODE } from './helpers';
import { one, openAt, run, upTo } from './migration-harness';

const BASE = `
  INSERT INTO roles (code, name, name_ar) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام') ON CONFLICT DO NOTHING;
  INSERT INTO users (username, full_name, role_id, password_hash) SELECT 'trial.person', 'Trial', id, 'x' FROM roles WHERE code = 'GENERAL_MANAGER';
  INSERT INTO branches (code, name, name_ar, city) VALUES ('TRL', 'Trial', 'تجربة', 'City')
`;
const sale = (number: string, method: string, total: number, refs: { inv?: string; txn?: string } = {}, status = 'COMPLETED') => `
  INSERT INTO sales (number, branch_id, cashier_id, subtotal, total, cost_total, payment_method, payment_ref_invoice, payment_ref_transaction, status, created_at)
    SELECT '${number}', b.id, u.id, ${total}, ${total}, 0, '${method}', ${refs.inv ? `'${refs.inv}'` : 'NULL'}, ${refs.txn ? `'${refs.txn}'` : 'NULL'}, '${status}', '2026-10-01T09:00:00Z'
    FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`;
const entry = (number: string, kind: string, method: string, amount: number, eventType = 'SALE') => `
  INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, payment_method, ref_type, ref_id, ref_number)
    SELECT a.id, a.branch_id, ${amount}, '${eventType}', '${method}', 'sale', s.id, s.number
    FROM sales s JOIN ledger_accounts a ON a.branch_id = s.branch_id AND a.kind = '${kind}' WHERE s.number = '${number}'`;
const applied = async (h: DatabaseHandle) => Number((await one(h, 'SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).n);
const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);
const stopsWith = async (h: DatabaseHandle, text: string) => {
  const before = await applied(h);
  const e = await h.migrate().then(() => null, (x: unknown) => x);
  expect(e, 'the upgrade must stop').not.toBeNull();
  const message = String((e as { cause?: Error }).cause?.message ?? (e as Error).message);
  expect(message).toContain(text);
  expect(message).toContain('Nothing was changed.');
  expect(await applied(h)).toBe(before);
  expect(Number((await one(h, `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'sale_payments'`)).n)).toBe(0);
};

describe('PAY-1 migrations 0033–0036 on a database at 0032', () => {
  beforeAll(() => {
    upTo(32);
  });

  it('converts every existing sale into one line of its whole total, with its references; nothing else changes', async () => {
    const h = await openAt(32);
    try {
      await run(h, BASE);
      await run(h, sale('S-CASH', 'CASH', 100_000));
      await run(h, entry('S-CASH', 'CASH', 'CASH', 100_000));
      await run(h, sale('S-BANK', 'BANK_TRANSFER', 250_000, { txn: 'TRF 1234' }));
      await run(h, entry('S-BANK', 'BANK', 'BANK_TRANSFER', 250_000));
      await run(h, sale('S-CARD', 'CARD', 70_000));
      await run(h, entry('S-CARD', 'BANK', 'CARD', 70_000));
      await run(h, sale('S-OLD', 'CASH', 40_000)); // recorded before the ledger: no entry
      await run(h, sale('S-VOID', 'CASH', 90_000, {}, 'VOIDED'));
      await run(h, entry('S-VOID', 'CASH', 'CASH', 90_000));
      await run(h, entry('S-VOID', 'CASH', 'CASH', -90_000, 'SALE_VOID'));
      const salesBefore = await run(h, `SELECT number, total, payment_method, payment_ref_invoice, payment_ref_transaction, status FROM sales ORDER BY number`);
      const ledgerBefore = await run(h, `SELECT account_id, amount, event_type, payment_method FROM ledger_entries ORDER BY id`);
      await h.migrate();
      expect(await run(h, `SELECT number, total, payment_method, payment_ref_invoice, payment_ref_transaction, status FROM sales ORDER BY number`)).toEqual(salesBefore);
      expect(await run(h, `SELECT account_id, amount, event_type, payment_method FROM ledger_entries ORDER BY id`)).toEqual(ledgerBefore);
      const lines = await run(h, `SELECT s.number, p.line_no::int AS n, p.method, p.amount::int AS amount, p.ref_invoice AS inv, p.ref_transaction AS txn, p.created_at = s.created_at AS same_time
                                  FROM sale_payments p JOIN sales s ON s.id = p.sale_id ORDER BY s.number`);
      expect(lines).toEqual([
        { number: 'S-BANK', n: 1, method: 'BANK_TRANSFER', amount: 250_000, inv: null, txn: 'TRF 1234', same_time: true },
        { number: 'S-CARD', n: 1, method: 'CARD', amount: 70_000, inv: null, txn: null, same_time: true },
        { number: 'S-CASH', n: 1, method: 'CASH', amount: 100_000, inv: null, txn: null, same_time: true },
        { number: 'S-OLD', n: 1, method: 'CASH', amount: 40_000, inv: null, txn: null, same_time: true },
        { number: 'S-VOID', n: 1, method: 'CASH', amount: 90_000, inv: null, txn: null, same_time: true },
      ]);
      for (const c of ['ck_sale_payments_method', 'ck_sale_payments_line_no', 'ck_sale_payments_amount_positive', 'ck_sale_payments_references', 'ck_sales_payment_method']) {
        expect((await one(h, `SELECT convalidated AS v FROM pg_constraint WHERE conname = '${c}'`))?.v, c).toBe(true);
      }
      // The table is append-only, and its checks hold.
      expect(await refused(h, `UPDATE sale_payments SET amount = 1`)).toBe(true);
      expect(await refused(h, `DELETE FROM sale_payments`)).toBe(true);
      const id = Number((await one(h, `SELECT id FROM sales WHERE number = 'S-CASH'`)).id);
      const line = (n: number, method: string, amount: number, inv = 'NULL', txn = 'NULL') =>
        `INSERT INTO sale_payments (sale_id, line_no, method, amount, ref_invoice, ref_transaction) VALUES (${id}, ${n}, '${method}', ${amount}, ${inv}, ${txn})`;
      expect(await refused(h, line(1, 'BANK_TRANSFER', 10, 'NULL', `'TRF 9'`))).toBe(true); // line 1 taken
      expect(await refused(h, line(2, 'CASH', 10))).toBe(true); // the same method twice
      expect(await refused(h, line(3, 'BANK_TRANSFER', 10, 'NULL', `'TRF 9999'`))).toBe(true); // line 3
      expect(await refused(h, line(2, 'BANK_TRANSFER', 0, 'NULL', `'TRF 9999'`))).toBe(true); // amount 0
      expect(await refused(h, line(2, 'BANK_TRANSFER', 10))).toBe(true); // no bank reference
      expect(await refused(h, line(2, 'BANK_TRANSFER', 10, 'NULL', `'TR9'`))).toBe(true); // too short
      expect(await refused(h, line(2, 'HASAD', 10))).toBe(true); // no Hasad invoice number
      expect(await refused(h, line(2, 'CARD', 10, 'NULL', `'X-1'`))).toBe(true); // a card takes no reference
      expect(await refused(h, line(2, 'CHEQUE', 10))).toBe(true);
      expect(await refused(h, `UPDATE sales SET payment_method = 'OTHER' WHERE number = 'S-CASH'`)).toBe(true);
      // 0035: the label and the total follow the lines (checked at commit); the sale's old reference checks moved to the lines.
      expect(await refused(h, `UPDATE sales SET payment_method = 'SPLIT' WHERE number = 'S-CASH'`)).toBe(true);
      expect(await refused(h, `UPDATE sales SET total = total + 1, subtotal = subtotal + 1 WHERE number = 'S-CASH'`)).toBe(true);
      expect(await refused(h, `INSERT INTO sales (number, branch_id, cashier_id, subtotal, total, cost_total, payment_method) SELECT 'S-NOLINE', branch_id, cashier_id, 10, 10, 0, 'CASH' FROM sales WHERE number = 'S-CASH'`)).toBe(true);
      expect(await refused(h, `UPDATE sales SET status = 'VOIDED', voided_at = now(), void_reason = 'test' WHERE number = 'S-BANK'`)).toBe(false);
      expect(Number((await one(h, `SELECT count(*) AS n FROM pg_constraint WHERE conname IN ('ck_sales_hasad_reference', 'ck_sales_bank_transfer_reference')`)).n)).toBe(0);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('0036: a database with Hasad receivable history stops, changing nothing (owner Q5: recreated, never converted)', async () => {
    const cases: [string, string[]][] = [
      ['a Hasad sale (its entry on the receivable)', [sale('S-HSD', 'HASAD', 300_000, { inv: 'HSD-77', txn: 'tx 5' }), entry('S-HSD', 'HASAD_RECEIVABLE', 'HASAD', 300_000)]],
      [
        'a voided Hasad sale (two entries netting to zero)',
        [sale('S-HSV', 'HASAD', 300_000, { inv: 'HSD-78' }, 'VOIDED'), entry('S-HSV', 'HASAD_RECEIVABLE', 'HASAD', 300_000), entry('S-HSV', 'HASAD_RECEIVABLE', 'HASAD', -300_000, 'SALE_VOID')],
      ],
      ['a settlement record', [`INSERT INTO hasad_receivable_settlements (number, branch_id, amount, actor_id) SELECT 'HRS-1', b.id, 500, u.id FROM branches b, users u WHERE b.code = 'TRL' AND u.username = 'trial.person'`]],
      ['a settlement in the audit log', [`INSERT INTO audit_logs (action, entity_type, entity_id, description) VALUES ('HASAD_RECEIVABLE_SETTLED', 'hasad_receivable_settlement', 'HRS-9', 'x')`]],
    ];
    for (const [what, setup] of cases) {
      const h = await openAt(32);
      try {
        await run(h, BASE);
        for (const q of setup) await run(h, q);
        const accounts = await run(h, `SELECT branch_id, kind FROM ledger_accounts ORDER BY id`);
        await stopsWith(h, 'Migration 0036 (PAY-1) stopped');
        expect(await run(h, `SELECT branch_id, kind FROM ledger_accounts ORDER BY id`), what).toEqual(accounts);
      } finally {
        await h.close();
      }
    }
  }, 240_000);

  it('0036 on a database without Hasad receivable history: the receivable, its table and its permission are gone', async () => {
    const h = await openAt(32);
    try {
      await run(h, BASE);
      await run(h, `INSERT INTO roles (code, name, name_ar) VALUES ('BRANCH_MANAGER', 'Branch Manager', 'مدير فرع') ON CONFLICT DO NOTHING`);
      await run(h, `INSERT INTO role_permissions (role_id, permission_code) SELECT id, 'cash.settle_hasad' FROM roles WHERE code IN ('GENERAL_MANAGER', 'BRANCH_MANAGER') ON CONFLICT DO NOTHING`);
      // A Hasad sale recorded without a receivable entry (as a sale before the ledger) converts to its payment line.
      await run(h, sale('S-HSD', 'HASAD', 300_000, { inv: 'HSD-77', txn: 'tx 5' }));
      await run(h, sale('S-CASH', 'CASH', 100_000));
      await run(h, entry('S-CASH', 'CASH', 'CASH', 100_000));
      await h.migrate();
      expect(await one(h, `SELECT p.method, p.amount::int AS amount, p.ref_invoice AS inv, p.ref_transaction AS txn FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE s.number = 'S-HSD'`)).toEqual({ method: 'HASAD', amount: 300_000, inv: 'HSD-77', txn: 'tx 5' });
      expect((await run(h, `SELECT kind FROM ledger_accounts a JOIN branches b ON b.id = a.branch_id WHERE b.code = 'TRL' ORDER BY kind`)).map((r) => r.kind)).toEqual(['BANK', 'CASH', 'FUNDS_IN_TRANSIT', 'OWED_TO_GM']);
      expect(Number((await one(h, `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'hasad_receivable_settlements'`)).n)).toBe(0);
      expect(Number((await one(h, `SELECT count(*) AS n FROM permissions WHERE code = 'cash.settle_hasad'`)).n)).toBe(0);
      expect(Number((await one(h, `SELECT count(*) AS n FROM role_permissions WHERE permission_code = 'cash.settle_hasad'`)).n)).toBe(0);
      // The checks refuse the removed kind and event type; a new branch gets the four accounts.
      expect(await refused(h, `INSERT INTO ledger_accounts (branch_id, kind) SELECT id, 'HASAD_RECEIVABLE' FROM branches WHERE code = 'TRL'`)).toBe(true);
      expect(await refused(h, entry('S-CASH', 'CASH', 'CASH', 1, 'HASAD_RECEIVABLE_SETTLEMENT'))).toBe(true);
      await run(h, `INSERT INTO branches (code, name, name_ar, city) VALUES ('NEW', 'New', 'جديد', 'City')`);
      expect((await run(h, `SELECT kind FROM ledger_accounts a JOIN branches b ON b.id = a.branch_id WHERE b.code = 'NEW' ORDER BY kind`)).map((r) => r.kind)).toEqual(['BANK', 'CASH', 'FUNDS_IN_TRANSIT', 'OWED_TO_GM']);
      expect(Number((await one(h, `SELECT count(*) AS n FROM ledger_entries`)).n)).toBe(1);
      // The no-delete protection of the accounts is back: a DELETE is refused.
      expect(await refused(h, `DELETE FROM ledger_accounts WHERE kind = 'FUNDS_IN_TRANSIT'`)).toBe(true);
      expect((await one(h, `SELECT tgenabled AS e FROM pg_trigger WHERE tgname = 'ledger_accounts_no_delete'`))?.e).toBe('O');
      if (PG_MODE) expect((await one(h, `SELECT has_table_privilege(current_user, 'ledger_entries', 'UPDATE') AS u`))?.u).toBe(false);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('owner addition 2: a sale recorded before PAY-1 reprints with its one backfilled payment line', async () => {
    const h = await openAt(32);
    try {
      await run(h, BASE);
      await run(h, sale('S-OLDBANK', 'BANK_TRANSFER', 250_000, { txn: 'TRF 1234' }));
      await run(h, entry('S-OLDBANK', 'BANK', 'BANK_TRANSFER', 250_000));
      await run(h, sale('S-OLDCASH', 'CASH', 90_000));
      await h.migrate();
      const ctx = createContext(h);
      const u = await one(h, `SELECT id FROM users WHERE username = 'trial.person'`);
      const gm: Actor = { userId: Number(u.id), username: 'trial.person', fullName: 'Trial', roleCode: 'GENERAL_MANAGER', roleName: 'General Manager', roleRank: 100, branchId: null, branchCode: null, branchName: null, permissions: new Set(Object.keys(PERMISSIONS) as never), sessionId: null };
      const id = async (n: string) => Number((await one(h, `SELECT id FROM sales WHERE number = '${n}'`)).id);
      const bank = await printSale(ctx, gm, await id('S-OLDBANK'));
      expect(bank.document).toMatchObject({ number: 'S-OLDBANK', paymentMethod: 'BANK_TRANSFER', total: 250_000, payments: [{ method: 'BANK_TRANSFER', amount: 250_000, invoiceRef: null, transactionRef: 'TRF 1234' }], copy: { n: 1 } });
      const cash = await printSale(ctx, gm, await id('S-OLDCASH'));
      expect(cash.document.payments).toEqual([{ method: 'CASH', amount: 90_000, invoiceRef: null, transactionRef: null }]);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('guard (a): stops, changing nothing, on a sale whose ledger entries disagree with it', async () => {
    for (const bad of [
      [sale('S-1', 'CASH', 100_000), entry('S-1', 'CASH', 'CASH', 90_000)], // the sum differs from the total
      [sale('S-2', 'CASH', 100_000), entry('S-2', 'BANK', 'BANK_TRANSFER', 100_000)], // recorded as cash, posted as a transfer
    ]) {
      const h = await openAt(32);
      try {
        await run(h, BASE);
        for (const q of bad) await run(h, q);
        await stopsWith(h, 'do not match their entries in the money ledger');
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  it('guard (b): stops, changing nothing, on a sale that cannot make a valid payment line', async () => {
    const h = await openAt(32);
    try {
      await run(h, BASE);
      await run(h, sale('S-3', 'CASH', 50_000, { txn: 'TRF 1234' })); // a cash sale carrying a bank reference
      await stopsWith(h, 'cannot be given a valid payment line');
    } finally {
      await h.close();
    }
  }, 120_000);
});
