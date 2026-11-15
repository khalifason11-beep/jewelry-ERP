// LBL-2 migrations 0042 (additive) and 0043 (the backfill) on a database migrated up to 0041 that already holds a DRAFT
// opening and a SEALED one (both projects; plan docs/plans/LBL-2.md §7, owner answer Q6):
//   * the draft's lines get consecutive codes in line order (a removed line's number gap in line_no does not matter),
//     starting at the piece counter's next value; the counter moves past them, so the next piece takes the next number;
//   * the sealed opening's lines, the pieces and everything else are not touched;
//   * a block crossing 999,999 keeps every digit (13-digit barcode), as core/numbering.ts;
//   * no counter row yet: the block starts at 1001;
//   * the rules added by 0042: a code once set never changes; code and barcode together; unique;
//   * 0044 (the tightening): every line has its piece or its code; a line without either stops the upgrade with the
//     rule's name, and once applied such a line is refused.

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { nextItemCode } from '../src/core/numbering';
import { one, openAt, run } from './migration-harness';

const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);

async function seed(h: DatabaseHandle, counterNext: number | null) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const role = await id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام', true, 100) RETURNING id`);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const b = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPB', '[Test] B', '[اختبار] ب', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${role}, 'x', false) RETURNING id`);
  const cat = await id(`INSERT INTO categories (code, name, name_ar) VALUES ('RING', 'Rings', '[اختبار] خواتم') RETURNING id`);
  if (counterNext != null) await run(h, `INSERT INTO document_sequences (scope, next) VALUES ('ITEM', ${counterNext})`);
  const line = (opening: number, lineNo: number, net: number) =>
    id(`INSERT INTO opening_lines (opening_id, line_no, category_id, description, karat, gross_weight_mg, net_weight_mg, source, condition, created_by)
        VALUES (${opening}, ${lineNo}, ${cat}, 'line ${lineNo}', 21, ${net + 100}, ${net}, 'KEYBOARD', 'NEW', ${gm}) RETURNING id`);
  // The sealed opening of branch B: one line, its piece made at the seal (the code from before LBL-2).
  const sealed = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${b}, ${gm}) RETURNING id`);
  const sealedLine = await line(sealed, 1, 3_000);
  const piece = await id(`INSERT INTO jewelry_items (code, barcode, category_id, karat, gross_weight_mg, net_weight_mg, origin, rate_kind, acquisition_cost, selling_price, branch_id, status)
      VALUES ('J-500', '628100000500', ${cat}, 21, 3100, 3000, 'OPENING', 'NEW', NULL, 0, ${b}, 'AVAILABLE') RETURNING id`);
  await run(h, `UPDATE opening_lines SET item_id = ${piece} WHERE id = ${sealedLine}`);
  await run(h, `UPDATE openings SET status = 'SEALED', sealed_by = ${gm}, sealed_at = now() WHERE id = ${sealed}`);
  // The draft of branch A: lines 1, 2, 4, 5 and 3 entered out of order (line 3 typed last); 6 removed.
  const draft = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${a}, ${gm}) RETURNING id`);
  for (const n of [1, 2, 4, 5, 3, 6]) await line(draft, n, 1_000 + n);
  await run(h, `DELETE FROM opening_lines WHERE opening_id = ${draft} AND line_no = 6`);
  return { draft, sealed, piece };
}

const draftLines = (h: DatabaseHandle, opening: number) => run(h, `SELECT line_no, reserved_code, reserved_barcode FROM opening_lines WHERE opening_id = ${opening} ORDER BY line_no`);

describe('migrations 0042–0043 (LBL-2) on a database at 0041 with a draft and a sealed opening', () => {
  it('the draft lines get consecutive codes in line order from the counter; the sealed opening and the pieces are untouched', async () => {
    const h = await openAt(41);
    try {
      const s = await seed(h, 2_000);
      const untouched = `SELECT ol.id, ol.item_id, ol.line_no, i.code, i.barcode FROM opening_lines ol JOIN jewelry_items i ON i.id = ol.item_id ORDER BY ol.id`;
      const items = `SELECT id, code, barcode, branch_id, status FROM jewelry_items ORDER BY id`;
      const before = { sealed: await run(h, untouched), items: await run(h, items) };
      await h.migrate();
      expect(await draftLines(h, s.draft)).toEqual([1, 2, 3, 4, 5].map((n, i) => ({ line_no: n, reserved_code: `J-${2_000 + i}`, reserved_barcode: `628100${String(2_000 + i).padStart(6, '0')}` })));
      expect(await run(h, untouched)).toEqual(before.sealed);
      expect(await run(h, items)).toEqual(before.items);
      expect(await one(h, `SELECT reserved_code FROM opening_lines WHERE opening_id = ${s.sealed}`)).toEqual({ reserved_code: null });
      // The counter moved past the block: the next piece takes the next number.
      expect(await one(h, `SELECT next FROM document_sequences WHERE scope = 'ITEM'`)).toEqual({ next: 2_005 });
      expect(await nextItemCode(h.db as never)).toEqual({ code: 'J-2005', barcode: '628100002005' });
      expect(await one(h, `SELECT count(*)::int AS n FROM opening_label_prints`)).toEqual({ n: 0 });
      // The rules added by 0042.
      expect(await refused(h, `UPDATE opening_lines SET reserved_code = 'J-1' WHERE opening_id = ${s.draft} AND line_no = 1`)).toBe(true);
      expect(await refused(h, `UPDATE opening_lines SET reserved_code = 'J-2001', reserved_barcode = '628100002001' WHERE opening_id = ${s.draft} AND line_no = 1`)).toBe(true);
      expect(await refused(h, `INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, source, condition, created_by, reserved_code)
        SELECT opening_id, 9, category_id, karat, gross_weight_mg, net_weight_mg, source, condition, created_by, 'J-9999' FROM opening_lines WHERE opening_id = ${s.draft} AND line_no = 1`)).toBe(true); // a code without its barcode
      expect(await refused(h, `INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, source, condition, created_by, reserved_code, reserved_barcode)
        SELECT opening_id, 9, category_id, karat, gross_weight_mg, net_weight_mg, source, condition, created_by, reserved_code, '628100009999' FROM opening_lines WHERE opening_id = ${s.draft} AND line_no = 1`)).toBe(true); // a code twice
      // The backfill again finds nothing to do (a line with a code is skipped).
      const sqlText = (await import('node:fs')).readFileSync(new URL('../../database/migrations/0043_lbl2_backfill_codes.sql', import.meta.url), 'utf8');
      await h.db.execute(sql.raw(sqlText));
      expect((await draftLines(h, s.draft)).map((l) => l.reserved_code)).toEqual(['J-2000', 'J-2001', 'J-2002', 'J-2003', 'J-2004']);
      expect(await one(h, `SELECT next FROM document_sequences WHERE scope = 'ITEM'`)).toEqual({ next: 2_006 }); // J-2005 was taken above
    } finally {
      await h.close();
    }
  }, 120_000);

  it('a block crossing 999,999 keeps every digit; with no counter row the block starts at 1001', async () => {
    const h = await openAt(41);
    try {
      const s = await seed(h, 999_998);
      await h.migrate();
      expect((await draftLines(h, s.draft)).map((l) => [l.reserved_code, l.reserved_barcode])).toEqual([
        ['J-999998', '628100999998'],
        ['J-999999', '628100999999'],
        ['J-1000000', '6281001000000'],
        ['J-1000001', '6281001000001'],
        ['J-1000002', '6281001000002'],
      ]);
      expect(await nextItemCode(h.db as never)).toEqual({ code: 'J-1000003', barcode: '6281001000003' });
    } finally {
      await h.close();
    }
    const fresh = await openAt(41);
    try {
      const s = await seed(fresh, null);
      await fresh.migrate();
      expect((await draftLines(fresh, s.draft)).map((l) => l.reserved_code)).toEqual(['J-1001', 'J-1002', 'J-1003', 'J-1004', 'J-1005']);
      expect(await nextItemCode(fresh.db as never)).toEqual({ code: 'J-1006', barcode: '628100001006' });
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it('0044: a draft line without a code stops the upgrade; once applied, a line without its piece or its code is refused', async () => {
    const h = await openAt(43);
    try {
      const s = await seed(h, 3_000); // lines added after 0043 ran, as old code would: no code
      const stopped = await h.migrate().then(() => 'migrated', (e: Error) => String(e.message ?? e) + String((e as { cause?: Error }).cause?.message ?? ''));
      expect(stopped).toMatch(/ck_opening_lines_code_or_piece/);
      await run(h, `UPDATE opening_lines SET reserved_code = 'J-' || (3000 + line_no), reserved_barcode = '628100' || lpad((3000 + line_no)::text, 6, '0') WHERE opening_id = ${s.draft}`);
      await h.migrate();
      expect(await one(h, `SELECT convalidated FROM pg_constraint WHERE conname = 'ck_opening_lines_code_or_piece'`)).toEqual({ convalidated: true });
      expect(await refused(h, `INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, source, condition, created_by)
        SELECT opening_id, 9, category_id, karat, gross_weight_mg, net_weight_mg, source, condition, created_by FROM opening_lines WHERE opening_id = ${s.draft} AND line_no = 1`)).toBe(true);
      // The sealed opening's line (its piece, no code) is fine.
      expect(await one(h, `SELECT count(*)::int AS n FROM opening_lines WHERE opening_id = ${s.sealed} AND reserved_code IS NULL AND item_id IS NOT NULL`)).toEqual({ n: 1 });
    } finally {
      await h.close();
    }
  }, 120_000);
});
