// Phase 2c on both projects: backup health evaluation, the health check and the GM status route,
// the retention rule and the backup configuration (the full dump/restore cycle is in test/pg/backup).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { t, type DatabaseHandle } from '@jerp/database';
import { DEFAULT_SETTINGS } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { resetThrottleMemory } from '../src/auth/lockout';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { evaluateBackupHealth } from '../src/modules/backups/status';
import { backupBaseName, parseBackupName, selectToKeep } from '../src/backup/retention';
import { BackupConfigError, loadBackupConfig, pgEnv } from '../src/backup/config';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
const H = 3_600_000;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle.close());
beforeEach(() => resetThrottleMemory());

async function login(username: string, role: keyof typeof DEMO_PASSWORDS) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  return agent;
}

describe('backup health evaluation', () => {
  const limits = DEFAULT_SETTINGS.backup;
  const now = new Date('2026-10-04T12:00:00Z');
  it('defaults: warn after 26 hours without a backup and 7 days without a restore drill', () => {
    expect(limits).toEqual({ maxAgeHours: 26, maxVerifyAgeDays: 7 });
  });
  it('OK when both are recent; WARNING with reason codes otherwise', () => {
    expect(evaluateBackupHealth(new Date(now.getTime() - 25 * H), new Date(now.getTime() - 6 * 24 * H), limits, now)).toEqual({ status: 'OK', backupAgeHours: 25, verifyAgeHours: 144, reasons: [] });
    expect(evaluateBackupHealth(new Date(now.getTime() - 27 * H), new Date(now.getTime() - 8 * 24 * H), limits, now)).toMatchObject({ status: 'WARNING', reasons: ['BACKUP_STALE', 'VERIFY_STALE'] });
    expect(evaluateBackupHealth(null, null, limits, now)).toEqual({ status: 'WARNING', backupAgeHours: null, verifyAgeHours: null, reasons: ['BACKUP_NEVER', 'VERIFY_NEVER'] });
    expect(evaluateBackupHealth(new Date(now.getTime() - 2 * H), null, { maxAgeHours: 1, maxVerifyAgeDays: 7 }, now).reasons).toEqual(['BACKUP_STALE', 'VERIFY_NEVER']);
  });
});

describe('health check and GM status', () => {
  it('the public health check shows only ages and status; no backups yet → WARNING; always HTTP 200', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.backup).toEqual({ status: 'WARNING', backupAgeHours: null, verifyAgeHours: null, reasons: ['BACKUP_NEVER', 'VERIFY_NEVER'] });
  });

  it('reads the latest SUCCESS of each kind (failures do not count) and the thresholds from the settings', async () => {
    const now = Date.now();
    await ctx.db.insert(t.backupRuns).values([
      { kind: 'BACKUP', status: 'SUCCESS', fileName: 'jerp-backup-a.dump.age', sizeBytes: 10, sha256: 'x', encrypted: true, uploaded: true, startedAt: new Date(now - 30 * H), finishedAt: new Date(now - 30 * H) },
      { kind: 'BACKUP', status: 'FAILURE', startedAt: new Date(now - H), finishedAt: new Date(now - H), detail: { error: 'upload failed' } },
      { kind: 'VERIFY', status: 'SUCCESS', fileName: 'jerp-backup-a.dump.age', startedAt: new Date(now - 2 * H), finishedAt: new Date(now - 2 * H) },
    ]);
    const health = (await request(app).get('/api/health')).body.backup;
    expect(health.status).toBe('WARNING');
    expect(health.reasons).toEqual(['BACKUP_STALE']);
    expect(Math.round(health.backupAgeHours)).toBe(30);
    // Nothing else leaks: no file names, hosts, sizes or checksums.
    expect(JSON.stringify(health)).not.toMatch(/jerp-backup|sha|upload|host/);

    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const s = (await gm.get('/api/backups/status')).body;
    expect(s).toMatchObject({ status: 'WARNING', reasons: ['BACKUP_STALE'], maxAgeHours: 26, maxVerifyAgeDays: 7 });
    // Raising the threshold (setting) clears the warning.
    await ctx.settings.apply(ctx.db, { 'backup.maxAgeHours': 48 }, { actor: { id: null, username: 'test' } });
    expect((await gm.get('/api/backups/status')).body).toMatchObject({ status: 'OK', reasons: [], maxAgeHours: 48 });
    await ctx.settings.apply(ctx.db, { 'backup.maxAgeHours': 26 }, { actor: { id: null, username: 'test' } });
  });

  it('branch managers and cashiers cannot read the backup status', async () => {
    expect((await (await login('branch.manager.kh', 'BRANCH_MANAGER')).get('/api/backups/status')).status).toBe(403);
    expect((await (await login('cashier.kh.01', 'CASHIER')).get('/api/backups/status')).status).toBe(403);
  });
});

