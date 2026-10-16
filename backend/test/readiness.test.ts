// SAFE-1: GET /api/ready (readiness) vs GET /api/health (liveness). Ready only when the database answers, every
// migration of this release is applied and every append-only table keeps its protecting trigger. The public answer is
// the status alone: no table name, count or driver detail leaks; the reason goes to the log. Both projects.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { log } from '../src/core/logger';
import { expectedMigrations } from '../src/core/readiness';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  handle = await openTestDatabase();
  app = createApp(createContext(handle), loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

const exec = (q: string) => handle.db.execute(sql.raw(q));

describe('readiness', () => {
  it('a migrated database is ready; the answer is the status only, never cached', async () => {
    expect(expectedMigrations()).toBeGreaterThanOrEqual(23);
    const r = await request(app).get('/api/ready');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ready: true });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('not ready (503) when an append-only protection is disabled, and only the log says which', async () => {
    const warn = vi.spyOn(log, 'warn');
    await exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
    try {
      const r = await request(app).get('/api/ready');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ready: false });
      expect(JSON.stringify(warn.mock.calls)).toContain('ledger_entries');
      expect(JSON.stringify(r.body)).not.toContain('ledger');
    } finally {
      await exec('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
      warn.mockRestore();
    }
    expect((await request(app).get('/api/ready')).status).toBe(200);
  });

  it('not ready when the applied migrations do not match this release', async () => {
    const warn = vi.spyOn(log, 'warn');
    await exec(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('safe1-test-extra', 9999999999999)`);
    try {
      const r = await request(app).get('/api/ready');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ready: false });
      expect(JSON.stringify(warn.mock.calls)).toMatch(/migrations applied: \d+, this release expects \d+/);
    } finally {
      await exec(`DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'safe1-test-extra'`);
      warn.mockRestore();
    }
    expect((await request(app).get('/api/ready')).status).toBe(200);
  });

  it('liveness stays as it was: /api/health answers 200 whatever the readiness', async () => {
    await exec('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    try {
      expect((await request(app).get('/api/health')).status).toBe(200);
      expect((await request(app).get('/api/ready')).status).toBe(503);
    } finally {
      await exec('ALTER TABLE audit_logs ENABLE TRIGGER USER');
    }
  });
});
