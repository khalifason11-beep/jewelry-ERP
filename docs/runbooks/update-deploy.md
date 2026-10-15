# Runbook: routine release (update)

For a server set up with `first-deploy.md`. Plan 15–30 minutes, outside shop hours. The shops stop entering data during
the update (step 3 to step 8). Define the `jerp` and `jerp_backup` shell helpers first (`first-deploy.md`, top).

## 1. Before the day

- The release is a **tag** on `main` whose CI is green (`typecheck`, `test-pglite`, `test-postgres`, `build`).
- Read the release notes: **does it contain a migration?** (`git diff --stat <current tag>..<new tag> -- database/migrations`).
  A release with a migration can only be undone by restoring the backup taken in step 3 (`rollback.md`).

## 2. Preflight on the current version (read-only)

```bash
jerp node scripts/server/preflight.mjs
```

All PASS before you continue.

## 3. Stop the writes and take a verified backup

Tell the branches to stop and keep paper receipts. Then:

```bash
systemctl stop jerp                       # graceful: running requests finish (SHUTDOWN_GRACE_MS)
jerp_backup npm run backup
# On the drill machine (it holds the secret key): prove this exact file restores.
npm run backup:verify -- --file ./jerp-backup-<time>.dump.age
```

Write down the backup file name. **Do not continue unless `backup:verify` passed.**

## 4. Get the new version

```bash
cd /srv/jerp/app
sudo -u jerp git fetch --tags && sudo -u jerp git checkout <new tag>
sudo -u jerp npm ci --include=dev
sudo -u jerp npm run build
```

## 5. Migrate with the owner role

```bash
jerp npm run migrate
```

Every pending migration runs in one transaction. If it stops (a guard message, or an error), **nothing was changed**:
go back to step 4 with the previous tag and start the service again (no restore needed). Report the message.

## 6. Preflight on the new version

```bash
jerp node scripts/server/preflight.mjs
```

## 7. Start and check readiness

```bash
systemctl start jerp
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:4000/api/ready && break; sleep 2; done
journalctl -u jerp -n 50 --no-pager
```

`{"ready":true}` within a minute, and no `refusing to start` or `SECURITY WARNING` in the log.

## 8. Smoke test (5 minutes)

- Sign in as the General Manager (password + passkey); the home shows today's figures.
- Open Cash for one branch: the expected cash matches what it was before the update.
- Open the last invoice and print it (or print preview).
- Sign in as a cashier on another device: the point of sale lists the pieces.

Then tell the branches to resume.

## 9. If readiness or the smoke test fails

- **No migration in this release:** check out the previous tag, `npm ci`, `npm run build`, `systemctl restart jerp`
  (code-only rollback, `rollback.md` A).
- **A migration was applied:** restore the backup from step 3 (`rollback.md` B). Do not try to "fix forward" on the
  production database during the shop day.
