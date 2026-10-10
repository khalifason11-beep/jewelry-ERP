// The attention list (BACKLOG BE-1, docs/plans/UI-B.md §1, D-ui-17). One endpoint, computed live from the data (no
// table, no cache), role- and branch-aware. Each signal is one grouped query over every branch in scope: the number of
// SQL statements does not grow with the number of branches, users or rows (tested).
//
// A signal carries a code, a severity, the branch it concerns (null = company or personal), a count, a link and
// `params`: plain data the browser turns into text (the frontend owns every sentence). No signal carries a cost, a
// profit or a money amount owed to suppliers; supplier debt is a weight (D-4-16). The only money is a cash-count
// difference (A4), which a branch manager already sees on Cash (`cash.view`).

import { sql } from 'drizzle-orm';
import type { Actor, Ctx } from '../../core/context';
import { can, isGlobal } from '../../authz';
import { forbidden } from '../../core/errors';
import { rows, num } from '../../core/sql';
import { addDays, dayKey, dayStart } from '../../core/time';
import { config } from '../../config';
import { backupHealth } from '../backups/status';
import { factorState } from '../../auth/second-factor';
import { setupRatesDone } from '../setup/service';

export type Severity = 'critical' | 'warning' | 'info';
export type SignalCode = 'A1' | 'A2' | 'A4' | 'A5' | 'A6' | 'A9' | 'A10' | 'A11' | 'A12' | 'A15' | 'A16' | 'S1' | 'S2';

