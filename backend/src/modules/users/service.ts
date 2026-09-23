// User administration with centralized password control.
// Passwords can be RESET (a one-time temporary password is returned once), never retrieved.

import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { generateTemporaryPassword, hashPassword } from '../../auth/password';
import { endUserSessions } from '../sessions/service';

export async function listRoles(ctx: Ctx) {
  const roles = await ctx.db.select().from(t.roles).orderBy(asc(t.roles.rank));
  const perms = await ctx.db.select().from(t.rolePermissions);
  return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permissionCode) }));
}

export async function listUsers(ctx: Ctx, actor: Actor, q: { branchId?: number } = {}) {
  requirePerm(actor, 'users.view');
  const scope = branchScope(actor, q.branchId);
  const where: SQL[] = [];
  if (scope != null) where.push(eq(t.users.branchId, scope));
  return ctx.db
    .select({
      id: t.users.id,
      username: t.users.username,
      fullName: t.users.fullName,
      fullNameAr: t.users.fullNameAr,
      phone: t.users.phone,
      roleCode: t.roles.code,
      roleName: t.roles.name,
      roleRank: t.roles.rank,
      branchId: t.users.branchId,
      branchName: t.branches.name,
      status: t.users.status,
      mustChangePassword: t.users.mustChangePassword,
      passwordChangedAt: t.users.passwordChangedAt,
      lastLoginAt: t.users.lastLoginAt,
      createdAt: t.users.createdAt,
      activeSessions: sql<number>`(select count(*) from sessions s where s.user_id = ${t.users.id} and s.status = 'ACTIVE')`,
    })
    .from(t.users)
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .leftJoin(t.branches, eq(t.branches.id, t.users.branchId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(t.roles.rank), asc(t.branches.id), asc(t.users.username));
}

async function resolveRole(ctx: Ctx, actor: Actor, roleCode: string) {
  const [role] = await ctx.db.select().from(t.roles).where(eq(t.roles.code, roleCode));
  if (!role) throw badRequest('Unknown role');
  if (role.rank > actor.roleRank) throw forbidden('You cannot assign a role above your own');
  const [global] = await ctx.db
    .select()
    .from(t.rolePermissions)
    .where(and(eq(t.rolePermissions.roleId, role.id), eq(t.rolePermissions.permissionCode, 'scope.all_branches')));
  return { role, global: !!global };
}

async function loadTarget(ctx: Ctx, actor: Actor, id: number) {
  const [u] = await ctx.db
    .select({ u: t.users, rank: t.roles.rank, roleCode: t.roles.code })
    .from(t.users)
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .where(eq(t.users.id, id));
  if (!u) throw notFound('User');
  if (u.u.id !== actor.userId && u.rank > actor.roleRank) throw forbidden('You cannot manage a user with a higher role');
  if (u.u.branchId != null) branchScope(actor, u.u.branchId);
  return u;
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  fullNameAr?: string;
  phone?: string;
  roleCode: string;
  branchId?: number | null;
  temporaryPassword?: string;
}

export async function createUser(ctx: Ctx, actor: Actor, input: CreateUserInput) {
  requirePerm(actor, 'users.manage');
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw badRequest('Username: 3–40 chars, letters, digits, dot, dash, underscore');
  const { role, global } = await resolveRole(ctx, actor, input.roleCode);
  const branchId = global ? null : (input.branchId ?? null);
  if (!global && branchId == null) throw badRequest('Branch roles must be assigned to a branch');
  if (branchId != null) branchScope(actor, branchId);
  const [exists] = await ctx.db.select({ id: t.users.id }).from(t.users).where(eq(t.users.username, username));
  if (exists) throw conflict('Username already exists');

  const { security } = await ctx.settings.get();
  const temp = input.temporaryPassword?.trim() || generateTemporaryPassword();
  if (temp.length < security.minPasswordLength) throw badRequest(`Password must be at least ${security.minPasswordLength} characters`);

  return ctx.db.transaction(async (tx) => {
    const [u] = await tx
      .insert(t.users)
      .values({
        username,
        fullName: input.fullName.trim(),
        fullNameAr: input.fullNameAr?.trim() || null,
        phone: input.phone?.trim() || null,
        roleId: role.id,
        branchId,
        passwordHash: await hashPassword(temp),
        mustChangePassword: true,
        createdBy: actor.userId,
      })
      .returning({ id: t.users.id, username: t.users.username });
    await writeAudit(tx, actor, {
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: username,
      branchId,
      description: `User ${username} (${input.fullName}) created as ${role.name}; must set a new password at first login`,
    });
    // The temporary password is returned exactly once so the admin can hand it over.
    return { id: u.id, username: u.username, temporaryPassword: temp };
  });
}

export async function updateUser(
  ctx: Ctx,
  actor: Actor,
  id: number,
  input: { fullName?: string; fullNameAr?: string; phone?: string; roleCode?: string; branchId?: number | null },
) {
  requirePerm(actor, 'users.manage');
  const target = await loadTarget(ctx, actor, id);
  const patch: Partial<typeof t.users.$inferInsert> = {};
  const changes: string[] = [];
  if (input.fullName && input.fullName !== target.u.fullName) {
    patch.fullName = input.fullName.trim();
    changes.push(`name → ${patch.fullName}`);
  }
  if (input.fullNameAr !== undefined) patch.fullNameAr = input.fullNameAr || null;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  let global = target.u.branchId == null;
  if (input.roleCode && input.roleCode !== target.roleCode) {
    if (id === actor.userId) throw forbidden('You cannot change your own role');
    const r = await resolveRole(ctx, actor, input.roleCode);
    patch.roleId = r.role.id;
    global = r.global;
    changes.push(`role → ${r.role.name}`);
  }
  if (input.branchId !== undefined || global) {
    const nextBranch = global ? null : (input.branchId ?? target.u.branchId);
    if (!global && nextBranch == null) throw badRequest('Branch roles must be assigned to a branch');
    if (nextBranch != null) branchScope(actor, nextBranch);
    if (nextBranch !== target.u.branchId) {
      patch.branchId = nextBranch;
      changes.push(`branch → ${nextBranch ?? 'all branches'}`);
    }
  }
  if (!Object.keys(patch).length) return { ok: true };
  await ctx.db.transaction(async (tx) => {
    await tx.update(t.users).set(patch).where(eq(t.users.id, id));
    if (patch.roleId || patch.branchId !== undefined) await endUserSessions(tx, id, 'Role or branch changed');
    await writeAudit(tx, actor, {
      action: 'USER_UPDATED',
      entityType: 'user',
      entityId: target.u.username,
      branchId: target.u.branchId,
      description: `User ${target.u.username} updated: ${changes.join(', ') || 'profile details'}`,
    });
  });
  return { ok: true };
}

export async function resetPassword(ctx: Ctx, actor: Actor, id: number) {
  requirePerm(actor, 'users.manage');
  const target = await loadTarget(ctx, actor, id);
  const temp = generateTemporaryPassword();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(t.users)
      .set({ passwordHash: await hashPassword(temp), mustChangePassword: true, passwordChangedAt: new Date() })
      .where(eq(t.users.id, id));
    await endUserSessions(tx, id, 'Password reset by administrator');
    await writeAudit(tx, actor, {
      action: 'PASSWORD_RESET',
      entityType: 'user',
      entityId: target.u.username,
      branchId: target.u.branchId,
      description: `Password of ${target.u.username} reset; user must choose a new password at next login. Existing sessions ended.`,
    });
  });
  return { username: target.u.username, temporaryPassword: temp };
}

export async function setUserStatus(ctx: Ctx, actor: Actor, id: number, status: 'ACTIVE' | 'DISABLED') {
  requirePerm(actor, 'users.manage');
  if (id === actor.userId) throw forbidden('You cannot disable your own account');
  const target = await loadTarget(ctx, actor, id);
  await ctx.db.transaction(async (tx) => {
    await tx.update(t.users).set({ status }).where(eq(t.users.id, id));
    if (status === 'DISABLED') await endUserSessions(tx, id, 'Account disabled');
    await writeAudit(tx, actor, {
      action: status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED',
      entityType: 'user',
      entityId: target.u.username,
      branchId: target.u.branchId,
      description: `Account ${target.u.username} ${status === 'DISABLED' ? 'disabled; active sessions terminated' : 're-enabled'}`,
    });
  });
  return { ok: true };
}
