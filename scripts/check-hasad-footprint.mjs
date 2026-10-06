#!/usr/bin/env node
// Hasad footprint guard (BACKLOG REM-2). Hasad is only a payment method / sales channel (SPEC §10).
// Fails when "hasad" (any case) or the Arabic word "حصاد" appears in the source outside the explicit
// allow-list scripts/hasad-footprint-allowlist.json, so the removed withdrawal workspace cannot creep
// back unnoticed. Also fails on stale allow-list entries (an entry that no longer matches anything),
// so the list stays exact. Run by `npm run typecheck` (like check:lockfile) and `npm run check:hasad`.
//
// Scanned: backend/src, shared/src, frontend/src (incl. the Arabic catalogue), database/src, scripts.
// Not scanned: tests, migrations (database/migrations: history), docs, this script and its allow-list.
//
// How to add an entry (only for one of the allowed categories):
//   { "category": "<one of CATEGORIES below>",
//     "files": ["path/relative/to/repo.ts", ...],   // exact paths
//     "match": "<regular expression, case-insensitive, tested against each offending line>",
//     "reason": "<why this occurrence is allowed>" }
// Keep `match` as narrow as possible. A line is allowed when an entry lists its file and matches it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(root, 'scripts/hasad-footprint-allowlist.json');
const SCAN = ['backend/src', 'shared/src', 'frontend/src', 'database/src', 'scripts'];
const SELF = new Set(['scripts/check-hasad-footprint.mjs', 'scripts/hasad-footprint-allowlist.json']);
const EXT = /\.(ts|tsx|mts|js|mjs|cjs|json|css|html)$/;
const WORD = /hasad|حصاد/i;
const CATEGORIES = new Set([
  'PAYMENT_METHOD', // the HASAD payment method, its labels and the counter's method list
  'POS_REFERENCES', // the Hasad invoice number / transaction reference typed at the POS and printed
  'RECEIVABLE', // the HASAD_RECEIVABLE account and its settlement by Hasad's bank transfer
  'DEPRECATED_UNTIL_REM5', // schema, enum values, CHECKs, classifications and history labels kept until REM-5
  'MIGRATION', // code that refers to what a migration did
  'REMOVAL_COMMENT', // comments explaining the removal
  'GUARD', // checks that prove the removal (rehearsal)
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

const entries = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
const problems = [];
entries.forEach((e, i) => {
  if (!CATEGORIES.has(e.category)) problems.push(`allow-list entry #${i + 1}: unknown category "${e.category}"`);
  if (!Array.isArray(e.files) || !e.files.length) problems.push(`allow-list entry #${i + 1}: "files" must list at least one path`);
  if (!e.reason || e.reason.trim().length < 10) problems.push(`allow-list entry #${i + 1}: a reason is required`);
  try {
    e.re = new RegExp(e.match, 'i');
  } catch (err) {
    problems.push(`allow-list entry #${i + 1}: invalid "match": ${err.message}`);
  }
  e.used = 0;
});

const offending = [];
for (const file of SCAN.flatMap((d) => walk(path.join(root, d)))) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (SELF.has(rel)) continue;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
    if (!WORD.test(line)) return;
    const hit = entries.find((e) => e.re && e.files.includes(rel) && e.re.test(line));
    if (hit) hit.used++;
    else offending.push(`${rel}:${n + 1}: ${line.trim().slice(0, 160)}`);
  });
}

entries.forEach((e, i) => {
  if (e.re && !e.used) problems.push(`stale allow-list entry #${i + 1} (${e.category}: ${e.reason}) matches nothing; remove it`);
});

if (offending.length) {
  problems.push(
    `"hasad" outside the allow-list (${offending.length} line(s)). Hasad is only a payment method (SPEC §10, REM-2). ` +
      'Remove it, or add a narrow entry to scripts/hasad-footprint-allowlist.json (see the header of scripts/check-hasad-footprint.mjs):\n  ' +
      offending.join('\n  '),
  );
}
if (problems.length) {
  console.error(`Hasad footprint check FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`hasad footprint OK: ${entries.reduce((s, e) => s + e.used, 0)} allowed line(s) across ${entries.length} allow-list entries.`);
