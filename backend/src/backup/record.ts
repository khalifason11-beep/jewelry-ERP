// Record a backup or restore-drill run in the append-only `backup_runs` table of the SOURCE
// database, through the app's runtime connection (the backup role is read-only by design).

import os from 'node:os';
import type { BackupRunKind, BackupRunStatus } from '@jerp/shared';

export interface RunRecord {
  kind: BackupRunKind;
  status: BackupRunStatus;
  fileName?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  encrypted?: boolean;
  uploaded?: boolean;
  detail?: unknown;
  startedAt: Date;
  finishedAt?: Date;
}

export async function recordRun(url: string | undefined, r: RunRecord): Promise<boolean> {
  if (!url) return false;
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO backup_runs (kind, status, file_name, size_bytes, sha256, encrypted, uploaded, detail, host, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [r.kind, r.status, r.fileName ?? null, r.sizeBytes ?? null, r.sha256 ?? null, r.encrypted ?? false, r.uploaded ?? false, r.detail == null ? null : JSON.stringify(r.detail), os.hostname(), r.startedAt, r.finishedAt ?? new Date()],
    );
    return true;
  } finally {
    await client.end().catch(() => undefined);
  }
}
