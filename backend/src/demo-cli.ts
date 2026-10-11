// `npm run demo` step 2 (scripts/demo.mjs): make sure a local demo-mode database has its first General
// Manager before the server starts (REM-3: demo mode starts EMPTY, exactly like production).
//
// - A General Manager exists            → exit 0 (the server starts).
// - None, and the terminal is interactive → ask for the username (the normal bootstrap rules apply:
//   at least 8 characters, no role-style words; there is no demo-only shortcut), run the REAL bootstrap
//   and print the one-time password → exit 0.
// - None, and not interactive            → print the full bootstrap command and exit with code 10 so
//   scripts/demo.mjs stops cleanly without starting the server.
// Never runs in production.

import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { config } from './config';
import { createContext, openDatabase } from './bootstrap';
import { assertOperatorUsername, bootstrapProduction } from './modules/bootstrap/service';
import { AppError } from './core/errors';

export const EXIT_NEEDS_BOOTSTRAP = 10;

if (config.appMode !== 'demo') {
  console.error('`npm run demo` is for APP_MODE=demo only. In production use `npm run bootstrap -w @jerp/backend` (docs/DEPLOYMENT.md).');
  process.exit(1);
}

const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrationUrl: config.migrationDatabaseUrl });
try {
  const ctx = createContext(handle);
  const [gm] = await ctx.db
    .select({ id: t.users.id })
    .from(t.users)
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .where(eq(t.roles.code, 'GENERAL_MANAGER'))
    .limit(1);
  if (gm) {
    process.exitCode = 0;
  } else if (!process.stdin.isTTY) {
    console.log(
      [
        'This demo database is empty: no General Manager yet.',
        'Create the first General Manager with the real bootstrap command (choose your own username:',
        'at least 8 characters, no role-style words such as "admin" or "manager"), then start again:',
        '',
        '  npm run bootstrap -w @jerp/backend -- --username <your.name> --full-name "<Your Name>" [--full-name-ar "<الاسم>"]',
        '  npm run demo',
        '',
      ].join('\n'),
    );
    process.exitCode = EXIT_NEEDS_BOOTSTRAP;
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('This demo database is empty. Create the first General Manager (the same rules as in production).');
    let username = '';
    for (;;) {
      username = (await rl.question('General Manager username (at least 8 characters, e.g. o.abdelrahman): ')).trim().toLowerCase();
      try {
        if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new AppError(400, 'BAD_REQUEST', 'Username: 3–40 chars, letters, digits, dot, dash, underscore');
        assertOperatorUsername(username);
        break;
      } catch (e) {
        console.log(`  ${e instanceof AppError ? e.message : String(e)}`);
      }
    }
    let fullName = '';
    while (fullName.length < 2) fullName = (await rl.question('Full name: ')).trim();
    const fullNameAr = (await rl.question('Full name in Arabic (optional): ')).trim() || undefined;
    rl.close();
    const res = await bootstrapProduction(ctx, { username, fullName, fullNameAr });
    console.log(`\nGeneral Manager "${res.username}" created.`);
    console.log(`One-time password (shown once, must be changed at first sign-in): ${res.temporaryPassword}\n`);
    process.exitCode = 0;
  }
} finally {
  await handle.close();
}
