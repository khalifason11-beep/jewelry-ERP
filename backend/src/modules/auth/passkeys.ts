// Passkeys as the second factor (Phase 2fa, docs/decisions.md D-2fa-*).
//
// Sign-in for an enrolled user is two steps: the password opens a PENDING sign-in (a 5-minute,
// single-use token in its own cookie that reaches no route but the second step); a passkey
// assertion or a recovery code then creates the real session (a brand-new session id). Every
// failure of the second step returns the same generic error and is counted with the same
// reserve-then-verify lockout as passwords. Cryptography is done by @simplewebauthn/server.

import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { ap, type SignInMethod, type SystemSettings, type TwoFactorRole, type WebauthnUv } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors';
import { log } from '../../core/logger';
import { hashPassword, verifyPassword } from '../../auth/password';
import { clearFailures } from '../../auth/lockout';
import { freshFactors, reauthRequired } from '../../auth/reauth';
import {
  activeCredentialCount,
  clearMfaFailures,
  factorState,
  newRecoveryCode,
  normaliseRecoveryCode,
  recordSignIn,
  RECOVERY_CODE_COUNT,
  reserveMfaAttempt,
  type FactorState,
} from '../../auth/second-factor';
import {
  CEREMONY_TIMEOUT_MS,
  challengeOf,
  consumeChallenge,
  reasonOf,
  storeChallenge,
  webauthn,
  type AuthenticationResponseJSON,
  type FailureReason,
  type RegistrationResponseJSON,
  type RelyingParty,
} from '../../auth/webauthn';
import { createSession, endUserSessions, loadActor, markReauthenticated, sessionRef } from '../sessions/service';

export const PENDING_TTL_MS = 5 * 60_000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The ONE error of the second step, whatever went wrong (D-2fa-6). */
export const secondFactorFailed = () => new AppError(401, 'SECOND_FACTOR_FAILED', 'Sign-in could not be completed. Try again with your passkey, or use a recovery code.');
export const pendingExpired = () => new AppError(401, 'LOGIN_PENDING_EXPIRED', 'The sign-in took too long. Enter your password again.');

const uvOf = (s: SystemSettings) => s.security.webauthnUserVerification;

// ───────────────────────── sessions after a complete sign-in ─────────────────────────

export interface SessionOpened {
  token: string;
  id: string;
  csrfToken: string;
  actor: Actor;
}

/** Create the session (new id), record the sign-in, audit it. Runs inside the caller's transaction. */
export async function openSession(
  tx: Executor,
  ctx: Ctx,
  u: { id: number; username: string; fullName: string; fullNameAr: string | null; branchId: number | null },
  input: { userAgent?: string; ip: string; method: SignInMethod; credential?: { id: number; nickname: string } | null; uv: boolean | null; reauthNow?: boolean },
): Promise<SessionOpened> {
  const { security } = await ctx.settings.get();
  const s = await createSession(tx, { userId: u.id, branchId: u.branchId, userAgent: input.userAgent, ip: input.ip, absoluteHours: security.sessionAbsoluteHours });
  await tx.update(t.sessions).set({ signInMethod: input.method }).where(eq(t.sessions.id, s.id));
  if (input.reauthNow) await markReauthenticated(tx, s.id);
  await tx.update(t.users).set({ lastLoginAt: new Date() }).where(eq(t.users.id, u.id));
  await recordSignIn(tx, { userId: u.id, sessionId: s.id, method: input.method, credential: input.credential, userAgent: input.userAgent, ip: input.ip, uv: input.uv });
  const actor = (await loadActor(tx, u.id, s.id))!;
  actor.ip = input.ip;
  await writeAudit(tx, actor, {
    action: 'LOGIN',
    entityType: 'session',
    entityId: sessionRef(s.id),
    key: input.method === 'PASSKEY' ? '{name} ({username}) signed in with passkey “{nickname}”' : input.method === 'RECOVERY_CODE' ? '{name} ({username}) signed in with a recovery code' : '{name} ({username}) signed in',
    params: { name: ap.text(u.fullName, u.fullNameAr), username: u.username, ...(input.credential ? { nickname: input.credential.nickname } : {}) },
    metadata: { method: input.method, uv: input.uv },
  });
  return { ...s, actor };
}

// ───────────────────────── pending sign-in ─────────────────────────

export async function createPending(tx: Executor, userId: number, input: { userAgent?: string; ip: string }): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  await tx.insert(t.loginPending).values({ tokenHash: tokenHash(token), userId, ipAddress: input.ip, userAgent: input.userAgent?.slice(0, 400) ?? null, expiresAt });
  return { token, expiresAt };
}

async function pendingFor(exec: Executor, token: string | undefined) {
  if (!token || token.length > 100) return null;
  const [p] = await exec
    .select()
    .from(t.loginPending)
    .where(and(eq(t.loginPending.tokenHash, tokenHash(token)), isNull(t.loginPending.consumedAt), gt(t.loginPending.expiresAt, new Date())));
  return p ?? null;
}

