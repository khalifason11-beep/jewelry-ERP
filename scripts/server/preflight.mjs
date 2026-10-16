#!/usr/bin/env node
// Server preflight (SAFE-1): read-only checks before a first start or an update, one line per check with the fix.
// Usage, with the service's environment loaded (docs/runbooks/first-deploy.md step 6):
//   node scripts/server/preflight.mjs
// Exit code 0 when nothing FAILs (WARN lines are explained), 1 otherwise. It never writes: the database is opened with
// default_transaction_read_only=on and nothing is migrated or created. Provider-neutral; the checks themselves are in
// backend/src/preflight.ts and reuse the server's own start-up checks.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checks = [];
const add = (c) => checks.push(c);

// 1. Node (before anything else is loaded).
const major = Number(process.versions.node.split('.')[0]);
add(major >= 20
  ? { name: 'node', status: 'PASS', detail: `Node ${process.versions.node}` }
  : { name: 'node', status: 'FAIL', detail: `Node ${process.versions.node}; 20 or newer is required`, fix: 'Install Node.js 22 LTS.' });

// 2. APP_MODE (the configuration module refuses to load without it, so it is checked here first).
const mode = process.env.APP_MODE;
if (mode === 'production') add({ name: 'app mode', status: 'PASS', detail: 'APP_MODE=production' });
else if (mode === 'demo') add({ name: 'app mode', status: 'FAIL', detail: 'APP_MODE=demo: a trial installation, every production refusal is off', fix: 'Set APP_MODE=production on a real server.' });
else add({ name: 'app mode', status: 'FAIL', detail: mode ? `APP_MODE="${mode}" is not valid` : 'APP_MODE is not set', fix: 'Set APP_MODE=production (exact spelling).' });

if (major >= 20 && (mode === 'production' || mode === 'demo')) {
  try {
    const env = { ...process.env };
    process.env.LOG_LEVEL = 'error'; // the checks print their own lines
    const { register } = await import('tsx/esm/api');
    register();
    const { serverChecks } = await import(pathToFileURL(path.join(ROOT, 'backend/src/preflight.ts')).href);
    for (const c of await serverChecks({ ...env, APP_MODE: 'production' })) add(c);
  } catch (e) {
    add({ name: 'preflight', status: 'FAIL', detail: e instanceof Error ? e.message : String(e), fix: 'Run `npm ci --include=dev` in the application directory.' });
  }
}

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  if (c.fix && c.status !== 'PASS') console.log(`${' '.repeat(6 + width)}  fix: ${c.fix}`);
}
const count = (s) => checks.filter((c) => c.status === s).length;
const failed = count('FAIL');
console.log(`\npreflight: ${count('PASS')} PASS, ${count('WARN')} WARN, ${failed} FAIL, ${count('SKIP')} SKIP: ${failed ? 'NOT READY: fix every FAIL' : count('WARN') ? 'no FAIL; read every WARN' : 'ready'}`);
process.exit(failed ? 1 : 0);
