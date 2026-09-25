import type { Executor } from '@jerp/database';
import { t } from '@jerp/database';
import { auditDescriptionEn, type AuditAction, type AuditParams } from '@jerp/shared';
import type { Actor } from './context';

export interface AuditEntry {
  action: AuditAction;
  entityType?: string;
  entityId?: string | number | null;
  /** English template used as the translation key, e.g. 'Sale {number} cancelled ({total}): {reason}'. */
  key: string;
  /** Typed params (see `ap` in @jerp/shared); money and weights stay numeric. */
  params?: AuditParams;
  branchId?: number | null;
  metadata?: Record<string, unknown>;
  at?: Date;
}

/** Append an audit event. Call inside the same transaction as the change it records. */
export async function writeAudit(exec: Executor, actor: Actor | null, entry: AuditEntry): Promise<void> {
  await exec.insert(t.auditLogs).values({
    at: entry.at ?? new Date(),
    userId: actor?.userId ?? null,
    username: actor?.username ?? 'system',
    userFullName: actor?.fullName ?? 'System',
    role: actor?.roleCode ?? 'SYSTEM',
    branchId: entry.branchId !== undefined ? entry.branchId : (actor?.branchId ?? null),
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId != null ? String(entry.entityId) : null,
    description: auditDescriptionEn(entry.key, entry.params),
    descriptionKey: entry.key,
    descriptionParams: entry.params ?? {},
    metadata: entry.metadata ?? {},
    sessionId: actor?.sessionId ?? null,
    ipAddress: actor?.ip ?? null,
  });
}
