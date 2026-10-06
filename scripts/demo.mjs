#!/usr/bin/env node
// `npm run demo`: build the UI, make sure the local demo database has its first General Manager
// (backend/src/demo-cli.ts asks for the username when the terminal is interactive), then start the server.
// Demo mode starts EMPTY (REM-3). For a populated local database (screenshots), see `npm run dev:sample`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_NEEDS_BOOTSTRAP = 10;
const run = (cmd, args, cwd = ROOT) => spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, APP_MODE: process.env.APP_MODE || 'demo' } });

let r = run('npm', ['run', 'build']);
if (r.status !== 0) process.exit(r.status ?? 1);
r = run('npx', ['tsx', 'src/demo-cli.ts'], path.join(ROOT, 'backend'));
if (r.status === EXIT_NEEDS_BOOTSTRAP) process.exit(0); // the command to run was printed; nothing else to do
if (r.status !== 0) process.exit(r.status ?? 1);
r = run('npm', ['start']);
process.exit(r.status ?? 0);
