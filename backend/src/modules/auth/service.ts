import { ap } from '@jerp/shared';
import { eq } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { config } from '../../config';
import type { Actor, Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, forbidden } from '../../core/errors';
import { log } from '../../core/logger';
import { burnVerification, hashPassword, needsRehash, verifyPassword } from '../../auth/password';
import { assertPasswordPolicy } from '../../auth/policy';
import { accountLocked, clearFailures, ipReserve, ipThrottled, reserveAttempt, type Reservation } from '../../auth/lockout';
import { publicBranding } from '../branding/service';
import { createSession, csrfTokenFor, endSession, endUserSessions, markReauthenticated, sessionRef } from '../sessions/service';
import { factorState } from '../../auth/second-factor';
import { createPending, openSession, secondFactorSummary, type SessionOpened } from './passkeys';

export interface LoginInput {
  username: string;
  password: string;
  userAgent?: string;
  ip?: string;
}

/** Username as typed, made safe for the audit log (L-1: never store arbitrary input verbatim). */
const auditableUsername = (u: string) => (/^[a-z0-9._-]{1,40}$/.test(u) ? u : '[invalid]');

/**
 * Sign in. Every failure — unknown username, locked account, wrong password — returns the SAME
 * response, writes the same audit entry and spends one password-hash verification, so responses
 * reveal neither which usernames exist nor which accounts are locked (M-2, D-1a-4, D-2a-12).
 * Attempts are reserved before the password is verified (D-2a-10): a burst of parallel guesses
 * gets at most `lockoutThreshold` real verifications per account and `IP_MAX_FAILURES` per IP.
 * On success a brand-new session (token + CSRF token) is created: session ids are never reused.
 */
export async function login(ctx: Ctx, input: LoginInput) {
  const username = input.username.trim().toLowerCase().slice(0, 64);
  const ip = input.ip ?? 'unknown';
  const { security } = await ctx.settings.get();
  const refused = async (branchId: number | null) => {
    await writeAudit(ctx.db, null, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: auditableUsername(username),
      branchId,
      key: 'Failed login attempt for “{username}” from {ip}',
      params: { username: auditableUsername(username), ip },
    });
    return invalidCredentials();
  };

  // Reserve an IP slot synchronously, before any await (refunded only on success).
  const refundIp = ipReserve(ip);
  if (!refundIp) {
    await burnVerification(input.password);
    log.warn('login throttled by IP', { ip });
    throw ipThrottled();
  }

  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  if (!u) {
    await burnVerification(input.password);
    throw await refused(null);
  }
  if (u.securityLockedAt) {
    // Security lock (D-2fa-13): refused whatever the credentials, nothing evaluated or counted, and
    // the same answer as a wrong password (no new enumeration channel). Only the operator lifts it.
    await burnVerification(input.password);
    throw await refused(u.branchId);
  }
  const r = await reserveAttempt(ctx.db, u.id, security);
  if (!r.allowed) {
    // Locked: not evaluated, not extended, and indistinguishable from an unknown username.
    await burnVerification(input.password);
    throw await refused(u.branchId);
  }
  if (!(await verifyPassword(input.password, u.passwordHash))) {
    await ctx.db.transaction(async (tx) => {
      if (r.lockedUntil) await auditLock(tx, u, r.failed, r.lockedUntil);
    });
    throw await refused(u.branchId);
  }
  refundIp();
  if (u.status !== 'ACTIVE') {
    await clearFailures(ctx.db, u.id);
    await writeAudit(ctx.db, null, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: username,
      branchId: u.branchId,
      key: 'Login refused for disabled account “{username}”',
      params: { username },
    });
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your administrator.');
  }
  const [role] = await ctx.db.select({ code: t.roles.code }).from(t.roles).where(eq(t.roles.id, u.roleId));
  return ctx.db.transaction(async (tx): Promise<LoginResult> => {
    await clearFailures(tx, u.id);
    // Upgrade legacy (scrypt) or outdated argon2 hashes while the plaintext is at hand.
    if (needsRehash(u.passwordHash)) await tx.update(t.users).set({ passwordHash: await hashPassword(input.password) }).where(eq(t.users.id, u.id));
    const factor = await factorState(tx, u.id, role.code, security);
    if (factor.secondStepAtLogin) {
      // Enrolled: the password only opens a pending sign-in (no route access); the passkey or a
      // recovery code completes it (D-2fa-5).
      const p = await createPending(tx, u.id, { userAgent: input.userAgent, ip });
      return { kind: 'PENDING', token: p.token, expiresAt: p.expiresAt };
    }
    // Not enrolled: a normal session. For a role that requires a second factor it is restricted to
    // enrollment, and the password just typed counts as confirmed for registering the first passkey.
    const s = await openSession(tx, ctx, u, { userAgent: input.userAgent, ip, method: 'PASSWORD', uv: null, reauthNow: factor.enrollmentRequired });
    return { kind: 'SESSION', ...s };
  });
}

