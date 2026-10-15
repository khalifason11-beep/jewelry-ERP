// REM-3 gates (run by `npm run typecheck`): no destructive statement in a new migration without a written
// reason, and no product code that imports test code. Pure functions, tested with sample SQL and sources.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PG_MODE } from './helpers';

type MigrationsGate = {
  BASELINE: number;
  DECISION_FROM: number;
  checkMigrationSql: (sql: string, opts?: { requireDecision?: boolean }) => { statement: number; rule: string; text: string }[];
  migrationNumber: (file: string) => number | null;
  checkMigrationsDir: (dir: string) => unknown[];
  checksum: (text: string) => string;
  checkManifest: (dir: string, manifest: Record<string, string>) => { file: string; kind: string }[];
  recordNew: (dir: string, manifest: Record<string, string>) => string[];
};
type DrizzleGate = { checkDrizzle: (o?: { schema?: string }) => { ok: boolean; output: string; written: string[] } };
type AssetsGate = { assetProblems: (files: { path: string; bytes: number }[]) => { problems: string[]; count: number; total: number } };
type ImportsGate = { isTestImport: (from: string, spec: string, root?: string) => boolean; testImportsIn: (from: string, src: string, root?: string) => string[] };

const ROOT = path.resolve(__dirname, '../..');
let mig: MigrationsGate;
let imp: ImportsGate;
let drz: DrizzleGate;
let ast: AssetsGate;
beforeAll(async () => {
  drz = (await import(path.join(ROOT, 'scripts/check-drizzle.mjs') as string)) as DrizzleGate;
  mig = (await import(path.join(ROOT, 'scripts/check-migrations.mjs') as string)) as MigrationsGate;
  imp = (await import(path.join(ROOT, 'scripts/check-test-imports.mjs') as string)) as ImportsGate;
  ast = (await import(path.join(ROOT, 'scripts/check-assets.mjs') as string)) as AssetsGate;
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

describe('migration gate: applied migrations are frozen (SAFE-1)', () => {
  const real = path.join(ROOT, 'database/migrations');
  const manifest = () => JSON.parse(fs.readFileSync(path.join(real, 'checksums.json'), 'utf8')) as Record<string, string>;
  const copy = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-migsum-'));
    for (const f of fs.readdirSync(real)) if (f.endsWith('.sql')) fs.copyFileSync(path.join(real, f), path.join(dir, f));
    return dir;
  };

  it('the committed manifest lists every migration with its current checksum', () => {
    expect(mig.checkManifest(real, manifest())).toEqual([]);
    expect(Object.keys(manifest())).toHaveLength(fs.readdirSync(real).filter((f) => /^\d{4}_.*\.sql$/.test(f)).length);
  });

  it('fails when an applied migration is edited, deleted, or a new one is not recorded; --record only adds', () => {
    const dir = copy();
    try {
      fs.appendFileSync(path.join(dir, '0010_passkeys.sql'), '\n-- a harmless-looking edit\n');
      fs.rmSync(path.join(dir, '0005_least_privilege_roles.sql'));
      fs.writeFileSync(path.join(dir, '0099_new_thing.sql'), 'ALTER TABLE "x" ADD COLUMN "y" integer;');
      const m = manifest();
      expect(mig.checkManifest(dir, m).sort((a, b) => a.file.localeCompare(b.file))).toEqual([
        { file: '0005_least_privilege_roles.sql', kind: 'missing' },
        { file: '0010_passkeys.sql', kind: 'changed' },
        { file: '0099_new_thing.sql', kind: 'unlisted' },
      ]);
      // Recording adds the new file and never rewrites the edited one.
      expect(mig.recordNew(dir, m)).toEqual(['0099_new_thing.sql']);
      expect(mig.checkManifest(dir, m).map((p) => p.kind).sort()).toEqual(['changed', 'missing']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a Windows (CRLF) checkout hashes the same as LF', () => {
    expect(mig.checksum('A;\r\nB;\r\n')).toBe(mig.checksum('A;\nB;\n'));
  });

  it('from 0023 on, a destructive statement must cite a written D-* decision', () => {
    expect(mig.DECISION_FROM).toBe(23);
    const reasonOnly = '-- allow-destructive: no longer needed\nDROP TABLE "x";';
    const withDecision = '-- allow-destructive: D-abc-3 the owner approved dropping x\nDROP TABLE "x";';
    expect(mig.checkMigrationSql(reasonOnly)).toEqual([]);
    expect(mig.checkMigrationSql(reasonOnly, { requireDecision: true })).toHaveLength(1);
    expect(mig.checkMigrationSql(withDecision, { requireDecision: true })).toEqual([]);
    expect(mig.checkMigrationSql('DELETE FROM "x";', { requireDecision: true })).toHaveLength(1);
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

// drizzle-kit runs without a database, so once (in the PGlite project) is enough.
describe.skipIf(PG_MODE)('drizzle snapshot gate (REM-5)', () => {
  const fixture = (name: string, body: string) => {
    const file = path.join(ROOT, 'database', `.drizzle-check-fixture-${name}.ts`);
    fs.writeFileSync(file, body);
    return { rel: `./${path.basename(file)}`, done: () => fs.rmSync(file, { force: true }) };
  };
  it('passes on the real schema: the snapshots match, drizzle-kit would generate nothing', () => {
    const r = drz.checkDrizzle();
    expect(r.written).toEqual([]);
    expect(r.ok).toBe(true);
  }, 120_000);
  it('fails on a cut-down schema file (the CAT-0 incident: it would generate DROP TABLE for live tables)', () => {
    const f = fixture('cut', "export { branches, users, roles } from './src/schema';\n");
    try {
      const r = drz.checkDrizzle({ schema: f.rel });
      expect(r.ok).toBe(false);
      expect(r.written.length).toBeGreaterThan(0);
    } finally {
      f.done();
    }
  }, 120_000);
  it('fails on a schema change without its migration', () => {
    const src = fs.readFileSync(path.join(ROOT, 'database/src/schema.ts'), 'utf8').replace("  city: text('city').notNull(),", "  city: text('city').notNull(),\n  extraColumn: text('extra_column'),");
    const f = fixture('changed', src.replace(/from '\.\//g, "from './src/"));
    try {
      const r = drz.checkDrizzle({ schema: f.rel });
      expect(r.ok).toBe(false);
      expect(r.written.length, r.output.slice(-400)).toBeGreaterThan(0);
    } finally {
      f.done();
    }
  }, 120_000);
});

describe('asset gate (UI-A2, D-ui-10)', () => {
  const kb = (n: number) => n * 1024;
  it('accepts a slim WebP set and never looks at application assets, references or PDFs', () => {
    const r = ast.assetProblems([
      { path: 'docs/ux/screens/demo/ar-1366x768/01-gm-home.webp', bytes: kb(40) },
      { path: 'docs/ux/ui-kit/ar-1366x768.webp', bytes: kb(70) },
      { path: 'frontend/public/logo.png', bytes: kb(900) },
      { path: 'frontend/src/assets/fonts/amiri.woff2', bytes: kb(400) },
      { path: 'docs/design-reference/login-background.jpg', bytes: kb(190) },
      { path: 'docs/print-check/invoice-A4-original.pdf', bytes: kb(300) },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.count).toBe(2);
  });
  it('refuses a big image, a JPEG capture, a "before" set and more than 4 MB in total', () => {
    expect(ast.assetProblems([{ path: 'docs/ux/screens/x.webp', bytes: kb(151) }]).problems[0]).toMatch(/151 KB \(limit 150 KB\)/);
    expect(ast.assetProblems([{ path: 'docs/ux/screens/x.jpg', bytes: kb(20) }]).problems[0]).toMatch(/not WebP/);
    expect(ast.assetProblems([{ path: 'docs/ux/baseline/before/a.webp', bytes: kb(20) }]).problems.some((p) => /before/.test(p))).toBe(true);
    const many = Array.from({ length: 41 }, (_, i) => ({ path: `docs/ux/screens/${i}.webp`, bytes: kb(100) }));
    expect(ast.assetProblems(many).problems[0]).toMatch(/limit 4 MB/);
  });
});