export interface Signal {
  /** Stable id of this line (code + subject), for the list's keys and tests. */
  id: string;
  code: SignalCode;
  severity: Severity;
  branchId: number | null;
  count: number;
  link: string;
  /** Plain data for the text (names, numbers, days); never a cost or a supplier money amount. */
  params: Record<string, string | number | null>;
  /** For ordering: the oldest moment this signal is about (ISO), or null. */
  since: string | null;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * GET /api/attention. The General Manager sees every branch (or one, `branchId`: the branch view of the home, which
 * then leaves out the company-level and personal signals); a branch manager sees their own branch; a cashier has no
 * attention list (the route matrix refuses them before this runs).
 */
export async function attentionFor(ctx: Ctx, actor: Actor, q: { branchId?: number } = {}) {
  if (!can(actor, 'dashboard.company') && !can(actor, 'dashboard.branch')) throw forbidden();
  const global = isGlobal(actor);
  if (!global) {
    if (actor.branchId == null) throw forbidden('Your account is not assigned to a branch');
    if (q.branchId != null && q.branchId !== actor.branchId) throw forbidden('You can only access data of your own branch');
  }
  const scope: number | null = global ? (q.branchId ?? null) : actor.branchId;
  const companyView = global && q.branchId == null;
  const settings = await ctx.settings.get();
  const tz = settings.company.timezone;
  const now = new Date();
  const today = dayKey(now, tz);
  const inScope = (col: string) => (scope == null ? sql`` : sql.raw(` AND ${col} = ${Number(scope)}`));
  const out: Signal[] = [];
  const push = (s: Signal) => out.push(s);

  const names = new Map(
    rows<{ id: number; name: string; name_ar: string }>(await ctx.db.execute(sql`SELECT id, name, name_ar FROM branches`)).map((b) => [Number(b.id), b]),
  );
  const branchParams = (id: number | null) => (id == null ? { branch: null, branchAr: null } : { branch: names.get(id)?.name ?? null, branchAr: names.get(id)?.name_ar ?? null });

  // ── A1 transfers in transit, A2 late transfers (inventory.transfer) ──
  if (can(actor, 'inventory.transfer')) {
    const staleMs = settings.transfers.pendingClaimStaleHours * 3_600_000;
    const trs = rows<{ id: number; number: string; from_branch_id: number; to_branch_id: number; created_at: Date | string; items: number }>(
      await ctx.db.execute(sql`
        SELECT t.id, t.number, t.from_branch_id, t.to_branch_id, t.created_at, count(ti.item_id)::int AS items
        FROM transfers t LEFT JOIN transfer_items ti ON ti.transfer_id = t.id
        WHERE t.status = 'IN_TRANSIT' ${scope == null ? sql`` : sql`AND (t.to_branch_id = ${scope} OR t.from_branch_id = ${scope})`}
        GROUP BY t.id
        ORDER BY t.created_at`),
    );
    const fresh = new Map<number, { count: number; since: string }>();
    for (const tr of trs) {
      const at = new Date(tr.created_at);
      const hours = Math.floor((now.getTime() - at.getTime()) / 3_600_000);
      if (now.getTime() - at.getTime() > staleMs) {
        // A2: late, for both ends of the transfer.
        push({
          id: `A2:${tr.id}`,
          code: 'A2',
          severity: 'warning',
          branchId: scope ?? Number(tr.to_branch_id),
          count: 1,
          link: '/transfers',
          params: { number: tr.number, hours, items: num(tr.items), ...prefixed('from', branchParams(Number(tr.from_branch_id))), ...prefixed('to', branchParams(Number(tr.to_branch_id))) },
          since: at.toISOString(),
        });
        continue;
      }
      // A1: in transit; a branch only sees what comes to it.
      if (scope != null && Number(tr.to_branch_id) !== scope) continue;
      const to = Number(tr.to_branch_id);
      const cur = fresh.get(to) ?? { count: 0, since: at.toISOString() };
      fresh.set(to, { count: cur.count + 1, since: cur.since });
    }
    for (const [to, f] of fresh) {
      push({ id: `A1:${to}`, code: 'A1', severity: 'info', branchId: to, count: f.count, link: '/transfers', params: { count: f.count, ...branchParams(to) }, since: f.since });
    }
  }

  // ── A4 cash-count difference, A5 no cash count (cash.view) ──
  if (can(actor, 'cash.view')) {
    const tolerance = settings.cash.countDifferenceTolerance;
    const from = addDays(today, -7);
    // The latest count of the latest counted business day per branch (within 7 days), and that day's expected cash:
    // every CASH entry before the end of that business day (the reconciliation's definition).
    const counts = rows<{ branch_id: number; business_day: string; counted_amount: number | string; expected: number | string }>(
      await ctx.db.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (c.branch_id) c.branch_id, c.business_day::text AS business_day, c.counted_amount
          FROM cash_counts c
          WHERE c.business_day >= ${from}::date ${inScope('c.branch_id')}
          ORDER BY c.branch_id, c.business_day DESC, c.at DESC, c.id DESC
        )
        SELECT l.branch_id, l.business_day, l.counted_amount,
               coalesce((SELECT sum(e.amount) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
                         WHERE a.kind = 'CASH' AND e.branch_id = l.branch_id
                           AND e.at < ((l.business_day::date + 1)::timestamp AT TIME ZONE ${tz})), 0) AS expected
        FROM latest l`),
    );
    for (const c of counts) {
      const difference = num(c.counted_amount) - num(c.expected);
      if (Math.abs(difference) <= tolerance) continue;
      const b = Number(c.branch_id);
      push({
        id: `A4:${b}`,
        code: 'A4',
        severity: 'warning',
        branchId: b,
        count: 1,
        link: `/cash?branchId=${b}&day=${c.business_day}`,
        params: { amount: difference, day: c.business_day, ...branchParams(b) },
        since: dayStart(c.business_day, tz).toISOString(),
      });
    }
    // A5: yesterday had cash movements but no count. A day without cash movements (closed) raises nothing.
    const yesterday = addDays(today, -1);
    const missing = rows<{ branch_id: number }>(
      await ctx.db.execute(sql`
        SELECT DISTINCT e.branch_id
        FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'CASH' AND e.at >= ${dayStart(yesterday, tz).toISOString()} AND e.at < ${dayStart(today, tz).toISOString()} ${inScope('e.branch_id')}
          AND NOT EXISTS (SELECT 1 FROM cash_counts c WHERE c.branch_id = e.branch_id AND c.business_day = ${yesterday}::date)`),
    );
    for (const m of missing) {
      const b = Number(m.branch_id);
      push({ id: `A5:${b}`, code: 'A5', severity: 'warning', branchId: b, count: 1, link: `/cash?branchId=${b}&day=${yesterday}`, params: { day: yesterday, ...branchParams(b) }, since: dayStart(yesterday, tz).toISOString() });
    }
  }

  // ── A6 supplier gold owed, per supplier (purchases.view): weight only, never money ──
  if (can(actor, 'purchases.view')) {
    const maxAgeDays = settings.purchases.supplierDebtMaxAgeDays;
    const owed = rows<{ supplier_id: number | null; supplier: string | null; supplier_ar: string | null; owed: number | string; orders: number; oldest_at: Date | string; oldest_id: number }>(
      await ctx.db.execute(sql`
        SELECT p.supplier_id, s.name AS supplier, s.name_ar AS supplier_ar,
               sum(p.gold_owed_mg_pure24) AS owed, count(*)::int AS orders, min(p.created_at) AS oldest_at,
               (array_agg(p.id ORDER BY p.created_at, p.id))[1] AS oldest_id
        FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.gold_owed_mg_pure24 > 0 ${inScope('p.branch_id')}
        GROUP BY p.supplier_id, s.name, s.name_ar`),
    );
    for (const o of owed) {
      const oldest = new Date(o.oldest_at);
      const days = Math.floor((now.getTime() - oldest.getTime()) / 86_400_000);
      push({
        id: `A6:${o.supplier_id ?? 0}`,
        code: 'A6',
        severity: days > maxAgeDays ? 'warning' : 'info',
        branchId: scope,
        count: num(o.orders),
        link: `/purchases/${o.oldest_id}`,
        params: { supplier: o.supplier ?? null, supplierAr: o.supplier_ar ?? null, pureMg24: num(o.owed), days, orders: num(o.orders) },
        since: oldest.toISOString(),
      });
    }
  }

  // ── A9 backups (backups.view; company view): CRITICAL on every page for the GM (owner condition, UI-B Q2) ──
  if (companyView && can(actor, 'backups.view')) {
    const h = await backupHealth(ctx, now);
    // Demo databases are disposable: no signal until a backup has ever been made there (D-2c-6).
    const demoNever = config.appMode === 'demo' && h.reasons.every((r) => r.endsWith('_NEVER'));
    if (h.status !== 'OK' && !demoNever) {
      push({
        id: 'A9',
        code: 'A9',
        severity: 'critical',
        branchId: null,
        count: h.reasons.length,
        link: '/settings#backups',
        params: { reasons: h.reasons.join(','), backupAgeHours: h.backupAgeHours, verifyAgeHours: h.verifyAgeHours, maxAgeHours: settings.backup.maxAgeHours, maxVerifyAgeDays: settings.backup.maxVerifyAgeDays },
        since: null,
      });
    }
  }

  // ── A10 new-device sign-ins in the last 7 days (company view, users.manage) ──
  if (companyView && can(actor, 'users.manage')) {
    const [d] = rows<{ n: number; managers: number; last: Date | string | null }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE r.code IN ('GENERAL_MANAGER', 'BRANCH_MANAGER'))::int AS managers, max(e.at) AS last
        FROM sign_in_events e JOIN users u ON u.id = e.user_id JOIN roles r ON r.id = u.role_id
        WHERE e.new_device AND e.at >= ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}`),
    );
    if (num(d?.n) > 0) {
      push({ id: 'A10', code: 'A10', severity: num(d.managers) > 0 ? 'warning' : 'info', branchId: null, count: num(d.n), link: '/sessions', params: { count: num(d.n), managers: num(d.managers) }, since: d.last ? new Date(d.last).toISOString() : null });
    }
  }

  // ── A11 failed sign-ins in 24 h (audit.view; a branch manager: own branch, as the old bell) ──
  if (can(actor, 'audit.view')) {
    const [f] = rows<{ n: number; last: Date | string | null }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS n, max(at) AS last FROM audit_logs
        WHERE action = 'LOGIN_FAILED' AND at >= ${new Date(now.getTime() - 86_400_000).toISOString()} ${inScope('branch_id')}`),
    );
    if (num(f?.n) > 0) {
      push({
        id: 'A11',
        code: 'A11',
        severity: num(f.n) >= settings.security.lockoutThreshold ? 'warning' : 'info',
        branchId: scope,
        count: num(f.n),
        link: '/audit?action=LOGIN_FAILED',
        params: { count: num(f.n) },
        since: f.last ? new Date(f.last).toISOString() : null,
      });
    }
  }

  // ── A12 temporarily locked accounts (users.view). Security-locked ones stay in the shell's lock notice (D-lock-1). ──
  if (can(actor, 'users.view')) {
    const [l] = rows<{ n: number }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS n FROM users
        WHERE security_locked_at IS NULL AND (locked_until > now() OR mfa_locked_until > now()) ${inScope('branch_id')}`),
    );
    if (num(l?.n) > 0) push({ id: 'A12', code: 'A12', severity: 'warning', branchId: scope, count: num(l.n), link: '/users', params: { count: num(l.n) }, since: null });
  }

  // ── A15 stock does not reconcile: the inventory movements' balance vs the AVAILABLE pieces, per branch ──
  if (can(actor, 'inventory.view')) {
    const mism = rows<{ branch_id: number; moved_items: number | string; moved_weight: number | string; items: number | string; weight: number | string }>(
      await ctx.db.execute(sql`
        WITH m AS (SELECT branch_id, coalesce(sum(direction), 0) AS moved_items, coalesce(sum(direction * net_weight_mg), 0) AS moved_weight
                   FROM inventory_movements WHERE true ${inScope('branch_id')} GROUP BY branch_id),
             a AS (SELECT branch_id, count(*) AS items, coalesce(sum(net_weight_mg), 0) AS weight
                   FROM jewelry_items WHERE status = 'AVAILABLE' ${inScope('branch_id')} GROUP BY branch_id)
        SELECT coalesce(m.branch_id, a.branch_id) AS branch_id, coalesce(m.moved_items, 0) AS moved_items, coalesce(m.moved_weight, 0) AS moved_weight,
               coalesce(a.items, 0) AS items, coalesce(a.weight, 0) AS weight
        FROM m FULL JOIN a ON a.branch_id = m.branch_id
        WHERE coalesce(m.moved_items, 0) <> coalesce(a.items, 0) OR coalesce(m.moved_weight, 0) <> coalesce(a.weight, 0)`),
    );
    for (const r of mism) {
      const b = Number(r.branch_id);
      push({
        id: `A15:${b}`,
        code: 'A15',
        severity: 'critical',
        branchId: b,
        count: 1,
        link: `/reports/inventory-movement?branchId=${b}`,
        params: { pieces: num(r.items) - num(r.moved_items), weightMg: num(r.weight) - num(r.moved_weight), ...branchParams(b) },
        since: null,
      });
    }
  }

  // ── A16 a missing gold or scrap rate (settings.manage; company view) ──
  if (companyView && can(actor, 'settings.manage') && !(await setupRatesDone(ctx))) {
    push({ id: 'A16', code: 'A16', severity: 'critical', branchId: null, count: 1, link: '/settings#rates', params: {}, since: null });
  }

  // ── Personal and system notices that moved here from the shell (UI-B Q2): S1 only one passkey, S2 touch-only keys ──
  if (companyView || !global) {
    const f = await factorState(ctx.db, actor.userId, actor.roleCode, settings.security);
    if (f.required && f.credentials === 1) push({ id: 'S1', code: 'S1', severity: 'info', branchId: null, count: 1, link: '/security', params: {}, since: null });
  }
  if (companyView && can(actor, 'settings.manage') && settings.security.webauthnUserVerification === 'preferred') {
    push({ id: 'S2', code: 'S2', severity: 'warning', branchId: null, count: 1, link: '/settings#second-factor', params: {}, since: null });
  }

  out.sort((a, z) => RANK[a.severity] - RANK[z.severity] || String(a.since ?? '9').localeCompare(String(z.since ?? '9')) || (a.branchId ?? 0) - (z.branchId ?? 0));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const s of out) counts[s.severity]++;
  return { generatedAt: now.toISOString(), branchId: scope, signals: out, counts };
}

function prefixed(p: 'from' | 'to', o: { branch: string | null; branchAr: string | null }) {
  return { [`${p}Branch`]: o.branch, [`${p}BranchAr`]: o.branchAr };
}

