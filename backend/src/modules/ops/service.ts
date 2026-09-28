// Break-glass operations for the server operator (someone with shell access to the server).
// Needed because the General Manager is the only user who can unlock accounts or reset passwords:
// a locked-out or forgotten GM would otherwise have nobody to help. Every action is audited with
// the operator's host and OS user.

import { eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';
import { AppError, notFound } from '../../core/errors';
import { clearFailures } from '../../auth/lockout';
import { generateTemporaryPassword, hashPassword } from '../../auth/password';
import { endUserSessions } from '../sessions/service';

export interface OperatorInfo {
  host: string;
  osUser: string;
}

const ACTOR = 'operator-cli';

async function findUser(ctx: Ctx, username: string) {
  const [u] = await ctx.db
    .select({ id: t.users.id, username: t.users.username, branchId: t.users.branchId, roleCode: t.roles.code })
    .from(t.users)
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .where(eq(t.users.username, username.trim().toLowerCase()));
  if (!u) throw notFound('User');
  return u;
}

export async function operatorUnlock(ctx: Ctx, username: string, op: OperatorInfo) {
  const u = await findUser(ctx, username);
  await ctx.db.transaction(async (tx) => {
    await clearFailures(tx, u.id);
    await writeAudit(tx, null, {
      action: 'USER_UNLOCKED',
      entityType: 'user',
      entityId: u.username,
      branchId: u.branchId,
      systemActor: ACTOR,
      key: 'Operator console: sign-in lock of {username} lifted',
      params: { username: u.username },
      metadata: { ...op },
    });
  });
  return { username: u.username };
}

/** Issue a one-time password for a General Manager (must be changed at next sign-in). */
export async function operatorResetGmPassword(ctx: Ctx, username: string, op: OperatorInfo) {
  const u = await findUser(ctx, username);
  if (u.roleCode !== 'GENERAL_MANAGER') throw new AppError(400, 'NOT_A_GM', 'Only a General Manager password can be reset from the operator console');
  const temporaryPassword = generateTemporaryPassword();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(t.users)
      .set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null })
      .where(eq(t.users.id, u.id));
    await endUserSessions(tx, u.id, 'Password reset from operator console');
    await writeAudit(tx, null, {
      action: 'PASSWORD_RESET',
      entityType: 'user',
      entityId: u.username,
      branchId: null,
      systemActor: ACTOR,
      key: 'Operator console: password of {username} reset; sessions ended',
      params: { username: u.username },
      metadata: { ...op },
    });
  });
  return { username: u.username, temporaryPassword };
}
