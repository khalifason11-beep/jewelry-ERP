#!/usr/bin/env node
// Gate (DOC-1, run by `npm run typecheck`): a cheap guard against the documentation drifting from the code. It fails when
//   - a migration file in database/migrations/ is not named in docs/DATA_MODEL.md;
//   - a table made append-only by a migration (jerp_lock_append_only) is not named in docs/DATA_MODEL.md;
//   - a permission code of shared/src/permissions.ts is not named in docs/FEATURES.md.
// It checks names only, not what the documents say about them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Problems for the given sources (exported for a quick self-test). */
export function docsProblems({ migrations, migrationSql, permissionsTs, dataModel, features }) {
  const problems = [];
  for (const m of migrations) {
    if (!dataModel.includes(m)) problems.push(`docs/DATA_MODEL.md does not name migration ${m}`);
  }
  const appendOnly = new Set([...migrationSql.matchAll(/jerp_lock_append_only\('([a-z_]+)'\)/g)].map((x) => x[1]));
  for (const table of [...appendOnly].sort()) {
    if (!dataModel.includes(`\`${table}\``)) problems.push(`docs/DATA_MODEL.md does not name append-only table ${table}`);
  }
  const block = permissionsTs.slice(permissionsTs.indexOf('export const PERMISSIONS = {'));
  const body = block.slice(0, block.indexOf('\n};'));
  const codes = [...body.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':/gm)].map((x) => x[1]);
  if (!codes.length) problems.push('no permission code found in shared/src/permissions.ts (parser out of date?)');
  for (const code of codes) {
    if (!features.includes(`\`${code}\``)) problems.push(`docs/FEATURES.md does not name permission ${code}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(ROOT, 'database/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const problems = docsProblems({
    migrations: files.map((f) => f.replace(/\.sql$/, '')),
    migrationSql: files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'),
    permissionsTs: read('shared/src/permissions.ts'),
    dataModel: read('docs/DATA_MODEL.md'),
    features: read('docs/FEATURES.md'),
  });
  if (problems.length) {
    console.error(`check:docs: ${problems.length} problem(s) — update the documentation:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log(`check:docs: ${files.length} migrations, append-only tables and permission codes are documented.`);
}
