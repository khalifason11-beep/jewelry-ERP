# Runbook: go-live reset (wipe the trial, create the real General Manager)

> **⚠ Do not run this before BKP-1 passed and the domain is final.**
> This runbook deletes every trial record for good: users, branches, rates, pieces, sales, money, history. The
> append-only history cannot be emptied from the app, so the whole database is dropped and created again. The only way
> back is the Hostinger snapshot of step 1.

For the operator on the day of go-live. One command per step. Every command says **WHERE** it runs:

- **[SERVER · root]** in the server's terminal as `root` (SSH from the owner's laptop, then `sudo -i` if needed);
- **[SERVER · postgres]** in the server's terminal, as written (`sudo -u postgres …` switches to the database admin);
- **[LAPTOP · browser]** in a web browser on the owner's laptop;
- **[DRILL MACHINE]** on the machine that holds the backup's secret key (not the server; `docs/runbooks/restore-drill.md`).

Each step ends with **You must see**. If you don't see it, stop and go to step 8.

Names used below are the defaults of `docs/runbooks/first-deploy.md`: the database `jewelry_erp`, the roles `jerp_owner`
(owner), `jerp_app` (runtime) and `jerp_backup` (backup), the app in `/srv/jerp/app`, the domain `erp.example.com`.
**The three roles and their passwords are kept.** `/etc/jerp.env` and `/etc/jerp-backup.env` stay as they are; only the
database is replaced.

**The two shell helpers** of `first-deploy.md` are used in every step. Paste them once when you open the root terminal:

```bash
jerp()        { ( set -a; . /etc/jerp.env;        set +a; cd /srv/jerp/app && runuser -u jerp -- "$@" ); }
jerp_backup() { ( set -a; . /etc/jerp-backup.env; set +a; cd /srv/jerp/app && runuser -u jerp -- "$@" ); }
```

(The env files are read by the shell: a value with spaces, such as `BACKUP_UPLOAD_COMMAND`, must be in single quotes.)

**Tested** on PostgreSQL 16.14 with the three roles, the real `postgres` admin, a `jerp` system user and a trial filled
by the app's own services (`docs/acceptance/DOC-2.md`). **Not tested here** (marked ⚑ where they occur): the Hostinger
snapshot and its rollback, systemd, the reverse proxy and TLS, the real domain, and real passkey devices.

---

## 1. Preconditions: tick every box, or stop

- [ ] **BKP-1 passed and is recorded:** a backup was restored on the drill machine (`restore-drill.md`), and its date,
      who ran it and the result are written down.
- [ ] **The domain is final.** `APP_ORIGIN` and `WEBAUTHN_RP_ID` in `/etc/jerp.env` hold the domain you will keep.
      Passkeys belong to that domain: if it ever changes, every passkey stops working.
- [ ] **⚑ A Hostinger snapshot is taken now**, after the last trial use (Hostinger panel → the VPS → Snapshots → Create).
      Write down its name and time: ______________________. It is the only way back.
- [ ] **The person who will be the General Manager is here**, with their laptop or phone. The temporary password, the
      passkey and the recovery codes are theirs: they type, they register, they keep the codes.
- [ ] **The username of the TRIAL General Manager** is written here: ______________________ (step 3 asks for it). To
      find it: **[SERVER · postgres]**
      `sudo -u postgres psql -d jewelry_erp -c "SELECT u.username FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'GENERAL_MANAGER';"`
- [ ] **The real General Manager's username** is chosen: 8 or more characters, a personal name such as `khalid.osman`.
      Never a role word: `admin`, `manager`, `gm`, `owner`, `test`, `demo`, `user`, `staff`… are refused.
- [ ] Nobody is using the system (shops closed, staff told).

## 2. Stop the service; the trial data

**[SERVER · root]** ⚑

```bash
systemctl stop jerp
```

You must see: `systemctl is-active jerp` prints `inactive`.

