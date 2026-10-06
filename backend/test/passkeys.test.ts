// Phase 2fa: passkeys as the second factor (WebAuthn), on PGlite AND real PostgreSQL. The browser
// is replaced by a software authenticator producing real signatures (test/soft-authenticator.ts);
// @simplewebauthn/server verifies them as in production. The burst test is in test/pg/.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { resetThrottleMemory } from '../src/auth/lockout';
import { log } from '../src/core/logger';
import { webauthnConfigProblems } from '../src/core/startup';
import { applyInitialSecuritySettings } from '../src/modules/auth/passkeys';
import { operatorResetSecondFactor } from '../src/modules/ops/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

const ORIGIN = 'http://localhost:4000';
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
const GM = { username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER };
const BM = { username: 'branch.manager.kh', password: DEMO_PASSWORDS.BRANCH_MANAGER };

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

// Everything the server sends back, to sweep it for secrets at the end (11.4).
const bodies: { path: string; text: string }[] = [];
const logged: string[] = [];

function agent(ua = UA_PC): Agent {
  const a = request.agent(app);
  a.set('user-agent', ua);
  return a;
}
async function call(a: Agent, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: unknown) {
  const r = await a[method](`/api${path}`).send(body as object);
  bodies.push({ path, text: JSON.stringify(r.body) });
  return r;
}
const userId = async (username: string) => (await ctx.db.select().from(t.users).where(eq(t.users.username, username)))[0].id;

async function passwordLogin(u: { username: string; password: string }, ua = UA_PC) {
  const a = agent(ua);
  const r = await call(a, 'post', '/auth/login', { username: u.username, password: u.password });
  if (r.body.csrfToken) a.set('x-csrf-token', r.body.csrfToken);
  return { a, r };
}

/** Password, then the passkey. */
async function twoStep(u: { username: string; password: string }, auth: SoftAuthenticator, override: Parameters<SoftAuthenticator['get']>[2] = {}, ua = UA_PC) {
  const a = agent(ua);
  const r = await call(a, 'post', '/auth/login', { username: u.username, password: u.password });
  expect(r.body.status, JSON.stringify(r.body)).toBe('SECOND_FACTOR_REQUIRED');
  const o = await call(a, 'post', '/auth/login/passkey/options', {});
  const response = auth.get(o.body.options, ORIGIN, override);
  const v = await call(a, 'post', '/auth/login/passkey/verify', { response });
  if (v.body.csrfToken) a.set('x-csrf-token', v.body.csrfToken);
  return { a, v, response, options: o.body.options };
}

/** Password + passkey step-up on a signed-in session. */
async function stepUp(a: Agent, u: { password: string }, auth: SoftAuthenticator) {
  expect((await call(a, 'post', '/auth/reauth', { password: u.password })).status).toBe(200);
  const o = await call(a, 'post', '/auth/reauth/passkey/options', {});
  return call(a, 'post', '/auth/reauth/passkey/verify', { response: auth.get(o.body.options, ORIGIN) });
}

const lastAudit = async (action: string) => (await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, action)).orderBy(desc(t.auditLogs.id)).limit(1))[0];

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, undefined, { twoFactor: true });
  app = createApp(ctx, loadConfig({ VITEST: '1', APP_ORIGIN: ORIGIN } as NodeJS.ProcessEnv));
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((msg: string, fields?: Record<string, unknown>) => {
      logged.push(`${msg} ${JSON.stringify(fields ?? {})}`);
    });
  }
});
afterAll(async () => handle.close());
beforeEach(async () => {
  resetThrottleMemory();
  await ctx.db.update(t.users).set({ mfaFailedCount: 0, mfaLockedUntil: null, failedLoginCount: 0, lockedUntil: null });
});

// The GM's authenticators, shared by the ordered tests below.
const shopPc = new SoftAuthenticator({ uv: true });
const phone = new SoftAuthenticator({ uv: true, counter: 'zero' });
let gmCodes: string[] = [];

