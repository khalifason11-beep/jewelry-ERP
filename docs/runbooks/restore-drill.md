# Runbook: restore drill

A backup that has never been restored is not a backup. The drill restores the latest backup on a **separate machine**
and proves it: the files are intact, the data restores, and the restored database is consistent. It is the existing
`npm run backup:verify` tool (`backend/src/backup/verify.ts`, `docs/DEPLOYMENT.md` §7).

## When

- Before any real data is entered (first deployment), by **someone other than the developer** (BACKLOG BKP-1).
- Every week, scheduled (DEPLOYMENT §7.6).
- Before every update that carries a migration, on the pre-deploy backup (`update-deploy.md` step 3).

## Where

On a machine you control that is **not** the production server: an office computer or a small VPS with PostgreSQL 16 and
`age`. It holds the age **secret** key; production holds only the public key.

## Steps

```bash
# 1. Fetch the latest backup's three files from the off-site storage into BACKUP_DIR:
#    jerp-backup-<time>.dump.age, its .sha256 and its .manifest.json
# 2. Run the drill (the scratch server needs a role that may CREATE DATABASE):
BACKUP_DIR=/var/backups/jerp \
BACKUP_AGE_IDENTITY_FILE=/root/jerp-backup.key \
BACKUP_VERIFY_ADMIN_URL=postgresql://<drill admin>@127.0.0.1:5432/postgres \
DATABASE_URL=<production runtime URL, only to record the drill result> \
APP_MODE=production \
npm run backup:verify
```

## What it proves (it fails loudly on any of these)

- Both checksums match (the file is what the backup wrote).
- The file decrypts with the secret key and `pg_restore` restores it into a throwaway database.
- **Row counts** equal the counts recorded in the manifest at backup time.
- **Ledger and pool balances:** every account balance is the sum of its entries; the broken-scrap pool per branch and
  karat equals its movements.
- **Append-only triggers** are present on every append-only table and refuse UPDATE, DELETE and TRUNCATE.
- **CHECK constraints** are present and valid.
- The throwaway database is dropped afterwards. The drill is recorded, so `/api/health` shows its age.

## Record

Write down: date, who ran it, backup file name, duration of the restore, result. A failed drill is an incident: fix the
backup chain before the next shop day.
