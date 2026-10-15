# Runbook: rollback

Migrations are forward-only (`docs/DEPLOYMENT.md`, "Migrations are forward-only"). How to go back depends on one
question.

```
Did the release apply a migration?   git diff --stat <previous tag>..<new tag> -- database/migrations
│
├── NO  → A. Code-only rollback            ~5 minutes      nothing is lost
│
└── YES → B. Restore the pre-deploy backup  ~20–60 minutes  everything entered after that backup is lost
          (old code cannot run on the new schema, and the migration cannot be "undone")
```

## A. Code-only rollback (no migration in the release)

```bash
cd /srv/jerp/app
sudo -u jerp git checkout <previous tag>
sudo -u jerp npm ci --include=dev && sudo -u jerp npm run build
systemctl restart jerp
curl -fsS http://127.0.0.1:4000/api/ready        # {"ready":true}
```

Nothing is lost: the database was never changed by the release. Every sale, purchase and count entered with the new
version stays.

## B. Restore from the pre-deploy backup (a migration was applied)

What is lost: everything entered between the backup (update-deploy step 3) and now. That is why the update stops the
shops before the backup and keeps them stopped until the smoke test: done that way, **nothing** is lost.

1. **Stop the app:** `systemctl stop jerp`. Tell the branches to keep paper receipts.
2. **Prove the file:** on the drill machine, `npm run backup:verify -- --file <the pre-deploy file>` (it must pass).
3. **Restore into a NEW database** (never over the old one, so you can still look at it):
   follow `docs/DEPLOYMENT.md` §7.8 steps 3–6 (create `jewelry_erp_restored` as the owner, `pg_restore`, re-apply the
   grants, check the locks with `npm run migrate`).
4. **Put the previous code back:** `git checkout <previous tag>`, `npm ci --include=dev`, `npm run build`.
5. **Point the app at the restored database:** change the database name in `DATABASE_URL` and `MIGRATION_DATABASE_URL`
   in `/etc/jerp.env`.
6. **Preflight, start, readiness:** `jerp node scripts/server/preflight.mjs`, `systemctl start jerp`, `/api/ready`.
7. **Smoke test** (update-deploy step 8), then tell the branches to resume.
8. **Re-enter** anything recorded on paper since the backup, and keep the old database until the owner agrees to drop
   it.

Time: 20 minutes for a small database; the `pg_restore` dominates (the restore drill prints its duration: use that
number as the estimate).