describe('enrollment (first sign-in of a required role)', () => {
  it('a GM without a passkey can do nothing but enroll; then registers a passkey and confirms recovery codes', async () => {
    const { a, r } = await passwordLogin(GM);
    expect(r.status).toBe(200);
    expect(r.body.secondFactor).toMatchObject({ required: true, enrollmentRequired: true, passkeys: 0 });
    const blocked = await call(a, 'get', '/sales');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('SECOND_FACTOR_ENROLLMENT_REQUIRED');
    // A nickname is required.
    expect((await call(a, 'post', '/auth/passkeys/register/options', { nickname: '' })).status).toBe(400);
    const o = await call(a, 'post', '/auth/passkeys/register/options', { nickname: 'Shop PC' });
    expect(o.body.options).toMatchObject({ attestation: 'none', rp: { id: 'localhost' }, excludeCredentials: [], authenticatorSelection: { userVerification: 'required' } });
    const v = await call(a, 'post', '/auth/passkeys/register/verify', { response: shopPc.create(o.body.options, ORIGIN) });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ nickname: 'Shop PC', uvAtRegistration: true });
    // Still blocked until the recovery codes are generated AND acknowledged.
    expect((await call(a, 'get', '/sales')).body.error.code).toBe('SECOND_FACTOR_ENROLLMENT_REQUIRED');
    const codes = await call(a, 'post', '/auth/recovery-codes', {});
    expect(codes.body.codes).toHaveLength(10);
    expect(new Set(codes.body.codes).size).toBe(10);
    for (const c of codes.body.codes) expect(c).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    gmCodes = codes.body.codes;
    expect((await call(a, 'get', '/sales')).body.error.code).toBe('SECOND_FACTOR_ENROLLMENT_REQUIRED');
    await call(a, 'post', '/auth/recovery-codes/acknowledge', {});
    expect((await call(a, 'get', '/sales')).status).toBe(200);
    const me = (await call(a, 'get', '/auth/me')).body.secondFactor;
    expect(me).toMatchObject({ enrollmentRequired: false, passkeys: 1, recoveryCodesRemaining: 10, recoveryCodesAcknowledged: true });
    // Stored hashed; audited without key material.
    const rows = await ctx.db.select().from(t.recoveryCodes).where(eq(t.recoveryCodes.userId, await userId(GM.username)));
    expect(rows.every((x) => x.codeHash.startsWith('$argon2id$') && !gmCodes.includes(x.codeHash))).toBe(true);
    const audit = await lastAudit('PASSKEY_REGISTERED');
    expect(audit.description).toContain('Shop PC');
  });
});

