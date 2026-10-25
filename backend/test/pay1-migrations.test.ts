// PAY-1 migrations on a database migrated up to 0032 holding real sales (both projects; the general upgrade from older
// versions is in migration-upgrade.test.ts):
//   0033: the append-only table `sale_payments`, its checks, and the SPLIT label of sales.payment_method;
//   0034: one payment line per existing sale (its method, its whole total, its references, its time). Two guards stop
//         the upgrade, changing nothing: (a) a sale that disagrees with its SALE ledger entries; (b) a sale that cannot
//         make a valid line. A sale recorded before the ledger (no entry) is converted from its own method.

import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
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

describe('PAY-1 migrations 0033–0034 on a database at 0032', () => {
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
      expect(await refused(h, `UPDATE sales SET payment_method = 'SPLIT' WHERE number = 'S-CASH'`)).toBe(false);
      expect(await refused(h, `UPDATE sales SET payment_method = 'OTHER' WHERE number = 'S-CASH'`)).toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('a HASAD sale keeps its invoice number and transaction reference on its line', async () => {
    const h = await openAt(32);
    try {
      await run(h, BASE);
      await run(h, sale('S-HSD', 'HASAD', 300_000, { inv: 'HSD-77', txn: 'tx 5' }));
      await run(h, entry('S-HSD', 'HASAD_RECEIVABLE', 'HASAD', 300_000));
      await h.migrate();
      expect(await one(h, `SELECT p.method, p.amount::int AS amount, p.ref_invoice AS inv, p.ref_transaction AS txn FROM sale_payments p`)).toEqual({ method: 'HASAD', amount: 300_000, inv: 'HSD-77', txn: 'tx 5' });
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
