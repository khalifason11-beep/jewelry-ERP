// "This wasn't me" on a RECOVERY-CODE sign-in (D-2fa-13): the code sheet is treated as stolen. The
// remaining codes are invalidated and the account is security-locked: every sign-in is refused with
// the same answer as a wrong password, whatever is presented, until the operator console lifts it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { resetThrottleMemory } from '../src/auth/lockout';
import { operatorResetSecondFactor, operatorUnlockSecurityLock } from '../src/modules/ops/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

const ORIGIN = 'http://localhost:4000';
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const UA_THIEF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';
const GM = { username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER };
const OP = { host: 'test-host', osUser: 'tester' };

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

const agent = (ua = UA_PC): Agent => request.agent(app).set('user-agent', ua) as unknown as Agent;
const pc = new SoftAuthenticator({ uv: true });
let codes: string[] = [];
let gmId = 0;

async function signedIn(a: Agent, body: { csrfToken?: string }) {
  if (body.csrfToken) a.set('x-csrf-token', body.csrfToken);
  return a;
}
async function withPasskey(ua = UA_PC) {
  const a = agent(ua);
  const p = await a.post('/api/auth/login').send(GM);
  expect(p.body.status).toBe('SECOND_FACTOR_REQUIRED');
  const o = await a.post('/api/auth/login/passkey/options').send({});
  const v = await a.post('/api/auth/login/passkey/verify').send({ response: pc.get(o.body.options, ORIGIN) });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return signedIn(a, v.body);
}
const activeCodes = async () =>
  Number((await ctx.db.select({ n: count() }).from(t.recoveryCodes).where(and(eq(t.recoveryCodes.userId, gmId), isNull(t.recoveryCodes.usedAt), isNull(t.recoveryCodes.invalidatedAt))))[0].n);
const lastAudit = async (action: string) => (await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, action)).orderBy(desc(t.auditLogs.id)).limit(1))[0];

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, undefined, { twoFactor: true });
  app = createApp(ctx, loadConfig({ VITEST: '1', APP_ORIGIN: ORIGIN } as NodeJS.ProcessEnv));
  gmId = (await ctx.db.select().from(t.users).where(eq(t.users.username, GM.username)))[0].id;
  // Enroll the GM: passkey on the shop PC + 10 recovery codes.
  const a = agent();
  const r = await a.post('/api/auth/login').send(GM);
  await signedIn(a, r.body);
  const o = await a.post('/api/auth/passkeys/register/options').send({ nickname: 'Shop PC' });
  expect((await a.post('/api/auth/passkeys/register/verify').send({ response: pc.create(o.body.options, ORIGIN) })).status).toBe(200);
  codes = (await a.post('/api/auth/recovery-codes').send({})).body.codes;
  await a.post('/api/auth/recovery-codes/acknowledge').send({});
});
afterAll(async () => handle?.close());
beforeEach(() => resetThrottleMemory());

