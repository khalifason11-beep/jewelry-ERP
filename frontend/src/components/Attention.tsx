// The attention list (UI-B, docs/plans/UI-B.md §1 and §3, D-ui-17, D-ui-18). One source, `GET /api/attention`, read
// by the top bar's attention control (every page, GM and branch manager) and by the homes' "Needs attention" panel.
// The server sends codes and plain data; every sentence is written here. Nothing is dismissible: a line leaves when
// its cause is fixed. No line carries a cost, a profit or a money amount owed to suppliers (supplier debt is grams).

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { grams, money, relative } from '../lib/format';
import { useI18n } from '../lib/i18n';

export type Severity = 'critical' | 'warning' | 'info';
export interface Signal {
  id: string;
  code: 'A1' | 'A2' | 'A4' | 'A5' | 'A6' | 'A9' | 'A10' | 'A11' | 'A12' | 'A15' | 'A16' | 'S1' | 'S2';
  severity: Severity;
  branchId: number | null;
  count: number;
  link: string;
  params: Record<string, string | number | null>;
  since: string | null;
}
export interface AttentionData {
  generatedAt: string;
  branchId: number | null;
  signals: Signal[];
  counts: Record<Severity, number>;
}

/** The attention list for the signed-in person (GM: every branch, or one with `branchId`; branch manager: own branch). */
export function useAttention(branchId?: number | null) {
  const { can } = useAuth();
  const allowed = can('dashboard.company') || can('dashboard.branch');
  return useQuery({
    queryKey: ['attention', branchId ?? 'all'],
    queryFn: () => get<AttentionData>(branchId ? `/attention?branchId=${branchId}` : '/attention'),
    enabled: allowed,
    refetchInterval: 60_000,
  });
}

/** Warning and critical lines count for the badge; information lines do not. */
export const urgentCount = (d?: AttentionData) => (d ? d.counts.critical + d.counts.warning : 0);
export const topSeverity = (d?: AttentionData): Severity | null => (!d ? null : d.counts.critical ? 'critical' : d.counts.warning ? 'warning' : d.counts.info ? 'info' : null);

/** The sentence (title) and the one-line detail of a signal. */
export function useSignalText() {
  const { t, L } = useI18n();
  return (s: Signal): { title: string; detail: string } => {
    const p = s.params;
    const n = (k: string) => Number(p[k] ?? 0);
    const branch = L(p.branch as string | null, p.branchAr as string | null) || '—';
    switch (s.code) {
      case 'A1':
        return { title: t('{count} transfer(s) on the way to {branch}', { count: n('count'), branch }), detail: t('Confirm receipt when they arrive') };
      case 'A2':
        return {
          title: t('Transfer {number} is late', { number: String(p.number ?? '') }),
          detail: t('{from} → {to} · {hours} hours on the way · {items} pieces', {
            from: L(p.fromBranch as string | null, p.fromBranchAr as string | null) || '—',
            to: L(p.toBranch as string | null, p.toBranchAr as string | null) || '—',
            hours: n('hours'),
            items: n('items'),
          }),
        };
      case 'A4':
        return {
          title: t('Cash count difference at {branch}', { branch }),
          detail: t('Count of {day}: {amount} against the expected cash', { day: String(p.day ?? ''), amount: `\u2066${n('amount') > 0 ? '+' : ''}${money(n('amount'))}\u2069` }),
        };
      case 'A5':
        return { title: t('No cash count at {branch} yesterday', { branch }), detail: t('Count the drawer for {day}', { day: String(p.day ?? '') }) };
      case 'A6':
        return {
          title: t('Gold owed to {supplier}', { supplier: L(p.supplier as string | null, p.supplierAr as string | null) || t('Supplier') }),
          detail:
            n('days') > 0
              ? t('{weight} of 24K over {orders} order(s) · oldest {days} days', { weight: grams(n('pureMg24')), orders: n('orders'), days: n('days') })
              : t('{weight} of 24K over {orders} order(s) · since today', { weight: grams(n('pureMg24')), orders: n('orders') }),
        };
      case 'A9': {
        const reasons = String(p.reasons ?? '').split(',').filter(Boolean);
        const lines = reasons.map((r) =>
          r === 'BACKUP_NEVER'
            ? t('No successful backup has been recorded.')
            : r === 'BACKUP_STALE'
              ? t('The last successful backup is {hours} hours old (limit: {max} hours).', { hours: Math.floor(n('backupAgeHours')), max: n('maxAgeHours') })
              : r === 'VERIFY_NEVER'
                ? t('No restore drill has succeeded yet.')
                : t('The last successful restore drill is {days} days old (limit: {max} days).', { days: Math.floor(n('verifyAgeHours') / 24), max: n('maxVerifyAgeDays') }),
        );
        return { title: t('Backups need attention'), detail: lines.join(' ') };
      }
      case 'A10':
        return {
          title: t('{count} sign-in(s) from a new device in 7 days', { count: n('count') }),
          detail: n('managers') > 0 ? t('{n} of them by a manager. Review the sessions', { n: n('managers') }) : t('Review the sessions'),
        };
      case 'A11':
        return { title: t('{n} failed sign-in attempt(s) in 24h', { n: n('count') }), detail: t('Review the audit log for details') };
      case 'A12':
        return { title: t('{count} account(s) temporarily locked', { count: n('count') }), detail: t('They unlock by themselves after a while, or a manager unlocks them now') };
      case 'A15':
        return {
          title: t('Stock does not reconcile at {branch}', { branch }),
          detail: t('Pieces off by {pieces}, weight off by {weight}. Check the stock movements', { pieces: n('pieces'), weight: grams(n('weightMg')) }),
        };
      case 'A16':
        return { title: t('A gold or scrap rate is missing'), detail: t('Set the rates in Settings before selling or buying scrap') };
      case 'S1':
        return { title: t('You have only one passkey'), detail: t('Register a second device (your phone is ideal) so a lost or broken computer does not lock you out.') };
      case 'S2':
        return { title: t('Touch-only security keys are accepted'), detail: t('A passkey does not have to check a fingerprint, face or PIN (Settings › Second factor).') };
    }
  };
}

