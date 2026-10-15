import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type AppMode = 'demo' | 'production';

/**
 * APP_MODE must be set explicitly (CLN-1, D-cln1-1, superseding D-1a-2): an absent or empty value used to mean "demo",
 * so a real server that forgot the variable started with every production refusal off. Only the exact strings below
 * are accepted; anything else stops the start.
 */
export const APP_MODE_MISSING =
  'APP_MODE is not set. Set APP_MODE=production on a real server, or APP_MODE=demo for a local trial installation (the only two valid values).';

export function parseAppMode(v: string | undefined): AppMode {
  if (v === 'demo' || v === 'production') return v;
  if (v === undefined || v.trim() === '') throw new Error(APP_MODE_MISSING);
  throw new Error(`APP_MODE must be exactly "demo" or "production" (got "${v}").`);
}

/** ALLOWED_KARATS_INITIAL: a comma-separated list of karats 8–24 (the setting's own rule); anything else stops the start. */
function allowedKaratsInitial(v: string | undefined): number[] | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const list = v.split(',').map((x) => x.trim());
  const karats = list.map(Number);
  if (karats.some((k, i) => !/^\d+$/.test(list[i]) || k < 8 || k > 24) || new Set(karats).size !== karats.length || karats.length > 10) {
    throw new Error(`ALLOWED_KARATS_INITIAL must be a comma-separated list of distinct karats from 8 to 24, e.g. "21" (got "${v}")`);
  }
  return karats;
}

/** A non-negative whole number from the environment, or the default; anything else stops the start. */
function whole(env: NodeJS.ProcessEnv, name: string, def: number, max: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === '') return def;
  if (!/^\d+$/.test(v.trim()) || Number(v) > max) throw new Error(`${name} must be a whole number from 0 to ${max} (got "${v}")`);
  return Number(v);
}

/** Express `trust proxy`: off unless explicitly configured (see docs/decisions.md D-1a-9). */
function trustProxy(v: string | undefined): boolean | number | string {
  if (!v || v === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // e.g. "loopback" or a CIDR list
}

const hostOf = (origin: string | undefined) => {
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = parseAppMode(env.APP_MODE);
  const production = mode === 'production';
  const appOrigin = env.APP_ORIGIN || undefined;
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
    appOrigin,
    // ── Passkeys (Phase 2fa, D-2fa-2). Changing the RP ID (or the domain) invalidates every passkey.
    /** WebAuthn relying-party id: a registrable suffix of APP_ORIGIN's host (default: that host). */
    webauthnRpId: env.WEBAUTHN_RP_ID || hostOf(appOrigin),
    /** Name shown by Windows Hello / the phone when registering. */
    webauthnRpName: env.WEBAUTHN_RP_NAME || hostOf(appOrigin) || 'Jewelry ERP',
    /** First-start-only initial values of the guarded second-factor settings (never read afterwards). */
    webauthnUvInitial: env.WEBAUTHN_UV_INITIAL || undefined,
    twoFactorRolesInitial: env.TWO_FACTOR_REQUIRED_ROLES_INITIAL,
    /** First-start-only initial value of `inventory.allowedKarats` (REM-3): one karat or a comma-separated list. */
    allowedKaratsInitial: allowedKaratsInitial(env.ALLOWED_KARATS_INITIAL),
    /** `__Host-` prefix pins the cookie to this host over HTTPS (production only). */
    cookieName: production ? '__Host-jerp_session' : 'jerp_session',
    cookieSecure: production ? env.COOKIE_SECURE !== 'false' : env.COOKIE_SECURE === 'true',
    trustProxy: trustProxy(env.TRUST_PROXY),
    /**
     * The runtime database pool (SAFE-1). Explicit limits so one slow query or a forgotten transaction cannot hold the
     * pool; migrations and CLIs are not affected. 0 turns a timeout off.
     */
    /** SAFE-1: on SIGTERM/SIGINT, how long running requests may take before their connections are cut. */
    shutdownGraceMs: whole(env, 'SHUTDOWN_GRACE_MS', 15_000, 600_000),
    pg: {
      max: whole(env, 'PG_POOL_MAX', 10, 200) || 10,
      statementTimeoutMs: whole(env, 'PG_STATEMENT_TIMEOUT_MS', 30_000, 3_600_000),
      idleInTxTimeoutMs: whole(env, 'PG_IDLE_IN_TX_TIMEOUT_MS', 60_000, 3_600_000),
      connectTimeoutMs: whole(env, 'PG_CONNECT_TIMEOUT_MS', 10_000, 600_000),
      idleTimeoutMs: whole(env, 'PG_IDLE_TIMEOUT_MS', 30_000, 3_600_000),
    },
    logLevel: (env.LOG_LEVEL ?? (env.VITEST ? 'silent' : 'info')) as 'debug' | 'info' | 'warn' | 'error' | 'silent',
    rootDir: root,
  };
}

export type Config = ReturnType<typeof loadConfig>;

/**
 * The process configuration. A missing or invalid APP_MODE (or another invalid variable) stops every entry point here,
 * before any database is opened, with the message alone (no stack trace).
 */
export const config: Config = (() => {
  try {
    return loadConfig();
  } catch (e) {
    console.error(`Refusing to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();
