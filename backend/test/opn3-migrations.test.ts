// OPN-3 migration 0037 on a database migrated up to 0036 that already holds a sealed opening, a draft, broken-scrap
// purchases, a void and a supplier settlement in the pool (both projects):
//   * nothing that exists changes: every pool row and balance, the openings, their lines and pieces, the purchases;
//   * the pool accepts the two new movement types (OPENING, OPENING_CORRECTION) and still refuses an unknown one;
//   * `opening_scrap_lines`: lines of a draft are added, edited (karat, weight, note) and removed; a karat outside 1–24,
//     a weight of 0, a note over 120 characters, a change of the line number are refused; nothing changes once the
//     opening is sealed;
//   * `opening_scrap_corrections`: only for a sealed opening, in its branch; a change of 0 and a short reason are
//     refused; append-only (UPDATE, DELETE refused).

import { describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { one, openAt, run } from './migration-harness';

const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);

async function seed(h: DatabaseHandle) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const gmRole = await id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام', true, 100) RETURNING id`);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const b = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPB', '[Test] B', '[اختبار] ب', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${gmRole}, 'x', false) RETURNING id`);
  const cat = await id(`INSERT INTO categories (code, name, name_ar) VALUES ('RING', 'Rings', '[اختبار] خواتم') RETURNING id`);
  // A sealed opening of branch A with one piece; a draft of branch B with one line.
  const sealed = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${a}, ${gm}) RETURNING id`);
  const op = await id(`INSERT INTO jewelry_items (code, barcode, category_id, karat, gross_weight_mg, net_weight_mg, origin, rate_kind, acquisition_cost, selling_price, branch_id, status)
    VALUES ('OP-1', 'OP-1', ${cat}, 21, 5100, 5000, 'OPENING', 'USED', NULL, 0, ${a}, 'AVAILABLE') RETURNING id`);
  const line = await id(`INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, condition, source, created_by) VALUES (${sealed}, 1, ${cat}, 21, 5100, 5000, 'USED', 'KEYBOARD', ${gm}) RETURNING id`);
  await run(h, `UPDATE opening_lines SET item_id = ${op} WHERE id = ${line}`);
  await run(h, `UPDATE openings SET status = 'SEALED', sealed_by = ${gm}, sealed_at = now() WHERE id = ${sealed}`);
  const draft = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${b}, ${gm}) RETURNING id`);
  await run(h, `INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, condition, source, created_by) VALUES (${draft}, 1, ${cat}, 21, 3000, 3000, 'NEW', 'KEYBOARD', ${gm})`);
  // Two broken-scrap purchases of branch A (pool +), one voided (REVERSAL −), a settlement (−).
  const purchase = (n: string, karat: number, mg: number) =>
    id(`INSERT INTO scrap_purchases (number, branch_id, kind, karat, gross_weight_mg, net_weight_mg, scrap_rate_per_gram, agreed_rate_per_gram, deviation_bp, override_approved, amount, payment_method, cash_amount, bank_amount, created_by)
        VALUES ('${n}', ${a}, 'BROKEN', ${karat}, ${mg}, ${mg}, 50000, 50000, 0, false, ${(mg / 1000) * 50000}, 'CASH', ${(mg / 1000) * 50000}, 0, ${gm}) RETURNING id`);
  const pool = (karat: number, mg: number, type: string, refType: string, ref: number) =>
    run(h, `INSERT INTO scrap_weight_entries (branch_id, karat, weight_mg, event_type, ref_type, ref_id, actor_id) VALUES (${a}, ${karat}, ${mg}, '${type}', '${refType}', ${ref}, ${gm})`);
  const p1 = await purchase('UPA-SCR-000001', 21, 40_000);
  const p2 = await purchase('UPA-SCR-000002', 18, 12_500);
  await pool(21, 40_000, 'SCRAP_PURCHASE', 'scrap_purchase', p1);
  await pool(18, 12_500, 'SCRAP_PURCHASE', 'scrap_purchase', p2);
  await pool(18, -12_500, 'REVERSAL', 'scrap_purchase', p2);
  await pool(21, -15_000, 'SUPPLIER_SETTLEMENT', 'supplier_settlement', 1);
  return { gm, a, b, sealed, draft };
}

const snapshot = async (h: DatabaseHandle) => ({
  pool: await run(h, `SELECT id, branch_id, karat, weight_mg, event_type, ref_type, ref_id FROM scrap_weight_entries ORDER BY id`),
  balances: await run(h, `SELECT branch_id, karat, sum(weight_mg)::bigint AS w FROM scrap_weight_entries GROUP BY branch_id, karat ORDER BY branch_id, karat`),
  openings: await run(h, `SELECT id, branch_id, status, sealed_by FROM openings ORDER BY id`),
  lines: await run(h, `SELECT id, opening_id, line_no, karat, net_weight_mg, condition, item_id FROM opening_lines ORDER BY id`),
  pieces: await run(h, `SELECT code, karat, origin, rate_kind, net_weight_mg, status, acquisition_cost FROM jewelry_items ORDER BY code`),
  purchases: await run(h, `SELECT number, kind, karat, net_weight_mg, amount FROM scrap_purchases ORDER BY number`),
});

describe('migration 0037 (OPN-3) on a database at 0036 with a sealed opening and a scrap pool', () => {
  it('changes nothing that exists; the new types, tables, checks and triggers hold', async () => {
    const h = await openAt(36);
    try {
      const s = await seed(h);
      const before = await snapshot(h);
      expect(before.balances.map((r) => [Number(r.karat), Number(r.w)])).toEqual([[18, 0], [21, 25_000]]);
      await h.migrate();
      expect(await snapshot(h)).toEqual(before);

      // The pool: the two new types, and nothing else.
      const poolRow = (type: string) => `INSERT INTO scrap_weight_entries (branch_id, karat, weight_mg, event_type, ref_type, ref_id) VALUES (${s.a}, 21, 1000, '${type}', 'opening_scrap_line', 1)`;
      expect(await refused(h, poolRow('OPENING'))).toBe(false);
      expect(await refused(h, poolRow('OPENING_CORRECTION'))).toBe(false);
      expect(await refused(h, poolRow('GIFT'))).toBe(true);

      // Draft scrap lines.
      const line = (o: Partial<Record<string, string | number>>) => {
        const v = { opening: s.draft, no: 1, karat: 21, w: 250_000, note: 'NULL', ...o };
        return `INSERT INTO opening_scrap_lines (opening_id, line_no, karat, weight_mg, note, created_by) VALUES (${v.opening}, ${v.no}, ${v.karat}, ${v.w}, ${v.note}, ${s.gm}) RETURNING id`;
      };
      expect(await refused(h, line({ karat: 0 }))).toBe(true);
      expect(await refused(h, line({ karat: 25 }))).toBe(true);
      expect(await refused(h, line({ w: 0 }))).toBe(true);
      expect(await refused(h, line({ note: `'${'x'.repeat(121)}'` }))).toBe(true);
      expect(await refused(h, line({ note: `''` }))).toBe(true);
      expect(await refused(h, line({ opening: s.sealed }))).toBe(true); // sealed: nothing is added
      const l1 = Number((await one(h, line({ karat: 9, note: `'bag 1'` }))).id); // any karat 1–24
      const l2 = Number((await one(h, line({ no: 2 }))).id);
      expect(await refused(h, line({ no: 2 }))).toBe(true); // the same line number twice
      expect(await refused(h, `UPDATE opening_scrap_lines SET karat = 18, weight_mg = 1500, note = 'bag 2', updated_by = ${s.gm}, updated_at = now() WHERE id = ${l2}`)).toBe(false);
      expect(await refused(h, `UPDATE opening_scrap_lines SET line_no = 7 WHERE id = ${l2}`)).toBe(true);
      expect(await refused(h, `DELETE FROM opening_scrap_lines WHERE id = ${l2}`)).toBe(false);
      expect(await refused(h, `TRUNCATE opening_scrap_lines`)).toBe(true);

      // Corrections: only of a sealed opening, in its branch.
      const corr = (o: Partial<Record<string, string | number>>) => {
        const v = { opening: s.sealed, branch: s.a, karat: 21, w: -1000, reason: `'counted again'`, ...o };
        return `INSERT INTO opening_scrap_corrections (opening_id, branch_id, karat, weight_mg_change, reason, corrected_by) VALUES (${v.opening}, ${v.branch}, ${v.karat}, ${v.w}, ${v.reason}, ${s.gm})`;
      };
      expect(await refused(h, corr({ opening: s.draft, branch: s.b }))).toBe(true); // a draft
      expect(await refused(h, corr({ branch: s.b }))).toBe(true); // not the opening's branch
      expect(await refused(h, corr({ w: 0 }))).toBe(true);
      expect(await refused(h, corr({ karat: 25 }))).toBe(true);
      expect(await refused(h, corr({ reason: `'  x '` }))).toBe(true);
      expect(await refused(h, corr({}))).toBe(false);
      expect(await refused(h, corr({ karat: 18, w: 2000 }))).toBe(false);
      expect(await refused(h, `UPDATE opening_scrap_corrections SET reason = 'changed'`)).toBe(true);
      expect(await refused(h, `DELETE FROM opening_scrap_corrections`)).toBe(true);

      // Once the draft is sealed, its scrap lines never change.
      await run(h, `UPDATE openings SET status = 'SEALED', sealed_by = ${s.gm}, sealed_at = now() WHERE id = ${s.draft}`);
      expect(await refused(h, `UPDATE opening_scrap_lines SET weight_mg = 1 WHERE id = ${l1}`)).toBe(true);
      expect(await refused(h, `DELETE FROM opening_scrap_lines WHERE id = ${l1}`)).toBe(true);
      expect(await refused(h, line({ no: 3 }))).toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);
});