async function pendingUser(exec: Executor, userId: number) {
  const [u] = await exec
    .select({ id: t.users.id, username: t.users.username, fullName: t.users.fullName, fullNameAr: t.users.fullNameAr, branchId: t.users.branchId, status: t.users.status, locked: t.users.securityLockedAt })
    .from(t.users)
    .where(eq(t.users.id, userId));
  return u && u.status === 'ACTIVE' && !u.locked ? u : null;
}

/** Consume the pending sign-in exactly once (a parallel duplicate finds nothing). */
async function consumePending(tx: Executor, id: string): Promise<boolean> {
  const r = await tx.update(t.loginPending).set({ consumedAt: new Date() }).where(and(eq(t.loginPending.tokenHash, id), isNull(t.loginPending.consumedAt))).returning({ id: t.loginPending.tokenHash });
  return r.length === 1;
}

export async function cancelPending(ctx: Ctx, token: string | undefined): Promise<void> {
  const p = await pendingFor(ctx.db, token);
  if (p) await consumePending(ctx.db, p.tokenHash);
}

/** What the second step may offer (after the password only). */
export async function pendingMethods(ctx: Ctx, token: string | undefined) {
  const p = await pendingFor(ctx.db, token);
  if (!p) throw pendingExpired();
  const credentials = await activeCredentialCount(ctx.db, p.userId);
  return { methods: credentials > 0 ? (['PASSKEY', 'RECOVERY_CODE'] as const) : (['RECOVERY_CODE'] as const), expiresAt: p.expiresAt };
}

async function auditSecondFactorFailure(exec: Executor, userId: number, reason: FailureReason, where: 'LOGIN' | 'STEPUP', actor?: Actor | null) {
  const [u] = await exec.select({ username: t.users.username, branchId: t.users.branchId }).from(t.users).where(eq(t.users.id, userId));
  await writeAudit(exec, actor ?? null, {
    action: reason === 'COUNTER_REGRESSION' ? 'SIGN_COUNT_REGRESSION' : 'SECOND_FACTOR_FAILED',
    entityType: 'user',
    entityId: u?.username ?? String(userId),
    branchId: u?.branchId ?? null,
    key:
      reason === 'COUNTER_REGRESSION'
        ? 'Security alert: passkey of {username} replayed or cloned (signature counter went backwards)'
        : where === 'LOGIN'
          ? 'Second sign-in step failed for {username}'
          : 'Passkey confirmation failed for {username}',
    params: { username: u?.username ?? String(userId) },
    // Reason code only: never the response, the challenge or the key.
    metadata: { reason, step: where },
  });
  if (reason === 'COUNTER_REGRESSION') log.warn('SECURITY: passkey signature counter regression', { userId });
}

async function lockedAudit(exec: Executor, userId: number, until: Date) {
  const [u] = await exec.select({ username: t.users.username, branchId: t.users.branchId }).from(t.users).where(eq(t.users.id, userId));
  await writeAudit(exec, null, {
    action: 'SECOND_FACTOR_LOCKED',
    entityType: 'user',
    entityId: u.username,
    branchId: u.branchId,
    key: 'Second factor of {username} locked for {minutes} min after repeated failures',
    params: { username: u.username, minutes: Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000)) },
  });
}

// ───────────────────────── passkey assertion (login and step-up) ─────────────────────────

/** Options for a passkey assertion of `userId` (allowCredentials = the user's active passkeys). */
async function assertionOptions(ctx: Ctx, exec: Executor, userId: number, rp: RelyingParty, binding: { pendingId?: string; sessionId?: string }, purpose: 'LOGIN' | 'STEPUP') {
  const settings = await ctx.settings.get();
  const creds = await exec
    .select({ credentialId: t.webauthnCredentials.credentialId, transports: t.webauthnCredentials.transports })
    .from(t.webauthnCredentials)
    .where(and(eq(t.webauthnCredentials.userId, userId), isNull(t.webauthnCredentials.revokedAt)));
  if (!creds.length) throw badRequest('No passkey is registered for this account');
  const options = await webauthn.authenticationOptions({
    rpID: rp.rpId,
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: (c.transports as never) ?? undefined })),
    userVerification: uvOf(settings),
    timeout: CEREMONY_TIMEOUT_MS,
  });
  await storeChallenge(exec, { purpose, userId, ...binding, challenge: options.challenge, rp });
  return options;
}

type AssertionResult = { ok: true; credential: { id: number; nickname: string }; uv: boolean } | { ok: false; reason: FailureReason };

/**
 * Verify one assertion for `userId`. The challenge is consumed FIRST (single use whatever happens),
 * then the credential must be this user's and not revoked, then the library verifies origin, RP ID,
 * signature, user presence, user verification (per the setting) and the signature counter.
 */
