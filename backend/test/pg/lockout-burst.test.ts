// Real PostgreSQL only: 200 parallel wrong-password sign-ins for ONE account over a connection pool.
// The account may have at most `lockoutThreshold` passwords actually verified (D-2a-10).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import * as password from '../../src/auth/password';
import { createContext } from '../../src/bootstrap';
import type { Ctx } from '../../src/core/context';
import { resetThrottleMemory } from '../../src/auth/lockout';
import { login } from '../../src/modules/auth/service';
import { seedDemo } from '../../src/seed/demo';
import { openTestDatabase, PG_MODE } from '../helpers';

vi.mock('../../src/auth/password', async (orig) => {
  const real = await orig<typeof import('../../src/auth/password')>();
  return { ...real, verifyPassword: vi.fn(real.verifyPassword) };
});

let handle: DatabaseHandle;
let ctx: Ctx;
const verify = vi.mocked(password.verifyPassword);

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedDemo(ctx);
});
afterAll(async () => handle?.close());

describe('lockout under a burst of parallel attempts', () => {
  it('200 parallel wrong passwords: at most lockoutThreshold reach verifyPassword; the account ends locked', async () => {
    resetThrottleMemory();
    const { security } = await ctx.settings.get();
    const [role] = await ctx.db.select().from(t.roles).where(eq(t.roles.code, 'CASHIER'));
    const [b] = await ctx.db.select().from(t.branches).limit(1);
    const [u] = await ctx.db
      .insert(t.users)
      .values({ username: 'burst.victim', fullName: 'Burst Victim', roleId: role.id, branchId: b.id, passwordHash: await password.hashPassword('Burst-Right-2026') })
      .returning();
    verify.mockClear();
    // Different source IPs, so the per-IP limiter does not hide what the account limiter does.
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) => login(ctx, { username: 'burst.victim', password: `wrong-${i}`, ip: `203.0.113.${i % 250}` })),
    );
    const onVictim = verify.mock.calls.filter(([, hash]) => hash === u.passwordHash).length;
    expect(onVictim).toBeLessThanOrEqual(security.lockoutThreshold);
    expect(onVictim).toBe(security.lockoutThreshold);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const [after] = await ctx.db.select().from(t.users).where(eq(t.users.id, u.id));
    expect(after.failedLoginCount).toBe(security.lockoutThreshold);
    expect(after.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Even the right password is refused now, without being verified.
    verify.mockClear();
    await expect(login(ctx, { username: 'burst.victim', password: 'Burst-Right-2026', ip: '203.0.113.251' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(verify.mock.calls.filter(([, hash]) => hash === u.passwordHash)).toHaveLength(0);

    // After the lock expires, a new burst gets exactly ONE verification (and the lock doubles).
    await ctx.db.update(t.users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(t.users.id, u.id));
    verify.mockClear();
    await Promise.allSettled(Array.from({ length: 50 }, (_, i) => login(ctx, { username: 'burst.victim', password: `again-${i}`, ip: `192.0.2.${i}` })));
    expect(verify.mock.calls.filter(([, hash]) => hash === u.passwordHash)).toHaveLength(1);
    const [relocked] = await ctx.db.select().from(t.users).where(eq(t.users.id, u.id));
    expect((relocked.lockedUntil!.getTime() - Date.now()) / 60_000).toBeGreaterThan(security.lockoutBaseMinutes * 2 - 1);
  });
});