export type LoginResult = ({ kind: 'SESSION' } & SessionOpened) | { kind: 'PENDING'; token: string; expiresAt: Date };

/** The one response for every failed sign-in (unknown user, locked account, wrong password). */
export const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Sign-in failed. Check your username and password. After several failed attempts, sign-in is paused for a while.');

async function auditLock(exec: Executor, u: { id: number; username: string; branchId: number | null }, failed: number, until: Date) {
  await writeAudit(exec, null, {
    action: 'ACCOUNT_LOCKED',
    entityType: 'user',
    entityId: u.username,
    branchId: u.branchId,
    key: 'Account {username} locked for {minutes} min after {n} failed attempts',
    params: { username: u.username, minutes: Math.round((until.getTime() - Date.now()) / 60_000), n: failed },
  });
}

/**
 * Password check for a signed-in user (re-auth, change password), with the same reserve-then-verify
 * protection as sign-in. A wrong password counts toward the lockout; if it locks the account, every
 * session of the user ends: an unattended terminal cannot be used to guess the password.
 */
async function checkPasswordWhileSignedIn(ctx: Ctx, actor: Actor, password: string, hash: string, action: 'REAUTH_FAILED' | 'LOGIN_FAILED'): Promise<boolean> {
  const { security } = await ctx.settings.get();
  const refundIp = ipReserve(actor.ip ?? 'unknown');
  if (!refundIp) throw ipThrottled();
  const r: Reservation = await reserveAttempt(ctx.db, actor.userId, security);
  if (!r.allowed) throw accountLocked();
  if (await verifyPassword(password, hash)) {
    refundIp();
    return true;
  }
  await ctx.db.transaction(async (tx) => {
    const [u] = await tx.select().from(t.users).where(eq(t.users.id, actor.userId));
    await writeAudit(tx, actor, {
      action,
      entityType: 'user',
      entityId: actor.username,
      key: action === 'REAUTH_FAILED' ? 'Password confirmation failed for {username}' : 'Failed login attempt for “{username}” from {ip}',
      params: { username: actor.username, ip: actor.ip ?? 'unknown' },
    });
    if (r.lockedUntil) {
      await auditLock(tx, u, r.failed, r.lockedUntil);
      await endUserSessions(tx, actor.userId, 'Account locked');
    }
  });
  return false;
}

export async function logout(ctx: Ctx, actor: Actor) {
  if (!actor.sessionId) return;
  await ctx.db.transaction(async (tx) => {
    await endSession(tx, actor.sessionId!, 'LOGGED_OUT', 'User signed out');
    await writeAudit(tx, actor, {
      action: 'LOGOUT',
      entityType: 'session',
      entityId: sessionRef(actor.sessionId!),
      key: '{name} ({username}) signed out',
      params: { name: ap.text(actor.fullName, actor.fullNameAr), username: actor.username },
    });
  });
}

/** Step-up authentication: confirms the password and opens the re-auth window on this session. */
export async function reauthenticate(ctx: Ctx, actor: Actor, password: string) {
  if (!actor.sessionId) throw forbidden();
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.id, actor.userId));
  if (!(await checkPasswordWhileSignedIn(ctx, actor, password, u.passwordHash, 'REAUTH_FAILED'))) {
    throw new AppError(403, 'REAUTH_FAILED', 'Password is incorrect');
  }
  await ctx.db.transaction(async (tx) => {
    await clearFailures(tx, actor.userId);
    await markReauthenticated(tx, actor.sessionId!);
    await writeAudit(tx, actor, {
      action: 'REAUTHENTICATED',
      entityType: 'session',
      entityId: sessionRef(actor.sessionId!),
      key: '{username} confirmed their password',
      params: { username: actor.username },
    });
  });
  return { ok: true, validForMinutes: (await ctx.settings.get()).security.reauthWindowMinutes };
}

