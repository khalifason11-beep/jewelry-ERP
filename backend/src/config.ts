import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type AppMode = 'demo' | 'production';

function appMode(v: string | undefined): AppMode {
  if (v === undefined || v === '' || v === 'demo') return 'demo';
  if (v === 'production') return 'production';
  throw new Error(`APP_MODE must be "demo" or "production" (got "${v}")`);
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
  const mode = appMode(env.APP_MODE);
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
    logLevel: (env.LOG_LEVEL ?? (env.VITEST ? 'silent' : 'info')) as 'debug' | 'info' | 'warn' | 'error' | 'silent',
    rootDir: root,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