async function verifyAssertionFor(tx: Executor, ctx: Ctx, userId: number, response: AuthenticationResponseJSON, binding: { pendingId?: string; sessionId?: string }, purpose: 'LOGIN' | 'STEPUP'): Promise<AssertionResult> {
  const settings = await ctx.settings.get();
  const ch = await consumeChallenge(tx, { purpose, userId, ...binding, challenge: challengeOf(response) });
  if (!ch) return { ok: false, reason: 'CHALLENGE' };
  const credId = typeof response.id === 'string' ? response.id : '';
  const [cred] = credId ? await tx.select().from(t.webauthnCredentials).where(eq(t.webauthnCredentials.credentialId, credId)) : [];
  if (!cred) return { ok: false, reason: 'UNKNOWN_CREDENTIAL' };
  if (cred.userId !== userId) return { ok: false, reason: 'OTHER_USERS_CREDENTIAL' };
  if (cred.revokedAt) return { ok: false, reason: 'REVOKED_CREDENTIAL' };
  let result;
  try {
    result = await webauthn.verifyAssertion({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: ch.origin,
      expectedRPID: ch.rpId,
      requireUserVerification: uvOf(settings) === 'required',
      credential: { id: cred.credentialId, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: cred.signCount, transports: (cred.transports as never) ?? undefined },
    });
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
  if (!result.verified) return { ok: false, reason: 'SIGNATURE' };
  const info = result.authenticationInfo;
  await tx
    .update(t.webauthnCredentials)
    .set({ signCount: info.newCounter, lastUsedAt: new Date(), backedUp: info.credentialBackedUp })
    .where(eq(t.webauthnCredentials.id, cred.id));
  return { ok: true, credential: { id: cred.id, nickname: cred.nickname }, uv: !!info.userVerified };
}

// ───────────────────────── login: second step ─────────────────────────

export async function loginPasskeyOptions(ctx: Ctx, token: string | undefined, rp: RelyingParty) {
  const p = await pendingFor(ctx.db, token);
  if (!p) throw pendingExpired();
  return assertionOptions(ctx, ctx.db, p.userId, rp, { pendingId: p.tokenHash }, 'LOGIN');
}

async function secondStep<T>(
  ctx: Ctx,
  token: string | undefined,
  input: { userAgent?: string; ip: string },
  check: (tx: Executor, userId: number, pendingId: string) => Promise<{ ok: true; method: SignInMethod; credential?: { id: number; nickname: string }; uv: boolean | null } | { ok: false; reason: FailureReason }>,
): Promise<SessionOpened & { factor: FactorState; extra?: T }> {
  const { security } = await ctx.settings.get();
  const p = await pendingFor(ctx.db, token);
  if (!p) throw pendingExpired();
  const user = await pendingUser(ctx.db, p.userId);
  if (!user) throw pendingExpired();
  // Reserve a failure BEFORE verifying anything (refunded on success).
  const r = await reserveMfaAttempt(ctx.db, p.userId, security);
  if (!r.allowed) {
    await auditSecondFactorFailure(ctx.db, p.userId, 'LOCKED', 'LOGIN');
    throw secondFactorFailed();
  }
  const outcome = await ctx.db.transaction(async (tx) => {
    // Serialise with "This wasn't me" (it locks the same row): a security lock taken meanwhile wins.
    const [lock] = await tx.select({ at: t.users.securityLockedAt }).from(t.users).where(eq(t.users.id, p.userId)).for('update');
    if (lock?.at) return { ok: false as const, reason: 'LOCKED' as FailureReason };
    const res = await check(tx, p.userId, p.tokenHash);
    if (!res.ok) return res;
    if (!(await consumePending(tx, p.tokenHash))) return { ok: false as const, reason: 'CHALLENGE' as FailureReason };
    await clearMfaFailures(tx, p.userId);
    await clearFailures(tx, p.userId);
    const factor = await factorState(tx, p.userId, (await roleOf(tx, p.userId))!, security);
    // A second-factor sign-in without a passkey left (e.g. after "this wasn't me"): straight into
    // enrollment, with the password counted as just confirmed.
    const s = await openSession(tx, ctx, user, { ...input, method: res.method, credential: res.credential, uv: res.uv, reauthNow: factor.enrollmentRequired });
    return { ok: true as const, session: s, factor };
  });
  if (!outcome.ok) {
    await ctx.db.transaction(async (tx) => {
      await auditSecondFactorFailure(tx, p.userId, outcome.reason, 'LOGIN');
      if (r.lockedUntil) await lockedAudit(tx, p.userId, r.lockedUntil);
    });
    throw secondFactorFailed();
  }
  return { ...outcome.session, factor: outcome.factor };
}

async function roleOf(exec: Executor, userId: number): Promise<string | null> {
  const [r] = await exec.select({ code: t.roles.code }).from(t.users).innerJoin(t.roles, eq(t.roles.id, t.users.roleId)).where(eq(t.users.id, userId));
  return r?.code ?? null;
}

export async function loginPasskeyVerify(ctx: Ctx, token: string | undefined, response: AuthenticationResponseJSON, input: { userAgent?: string; ip: string }) {
  return secondStep(ctx, token, input, async (tx, userId, pendingId) => {
    const r = await verifyAssertionFor(tx, ctx, userId, response, { pendingId }, 'LOGIN');
    return r.ok ? { ok: true, method: 'PASSKEY', credential: r.credential, uv: r.uv } : r;
  });
}

export async function loginRecoveryCode(ctx: Ctx, token: string | undefined, code: string, input: { userAgent?: string; ip: string }) {
  return secondStep(ctx, token, input, async (tx, userId) => {
    const used = await consumeRecoveryCode(tx, userId, code);
    if (!used) return { ok: false, reason: 'INVALID_RECOVERY_CODE' };
    const [u] = await tx.select({ username: t.users.username, branchId: t.users.branchId }).from(t.users).where(eq(t.users.id, userId));
    await writeAudit(tx, null, {
      action: 'RECOVERY_CODE_USED',
      entityType: 'user',
      entityId: u.username,
      branchId: u.branchId,
      key: '{username} used a recovery code to sign in ({remaining} left)',
      params: { username: u.username, remaining: used.remaining },
    });
    return { ok: true, method: 'RECOVERY_CODE', uv: null };
  });
}

/** Verify a recovery code against the user's unused ones and consume the match atomically. */
async function consumeRecoveryCode(tx: Executor, userId: number, input: string): Promise<{ remaining: number } | null> {
  const code = normaliseRecoveryCode(input);
  if (!code) return null;
  const rows = await tx
    .select({ id: t.recoveryCodes.id, hash: t.recoveryCodes.codeHash })
    .from(t.recoveryCodes)
    .where(and(eq(t.recoveryCodes.userId, userId), isNull(t.recoveryCodes.usedAt), isNull(t.recoveryCodes.invalidatedAt)));
  for (const r of rows) {
    if (await verifyPassword(code, r.hash)) {
      const done = await tx.update(t.recoveryCodes).set({ usedAt: new Date() }).where(and(eq(t.recoveryCodes.id, r.id), isNull(t.recoveryCodes.usedAt))).returning({ id: t.recoveryCodes.id });
      if (!done.length) return null;
      return { remaining: rows.length - 1 };
    }
  }
  return null;
}

// ───────────────────────── step-up with a passkey ─────────────────────────

export async function stepUpOptions(ctx: Ctx, actor: Actor, rp: RelyingParty) {
  if (!actor.sessionId) throw forbidden();
  return assertionOptions(ctx, ctx.db, actor.userId, rp, { sessionId: actor.sessionId }, 'STEPUP');
}

/**
 * Confirm with a passkey on a signed-in session: opens the passkey half of the re-auth window and
 * records whether user verification was proved (needed to switch the UV setting to "required").
 * Failures count on the second-factor lockout; reaching it ends every session of the user.
 */
export async function stepUpVerify(ctx: Ctx, actor: Actor, response: AuthenticationResponseJSON) {
  if (!actor.sessionId) throw forbidden();
  const { security } = await ctx.settings.get();
  const r = await reserveMfaAttempt(ctx.db, actor.userId, security);
  if (!r.allowed) throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
  const res = await ctx.db.transaction(async (tx) => {
    const v = await verifyAssertionFor(tx, ctx, actor.userId, response, { sessionId: actor.sessionId! }, 'STEPUP');
    if (!v.ok) return v;
    await clearMfaFailures(tx, actor.userId);
    await tx.update(t.sessions).set({ passkeyReauthAt: new Date(), passkeyReauthUv: v.uv }).where(eq(t.sessions.id, actor.sessionId!));
    await writeAudit(tx, actor, {
      action: 'REAUTHENTICATED',
      entityType: 'session',
      entityId: sessionRef(actor.sessionId!),
      key: '{username} confirmed with passkey “{nickname}”',
      params: { username: actor.username, nickname: v.credential.nickname },
      metadata: { uv: v.uv },
    });
    return v;
  });
  if (!res.ok) {
    await ctx.db.transaction(async (tx) => {
      await auditSecondFactorFailure(tx, actor.userId, res.reason, 'STEPUP', actor);
      if (r.lockedUntil) {
        await lockedAudit(tx, actor.userId, r.lockedUntil);
        await endUserSessions(tx, actor.userId, 'Second factor locked');
      }
    });
    throw new AppError(403, 'REAUTH_FAILED', 'The passkey could not be confirmed');
  }
  return { ok: true, uv: res.uv, validForMinutes: security.reauthWindowMinutes };
}

// ───────────────────────── registration ─────────────────────────

/** Password re-confirmed within the window, and the passkey too when the user already has one. */
async function requireFreshForCredentialChange(ctx: Ctx, actor: Actor) {
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  if (!f.password || (f.hasPasskey && !f.passkey)) throw reauthRequired(f);
  return f;
}

async function userHandle(exec: Executor, userId: number): Promise<string> {
  const [u] = await exec.select({ h: t.users.webauthnUserHandle }).from(t.users).where(eq(t.users.id, userId));
  if (u?.h) return u.h;
  const h = randomBytes(32).toString('base64url');
  await exec.update(t.users).set({ webauthnUserHandle: h }).where(and(eq(t.users.id, userId), isNull(t.users.webauthnUserHandle)));
  const [again] = await exec.select({ h: t.users.webauthnUserHandle }).from(t.users).where(eq(t.users.id, userId));
  return again.h!;
}

const cleanNickname = (n: string) => n.replace(/\s+/g, ' ').trim();

export async function registrationOptions(ctx: Ctx, actor: Actor, nickname: string, rp: RelyingParty) {
  if (!actor.sessionId) throw forbidden();
  const nick = cleanNickname(nickname);
  if (nick.length < 1 || nick.length > 60) throw badRequest('Give this device a name (1 to 60 characters)');
  await requireFreshForCredentialChange(ctx, actor);
  const settings = await ctx.settings.get();
  const existing = await ctx.db
    .select({ credentialId: t.webauthnCredentials.credentialId, transports: t.webauthnCredentials.transports })
    .from(t.webauthnCredentials)
    .where(and(eq(t.webauthnCredentials.userId, actor.userId), isNull(t.webauthnCredentials.revokedAt)));
  const handle = await userHandle(ctx.db, actor.userId);
  const options = await webauthn.registrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userName: actor.username,
    userID: Buffer.from(handle, 'base64url'),
    userDisplayName: actor.fullNameAr || actor.fullName,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: (c.transports as never) ?? undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: uvOf(settings) },
    timeout: CEREMONY_TIMEOUT_MS,
  });
  await storeChallenge(ctx.db, { purpose: 'REGISTER', userId: actor.userId, sessionId: actor.sessionId, challenge: options.challenge, rp, nickname: nick });
  return options;
}

