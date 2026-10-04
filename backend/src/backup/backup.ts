// `npm run backup` (Phase 2c, D-2c-1 … D-2c-5).
//
//   1. Refuse in STRICT mode (production, or BACKUP_STRICT=true) without an encryption key, without
//      an off-site upload command, or when the backup role could write, owns tables, or is the
//      runtime / migration role.
//   2. Open a REPEATABLE READ READ ONLY transaction as the read-only BACKUP role, export its
//      snapshot and collect the integrity statistics (row counts, ledger and pool balances, CHECK
//      constraints) inside it; pg_dump (custom format) dumps that SAME snapshot.
//   3. The dump is piped straight into `age` (encrypted at rest; no plaintext file is ever written).
//   4. Write a manifest (the statistics) and a sha256 checksum file; run the off-site upload hook;
//      apply the retention policy; record the run in `backup_runs`.

import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client as PgClient } from 'pg';
import { childEnv, pgEnv, userOf, type BackupConfig } from './config';
import { bin, pipeline, run, runShell, sha256File, ToolError } from './run';
import { backupBaseName, parseBackupName, selectToKeep } from './retention';
import { collectStats, type DbStats } from './stats';
import { recordRun } from './record';

export class BackupRefused extends Error {}

export interface Manifest {
  format: 1;
  createdAt: string;
  dumpFile: string;
  encrypted: boolean;
  stats: DbStats;
}

export interface BackupResult {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  encrypted: boolean;
  uploaded: boolean;
  pruned: string[];
  warnings: string[];
}

/** What would make this role unfit as the read-only backup role. */
export async function backupRoleProblems(client: PgClient, cfg: BackupConfig): Promise<string[]> {
  const problems: string[] = [];
  const me = (await client.query<{ role: string; superuser: boolean; createdb: boolean; createrole: boolean }>(
    `SELECT current_user AS role, rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole FROM pg_roles WHERE rolname = current_user`,
  )).rows[0];
  if (me.superuser) problems.push(`the backup role "${me.role}" is a superuser`);
  if (me.createdb || me.createrole) problems.push(`the backup role "${me.role}" can create databases or roles`);
  const owns = Number((await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'S') AND pg_has_role(current_user, c.relowner, 'MEMBER')`,
  )).rows[0].n);
  if (owns) problems.push(`the backup role "${me.role}" owns ${owns} tables (it must not be the owner role)`);
  const writes = Number((await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))`,
  )).rows[0].n);
  if (writes) problems.push(`the backup role "${me.role}" can write to ${writes} tables (it must be read-only)`);
  for (const [name, url] of [['runtime (DATABASE_URL)', cfg.runtimeDatabaseUrl], ['migration (MIGRATION_DATABASE_URL)', cfg.migrationDatabaseUrl]] as const) {
    if (url && userOf(url) === me.role) problems.push(`the backup role "${me.role}" is also the ${name} role`);
  }
  return problems;
}

/** Apply the retention policy to BACKUP_DIR; returns the base names removed. */
export async function applyRetention(cfg: BackupConfig): Promise<string[]> {
  const files = await readdir(cfg.backupDir);
  const bases = new Map<string, Date>();
  for (const f of files) {
    const p = parseBackupName(f);
    if (p && /\.dump(\.age)?$/.test(f)) bases.set(p.base, p.at);
  }
  const list = [...bases];
  const keep = selectToKeep(list.map(([, at]) => at), cfg.keep);
  const removed: string[] = [];
  for (const [i, [base]] of list.entries()) {
    if (keep.has(i)) continue;
    for (const f of files) if (f.startsWith(`${base}.`)) await rm(path.join(cfg.backupDir, f), { force: true });
    removed.push(base);
  }
  return removed;
}

