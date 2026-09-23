import { and, eq, ne, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { config } from './config';
import { createApp } from './app';
import { createContext, isEmpty, openDatabase } from './bootstrap';
import { releaseStaleReservations } from './modules/hasad/service';
import { seedDemo } from './seed/demo';

const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
const ctx = createContext(handle);

if (await isEmpty(ctx)) {
  console.log('Empty database — loading demo data…');
  const started = Date.now();
  await seedDemo(ctx);
  console.log(`Demo data loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const app = createApp(ctx);
app.listen(config.port, () => {
  console.log(`Jewelry ERP API on http://localhost:${config.port}  (db: ${handle.driver}${handle.driver === 'pglite' ? ` @ ${config.dataDir}` : ''}, Hasad: ${ctx.hasad.mode})`);
});

// Background housekeeping.
setInterval(() => {
  releaseStaleReservations(ctx).catch((e) => console.error('reservation sweep failed', e));
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
