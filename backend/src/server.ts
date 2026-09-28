import { and, eq, ne, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { config } from './config';
import { createApp } from './app';
import { createContext, isEmpty, openDatabase } from './bootstrap';
import { log } from './core/logger';
import { demoCredentialsInUse, productionConfigProblems } from './core/startup';
import { releaseStaleReservations } from './modules/hasad/service';
import { seedDemo } from './seed/demo';

// ── Refuse unsafe production configurations before touching the database (security item 2).
const problems = productionConfigProblems(config);
if (problems.length) {
  log.error('refusing to start: unsafe production configuration', { problems });
  process.exit(1);
}

const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
const ctx = createContext(handle);

if (config.appMode === 'demo') {
  if (await isEmpty(ctx)) {
    log.info('empty database: loading demo data');
    const started = Date.now();
    await seedDemo(ctx);
    log.info('demo data loaded', { seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
  }
} else {
  // Production never seeds demo data, and never runs with a published demo password.
  const leaked = await demoCredentialsInUse(handle.db);
  if (leaked.length) {
    log.error('refusing to start: demo accounts still accept their published demo password', { accounts: leaked });
    await handle.close();
    process.exit(1);
  }
  if (await isEmpty(ctx)) log.warn('no users yet: run `npm run bootstrap -w @jerp/backend` to create the first General Manager');
}

const app = createApp(ctx, config);
app.listen(config.port, () => {
  log.info('server started', { port: config.port, appMode: config.appMode, db: handle.driver, hasad: ctx.hasad.mode });
});

// Background housekeeping.
setInterval(() => {
  releaseStaleReservations(ctx).catch((e) => log.error('reservation sweep failed', { err: e }));
  if (config.appMode !== 'demo') return;
  // Demo presence: keep the clearly-labelled simulated sessions "alive" (except the idle example).
  ctx.db
    .update(t.sessions)
    .set({ lastActivityAt: sql`now() - (random() * interval '90 seconds')` })
    .where(and(eq(t.sessions.isSimulated, true), eq(t.sessions.status, 'ACTIVE'), ne(t.sessions.currentModule, 'dashboard')))
    .catch(() => undefined);
}, 60_000);

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