export async function registrationVerify(ctx: Ctx, actor: Actor, response: RegistrationResponseJSON) {
  if (!actor.sessionId) throw forbidden();
  await requireFreshForCredentialChange(ctx, actor);
  const settings = await ctx.settings.get();
  return ctx.db.transaction(async (tx) => {
    const ch = await consumeChallenge(tx, { purpose: 'REGISTER', userId: actor.userId, sessionId: actor.sessionId!, challenge: challengeOf(response) });
    if (!ch) throw badRequest('This registration expired. Start again.');
    let result;
    try {
      result = await webauthn.verifyAttestation({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: ch.origin,
        expectedRPID: ch.rpId,
        requireUserVerification: uvOf(settings) === 'required',
      });
    } catch (e) {
      const reason = reasonOf(e);
      throw badRequest(reason === 'USER_VERIFICATION' ? 'This device did not verify you (fingerprint, face or PIN), which is required' : 'This device could not be registered. Try again.');
    }
    if (!result.verified || !result.registrationInfo) throw badRequest('This device could not be registered. Try again.');
    const info = result.registrationInfo;
    const [dup] = await tx.select({ id: t.webauthnCredentials.id }).from(t.webauthnCredentials).where(eq(t.webauthnCredentials.credentialId, info.credential.id));
    if (dup) throw badRequest('This device is already registered');
    const [row] = await tx
      .insert(t.webauthnCredentials)
      .values({
        userId: actor.userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        signCount: info.credential.counter,
        transports: info.credential.transports ?? null,
        nickname: ch.nickname ?? 'Passkey',
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        uvAtRegistration: !!info.userVerified,
      })
      .returning({ id: t.webauthnCredentials.id, nickname: t.webauthnCredentials.nickname, uvAtRegistration: t.webauthnCredentials.uvAtRegistration, createdAt: t.webauthnCredentials.createdAt });
    await writeAudit(tx, actor, {
      action: 'PASSKEY_REGISTERED',
      entityType: 'user',
      entityId: actor.username,
      key: '{username} registered passkey “{nickname}”',
      params: { username: actor.username, nickname: row.nickname },
      metadata: { credential: row.id, uv: row.uvAtRegistration, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp },
    });
    return row;
  });
}

