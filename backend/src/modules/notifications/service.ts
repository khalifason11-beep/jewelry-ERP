import { and, eq, gte, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { Actor, Ctx } from '../../core/context';
import { can, isGlobal } from '../../authz';

/** `title` / `body` are translation keys; the UI fills them with `params`. */
export interface Notification {
  id: string;
  kind: 'TRANSFER' | 'SECURITY';
  title: string;
  body: string;
  params: Record<string, string | number>;
  link: string;
  at: Date;
  severity: 'info' | 'warning';
}

/** Actionable items for the current user, computed from live data (no separate store). */
export async function notificationsFor(ctx: Ctx, actor: Actor): Promise<Notification[]> {
  const out: Notification[] = [];
  const branchCond = <T extends { branchId: unknown }>(col: T['branchId']) =>
    isGlobal(actor) ? undefined : eq(col as never, actor.branchId ?? -1);

  if (can(actor, 'inventory.transfer')) {
    const trs = await ctx.db
      .select({ id: t.transfers.id, number: t.transfers.number, createdAt: t.transfers.createdAt, from: t.branches.name })
      .from(t.transfers)
      .innerJoin(t.branches, eq(t.branches.id, t.transfers.fromBranchId))
      .where(and(eq(t.transfers.status, 'IN_TRANSIT'), isGlobal(actor) ? undefined : eq(t.transfers.toBranchId, actor.branchId ?? -1)))
      .limit(5);
    for (const tr of trs) {
      out.push({ id: `trf-${tr.id}`, kind: 'TRANSFER', title: 'Transfer {number} in transit', body: 'From {branch}. Confirm receipt when it arrives', params: { number: tr.number, branch: tr.from }, link: '/transfers', at: tr.createdAt, severity: 'info' });
    }
  }
  if (can(actor, 'audit.view')) {
    const [failed] = await ctx.db
      .select({ n: sql<number>`count(*)`, last: sql<Date>`max(${t.auditLogs.at})` })
      .from(t.auditLogs)
      .where(and(eq(t.auditLogs.action, 'LOGIN_FAILED'), gte(t.auditLogs.at, new Date(Date.now() - 86400_000)), branchCond(t.auditLogs.branchId)));
    if (Number(failed.n) > 0) {
      out.push({ id: 'sec-failed', kind: 'SECURITY', title: '{n} failed sign-in attempt(s) in 24h', body: 'Review the audit log for details', params: { n: Number(failed.n) }, link: '/audit?action=LOGIN_FAILED', at: new Date(failed.last), severity: 'warning' });
    }
  }
  return out.sort((a, b) => +new Date(b.at) - +new Date(a.at));
}
