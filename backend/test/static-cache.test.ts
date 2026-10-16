// SAFE-1: cache headers of the built frontend. Vite names every file under /assets by its content hash, so those files
// never change and are cached for a year (immutable). index.html names the current hashes, so it is revalidated on
// every load (no-cache): after an update every browser gets the new version on its next page load, not up to an hour
// later. Other files at the root (favicon) keep the short cache. The SPA fallback is index.html, so no-cache too.
// API answers keep no-store. Both projects; a throwaway dist folder stands in for the build.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let dist: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  handle = await openTestDatabase();
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title><script src="/assets/index-AbCd1234.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbCd1234.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  app = createApp(createContext(handle), { ...loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv), frontendDist: dist });
});
afterAll(async () => {
  await handle?.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('frontend cache headers', () => {
  it('hashed assets: one year, immutable', async () => {
    const r = await request(app).get('/assets/index-AbCd1234.js');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('index.html, the SPA fallback and the root: no-cache (revalidated on every load)', async () => {
    for (const p of ['/', '/index.html', '/pos', '/reports/sales?x=1']) {
      const r = await request(app).get(p);
      expect(r.status, p).toBe(200);
      expect(r.text, p).toContain('/assets/index-AbCd1234.js');
      expect(r.headers['cache-control'], p).toBe('no-cache');
    }
  });

  it('other root files keep the short cache; the API keeps no-store', async () => {
    expect((await request(app).get('/favicon.svg')).headers['cache-control']).toBe('public, max-age=3600');
    expect((await request(app).get('/api/health')).headers['cache-control']).toBe('no-store');
  });
});
