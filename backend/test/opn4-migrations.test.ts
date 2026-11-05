// OPN-4 migration 0039 on a database migrated up to 0038 that already holds the three roles, a branch manager, a draft
// opening with lines and a sealed-looking opening (both projects):
//   * nothing that exists changes: openings, their lines, every other grant;
//   * `opening.enter` exists and is granted to the branch manager and the General Manager, never to the cashier;
//   * `opening.manage` (and `opening.correct`) stay with the General Manager only; only the description of
//     `opening.manage` changes, to say what it keeps (start, seal, broken scrap);
//   * running the migration's statements a second time changes nothing (idempotent).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { DEFAULT_ROLE_PERMISSIONS, GM_ONLY_PERMISSIONS, PERMISSIONS } from '@jerp/shared';
import { one, openAt, run } from './migration-harness';

const SQL_FILE = path.resolve(__dirname, '../../database/migrations/0039_opn4_opening_enter.sql');

async function seed(h: DatabaseHandle) {
  const id = async (q: string) => Number((await one(h, q)).id);
  const role = (code: string, rank: number) => id(`INSERT INTO roles (code, name, name_ar, is_system, rank) VALUES ('${code}', '${code}', '${code}', true, ${rank}) RETURNING id`);
  const gmRole = await role('GENERAL_MANAGER', 100);
  const bmRole = await role('BRANCH_MANAGER', 50);
  await role('CASHIER', 10);
  for (const p of ['opening.manage', 'opening.correct']) await run(h, `INSERT INTO role_permissions (role_id, permission_code) VALUES (${gmRole}, '${p}') ON CONFLICT DO NOTHING`);
  await run(h, `INSERT INTO role_permissions (role_id, permission_code) VALUES (${bmRole}, 'money_transfers.view') ON CONFLICT DO NOTHING`);
  const a = await id(`INSERT INTO branches (code, name, name_ar, city) VALUES ('UPA', '[Test] A', '[اختبار] أ', 'X') RETURNING id`);
  const gm = await id(`INSERT INTO users (username, full_name, role_id, password_hash, must_change_password) VALUES ('upgrade.alpha', '[Test] GM', ${gmRole}, 'x', false) RETURNING id`);
  await id(`INSERT INTO users (username, full_name, role_id, branch_id, password_hash, must_change_password) VALUES ('upgrade.bravo', '[Test] BM', ${bmRole}, ${a}, 'x', false) RETURNING id`);
  const cat = await id(`INSERT INTO categories (code, name, name_ar) VALUES ('RING', 'Rings', '[اختبار] خواتم') RETURNING id`);
  const draft = await id(`INSERT INTO openings (branch_id, created_by) VALUES (${a}, ${gm}) RETURNING id`);
  for (const n of [1, 2]) {
    await run(h, `INSERT INTO opening_lines (opening_id, line_no, category_id, karat, gross_weight_mg, net_weight_mg, condition, source, created_by) VALUES (${draft}, ${n}, ${cat}, 21, ${3000 + n}, 3000, 'NEW', 'KEYBOARD', ${gm})`);
  }
}

const snapshot = async (h: DatabaseHandle) => ({
  openings: await run(h, `SELECT id, branch_id, status, created_by FROM openings ORDER BY id`),
  lines: await run(h, `SELECT id, opening_id, line_no, karat, gross_weight_mg, net_weight_mg, condition, source, created_by, created_at FROM opening_lines ORDER BY id`),
  grants: await run(h, `SELECT r.code, rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY r.code, rp.permission_code`),
  permissions: await run(h, `SELECT code, description FROM permissions WHERE code <> 'opening.manage' ORDER BY code`),
});

describe('migration 0039 (OPN-4) on a database at 0038 with a draft opening', () => {
  it('grants opening.enter to the branch manager and the General Manager only; nothing else changes; idempotent', async () => {
    const h = await openAt(38);
    try {
      await seed(h);
      const before = await snapshot(h);
      await h.migrate();
      const after = await snapshot(h);
      expect(after.openings).toEqual(before.openings);
      expect(after.lines).toEqual(before.lines);
      const isEnter = (g: Record<string, unknown>) => g.permission_code === 'opening.enter';
      expect(after.grants.filter((g) => !isEnter(g))).toEqual(before.grants);
      expect(after.grants.filter(isEnter).map((g) => g.code)).toEqual(['BRANCH_MANAGER', 'GENERAL_MANAGER']);
      // opening.manage and opening.correct stay with the General Manager only.
      for (const p of ['opening.manage', 'opening.correct']) expect(after.grants.filter((g) => g.permission_code === p).map((g) => g.code), p).toEqual(['GENERAL_MANAGER']);
      // The permission rows: the new one, and the new description of opening.manage (the same text as shared/).
      const perms = Object.fromEntries((await run(h, `SELECT code, description FROM permissions WHERE code IN ('opening.enter', 'opening.manage')`)).map((p) => [p.code, p.description]));
      expect(perms).toEqual({ 'opening.enter': PERMISSIONS['opening.enter'], 'opening.manage': PERMISSIONS['opening.manage'] });
      expect(after.permissions.filter((p) => p.code !== 'opening.enter')).toEqual(before.permissions);

      // Run again (a retried deploy): nothing more.
      const once = await snapshot(h);
      // Each statement exactly as the migrator runs it (the harness's `run` splits on ";", which a description holds).
      for (const stmt of fs.readFileSync(SQL_FILE, 'utf8').split('--> statement-breakpoint')) await h.db.execute(sql.raw(stmt));
      expect(await snapshot(h)).toEqual(once);
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe('D-opn4-1: the default role grants', () => {
  it('opening.enter: the branch manager and the General Manager, not the cashier; it is not General-Manager-only', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.BRANCH_MANAGER).toContain('opening.enter');
    expect(DEFAULT_ROLE_PERMISSIONS.GENERAL_MANAGER).toContain('opening.enter');
    expect(DEFAULT_ROLE_PERMISSIONS.CASHIER).not.toContain('opening.enter');
    expect(GM_ONLY_PERMISSIONS as readonly string[]).not.toContain('opening.enter');
    expect(GM_ONLY_PERMISSIONS as readonly string[]).toEqual(expect.arrayContaining(['opening.manage', 'opening.correct']));
  });
});
