import { config } from './config';
import { createApp } from './app';
import { createContext, isEmpty, openDatabase } from './bootstrap';
import { log } from './core/logger';
import { demoCredentialsInUse, productionConfigProblems, runtimeRoleProblems, unvalidatedConstraints } from './core/startup';
import { applyInitialSecuritySettings, purgeExpiredSecondFactorState } from './modules/auth/passkeys';
import { replaceLegacyInvoiceFooters } from './modules/settings/legacy-footer';

// ── Refuse unsafe production configurations before touching the database (security item 2).
const problems = productionConfigProblems(config);
if (problems.length) {
  log.error('refusing to start: unsafe production configuration', { problems });
  process.exit(1);
}

const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrationUrl: config.migrationDatabaseUrl });
const ctx = createContext(handle);

const notValidated = await unvalidatedConstraints(handle.db);
if (notValidated.length) {
  log.warn('integrity constraints left NOT VALID: existing rows violate them (new rows are still checked); correct the rows, then run ALTER TABLE … VALIDATE CONSTRAINT', { constraints: notValidated });
}

// REM-3: no demo data. A demo-mode database starts empty, exactly like production; `npm run demo`
// asks for the first General Manager's username and runs the real bootstrap (scripts/demo.mjs).
if (config.appMode === 'demo') {
  if (await isEmpty(ctx)) log.warn('no users yet: run `npm run demo` (asks for the first General Manager) or `npm run bootstrap -w @jerp/backend`');
} else {
  // Least privilege (D-2a-13): the runtime role must not own or be able to alter the append-only tables.
  const roles = await runtimeRoleProblems(handle.db);
  if (roles.superuser || roles.tables.length) {
    const details = {
      role: roles.role,
      superuser: roles.superuser,
      tables: roles.tables.map((r) => `${r.table}${r.owns ? ' (owner)' : ''}${r.update ? ' UPDATE' : ''}${r.delete ? ' DELETE' : ''}${r.truncate ? ' TRUNCATE' : ''}`),
      fix: 'Run migrations as an owner role (MIGRATION_DATABASE_URL) and connect the app (DATABASE_URL) as a runtime role with only SELECT/INSERT on these tables: see docs/DEPLOYMENT.md, "Separate owner and runtime roles".',
    };
    if (config.strictDbRoles) {
      log.error('refusing to start: the database role can alter the append-only tables (STRICT_DB_ROLES=true)', details);
      await handle.close();
      process.exit(1);
    }
    log.warn('SECURITY WARNING: the database role can alter the append-only tables (audit log, ledgers). Anyone with the app credentials could rewrite history.', details);
  }
  // Production never seeds demo data, and never runs with a published demo password.
  const leaked = await demoCredentialsInUse(handle.db);
  if (leaked.length) {
    log.error('refusing to start: demo accounts still accept their published demo password', { accounts: leaked });
    await handle.close();
    process.exit(1);
  }
  if (await isEmpty(ctx)) log.warn('no users yet: run `npm run bootstrap -w @jerp/backend` to create the first General Manager');
}

// Second-factor policy: the operator's initial values apply on the very first start only (D-2fa-4).
const footers = await replaceLegacyInvoiceFooters(ctx);
if (footers.length) log.info('unedited default invoice footer replaced by the new default', { keys: footers });
const initial = await applyInitialSecuritySettings(ctx, { uv: config.webauthnUvInitial, roles: config.twoFactorRolesInitial });
if (initial.length) log.info('second-factor settings initialised from the environment (first start)', { keys: initial.map((c) => c.key) });
const { security: sec } = await ctx.settings.get();
log.info('second factor', { rpId: config.webauthnRpId ?? '(demo: from each request)', userVerification: sec.webauthnUserVerification, requiredRoles: sec.twoFactorRequiredRoles });

const app = createApp(ctx, config);
app.listen(config.port, () => {
  log.info('server started', { port: config.port, appMode: config.appMode, db: handle.driver, webauthnRpId: config.webauthnRpId ?? '(from each request: demo without APP_ORIGIN)' });
});

// Background housekeeping.
setInterval(() => {
  purgeExpiredSecondFactorState(ctx.db).catch((e) => log.error('second-factor sweep failed', { err: e }));
}, 60_000);

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
