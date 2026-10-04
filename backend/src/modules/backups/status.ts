// Backup health (Phase 2c, D-2c-6). Reads the append-only `backup_runs` table: the age of the last
// successful backup and of the last successful restore drill, compared with the thresholds from
// the settings. The result carries ONLY ages (hours), a status and reason codes: no file names,
// paths, sizes, hosts or anything else, because the health check is public.

import { and, desc, eq } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import type { SystemSettings } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';

export type BackupReason = 'BACKUP_NEVER' | 'BACKUP_STALE' | 'VERIFY_NEVER' | 'VERIFY_STALE';

export interface BackupHealth {
  status: 'OK' | 'WARNING';
  /** Hours since the last successful backup (one decimal), null = never. */
  backupAgeHours: number | null;
  /** Hours since the last successful restore drill, null = never. */
  verifyAgeHours: number | null;
  reasons: BackupReason[];
}

async function lastSuccess(exec: Executor, kind: 'BACKUP' | 'VERIFY'): Promise<Date | null> {
  const [row] = await exec
    .select({ at: t.backupRuns.finishedAt })
    .from(t.backupRuns)
    .where(and(eq(t.backupRuns.kind, kind), eq(t.backupRuns.status, 'SUCCESS')))
    .orderBy(desc(t.backupRuns.finishedAt))
    .limit(1);
  return row?.at ?? null;
}

const hoursSince = (d: Date | null, now: Date) => (d ? Math.max(0, Math.round(((now.getTime() - d.getTime()) / 3_600_000) * 10) / 10) : null);

/** Pure evaluation (unit-tested): the ages against the thresholds. */
export function evaluateBackupHealth(lastBackup: Date | null, lastVerify: Date | null, limits: SystemSettings['backup'], now = new Date()): BackupHealth {
  const backupAgeHours = hoursSince(lastBackup, now);
  const verifyAgeHours = hoursSince(lastVerify, now);
  const reasons: BackupReason[] = [];
  if (backupAgeHours == null) reasons.push('BACKUP_NEVER');
  else if (backupAgeHours > limits.maxAgeHours) reasons.push('BACKUP_STALE');
  if (verifyAgeHours == null) reasons.push('VERIFY_NEVER');
  else if (verifyAgeHours > limits.maxVerifyAgeDays * 24) reasons.push('VERIFY_STALE');
  return { status: reasons.length ? 'WARNING' : 'OK', backupAgeHours, verifyAgeHours, reasons };
}

export async function backupHealth(ctx: Ctx, now = new Date()): Promise<BackupHealth> {
  const { backup } = await ctx.settings.get();
  return evaluateBackupHealth(await lastSuccess(ctx.db, 'BACKUP'), await lastSuccess(ctx.db, 'VERIFY'), backup, now);
}

/** GM view: the same ages plus the configured thresholds. */
export async function backupStatusView(ctx: Ctx, actor: Actor) {
  requirePerm(actor, 'backups.view');
  const { backup } = await ctx.settings.get();
  return { ...(await backupHealth(ctx)), maxAgeHours: backup.maxAgeHours, maxVerifyAgeDays: backup.maxVerifyAgeDays };
}
