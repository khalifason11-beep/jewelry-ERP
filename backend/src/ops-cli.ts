// Operator console — requires shell access to the server (it is never exposed over HTTP).
//
//   npm run ops -w @jerp/backend -- unlock --username <user>
//   npm run ops -w @jerp/backend -- reset-gm-password --username <gm user>
//
// It targets the database configured in the environment (DATABASE_URL). It refuses to run unless
// APP_MODE=production, so a demo database is never touched by mistake; pass --allow-non-production
// to run it deliberately against a demo/test database. Every action is written to the audit log.

import os from 'node:os';
import { parseArgs } from 'node:util';
import { config } from './config';
import { createContext, openDatabase } from './bootstrap';
import { productionConfigProblems } from './core/startup';
import { operatorResetGmPassword, operatorUnlock } from './modules/ops/service';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    username: { type: 'string' },
    'allow-non-production': { type: 'boolean', default: false },
  },
  strict: true,
});

const command = positionals[0];
if (!['unlock', 'reset-gm-password'].includes(command ?? '') || !values.username) {
  console.error('Usage: npm run ops -w @jerp/backend -- <unlock|reset-gm-password> --username <user> [--allow-non-production]');
  process.exit(2);
}
if (config.appMode !== 'production' && !values['allow-non-production']) {
  console.error(`Refusing to run: APP_MODE is "${config.appMode}", not "production". Pass --allow-non-production to run against this database on purpose.`);
  process.exit(1);
}
const problems = productionConfigProblems(config);
if (problems.length) {
  console.error(`Refusing to run: unsafe production configuration:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

const operator = { host: os.hostname(), osUser: os.userInfo().username };
const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrationUrl: config.migrationDatabaseUrl });
try {
  const ctx = createContext(handle);
  if (command === 'unlock') {
    const r = await operatorUnlock(ctx, values.username, operator);
    console.log(`Sign-in lock of "${r.username}" lifted (audited as operator-cli from ${operator.osUser}@${operator.host}).`);
  } else {
    const r = await operatorResetGmPassword(ctx, values.username, operator);
    console.log(`Password of "${r.username}" reset; all sessions ended (audited as operator-cli from ${operator.osUser}@${operator.host}).`);
    console.log(`One-time password (shown once, must be changed at next sign-in): ${r.temporaryPassword}`);
  }
} catch (e) {
  console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
