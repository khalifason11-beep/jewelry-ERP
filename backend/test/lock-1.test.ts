// LOCK-1 (D-lock-1): who learns that an account is security-locked (D-2fa-13).
// - Managers see a notice: /auth/me.lockedAccounts, the General Manager every account, a branch manager the staff of
//   their own branch, a cashier nothing. The Users list carries securityLockedAt.
// - Nobody else: a sign-in to a locked account is answered exactly like an unknown username, with the same work (one
//   password-hash computation: the same timing class) and no cookie. The reporter's own sign-in page note is client
//   state of that tab only (frontend), never a server answer.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import * as password from '../src/auth/password';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { resetThrottleMemory } from '../src/auth/lockout';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

vi.mock('../src/auth/password', async (orig) => {
  const real = await orig<typeof import('../src/auth/password')>();
  return { ...real, verifyPassword: vi.fn(real.verifyPassword), burnVerification: vi.fn(real.burnVerification) };
});

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
const verify = vi.mocked(password.verifyPassword);
const burn = vi.mocked(password.burnVerification);

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent as unknown as Agent;
}
const lockAccount = (username: string) =>
  ctx.db.update(t.users).set({ securityLockedAt: new Date(), securityLockReason: 'test: reported recovery-code sign-in' }).where(eq(t.users.username, username));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());
beforeEach(() => resetThrottleMemory());

describe('who sees a security-locked account', () => {
  let gm: Agent;
  let bmKh: Agent;
  let bmOmd: Agent;
  let cashier: Agent;

  beforeAll(async () => {
    // Sign in before the locks: a locked account cannot sign in at all.
    gm = await login('general.manager', 'GENERAL_MANAGER');
    bmKh = await login('branch.manager.kh', 'BRANCH_MANAGER');
    bmOmd = await login('branch.manager.omd', 'BRANCH_MANAGER');
    cashier = await login('cashier.kh.02', 'CASHIER');
    await lockAccount('cashier.kh.01');
    await lockAccount('cashier.omd.01');
  });

  const lockedNames = async (a: Agent) => {
    const r = await a.get('/api/auth/me');
    expect(r.status).toBe(200);
    return (r.body.lockedAccounts as { username: string }[]).map((x) => x.username).sort();
  };

  it('the General Manager sees every locked account', async () => {
    expect(await lockedNames(gm)).toEqual(['cashier.kh.01', 'cashier.omd.01']);
  });

  it('a branch manager sees only the own branch, never another branch', async () => {
    expect(await lockedNames(bmKh)).toEqual(['cashier.kh.01']);
    expect(await lockedNames(bmOmd)).toEqual(['cashier.omd.01']);
  });

  it('a cashier sees none, even of a colleague in the same branch', async () => {
    expect(await lockedNames(cashier)).toEqual([]);
  });

  it('the answer holds names and the time only, never the reason', async () => {
    const r = await gm.get('/api/auth/me');
    for (const a of r.body.lockedAccounts) {
      expect(Object.keys(a).sort()).toEqual(['fullName', 'fullNameAr', 'id', 'lockedAt', 'username']);
    }
  });

  it('the Users list shows since when an account is security-locked', async () => {
    const rows = (await gm.get('/api/users')).body as { username: string; securityLockedAt: string | null }[];
    expect(rows.find((u) => u.username === 'cashier.kh.01')?.securityLockedAt).toBeTruthy();
    expect(rows.find((u) => u.username === 'cashier.kh.02')?.securityLockedAt).toBeNull();
  });

  it('the notice disappears when the lock is lifted', async () => {
    await ctx.db.update(t.users).set({ securityLockedAt: null, securityLockReason: null }).where(eq(t.users.username, 'cashier.omd.01'));
    expect(await lockedNames(gm)).toEqual(['cashier.kh.01']);
    expect(await lockedNames(bmOmd)).toEqual([]);
  });
});

describe('the sign-in never reveals a lock', () => {
  it('a locked account (even with the right password) and an unknown username: identical answers, same timing class', async () => {
    await lockAccount('branch.manager.bhr');
    const failedAudits = async (entityId: string) =>
      (await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'LOGIN_FAILED'), eq(t.auditLogs.entityId, entityId)))).length;
    const attempt = async (username: string, pw: string) => {
      resetThrottleMemory();
      verify.mockClear();
      burn.mockClear();
      const before = await failedAudits(username);
      const res = await request(app).post('/api/auth/login').send({ username, password: pw });
      return {
        status: res.status,
        body: res.body,
        cookie: res.headers['set-cookie'],
        // Timing class: exactly one password-hash computation, whether verified or burned.
        hashChecks: verify.mock.calls.length + burn.mock.calls.length,
        audits: (await failedAudits(username)) - before,
      };
    };
    const locked = await attempt('branch.manager.bhr', DEMO_PASSWORDS.BRANCH_MANAGER);
    const unknown = await attempt('branch.manager.xyz', DEMO_PASSWORDS.BRANCH_MANAGER);
    expect(locked.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(locked.body).toEqual(unknown.body);
    expect(locked.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(locked.cookie).toBeUndefined();
    expect(unknown.cookie).toBeUndefined();
    expect(locked.hashChecks).toBe(1);
    expect(unknown.hashChecks).toBe(1);
    expect(locked.audits).toBe(1);
    expect(unknown.audits).toBe(1);
    // No public endpoint mentions it either.
    expect(JSON.stringify((await request(app).get('/api/meta')).body)).not.toMatch(/lock/i);
  });
});
