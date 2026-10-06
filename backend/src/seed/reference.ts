// System reference data needed by every deployment (demo AND production): the permission catalogue, and the system roles with their default grants. No item types: their names come from the client (CAT-0).
// Idempotent: existing rows are left untouched, so it is safe to run on every bootstrap.

import { inArray } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLES, PERMISSIONS } from '@jerp/shared';

/** Relative privilege of the system roles (users can only manage lower ranks). */
export const ROLE_RANK = { CASHIER: 10, BRANCH_MANAGER: 50, GENERAL_MANAGER: 100 } as const;

export async function seedRolesAndPermissions(db: Executor): Promise<Record<string, number>> {
  await db
    .insert(t.permissions)
    .values(Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description })))
    .onConflictDoNothing();
  await db
    .insert(t.roles)
    .values(DEFAULT_ROLES.map((r) => ({ ...r, isSystem: true, rank: ROLE_RANK[r.code] })))
    .onConflictDoNothing();
  const roleRows = await db.select().from(t.roles).where(inArray(t.roles.code, DEFAULT_ROLES.map((r) => r.code)));
  const roleId = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));
  for (const r of DEFAULT_ROLES) {
    await db
      .insert(t.rolePermissions)
      .values(DEFAULT_ROLE_PERMISSIONS[r.code].map((p) => ({ roleId: roleId[r.code], permissionCode: p })))
      .onConflictDoNothing();
  }
  return roleId;
}
