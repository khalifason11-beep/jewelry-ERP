// Branch administration (General Manager). The branch code is chosen once at creation and never
// changes (it is part of every document number); the database enforces
// this with a trigger as well. Every change is audited and requires a recent re-authentication
// (route matrix).

import { and, eq, ne } from 'drizzle-orm';
import { t } from '@jerp/database';
import { ap } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { conflict, notFound } from '../../core/errors';

export interface BranchInput {
  code: string;
  name: string;
  nameAr: string;
  city: string;
  address?: string | null;
  phone?: string | null;
}

export type BranchPatch = Partial<Omit<BranchInput, 'code'>> & { isActive?: boolean };

export async function createBranch(ctx: Ctx, actor: Actor, input: BranchInput) {
  requirePerm(actor, 'branches.manage');
  return ctx.db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: t.branches.id }).from(t.branches).where(eq(t.branches.code, input.code));
    if (dup) throw conflict('Branch code {code} is already used', { code: input.code });
    const [b] = await tx
      .insert(t.branches)
      .values({ code: input.code, name: input.name, nameAr: input.nameAr, city: input.city, address: input.address ?? null, phone: input.phone ?? null })
      .returning();
    await writeAudit(tx, actor, {
      action: 'BRANCH_CREATED',
      entityType: 'branch',
      entityId: b.code,
      branchId: b.id,
      key: 'Branch {code} created: {name}',
      params: { code: b.code, name: ap.text(b.name, b.nameAr) },
    });
    return b;
  });
}

export async function updateBranch(ctx: Ctx, actor: Actor, id: number, patch: BranchPatch) {
  requirePerm(actor, 'branches.manage');
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.branches).where(eq(t.branches.id, id)).for('update');
    if (!before) throw notFound('Branch');
    const changes: (keyof BranchPatch)[] = [];
    for (const k of Object.keys(patch) as (keyof BranchPatch)[]) {
      if (patch[k] !== undefined && patch[k] !== before[k]) changes.push(k);
    }
    if (!changes.length) return before;
    if (patch.name) {
      const [dup] = await tx.select({ id: t.branches.id }).from(t.branches).where(and(eq(t.branches.name, patch.name), ne(t.branches.id, id)));
      if (dup) throw conflict('Another branch already uses this name');
    }
    const [after] = await tx.update(t.branches).set(patch).where(eq(t.branches.id, id)).returning();
    await writeAudit(tx, actor, {
      action: 'BRANCH_UPDATED',
      entityType: 'branch',
      entityId: after.code,
      branchId: after.id,
      key: 'Branch {code} updated: {fields}',
      params: { code: after.code, fields: changes.join(', ') },
      metadata: { before: Object.fromEntries(changes.map((k) => [k, before[k]])), after: Object.fromEntries(changes.map((k) => [k, after[k]])) },
    });
    return after;
  });
}
