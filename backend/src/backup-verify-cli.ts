// npm run backup:verify [-- --file <path>] — restore drill of the latest backup into a throwaway
// database, with integrity checks (docs/DEPLOYMENT.md §7). Exit code ≠ 0 on any failure.
import { BackupConfigError, loadBackupConfig } from './backup/config';
import { runVerify, VerifyFailed } from './backup/verify';

const i = process.argv.indexOf('--file');
const file = i > 0 ? process.argv[i + 1] : undefined;
try {
  const r = await runVerify(loadBackupConfig(), { file });
  console.log(`\nRESTORE DRILL OK: ${r.fileName} · ${r.checks.length} integrity checks passed`);
  process.exit(0);
} catch (e) {
  console.error('\n' + '!'.repeat(72));
  console.error(`RESTORE DRILL FAILED: ${(e as Error).message}`);
  if (e instanceof VerifyFailed) for (const c of e.checks.filter((x) => !x.ok)) console.error(`  - ${c.name}: ${c.detail}`);
  console.error('!'.repeat(72) + '\n');
  process.exit(e instanceof BackupConfigError ? 2 : 1);
}
