// npm run migrate — apply pending database migrations and exit (nothing else).
// Uses MIGRATION_DATABASE_URL (owner role) when set, otherwise DATABASE_URL, otherwise the embedded
// PGlite directory. Migrations are forward-only and never drop data (docs/decisions.md).

import { config } from './config';
import { runMigrations } from './bootstrap';
import { productionConfigProblems } from './core/startup';

const problems = productionConfigProblems(config);
if (problems.length) {
  console.error(`Refusing to migrate (APP_MODE=${config.appMode}):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
const url = config.migrationDatabaseUrl ?? config.databaseUrl;
await runMigrations(url ? { url } : { dataDir: config.dataDir });
console.log(`Migrations applied (${config.migrationDatabaseUrl ? 'MIGRATION_DATABASE_URL' : url ? 'DATABASE_URL' : 'embedded database'}).`);
