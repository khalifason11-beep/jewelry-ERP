// One-time production bootstrap (security item 2, docs/decisions.md D-1a-3):
// reference data + optional branches + the first General Manager, who must change the generated
// one-time password at first sign-in. Refuses to run when a General Manager already exists.

import { and, eq, inArray } from 'drizzle-orm';
import { t } from '@jerp/database';
import { ap } from '@jerp/shared';
import type { Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest } from '../../core/errors';
import { generateTemporaryPassword, hashPassword } from '../../auth/password';
import { seedCategories, seedRolesAndPermissions } from '../../seed/reference';

export interface BootstrapBranch {
  code: string;
  name: string;
  nameAr: string;
  city: string;
}

export interface BootstrapInput {
  username: string;
  fullName: string;
  fullNameAr?: string;
  branches?: BootstrapBranch[];
}

/** Parses "CODE:Name:الاسم:City" (as given on the command line). */
export function parseBranchArg(arg: string): BootstrapBranch {
  const [code, name, nameAr, city] = arg.split(':').map((s) => s.trim());
  if (!code || !/^[A-Z]{2,6}$/.test(code) || !name || !nameAr || !city) {
    throw badRequest('Branch must be CODE:NameEn:NameAr:City with a 2–6 letter upper-case code');
  }
  return { code, name, nameAr, city };
}

export async function bootstrapProduction(ctx: Ctx, input: BootstrapInput): Promise<{ username: string; temporaryPassword: string; branches: string[] }> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw badRequest('Username: 3–40 chars, letters, digits, dot, dash, underscore');
  if (input.fullName.trim().length < 2) throw badRequest('Invalid value for {field}', { field: 'fullName' });

  return ctx.db.transaction(async (tx) => {
    const roleId = await seedRolesAndPermissions(tx);
    await seedCategories(tx);
    const [existingGm] = await tx
      .select({ id: t.users.id })
      .from(t.users)
      .where(and(eq(t.users.roleId, roleId.GENERAL_MANAGER)));
    if (existingGm) throw new AppError(409, 'ALREADY_BOOTSTRAPPED', 'A General Manager already exists; bootstrap refused');
    const [taken] = await tx.select({ id: t.users.id }).from(t.users).where(eq(t.users.username, username));
    if (taken) throw new AppError(409, 'CONFLICT', 'Username already exists');

    const created: string[] = [];
    if (input.branches?.length) {
      const codes = input.branches.map((b) => b.code);
      const exists = await tx.select({ code: t.branches.code }).from(t.branches).where(inArray(t.branches.code, codes));
      const skip = new Set(exists.map((e) => e.code));
      const fresh = input.branches.filter((b) => !skip.has(b.code));
      if (fresh.length) await tx.insert(t.branches).values(fresh);
      created.push(...fresh.map((b) => b.code));
    }

    const temporaryPassword = generateTemporaryPassword();
    const [gm] = await tx
      .insert(t.users)
      .values({
        username,
        fullName: input.fullName.trim(),
        fullNameAr: input.fullNameAr?.trim() || null,
        roleId: roleId.GENERAL_MANAGER,
        branchId: null,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
      })
      .returning();
    await writeAudit(tx, null, {
      action: 'BOOTSTRAP_COMPLETED',
      entityType: 'user',
      entityId: gm.username,
      branchId: null,
      key: 'System bootstrapped: first General Manager {username} created ({n} branches)',
      params: { username: gm.username, n: created.length },
      metadata: { branches: created, name: ap.text(gm.fullName, gm.fullNameAr) },
    });
    ctx.settings.invalidate();
    return { username: gm.username, temporaryPassword, branches: created };
  });
}