describe('retention and names', () => {
  it('names round-trip and foreign files are ignored', () => {
    const at = new Date('2026-10-04T10:15:00Z');
    expect(backupBaseName(at)).toBe('jerp-backup-20261004T101500Z');
    expect(parseBackupName('jerp-backup-20261004T101500Z.dump.age')).toEqual({ base: 'jerp-backup-20261004T101500Z', at });
    expect(parseBackupName('notes.txt')).toBeNull();
  });
  it('keeps the newest per day / ISO week / month within the limits', () => {
    const d = (s: string) => new Date(s);
    const times = [d('2026-10-04T02:00Z'), d('2026-10-04T14:00Z'), d('2026-10-03T02:00Z'), d('2026-09-20T02:00Z'), d('2026-08-31T02:00Z'), d('2026-08-01T02:00Z'), d('2025-01-01T02:00Z')];
    const keep = selectToKeep(times, { daily: 2, weekly: 2, monthly: 3 });
    // daily: 10-04 (14:00, the newest of that day) and 10-03; weekly adds 09-20; monthly adds 08-31.
    expect([...keep].sort()).toEqual([1, 2, 3, 4]);
    expect(selectToKeep([], { daily: 1, weekly: 1, monthly: 1 }).size).toBe(0);
    expect(selectToKeep([d('2020-01-01')], { daily: 0, weekly: 0, monthly: 0 })).toEqual(new Set([0]));
  });
});

describe('backup configuration', () => {
  it('requires BACKUP_DIR and BACKUP_DATABASE_URL; production is strict; defaults 14/8/6', () => {
    expect(() => loadBackupConfig({ BACKUP_DATABASE_URL: 'postgres://a@h/db' })).toThrow(BackupConfigError);
    expect(() => loadBackupConfig({ BACKUP_DIR: '/tmp/x' })).toThrow(/BACKUP_DATABASE_URL/);
    const c = loadBackupConfig({ BACKUP_DIR: '/tmp/x', BACKUP_DATABASE_URL: 'postgres://a@h/db', APP_MODE: 'production', BACKUP_AGE_RECIPIENT: 'age1abc, age1def' });
    expect(c).toMatchObject({ strict: true, keep: { daily: 14, weekly: 8, monthly: 6 }, ageRecipients: ['age1abc', 'age1def'] });
    expect(loadBackupConfig({ BACKUP_DIR: '/tmp/x', BACKUP_DATABASE_URL: 'postgres://a@h/db' }).strict).toBe(false);
    expect(loadBackupConfig({ BACKUP_DIR: '/tmp/x', BACKUP_DATABASE_URL: 'postgres://a@h/db', BACKUP_STRICT: 'true' }).strict).toBe(true);
    expect(() => loadBackupConfig({ BACKUP_DIR: '/tmp/x', BACKUP_DATABASE_URL: 'postgres://a@h/db', BACKUP_KEEP_DAILY: '-1' })).toThrow(/BACKUP_KEEP_DAILY/);
  });
  it('passes the password to pg_dump through the environment, never on the command line', () => {
    expect(pgEnv('postgres://bk:s%40cret@db.example:5433/jerp?sslmode=require')).toEqual({ PGHOST: 'db.example', PGPORT: '5433', PGUSER: 'bk', PGPASSWORD: 's@cret', PGDATABASE: 'jerp', PGSSLMODE: 'require' });
  });
});
