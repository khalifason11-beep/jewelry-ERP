// `npm run backup:verify` — the restore drill (Phase 2c, D-2c-4).
//
//   1. Take the latest backup in BACKUP_DIR (or the one given), check both sha256 sums.
//   2. Create a throwaway database, decrypt (age, identity from the environment, held in a 0600
//      temp file for the duration only) and restore it with pg_restore --exit-on-error.
//   3. Run every integrity check of checks.ts against the restored copy and the manifest.
//   4. Drop the throwaway database, record the run, fail loudly if any check failed.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BackupConfigError, childEnv, pgEnv, withDatabase, type BackupConfig } from './config';
import { bin, pipeline, run, sha256File } from './run';
import { parseBackupName } from './retention';
import { checkRestored, type CheckResult } from './checks';
import { recordRun } from './record';
import type { Manifest } from './backup';

export class VerifyFailed extends Error {
  constructor(message: string, readonly checks: CheckResult[] = []) {
    super(message);
  }
}

export interface VerifyResult {
  fileName: string;
  checks: CheckResult[];
}

export async function latestBackup(dir: string): Promise<string | null> {
  const dumps = (await readdir(dir)).filter((f) => parseBackupName(f) && /\.dump(\.age)?$/.test(f)).sort();
  return dumps.at(-1) ?? null;
}

export async function runVerify(cfg: BackupConfig, opts: { file?: string; log?: (m: string) => void } = {}): Promise<VerifyResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = new Date();
  let fileName = opts.file ? path.basename(opts.file) : '';
  let checks: CheckResult[] = [];
  let tmp: string | undefined;
  const dbName = `jerp_verify_${Date.now()}_${randomBytes(3).toString('hex')}`;
  let created = false;
  const { Client } = await import('pg');
  try {
    if (!cfg.verifyAdminUrl) throw new BackupConfigError('BACKUP_VERIFY_ADMIN_URL (or MIGRATION_DATABASE_URL) is not set: the drill needs a role that can create a throwaway database');
    if (!fileName) {
      const latest = await latestBackup(cfg.backupDir);
      if (!latest) throw new VerifyFailed(`no backup found in ${cfg.backupDir}`);
      fileName = latest;
    }
    const parsed = parseBackupName(fileName);
    if (!parsed) throw new VerifyFailed(`${fileName} is not a backup made by npm run backup`);
    const dir = opts.file ? path.dirname(path.resolve(opts.file)) : cfg.backupDir;
    const dumpPath = path.join(dir, fileName);
    const manifestName = `${parsed.base}.manifest.json`;

    // ── 1. checksums
    const sums = new Map(
      (await readFile(path.join(dir, `${parsed.base}.sha256`), 'utf8').catch(() => { throw new VerifyFailed(`checksum file ${parsed.base}.sha256 is missing`); }))
        .split('\n')
        .filter(Boolean)
        .map((l) => { const [h, f] = l.split(/\s+/); return [f, h] as const; }),
    );
    for (const f of [fileName, manifestName]) {
      const want = sums.get(f);
      const got = await sha256File(path.join(dir, f)).catch(() => null);
      if (!want || want !== got) throw new VerifyFailed(`CHECKSUM MISMATCH for ${f}: the file is damaged or was changed`);
    }
    const manifest = JSON.parse(await readFile(path.join(dir, manifestName), 'utf8')) as Manifest;
    log(`Checksums OK: ${fileName}`);

    // ── 2. throwaway database + restore
    const admin = new Client({ connectionString: cfg.verifyAdminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      created = true;
    } finally {
      await admin.end().catch(() => undefined);
    }
    const restoreArgs = ['--no-owner', '--no-acl', '--exit-on-error', '--no-password', `--dbname=${dbName}`];
    const restoreEnv = childEnv(pgEnv(cfg.verifyAdminUrl, dbName));
    log(`Restoring into the throwaway database ${dbName}…`);
    if (manifest.encrypted) {
      if (!cfg.ageIdentity && !cfg.ageIdentityFile) throw new VerifyFailed('the backup is encrypted: set BACKUP_AGE_IDENTITY or BACKUP_AGE_IDENTITY_FILE');
      let identityFile = cfg.ageIdentityFile;
      if (!identityFile) {
        tmp = await mkdtemp(path.join(os.tmpdir(), 'jerp-verify-'));
        identityFile = path.join(tmp, 'identity');
        await writeFile(identityFile, `${cfg.ageIdentity!.trim()}\n`, { mode: 0o600 });
      }
      await pipeline(
        { cmd: cfg.ageBin, args: ['-d', '-i', identityFile, dumpPath], env: childEnv(), label: 'age' },
        { cmd: bin(cfg.pgBin, 'pg_restore'), args: restoreArgs, env: restoreEnv, label: 'pg_restore' },
      );
    } else {
      await run(bin(cfg.pgBin, 'pg_restore'), [...restoreArgs, dumpPath], restoreEnv, 'pg_restore');
    }

    // ── 3. integrity checks on the restored copy
    const restored = new Client({ connectionString: withDatabase(cfg.verifyAdminUrl, dbName) });
    await restored.connect();
    try {
      checks = await checkRestored(restored, manifest.stats);
    } finally {
      await restored.end().catch(() => undefined);
    }
    for (const c of checks) log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new VerifyFailed(`${failed.length} integrity check(s) failed: ${failed.map((c) => c.name).join(', ')}`, checks);

    await recordRun(cfg.recordDatabaseUrl, { kind: 'VERIFY', status: 'SUCCESS', fileName, detail: { checks: checks.map((c) => ({ name: c.name, ok: c.ok })) }, startedAt });
    return { fileName, checks };
  } catch (e) {
    const message = String((e as Error).message ?? e).slice(0, 500);
    await recordRun(cfg.recordDatabaseUrl, {
      kind: 'VERIFY',
      status: 'FAILURE',
      fileName: fileName || null,
      detail: { error: message, checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.ok ? undefined : c.detail })) },
      startedAt,
    }).catch(() => false);
    throw e instanceof VerifyFailed ? e : new VerifyFailed(message, checks);
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (created) {
      const admin = new Client({ connectionString: cfg.verifyAdminUrl });
      await admin.connect().then(() => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)).catch((err: Error) => log(`WARNING: could not drop ${dbName}: ${err.message}`));
      await admin.end().catch(() => undefined);
    }
  }
}
