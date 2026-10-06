#!/usr/bin/env node
// Gate (REM-3, run by `npm run typecheck`): product code never depends on test code. Any import, dynamic
// import or require in backend/src, frontend/src, shared/src, database/src or scripts that resolves into
// backend/test/** (or any folder named `fixtures`) fails the check. The test world (backend/test/fixtures)
// replaced the demo seed and must never ship.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT_DIRS = ['backend/src', 'frontend/src', 'shared/src', 'database/src', 'scripts'];
const EXT = /\.(m?[jt]sx?|cjs)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;

/** Is this module specifier (as written in `fromFile`) test code? */
export function isTestImport(fromFile, spec, root = ROOT) {
  if (/(^|\/)fixtures(\/|$)/.test(spec)) return true;
  if (/(^|\/)backend\/test(\/|$)/.test(spec)) return true;
  if (!spec.startsWith('.')) return false;
  const target = path.relative(root, path.resolve(path.dirname(fromFile), spec)).split(path.sep).join('/');
  return target === 'backend/test' || target.startsWith('backend/test/') || /(^|\/)fixtures(\/|$)/.test(target);
}

/** The offending specifiers in one source text. */
export function testImportsIn(fromFile, source, root = ROOT) {
  const bad = [];
  for (const m of source.matchAll(SPECIFIER)) if (isTestImport(fromFile, m[2], root)) bad.push(m[2]);
  return bad;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.test(e.name)) yield p;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const failures = [];
  let files = 0;
  for (const d of PRODUCT_DIRS) {
    for (const f of walk(path.join(ROOT, d))) {
      if (path.resolve(f) === fileURLToPath(import.meta.url)) continue; // this file names the patterns
      files++;
      for (const spec of testImportsIn(f, fs.readFileSync(f, 'utf8'))) failures.push(`${path.relative(ROOT, f)} imports ${spec}`);
    }
  }
  if (failures.length) {
    console.error('Test-import check FAILED: product code imports test code (backend/test or a fixtures folder):');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`test imports OK: ${files} product file(s) import nothing from backend/test or fixtures.`);
}