describe('security lock after a reported recovery-code sign-in', () => {
  let thiefPending: Agent;

  it('reporting a recovery-code sign-in locks the account, invalidates the remaining codes, ends every session', async () => {
    // The thief has the password and the code sheet: signs in with code 0 …
    const thief = agent(UA_THIEF);
    await thief.post('/api/auth/login').send(GM);
    const s = await thief.post('/api/auth/login/recovery').send({ code: codes[0] });
    expect(s.status).toBe(200);
    await signedIn(thief, s.body);
    // … and has a second sign-in half-way (password accepted, second step pending).
    thiefPending = agent(UA_THIEF);
    expect((await thiefPending.post('/api/auth/login').send(GM)).body.status).toBe('SECOND_FACTOR_REQUIRED');

    const owner = await withPasskey();
    const ev = (await owner.get('/api/auth/sign-ins')).body.find((e: { method: string }) => e.method === 'RECOVERY_CODE');
    expect(ev).toBeTruthy();
    expect(await activeCodes()).toBe(9);
    const r = await owner.post(`/api/auth/sign-ins/${ev.id}/not-me`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ securityLocked: true, recoveryCodesInvalidated: 9, revoked: 1 });

    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.id, gmId));
    expect(u.securityLockedAt).toBeInstanceOf(Date);
    expect(u.securityLockReason).toMatch(/recovery code/);
    expect(u.mustChangePassword).toBe(true);
    expect(await activeCodes()).toBe(0);
    expect((await ctx.db.select({ n: count() }).from(t.webauthnCredentials).where(and(eq(t.webauthnCredentials.userId, gmId), isNull(t.webauthnCredentials.revokedAt))))[0].n).toBe(0);
    expect((await thief.get('/api/auth/me')).status).toBe(401);
    expect((await owner.get('/api/auth/me')).status).toBe(401);
    const audit = await lastAudit('ACCOUNT_SECURED');
    expect(audit.metadata).toMatchObject({ method: 'RECOVERY_CODE', securityLocked: true });
  });

  it('the stolen password plus a leftover code cannot sign in (nor finish a sign-in started before the lock)', async () => {
    expect((await thiefPending.post('/api/auth/login/recovery').send({ code: codes[1] })).status).toBe(401);
    const a = agent(UA_THIEF);
    const p = await a.post('/api/auth/login').send(GM);
    expect(p.status).toBe(401);
    expect(p.body.status).toBeUndefined();
    expect((await a.post('/api/auth/login/recovery').send({ code: codes[2] })).status).toBe(401);
    expect((await a.post('/api/auth/login/passkey/options').send({})).status).toBe(401);
    expect(Number((await ctx.db.select({ n: count() }).from(t.sessions).where(and(eq(t.sessions.userId, gmId), isNull(t.sessions.endedAt))))[0].n)).toBe(0);
  });

  it('the refusal is byte-for-byte the wrong-password answer (no new enumeration channel)', async () => {
    const locked = await agent().post('/api/auth/login').send(GM);
    const wrong = await agent().post('/api/auth/login').send({ username: 'branch.manager.kh', password: 'not-the-password-1' });
    const unknown = await agent().post('/api/auth/login').send({ username: 'nobody.here', password: 'whatever-1' });
    expect(locked.status).toBe(wrong.status);
    expect(locked.body).toEqual(wrong.body);
    expect(unknown.body).toEqual(wrong.body);
    expect(locked.headers['set-cookie']).toBeUndefined();
    // Not counted against the password lockout either (nothing was evaluated).
    expect((await ctx.db.select().from(t.users).where(eq(t.users.id, gmId)))[0].failedLoginCount).toBe(0);
  });

  it('only the operator console lifts it: reset-second-factor refuses; unlock-security-lock resets everything', async () => {
    await expect(operatorResetSecondFactor(ctx, GM.username, OP)).rejects.toMatchObject({ code: 'SECURITY_LOCKED' });
    const r = await operatorUnlockSecurityLock(ctx, GM.username, OP);
    expect(r.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    const audit = await lastAudit('SECURITY_LOCK_LIFTED');
    expect(audit).toMatchObject({ username: 'operator-cli', userFullName: 'System (operator-cli)' });
    expect(audit.metadata).toMatchObject({ host: 'test-host', osUser: 'tester' });
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.id, gmId));
    expect(u).toMatchObject({ securityLockedAt: null, securityLockReason: null, mustChangePassword: true, recoveryCodesAcknowledgedAt: null });
    await expect(operatorUnlockSecurityLock(ctx, GM.username, OP)).rejects.toMatchObject({ code: 'NOT_SECURITY_LOCKED' });

    // The old (stolen) password no longer works; the one-time password does → new password → enrollment.
    expect((await agent().post('/api/auth/login').send(GM)).status).toBe(401);
    const a = agent();
    const s = await a.post('/api/auth/login').send({ username: GM.username, password: r.temporaryPassword });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.user.mustChangePassword).toBe(true);
    await signedIn(a, s.body);
    const c = await a.post('/api/auth/change-password').send({ currentPassword: r.temporaryPassword, newPassword: 'A-brand-new-Passw0rd-2026' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.secondFactor).toMatchObject({ enrollmentRequired: true, passkeys: 0, recoveryCodesAcknowledged: false });
  });
});