// ───────────────────────── credential management ─────────────────────────

export async function listPasskeys(ctx: Ctx, actor: Actor) {
  return ctx.db
    .select({
      id: t.webauthnCredentials.id,
      nickname: t.webauthnCredentials.nickname,
      createdAt: t.webauthnCredentials.createdAt,
      lastUsedAt: t.webauthnCredentials.lastUsedAt,
      uvAtRegistration: t.webauthnCredentials.uvAtRegistration,
      backedUp: t.webauthnCredentials.backedUp,
      deviceType: t.webauthnCredentials.deviceType,
    })
    .from(t.webauthnCredentials)
    .where(and(eq(t.webauthnCredentials.userId, actor.userId), isNull(t.webauthnCredentials.revokedAt)))
    .orderBy(asc(t.webauthnCredentials.id));
}

/** Soft revocation (never a delete). The last passkey of a user whose role requires 2FA stays. */
export async function removePasskey(ctx: Ctx, actor: Actor, id: number) {
  const { security } = await ctx.settings.get();
  return ctx.db.transaction(async (tx) => {
    const [c] = await tx.select().from(t.webauthnCredentials).where(and(eq(t.webauthnCredentials.id, id), eq(t.webauthnCredentials.userId, actor.userId), isNull(t.webauthnCredentials.revokedAt))).for('update');
    if (!c) throw notFound('Passkey');
    // Serialise removals of this user's passkeys (two parallel removals cannot both pass the check).
    await tx.select({ id: t.users.id }).from(t.users).where(eq(t.users.id, actor.userId)).for('update');
    const remaining = await activeCredentialCount(tx, actor.userId);
    if (remaining <= 1 && (security.twoFactorRequiredRoles as string[]).includes(actor.roleCode)) {
      throw badRequest('This is your last passkey: register another device before removing it');
    }
    await tx.update(t.webauthnCredentials).set({ revokedAt: new Date(), revokedReason: 'Removed by the user' }).where(eq(t.webauthnCredentials.id, c.id));
    await writeAudit(tx, actor, {
      action: 'PASSKEY_REMOVED',
      entityType: 'user',
      entityId: actor.username,
      key: '{username} removed passkey “{nickname}”',
      params: { username: actor.username, nickname: c.nickname },
      metadata: { credential: c.id },
    });
    return { ok: true };
  });
}