export async function runBackup(cfg: BackupConfig, opts: { now?: Date; log?: (m: string) => void } = {}): Promise<BackupResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = new Date();
  const now = opts.now ?? startedAt;
  const warnings: string[] = [];
  const encrypted = cfg.ageRecipients.length > 0;
  const base = backupBaseName(now);
  const dumpName = `${base}.dump${encrypted ? '.age' : ''}`;
  let finalPath: string | undefined;
  try {
    // ── 1. STRICT refusals and warnings
    if (!encrypted) {
      if (cfg.strict) throw new BackupRefused('BACKUP_AGE_RECIPIENT is not set: backups must be encrypted (strict mode)');
      warnings.push('BACKUP_AGE_RECIPIENT is not set: this backup is NOT encrypted (allowed outside production only)');
    }
    if (!cfg.uploadCommand) {
      if (cfg.strict) throw new BackupRefused('BACKUP_UPLOAD_COMMAND is not set: a backup that stays on this server does not count (strict mode)');
      warnings.push('BACKUP_UPLOAD_COMMAND is not set: this backup stays on this machine only');
    }

    const { Client } = await import('pg');
    const client = new Client({ connectionString: cfg.backupDatabaseUrl });
    await client.connect();
    let stats: DbStats;
    try {
      const problems = await backupRoleProblems(client, cfg);
      if (problems.length) {
        if (cfg.strict) throw new BackupRefused(`unsafe backup role: ${problems.join('; ')}`);
        warnings.push(...problems.map((p) => `${p} (allowed outside production only)`));
      }
      for (const w of warnings) log(`WARNING: ${w}`);

      // ── 2. one snapshot for the statistics AND the dump
      await mkdir(cfg.backupDir, { recursive: true, mode: 0o700 });
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = (await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0].s;
      stats = await collectStats(client);

      // ── 3. pg_dump | age  →  <name>.partial (renamed only when complete)
      const partial = path.join(cfg.backupDir, `${dumpName}.partial`);
      const dumpArgs = ['--format=custom', '--no-password', `--snapshot=${snapshot}`];
      const pgDump = { cmd: bin(cfg.pgBin, 'pg_dump'), env: childEnv(pgEnv(cfg.backupDatabaseUrl)), label: 'pg_dump' };
      log(`Dumping the database (${Object.keys(stats.tables).length} tables, one snapshot)…`);
      if (encrypted) {
        await pipeline(
          { ...pgDump, args: dumpArgs },
          { cmd: cfg.ageBin, args: [...cfg.ageRecipients.flatMap((r) => ['-r', r]), '-o', partial], env: childEnv(), label: 'age' },
        );
      } else {
        await run(pgDump.cmd, [...dumpArgs, `--file=${partial}`], pgDump.env, 'pg_dump');
      }
      await client.query('COMMIT');
      finalPath = path.join(cfg.backupDir, dumpName);
      await rename(partial, finalPath);
      await chmod(finalPath, 0o600);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }

    // ── 4. manifest + checksums
    const manifest: Manifest = { format: 1, createdAt: now.toISOString(), dumpFile: dumpName, encrypted, stats };
    const manifestName = `${base}.manifest.json`;
    const manifestPath = path.join(cfg.backupDir, manifestName);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const sha256 = await sha256File(finalPath);
    const checksumPath = path.join(cfg.backupDir, `${base}.sha256`);
    await writeFile(checksumPath, `${sha256}  ${dumpName}\n${await sha256File(manifestPath)}  ${manifestName}\n`, { mode: 0o600 });
    const sizeBytes = (await stat(finalPath)).size;
    log(`Backup written: ${dumpName} (${sizeBytes} bytes, ${encrypted ? 'encrypted with age' : 'NOT encrypted'})`);

    // ── 5. off-site copy
    let uploaded = false;
    if (cfg.uploadCommand) {
      log('Running the off-site upload command…');
      await runShell(cfg.uploadCommand, childEnv({ BACKUP_FILE: finalPath, BACKUP_CHECKSUM_FILE: checksumPath, BACKUP_MANIFEST_FILE: manifestPath, BACKUP_NAME: base, BACKUP_DIR: cfg.backupDir }));
      uploaded = true;
      log('Off-site copy done.');
    }

    // ── 6. retention (local copies)
    const pruned = await applyRetention(cfg);
    if (pruned.length) log(`Retention: removed ${pruned.length} old backup(s).`);

    const totalRows = Object.values(stats.tables).reduce((s, n) => s + n, 0);
    const recorded = await recordRun(cfg.recordDatabaseUrl, {
      kind: 'BACKUP',
      status: 'SUCCESS',
      fileName: dumpName,
      sizeBytes,
      sha256,
      encrypted,
      uploaded,
      detail: { tables: Object.keys(stats.tables).length, rows: totalRows, pruned: pruned.length, warnings },
      startedAt,
    });
    if (!recorded) log('WARNING: DATABASE_URL is not set: this run was not recorded, the health check will not see it.');
    return { fileName: dumpName, filePath: finalPath, sizeBytes, sha256, encrypted, uploaded, pruned, warnings };
  } catch (e) {
    const message = e instanceof BackupRefused || e instanceof ToolError ? e.message : String((e as Error).message ?? e);
    await recordRun(cfg.recordDatabaseUrl, { kind: 'BACKUP', status: 'FAILURE', fileName: finalPath ? dumpName : null, encrypted, detail: { error: message.slice(0, 500) }, startedAt }).catch(() => false);
    if (!finalPath) await rm(path.join(cfg.backupDir, `${dumpName}.partial`), { force: true }).catch(() => undefined);
    throw e;
  }
}
