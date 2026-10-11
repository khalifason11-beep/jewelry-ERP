// Server-side sessions: the basis for authentication, "Active Users" monitoring and revocation.
// Monitoring is transparent: users can see their own session; admins see sessions in scope.

import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import type { Permission, SessionPresence } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { forbidden, notFound } from '../../core/errors';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Short, non-sensitive session reference for display (never the token). */
export const sessionRef = (id: string) => `S-${id.slice(0, 8).toUpperCase()}`;

export function describeDevice(ua: string | undefined | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /node|supertest|undici/i.test(ua)
              ? 'API client'
              : 'Browser';
  const os = /iPad/.test(ua)
    ? 'iPadOS'
    : /iPhone/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return os ? `${browser} on ${os}` : browser;
}

export async function createSession(
  exec: Executor,
  input: { userId: number; branchId: number | null; userAgent?: string; ip?: string; absoluteHours: number; at?: Date },
): Promise<{ token: string; id: string; csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const id = hashToken(token);
  const at = input.at ?? new Date();
  await exec.insert(t.sessions).values({
    id,
    userId: input.userId,
    branchId: input.branchId,
    userAgent: input.userAgent?.slice(0, 400) ?? null,
    device: describeDevice(input.userAgent),
    ipAddress: input.ip ?? null,
    currentModule: 'login',
    loginAt: at,
    lastActivityAt: at,
    absoluteExpiresAt: new Date(at.getTime() + input.absoluteHours * 3600_000),
    csrfToken,
  });
  return { token, id, csrfToken };
}

export async function loadActor(exec: Executor, userId: number, sessionId: string | null): Promise<Actor | null> {
  const [u] = await exec
    .select({
      id: t.users.id,
      username: t.users.username,
      fullName: t.users.fullName,
      fullNameAr: t.users.fullNameAr,
      status: t.users.status,
      branchId: t.users.branchId,
      roleId: t.roles.id,
      roleCode: t.roles.code,
      roleName: t.roles.name,
      roleRank: t.roles.rank,
      branchCode: t.branches.code,
      branchName: t.branches.name,
    })
    .from(t.users)
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .leftJoin(t.branches, eq(t.branches.id, t.users.branchId))
    .where(eq(t.users.id, userId));
  if (!u || u.status !== 'ACTIVE') return null;
  const perms = await exec
    .select({ code: t.rolePermissions.permissionCode })
    .from(t.rolePermissions)
    .where(eq(t.rolePermissions.roleId, u.roleId));
  return {
    userId: u.id,
    username: u.username,
    fullName: u.fullName,
    fullNameAr: u.fullNameAr,
    roleCode: u.roleCode,
    roleName: u.roleName,
    roleRank: u.roleRank,
    branchId: u.branchId,
    branchCode: u.branchCode,
    branchName: u.branchName,
    permissions: new Set(perms.map((p) => p.code as Permission)),
    sessionId,
  };
}

export async function resolveSession(ctx: Ctx, token: string) {
  const id = hashToken(token);
  const [s] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, id));
  if (!s || s.status !== 'ACTIVE') return null;
  const { security } = await ctx.settings.get();
  const now = Date.now();
  const absolute = s.absoluteExpiresAt?.getTime() ?? s.loginAt.getTime() + security.sessionAbsoluteHours * 3600_000;
  if (now >= absolute) {
    await endSession(ctx.db, id, 'EXPIRED', 'Absolute session limit');
    return null;
  }
  const actor = await loadActor(ctx.db, s.userId, s.id);
  if (!actor) {
    await endSession(ctx.db, id, 'REVOKED', 'Account disabled');
    return null;
  }
  if (now - s.lastActivityAt.getTime() > security.idleMinutes * 60_000) {
    await endSession(ctx.db, id, 'EXPIRED', 'Inactivity timeout');
    return null;
  }
  return { session: s, actor };
}

/**
 * Record activity (throttled) and the module the user is currently in.
 * `idleMs` = milliseconds since the user's last real input, reported by the browser; background
 * polling therefore never keeps an unattended terminal signed in (docs/decisions.md D-1a-5).
 */
export async function touchSession(ctx: Ctx, s: typeof t.sessions.$inferSelect, module?: string, idleMs = 0) {
  const activityAt = Date.now() - Math.min(Math.max(0, idleMs), 24 * 3600_000);
  const advanced = activityAt - s.lastActivityAt.getTime() > 15_000;
  const moved = module && module !== s.currentModule;
  if (!advanced && !moved) return;
  await ctx.db
    .update(t.sessions)
    .set({ ...(advanced ? { lastActivityAt: new Date(activityAt) } : {}), ...(module ? { currentModule: module.slice(0, 60) } : {}) })
    .where(eq(t.sessions.id, s.id));
}

/** Mark a successful password re-authentication on this session. */
export async function markReauthenticated(exec: Executor, sessionId: string, at = new Date()) {
  await exec.update(t.sessions).set({ reauthAt: at }).where(eq(t.sessions.id, sessionId));
}

