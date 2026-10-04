// Real PostgreSQL only: 200 parallel invalid passkey assertions for ONE pending sign-in over a
// connection pool. At most `security.lockoutThreshold` may reach cryptographic verification
// (reserve-then-verify, D-2fa-6), exactly as for passwords (D-2a-10).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../../src/app';
import { createContext } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import type { Ctx } from '../../src/core/context';
import { resetThrottleMemory } from '../../src/auth/lockout';
import { webauthn } from '../../src/auth/webauthn';
import { loginPasskeyOptions, loginPasskeyVerify } from '../../src/modules/auth/passkeys';
import { seedDemo } from '../../src/seed/demo';
import { DEMO_PASSWORDS } from '../../src/seed/catalog';
import { openTestDatabase, PG_MODE } from '../helpers';
import { SoftAuthenticator } from '../soft-authenticator';

const ORIGIN = 'http://localhost:4000';
const RP = { rpId: 'localhost', rpName: 'Test', origin: ORIGIN };
const GM = { username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER };

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedDemo(ctx, undefined, { twoFactor: true });
  app = createApp(ctx, loadConfig({ VITEST: '1', APP_ORIGIN: ORIGIN } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

const pendingToken = (r: request.Response) => {
  const c = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((x) => x.startsWith('jerp_pending='));
  return c!.split(';')[0].split('=')[1];
};

describe('second-factor lockout under a burst of parallel assertions', () => {
  it('200 parallel invalid assertions: at most lockoutThreshold are verified; the right passkey is then refused unverified', async () => {
    resetThrottleMemory();
    const { security } = await ctx.settings.get();
    const key = new SoftAuthenticator({ uv: true });

    // Enroll the GM (password → register → recovery codes).
    const a = request.agent(app);
    const login = await a.post('/api/auth/login').send(GM);
    a.set('x-csrf-token', login.body.csrfToken);
    const o = await a.post('/api/auth/passkeys/register/options').send({ nickname: 'Shop PC' });
    expect((await a.post('/api/auth/passkeys/register/verify').send({ response: key.create(o.body.options, ORIGIN) })).status).toBe(200);
    await a.post('/api/auth/recovery-codes').send({});
    await a.post('/api/auth/recovery-codes/acknowledge').send({});

    // A new sign-in: password accepted → pending.
    const b = request.agent(app);
    const pw = await b.post('/api/auth/login').send(GM);
    expect(pw.body.status).toBe('SECOND_FACTOR_REQUIRED');
    const token = pendingToken(pw);

    // 200 valid-looking challenges, each answered with a correctly signed assertion for the WRONG RP ID.
    const responses = [];
    for (let i = 0; i < 200; i++) {
      const opts = await loginPasskeyOptions(ctx, token, RP);
      responses.push(key.get(opts, ORIGIN, { rpId: 'evil.example' }));
    }
    const spy = vi.spyOn(webauthn, 'verifyAssertion');
    const results = await Promise.allSettled(responses.map((r) => loginPasskeyVerify(ctx, token, r as never, { ip: '203.0.113.7' })));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(security.lockoutThreshold);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, GM.username));
    expect(u.mfaLockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Locked: even a correct assertion is refused without reaching verification.
    spy.mockClear();
    const opts = await loginPasskeyOptions(ctx, token, RP);
    await expect(loginPasskeyVerify(ctx, token, key.get(opts, ORIGIN) as never, { ip: '203.0.113.7' })).rejects.toMatchObject({ code: 'SECOND_FACTOR_FAILED' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