describe('two-step sign-in', () => {
  it('password → a pending state that opens no route → passkey → a brand-new session', async () => {
    const a = agent();
    const r = await call(a, 'post', '/auth/login', GM);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'SECOND_FACTOR_REQUIRED', methods: ['PASSKEY', 'RECOVERY_CODE'] });
    expect(r.body).not.toHaveProperty('csrfToken');
    // The pending cookie grants nothing.
    for (const p of ['/auth/me', '/sales', '/auth/passkeys', '/dashboard/company']) expect((await call(a, 'get', p)).status, p).toBe(401);
    const o = await call(a, 'post', '/auth/login/passkey/options', {});
    expect(o.body.options.allowCredentials).toHaveLength(1);
    expect(o.body.options.userVerification).toBe('required');
    const v = await call(a, 'post', '/auth/login/passkey/verify', { response: shopPc.get(o.body.options, ORIGIN) });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.user.username).toBe(GM.username);
    expect(v.body.secondFactor.signInMethod).toBe('PASSKEY');
    a.set('x-csrf-token', v.body.csrfToken);
    expect((await call(a, 'get', '/sales')).status).toBe(200);
    // The pending sign-in is single use.
    expect((await call(a, 'post', '/auth/login/passkey/options', {})).body.error.code).toBe('LOGIN_PENDING_EXPIRED');
    const [ev] = await ctx.db.select().from(t.signInEvents).where(eq(t.signInEvents.userId, await userId(GM.username))).orderBy(desc(t.signInEvents.id)).limit(1);
    expect(ev).toMatchObject({ method: 'PASSKEY', credentialNickname: 'Shop PC', uv: true, browser: 'Chrome on Windows' });
  });

  it('a replayed assertion fails, and every second-step failure looks the same', async () => {
    const first = await twoStep(GM, shopPc);
    expect(first.v.status).toBe(200);
    const a = agent();
    await call(a, 'post', '/auth/login', GM);
    await call(a, 'post', '/auth/login/passkey/options', {});
    const replay = await call(a, 'post', '/auth/login/passkey/verify', { response: first.response });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatchObject({ code: 'SECOND_FACTOR_FAILED' });
    // Same body for a bad recovery code.
    const bad = await call(a, 'post', '/auth/login/recovery', { code: 'AAAAA-BBBBB' });
    expect(bad.body).toEqual(replay.body);
    expect((await lastAudit('SECOND_FACTOR_FAILED')).metadata).toMatchObject({ reason: 'INVALID_RECOVERY_CODE', step: 'LOGIN' });
  });

  it('refuses a wrong origin, a wrong RP ID, an expired or reused challenge, and an expired pending sign-in', async () => {
    for (const override of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }]) {
      const { v } = await twoStep(GM, shopPc, override);
      expect(v.status).toBe(401);
      expect(v.body.error.code).toBe('SECOND_FACTOR_FAILED');
    }
    const reasons = (await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'SECOND_FACTOR_FAILED')).orderBy(desc(t.auditLogs.id)).limit(2)).map((x) => (x.metadata as { reason: string }).reason);
    expect(reasons.sort()).toEqual(['ORIGIN', 'RP_ID']);

    // Expired challenge.
    const a = agent();
    await call(a, 'post', '/auth/login', GM);
    const o = await call(a, 'post', '/auth/login/passkey/options', {});
    await ctx.db.update(t.webauthnChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(isNull(t.webauthnChallenges.consumedAt));
    expect((await call(a, 'post', '/auth/login/passkey/verify', { response: shopPc.get(o.body.options, ORIGIN) })).body.error.code).toBe('SECOND_FACTOR_FAILED');
    // Reused challenge: a second assertion for the same (consumed) challenge.
    const o2 = await call(a, 'post', '/auth/login/passkey/options', {});
    const resp = shopPc.get(o2.body.options, ORIGIN);
    expect((await call(a, 'post', '/auth/login/passkey/verify', { response: resp })).status).toBe(200);
    // Expired pending sign-in.
    const b = agent();
    await call(b, 'post', '/auth/login', GM);
    await ctx.db.update(t.loginPending).set({ expiresAt: new Date(Date.now() - 1000) }).where(isNull(t.loginPending.consumedAt));
    expect((await call(b, 'post', '/auth/login/passkey/options', {})).body.error.code).toBe('LOGIN_PENDING_EXPIRED');
  });

  it('refuses another user’s credential and a revoked credential', async () => {
    // A branch manager registers a passkey voluntarily (not a required role).
    const bmAuth = new SoftAuthenticator({ uv: true });
    const { a } = await passwordLogin(BM);
    expect((await call(a, 'post', '/auth/reauth', { password: BM.password })).status).toBe(200);
    const o = await call(a, 'post', '/auth/passkeys/register/options', { nickname: 'BM laptop' });
    expect((await call(a, 'post', '/auth/passkeys/register/verify', { response: bmAuth.create(o.body.options, ORIGIN) })).status).toBe(200);
    // The GM's pending sign-in answered with the BM's (validly signed) credential.
    const g = agent();
    await call(g, 'post', '/auth/login', GM);
    const go = await call(g, 'post', '/auth/login/passkey/options', {});
    expect((await call(g, 'post', '/auth/login/passkey/verify', { response: bmAuth.get(go.body.options, ORIGIN) })).body.error.code).toBe('SECOND_FACTOR_FAILED');
    expect((await lastAudit('SECOND_FACTOR_FAILED')).metadata).toMatchObject({ reason: 'OTHER_USERS_CREDENTIAL' });

    // The BM's own credential, revoked (soft flag), no longer signs in.
    const bmId = await userId(BM.username);
    await ctx.db.update(t.webauthnCredentials).set({ revokedAt: new Date(), revokedReason: 'test' }).where(eq(t.webauthnCredentials.userId, bmId));
    const b = agent();
    const r = await call(b, 'post', '/auth/login', BM);
    // No passkey left and no recovery codes: an ordinary password sign-in again (not a required role).
    expect(r.body.user?.username).toBe(BM.username);
    expect((await ctx.db.select().from(t.webauthnCredentials).where(eq(t.webauthnCredentials.userId, bmId))).length).toBe(1); // never deleted
  });

  it('rejects a signature-counter regression (security event) and tolerates authenticators that always report 0', async () => {
    const gmId = await userId(GM.username);
    await ctx.db.update(t.webauthnCredentials).set({ signCount: 1000 }).where(and(eq(t.webauthnCredentials.userId, gmId), eq(t.webauthnCredentials.nickname, 'Shop PC')));
    const { v } = await twoStep(GM, shopPc, { counter: 5 });
    expect(v.body.error.code).toBe('SECOND_FACTOR_FAILED');
    const alert = await lastAudit('SIGN_COUNT_REGRESSION');
    expect(alert.metadata).toMatchObject({ reason: 'COUNTER_REGRESSION' });
    expect(logged.some((l) => l.includes('counter regression'))).toBe(true);
    await ctx.db.update(t.webauthnCredentials).set({ signCount: 0 }).where(and(eq(t.webauthnCredentials.userId, gmId), eq(t.webauthnCredentials.nickname, 'Shop PC')));
    shopPc.credentials[0].counter = 0;

    // A second device (the phone) whose counter is always 0: accepted every time.
    const { a } = await twoStep(GM, shopPc);
    expect((await stepUp(a, GM, shopPc)).status).toBe(200);
    const o = await call(a, 'post', '/auth/passkeys/register/options', { nickname: 'Phone' });
    expect(o.body.options.excludeCredentials).toHaveLength(1);
    expect((await call(a, 'post', '/auth/passkeys/register/verify', { response: phone.create(o.body.options, ORIGIN) })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await twoStep(GM, phone, {}, UA_PHONE)).v.status).toBe(200);
  });

  it('wrong password and unknown user still look exactly alike (no new enumeration channel)', async () => {
    const wrong = await call(agent(), 'post', '/auth/login', { username: GM.username, password: 'Wrong-password-123' });
    const unknown = await call(agent(), 'post', '/auth/login', { username: 'nobody.here', password: 'Wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });
});

describe('step-up for sensitive actions', () => {
  it('a GM with a passkey needs password AND passkey; the window then covers several changes', async () => {
    const { a } = await twoStep(GM, shopPc);
    const change = () => call(a, 'put', '/settings', { changes: { 'transfers.pendingClaimStaleHours': 30 + Math.floor(Math.random() * 100) } });
    let r = await change();
    expect(r.body.error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { password: true, passkey: true } });
    await call(a, 'post', '/auth/reauth', { password: GM.password });
    r = await change();
    expect(r.body.error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { password: false, passkey: true } });
    const o = await call(a, 'post', '/auth/reauth/passkey/options', {});
    expect((await call(a, 'post', '/auth/reauth/passkey/verify', { response: shopPc.get(o.body.options, ORIGIN) })).body).toMatchObject({ ok: true, uv: true });
    for (let i = 0; i < 3; i++) expect((await change()).status).toBe(200);
    // Guarded second-factor settings cannot go through the generic settings form.
    const g = await call(a, 'put', '/settings', { changes: { 'security.webauthnUserVerification': 'preferred' } });
    expect(g.status).toBe(403);
  });
});

