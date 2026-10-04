// Backup configuration (Phase 2c, D-2c-*). Everything comes from the environment; secrets (the age
// identity, database passwords) are never written to disk by this code except a 0600 temp file for
// the identity during a restore drill, and are never logged.

import path from 'node:path';

export class BackupConfigError extends Error {}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupConfig {
  production: boolean;
  /** Refuse instead of warn: always in production, or BACKUP_STRICT=true. */
  strict: boolean;
  backupDir: string;
  /** Read-only BACKUP role used by pg_dump (never the owner or the runtime role). */
  backupDatabaseUrl: string;
  /** Where runs are recorded (the app's runtime connection). */
  recordDatabaseUrl?: string;
  runtimeDatabaseUrl?: string;
  migrationDatabaseUrl?: string;
  /** age public keys (encryption only needs these; the private key never has to be on the server). */
  ageRecipients: string[];
  /** age private key, only needed by the restore drill: the key itself or a file holding it. */
  ageIdentity?: string;
  ageIdentityFile?: string;
  /** Shell command run after a successful encrypted dump to copy it off the server. */
  uploadCommand?: string;
  keep: RetentionPolicy;
  /** A role allowed to CREATE DATABASE, for the throwaway restore of the drill. */
  verifyAdminUrl?: string;
  /** Directory of pg_dump / pg_restore when they are not on PATH. */
  pgBin?: string;
  ageBin: string;
}

const count = (v: string | undefined, def: number, name: string) => {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new BackupConfigError(`${name} must be a whole number between 0 and 1000`);
  return n;
};

export function loadBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const production = env.APP_MODE === 'production';
  const backupDir = env.BACKUP_DIR;
  if (!backupDir) throw new BackupConfigError('BACKUP_DIR is not set');
  const backupDatabaseUrl = env.BACKUP_DATABASE_URL;
  if (!backupDatabaseUrl) throw new BackupConfigError('BACKUP_DATABASE_URL is not set (a read-only backup role, see docs/DEPLOYMENT.md §7)');
  return {
    production,
    strict: production || env.BACKUP_STRICT === 'true',
    backupDir: path.resolve(backupDir),
    backupDatabaseUrl,
    recordDatabaseUrl: env.DATABASE_URL || undefined,
    runtimeDatabaseUrl: env.DATABASE_URL || undefined,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL || undefined,
    ageRecipients: (env.BACKUP_AGE_RECIPIENT ?? '').split(/[\s,]+/).filter(Boolean),
    ageIdentity: env.BACKUP_AGE_IDENTITY || undefined,
    ageIdentityFile: env.BACKUP_AGE_IDENTITY_FILE || undefined,
    uploadCommand: env.BACKUP_UPLOAD_COMMAND || undefined,
    keep: {
      daily: count(env.BACKUP_KEEP_DAILY, 14, 'BACKUP_KEEP_DAILY'),
      weekly: count(env.BACKUP_KEEP_WEEKLY, 8, 'BACKUP_KEEP_WEEKLY'),
      monthly: count(env.BACKUP_KEEP_MONTHLY, 6, 'BACKUP_KEEP_MONTHLY'),
    },
    verifyAdminUrl: env.BACKUP_VERIFY_ADMIN_URL || env.MIGRATION_DATABASE_URL || undefined,
    pgBin: env.BACKUP_PG_BIN || undefined,
    ageBin: env.BACKUP_AGE_BIN || 'age',
  };
}

/** libpq environment for a connection URL, so no password ever appears on a command line. */
export function pgEnv(url: string, database?: string): Record<string, string> {
  const u = new URL(url);
  const out: Record<string, string> = {};
  const host = u.searchParams.get('host') ?? decodeURIComponent(u.hostname);
  if (host) out.PGHOST = host;
  if (u.port) out.PGPORT = u.port;
  if (u.username) out.PGUSER = decodeURIComponent(u.username);
  if (u.password) out.PGPASSWORD = decodeURIComponent(u.password);
  out.PGDATABASE = database ?? decodeURIComponent(u.pathname.replace(/^\//, ''));
  const ssl = u.searchParams.get('sslmode');
  if (ssl) out.PGSSLMODE = ssl;
  return out;
}

/** The same URL pointing at another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export const userOf = (url?: string) => (url ? decodeURIComponent(new URL(url).username) : undefined);

/** Environment for child processes: never pass the age private key along. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.BACKUP_AGE_IDENTITY;
  return env;
}
