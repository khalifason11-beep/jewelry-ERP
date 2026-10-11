// CLN-3 item 4: a browser that still holds a valid session cookie (for example a tab left open, then the sign-in page
// opened again) must be able to sign in. The sign-in steps authenticate fresh credentials and never act on the old
// session, so they need no CSRF token; they keep the Origin check whenever APP_ORIGIN is set, exactly like a sign-in
// without a cookie (login CSRF stays covered). A successful sign-in ends the session the request arrived with.
// Everything else that runs on a session still needs the token. Both projects.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { resetThrottleMemory } from '../src/auth/lockout';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

const ORIGIN = 'http://localhost:4000';
const BM = { username: 'branch.manager.kh', password: DEMO_PASSWORDS.BRANCH_MANAGER };
const CASHIER = { username: 'cashier.kh.01', password: DEMO_PASSWORDS.CASHIER };

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1', APP_ORIGIN: ORIGIN } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

/** A browser that signed in earlier and still holds the cookie, but has lost the CSRF token (a reloaded page). */
async function staleBrowser(u = BM) {
  resetThrottleMemory();
  const a = request.agent(app);
  const first = await a.post('/api/auth/login').set('Origin', ORIGIN).send(u);
  expect(first.status).toBe(200);
  return a;
}
const sessionStatus = async (username: string) => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await ctx.db.select({ id: t.sessions.id, status: t.sessions.status }).from(t.sessions).where(eq(t.sessions.userId, u.id)));
};

describe('signing in while a previous session cookie is still valid', () => {
  it('passes without a CSRF token, and the previous session is ended', async () => {
    const a = await staleBrowser();
    const before = (await sessionStatus(BM.username)).filter((s) => s.status === 'ACTIVE').map((s) => s.id);
    resetThrottleMemory();
    const again = await a.post('/api/auth/login').set('Origin', ORIGIN).send(BM);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const after = await sessionStatus(BM.username);
    for (const id of before) expect(after.find((s) => s.id === id)?.status, id).toBe('LOGGED_OUT');
    expect(after.filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
  });

  it('signing in as ANOTHER user from the same browser also ends the old session', async () => {
    const earlier = new Set((await sessionStatus(BM.username)).map((s) => s.id));
    const a = await staleBrowser(BM);
    const [mine] = (await sessionStatus(BM.username)).filter((s) => !earlier.has(s.id));
    expect(mine.status).toBe('ACTIVE');
    resetThrottleMemory();
    expect((await a.post('/api/auth/login').set('Origin', ORIGIN).send(CASHIER)).status).toBe(200);
    expect((await sessionStatus(BM.username)).find((s) => s.id === mine.id)?.status).toBe('LOGGED_OUT');
  });

  it('the Origin check still applies to sign-in (login CSRF): a foreign Origin is refused with or without a cookie', async () => {
    const a = await staleBrowser();
    resetThrottleMemory();
    const r = await a.post('/api/auth/login').set('Origin', 'https://evil.example').send(BM);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_FAILED');
    const fresh = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send(BM);
    expect(fresh.body.error.code).toBe('CSRF_FAILED');
  });

  it('everything that acts on the session still needs the token', async () => {
    const a = await staleBrowser();
    for (const [path, body] of [['/api/auth/logout', {}], ['/api/auth/change-password', { currentPassword: 'x', newPassword: 'y' }], ['/api/auth/reauth', { password: BM.password }]] as const) {
      const r = await a.post(path).set('Origin', ORIGIN).send(body);
      expect(r.status, path).toBe(403);
      expect(r.body.error.code, path).toBe('CSRF_FAILED');
    }
  });
});