// ───────────────────────── recovery codes ─────────────────────────

/**
 * New set of 10 single-use codes, shown ONCE (the only response that ever contains them), stored
 * argon2id-hashed. Replacing an existing confirmed set needs the full step-up (password + passkey);
 * the first set, during enrollment, needs the recently confirmed password only.
 */
export async function generateRecoveryCodes(ctx: Ctx, actor: Actor) {
  const [u] = await ctx.db.select({ gen: t.users.recoveryCodesGeneratedAt, ack: t.users.recoveryCodesAcknowledgedAt }).from(t.users).where(eq(t.users.id, actor.userId));
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  const replacing = !!u?.ack;
  if (!f.password || (replacing && f.hasPasskey && !f.passkey)) throw reauthRequired(f);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const hashes = await Promise.all(codes.map((c) => hashPassword(c)));
  const now = new Date();
  await ctx.db.transaction(async (tx) => {
    await tx.update(t.recoveryCodes).set({ invalidatedAt: now }).where(and(eq(t.recoveryCodes.userId, actor.userId), isNull(t.recoveryCodes.usedAt), isNull(t.recoveryCodes.invalidatedAt)));
    await tx.insert(t.recoveryCodes).values(hashes.map((h) => ({ userId: actor.userId, codeHash: h, generatedAt: now })));
    await tx.update(t.users).set({ recoveryCodesGeneratedAt: now, recoveryCodesAcknowledgedAt: null }).where(eq(t.users.id, actor.userId));
    await writeAudit(tx, actor, {
      action: 'RECOVERY_CODES_GENERATED',
      entityType: 'user',
      entityId: actor.username,
      key: replacing ? '{username} replaced their recovery codes (the old ones no longer work)' : '{username} generated recovery codes',
      params: { username: actor.username },
    });
  });
  return { codes, generatedAt: now };
}

export async function acknowledgeRecoveryCodes(ctx: Ctx, actor: Actor) {
  const [u] = await ctx.db.select({ gen: t.users.recoveryCodesGeneratedAt }).from(t.users).where(eq(t.users.id, actor.userId));
  if (!u?.gen) throw badRequest('Generate your recovery codes first');
  await ctx.db.transaction(async (tx) => {
    await tx.update(t.users).set({ recoveryCodesAcknowledgedAt: new Date() }).where(eq(t.users.id, actor.userId));
    await writeAudit(tx, actor, { action: 'RECOVERY_CODES_ACKNOWLEDGED', entityType: 'user', entityId: actor.username, key: '{username} confirmed saving the recovery codes', params: { username: actor.username } });
  });
  return { ok: true };
}

// ───────────────────────── recent sign-ins, new-device alert ─────────────────────────

export async function recentSignIns(ctx: Ctx, actor: Actor) {
  return ctx.db
    .select({
      id: t.signInEvents.id,
      at: t.signInEvents.at,
      method: t.signInEvents.method,
      credentialNickname: t.signInEvents.credentialNickname,
      browser: t.signInEvents.browser,
      ipApprox: t.signInEvents.ipApprox,
      uv: t.signInEvents.uv,
      newDevice: t.signInEvents.newDevice,
    })
    .from(t.signInEvents)
    .where(eq(t.signInEvents.userId, actor.userId))
    .orderBy(desc(t.signInEvents.at), desc(t.signInEvents.id))
    .limit(10);
}

/** The latest undismissed new-device sign-in of the last 30 days (own account). */
export async function newDeviceAlert(exec: Executor, userId: number) {
  const [e] = await exec
    .select({ id: t.signInEvents.id, at: t.signInEvents.at, browser: t.signInEvents.browser, credentialNickname: t.signInEvents.credentialNickname, ipApprox: t.signInEvents.ipApprox, method: t.signInEvents.method })
    .from(t.signInEvents)
    .where(and(eq(t.signInEvents.userId, userId), eq(t.signInEvents.newDevice, true), isNull(t.signInEvents.dismissedAt), gt(t.signInEvents.at, new Date(Date.now() - 30 * 86_400_000))))
    .orderBy(desc(t.signInEvents.at))
    .limit(1);
  return e ?? null;
}

