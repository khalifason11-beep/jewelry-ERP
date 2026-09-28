import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type AppMode = 'demo' | 'production';

function appMode(v: string | undefined): AppMode {
  if (v === undefined || v === '' || v === 'demo') return 'demo';
  if (v === 'production') return 'production';
  throw new Error(`APP_MODE must be "demo" or "production" (got "${v}")`);
}

/** Express `trust proxy`: off unless explicitly configured (see docs/decisions.md D-1a-9). */
function trustProxy(v: string | undefined): boolean | number | string {
  if (!v || v === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // e.g. "loopback" or a CIDR list
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = appMode(env.APP_MODE);
  const production = mode === 'production';
  return {
    appMode: mode,
    production,
    port: Number(env.PORT ?? 4000),
    /** When set, a real PostgreSQL server is used. Otherwise embedded PGlite (demo/tests only). */
    databaseUrl: env.DATABASE_URL || undefined,
    /**
     * Optional owner role used ONLY to run migrations (D-2a-13). When set, the app itself connects
     * with DATABASE_URL, which should be a runtime role that owns nothing.
     */
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL || undefined,
    /** Refuse to start in production when the runtime role could alter the append-only tables. */
    strictDbRoles: env.STRICT_DB_ROLES === 'true',
    dataDir: env.PGLITE_DIR ?? path.join(root, '.data', 'pglite'),
    frontendDist: path.join(root, 'frontend', 'dist'),
    /** Public origin of the SPA, e.g. https://erp.example.com (required in production). */
    appOrigin: env.APP_ORIGIN || undefined,
    /** `__Host-` prefix pins the cookie to this host over HTTPS (production only). */
    cookieName: production ? '__Host-jerp_session' : 'jerp_session',
    cookieSecure: production ? env.COOKIE_SECURE !== 'false' : env.COOKIE_SECURE === 'true',
    trustProxy: trustProxy(env.TRUST_PROXY),
    logLevel: (env.LOG_LEVEL ?? (env.VITEST ? 'silent' : 'info')) as 'debug' | 'info' | 'warn' | 'error' | 'silent',
    rootDir: root,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
