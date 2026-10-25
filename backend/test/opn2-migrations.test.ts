// OPN-2 migrations 0029 (additive) and 0030 (backfill + guard) on a database migrated up to 0028 holding data (both
// projects; the general upgrade from older versions is in migration-upgrade.test.ts):
//   * a sealed opening (as OPN-1 sealed it): its pieces get the NEW rate kind, its lines keep no condition (D-opn2-3),
//     a sellable scrap piece gets USED, a supplier piece NEW; no price input, cost or weight changes;
//   * a DRAFT opening that already has lines stops the upgrade with a clear message and nothing is applied; once the
//     draft is emptied the same upgrade goes through (an empty draft is fine);
//   * after the upgrade a new line needs a condition (the trigger), and the values are checked.

import { describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { one, openAt, run } from './migration-harness';

const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);

/** Two branches, a type, a sealed opening of 2 pieces in branch A, a scrap and a supplier piece; branch B gets a draft. */
async function seed(h: DatabaseHandle) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const role = await id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام', true, 100) RETURNING id`);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const b = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPB', '[Test] B', '[اختبار] ب', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${role}, 'x', false) RETURNING id`);
  const cat = await id(`INSERT INTO categories (code, name, name_ar) VALUES ('RING', 'Rings', '[اختبار] خواتم') RETURNING id`);
  const opening = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${a}, ${gm}) RETURNING id`);
  const piece = (code: string, origin: string, cost: string) =>
    id(`INSERT INTO jewelry_items (code, barcode, category_id, karat, gross_weight_mg, net_weight_mg, origin, acquisition_cost, selling_price, branch_id, status)
        VALUES ('${code}', '${code}', ${cat}, 21, 5100, 5000, '${origin}', ${cost}, 0, ${a}, 'AVAILABLE') RETURNING id`);
  for (const n of [1, 2]) {
    const line = await id(`INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, source, created_by) VALUES (${opening}, ${n}, ${cat}, 21, 5100, 5000, 'KEYBOARD', ${gm}) RETURNING id`);
    const item = await piece(`OP-${n}`, 'OPENING', 'NULL');
    await run(h, `UPDATE opening_lines SET item_id = ${item} WHERE id = ${line}`);
  }
  await run(h, `UPDATE openings SET status = 'SEALED', sealed_by = ${gm}, sealed_at = now() WHERE id = ${opening}`);
  await piece('SC-1', 'SCRAP', '700000');
  await piece('SN-1', 'SUPPLIER_NEW', '800000');
  const draft = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${b}, ${gm}) RETURNING id`);
  return { gm, cat, draft };
}
const snapshot = async (h: DatabaseHandle) => run(h, `SELECT code, origin, acquisition_cost, selling_price, net_weight_mg, karat FROM jewelry_items ORDER BY code`);

describe('migrations 0029 and 0030 (OPN-2) on a database at 0028 with data', () => {
  it('a sealed opening: its pieces become NEW, its lines keep no condition; scrap USED, supplier NEW; nothing else moves', async () => {
    const h = await openAt(28);
    try {
      const { gm, cat, draft } = await seed(h);
      const before = await snapshot(h);
      await h.migrate();
      expect(await snapshot(h)).toEqual(before);
      expect((await run(h, `SELECT code, rate_kind FROM jewelry_items ORDER BY code`)).map((r) => [r.code, r.rate_kind])).toEqual([
        ['OP-1', 'NEW'],
        ['OP-2', 'NEW'],
        ['SC-1', 'USED'],
        ['SN-1', 'NEW'],
      ]);
      expect(Number((await one(h, `SELECT count(*) AS n FROM opening_lines WHERE condition IS NOT NULL`)).n)).toBe(0);
      // The sealed opening is still closed; a new line in the (empty) draft needs a condition with a known value.
      expect(await refused(h, `UPDATE opening_lines SET condition = 'USED'`)).toBe(true);
      const line = (n: number, condition: string) => `INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, condition, source, created_by) VALUES (${draft}, ${n}, ${cat}, 21, 1000, 1000, ${condition}, 'KEYBOARD', ${gm})`;
      expect(await refused(h, line(1, 'NULL'))).toBe(true);
      expect(await refused(h, line(1, `'OLD'`))).toBe(true);
      expect(await refused(h, line(1, `'USED'`))).toBe(false);
      expect(await refused(h, `UPDATE jewelry_items SET rate_kind = 'OTHER' WHERE code = 'OP-1'`)).toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('a draft that already has lines stops the upgrade (nothing applied); emptied, the upgrade goes through', async () => {
    const h = await openAt(28);
    try {
      const { gm, cat, draft } = await seed(h);
      await run(h, `INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, source, created_by) VALUES (${draft}, 1, ${cat}, 21, 1000, 1000, 'KEYBOARD', ${gm})`);
      const applied = Number((await one(h, `SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)).n);
      const e = await h.migrate().then(() => null, (x: Error & { cause?: Error }) => x);
      expect(`${e?.message} ${e?.cause?.message ?? ''}`).toMatch(/Migration 0030 \(OPN-2\) stopped: the opening balance draft of UPB \(1 line\(s\)\) has lines without a condition/);
      expect(Number((await one(h, `SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)).n)).toBe(applied);
      expect(Number((await one(h, `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'jewelry_items' AND column_name = 'rate_kind'`)).n)).toBe(0);
      await run(h, `DELETE FROM opening_lines WHERE opening_id = ${draft}`);
      await h.migrate();
      expect(Number((await one(h, `SELECT count(*) AS n FROM jewelry_items WHERE rate_kind IS NULL`)).n)).toBe(0);
    } finally {
      await h.close();
    }
  }, 120_000);
});
