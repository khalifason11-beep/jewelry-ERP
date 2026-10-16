// CLN-1 (D-cln1-1, superseding D-1a-2): APP_MODE must be explicit. An absent, empty or misspelt value stops the app and
// every CLI before anything is opened; only the exact strings "demo" and "production" are accepted. Both projects.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_MODE_MISSING, loadConfig, parseAppMode } from '../src/config';
import { BackupConfigError, loadBackupConfig } from '../src/backup/config';

const PROD = { APP_MODE: 'production', DATABASE_URL: 'postgres://erp:S3cure-Pw-2026@db.internal:5432/erp', APP_ORIGIN: 'https://erp.example.com' };

describe('APP_MODE is required and exact', () => {
  it('absent or empty: refused with the message naming the two valid values', () => {
    for (const env of [{}, { APP_MODE: '' }, { APP_MODE: '   ' }]) {
      expect(() => loadConfig(env as NodeJS.ProcessEnv), JSON.stringify(env)).toThrow(APP_MODE_MISSING);
    }
    expect(APP_MODE_MISSING).toMatch(/APP_MODE=production/);
    expect(APP_MODE_MISSING).toMatch(/APP_MODE=demo/);
  });

  it('any other spelling is refused: "prod", "Production", "DEMO", " demo"', () => {
    for (const v of ['prod', 'Production', 'PRODUCTION', 'DEMO', ' demo', 'demo ', 'staging']) {
      expect(() => parseAppMode(v), v).toThrow(/APP_MODE must be exactly "demo" or "production"/);
      expect(() => loadConfig({ APP_MODE: v } as NodeJS.ProcessEnv), v).toThrow(/APP_MODE/);
    }
  });

  it('"demo" and "production" are accepted', () => {
    const demo = loadConfig({ APP_MODE: 'demo' } as NodeJS.ProcessEnv);
    expect(demo).toMatchObject({ appMode: 'demo', production: false });
    const prod = loadConfig(PROD as NodeJS.ProcessEnv);
    expect(prod).toMatchObject({ appMode: 'production', production: true, cookieName: '__Host-jerp_session', cookieSecure: true });
  });

  it('the backup configuration applies the same rule', () => {
    const base = { BACKUP_DIR: '/tmp/x', BACKUP_DATABASE_URL: 'postgres://a@h/db' };
    expect(() => loadBackupConfig(base)).toThrow(BackupConfigError);
    expect(() => loadBackupConfig(base)).toThrow(APP_MODE_MISSING);
    expect(() => loadBackupConfig({ ...base, APP_MODE: 'Production' })).toThrow(/exactly/);
    expect(loadBackupConfig({ ...base, APP_MODE: 'production' }).production).toBe(true);
  });
});

describe('every entry point refuses to start without APP_MODE', () => {
  const backend = path.resolve(__dirname, '..');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'APP_MODE' && k !== 'VITEST' && !k.startsWith('VITEST_')));
  const cases: [string, string[]][] = [
    ['server', ['src/server.ts']],
    ['bootstrap', ['src/bootstrap-cli.ts', '--username', 'first.lastname', '--full-name', 'Owner']],
    ['ops', ['src/ops-cli.ts', 'unlock', '--username', 'first.lastname']],
    ['migrate', ['src/migrate-cli.ts']],
    ['backup', ['src/backup-cli.ts']],
    ['backup:verify', ['src/backup-verify-cli.ts']],
  ];
  for (const [name, args] of cases) {
    it(`${name}: exit code 1 and the message, nothing opened`, () => {
      const r = spawnSync('npx', ['tsx', ...args], { cwd: backend, env: { ...env, PGLITE_DIR: '/nonexistent/should-not-be-created' }, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, `${name}: ${r.stdout}\n${r.stderr}`).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain(APP_MODE_MISSING);
    }, 90_000);
  }
});

// SAFE-1: every entry point runs in UTC, whatever the server's own time zone.
describe('the process time zone is pinned to UTC', () => {
  it('a process started with another TZ runs in UTC once the configuration is loaded', () => {
    const backend = path.resolve(__dirname, '..');
    const code = "const before = new Date(0).getTimezoneOffset(); await import('./src/config.ts'); console.log(JSON.stringify({ before, tz: process.env.TZ, after: new Date(0).getTimezoneOffset() }))";
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: backend,
      env: { ...process.env, APP_MODE: 'demo', TZ: 'America/New_York' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual({ before: 300, tz: 'UTC', after: 0 });
  }, 90_000);
});