/** CSRF token of a live session (created lazily for sessions opened before migration 0002). */
export async function csrfTokenFor(exec: Executor, sessionId: string): Promise<string | null> {
  const [s] = await exec.select({ token: t.sessions.csrfToken, status: t.sessions.status }).from(t.sessions).where(eq(t.sessions.id, sessionId));
  if (!s || s.status !== 'ACTIVE') return null;
  if (s.token) return s.token;
  const token = randomBytes(24).toString('base64url');
  await exec.update(t.sessions).set({ csrfToken: token }).where(and(eq(t.sessions.id, sessionId), isNull(t.sessions.csrfToken)));
  const [again] = await exec.select({ token: t.sessions.csrfToken }).from(t.sessions).where(eq(t.sessions.id, sessionId));
  return again?.token ?? null;
}

export async function endSession(exec: Executor, id: string, status: 'LOGGED_OUT' | 'EXPIRED' | 'REVOKED', reason: string) {
  await exec
    .update(t.sessions)
    .set({ status, endedAt: new Date(), endedReason: reason })
    .where(and(eq(t.sessions.id, id), eq(t.sessions.status, 'ACTIVE')));
}

function presence(s: { status: string; lastActivityAt: Date }, idleMinutes: number): SessionPresence {
  if (s.status !== 'ACTIVE') return 'ENDED';
  return Date.now() - s.lastActivityAt.getTime() > idleMinutes * 60_000 ? 'IDLE' : 'ACTIVE';
}

export async function listSessions(
  ctx: Ctx,
  actor: Actor,
  q: { scope: 'active' | 'recent'; branchId?: number | null; mine?: boolean },
) {
  const mine = q.mine || !actor.permissions.has('sessions.view');
  if (mine) requireAny(actor, 'sessions.view_own', 'sessions.view');
  const where = [];
  if (mine) where.push(eq(t.sessions.userId, actor.userId));
  else {
    const scope = branchScope(actor, q.branchId);
    if (scope != null) where.push(eq(t.users.branchId, scope));
  }
  if (q.scope === 'active') where.push(eq(t.sessions.status, 'ACTIVE'));
  else where.push(or(eq(t.sessions.status, 'ACTIVE'), gte(t.sessions.loginAt, new Date(Date.now() - 7 * 86400_000)))!);

  const { security } = await ctx.settings.get();
  const rowsAll = await ctx.db
    .select({
      id: t.sessions.id,
      userId: t.users.id,
      username: t.users.username,
      fullName: t.users.fullName,
      roleCode: t.roles.code,
      roleName: t.roles.name,
      branchId: t.users.branchId,
      branchName: t.branches.name,
      loginAt: t.sessions.loginAt,
      lastActivityAt: t.sessions.lastActivityAt,
      device: t.sessions.device,
      userAgent: t.sessions.userAgent,
      ipAddress: t.sessions.ipAddress,
      currentModule: t.sessions.currentModule,
      status: t.sessions.status,
      endedAt: t.sessions.endedAt,
      endedReason: t.sessions.endedReason,
    })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .leftJoin(t.branches, eq(t.branches.id, t.users.branchId))
    .where(and(...where))
    .orderBy(desc(t.sessions.lastActivityAt))
    .limit(300);

  // Flag accounts with more than one live session (possible credential sharing).
  const liveCount = new Map<number, number>();
  for (const r of rowsAll) if (r.status === 'ACTIVE') liveCount.set(r.userId, (liveCount.get(r.userId) ?? 0) + 1);

  return rowsAll.map(({ id, ...r }) => ({
    ...r,
    ref: sessionRef(id),
    key: id.slice(0, 16),
    isCurrent: id === actor.sessionId,
    presence: presence(r, security.sessionIdleMinutes),
    concurrentSessions: r.status === 'ACTIVE' ? (liveCount.get(r.userId) ?? 1) : 0,
  }));
}

export async function revokeSession(ctx: Ctx, actor: Actor, key: string) {
  requirePerm(actor, 'sessions.revoke');
  // `key` is the 16-hex-char prefix shown in the sessions list; match it exactly (never LIKE).
  if (!/^[0-9a-f]{16}$/.test(key)) throw notFound('Session');
  const [s] = await ctx.db
    .select({ id: t.sessions.id, userId: t.sessions.userId, status: t.sessions.status, username: t.users.username, branchId: t.users.branchId, rank: t.roles.rank })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .where(sql`left(${t.sessions.id}, 16) = ${key}`);
  if (!s) throw notFound('Session');
  if (s.branchId != null) branchScope(actor, s.branchId);
  if (s.id === actor.sessionId) throw forbidden('Use Sign out to end your own session');
  if (s.rank >= actor.roleRank && s.userId !== actor.userId) throw forbidden('Cannot terminate sessions of an equal or higher role');
  await ctx.db.transaction(async (tx) => {
    await endSession(tx, s.id, 'REVOKED', `Terminated by ${actor.username}`);
    await writeAudit(tx, actor, {
      action: 'SESSION_REVOKED',
      entityType: 'session',
      entityId: sessionRef(s.id),
      key: 'Terminated session {session} of {username}',
      params: { session: sessionRef(s.id), username: s.username },
      branchId: s.branchId,
    });
  });
}

/** End all live sessions of a user (on disable / password reset). */
export async function endUserSessions(exec: Executor, userId: number, reason: string) {
  await exec
    .update(t.sessions)
    .set({ status: 'REVOKED', endedAt: new Date(), endedReason: reason })
    .where(and(eq(t.sessions.userId, userId), inArray(t.sessions.status, ['ACTIVE'])));
}
