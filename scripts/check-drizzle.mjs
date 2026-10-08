#!/usr/bin/env node
// Gate (REM-5, run by `npm run typecheck`): the drizzle snapshots match the COMPLETE schema. It runs
// `drizzle-kit generate` against a throw-away copy of database/migrations and fails if drizzle-kit would write a
// migration: a schema change without its migration, a hand edit that desynchronised a snapshot, or a schema file
// that is missing tables (the CAT-0 incident: a cut-down schema made drizzle-kit generate DROP TABLE for live
// tables). Needs no database. CHECKs and triggers are not in drizzle snapshots (hand-written, see
// shared/src/db-checks.ts and backend/test/phase2a.test.ts), so they are out of scope here.
//
//   node scripts/check-drizzle.mjs                    # the real schema
//   node scripts/check-drizzle.mjs --schema=<file>    # another schema file (tests), relative to database/

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'database');

/** Returns { ok, output, written }: written lists the files drizzle-kit would have added. */
export function checkDrizzle({ schema = './src/schema.ts' } = {}) {
  const work = fs.mkdtempSync(path.join(DB, '.drizzle-check-'));
  const rel = `./${path.basename(work)}`;
  try {
    fs.cpSync(path.join(DB, 'migrations'), path.join(work, 'migrations'), { recursive: true });
    const before = new Set(fs.readdirSync(path.join(work, 'migrations')));
    fs.writeFileSync(
      path.join(work, 'drizzle.config.ts'),
      `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ dialect: 'postgresql', schema: [${JSON.stringify(schema)}], out: ${JSON.stringify(`${rel}/migrations`)}, schemaFilter: ['public'] });\n`,
    );
    const r = spawnSync('npx', ['drizzle-kit', 'generate', '--config', `${rel}/drizzle.config.ts`, '--name', 'drizzle_check'], { cwd: DB, encoding: 'utf8', input: '', timeout: 120_000 });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const written = fs.readdirSync(path.join(work, 'migrations')).filter((f) => !before.has(f));
    const ok = r.status === 0 && written.length === 0 && /No schema changes/.test(output);
    return { ok, output, written };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const schema = process.argv.find((a) => a.startsWith('--schema='))?.split('=')[1];
  const { ok, output, written } = checkDrizzle(schema ? { schema } : {});
  if (!ok) {
    console.error('Drizzle check FAILED: the snapshots do not match database/src/schema.ts.');
    if (written.length) console.error(`drizzle-kit would write: ${written.join(', ')}`);
    console.error(output.split('\n').slice(-15).join('\n'));
    console.error('Generate the migration from the COMPLETE schema (npm run generate -w @jerp/database), review it, and commit it with its snapshot.');
    process.exit(1);
  }
  console.log('drizzle OK: the snapshots match the complete schema (drizzle-kit would generate nothing).');
}
