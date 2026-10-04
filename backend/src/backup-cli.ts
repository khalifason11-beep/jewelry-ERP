// npm run backup — encrypted logical backup of the application database (docs/DEPLOYMENT.md §7).
import { BackupConfigError, loadBackupConfig } from './backup/config';
import { BackupRefused, runBackup } from './backup/backup';

try {
  const cfg = loadBackupConfig();
  const r = await runBackup(cfg);
  console.log(`BACKUP OK: ${r.fileName} · ${r.sizeBytes} bytes · sha256 ${r.sha256} · ${r.encrypted ? 'encrypted' : 'NOT ENCRYPTED'} · ${r.uploaded ? 'copied off-site' : 'NOT copied off-site'}`);
  process.exit(0);
} catch (e) {
  const refused = e instanceof BackupRefused || e instanceof BackupConfigError;
  console.error(`\nBACKUP ${refused ? 'REFUSED' : 'FAILED'}: ${(e as Error).message}\n`);
  process.exit(refused ? 2 : 1);
}