**The trial data is discarded** (owner's decision). Tick one:

- [ ] **Discard, no copy** (the default). Write: "Trial data discarded on ____ by ____."
- [ ] **One last encrypted TRIAL copy** (optional). **[SERVER · root]** `jerp_backup npm run backup`.
      You must see: `BACKUP OK: jerp-backup-<time>.dump.age … copied off-site`. Write the file name here:
      ______________________. **It is deleted after the reset** (step 7): it is not kept.

## 3. Drop and recreate the database (same roles, every grant)

**[SERVER · postgres]** One command. Type the database name **twice**, and the TRIAL General Manager's username from
step 1:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -v db=jewelry_erp -v db_confirm=jewelry_erp -v trial_gm=<trial GM username> -f /srv/jerp/app/scripts/server/go-live-reset.sql
```

You must see two lines:
`The TRIAL database jewelry_erp of General Manager <name> is dropped now: … users, … branches, … pieces, … sales.`
`DONE: the database jewelry_erp is empty, with the grants of jerp_owner jerp_app jerp_backup . Next: npm run migrate …`

**It refuses, and changes nothing,** with a line starting `REFUSED:`, when:
- the two names differ;
- a role is missing;
- the target is a system database;
- **the database is not the trial one you named** (the user you gave is not its General Manager).

Read the line, correct the command, run it again. A refusal is safe.

If the command stopped **after** the drop (the database exists but is empty), run the **same command again**. It says
`holds no table … it is created again` and finishes the job.

What it does (`scripts/server/go-live-reset.sql`):
- creates the database again;
- gives the owner the right to create tables, and the runtime and backup roles the right to use them;
- creates the `drizzle` schema (the migration history), readable by the runtime and backup roles;
- sets the owner's default privileges, so that every table the migrations create is usable by the runtime role and
  readable by the backup role (`docs/DEPLOYMENT.md` §5 and §7.2).

## 4. Migrate, then the preflight

**[SERVER · root]**

```bash
jerp npm run migrate
```

You must see: `Migrations applied (MIGRATION_DATABASE_URL).`

**[SERVER · root]**

```bash
jerp node scripts/server/preflight.mjs
```

You must see: every line `PASS`, except **one expected WARN** on `backups` (`BACKUP_NEVER, VERIFY_NEVER`: the new database
has no backup yet; step 7 clears it). The last line: `preflight: 11 PASS, 1 WARN, 0 FAIL, 0 SKIP: no FAIL; read every WARN`.

Lines to look at:
- `PASS migrations 39 of 39 applied`: the number grows with releases; both numbers must be equal.
- `PASS runtime role jerp_app cannot alter the audit log or the ledgers`: the strict-role check. The server refuses to
  start without it (`STRICT_DB_ROLES=true`).
- `PASS append-only every append-only table has its enabled protection trigger`.

Any `FAIL`: the line below it says `fix: …`. For example, `jerp_app cannot read the migration history` gives the two
`GRANT` lines. Do the fix, run the preflight again. Never start the service on a FAIL.

## 5. The real General Manager

**[SERVER · root]** With the **English** name only:

```bash
jerp npm run bootstrap -w @jerp/backend -- --username <real.username> --full-name "<Name in English>"
```

You must see:
`General Manager "<real.username>" created. Branches created: none.`
`One-time password (shown once, must be changed at first sign-in): Temp-XXXX-XXXX-XXXX`

**Give the one-time password to the General Manager now, on paper. Do not keep a copy.**

Rules and refusals:
- **The username:** 8 or more characters, lower-case letters, digits, dot, dash or underscore. It must not contain a
  role word (`admin`, `manager`, `general`, `gm`, `owner`, `boss`, `test`, `demo`, `user`, `staff`, `cashier`,
  `system`, `root`, `support`…). Refused with `Bootstrap failed: Choose a personal username, not a role-style name
  such as "admin"`: choose another name.
- **The Arabic name is not given here** (owner's decision). A Windows console sends Arabic as `????`. Typed later in the
  browser (step 6), it is always right. If someone passes `--full-name-ar` anyway and the console garbled it, the
  bootstrap refuses: `Bootstrap failed: The Arabic name "????" arrived garbled … Leave it out and type it later in the
  app`. Run the command again without `--full-name-ar`.
- **No branch here** (owner's decision): the first branch is created in the app (step 6), where its Arabic name is typed
  in the browser. Do not use `--branch`.
- **Run once.** A second bootstrap is refused (`A General Manager already exists`).

## 6. Start, check, first sign-in

**[SERVER · root]** ⚑

```bash
systemctl start jerp
```

**[SERVER · root]**

```bash
curl -fsS http://127.0.0.1:4000/api/ready
```

You must see: `{"ready":true}`. Check the log: `journalctl -u jerp -n 30 --no-pager` shows `server started`, and **no**
`refusing to start` and **no** `SECURITY WARNING`.

**⚑ The Origin echo test** (`docs/DEPLOYMENT.md` §6). Needed only if the reverse proxy changed since the first deploy.
Skip it otherwise. It stops the app for a minute:

```bash
systemctl stop jerp
node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({origin:q.headers.origin,host:q.headers.host,xfh:q.headers['x-forwarded-host'],xfp:q.headers['x-forwarded-proto']}))}).listen(4000)"
```

From the laptop (**[LAPTOP · terminal]**): `curl -s -X POST -H 'Origin: https://erp.example.com' https://erp.example.com/`.
You must see `"origin":"https://erp.example.com"`. Back on the server, stop the echo with **Ctrl+C**, then **start the
app again**: **[SERVER · root]** `systemctl restart jerp`, and `curl -fsS http://127.0.0.1:4000/api/ready` →
`{"ready":true}`. Without the restart nothing listens on 4000 and every page fails.

