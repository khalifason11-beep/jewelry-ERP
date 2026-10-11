#!/usr/bin/env node
// Runs a development command in demo mode, explicitly (CLN-1, D-cln1-1): APP_MODE has no default any more, so the
// development entry points (`npm run dev`, `npm run dev:sample`) say APP_MODE=demo here, on every platform (no shell
// syntax needed on Windows). If APP_MODE is already set to anything else, it refuses instead of overriding it.
//
//   node ../scripts/demo-mode.mjs <command> [args…]

import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('Usage: node scripts/demo-mode.mjs <command> [args…]');
  process.exit(2);
}
const current = process.env.APP_MODE;
if (current !== undefined && current !== '' && current !== 'demo') {
  console.error(`Refusing to run "${cmd}" in demo mode: APP_MODE is "${current}". This command is for APP_MODE=demo only.`);
  process.exit(1);
}
const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, APP_MODE: 'demo' }, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