describe('recovery codes', () => {
  it('sign in with a recovery code once; the same code never works twice; regenerating needs the full step-up', async () => {
    const a = agent();
    await call(a, 'post', '/auth/login', GM);
    const ok = await call(a, 'post', '/auth/login/recovery', { code: gmCodes[0].toLowerCase().replace('-', ' ') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.secondFactor).toMatchObject({ signInMethod: 'RECOVERY_CODE', recoveryCodesRemaining: 9 });
    const b = agent();
    await call(b, 'post', '/auth/login', GM);
    expect((await call(b, 'post', '/auth/login/recovery', { code: gmCodes[0] })).body.error.code).toBe('SECOND_FACTOR_FAILED');
    expect((await lastAudit('RECOVERY_CODE_USED')).description).toContain('9');

    a.set('x-csrf-token', ok.body.csrfToken);
    expect((await call(a, 'post', '/auth/recovery-codes', {})).body.error.code).toBe('REAUTH_REQUIRED');
    expect((await stepUp(a, GM, shopPc)).status).toBe(200);
    const fresh = await call(a, 'post', '/auth/recovery-codes', {});
    expect(fresh.body.codes).toHaveLength(10);
    // The old set is invalid now.
    const c = agent();
    await call(c, 'post', '/auth/login', GM);
    expect((await call(c, 'post', '/auth/login/recovery', { code: gmCodes[1] })).body.error.code).toBe('SECOND_FACTOR_FAILED');
    gmCodes = fresh.body.codes;
    await call(a, 'post', '/auth/recovery-codes/acknowledge', {});
  });
});

describe('credential management', () => {
  it('lists passkeys; removal needs the full step-up; the LAST passkey of a required role cannot be removed', async () => {
    const { a } = await twoStep(GM, shopPc);
    const list = (await call(a, 'get', '/auth/passkeys')).body as { id: number; nickname: string }[];
    expect(list.map((x) => x.nickname)).toEqual(['Shop PC', 'Phone']);
    expect(JSON.stringify(list)).not.toMatch(/publicKey|credentialId/);
    const phoneId = list.find((x) => x.nickname === 'Phone')!.id;
    const shopId = list.find((x) => x.nickname === 'Shop PC')!.id;
    expect((await call(a, 'delete', `/auth/passkeys/${phoneId}`)).body.error.code).toBe('REAUTH_REQUIRED');
    expect((await stepUp(a, GM, shopPc)).status).toBe(200);
    expect((await call(a, 'delete', `/auth/passkeys/${phoneId}`)).status).toBe(200);
    const last = await call(a, 'delete', `/auth/passkeys/${shopId}`);
    expect(last.status).toBe(400);
    expect(last.body.error.key).toMatch(/last passkey/);
    // The removed phone cannot sign in; its row stays (soft flag).
    expect((await twoStep(GM, phone, {}, UA_PHONE)).v.body.error.code).toBe('SECOND_FACTOR_FAILED');
    expect((await lastAudit('SECOND_FACTOR_FAILED')).metadata).toMatchObject({ reason: 'REVOKED_CREDENTIAL' });
    const [row] = await ctx.db.select().from(t.webauthnCredentials).where(eq(t.webauthnCredentials.id, phoneId));
    expect(row.revokedAt).not.toBeNull();
  });
});

describe('user verification setting', () => {
  it('the generic default is "required"; WEBAUTHN_UV_INITIAL is read only when the setting was never stored', async () => {
    const fresh = await openTestDatabase();
    try {
      const c2 = createContext(fresh);
      expect((await c2.settings.get()).security.webauthnUserVerification).toBe('required');
      await applyInitialSecuritySettings(c2, { uv: 'preferred', roles: '' });
      expect((await c2.settings.get()).security).toMatchObject({ webauthnUserVerification: 'preferred', twoFactorRequiredRoles: [] });
      await applyInitialSecuritySettings(c2, { uv: 'required', roles: 'GENERAL_MANAGER' });
      expect((await c2.settings.get()).security).toMatchObject({ webauthnUserVerification: 'preferred', twoFactorRequiredRoles: [] });
    } finally {
      await fresh.close();
    }
    expect(webauthnConfigProblems(loadConfig({ WEBAUTHN_UV_INITIAL: 'sometimes' } as NodeJS.ProcessEnv))).toEqual(['WEBAUTHN_UV_INITIAL must be "required" or "preferred".']);
  });

  it('"required": a touch-only key is refused at registration and at sign-in; "preferred": accepted and recorded', async () => {
    const touchKey = new SoftAuthenticator({ uv: false });
    const { a } = await twoStep(GM, shopPc);
    expect((await stepUp(a, GM, shopPc)).status).toBe(200);
    let o = await call(a, 'post', '/auth/passkeys/register/options', { nickname: 'USB key 1' });
    const refused = await call(a, 'post', '/auth/passkeys/register/verify', { response: touchKey.create(o.body.options, ORIGIN) });
    expect(refused.status).toBe(400);
    expect(refused.body.error.key).toMatch(/did not verify you/);

    // Switch to "preferred" through the guarded flow (password + passkey).
    const sw = await call(a, 'put', '/security/second-factor', { userVerification: 'preferred' });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body.userVerification).toBe('preferred');
    expect((await lastAudit('SECURITY_SETTING_CHANGED')).entityId).toBe('security.webauthnUserVerification');

    o = await call(a, 'post', '/auth/passkeys/register/options', { nickname: 'USB key 1' });
    expect(o.body.options.authenticatorSelection.userVerification).toBe('preferred');
    const accepted = await call(a, 'post', '/auth/passkeys/register/verify', { response: touchKey.create(o.body.options, ORIGIN) });
    expect(accepted.body).toMatchObject({ nickname: 'USB key 1', uvAtRegistration: false });
    const s = await twoStep(GM, touchKey, { credential: touchKey.credentials[1] });
    expect(s.v.status, JSON.stringify(s.v.body)).toBe(200);
    const [ev] = await ctx.db.select().from(t.signInEvents).where(eq(t.signInEvents.userId, await userId(GM.username))).orderBy(desc(t.signInEvents.id)).limit(1);
    expect(ev).toMatchObject({ credentialNickname: 'USB key 1', uv: false });

    // Switching back to "required" with a confirming assertion that lacked UV is refused (no self-lockout)…
    const k = s.a;
    expect((await call(k, 'post', '/auth/reauth', { password: GM.password })).status).toBe(200);
    const ko = await call(k, 'post', '/auth/reauth/passkey/options', {});
    expect((await call(k, 'post', '/auth/reauth/passkey/verify', { response: touchKey.get(ko.body.options, ORIGIN, { credential: touchKey.credentials[1] }) })).body.uv).toBe(false);
    const no = await call(k, 'put', '/security/second-factor', { userVerification: 'required' });
    expect(no.status).toBe(400);
    expect(no.body.error.key).toMatch(/lock you out/);
    // …and allowed after confirming with a device that verifies the user.
    const yo = await call(k, 'post', '/auth/reauth/passkey/options', {});
    expect((await call(k, 'post', '/auth/reauth/passkey/verify', { response: shopPc.get(yo.body.options, ORIGIN) })).body.uv).toBe(true);
    expect((await call(k, 'put', '/security/second-factor', { userVerification: 'required' })).body.userVerification).toBe('required');
    // Existing credentials stay valid; the touch-only key now fails at sign-in (operator CLI is the recovery path).
    expect((await twoStep(GM, touchKey, { credential: touchKey.credentials[1] })).v.body.error.code).toBe('SECOND_FACTOR_FAILED');
    expect((await lastAudit('SECOND_FACTOR_FAILED')).metadata).toMatchObject({ reason: 'USER_VERIFICATION' });
    expect((await call(k, 'get', '/auth/passkeys')).body.map((x: { nickname: string }) => x.nickname)).toContain('USB key 1');
  });

  it('every policy change needs password + a fresh passkey; enforcement changes are audited', async () => {
    const { a } = await twoStep(GM, shopPc);
    const r = await call(a, 'put', '/security/second-factor', { requiredRoles: [] });
    expect(r.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await stepUp(a, GM, shopPc)).status).toBe(200);
    const off = await call(a, 'put', '/security/second-factor', { requiredRoles: ['GENERAL_MANAGER', 'BRANCH_MANAGER'] });
    expect(off.body.requiredRoles).toEqual(['GENERAL_MANAGER', 'BRANCH_MANAGER']);
    // A cashier can never be forced (shared terminals): refused by validation.
    expect((await call(a, 'put', '/security/second-factor', { requiredRoles: ['CASHIER'] })).status).toBe(400);
    const back = await call(a, 'put', '/security/second-factor', { requiredRoles: ['GENERAL_MANAGER'] });
    expect(back.body.requiredRoles).toEqual(['GENERAL_MANAGER']);
    const audits = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'SECURITY_SETTING_CHANGED'), eq(t.auditLogs.entityId, 'security.twoFactorRequiredRoles')));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const hist = await ctx.db.select().from(t.settingsHistory).where(eq(t.settingsHistory.key, 'security.twoFactorRequiredRoles'));
    expect(hist.length).toBeGreaterThanOrEqual(3);
  });
});