export async function dismissSignInAlert(ctx: Ctx, actor: Actor, id: number) {
  return ctx.db.transaction(async (tx) => {
    const done = await tx
      .update(t.signInEvents)
      .set({ dismissedAt: new Date() })
      .where(and(eq(t.signInEvents.id, id), eq(t.signInEvents.userId, actor.userId), isNull(t.signInEvents.dismissedAt)))
      .returning({ id: t.signInEvents.id, browser: t.signInEvents.browser });
    if (!done.length) throw notFound('Sign-in');
    await writeAudit(tx, actor, {
      action: 'SIGN_IN_ALERT_DISMISSED',
      entityType: 'user',
      entityId: actor.username,
      key: '{username} confirmed a sign-in from a new device ({browser}) was theirs',
      params: { username: actor.username, browser: done[0].browser ?? '—' },
    });
    return { ok: true };
  });
}

/**
 * "This wasn't me" (D-2fa-10, D-2fa-13). In every case: end every session of the user, revoke all
 * their passkeys and force a new password.
 * - Reported sign-in used a PASSKEY: the confirmed recovery codes stay valid — they are how the real
 *   owner gets back in (a password thief alone cannot pass the second step).
 * - Reported sign-in used a RECOVERY CODE: the code sheet is compromised. Every remaining code is
 *   invalidated and the account is SECURITY-LOCKED: every sign-in is refused (as a wrong password)
 *   until the operator console lifts the lock (`unlock-security-lock`).
 */
export async function notMe(ctx: Ctx, actor: Actor, id: number) {
  return ctx.db.transaction(async (tx) => {
    await tx.select({ id: t.users.id }).from(t.users).where(eq(t.users.id, actor.userId)).for('update');
    const [e] = await tx.select().from(t.signInEvents).where(and(eq(t.signInEvents.id, id), eq(t.signInEvents.userId, actor.userId)));
    if (!e) throw notFound('Sign-in');
    const now = new Date();
    const codeSheetCompromised = e.method === 'RECOVERY_CODE';
    await tx.update(t.signInEvents).set({ dismissedAt: now }).where(and(eq(t.signInEvents.userId, actor.userId), isNull(t.signInEvents.dismissedAt)));
    const revoked = await tx
      .update(t.webauthnCredentials)
      .set({ revokedAt: now, revokedReason: '“This wasn’t me” reported by the user' })
      .where(and(eq(t.webauthnCredentials.userId, actor.userId), isNull(t.webauthnCredentials.revokedAt)))
      .returning({ id: t.webauthnCredentials.id });
    let codesInvalidated = 0;
    if (codeSheetCompromised) {
      codesInvalidated = (
        await tx
          .update(t.recoveryCodes)
          .set({ invalidatedAt: now })
          .where(and(eq(t.recoveryCodes.userId, actor.userId), isNull(t.recoveryCodes.usedAt), isNull(t.recoveryCodes.invalidatedAt)))
          .returning({ id: t.recoveryCodes.id })
      ).length;
      await tx.delete(t.loginPending).where(eq(t.loginPending.userId, actor.userId));
    }
    await tx
      .update(t.users)
      .set({
        mustChangePassword: true,
        ...(codeSheetCompromised ? { securityLockedAt: now, securityLockReason: 'A sign-in with a recovery code was reported as not the user (“This wasn’t me”)' } : {}),
      })
      .where(eq(t.users.id, actor.userId));
    await endUserSessions(tx, actor.userId, 'Reported as not the user (“This wasn’t me”)');
    await writeAudit(tx, actor, {
      action: 'ACCOUNT_SECURED',
      entityType: 'user',
      entityId: actor.username,
      key: codeSheetCompromised
        ? '{username} reported a recovery-code sign-in as not theirs: account security-locked until the operator restores it, all sessions ended, {n} passkey(s) revoked, {codes} recovery code(s) invalidated'
        : '{username} reported a sign-in as not theirs: all sessions ended, {n} passkey(s) revoked, new password required',
      params: { username: actor.username, n: revoked.length, ...(codeSheetCompromised ? { codes: codesInvalidated } : {}) },
      metadata: { signIn: e.id, method: e.method, browser: e.browser, ipApprox: e.ipApprox, securityLocked: codeSheetCompromised },
    });
    return { ok: true, revoked: revoked.length, securityLocked: codeSheetCompromised, recoveryCodesInvalidated: codesInvalidated };
  });
}

// ───────────────────────── second-factor policy (guarded settings) ─────────────────────────

/**
 * Change security.webauthnUserVerification and/or security.twoFactorRequiredRoles. Needs the full
 * step-up: the password AND a passkey assertion within the window — so the changer must have a
 * passkey. Switching to "required" is refused unless that confirming assertion proved user
 * verification: a General Manager can never lock himself out with a key that cannot verify him.
 */
