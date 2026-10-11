#!/usr/bin/env node
// Phase gate (UI-B, D-ui-21): times the homes and the attention list on a large PostgreSQL database and fails when a
// p95 is above the budget. The harness itself is test code (backend/test/perf/perf-homes.ts: it uses the fixture
// world), so it runs in a child process here.
//
//   REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>@localhost:5432/postgres node scripts/perf-homes.mjs [--explain] [--keep]

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('npx', ['tsx', 'test/perf/perf-homes.ts', ...process.argv.slice(2)], { cwd: path.join(ROOT, 'backend'), stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
