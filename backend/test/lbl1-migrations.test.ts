// LBL-1 migration 0041 on a database migrated up to 0040 that already holds pieces (both projects): nothing that exists
// changes; `label_prints` starts empty; a print row must be of the piece's branch; FIRST only for a piece never
// printed, REPRINT only after one; copies 1–20; kind and source from their lists; append-only.

import { describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '@jerp/database';
import { one, openAt, run } from './migration-harness';

const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);

async function seed(h: DatabaseHandle) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const role = await id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام', true, 100) RETURNING id`);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const b = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPB', '[Test] B', '[اختبار] ب', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${role}, 'x', false) RETURNING id`);
  const cat = await id(`INSERT INTO categories (code, name, name_ar) VALUES ('RING', 'Rings', '[اختبار] خواتم') RETURNING id`);
  const piece = (n: number, branch: number) =>
    id(`INSERT INTO jewelry_items (code, barcode, category_id, karat, gross_weight_mg, net_weight_mg, origin, rate_kind, acquisition_cost, selling_price, branch_id, status)
        VALUES ('J-${n}', '628100${String(n).padStart(6, '0')}', ${cat}, 21, 5100, 5000, 'OPENING', 'NEW', NULL, 0, ${branch}, 'AVAILABLE') RETURNING id`);
  return { a, b, gm, p1: await piece(1, a), p2: await piece(2, a) };
}

describe('migration 0041 (LBL-1) on a database at 0040 with pieces', () => {
  it('changes nothing that exists; label_prints and its rules', async () => {
    const h = await openAt(40);
    try {
      const s = await seed(h);
      const items = `SELECT id, code, barcode, branch_id, status FROM jewelry_items ORDER BY id`;
      const before = await run(h, items);
      await h.migrate();
      expect(await run(h, items)).toEqual(before);
      expect(await one(h, `SELECT count(*)::int AS n FROM label_prints`)).toEqual({ n: 0 });
      const ins = (item: number, branch: number, kind: string, copies = 1, source = 'PIECE') =>
        `INSERT INTO label_prints (item_id, branch_id, copies, kind, source, batch_id, printed_by) VALUES (${item}, ${branch}, ${copies}, '${kind}', '${source}', 'b1', ${s.gm}) RETURNING id`;
      expect(await refused(h, ins(s.p1, s.b, 'FIRST'))).toBe(true); // another branch
      expect(await refused(h, ins(s.p1, s.a, 'REPRINT'))).toBe(true); // never printed
      expect(await refused(h, ins(s.p1, s.a, 'FIRST', 21))).toBe(true);
      expect(await refused(h, ins(s.p1, s.a, 'FIRST', 1, 'POS'))).toBe(true);
      expect(await refused(h, ins(s.p1, s.a, 'COPY'))).toBe(true);
      expect(await refused(h, ins(s.p1, s.a, 'FIRST', 20))).toBe(false);
      expect(await refused(h, ins(s.p1, s.a, 'FIRST'))).toBe(true); // a second FIRST
      expect(await refused(h, ins(s.p1, s.a, 'REPRINT', 1, 'STOCK_LIST'))).toBe(false);
      expect(await refused(h, `UPDATE label_prints SET copies = 2`)).toBe(true);
      expect(await refused(h, `DELETE FROM label_prints`)).toBe(true);
      expect(await one(h, `SELECT count(*)::int AS n FROM label_prints WHERE item_id = ${s.p1}`)).toEqual({ n: 2 });
    } finally {
      await h.close();
    }
  }, 120_000);
});
