// First steps on an empty system (REM-3). A new database has no demo data; the General Manager's home
// shows a four-step checklist until the system can take its first sale:
//   1. allowed karats confirmed (mandatory: an initial value from ALLOWED_KARATS_INITIAL is NOT a confirmation)
//   2. today's gold rate and the scrap buying rates for the allowed karats
//   3. a first branch
//   4. a branch manager and a cashier
// Every step is derived from real data; nothing here can be "ticked" without doing the step.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { KARATS } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest } from '../../core/errors';
import { rows } from '../../core/sql';

export type SetupStepKey = 'karats' | 'rates' | 'branch' | 'staff';

export async function setupStatus(ctx: Ctx, actor: Actor) {
  requirePerm(actor, 'settings.manage');
  const { inventory } = await ctx.settings.get();
  const allowed = inventory.allowedKarats;
  // Gold sell rates exist only for the karats the rate form offers (KARATS); scrap rates for any karat.
  const goldKarats = allowed.filter((k) => (KARATS as readonly number[]).includes(k));
  const gold = new Set(rows<{ karat: number }>(await ctx.db.execute(sql`SELECT DISTINCT karat FROM gold_rates`)).map((r) => Number(r.karat)));
  const scrap = new Set(rows<{ karat: number }>(await ctx.db.execute(sql`SELECT DISTINCT karat FROM scrap_rates`)).map((r) => Number(r.karat)));
  const [{ n: branches }] = rows<{ n: number }>(await ctx.db.execute(sql`SELECT count(*)::int AS n FROM branches WHERE is_active`));
  const staff = await ctx.db
    .select({ code: t.roles.code })
    .from(t.users)
    .innerJoin(t.roles, eq(t.roles.id, t.users.roleId))
    .where(and(eq(t.users.status, 'ACTIVE'), inArray(t.roles.code, ['BRANCH_MANAGER', 'CASHIER'])));
  const roles = new Set(staff.map((s) => s.code));
  const steps: { key: SetupStepKey; done: boolean }[] = [
    { key: 'karats', done: inventory.allowedKaratsConfirmed },
    { key: 'rates', done: goldKarats.length > 0 && goldKarats.every((k) => gold.has(k)) && allowed.every((k) => scrap.has(k)) },
    { key: 'branch', done: Number(branches) > 0 },
    { key: 'staff', done: roles.has('BRANCH_MANAGER') && roles.has('CASHIER') },
  ];
  return { complete: steps.every((s) => s.done), steps, allowedKarats: allowed };
}

/** Step 1: the General Manager confirms (and may change) the allowed karats. Audited; re-confirmation by password. */
export async function confirmAllowedKarats(ctx: Ctx, actor: Actor, allowedKarats: number[]) {
  requirePerm(actor, 'settings.manage');
  if (!allowedKarats.length) throw badRequest('Select at least one karat');
  const karats = [...new Set(allowedKarats)].sort((a, b) => a - b);
  await ctx.db.transaction(async (tx) => {
    await ctx.settings.apply(
      tx,
      { 'inventory.allowedKarats': karats, 'inventory.allowedKaratsConfirmed': true },
      { actor: { id: actor.userId, username: actor.username }, reason: 'First steps: allowed karats confirmed', allowGuarded: true },
    );
    await writeAudit(tx, actor, {
      action: 'ALLOWED_KARATS_CONFIRMED',
      entityType: 'setting',
      entityId: 'inventory.allowedKarats',
      key: 'Allowed karats confirmed: {karats}',
      params: { karats: karats.join(', ') },
    });
  });
  ctx.settings.invalidate();
  return setupStatus(ctx, actor);
}

/**
 * First start only (like the second-factor settings, D-2fa-4): ALLOWED_KARATS_INITIAL sets
 * `inventory.allowedKarats` while no row for it exists. It is not a confirmation (step 1 stays open).
 */
export async function applyInitialInventorySettings(ctx: Ctx, init: { allowedKarats?: number[] }) {
  if (!init.allowedKarats) return [];
  const [row] = await ctx.db.select({ key: t.settings.key }).from(t.settings).where(eq(t.settings.key, 'inventory.allowedKarats'));
  if (row) return [];
  return ctx.db.transaction(async (tx) => {
    const { changed } = await ctx.settings.apply(tx, { 'inventory.allowedKarats': init.allowedKarats }, { actor: { id: null, username: 'system (first start)' }, reason: 'Initial value from the environment (first start)' });
    await writeAudit(tx, null, {
      action: 'SETTINGS_CHANGED',
      entityType: 'setting',
      entityId: 'inventory.allowedKarats',
      key: 'First start: {setting} set to {to} from the environment',
      params: { setting: 'inventory.allowedKarats', to: JSON.stringify(init.allowedKarats) },
    });
    return changed;
  });
}
