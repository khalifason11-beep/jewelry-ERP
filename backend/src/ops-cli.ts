// Operator console — requires shell access to the server (it is never exposed over HTTP).
//
//   npm run ops -w @jerp/backend -- unlock --username <user>
//   npm run ops -w @jerp/backend -- reset-gm-password --username <gm user>
//   npm run ops -w @jerp/backend -- reset-second-factor --username <user> --confirm
//   npm run ops -w @jerp/backend -- unlock-security-lock --username <user> --confirm
//
// It targets the database configured in the environment (DATABASE_URL). It refuses to run unless
// APP_MODE=production, so a demo database is never touched by mistake; pass --allow-non-production
// to run it deliberately against a demo/test database. Every action is written to the audit log.

import os from 'node:os';
import { parseArgs } from 'node:util';
import { config } from './config';
import { createContext, openDatabase } from './bootstrap';
import { productionConfigProblems } from './core/startup';
import { operatorResetGmPassword, operatorResetSecondFactor, operatorUnlock, operatorUnlockSecurityLock } from './modules/ops/service';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    username: { type: 'string' },
    'allow-non-production': { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
  },
  strict: true,
});

const command = positionals[0];
if (!['unlock', 'reset-gm-password', 'reset-second-factor', 'unlock-security-lock'].includes(command ?? '') || !values.username) {
  console.error('Usage: npm run ops -w @jerp/backend -- <unlock|reset-gm-password|reset-second-factor|unlock-security-lock> --username <user> [--confirm] [--allow-non-production]');
  process.exit(2);
}
if (command === 'reset-second-factor' && !values.confirm) {
  console.error('reset-second-factor revokes every passkey and recovery code of the user and ends their sessions. Run it again with --confirm to proceed.');
  process.exit(2);
}
if (command === 'unlock-security-lock' && !values.confirm) {
  console.error('unlock-security-lock lifts the security lock, revokes every passkey and recovery code, issues a new one-time password and ends the sessions. Run it again with --confirm to proceed.');
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
  } else if (command === 'reset-second-factor') {
    const r = await operatorResetSecondFactor(ctx, values.username, operator);
    console.log(`Second factor of "${r.username}" reset: ${r.revoked} passkey(s) revoked, ${r.recoveryCodesInvalidated} recovery code(s) invalidated, sessions ended (audited as operator-cli from ${operator.osUser}@${operator.host}).`);
    console.log('At the next sign-in (password only) the user must register a new passkey and new recovery codes. If the password may be known to someone else, run reset-gm-password too.');
  } else if (command === 'unlock-security-lock') {
    const r = await operatorUnlockSecurityLock(ctx, values.username, operator);
    console.log(`Security lock of "${r.username}" lifted: ${r.revoked} passkey(s) revoked, ${r.recoveryCodesInvalidated} recovery code(s) invalidated, sessions ended (audited as operator-cli from ${operator.osUser}@${operator.host}).`);
    console.log(`One-time password (shown once; give it to the user in person; must be changed at next sign-in): ${r.temporaryPassword}`);
    console.log('After the new password the user must register a new passkey and new recovery codes.');
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
