#!/usr/bin/env node
// `npm run verify` (SAFE-1): the gates in order, stopping at the first failure, then a one-screen summary.
// A thin wrapper: every step is an existing script, run exactly as a contributor or CI runs it.
//
//   npm run verify                  typecheck, tests (PGlite), tests (PostgreSQL), build, i18n:check
//   npm run verify -- --full        the same, then REH-1, e2e print, passkeys on and off, states, add piece, UI kit, perf
//
// PostgreSQL steps need a role that may CREATE DATABASE (never a production URL: the tests create and drop databases):
//   TEST_DATABASE_URL=postgresql://jerp_test:<pw>@localhost:5432/postgres   (REH-1 and perf use it too, unless
//   REHEARSAL_ADMIN_URL is set). Without it those steps print a loud SKIPPED line; they are not counted as passed.
// The --full steps also need Playwright with Chromium (`npm install -g playwright@1.56.1 && playwright install chromium`).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const pgUrl = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.REHEARSAL_ADMIN_URL || pgUrl;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NO_PG = 'TEST_DATABASE_URL is not set';

/** name, command, args, extra env, why it is skipped (or undefined). */
const steps = [
  ['typecheck', npm, ['run', 'typecheck']],
  ['tests (PGlite)', npm, ['exec', '-w', '@jerp/backend', '--', 'vitest', 'run', '--project', 'pglite']],
  // What `npm run test:pg -w @jerp/backend` runs, without its POSIX-only variable syntax (works on Windows too).
  ['tests (PostgreSQL)', npm, ['exec', '-w', '@jerp/backend', '--', 'vitest', 'run', '--project', 'postgres'], { REQUIRE_PG_TESTS: '1' }, pgUrl ? undefined : NO_PG],
  ['build', npm, ['run', 'build']],
  ['i18n:check', npm, ['run', 'i18n:check']],
];
if (full) {
  const noAdmin = adminUrl ? undefined : 'REHEARSAL_ADMIN_URL / TEST_DATABASE_URL is not set';
  steps.push(
    ['REH-1 rehearsal', process.execPath, ['scripts/rehearsal/rehearsal.mjs', '--skip-build'], { REHEARSAL_ADMIN_URL: adminUrl }, noAdmin],
    ['e2e print', process.execPath, ['scripts/e2e-print.mjs']],
    ['e2e passkeys (on)', process.execPath, ['scripts/e2e-passkeys.mjs']],
    ['e2e passkeys (off)', process.execPath, ['scripts/e2e-passkeys.mjs', '--mode=off']],
    ['e2e states', process.execPath, ['scripts/e2e-states.mjs']],
    ['e2e add piece', process.execPath, ['scripts/e2e-add-piece.mjs']],
    ['e2e prices', process.execPath, ['scripts/e2e-prices.mjs']],
    ['e2e corrections', process.execPath, ['scripts/e2e-corrections.mjs']],
    // --no-shots: the checks only, so the committed screenshots in docs/ux/ui-kit are not rewritten.
    ['UI kit', process.execPath, ['scripts/capture-ui-kit.mjs', '--no-shots']],
    ['perf (homes)', process.execPath, ['scripts/perf-homes.mjs'], { REHEARSAL_ADMIN_URL: adminUrl }, noAdmin],
  );
}

const results = [];
const started = Date.now();
for (const [name, cmd, args, env = {}, skip] of steps) {
  if (skip) {
    console.log(`\n${'!'.repeat(100)}\n!!! SKIPPED: ${name}: ${skip}\n${'!'.repeat(100)}`);
    results.push({ name, status: 'SKIPPED', detail: skip });
    continue;
  }
  console.log(`\n=== verify: ${name} ===`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  const secs = Math.round((Date.now() - t0) / 1000);
  const ok = r.status === 0;
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail: `${secs} s${ok ? '' : `, exit ${r.status ?? r.signal ?? r.error?.message}`}` });
  if (!ok) break;
}
for (const [name] of steps.slice(results.length)) results.push({ name, status: 'NOT RUN', detail: 'stopped at the first failure' });

const width = Math.max(...results.map((r) => r.name.length));
const failed = results.some((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIPPED').length;
console.log(`\n${'─'.repeat(60)}\nverify${full ? ' --full' : ''} summary (${Math.round((Date.now() - started) / 1000)} s)`);
for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.name.padEnd(width)}  ${r.detail}`);
console.log(`${'─'.repeat(60)}\n${failed ? 'VERIFY FAILED' : skipped ? `VERIFY PASSED WITH ${skipped} SKIPPED STEP(S): not a full verification` : 'VERIFY PASSED'}`);
process.exit(failed ? 1 : 0);