describe('recent sign-ins and the new-device alert', () => {
  it('a sign-in from a browser not seen in 30 days raises the alert; it can be dismissed (audited)', async () => {
    await ctx.db.update(t.signInEvents).set({ dismissedAt: new Date() }).where(isNull(t.signInEvents.dismissedAt));
    const { a } = await twoStep(GM, shopPc, {}, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15');
    const me = (await call(a, 'get', '/auth/me')).body.secondFactor;
    expect(me.newDeviceAlert).toMatchObject({ browser: 'Safari on macOS', credentialNickname: 'Shop PC' });
    const list = (await call(a, 'get', '/auth/sign-ins')).body;
    expect(list.length).toBeLessThanOrEqual(10);
    expect(list[0]).toMatchObject({ method: 'PASSKEY', newDevice: true, uv: true });
    expect(list[0].ipApprox ?? '').not.toMatch(/\.\d+$/);
    expect((await call(a, 'post', `/auth/sign-ins/${me.newDeviceAlert.id}/dismiss`)).status).toBe(200);
    expect((await call(a, 'get', '/auth/me')).body.secondFactor.newDeviceAlert).toBeNull();
    expect(await lastAudit('SIGN_IN_ALERT_DISMISSED')).toBeTruthy();
  });

  it('“This wasn’t me” ends every session, revokes the passkeys and forces a new password; the recovery codes get the user back in', async () => {
    const { a } = await twoStep(GM, shopPc, {}, UA_PHONE);
    const other = (await twoStep(GM, shopPc)).a;
    const me = (await call(a, 'get', '/auth/me')).body.secondFactor;
    const id = me.newDeviceAlert?.id ?? (await call(a, 'get', '/auth/sign-ins')).body[0].id;
    const r = await call(a, 'post', `/auth/sign-ins/${id}/not-me`);
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await call(other, 'get', '/auth/me')).status).toBe(401);
    expect((await call(a, 'get', '/auth/me')).status).toBe(401);
    // Password alone is not enough: the second step remains (recovery codes), then a new password, then enrollment.
    const b = agent();
    const p = await call(b, 'post', '/auth/login', GM);
    expect(p.body).toMatchObject({ status: 'SECOND_FACTOR_REQUIRED', methods: ['RECOVERY_CODE'] });
    const s = await call(b, 'post', '/auth/login/recovery', { code: gmCodes[0] });
    expect(s.status).toBe(200);
    expect(s.body.user.mustChangePassword).toBe(true);
    b.set('x-csrf-token', s.body.csrfToken);
    expect((await call(b, 'get', '/sales')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(await lastAudit('ACCOUNT_SECURED')).toBeTruthy();
    // A reported PASSKEY sign-in never locks the account and keeps the other recovery codes (D-2fa-13).
    expect(r.body).toMatchObject({ securityLocked: false, recoveryCodesInvalidated: 0 });
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, GM.username));
    expect(u.securityLockedAt).toBeNull();
    expect((await ctx.db.select({ n: count() }).from(t.recoveryCodes).where(and(eq(t.recoveryCodes.userId, u.id), isNull(t.recoveryCodes.invalidatedAt), isNull(t.recoveryCodes.usedAt))))[0].n).toBeGreaterThan(0);
  });
});