/**
 * Change own password. All sessions of the user end and a fresh session is issued for the
 * current device (session rotation on credential change).
 */
export async function changePassword(ctx: Ctx, actor: Actor, input: { currentPassword: string; newPassword: string; userAgent?: string }) {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.id, actor.userId));
  const { security } = await ctx.settings.get();
  if (!u.mustChangePassword && !security.allowSelfPasswordChange) {
    throw forbidden('Passwords are managed centrally. Ask the General Manager to reset your password.');
  }
  if (!(await checkPasswordWhileSignedIn(ctx, actor, input.currentPassword, u.passwordHash, 'LOGIN_FAILED'))) {
    throw badRequest('Current password is incorrect');
  }
  if (input.newPassword === input.currentPassword) throw badRequest('New password must differ from the current one');
  assertPasswordPolicy(input.newPassword, { minLength: security.minPasswordLength, username: u.username });
  return ctx.db.transaction(async (tx) => {
    await tx
      .update(t.users)
      .set({ passwordHash: await hashPassword(input.newPassword), mustChangePassword: false, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null })
      .where(eq(t.users.id, actor.userId));
    await endUserSessions(tx, actor.userId, 'Password changed');
    const s = await createSession(tx, { userId: u.id, branchId: u.branchId, userAgent: input.userAgent, ip: actor.ip, absoluteHours: security.sessionAbsoluteHours });
    await writeAudit(tx, actor, {
      action: 'PASSWORD_CHANGED',
      entityType: 'user',
      entityId: actor.username,
      key: u.mustChangePassword ? '{username} set a new password (required after reset)' : '{username} set a new password',
      params: { username: actor.username },
    });
    return { ok: true, token: s.token, sessionId: s.id };
  });
}

export async function me(ctx: Ctx, actor: Actor) {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.id, actor.userId));
  const [role] = await ctx.db.select().from(t.roles).where(eq(t.roles.code, actor.roleCode));
  const branch = actor.branchId
    ? (await ctx.db.select().from(t.branches).where(eq(t.branches.id, actor.branchId)))[0]
    : null;
  const [session] = actor.sessionId ? await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, actor.sessionId)) : [];
  const settings = await ctx.settings.get();
  return {
    user: {
      id: u.id,
      username: u.username,
      fullName: u.fullName,
      fullNameAr: u.fullNameAr,
      mustChangePassword: u.mustChangePassword,
      role: { code: role.code, name: role.name, nameAr: role.nameAr },
      branch: branch ? { id: branch.id, code: branch.code, name: branch.name, nameAr: branch.nameAr } : null,
      permissions: [...actor.permissions].sort(),
    },
    session: session
      ? { ref: sessionRef(session.id), loginAt: session.loginAt, device: session.device, ipAddress: session.ipAddress }
      : null,
    branding: publicBranding(settings),
    timezone: settings.company.timezone,
    appMode: config.appMode,
    csrfToken: actor.sessionId ? await csrfTokenFor(ctx.db, actor.sessionId) : null,
    allowSelfPasswordChange: settings.security.allowSelfPasswordChange,
    maxDiscountPercent: settings.sales.maxDiscountPercentByRole[actor.roleCode] ?? 0,
    // Phase 2fa: second-factor state of this account (no secrets: counts, flags, the new-device alert).
    secondFactor: await secondFactorSummary(ctx, actor),
    // Phase 4: what the counter offers (D-4-6) and which karats are sold here (D-4-1).
    posPaymentMethods: settings.sales.posPaymentMethods,
    print: { invoiceFormat: settings.print.invoiceFormat, receiptWidthMm: settings.print.receiptWidthMm, autoPrintAfterSale: settings.print.autoPrintAfterSale },
    allowedKarats: settings.inventory.allowedKarats,
  };
}