**First sign-in** **[LAPTOP · browser]**, by the General Manager, at `https://erp.example.com`:

1. Username and the one-time password → the system asks for a new password at once. Type a long new one, twice.
2. **⚑ Register a passkey:** the system shows "Step 1 of 2 · Register this computer": follow it on this laptop.
3. **⚑ Save the recovery codes:** "Step 2 of 2 · Save your recovery codes" shows them once. Print them or write them
   down, and keep them away from the laptop. Then add the phone as a second device: user menu → Security → **Add a
   device** (`docs/DEPLOYMENT.md` §8.3).
4. **Users** → your own row → type your **Arabic name** → Save.
5. **Branches** → **New branch** → the first branch, with its Arabic name typed here.

**Nothing of the trial is left.** **[SERVER · postgres]**

```bash
sudo -u postgres psql -X -d jewelry_erp -c "SELECT (SELECT string_agg(username, ', ') FROM users) AS users, (SELECT count(*) FROM gold_rates) AS gold_rates, (SELECT count(*) FROM scrap_rates) AS scrap_rates, (SELECT count(*) FROM jewelry_items) AS pieces, (SELECT count(*) FROM sales) AS sales, (SELECT count(*) FROM ledger_entries) AS ledger_entries;"
```

You must see: `users` = the real General Manager only, and **0** everywhere else. (Run before step 5 of the sign-in,
`branches` is 0 too; afterwards it is the one branch you created.) In the app: no trial user under Users, no trial branch,
no rate on Prices, no piece in Inventory.

## 7. First backup, and the drill

**[SERVER · root]**

```bash
jerp_backup npm run backup
```

You must see: `BACKUP OK: jerp-backup-<time>.dump.age … encrypted · copied off-site`.

If a TRIAL copy was made in step 2: **delete it now**, on the server (`/var/backups/jerp` or your `BACKUP_DIR`) and in the
off-site storage, using the file name you wrote in step 2. Write: "TRIAL copy ____ deleted on ____ by ____."

**[DRILL MACHINE]** Fetch the three new files from the off-site storage and run the drill (`docs/runbooks/restore-drill.md`).
You must see `RESTORE DRILL OK: … 6 integrity checks passed`. Then, from the laptop, `https://erp.example.com/api/health`
shows `"backup":{"status":"OK",…}`.

**Record** (keep with the BKP-1 record):

| Item | Value |
|---|---|
| Date and time of the reset | |
| Who ran it | |
| Hostinger snapshot name | |
| Trial data | discarded / TRIAL copy made and deleted on ____ |
| Real General Manager username | |
| Preflight result | 0 FAIL |
| First backup file | |
| Drill result | RESTORE DRILL OK on ____ by ____ |

## 8. Rollback: back to the snapshot

**When:** any step above fails and its own hint does not fix it, for example:
- the reset refused in a way you cannot explain;
- the preflight shows a FAIL that stays after its fix;
- the service does not start;
- `/api/ready` is not `{"ready":true}`;
- the first sign-in fails.

**Do not improvise in the database.**

**How** ⚑ (Hostinger panel, on the laptop):
1. Hostinger panel → the VPS → **Snapshots** → the snapshot written in step 1 → **Restore**. Confirm.
2. Wait until the VPS shows **Running** again. The whole server is as it was at the snapshot: the trial database, the
   service and the files.
3. **[SERVER · root]** `systemctl status jerp`, then `curl -fsS http://127.0.0.1:4000/api/ready` → `{"ready":true}`.
   The trial works as before.
4. Write down what failed (the exact line on screen) and send it to engineering. Plan a new go-live date. Repeat this
   runbook from step 1, including a **new** snapshot.

Nothing the General Manager did after the snapshot survives a rollback: a new passkey or a new branch is gone. That is
fine, because nothing real has happened yet.
