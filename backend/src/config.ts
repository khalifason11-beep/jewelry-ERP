import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  production: process.env.NODE_ENV === 'production',
  /** When set, a real PostgreSQL server is used. Otherwise embedded PGlite. */
  databaseUrl: process.env.DATABASE_URL || undefined,
  dataDir: process.env.PGLITE_DIR ?? path.join(root, '.data', 'pglite'),
  frontendDist: path.join(root, 'frontend', 'dist'),
  cookieName: 'jerp_session',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  rootDir: root,
};
