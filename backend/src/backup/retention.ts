// Backup file names and the retention rule (D-2c-3): keep the newest backup of each of the last
// N days, N ISO weeks and N months (UTC); everything else in BACKUP_DIR made by this tool is removed.

export const BACKUP_PREFIX = 'jerp-backup-';

/** e.g. jerp-backup-20261004T101500Z */
export function backupBaseName(at: Date): string {
  return BACKUP_PREFIX + at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Time of a backup from its file name (dump, checksum or manifest), or null if not ours. */
export function parseBackupName(file: string): { base: string; at: Date } | null {
  const m = /^(jerp-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z)(?:\.|$)/.exec(file);
  if (!m) return null;
  const at = new Date(Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]));
  return Number.isNaN(at.getTime()) ? null : { base: m[1], at };
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${week}`;
}

/** Which of the given backup times to keep (grandfather-father-son). The newest is always kept. */
export function selectToKeep(times: Date[], keep: { daily: number; weekly: number; monthly: number }): Set<number> {
  const order = times.map((t, i) => ({ t, i })).sort((a, b) => b.t.getTime() - a.t.getTime());
  const kept = new Set<number>();
  if (order.length) kept.add(order[0].i);
  const bucket = (key: (d: Date) => string, n: number) => {
    const seen = new Set<string>();
    for (const { t, i } of order) {
      const k = key(t);
      if (seen.has(k)) continue;
      if (seen.size >= n) break;
      seen.add(k);
      kept.add(i);
    }
  };
  bucket((d) => d.toISOString().slice(0, 10), keep.daily);
  bucket(isoWeek, keep.weekly);
  bucket((d) => d.toISOString().slice(0, 7), keep.monthly);
  return kept;
}
