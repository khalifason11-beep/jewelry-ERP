// OPN-FIX migration 0032 (additive) on a database migrated up to 0031 holding a sealed opening (both projects; the
// general upgrade from older versions is in migration-upgrade.test.ts):
//   * nothing that exists changes; the permission `opening.correct` goes to the General Manager only;
//   * `opening_piece_corrections` accepts a correction of a piece of a sealed opening and refuses: a piece that is not a
//     line of that opening, a piece of a DRAFT opening, an unknown kind or condition, a void that changes a value, a
//     correction that changes nothing, a short reason, bad weights, a branch that does not exist;
//   * the table is append-only (UPDATE, DELETE refused).

import { describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { one, openAt, run } from './migration-harness';

const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);

async function seed(h: DatabaseHandle) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const gmRole = await id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام', true, 100) RETURNING id`);
  await id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('BRANCH_MANAGER', 'Branch Manager', 'مدير فرع', true, 50) RETURNING id`);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const b = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPB', '[Test] B', '[اختبار] ب', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${gmRole}, 'x', false) RETURNING id`);
  const cat = await id(`INSERT INTO categories (code, name, name_ar) VALUES ('RING', 'Rings', '[اختبار] خواتم') RETURNING id`);
  const piece = (code: string, origin: string, rateKind: string, cost: string, branch = a) =>
    id(`INSERT INTO jewelry_items (code, barcode, category_id, karat, gross_weight_mg, net_weight_mg, origin, rate_kind, acquisition_cost, selling_price, branch_id, status)
        VALUES ('${code}', '${code}', ${cat}, 21, 5100, 5000, '${origin}', '${rateKind}', ${cost}, 0, ${branch}, 'AVAILABLE') RETURNING id`);
  const line = (opening: number, n: number) =>
    id(`INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, condition, source, created_by) VALUES (${opening}, ${n}, ${cat}, 21, 5100, 5000, 'NEW', 'KEYBOARD', ${gm}) RETURNING id`);
  // A sealed opening of branch A with one piece; a draft of branch B with one line; a supplier piece.
  const sealed = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${a}, ${gm}) RETURNING id`);
  const op = await piece('OP-1', 'OPENING', 'NEW', 'NULL');
  await run(h, `UPDATE opening_lines SET item_id = ${op} WHERE id = ${await line(sealed, 1)}`);
  await run(h, `UPDATE openings SET status = 'SEALED', sealed_by = ${gm}, sealed_at = now() WHERE id = ${sealed}`);
  const draft = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${b}, ${gm}) RETURNING id`);
  const draftPiece = await piece('DR-1', 'OPENING', 'NEW', 'NULL', b);
  await run(h, `UPDATE opening_lines SET item_id = ${draftPiece} WHERE id = ${await line(draft, 1)}`);
  const supplier = await piece('SN-1', 'SUPPLIER_NEW', 'NEW', '800000');
  return { gm, a, b, sealed, draft, op, draftPiece, supplier };
}

describe('migration 0032 (OPN-FIX) on a database at 0031 with a sealed opening', () => {
  it('adds the table and the permission; the checks, the trigger and the append-only protection hold', async () => {
    const h = await openAt(31);
    try {
      const s = await seed(h);
      const before = await run(h, `SELECT code, karat, rate_kind, net_weight_mg, gross_weight_mg, status, acquisition_cost FROM jewelry_items ORDER BY code`);
      await h.migrate();
      expect(await run(h, `SELECT code, karat, rate_kind, net_weight_mg, gross_weight_mg, status, acquisition_cost FROM jewelry_items ORDER BY code`)).toEqual(before);
      expect((await run(h, `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_code = 'opening.correct' ORDER BY r.code`)).map((r) => r.code)).toEqual(['GENERAL_MANAGER']);
      expect(Number((await one(h, `SELECT count(*) AS n FROM opening_piece_corrections`)).n)).toBe(0);

      const row = (o: Partial<Record<string, string | number>>) => {
        const v = { item: s.op, opening: s.sealed, branch: s.a, kind: `'CORRECT'`, cb: `'NEW'`, ca: `'USED'`, kb: 21, ka: 21, gb: 5100, ga: 5100, nb: 5000, na: 5000, reason: `'wrong condition'`, ...o };
        return `INSERT INTO opening_piece_corrections (item_id, opening_id, branch_id, kind, condition_before, condition_after, karat_before, karat_after, gross_weight_mg_before, gross_weight_mg_after, net_weight_mg_before, net_weight_mg_after, reason, corrected_by)
                VALUES (${v.item}, ${v.opening}, ${v.branch}, ${v.kind}, ${v.cb}, ${v.ca}, ${v.kb}, ${v.ka}, ${v.gb}, ${v.ga}, ${v.nb}, ${v.na}, ${v.reason}, ${s.gm})`;
      };
      expect(await refused(h, row({ item: s.supplier }))).toBe(true); // not a line of the opening
      expect(await refused(h, row({ item: s.draftPiece, opening: s.draft, branch: s.b }))).toBe(true); // the opening is a draft
      expect(await refused(h, row({ kind: `'EDIT'` }))).toBe(true);
      expect(await refused(h, row({ ca: `'OLD'` }))).toBe(true);
      expect(await refused(h, row({ kind: `'VOID'` }))).toBe(true); // a void that changes a value
      expect(await refused(h, row({ ca: `'NEW'` }))).toBe(true); // a correction that changes nothing
      expect(await refused(h, row({ reason: `'  x '` }))).toBe(true);
      expect(await refused(h, row({ na: 5200 }))).toBe(true); // net above gross
      expect(await refused(h, row({ ka: 25 }))).toBe(true);
      expect(await refused(h, row({ branch: s.b + 1000 }))).toBe(true);
      expect(await refused(h, row({}))).toBe(false);
      expect(await refused(h, row({ kind: `'VOID'`, ca: `'NEW'` }))).toBe(false);
      expect(Number((await one(h, `SELECT count(*) AS n FROM opening_piece_corrections`)).n)).toBe(2);
      expect(await refused(h, `UPDATE opening_piece_corrections SET reason = 'changed'`)).toBe(true);
      expect(await refused(h, `DELETE FROM opening_piece_corrections`)).toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);
});
