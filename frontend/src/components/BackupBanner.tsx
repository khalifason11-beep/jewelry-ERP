// GM warning banner (Phase 2c, D-2c-6): shown when the last successful backup or restore drill is
// older than the thresholds in Settings. It shows ages and status only.

import { useQuery } from '@tanstack/react-query';
import { DatabaseBackup } from 'lucide-react';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Alert } from './ui';

interface BackupStatus {
  status: 'OK' | 'WARNING';
  backupAgeHours: number | null;
  verifyAgeHours: number | null;
  reasons: ('BACKUP_NEVER' | 'BACKUP_STALE' | 'VERIFY_NEVER' | 'VERIFY_STALE')[];
  maxAgeHours: number;
  maxVerifyAgeDays: number;
}

export function BackupBanner() {
  const { t } = useI18n();
  const { can, me } = useAuth();
  const q = useQuery({ queryKey: ['backup-status'], queryFn: () => get<BackupStatus>('/backups/status'), enabled: can('backups.view'), refetchInterval: 300_000 });
  const s = q.data;
  if (!s || s.status === 'OK') return null;
  // Demo databases are disposable: no banner until a backup has ever been made there (D-2c-6).
  if (me?.appMode === 'demo' && s.reasons.every((r) => r.endsWith('_NEVER'))) return null;
  const lines = s.reasons.map((r) =>
    r === 'BACKUP_NEVER'
      ? t('No successful backup has been recorded.')
      : r === 'BACKUP_STALE'
        ? t('The last successful backup is {hours} hours old (limit: {max} hours).', { hours: Math.floor(s.backupAgeHours ?? 0), max: s.maxAgeHours })
        : r === 'VERIFY_NEVER'
          ? t('No restore drill has succeeded yet.')
          : t('The last successful restore drill is {days} days old (limit: {max} days).', { days: Math.floor((s.verifyAgeHours ?? 0) / 24), max: s.maxVerifyAgeDays }),
  );
  return (
    <Alert tone="warning" icon={<DatabaseBackup className="size-4" />} title={t('Backups need attention')} className="mb-5">
      <div data-testid="backup-banner">
        {lines.map((l) => <div key={l}>{l}</div>)}
      </div>
    </Alert>
  );
}
