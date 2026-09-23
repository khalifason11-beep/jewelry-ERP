import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { formatWeight } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { can, isGlobal } from '../../authz';

export interface Notification {
  id: string;
  kind: 'HASAD' | 'TRANSFER' | 'EXPENSE' | 'SECURITY';
  title: string;
  body: string;
  link: string;
  at: Date;
  severity: 'info' | 'warning';
}

/** Actionable items for the current user, computed from live data (no separate store). */
export async function notificationsFor(ctx: Ctx, actor: Actor): Promise<Notification[]> {
  const out: Notification[] = [];
  const branchCond = <T extends { branchId: unknown }>(col: T['branchId']) =>
    isGlobal(actor) ? undefined : eq(col as never, actor.branchId ?? -1);

  if (can(actor, 'hasad.process') || can(actor, 'hasad.view')) {
    const ws = await ctx.db
      .select({ id: t.hasadWithdrawals.id, externalId: t.hasadWithdrawals.externalId, customerName: t.hasadWithdrawals.customerName, weight: t.hasadWithdrawals.entitledWeightMg, receivedAt: t.hasadWithdrawals.receivedAt, branchName: t.branches.name })
      .from(t.hasadWithdrawals)
      .innerJoin(t.branches, eq(t.branches.id, t.hasadWithdrawals.branchId))
      .where(and(eq(t.hasadWithdrawals.status, 'READY_FOR_PICKUP'), branchCond(t.hasadWithdrawals.branchId)))
      .orderBy(desc(t.hasadWithdrawals.receivedAt))
      .limit(6);
    for (const w of ws) {
      out.push({
        id: `hasad-${w.id}`,
        kind: 'HASAD',
        title: `Hasad withdrawal ${w.externalId}`,
        body: `${w.customerName} · ${formatWeight(w.weight)} · ${w.branchName} — ready for pickup`,
        link: `/hasad/${w.id}`,
        at: w.receivedAt,
        severity: 'info',
      });
    }
  }
  if (can(actor, 'inventory.transfer')) {
    const trs = await ctx.db
      .select({ id: t.transfers.id, number: t.transfers.number, createdAt: t.transfers.createdAt, from: t.branches.name })
      .from(t.transfers)
      .innerJoin(t.branches, eq(t.branches.id, t.transfers.fromBranchId))
      .where(and(eq(t.transfers.status, 'IN_TRANSIT'), isGlobal(actor) ? undefined : eq(t.transfers.toBranchId, actor.branchId ?? -1)))
      .limit(5);
    for (const tr of trs) {
      out.push({ id: `trf-${tr.id}`, kind: 'TRANSFER', title: `Transfer ${tr.number} in transit`, body: `From ${tr.from} — confirm receipt when it arrives`, link: '/transfers', at: tr.createdAt, severity: 'info' });
    }
  }
  if (can(actor, 'expenses.approve')) {
    const ex = await ctx.db
      .select({ id: t.expenses.id, number: t.expenses.number, amount: t.expenses.amount, createdAt: t.expenses.createdAt, branch: t.branches.name })
      .from(t.expenses)
      .innerJoin(t.branches, eq(t.branches.id, t.expenses.branchId))
      .where(eq(t.expenses.status, 'PENDING'))
      .limit(5);
    for (const e of ex) {
      out.push({ id: `exp-${e.id}`, kind: 'EXPENSE', title: `Expense ${e.number} awaiting approval`, body: `${e.branch} · ${e.amount.toLocaleString()} SDG`, link: '/expenses', at: e.createdAt, severity: 'warning' });
    }
  }
  if (can(actor, 'audit.view')) {
    const [failed] = await ctx.db
      .select({ n: sql<number>`count(*)`, last: sql<Date>`max(${t.auditLogs.at})` })
      .from(t.auditLogs)
      .where(and(eq(t.auditLogs.action, 'LOGIN_FAILED'), gte(t.auditLogs.at, new Date(Date.now() - 86400_000)), branchCond(t.auditLogs.branchId)));
    if (Number(failed.n) > 0) {
      out.push({ id: 'sec-failed', kind: 'SECURITY', title: `${failed.n} failed sign-in attempt(s) in 24h`, body: 'Review the audit log for details', link: '/audit?action=LOGIN_FAILED', at: new Date(failed.last), severity: 'warning' });
    }
  }
  return out.sort((a, b) => +new Date(b.at) - +new Date(a.at));
}
