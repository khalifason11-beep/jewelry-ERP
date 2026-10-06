// Sign-in failures are indistinguishable (D-2a-12) and throttling reserves before verifying (D-2a-10).
// Runs on PGlite and real PostgreSQL. verifyPassword / burnVerification are spied through a module mock.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import * as password from '../src/auth/password';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { IP_MAX_FAILURES, resetThrottleMemory } from '../src/auth/lockout';
import { login } from '../src/modules/auth/service';
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
const verify = vi.mocked(password.verifyPassword);
const burn = vi.mocked(password.burnVerification);

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle.close());
beforeEach(() => {
  resetThrottleMemory();
  verify.mockClear();
  burn.mockClear();
});

const makeUser = async (username: string, pw: string) => {
  const [role] = await ctx.db.select().from(t.roles).where(eq(t.roles.code, 'CASHIER'));
  const [b] = await ctx.db.select().from(t.branches).limit(1);
  const [u] = await ctx.db.insert(t.users).values({ username, fullName: username, roleId: role.id, branchId: b.id, passwordHash: await password.hashPassword(pw) }).returning();
  return u;
};
const failedAudits = async (entityId: string) =>
  (await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'LOGIN_FAILED'), eq(t.auditLogs.entityId, entityId)))).length;

describe('unknown username, locked account and wrong password are indistinguishable from the first attempt', () => {
  it('same status, same body, one hash verification and one audit entry each', async () => {
    const locked = await makeUser('first.locked', 'Locked-Pass-2026');
    await ctx.db.update(t.users).set({ failedLoginCount: 5, lockedUntil: new Date(Date.now() + 3600_000) }).where(eq(t.users.id, locked.id));
    await makeUser('first.wrong', 'Wrong-Pass-2026');

    const attempt = async (username: string, pw: string) => {
      verify.mockClear();
      burn.mockClear();
      const before = await failedAudits(username);
      const res = await request(app).post('/api/auth/login').send({ username, password: pw });
      return { status: res.status, body: res.body, hashChecks: verify.mock.calls.length + burn.mock.calls.length, audits: (await failedAudits(username)) - before };
    };
    const unknown = await attempt('first.nobody', 'Some-Pass-2026');
    const lockedRes = await attempt('first.locked', 'Locked-Pass-2026'); // even the RIGHT password
    const wrong = await attempt('first.wrong', 'Not-It-2026');

    for (const r of [unknown, lockedRes, wrong]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(unknown.body);
      expect(r.hashChecks).toBe(1);
      expect(r.audits).toBe(1);
    }
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    // A refused attempt on a locked account neither reveals nor extends the lock.
    const [after] = await ctx.db.select().from(t.users).where(eq(t.users.id, locked.id));
    expect(after.failedLoginCount).toBe(5);
  });
});

describe('per-IP limiter: reserve before verifying, refund on success', () => {
  it('parallel failures from one IP get at most IP_MAX_FAILURES evaluations', async () => {
    const n = IP_MAX_FAILURES * 3;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => login(ctx, { username: `ip.spray.${i}`, password: 'Spray-Pass-2026', ip: '198.51.100.7' })),
    );
    const codes = results.map((r) => (r.status === 'rejected' ? (r.reason as { code?: string }).code : 'OK'));
    expect(codes.filter((c) => c === 'INVALID_CREDENTIALS')).toHaveLength(IP_MAX_FAILURES);
    expect(codes.filter((c) => c === 'TOO_MANY_ATTEMPTS')).toHaveLength(n - IP_MAX_FAILURES);
  });

  it('successful sign-ins give their slot back (a busy shop behind one IP is never locked out)', async () => {
    for (let i = 0; i < IP_MAX_FAILURES + 5; i++) {
      await login(ctx, { username: 'cashier.kh.01', password: DEMO_PASSWORDS.CASHIER, ip: '198.51.100.8' });
    }
    await expect(login(ctx, { username: 'cashier.kh.01', password: DEMO_PASSWORDS.CASHIER, ip: '198.51.100.8' })).resolves.toBeTruthy();
  });
});
