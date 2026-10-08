// Real PostgreSQL only (Phase 2c): the full backup → off-site copy → restore drill cycle against a
// freshly seeded database, the STRICT refusals, and proof that the drill fails loudly when the
// backup is damaged or the restored database has lost an integrity guarantee.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import type { Ctx } from '../../src/core/context';
import { seedWorld } from '../fixtures/world';
import { childEnv, loadBackupConfig, pgEnv, withDatabase, type BackupConfig } from '../../src/backup/config';
import { applyRetention, BackupRefused, runBackup, type Manifest } from '../../src/backup/backup';
import { runVerify, VerifyFailed } from '../../src/backup/verify';
import { checkRestored } from '../../src/backup/checks';
import { collectStats } from '../../src/backup/stats';
import { pipeline } from '../../src/backup/run';
import { backupBaseName } from '../../src/backup/retention';
import { backupHealth } from '../../src/modules/backups/status';
import { dropTestDatabase, openTestDatabase, PG_MODE } from '../helpers';

let handle: Awaited<ReturnType<typeof openTestDatabase>>;
let ctx: Ctx;
let dbUrl: string;
let adminUrl: string;
let backupUrl: string;
let backupRole: string;
let secretKey: string;
let publicKey: string;
let work: string;
const logs: string[] = [];
const log = (m: string) => logs.push(m);

const baseEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  APP_MODE: 'production',
  BACKUP_DIR: path.join(work, 'local'),
  BACKUP_DATABASE_URL: backupUrl,
  DATABASE_URL: dbUrl,
  BACKUP_AGE_RECIPIENT: publicKey,
  BACKUP_AGE_IDENTITY: secretKey,
  BACKUP_UPLOAD_COMMAND: `mkdir -p "${path.join(work, 'offsite')}" && cp "$BACKUP_FILE" "$BACKUP_CHECKSUM_FILE" "$BACKUP_MANIFEST_FILE" "${path.join(work, 'offsite')}/"`,
  BACKUP_VERIFY_ADMIN_URL: adminUrl,
  ...over,
});
const cfg = (over: Record<string, string | undefined> = {}): BackupConfig => loadBackupConfig(baseEnv(over));
const runs = async () => ctx.db.select().from(t.backupRuns).orderBy(desc(t.backupRuns.id));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  dbUrl = handle.url!;
  adminUrl = process.env.TEST_DATABASE_URL!;
  work = mkdtempSync(path.join(os.tmpdir(), 'jerp-backup-test-'));

  // The read-only BACKUP role, created exactly as docs/DEPLOYMENT.md §7 describes.
  backupRole = `jerp_bk_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  const dbName = new URL(dbUrl).pathname.slice(1);
  const { Client } = await import('pg');
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`CREATE ROLE ${backupRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await c.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${backupRole}`);
  for (const schema of ['public', 'drizzle']) {
    await c.query(`GRANT USAGE ON SCHEMA ${schema} TO ${backupRole}`);
    await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${backupRole}`);
    await c.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${backupRole}`);
  }
  await c.end();
  const u = new URL(dbUrl);
  u.username = backupRole;
  u.password = password;
  backupUrl = u.toString();

  // An age key pair: the server only needs the PUBLIC key; the drill gets the secret one.
  const keyFile = path.join(work, 'key.txt');
  execFileSync('age-keygen', ['-o', keyFile], { stdio: 'ignore' });
  secretKey = readFileSync(keyFile, 'utf8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-'))!;
  publicKey = execFileSync('age-keygen', ['-y', keyFile]).toString().trim();
}, 240_000);

afterAll(async () => {
  await handle?.close();
  if (backupRole) {
    const { Client } = await import('pg');
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    await c.query(`DROP ROLE IF EXISTS ${backupRole}`).catch(() => undefined);
    await c.end();
  }
});

describe('STRICT mode (production) refuses unsafe backups', () => {
  it('without an encryption key, without an off-site command, or with a role that can write', async () => {
    await expect(runBackup(cfg({ BACKUP_AGE_RECIPIENT: '' }), { log })).rejects.toThrow(/BACKUP_AGE_RECIPIENT is not set/);
    await expect(runBackup(cfg({ BACKUP_UPLOAD_COMMAND: '' }), { log })).rejects.toThrow(/BACKUP_UPLOAD_COMMAND is not set/);
    // The owner / runtime role as backup role: refused.
    const e = await runBackup(cfg({ BACKUP_DATABASE_URL: dbUrl }), { log }).catch((x) => x);
    expect(e).toBeInstanceOf(BackupRefused);
    expect(String(e.message)).toMatch(/owns \d+ tables/);
    expect(String(e.message)).toMatch(/runtime \(DATABASE_URL\)/);
    expect(String(e.message)).toMatch(/can write to \d+ tables/);
    // Nothing was written; the refusals are recorded as failures.
    expect(existsSync(path.join(work, 'local')) ? readdirSync(path.join(work, 'local')).filter((f) => !f.endsWith('.partial')) : []).toEqual([]);
    expect((await runs()).every((r) => r.kind === 'BACKUP' && r.status === 'FAILURE')).toBe(true);
  });
});

describe('backup → off-site copy → restore drill', () => {
  let result: Awaited<ReturnType<typeof runBackup>>;

  it('writes an encrypted dump, a manifest and checksums, copies them off-site and records the run', async () => {
    result = await runBackup(cfg(), { log });
    expect(result).toMatchObject({ encrypted: true, uploaded: true });
    const local = path.join(work, 'local');
    const base = result.fileName.replace(/\.dump\.age$/, '');
    expect(readdirSync(local).sort()).toEqual([`${base}.dump.age`, `${base}.manifest.json`, `${base}.sha256`]);
    expect(readdirSync(path.join(work, 'offsite')).sort()).toEqual(readdirSync(local).sort());
    // Encrypted at rest: age header, no SQL or table names in clear.
    const raw = readFileSync(result.filePath);
    expect(raw.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(raw.includes(Buffer.from('ledger_entries'))).toBe(false);
    expect(readFileSync(path.join(local, `${base}.sha256`), 'utf8')).toContain(`${result.sha256}  ${result.fileName}`);
    // The manifest was taken in the dump's snapshot: it matches the live database (nothing ran since).
    const manifest = JSON.parse(readFileSync(path.join(local, `${base}.manifest.json`), 'utf8')) as Manifest;
    const { Client } = await import('pg');
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    const live = await collectStats(c);
    await c.end();
    const { ['public.backup_runs']: _a, ...liveTables } = live.tables;
    const { ['public.backup_runs']: _b, ...manTables } = manifest.stats.tables;
    expect(manTables).toEqual(liveTables);
    expect(manifest.stats.ledger).toEqual(live.ledger);
    // Recorded; the secret key never appears in any output or file.
    const [last] = await runs();
    expect(last).toMatchObject({ kind: 'BACKUP', status: 'SUCCESS', encrypted: true, uploaded: true, fileName: result.fileName, sha256: result.sha256 });
    expect(logs.join('\n')).not.toContain('AGE-SECRET-KEY');
    for (const f of readdirSync(local)) expect(readFileSync(path.join(local, f)).includes(Buffer.from('AGE-SECRET-KEY'))).toBe(false);
  });

  it('the restore drill restores into a throwaway database and every integrity check passes', async () => {
    const r = await runVerify(cfg(), { log }).catch((e: VerifyFailed) => {
      throw new Error(`${e.message}: ${e.checks.filter((c) => !c.ok).map((c) => c.detail).join(' | ')}`);
    });
    expect(r.fileName).toBe(result.fileName);
    expect(r.checks.map((c) => c.name)).toEqual(['row counts', 'ledger balances', 'scrap pool balances', 'supplier gold owed', 'append-only triggers', 'check constraints']);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.find((c) => c.name === 'append-only triggers')!.detail).toMatch(/refused/);
    const [last] = await runs();
    expect(last).toMatchObject({ kind: 'VERIFY', status: 'SUCCESS', fileName: result.fileName });
    // The throwaway database is gone.
    const { Client } = await import('pg');
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    const left = await c.query(`SELECT datname FROM pg_database WHERE datname LIKE 'jerp_verify_%'`);
    await c.end();
    expect(left.rows).toEqual([]);
    // The health check now reports OK, with ages only.
    const h = await backupHealth(ctx);
    expect(h).toMatchObject({ status: 'OK', reasons: [] });
    expect(Object.keys(h).sort()).toEqual(['backupAgeHours', 'reasons', 'status', 'verifyAgeHours']);
  });

  it('fails loudly on a damaged backup and without the decryption key', async () => {
    const damaged = path.join(work, 'damaged');
    execFileSync('mkdir', ['-p', damaged]);
    const base = result.fileName.replace(/\.dump\.age$/, '');
    for (const f of readdirSync(path.join(work, 'local'))) copyFileSync(path.join(work, 'local', f), path.join(damaged, f));
    const bytes = readFileSync(path.join(damaged, result.fileName));
    bytes[bytes.length - 10] ^= 0xff;
    writeFileSync(path.join(damaged, result.fileName), bytes);
    await expect(runVerify(cfg({ BACKUP_DIR: damaged }), { log })).rejects.toThrow(/CHECKSUM MISMATCH/);
    expect((await runs())[0]).toMatchObject({ kind: 'VERIFY', status: 'FAILURE' });
    await expect(runVerify(cfg({ BACKUP_AGE_IDENTITY: '' }), { log })).rejects.toThrow(/BACKUP_AGE_IDENTITY/);
    expect(base).toMatch(/^jerp-backup-/);
  });

  it('the checks catch a restored database that lost an append-only trigger, a CHECK constraint, a ledger or pool row', async () => {
    const base = result.fileName.replace(/\.dump\.age$/, '');
    const manifest = JSON.parse(readFileSync(path.join(work, 'local', `${base}.manifest.json`), 'utf8')) as Manifest;
    const dbName = `jerp_tamper_${randomBytes(3).toString('hex')}`;
    const { Client } = await import('pg');
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    try {
      const keyFile = path.join(work, 'key.txt');
      await pipeline(
        { cmd: 'age', args: ['-d', '-i', keyFile, result.filePath], env: childEnv(), label: 'age' },
        { cmd: 'pg_restore', args: ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${dbName}`], env: childEnv(pgEnv(adminUrl, dbName)), label: 'pg_restore' },
      );
      const c = new Client({ connectionString: withDatabase(adminUrl, dbName) });
      c.on('error', () => undefined);
      await c.connect();
      // Intact copy: all checks pass.
      expect((await checkRestored(c, manifest.stats)).every((x) => x.ok)).toBe(true);
      // Tamper.
      await c.query('DROP TRIGGER ledger_entries_append_only ON ledger_entries');
      await c.query('UPDATE ledger_entries SET amount = amount + 1 WHERE id = (SELECT min(id) FROM ledger_entries WHERE amount > 0 AND reverses_entry_id IS NULL)');
      await c.query('DROP TRIGGER scrap_weight_entries_append_only ON scrap_weight_entries');
      await c.query('DELETE FROM scrap_weight_entries WHERE id = (SELECT max(id) FROM scrap_weight_entries WHERE weight_mg > 0)');
      await c.query('ALTER TABLE sales DROP CONSTRAINT ck_sales_hasad_reference');
      const res = await checkRestored(c, manifest.stats);
      await c.end();
      const failed = res.filter((x) => !x.ok).map((x) => x.name);
      expect(failed).toEqual(['row counts', 'ledger balances', 'scrap pool balances', 'append-only triggers', 'check constraints']);
      expect(res.find((x) => x.name === 'append-only triggers')!.detail).toMatch(/ledger_entries: row trigger missing/);
      expect(res.find((x) => x.name === 'check constraints')!.detail).toMatch(/ck_sales_hasad_reference/);
    } finally {
      await dropTestDatabase(admin, dbName);
      await admin.end();
    }
  });

  it('a failed off-site copy fails the backup (kept locally, recorded as FAILURE, not counted as a backup)', async () => {
    const before = await backupHealth(ctx);
    await expect(runBackup(cfg({ BACKUP_UPLOAD_COMMAND: 'exit 3' }), { log, now: new Date(Date.now() + 1000) })).rejects.toThrow(/exited with code 3/);
    expect((await runs())[0]).toMatchObject({ kind: 'BACKUP', status: 'FAILURE' });
    expect((await backupHealth(ctx)).backupAgeHours).toBeGreaterThanOrEqual(before.backupAgeHours!);
  });

  it('retention keeps 14 daily, 8 weekly and 6 monthly backups and removes the rest with their files', async () => {
    const dir = path.join(work, 'retention');
    execFileSync('mkdir', ['-p', dir]);
    const now = Date.UTC(2026, 9, 4, 2, 0, 0);
    for (let d = 0; d < 400; d++) {
      const base = backupBaseName(new Date(now - d * 86_400_000));
      for (const ext of ['.dump.age', '.sha256', '.manifest.json']) writeFileSync(path.join(dir, base + ext), '');
    }
    writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me');
    const removed = await applyRetention(loadBackupConfig(baseEnv({ BACKUP_DIR: dir })));
    const kept = readdirSync(dir).filter((f) => f.endsWith('.dump.age'));
    expect(kept.length).toBeGreaterThanOrEqual(14);
    expect(kept.length).toBeLessThanOrEqual(14 + 8 + 6);
    expect(removed.length + kept.length).toBe(400);
    expect(readdirSync(dir)).toContain('unrelated.txt');
    expect(readdirSync(dir).filter((f) => f.endsWith('.sha256')).length).toBe(kept.length);
    // The 14 newest days are all kept; the oldest kept is about 6 months old.
    for (let d = 0; d < 14; d++) expect(kept).toContain(`${backupBaseName(new Date(now - d * 86_400_000))}.dump.age`);
    const oldest = kept.sort()[0];
    const age = (now - Date.UTC(+oldest.slice(12, 16), +oldest.slice(16, 18) - 1, +oldest.slice(18, 20))) / 86_400_000;
    // Six monthly buckets back from October 2026 end with the newest backup of May: 31 May.
    expect(oldest).toBe(`${backupBaseName(new Date(Date.UTC(2026, 4, 31, 2, 0, 0)))}.dump.age`);
    expect(Math.floor(age)).toBe(126);
  });
});

describe('backup_runs', () => {
  it('is append-only', async () => {
    const { Client } = await import('pg');
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    for (const q of ['UPDATE backup_runs SET status = status', 'DELETE FROM backup_runs', 'TRUNCATE backup_runs']) {
      await expect(c.query(q)).rejects.toThrow(/append-only|permission denied/);
    }
    await c.end();
    expect((await ctx.db.select().from(t.backupRuns).where(eq(t.backupRuns.status, 'SUCCESS'))).length).toBeGreaterThanOrEqual(2);
  });
});

describe('VerifyFailed', () => {
  it('is what the drill throws', () => {
    expect(new VerifyFailed('x')).toBeInstanceOf(Error);
  });
});