const CHIP: Record<Severity, string> = { critical: 'bg-crit-bg text-crit', warning: 'bg-warn-bg text-warn', info: 'bg-neutral-bg text-ink-2' };

/** The severity in words (never colour alone, mockup `.sev`): Urgent, Warning, For information. */
export function SeverityChip({ severity }: { severity: Severity }) {
  const { t } = useI18n();
  const word: Record<Severity, string> = { critical: t('Urgent'), warning: t('Warning'), info: t('For information') };
  return <span className={clsx('shrink-0 whitespace-nowrap rounded-badge px-1.5 text-meta font-semibold', CHIP[severity])}>{word[severity]}</span>;
}

/**
 * The lines of the list (mockup `.row`): the severity in words, the sentence, the detail and when; each opens the
 * screen that fixes it. `tone="panel"` draws white rows on a grey panel (the homes); the popover uses plain rows.
 */
export function AttentionLines({ signals, onOpen, tone = 'plain', testId = 'attention-line' }: { signals: Signal[]; onOpen: (s: Signal) => void; tone?: 'plain' | 'panel'; testId?: string }) {
  const text = useSignalText();
  return (
    <ul className={clsx(tone === 'plain' ? 'divide-y divide-line' : 'grid grid-cols-1 gap-1.5')}>
      {signals.map((s) => {
        const { title, detail } = text(s);
        return (
          <li key={s.id}>
            <button
              onClick={() => onOpen(s)}
              className={clsx('flex w-full items-start gap-2.5 text-start', tone === 'plain' ? 'px-4 py-2.5 hover:bg-panel' : 'rounded-row bg-surface px-3 py-2 hover:bg-neutral-bg')}
              data-testid={testId}
              data-code={s.code}
              data-severity={s.severity}
            >
              <SeverityChip severity={s.severity} />
              <span className="min-w-0 flex-1">
                <span className="block text-meta font-medium text-ink">{title}</span>
                <span className="block truncate text-meta text-ink-3" title={detail}>
                  {detail}
                  {s.since && <> · {relative(s.since)}</>}
                </span>
              </span>
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-3 rtl:rotate-180" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