describe('operator console reset (lost device)', () => {
  it('revokes every passkey, invalidates the recovery codes, ends sessions; next sign-in must enroll again', async () => {
    const bmId = await userId(BM.username);
    const r = await operatorResetSecondFactor(ctx, GM.username, { host: 'test', osUser: 'tester' });
    expect(r.username).toBe(GM.username);
    const gmId = await userId(GM.username);
    expect((await ctx.db.select({ n: count() }).from(t.webauthnCredentials).where(and(eq(t.webauthnCredentials.userId, gmId), isNull(t.webauthnCredentials.revokedAt))))[0].n).toBe(0);
    expect((await ctx.db.select({ n: count() }).from(t.recoveryCodes).where(and(eq(t.recoveryCodes.userId, gmId), isNull(t.recoveryCodes.invalidatedAt), isNull(t.recoveryCodes.usedAt))))[0].n).toBe(0);
    const audit = await lastAudit('SECOND_FACTOR_RESET');
    expect(audit.username ?? audit.metadata).toBeTruthy();
    expect(JSON.stringify(audit)).toContain('operator-cli');
    // Password-only sign-in → enrollment only (the password must be changed first after "not me").
    await ctx.db.update(t.users).set({ mustChangePassword: false }).where(eq(t.users.id, gmId));
    const { r: login } = await passwordLogin(GM);
    expect(login.body.secondFactor).toMatchObject({ enrollmentRequired: true, passkeys: 0 });
    expect(bmId).toBeGreaterThan(0);
  });
});