export async function updateSecondFactorPolicy(ctx: Ctx, actor: Actor, input: { userVerification?: WebauthnUv; requiredRoles?: TwoFactorRole[]; reason?: string }) {
  const f = await freshFactors(ctx, ctx.db, actor.sessionId, actor.userId);
  if (!f.hasPasskey) throw badRequest('Register a passkey for your own account before changing the second-factor rules');
  if (!f.password || !f.passkey) throw reauthRequired(f);
  const current = (await ctx.settings.get()).security;
  if (input.userVerification === 'required' && current.webauthnUserVerification !== 'required' && !f.passkeyUv) {
    throw badRequest('Your passkey did not verify you with a fingerprint, face or PIN: switching to “required” would lock you out. Confirm with a device that verifies you (Windows Hello, a phone, or a key with a PIN).');
  }
  const changes: Record<string, unknown> = {};
  if (input.userVerification) changes['security.webauthnUserVerification'] = input.userVerification;
  if (input.requiredRoles) changes['security.twoFactorRequiredRoles'] = input.requiredRoles;
  if (!Object.keys(changes).length) throw badRequest('Nothing to change');
  return ctx.db.transaction(async (tx) => {
    const { settings, changed } = await ctx.settings.apply(tx, changes, { actor: { id: actor.userId, username: actor.username }, reason: input.reason, allowGuarded: true });
    for (const c of changed) {
      await writeAudit(tx, actor, {
        action: 'SECURITY_SETTING_CHANGED',
        entityType: 'setting',
        entityId: c.key,
        key: '{username} changed {setting} from {from} to {to} (confirmed with password and passkey)',
        params: { username: actor.username, setting: c.key, from: JSON.stringify(c.from), to: JSON.stringify(c.to) },
        metadata: { passkeyUv: f.passkeyUv },
      });
    }
    return { userVerification: settings.security.webauthnUserVerification, requiredRoles: settings.security.twoFactorRequiredRoles, changed: changed.map((c) => c.key) };
  });
}

/**
 * First start only (D-2fa-4): when a guarded setting has never been stored, store the operator's
 * initial value from the environment (WEBAUTHN_UV_INITIAL, TWO_FACTOR_REQUIRED_ROLES_INITIAL).
 * Once a row exists the database is authoritative and the environment is ignored.
 */
export async function applyInitialSecuritySettings(ctx: Ctx, init: { uv?: string; roles?: string }) {
  const rows = await ctx.db.select({ key: t.settings.key }).from(t.settings).where(inArray(t.settings.key, ['security.webauthnUserVerification', 'security.twoFactorRequiredRoles']));
  const have = new Set(rows.map((r) => r.key));
  const changes: Record<string, unknown> = {};
  if (init.uv && !have.has('security.webauthnUserVerification')) changes['security.webauthnUserVerification'] = init.uv;
  if (init.roles !== undefined && !have.has('security.twoFactorRequiredRoles')) {
    changes['security.twoFactorRequiredRoles'] = init.roles.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (!Object.keys(changes).length) return [];
  return ctx.db.transaction(async (tx) => {
    const { changed } = await ctx.settings.apply(tx, changes, { actor: { id: null, username: 'system (first start)' }, reason: 'Initial value from the environment (first start)', allowGuarded: true });
    for (const c of Object.keys(changes)) {
      await writeAudit(tx, null, {
        action: 'SECURITY_SETTING_CHANGED',
        entityType: 'setting',
        entityId: c,
        key: 'First start: {setting} set to {to} from the environment',
        params: { setting: c, to: JSON.stringify(changes[c]) },
      });
    }
    return changed;
  });
}

// ───────────────────────── /auth/me summary ─────────────────────────

export async function secondFactorSummary(ctx: Ctx, actor: Actor) {
  const { security } = await ctx.settings.get();
  const f = await factorState(ctx.db, actor.userId, actor.roleCode, security);
  const [s] = actor.sessionId ? await ctx.db.select({ m: t.sessions.signInMethod }).from(t.sessions).where(eq(t.sessions.id, actor.sessionId)) : [];
  const alert = f.required || f.credentials > 0 ? await newDeviceAlert(ctx.db, actor.userId) : null;
  return {
    required: f.required,
    enrollmentRequired: f.enrollmentRequired,
    passkeys: f.credentials,
    recoveryCodesRemaining: f.recoveryRemaining,
    recoveryCodesAcknowledged: f.recoveryAcknowledged,
    userVerification: security.webauthnUserVerification,
    requiredRoles: security.twoFactorRequiredRoles,
    signInMethod: (s?.m ?? 'PASSWORD') as SignInMethod,
    newDeviceAlert: alert,
  };
}

/** Housekeeping: remove pending sign-ins and challenges that expired over an hour ago (they grant nothing). */
export async function purgeExpiredSecondFactorState(exec: Executor): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60_000);
  await exec.delete(t.loginPending).where(lt(t.loginPending.expiresAt, cutoff));
  await exec.delete(t.webauthnChallenges).where(lt(t.webauthnChallenges.expiresAt, cutoff));
}
