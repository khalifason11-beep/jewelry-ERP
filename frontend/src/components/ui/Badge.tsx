// Badges (UI-A1, R6): four meanings only, each with its token pair (contrast >= 4.5:1, tokens.md).
// ok = a completed state; warn = needs attention; crit = failed, cancelled, refused; info = everything else.
// The label is always text: colour is never the only signal.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useI18n } from '../../lib/i18n';

export type Tone = 'ok' | 'warn' | 'crit' | 'info';
const TONE: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  crit: 'bg-crit-bg text-crit',
  info: 'bg-neutral-bg text-ink-2',
};

/** Statuses the server sends, by meaning. Anything not listed is informational. */
const STATUS_TONE: Record<string, Tone> = {
  COMPLETED: 'ok',
  APPROVED: 'ok',
  RECEIVED: 'ok',
  PENDING: 'warn',
  IN_PROGRESS: 'warn',
  IN_TRANSIT: 'warn',
  TRANSFERRED: 'warn',
  IDLE: 'warn',
  DAMAGED: 'crit',
  DAMAGE: 'crit',
  VOIDED: 'crit',
  CANCELLED: 'crit',
  REJECTED: 'crit',
  DISABLED: 'crit',
  REVOKED: 'crit',
  LOGIN_FAILED: 'crit',
};
export const statusTone = (status: string): Tone => STATUS_TONE[status] ?? 'info';

export function Badge({ children, tone = 'info', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-badge px-[7px] py-px text-meta font-semibold', TONE[tone], className)}>{children}</span>;
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const { t } = useI18n();
  if (!status) return <span className="text-ink-3">—</span>;
  const label = t(status);
  return (
    <Badge tone={statusTone(status)} className={className}>
      {label === status ? status.replaceAll('_', ' ') : label}
    </Badge>
  );
}
