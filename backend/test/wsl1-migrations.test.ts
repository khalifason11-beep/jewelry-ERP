// WSL-1 migration 0040 on a database migrated up to 0039 that already holds broken scrap in the pool (a purchase, a
// supplier settlement, a reversal, an opening) and a sale (both projects):
//   * nothing that exists changes: every pool row and balance, the sale;
//   * the pool accepts the new movement type SCRAP_SALE and still refuses an unknown one;
//   * `sale_scrap_lines`: karat 1–24, grains > 0, weight = grains × 100 mg, rate and price > 0, one line per karat per
//     sale; a line must leave the pool exactly once at commit (one SCRAP_SALE row of its weight, karat and branch);
//     append-only (UPDATE, DELETE refused).

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { one, openAt, run, rowsOf } from './migration-harness';

const refused = async (h: DatabaseHandle, q: string) => run(h, q).then(() => false, () => true);

async function seed(h: DatabaseHandle) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const role = await id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام', true, 100) RETURNING id`);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const b = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPB', '[Test] B', '[اختبار] ب', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${role}, 'x', false) RETURNING id`);
  const pool = (branch: number, karat: number, mg: number, type: string, refType: string, refId: number) =>
    run(h, `INSERT INTO scrap_weight_entries (branch_id, karat, weight_mg, event_type, ref_type, ref_id, actor_id) VALUES (${branch}, ${karat}, ${mg}, '${type}', '${refType}', ${refId}, ${gm})`);
  await pool(a, 21, 12_500, 'SCRAP_PURCHASE', 'scrap_purchase', 1);
  await pool(a, 21, -2_000, 'SUPPLIER_SETTLEMENT', 'supplier_settlement', 1);
  await pool(a, 18, 3_000, 'OPENING', 'opening_scrap_line', 1);
  await pool(b, 21, 4_000, 'SCRAP_PURCHASE', 'scrap_purchase', 2);
  await pool(b, 21, -4_000, 'REVERSAL', 'scrap_purchase', 2);
  // A sale of branch A (with its payment line, in one transaction: the 0035 trigger checks them at commit).
  const sale = await h.db.transaction(async (tx) => {
    const [s] = rowsOf<{ id: number }>(
      await tx.execute(sql.raw(`INSERT INTO sales (number, branch_id, cashier_id, subtotal, total, cost_total, payment_method) VALUES ('UPA-INV-000001', ${a}, ${gm}, 100000, 100000, 0, 'CASH') RETURNING id`)),
    );
    await tx.execute(sql.raw(`INSERT INTO sale_payments (sale_id, line_no, method, amount) VALUES (${s.id}, 1, 'CASH', 100000)`));
    return Number(s.id);
  });
  return { a, b, gm, sale };
}

const snapshot = async (h: DatabaseHandle) => ({
  pool: await run(h, `SELECT id, branch_id, karat, weight_mg, event_type, ref_type, ref_id FROM scrap_weight_entries ORDER BY id`),
  balances: await run(h, `SELECT branch_id, karat, sum(weight_mg)::bigint AS w FROM scrap_weight_entries GROUP BY branch_id, karat ORDER BY branch_id, karat`),
  sales: await run(h, `SELECT id, number, total, status FROM sales ORDER BY id`),
});

describe('migration 0040 (WSL-1) on a database at 0039 with broken scrap in the pool', () => {
  it('changes nothing that exists; SCRAP_SALE, the grain lines and their checks', async () => {
    const h = await openAt(39);
    try {
      const s = await seed(h);
      const before = await snapshot(h);
      await h.migrate();
      expect(await snapshot(h)).toEqual(before);

      // The pool: SCRAP_SALE is a movement type now; an unknown one is still refused.
      const poolRow = (type: string) => `INSERT INTO scrap_weight_entries (branch_id, karat, weight_mg, event_type, ref_type, ref_id) VALUES (${s.a}, 21, -100, '${type}', 'test', 1)`;
      expect(await refused(h, poolRow('SCRAP_SOLD'))).toBe(true);
      expect(await refused(h, poolRow('SCRAP_SALE'))).toBe(false);

      // A grain line written with its one pool row, in one transaction: accepted.
      const line = (o: Partial<Record<string, number>> = {}) => {
        const v = { sale: s.sale, no: 1, karat: 21, grains: 3, weight: 300, rate: 123_456, price: 37_037, ...o };
        return `INSERT INTO sale_scrap_lines (sale_id, line_no, karat, grains, weight_mg, rate_per_gram, price) VALUES (${v.sale}, ${v.no}, ${v.karat}, ${v.grains}, ${v.weight}, ${v.rate}, ${v.price}) RETURNING id`;
      };
      const withPool = (q: string, pool: (lineId: number) => string | string[] | null) =>
        h.db
          .transaction(async (tx) => {
            const [r] = rowsOf<{ id: number }>(await tx.execute(sql.raw(q)));
            for (const p of [pool(Number(r.id)) ?? []].flat()) await tx.execute(sql.raw(p));
            return Number(r.id);
          })
          .then(
            (lineId) => ({ ok: true, lineId }),
            () => ({ ok: false, lineId: 0 }),
          );
      const sold = (branch: number, karat: number, mg: number, type = 'SCRAP_SALE') => (lineId: number) =>
        `INSERT INTO scrap_weight_entries (branch_id, karat, weight_mg, event_type, ref_type, ref_id) VALUES (${branch}, ${karat}, ${mg}, '${type}', 'sale_scrap_line', ${lineId})`;
      const good = await withPool(line(), sold(s.a, 21, -300));
      expect(good.ok).toBe(true);
      // Without its pool row, or with a wrong one (weight, karat, branch, type, twice): refused at commit.
      expect((await withPool(line({ no: 2, karat: 22 }), () => null)).ok).toBe(false);
      expect((await withPool(line({ no: 2, karat: 22 }), sold(s.a, 22, -200))).ok).toBe(false);
      expect((await withPool(line({ no: 2, karat: 22 }), sold(s.a, 21, -300))).ok).toBe(false);
      expect((await withPool(line({ no: 2, karat: 22 }), sold(s.b, 22, -300))).ok).toBe(false);
      expect((await withPool(line({ no: 2, karat: 22 }), sold(s.a, 22, -300, 'SUPPLIER_SETTLEMENT'))).ok).toBe(false);
      expect((await withPool(line({ no: 2, karat: 22 }), (id) => [sold(s.a, 22, -300)(id), sold(s.a, 22, -300)(id)])).ok).toBe(false);
      // The line's own checks.
      for (const bad of [{ karat: 0 }, { karat: 25 }, { grains: 0, weight: 0 }, { weight: 301 }, { rate: 0 }, { price: 0 }, { no: 0 }]) {
        const k = bad.karat ?? 22;
        expect((await withPool(line({ no: 2, karat: k, ...bad }), sold(s.a, k, -(bad.weight ?? 300)))).ok, JSON.stringify(bad)).toBe(false);
      }
      // One line per karat per sale, and per line number.
      expect((await withPool(line({ no: 2 }), sold(s.a, 21, -300))).ok).toBe(false);
      expect((await withPool(line({ karat: 22 }), sold(s.a, 22, -300))).ok).toBe(false);
      // Append-only.
      expect(await refused(h, `UPDATE sale_scrap_lines SET grains = 4, weight_mg = 400 WHERE id = ${good.lineId}`)).toBe(true);
      expect(await refused(h, `DELETE FROM sale_scrap_lines WHERE id = ${good.lineId}`)).toBe(true);
      expect(await one(h, `SELECT count(*)::int AS n FROM sale_scrap_lines`)).toEqual({ n: 1 });
    } finally {
      await h.close();
    }
  }, 120_000);
});
