#!/usr/bin/env node
// Gate (UI-A2, D-ui-10, run by `npm run typecheck`): screenshots stay small in the repository.
//
// Scans the image files git knows about or would add (tracked, plus untracked files that are not ignored) under
// `docs/ux/`, the only place screenshots are committed (docs/ux/screens/, docs/ux/ui-kit/). It fails when:
//   - their total size is over 4 MB;
//   - one image is over 150 KB;
//   - one is not WebP (JPEG or PNG captures belong in the git-ignored .ux-shots/);
//   - a folder named `before` exists under docs/ (no "before" sets: the previous phase's "after" is in git history).
// Not scanned, so never blocked: the application's own assets (frontend/public, frontend/src, the bundled fonts),
// docs/design-reference/ (logo or login background references) and docs/print-check/ (PDFs).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMITS = { totalBytes: 4 * 1024 * 1024, fileBytes: 150 * 1024 };
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i;

/** Problems for a list of { path, bytes } (paths relative to the repository, forward slashes). */
export function assetProblems(files) {
  const problems = [];
  const shots = files.filter((f) => f.path.startsWith('docs/ux/') && IMAGE.test(f.path));
  const total = shots.reduce((s, f) => s + f.bytes, 0);
  if (total > LIMITS.totalBytes) problems.push(`screenshots under docs/ux/ total ${(total / 1048576).toFixed(1)} MB (limit 4 MB)`);
  for (const f of shots) {
    if (f.bytes > LIMITS.fileBytes) problems.push(`${f.path}: ${Math.round(f.bytes / 1024)} KB (limit 150 KB)`);
    if (!/\.webp$/i.test(f.path)) problems.push(`${f.path}: not WebP (captures go to .ux-shots/; publish with --publish)`);
  }
  for (const f of files) if (f.path.startsWith('docs/') && /(^|\/)before\//.test(f.path)) problems.push(`${f.path}: no "before" sets in the repository`);
  return { problems, count: shots.length, total };
}

function gitFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'docs'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => fs.existsSync(path.join(ROOT, p)))
    .map((p) => ({ path: p, bytes: fs.statSync(path.join(ROOT, p)).size }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let files;
  try {
    files = gitFiles();
  } catch {
    console.log('assets: not a git checkout, skipped.');
    process.exit(0);
  }
  const { problems, count, total } = assetProblems(files);
  if (problems.length) {
    console.error(`Asset check FAILED (D-ui-10):\n${problems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`assets OK: ${count} screenshot(s) under docs/ux/, ${(total / 1048576).toFixed(1)} MB (limits: 4 MB in total, 150 KB each, WebP only).`);
}
