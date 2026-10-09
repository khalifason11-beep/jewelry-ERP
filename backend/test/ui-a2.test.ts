// UI-A2: the server side of the crash page (D-ui-12): POST /api/client-errors.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { log } from '../src/core/logger';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = withIdempotencyKeys(request.agent(app));
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('crash reports from the browser (D-ui-12)', () => {
  const report = { ref: 'ERR-AB12CD34', path: '/sales', message: 'TypeError: x is undefined', stack: 'at SalesPage (index.js:1:2)' };

  it('needs a signed-in session', async () => {
    expect((await request(app).post('/api/client-errors').send(report)).status).toBe(401);
  });

  it('writes the reference id and details to the server log only, for any role', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const res = await cashier.post('/api/client-errors').send(report);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith('client render error', expect.objectContaining({ ref: 'ERR-AB12CD34', path: '/sales', message: report.message, username: 'cashier.kh.01' }));
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a malformed reference, unknown fields and oversized details', async () => {
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.post('/api/client-errors').send({ ...report, ref: 'nope' })).status).toBe(400);
    expect((await gm.post('/api/client-errors').send({ ...report, extra: 1 })).status).toBe(400);
    expect((await gm.post('/api/client-errors').send({ ...report, message: 'x'.repeat(501) })).status).toBe(400);
  });
});