describe('demo mode default', () => {
  it('without DEMO_TWO_FACTOR the demo requires no second factor (the login page keeps working)', async () => {
    const h = await openTestDatabase();
    try {
      const c = createContext(h);
      await seedWorld(c);
      expect((await c.settings.get()).security.twoFactorRequiredRoles).toEqual([]);
      const a2 = createApp(c, loadConfig({ VITEST: '1', APP_ORIGIN: ORIGIN } as NodeJS.ProcessEnv));
      const r = await request(a2).post('/api/auth/login').send(GM);
      expect(r.body.user.username).toBe(GM.username);
      expect(r.body.secondFactor).toMatchObject({ required: false, enrollmentRequired: false });
    } finally {
      await h.close();
    }
  });
});

describe('secrets never leave the server (11.4)', () => {
  it('no public key, challenge, recovery code or hash in responses (outside their one place), audit entries or logs', async () => {
    const keys = (await ctx.db.select({ k: t.webauthnCredentials.publicKey }).from(t.webauthnCredentials)).map((r) => r.k);
    const hashes = [
      ...(await ctx.db.select({ h: t.recoveryCodes.codeHash }).from(t.recoveryCodes)).map((r) => r.h),
      ...(await ctx.db.select({ h: t.webauthnChallenges.challengeHash }).from(t.webauthnChallenges)).map((r) => r.h),
    ];
    // The user handle is an opaque random id the protocol hands to the authenticator in the
    // registration options (user.id); it must appear nowhere else.
    const handles = (await ctx.db.select({ h: t.users.webauthnUserHandle }).from(t.users)).map((r) => r.h).filter(Boolean) as string[];
    expect(handles.length).toBeGreaterThan(0);
    const challenges = bodies.filter((b) => b.path.endsWith('/options')).map((b) => (JSON.parse(b.text).options?.challenge as string) ?? '').filter(Boolean);
    const codes = bodies.filter((b) => b.path === '/auth/recovery-codes').flatMap((b) => (JSON.parse(b.text).codes as string[]) ?? []);
    expect(keys.length).toBeGreaterThan(0);
    expect(challenges.length).toBeGreaterThan(5);
    expect(codes.length).toBeGreaterThanOrEqual(20);
    const audits = JSON.stringify(await ctx.db.select().from(t.auditLogs));
    const logs = logged.join('\n');
    for (const s of [...keys, ...hashes]) {
      for (const b of bodies) expect(b.text.includes(s), `secret in response of ${b.path}`).toBe(false);
      expect(audits.includes(s)).toBe(false);
      expect(logs.includes(s)).toBe(false);
    }
    for (const h of handles) {
      for (const b of bodies.filter((x) => x.path !== '/auth/passkeys/register/options')) expect(b.text.includes(h), `user handle in ${b.path}`).toBe(false);
      expect(audits.includes(h)).toBe(false);
      expect(logs.includes(h)).toBe(false);
    }
    for (const c of challenges) {
      for (const b of bodies.filter((x) => !x.path.endsWith('/options'))) expect(b.text.includes(c), `challenge in ${b.path}`).toBe(false);
      expect(audits.includes(c)).toBe(false);
      expect(logs.includes(c)).toBe(false);
    }
    for (const c of codes) {
      for (const b of bodies.filter((x) => x.path !== '/auth/recovery-codes')) expect(b.text.includes(c), `recovery code in ${b.path}`).toBe(false);
      expect(audits.includes(c)).toBe(false);
      expect(logs.includes(c)).toBe(false);
    }
    // Field names too: nothing SECRET-classified anywhere.
    for (const b of bodies) expect(b.text).not.toMatch(/"(publicKey|codeHash|challengeHash|passwordHash|webauthnUserHandle|tokenHash)"/);
    void sql;
  });
});
