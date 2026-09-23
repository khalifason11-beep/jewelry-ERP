import { eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { Actor, Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, forbidden } from '../../core/errors';
import { hashPassword, verifyPassword } from '../../auth/password';
import { createSession, endSession, loadActor, sessionRef } from '../sessions/service';

export async function login(ctx: Ctx, input: { username: string; password: string; userAgent?: string; ip?: string }) {
  const username = input.username.trim().toLowerCase();
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  const ok = u ? await verifyPassword(input.password, u.passwordHash) : false;
  if (!u || !ok) {
    await writeAudit(ctx.db, null, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: username,
      branchId: u?.branchId ?? null,
      description: `Failed login attempt for "${username}" from ${input.ip ?? 'unknown'}`,
    });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }
  if (u.status !== 'ACTIVE') {
    await writeAudit(ctx.db, null, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: username,
      branchId: u.branchId,
      description: `Login refused for disabled account "${username}"`,
    });
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your administrator.');
  }
  return ctx.db.transaction(async (tx) => {
    const s = await createSession(tx, { userId: u.id, branchId: u.branchId, userAgent: input.userAgent, ip: input.ip });
    await tx.update(t.users).set({ lastLoginAt: new Date() }).where(eq(t.users.id, u.id));
    const actor = (await loadActor(tx, u.id, s.id))!;
    actor.ip = input.ip;
    await writeAudit(tx, actor, {
      action: 'LOGIN',
      entityType: 'session',
      entityId: sessionRef(s.id),
      description: `${u.fullName} (${u.username}) signed in`,
    });
    return { ...s, actor };
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
      description: `${actor.fullName} (${actor.username}) signed out`,
    });
  });
}

export async function changePassword(ctx: Ctx, actor: Actor, input: { currentPassword: string; newPassword: string }) {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.id, actor.userId));
  const { security } = await ctx.settings.get();
  if (!u.mustChangePassword && !security.allowSelfPasswordChange) {
    throw forbidden('Passwords are managed centrally. Ask the General Manager to reset your password.');
  }
  if (!(await verifyPassword(input.currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect');
  if (input.newPassword.length < security.minPasswordLength) throw badRequest(`New password must be at least ${security.minPasswordLength} characters`);
  if (input.newPassword === input.currentPassword) throw badRequest('New password must differ from the current one');
  if (!/[A-Za-z]/.test(input.newPassword) || !/\d/.test(input.newPassword)) throw badRequest('Use letters and digits');
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(t.users)
      .set({ passwordHash: await hashPassword(input.newPassword), mustChangePassword: false, passwordChangedAt: new Date() })
      .where(eq(t.users.id, actor.userId));
    await writeAudit(tx, actor, {
      action: 'PASSWORD_CHANGED',
      entityType: 'user',
      entityId: actor.username,
      description: `${actor.username} set a new password${u.mustChangePassword ? ' (required after reset)' : ''}`,
    });
  });
  return { ok: true };
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
    company: settings.company,
    allowSelfPasswordChange: settings.security.allowSelfPasswordChange,
    maxDiscountPercent: settings.sales.maxDiscountPercentByRole[actor.roleCode] ?? 0,
    hasadMode: ctx.hasad.mode,
  };
}
