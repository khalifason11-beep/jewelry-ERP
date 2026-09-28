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
import { accountLocked, clearFailures, ghostFailure, ghostLocked, ipBlocked, ipFailure, ipThrottled, recordFailure } from '../../auth/lockout';
import { publicBranding } from '../branding/service';
import { createSession, csrfTokenFor, endSession, endUserSessions, loadActor, markReauthenticated, sessionRef } from '../sessions/service';

export interface LoginInput {
  username: string;
  password: string;
  userAgent?: string;
  ip?: string;
}

/** Username as typed, made safe for the audit log (L-1: never store arbitrary input verbatim). */
const auditableUsername = (u: string) => (/^[a-z0-9._-]{1,40}$/.test(u) ? u : '[invalid]');

/**
 * Sign in. Every failure path returns the same generic errors and spends the same hashing time,
 * so responses reveal neither which usernames exist nor which accounts are locked (M-2, D-1a-4).
 * On success a brand-new session (token + CSRF token) is created: session ids are never reused.
 */
export async function login(ctx: Ctx, input: LoginInput) {
  const username = input.username.trim().toLowerCase().slice(0, 64);
  const ip = input.ip ?? 'unknown';
  const { security } = await ctx.settings.get();
  const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  const auditFailure = (exec: Executor, branchId: number | null) =>
    writeAudit(exec, null, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: auditableUsername(username),
      branchId,
      key: 'Failed login attempt for “{username}” from {ip}',
      params: { username: auditableUsername(username), ip },
    });

  if (ipBlocked(ip)) {
    await burnVerification(input.password);
    log.warn('login throttled by IP', { ip });
    throw ipThrottled();
  }

  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  if (!u) {
    await burnVerification(input.password);
    if (ghostLocked(username)) throw accountLocked();
    ghostFailure(username, security);
    ipFailure(ip);
    await auditFailure(ctx.db, null);
    throw invalid();
  }
  if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) {
    // Attempts during a lock are not evaluated (and do not extend the lock).
    await burnVerification(input.password);
    throw accountLocked();
  }
  if (!(await verifyPassword(input.password, u.passwordHash))) {
    ipFailure(ip);
    await ctx.db.transaction(async (tx) => {
      const r = await recordFailure(tx, u.id, security);
      await auditFailure(tx, u.branchId);
      if (r.lockedUntil) await auditLock(tx, u, r.failed, r.lockedUntil);
    });
    throw invalid();
  }
  if (u.status !== 'ACTIVE') {
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
  return ctx.db.transaction(async (tx) => {
    await clearFailures(tx, u.id);
    // Upgrade legacy (scrypt) or outdated argon2 hashes while the plaintext is at hand.
    if (needsRehash(u.passwordHash)) await tx.update(t.users).set({ passwordHash: await hashPassword(input.password) }).where(eq(t.users.id, u.id));
    const s = await createSession(tx, { userId: u.id, branchId: u.branchId, userAgent: input.userAgent, ip, absoluteHours: security.sessionAbsoluteHours });
    await tx.update(t.users).set({ lastLoginAt: new Date() }).where(eq(t.users.id, u.id));
    const actor = (await loadActor(tx, u.id, s.id))!;
    actor.ip = ip;
    await writeAudit(tx, actor, {
      action: 'LOGIN',
      entityType: 'session',
      entityId: sessionRef(s.id),
      key: '{name} ({username}) signed in',
      params: { name: ap.text(u.fullName, u.fullNameAr), username: u.username },
    });
    return { ...s, actor };
  });
}

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
 * A wrong password typed by a signed-in user (re-auth, change password) counts toward the lockout.
 * If it locks the account, every session of the user ends: an unattended terminal cannot be used
 * to guess the password.
 */
async function wrongPasswordWhileSignedIn(ctx: Ctx, actor: Actor, action: 'REAUTH_FAILED' | 'LOGIN_FAILED') {
  const { security } = await ctx.settings.get();
  ipFailure(actor.ip ?? 'unknown');
  await ctx.db.transaction(async (tx) => {
    const [u] = await tx.select().from(t.users).where(eq(t.users.id, actor.userId));
    const r = await recordFailure(tx, actor.userId, security);
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
  if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) throw accountLocked();
  if (!(await verifyPassword(password, u.passwordHash))) {
    await wrongPasswordWhileSignedIn(ctx, actor, 'REAUTH_FAILED');
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
  if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) throw accountLocked();
  if (!(await verifyPassword(input.currentPassword, u.passwordHash))) {
    await wrongPasswordWhileSignedIn(ctx, actor, 'LOGIN_FAILED');
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
    hasadMode: ctx.hasad.mode,
  };
}
