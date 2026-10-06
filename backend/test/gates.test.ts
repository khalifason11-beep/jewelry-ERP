// REM-3 gates (run by `npm run typecheck`): no destructive statement in a new migration without a written
// reason, and no product code that imports test code. Pure functions, tested with sample SQL and sources.

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

type MigrationsGate = {
  BASELINE: number;
  checkMigrationSql: (sql: string) => { statement: number; rule: string; text: string }[];
  migrationNumber: (file: string) => number | null;
  checkMigrationsDir: (dir: string) => unknown[];
};
type ImportsGate = { isTestImport: (from: string, spec: string, root?: string) => boolean; testImportsIn: (from: string, src: string, root?: string) => string[] };

const ROOT = path.resolve(__dirname, '../..');
let mig: MigrationsGate;
let imp: ImportsGate;
beforeAll(async () => {
  mig = (await import(path.join(ROOT, 'scripts/check-migrations.mjs') as string)) as MigrationsGate;
  imp = (await import(path.join(ROOT, 'scripts/check-test-imports.mjs') as string)) as ImportsGate;
});

const BREAK = '\n--> statement-breakpoint\n';

describe('migration gate', () => {
  it.each([
    ['DROP TABLE "jewelry_items";', 'DROP TABLE'],
    ['DROP SCHEMA IF EXISTS "hasad_mock" CASCADE;', 'DROP SCHEMA'],
    ['ALTER TABLE "users" DROP COLUMN "phone";', 'DROP COLUMN'],
    ['TRUNCATE TABLE "sales";', 'TRUNCATE'],
    ['TRUNCATE ledger_entries;', 'TRUNCATE'],
    ['DELETE FROM "settings" WHERE key = \'x\';', 'DELETE FROM'],
    ['ALTER TABLE "sales" ALTER COLUMN "total" SET DATA TYPE numeric;', 'ALTER COLUMN … TYPE'],
    ['ALTER TABLE "sales" ALTER COLUMN total TYPE bigint;', 'ALTER COLUMN … TYPE'],
    ['ALTER TABLE "sales" RENAME COLUMN "total" TO "amount";', 'RENAME'],
    ['ALTER TABLE "sales" RENAME TO "invoices";', 'RENAME'],
    ['ALTER TABLE "sales" DROP CONSTRAINT "ck_sales_total";', 'DROP CONSTRAINT'],
    ['DROP TRIGGER IF EXISTS "trg_ledger_append_only" ON "ledger_entries";', 'DROP TRIGGER'],
    ['ALTER TABLE "ledger_entries" DISABLE TRIGGER ALL;', 'DISABLE TRIGGER'],
    ['DROP FUNCTION IF EXISTS jerp_refuse_change();', 'DROP FUNCTION'],
    ['REVOKE INSERT ON "audit_logs" FROM jerp_runtime;', 'REVOKE'],
  ])('refuses %s without a reason', (sql, rule) => {
    expect(mig.checkMigrationSql(sql).map((p) => p.rule)).toContain(rule);
  });

  it('accepts the same statement with "-- allow-destructive: <reason>" inside it', () => {
    expect(mig.checkMigrationSql('-- allow-destructive: REM-5 drops the expenses table (no rows since REM-1)\nDROP TABLE "expenses";')).toEqual([]);
    // Replacing a CHECK constraint legitimately needs the comment (decisions.md D-rem3-6).
    const replace = ['-- allow-destructive: replace ck_sales_payment_method with the new list\nALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "ck_sales_payment_method";', 'ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_payment_method" CHECK (payment_method IN (\'CASH\'));'].join(BREAK);
    expect(mig.checkMigrationSql(replace)).toEqual([]);
    // The reason must be a real text, and it covers only its own statement.
    expect(mig.checkMigrationSql('-- allow-destructive:\nDROP TABLE "x";')).toHaveLength(1);
    expect(mig.checkMigrationSql(['-- allow-destructive: first only\nDROP TABLE "a";', 'DROP TABLE "b";'].join(BREAK))).toEqual([expect.objectContaining({ statement: 2, rule: 'DROP TABLE' })]);
  });

  it('allows DROP INDEX, DROP NOT NULL and DROP DEFAULT, and ignores keywords in comments, strings and triggers that forbid TRUNCATE', () => {
    expect(
      mig.checkMigrationSql(
        [
          'DROP INDEX IF EXISTS "products_name_idx";',
          'ALTER TABLE "products" ALTER COLUMN "name" DROP NOT NULL;',
          'ALTER TABLE "products" ALTER COLUMN "is_active" DROP DEFAULT;',
          '-- we never DROP TABLE here\nCREATE TABLE "t" ("id" serial);',
          'INSERT INTO "audit_logs" ("description") VALUES (\'DELETE FROM is only a word here\');',
          'CREATE TRIGGER "trg_x" BEFORE UPDATE OR DELETE OR TRUNCATE ON "x" FOR EACH STATEMENT EXECUTE FUNCTION f();',
        ].join(BREAK),
      ),
    ).toEqual([]);
  });

  it('applies only to migrations numbered after the baseline (0015) — today none, so the real folder passes', () => {
    expect(mig.BASELINE).toBe(15);
    expect(mig.migrationNumber('0016_drop_expenses.sql')).toBe(16);
    expect(mig.migrationNumber('meta')).toBeNull();
    expect(mig.checkMigrationsDir(path.join(ROOT, 'database/migrations'))).toEqual([]);
  });

  it('would have stopped the CAT-0 drizzle-kit incident (generated DROP TABLE of live tables)', () => {
    const generated = ['DROP TABLE "jewelry_items" CASCADE;', 'DROP TABLE "item_status_history" CASCADE;', 'DROP TABLE "inventory_movements" CASCADE;'].join(BREAK);
    expect(mig.checkMigrationSql(generated)).toHaveLength(3);
  });
});

describe('test-import gate', () => {
  const from = (rel: string) => path.join(ROOT, rel);
  it('flags product code importing backend/test or a fixtures folder', () => {
    expect(imp.isTestImport(from('backend/src/server.ts'), '../test/fixtures/world', ROOT)).toBe(true);
    expect(imp.isTestImport(from('backend/src/modules/x/service.ts'), '../../../test/helpers', ROOT)).toBe(true);
    expect(imp.isTestImport(from('scripts/x.mjs'), '../backend/test/fixtures/world.ts', ROOT)).toBe(true);
    expect(imp.isTestImport(from('frontend/src/a.ts'), '@jerp/backend/test/fixtures/world', ROOT)).toBe(true);
    expect(imp.testImportsIn(from('backend/src/a.ts'), "import { seedWorld } from '../test/fixtures/world';\nconst w = await import('../test/fixtures/world-data');\nconst r = require('../test/helpers');", ROOT)).toHaveLength(3);
  });
  it('allows ordinary imports', () => {
    expect(imp.testImportsIn(from('backend/src/a.ts'), "import { t } from '@jerp/database';\nimport { x } from './core/test-utils-not-a-folder';\nimport fs from 'node:fs';", ROOT)).toEqual([]);
  });
});
