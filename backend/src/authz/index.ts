// Authorization & data isolation — enforced here, in the business layer, for every call.
// The UI hides what a user cannot do, but hiding is never the control.

import type { Permission } from '@jerp/shared';
import type { Actor } from '../core/context';
import { forbidden } from '../core/errors';

export function can(actor: Actor, perm: Permission): boolean {
  return actor.permissions.has(perm);
}

export function requirePerm(actor: Actor, ...perms: Permission[]): void {
  for (const p of perms) if (!actor.permissions.has(p)) throw forbidden('Missing permission: {permission}', { permission: p });
}

export function requireAny(actor: Actor, ...perms: Permission[]): void {
  if (!perms.some((p) => actor.permissions.has(p))) throw forbidden('Requires one of: {permissions}', { permissions: perms.join(', ') });
}

export function isGlobal(actor: Actor): boolean {
  return actor.permissions.has('scope.all_branches');
}

/**
 * Resolve which branch(es) a query may touch.
 * Returns a branch id, or `null` meaning "all branches" (global users only).
 * A branch-bound user asking for another branch gets 403 — never silently other data.
 */
export function branchScope(actor: Actor, requested?: number | null): number | null {
  if (isGlobal(actor)) return requested ?? null;
  if (actor.branchId == null) throw forbidden('Your account is not assigned to a branch');
  if (requested != null && requested !== actor.branchId) {
    throw forbidden('You can only access data of your own branch');
  }
  return actor.branchId;
}

export function assertBranchAccess(actor: Actor, branchId: number): void {
  branchScope(actor, branchId);
}
