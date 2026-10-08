# Deployment behind a reverse proxy (Render or similar)

This guide covers a production deployment where the app runs behind a managed reverse proxy or load
balancer that terminates HTTPS, for example a Render Web Service with a Render PostgreSQL database.
The app is a single Node.js service: the API serves the built React app too, so no separate static
site is needed.

> Production mode refuses to start while the configuration is unsafe (see D-1a-10 in
> [decisions.md](decisions.md)). If the service does not come up, read the start-up log first: it lists
> every problem it found.

> **The old hosted demo cannot run from the default branch any more (REM-3).** Earlier versions, started with
> `npm start` in `APP_MODE=demo` (e.g. a Render web service without `APP_MODE=production`), seeded fictional data
> and listed demo accounts on the login page on an empty database. That code is gone: `npm start` now creates **no
> General Manager** and no data, so such a service starts with an empty database that nobody can sign in to (the log
> says `no users yet`). `npm run demo` asks for the username in a terminal, which a hosting platform does not have,
> and an embedded PGlite database on an ephemeral disk is lost at every deploy. A **public demo needs its own
> plan** (BACKLOG DEMO-1): where it runs, who bootstraps it, what sample data with client-approved names, how it
> is reset, and how it stays separate from production. Until then, show the system from a local `npm run demo` or a
> `dev:sample` database (docs/DEMO_SCRIPT.md).

## 1. Services

| Render resource | Settings |
|---|---|
| PostgreSQL | Any plan. Use the **Internal Database URL** for the web service, so traffic stays on Render's private network. |
| Web Service | Runtime **Node**, region the same as the database. |
| Build command | `npm ci --include=dev && npm run build` (the start command runs TypeScript through `tsx`, a dev dependency, so dev dependencies must be installed) |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Instances | **1** for now. The per-IP sign-in throttle and the login counters for unknown usernames are kept in process memory, and each instance keeps its own settings cache for up to 5 s. See "Remaining limits" below. |

## 2. Environment variables

| Variable | Value on Render | Why |
|---|---|---|
| `APP_MODE` | `production` | Turns on the start-up refusals, removes the "Demo" badge and refuses `npm run dev:sample`. (Since REM-3 there is no demo data in any mode: demo mode starts empty too.) |
| `DATABASE_URL` | Render's **Internal Database URL** (`postgresql://user:password@host/db`) | Required in production; embedded PGlite is refused. Render generates a strong password. Never reuse `postgres`, `password`, `admin`, `root`, `changeme`, `secret` or `123456`: they are refused. |
| `APP_ORIGIN` | `https://<your-service>.onrender.com`, or your custom domain, e.g. `https://erp.example.com` | Exact origin the browser uses (scheme + host, no trailing slash, no path). Must be `https://`. State-changing requests from any other origin are rejected (CSRF defence). If you add a custom domain later, update this value. |
| `TRUST_PROXY` | `1` to start with, then **verify** (section 4) | Number of proxy hops in front of the app. It decides which `X-Forwarded-For` entry becomes the client IP used in the audit log, the sessions list and the per-IP sign-in throttle. Unset means "no proxy": all users then appear with the proxy's IP. |
| `COOKIE_SECURE` | leave **unset** (defaults to `true` in production) | The session cookie is `__Host-jerp_session`: `Secure`, `HttpOnly`, `SameSite=Lax`. `false` is refused in production. |
| `LOG_LEVEL` | `info` | `warn` or `error` to reduce volume, `debug` only while diagnosing. Logs never contain bodies, query strings, cookies or passwords. |
| `NODE_VERSION` | `22` | Node 20 or newer is required; 22 is what the project is tested on. |
| `PORT` | **do not set** | Render provides it; the app reads it. |
| `MIGRATION_DATABASE_URL` | optional, recommended: the owner role (section 5) | Runs the migrations; the app then connects with `DATABASE_URL` as a runtime role that owns nothing. |
| `STRICT_DB_ROLES` | `true` once the roles are separated | Refuse to start if the runtime role could alter the audit log or the ledgers. |
| `WEBAUTHN_RP_ID` | leave **unset** (= the host of `APP_ORIGIN`), or the parent domain, e.g. `example.com` | The domain passkeys belong to. Must be the host of `APP_ORIGIN` or a parent of it; anything else is refused at start-up. **Changing it later invalidates every passkey** (section 8.1). |
| `WEBAUTHN_RP_NAME` | optional, e.g. the company name | Shown by Windows Hello / the phone when registering. Cosmetic. |
| `WEBAUTHN_UV_INITIAL` | optional: `required` (default) or `preferred` | **First start only**: initial value of "what a passkey must check" (section 8.4). Ignored once the setting exists. |
| `ALLOWED_KARATS_INITIAL` | optional, e.g. `21` | **First start only**: the initial list of allowed karats (comma-separated, 8–24; an invalid value stops the start). Ignored once the setting exists. The GM still confirms the list once (first-steps checklist). |
| `TWO_FACTOR_REQUIRED_ROLES_INITIAL` | optional, e.g. `GENERAL_MANAGER` (default) or empty | **First start only**: roles that must use a passkey. Empty = not enforced (accepted risk, section 8.7). Ignored once the setting exists. |

Secrets: the only secret is the database password inside `DATABASE_URL`. Keep it in Render's
environment settings (or an Environment Group), never in the repository. The app needs no signing key:
CSRF tokens and session ids are random values stored in the database. Rotating the database password
means updating `DATABASE_URL` and redeploying; all sessions survive because they live in the database.

Not used in production: `PGLITE_DIR` (embedded database for local demo mode only).

Backup variables (`BACKUP_*`) are listed in section 7; they belong to the backup job, not to the web service.

## 3. First start

1. Create the database and the web service with the variables above. Deploy. Migrations run
   automatically at start-up (forward-only; they never drop data).
2. Open the service's **Shell** tab and create the first General Manager and the branches:

   ```bash
   npm run bootstrap -w @jerp/backend -- --username o.abdelrahman --full-name "Owner Name" --full-name-ar "اسم المالك" \
     --branch "KRT:Khartoum Branch:فرع الخرطوم:Khartoum"
   ```

   It prints a one-time password that must be changed at the first sign-in, and refuses to run again once a
   General Manager exists. Further branches can be added later from **Branches → New branch** (GM only).
3. Sign in as the GM and change the password. The GM must then register a passkey and save the recovery codes
   before anything else opens (section 8: decide the final domain **first**). Then open **Settings** and set the company names, currency
   labels, invoice footer and logo.
4. The GM's home shows the **first steps** checklist until each step is done (REM-3):
   1. **Allowed karats** (mandatory): tick the karats and confirm (password re-confirmation; audited as
      "Allowed karats confirmed"). For this client: **21 only** (or start with `ALLOWED_KARATS_INITIAL=21`, then
      just confirm). Only these karats can be bought from a supplier, bought as a sellable scrap piece, priced, sold
      or delivered; broken scrap of any karat can still be bought. (The code default lists 18/21/22/24; nothing in
      the code assumes 21.)
   2. **Today's gold rate and the scrap rates** (Settings).
   3. **The first branch** (if the bootstrap created none).
   4. **A branch manager and a cashier** (Users).

   Until stock exists, the branch dashboard and the point of sale show an explanation instead of empty tables, and
   the header shows "Set today's rate" until a gold rate exists.
5. Still in **Settings** (Phase 4):
   - **Scrap buying rates (per gram)**: enter today's rate for every karat the branches buy as scrap (any karat 1–24
     can be added). Without a rate for a karat, scrap of that karat cannot be bought.
   - **Sales → Payment methods at the counter**: Cash, Bank transfer and Hasad by default. Card and mobile
     wallet stay off unless the client asks for them.
   - **Business rules → Scrap price tolerance** and **GM approval beyond tolerance**: check the values with the client.

### Operator console (shell access only)

Two recovery actions exist for the case where nobody can sign in. They are **not** reachable over HTTP;
you need the Render Shell (or SSH) for the service:

```bash
# Lift a sign-in lock (any user)
npm run ops -w @jerp/backend -- unlock --username o.abdelrahman

# Reset the General Manager's password (GM accounts only); prints a one-time password,
# ends all of that user's sessions and forces a password change at the next sign-in
npm run ops -w @jerp/backend -- reset-gm-password --username o.abdelrahman

# Lost every passkey AND the recovery codes: revoke all passkeys, invalidate the recovery codes,
# end the sessions; the next sign-in registers a new passkey (section 8.6)
npm run ops -w @jerp/backend -- reset-second-factor --username o.abdelrahman --confirm

# Account SECURITY-LOCKED after "This wasn't me" on a recovery-code sign-in (section 8.6): lifts the lock,
# revokes passkeys and codes, prints a NEW one-time password, ends sessions; new password + new enrollment
npm run ops -w @jerp/backend -- unlock-security-lock --username o.abdelrahman --confirm
```

All of them refuse to run unless `APP_MODE=production` and the production configuration is safe (pass
`--allow-non-production` only on purpose, e.g. against a staging copy). Each action is written to the
audit log as actor **System (operator-cli)** with the server host name and the OS user.

## 4. Verify that real client IPs reach the app

Do this once after the first deploy, and again after any change to the proxy, CDN or custom domain.

**a. Your own IP appears.**

1. On your phone, turn Wi-Fi **off** (mobile data), open a "what is my IP" page and note the address.
2. Sign in to the ERP from the phone.
3. On a computer, sign in as the GM and open **Active sessions**. The phone's session must show the
   address from step 1. Also check **Audit log**: the `LOGIN` entry must show the same IP.
4. If the address shown is a private one (`10.x`, `172.16–31.x`, `192.168.x`) or belongs to the hosting
   provider, the app is trusting **too few** hops: raise `TRUST_PROXY` by one, redeploy and repeat.

**b. A forged header is ignored.** From a computer, send a failed sign-in with a made-up forwarded address:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://erp.example.com/api/auth/login \
  -H 'Origin: https://erp.example.com' -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.77' \
  -d '{"username":"o.abdelrahman","password":"wrong-password"}'
```

It answers `401`. In **Audit log**, the matching `LOGIN_FAILED` entry must show **your computer's real IP**,
never `203.0.113.77`. If it shows `203.0.113.77`, the app is trusting **too many** hops: lower
`TRUST_PROXY` by one and redeploy. (This failed attempt counts toward the lockout of that user; one attempt
is harmless, and the GM, or the operator console, can unlock.)

**c. The per-IP sign-in throttle does not hit everyone at once.** The throttle blocks an IP address after 30 failed
sign-in attempts within 15 minutes. If every request appeared to come from the proxy's address, 30 failed attempts by
anyone would block sign-in for the whole company.

1. Sign in from two devices on **different networks** (phone on mobile data, computer on office Wi-Fi).
2. **Active sessions** must show two **different** IP addresses. If both show the same address, the IP is not
   being resolved (go back to step a).
3. Note: staff in one shop sharing one internet connection correctly share one IP. 30 failures per
   15 minutes is well above normal use, but a shared connection is the reason the limit is not lower.

## 5. Database roles and integrity rules

- **Why roles matter.** The append-only tables (`audit_logs`, `inventory_movements`, `item_status_history`,
  `gold_rates`, `settings_history`, `ledger_entries`, `cash_counts`) are protected by triggers and by missing
  privileges. A role that **owns** those tables can still drop the triggers or grant itself the privileges back,
  and a superuser ignores privileges altogether. So the app should run as a role that owns nothing.
- **One role (simplest, Render's default).** `DATABASE_URL` both migrates and runs the app. Migrations take
  UPDATE/DELETE/TRUNCATE away from it on the append-only tables, but it still owns them, so at every start the server
  logs `SECURITY WARNING: the database role can alter the append-only tables` with the fix. Acceptable for a trial,
  not for real money.
- **Separate owner and runtime roles (recommended for production).** See below. With `STRICT_DB_ROLES=true` the
  server refuses to start whenever the runtime role owns, or can update, delete or truncate, an append-only table.

### Separate owner and runtime roles

Run once, as a role that may create roles (the database's admin user; if your provider's default user cannot create
roles, create the two users in the provider's dashboard instead and run the GRANTs below). Replace `jewelry_erp` and
the passwords:

```sql
-- 1. As the admin user, connected to the application database:
CREATE ROLE jerp_owner LOGIN PASSWORD '<long random password 1>';   -- runs migrations, owns the tables
CREATE ROLE jerp_app   LOGIN PASSWORD '<long random password 2>';   -- the app connects as this role
GRANT CONNECT, CREATE ON DATABASE jewelry_erp TO jerp_owner;
GRANT CONNECT ON DATABASE jewelry_erp TO jerp_app;
GRANT USAGE, CREATE ON SCHEMA public TO jerp_owner;
GRANT USAGE ON SCHEMA public TO jerp_app;

-- 2. As jerp_owner, BEFORE the first migration: every table the migrations create is usable by the app…
ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jerp_app;
ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO jerp_app;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO jerp_app;
-- …and the migrations themselves take UPDATE/DELETE/TRUNCATE away again on every append-only table
-- (function jerp_lock_append_only, migration 0005).
```

Environment variables on the web service:

| Variable | Value |
|---|---|
| `MIGRATION_DATABASE_URL` | `postgresql://jerp_owner:<password 1>@<host>/jewelry_erp` (used only to run migrations at start-up and by `npm run migrate`) |
| `DATABASE_URL` | `postgresql://jerp_app:<password 2>@<host>/jewelry_erp` |
| `STRICT_DB_ROLES` | `true` |

`npm run migrate` applies pending migrations alone (with `MIGRATION_DATABASE_URL` when set) and exits; the server also
runs them at start-up. Bootstrap and the operator console accept the same variables.

**Switching an existing single-role database to separate roles** (as the admin user, after step 1 above; `old_role` is
the role that owned everything until now):

```sql
REASSIGN OWNED BY old_role TO jerp_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jerp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jerp_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO jerp_app;
-- then, as jerp_owner: step 2 above, and re-apply the append-only lock:
SELECT jerp_lock_append_only(t::regclass)
FROM unnest(ARRAY['audit_logs','inventory_movements','item_status_history','gold_rates','settings_history',
                   'ledger_entries','cash_counts']) AS t;
```

Start the service; the log must **not** contain `SECURITY WARNING: the database role can alter the append-only tables`.
A real-PostgreSQL test (`backend/test/pg/db-roles.test.ts`) builds exactly this setup and proves the runtime role can
neither change history rows nor disable, drop or bypass the triggers, nor grant itself the privileges back.

- **Start-up warning about NOT VALID constraints.** If old rows violate one of the integrity rules added in Phase 2a,
  that rule is left `NOT VALID` (it still applies to every new or changed row) and the server logs
  `integrity constraints left NOT VALID` with the table and constraint names at every start. Correct the rows,
  then run `ALTER TABLE <table> VALIDATE CONSTRAINT <name>;`. On a fresh database this never appears.
- **API clients other than the web app** must send an `Idempotency-Key` header (16–128 characters of `A–Z a–z 0–9 _ -`,
  one new key per business action, reused only for retries of that action) on: create sale, void sale, create
  purchase, create transfer, receive transfer, record a cash count and record a Hasad bank transfer.
  Without it the server answers `428`.

### Money ledger (Phase 2b)

- Upgrading an existing database creates the branch accounts (CASH, BANK, FUNDS_IN_TRANSIT) and backfills the
  item cost model, but **never creates ledger entries** for past sales or settlements. A real company's
  books start at the opening balance (Phase 3); until then the Cash screen only reflects events recorded after the
  upgrade. (Old demo databases from before REM-3 kept their seeded history; demo data no longer exists.)
- API clients: create sale, void sale and record a Hasad bank transfer store their
  idempotency record in the same transaction as the money movement; a retry with the same key returns the first
  result, and nothing is ever posted twice.

### Expenses removed (REM-1, migration 0013)

- Expenses are no longer part of the product (no screen, route, permission, setting or report). Migration 0013 deletes
  the `expenses.*` permissions and their role grants, and adds triggers that refuse new rows in `expenses` and new
  `EXPENSE` entries in `ledger_entries`. Existing rows stay untouched (history); a historical `EXPENSE` entry appears
  on the Cash screen under "Other movements", so the daily lines still add up to the ledger. REM-5 drops the table.

### Types, products and suppliers (CAT-0, migration 0015)

- The bootstrap command creates **no item types**, products or suppliers: the General Manager or a branch manager
  creates them (Inventory → **Types & products**, or inline from a supplier purchase or a sellable scrap purchase).
- A supplier purchase now **requires a supplier**.
- Migration 0015 adds the function `jerp_normalize_name`, normalized-name columns with unique indexes, `is_active`
  and `created_by`/`created_at` on types, products and suppliers, and makes the English names optional. **It stops
  without changing anything** if two existing types, products (same karat and type) or suppliers have names that are
  the same after normalization (أ/ا, ى/ي, tatweel, diacritics, digits, spaces, case); the error lists them. Rename or
  merge those rows, then run the migration again.

### Hasad reduced to a payment channel (REM-2, migration 0014)

- Hasad is only a payment method now (with the Hasad invoice number and an optional transaction reference) and the
  per-branch **Hasad receivable**, settled when Hasad's bank transfer arrives. The withdrawal workspace, counter
  sessions, weight-difference settlements, the simulator and the mock integration are gone; there is no connection to
  any external system.
- Migration 0014 releases any piece still RESERVED by an open counter session (status history and an audit entry per
  piece, actor System), deletes the `hasad.*` permissions and their grants, and adds triggers that refuse new rows in
  the Hasad tables, the `settlements` table, the `hasad_mock` schema and new `HASAD_SETTLEMENT` ledger entries.
  History stays; a historical `HASAD_SETTLEMENT` entry appears on the Cash screen under "Other movements". REM-5 drops
  the tables and the `hasad_mock` schema.

### Purchases, scrap and supplier settlement (Phase 4)

- Migration 0007 adds a **HASAD_RECEIVABLE** account to every branch (and to every future branch). Sales paid with
  Hasad are held there. Migration 0008 adds the settlement of that receivable: when Hasad's bank transfer reaches
  the branch's bank account, a branch manager or the GM records it on the Cash screen and the amount moves from
  the receivable to BANK (new append-only table `hasad_receivable_settlements`, new permission `cash.settle_hasad`).
- Purchases recorded **before** the upgrade have no gold debt (NULL): they are shown as "recorded before gold
  settlement" and cannot be settled with scrap. Nothing is backfilled.
- New append-only tables (`scrap_rates`, `scrap_purchases`, `scrap_weight_entries`, `supplier_settlements`) are
  locked like the other ledgers by the migration (`jerp_lock_append_only`); with separate owner and runtime roles
  (section 5) the start-up check covers them too.
- API clients: `POST /purchases` now stores its idempotency record in the same transaction (it pays the making
  charge), like scrap purchases and supplier settlements; a retry with the same key never pays or settles twice.

## 6. After every deploy

- `GET /api/health` returns `200`.
- The login page shows the company name and logo from Settings, not "Jewelry ERP".
- The login page lists no accounts, and the header shows no "Demo" badge (it appears only in `APP_MODE=demo`).
- The start-up log has no `integrity constraints left NOT VALID` warning (see section 5).
- `GET /api/health` shows `"backup": {"status": "OK", …}` once backups and restore drills run (section 7).
- Settings show **Allowed karats = 21** and a scrap buying rate for each karat the branches buy.

## 7. Backups

**This must be working, and the first restore drill done by a person, before any real data is entered.**

### What exists

| Command | What it does |
|---|---|
| `npm run backup` | `pg_dump` (custom format) of the application database as a **read-only backup role**, piped straight into `age` (encrypted at rest; no unencrypted file is ever written), plus a manifest (row counts, ledger and pool balances, CHECK constraints, taken in the **same snapshot** as the dump) and a `.sha256` checksum file. Then the **off-site upload command**, then the **retention** policy. Each run is recorded in the append-only `backup_runs` table. |
| `npm run backup:verify` | **Restore drill**: checks both checksums of the latest backup (or `-- --file <path>`), decrypts it, restores it into a **throwaway database**, and runs the integrity checks: row counts of every table = source; every ledger account balance (sum of its entries) = source, entries on the right branch, reversals mirror their original; every scrap-pool balance = source and none negative; supplier gold debt − settled = owed; every append-only table still has both triggers and they really refuse `UPDATE`, `DELETE` and `TRUNCATE`; every CHECK constraint of the source and of the code is present and validated. The throwaway database is always dropped. Any failure prints `RESTORE DRILL FAILED` and exits non-zero. |

Exit codes: `0` success, `1` failure, `2` refused (configuration). Use them to alert from your scheduler.

The test suite runs the whole cycle (backup → off-site copy → restore drill, plus damaged-file and
tampered-database cases) against a freshly seeded real PostgreSQL database (`backend/test/pg/backup.test.ts`).

### Recovery targets (state these to the client)

- **Maximum data loss (RPO) = the time between two backups.** With one backup a day, up to 24 hours of
  entries can be lost and must be re-entered from receipts. The health check warns after **26 hours**
  without a successful backup (setting *Backups → Warn after …*).
- **Time to restore (RTO)**: minutes for a database of this size, plus the time to fetch the file. Measure it
  during the first drill and write it down.
- **To lose less**: run `npm run backup` more often (e.g. every hour: RPO 1 hour; lower *Warn after* to 2
  hours), and/or enable the database provider's **point-in-time recovery** (continuous WAL archiving; on
  Render a paid PostgreSQL plan, self-hosted pgBackRest or WAL-G), which brings the loss down to seconds.
  The logical backups described here stay useful in any case: they are encrypted, off-site, and checked.

### 7.1 Tools

`pg_dump` and `pg_restore` of the **same major version as the server** (PostgreSQL 16 → `postgresql-client-16`)
and [`age`](https://github.com/FiloSottile/age) (`apt install age`). Set `BACKUP_PG_BIN` if `pg_dump` is not on `PATH`.

### 7.2 The read-only backup role (run once, as the owner role)

It must be neither the owner nor the runtime role. The script checks this and, in production, refuses to
run with a role that is a superuser, can create databases or roles, owns a table, can write to any table,
or is the `DATABASE_URL` / `MIGRATION_DATABASE_URL` role.

```sql
CREATE ROLE jerp_backup LOGIN PASSWORD '<long random password>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE <database> TO jerp_backup;
GRANT USAGE ON SCHEMA public, drizzle TO jerp_backup;
GRANT SELECT ON ALL TABLES    IN SCHEMA public, drizzle TO jerp_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO jerp_backup;
-- Tables created by future migrations (run as the owner role) are readable too:
ALTER DEFAULT PRIVILEGES FOR ROLE <owner role> IN SCHEMA public  GRANT SELECT ON TABLES    TO jerp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE <owner role> IN SCHEMA public  GRANT SELECT ON SEQUENCES TO jerp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE <owner role> IN SCHEMA drizzle GRANT SELECT ON TABLES    TO jerp_backup;
```

(On a self-hosted server where you are superuser, `GRANT pg_read_all_data TO jerp_backup;` replaces the
`GRANT SELECT` lines.) If a migration ever adds a schema, grant `USAGE` and `SELECT` on it too: `pg_dump`
fails loudly on any table it cannot read, so a missed grant shows up as a failed backup, never a partial one.

The restore drill needs a **different** role that may `CREATE DATABASE` on a scratch server
(`BACKUP_VERIFY_ADMIN_URL`; by default `MIGRATION_DATABASE_URL`). Prefer a separate PostgreSQL server for
drills, so a drill never competes with production.

### 7.3 The encryption key (age)

Create the key pair **on an administrator's computer, not on the server**:

```bash
age-keygen -o jerp-backup.key        # the SECRET key: password manager + a printed copy in a safe
age-keygen -y jerp-backup.key        # prints the PUBLIC key: age1…
```

The backup job only needs the **public** key (`BACKUP_AGE_RECIPIENT`); a stolen server therefore cannot read
old backups. Several recipients (comma-separated) let two people each hold a key. The secret key is needed
only for the drill and for a real restore (`BACKUP_AGE_IDENTITY`, or `BACKUP_AGE_IDENTITY_FILE` pointing at a
`0600` file). It is never written to the repository, never logged, and never passed to the upload command.
**Losing the secret key means losing every backup**: keep two copies in two places.

### 7.4 Variables

| Variable | Where | Meaning |
|---|---|---|
| `APP_MODE` | backup job | `production` ⇒ **strict**: refuses without encryption key, without upload command, or with an unsafe role. `BACKUP_STRICT=true` gives the same anywhere. |
| `BACKUP_DIR` | both | Local directory for backups (created `0700`, files `0600`). |
| `BACKUP_DATABASE_URL` | backup job | The read-only backup role (7.2). |
| `DATABASE_URL` | both | The app's runtime connection, used only to **record** runs in `backup_runs` (the backup role cannot write). |
| `BACKUP_AGE_RECIPIENT` | backup job | age public key(s). |
| `BACKUP_UPLOAD_COMMAND` | backup job | Shell command run after a successful encrypted dump; receives `BACKUP_FILE`, `BACKUP_CHECKSUM_FILE`, `BACKUP_MANIFEST_FILE`, `BACKUP_NAME`. A non-zero exit fails the backup. |
| `BACKUP_KEEP_DAILY` / `_WEEKLY` / `_MONTHLY` | backup job | Local retention, default **14 / 8 / 6** (newest backup of each of the last 14 days, 8 ISO weeks, 6 months, UTC). Off-site retention is set on the storage itself (below). |
| `BACKUP_AGE_IDENTITY` or `BACKUP_AGE_IDENTITY_FILE` | drill only | age secret key. |
| `BACKUP_VERIFY_ADMIN_URL` | drill only | Role allowed to create the throwaway database. |
| `BACKUP_PG_BIN`, `BACKUP_AGE_BIN` | optional | Tool locations. |

### 7.5 Off-site copy (required: a backup that lives only on the server it protects does not count)

Give the upload credentials **write-only** rights where possible, so that a compromised server cannot delete
older backups; set retention on the storage side.

**Example A: S3-compatible object storage** (AWS S3, Backblaze B2, Cloudflare R2, Wasabi), with the AWS CLI.
Enable bucket versioning and object lock, and a lifecycle rule (e.g. delete after 400 days):

```bash
BACKUP_UPLOAD_COMMAND='for f in "$BACKUP_FILE" "$BACKUP_CHECKSUM_FILE" "$BACKUP_MANIFEST_FILE"; do aws s3 cp "$f" "s3://jerp-backups/prod/" --only-show-errors || exit 1; done'
# credentials of an IAM user allowed only s3:PutObject on that prefix: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# and for B2/R2 also AWS_ENDPOINT_URL=https://<endpoint>
```

**Example B: another machine over SSH** (an office server or a second VPS in another data centre):

```bash
BACKUP_UPLOAD_COMMAND='rsync -a -e "ssh -i /etc/jerp/backup_ed25519 -o StrictHostKeyChecking=yes" "$BACKUP_FILE" "$BACKUP_CHECKSUM_FILE" "$BACKUP_MANIFEST_FILE" backup@offsite.example.com:/srv/jerp-backups/'
# on the receiving side, restrict that key in authorized_keys to rrsync (write into that directory only)
```

**Example C: any rclone remote** (Google Drive, OneDrive, Dropbox, SFTP…):
`BACKUP_UPLOAD_COMMAND='rclone copy "$BACKUP_FILE" offsite:jerp && rclone copy "$BACKUP_CHECKSUM_FILE" offsite:jerp && rclone copy "$BACKUP_MANIFEST_FILE" offsite:jerp'`

### 7.6 Schedule

**cron** on a server that has the tools (times in the server's timezone; Sudan is UTC+2):

```cron
# daily backup at 01:30, after closing
30 1 * * *  cd /srv/jerp && npm run backup        >> /var/log/jerp-backup.log 2>&1
# weekly restore drill (Sunday 03:00) on the drill machine, which holds the secret key
0 3 * * 0   cd /srv/jerp && npm run backup:verify >> /var/log/jerp-backup-verify.log 2>&1
```

**Render**: add a **Cron Job** service from the same repository, schedule `30 23 * * *` (UTC = 01:30 in
Khartoum), build command `npm ci`, command `npm run backup`, with the variables of 7.4 (no secret key).
Its disk is temporary, so the off-site copy is the real one. Run the weekly drill on a machine you control
(an office computer or a small VPS with PostgreSQL 16 and age): download the latest three files from the
off-site storage into `BACKUP_DIR`, then `npm run backup:verify` with `BACKUP_AGE_IDENTITY_FILE`,
`BACKUP_VERIFY_ADMIN_URL` (the local scratch server) and `DATABASE_URL` (production runtime role, used only to
record the drill so the health check sees it).

### 7.7 Monitoring

- `GET /api/health` always answers HTTP 200 (a stale backup must not make the host restart a healthy
  service) and includes `"backup": {"status": "OK" | "WARNING", "backupAgeHours", "verifyAgeHours", "reasons"}`
  — ages and status only. Point an uptime monitor at it with a keyword alert on `"WARNING"`.
- The General Manager sees a warning banner on the Executive Overview when the last successful backup is
  older than *Warn after … hours* (default 26) or the last successful drill older than *… days* (default 7)
  (**Settings → Backups**). A failed upload counts as a failed backup.

### 7.8 Restoring after a disaster (step by step)

1. **Stop the writes**: suspend the web service (Render: *Suspend*), so nothing is entered into a database you
   are about to replace. Tell the branches to keep paper receipts.
2. **Fetch** the latest backup's three files from the off-site storage and check them:
   `sha256sum -c jerp-backup-<time>.sha256`.
3. **Prove the file is good** on the drill machine: `npm run backup:verify -- --file ./jerp-backup-<time>.dump.age`.
4. **Create an empty database** owned by the owner role on the production server:
   `CREATE DATABASE jerp_restored OWNER <owner role>;`
5. **Restore** as the owner role, keeping the privileges (the runtime and backup roles must exist on the server):

   ```bash
   age -d -i jerp-backup.key jerp-backup-<time>.dump.age \
     | pg_restore --no-owner --role=<owner role> --exit-on-error --dbname="postgresql://<owner>:<pw>@<host>/jerp_restored"
   ```

6. **Re-check the locks**: as the owner, `npm run migrate` against the restored database (a no-op that confirms
   the schema version), then point `DATABASE_URL` / `MIGRATION_DATABASE_URL` at `jerp_restored` (or rename the
   databases) and resume the service. The start-up check reports any runtime-role privilege problem on the
   append-only tables (with `STRICT_DB_ROLES=true` it refuses to start).
7. **Check** `GET /api/health`, sign in as the General Manager, compare the Cash screen and the last invoices
   with the paper records, then **re-enter everything recorded after the backup time** (that is the data loss).
   Reconcile the sales paid through Hasad and Hasad's bank transfers with Hasad's own records.
8. Run `npm run backup` immediately, so the restored state is itself backed up.

### 7.9 Before go-live (human, not automated)

- [ ] The backup role exists and `npm run backup` succeeds in production mode (strict) with a real off-site copy.
- [ ] Someone other than the developer has done **a full restore drill by hand on a real copy** (7.8 steps 2–5
      against a scratch server), timed it, and written down the time and the result.
- [ ] Both copies of the secret key are stored, and a second person knows where.
- [ ] The scheduler runs daily backups and weekly drills; the GM banner and the health check show `OK`.

## 8. Passkeys (second sign-in factor)

The General Manager signs in with the password **and** a passkey. Decisions: `docs/decisions.md` §9 (D-2fa-*).

### 8.1 The domain (read before go-live)

- Passkeys are tied to a domain, the **RP ID**: by default the host of `APP_ORIGIN` (e.g. `erp.example.com`).
  The app refuses to start in production if `APP_ORIGIN` is not `https://…` or if `WEBAUTHN_RP_ID` is not that host
  or a parent of it. The start-up log line `server started` shows the `webauthnRpId` in use.
- **Changing the domain or the RP ID later makes every registered passkey useless** (the browser will not offer
  them on another domain). Choose the final domain **before** the GM registers. If it must change: before
  switching, make sure the GM still has unused recovery codes (or plan an operator reset), switch, then every
  user signs in with a recovery code and registers again — or run `reset-second-factor` for each user.
- Setting `WEBAUTHN_RP_ID` to the parent domain (`example.com`) keeps passkeys valid if the app later moves to
  another sub-domain of it. Leave it unset if unsure.
- Passkeys need a secure connection: https in production; `http://localhost` works for the demo.

### 8.2 Hardware

Any one of these works; **register two** (8.3):

- **Windows Hello** on the shop PC: a fingerprint reader, an IR face camera, or at least the Windows Hello PIN
  (Settings → Accounts → Sign-in options). The PIN is local to the PC; it is not the ERP password.
- **A USB FIDO2 security key** (e.g. YubiKey 5, Feitian, Google Titan). For `required` (8.4) choose one with a
  PIN or fingerprint and set its PIN once (Windows: Settings → Accounts → Sign-in options → Security key).
- **A phone** (Android 9+ with screen lock, iPhone iOS 16+). The PC uses it over Bluetooth after scanning a QR
  code; Bluetooth must be on, on both.

### 8.3 Register two devices

At the first sign-in the GM registers the PC and saves the 10 recovery codes (print them; keep them away from the
PC, e.g. in the safe). Then, from user menu → **Sign-in security** → **Add a device**: the phone (choose "iPhone,
iPad or Android device" in the Windows window and scan the QR code) or a second USB key. A banner reminds the GM
until a second device exists. A single device is a single point of failure.

### 8.4 What a passkey must check (Settings → Second factor)

- **Fingerprint, face or PIN — `required` (default, recommended).** The device itself checks who is there. A key
  that only needs a touch is refused. Someone who steals the key and the password still cannot sign in.
- **A touch is enough — `preferred`.** Also accepts simple USB keys with no PIN or fingerprint. Then the key **plus**
  the password is enough, so the key must be treated like a house key. Accepted risk only on these conditions:
  1. the key is **never left plugged into the PC**;
  2. **two keys are bought** (one kept in the safe);
  3. the choice is **reviewed when branches are added**.
  While this is selected the GM sees a permanent warning banner.
- Changing either value needs the password and a fresh passkey; it is recorded in the audit log. Switching back to
  `required` is refused unless the passkey used to confirm it checked the GM's fingerprint/face/PIN (so the GM
  cannot lock themselves out). Existing passkeys stay registered; a touch-only key stops working under `required`
  (use a recovery code or another device, or the operator reset).

### 8.5 Day to day

- Sign-in: password → "Use my passkey" → fingerprint/face/PIN (or the key / phone).
- Sensitive actions (rates, users, settings, adjustments…) ask for the password and the passkey again, then stay
  open for the re-confirmation window (Settings, default 5 minutes).
- **New-device alert**: a sign-in from a browser or passkey not seen in 30 days shows a red banner. "It was me"
  closes it. **"This wasn't me"** signs out every session, removes every passkey and forces a new password.
  - If that sign-in used a **passkey**: the GM signs in with the password + a recovery code, sets a new password,
    and registers the devices again.
  - If that sign-in used a **recovery code**: the code sheet is treated as stolen. All remaining codes stop
    working and the account is **locked**: every sign-in is refused (it looks like a wrong password) until the
    operator lifts it (section 8.6, step 5). The confirmation window warns the GM before this happens.

### 8.6 Lost or broken device (procedure)

1. **Another registered device is available** (phone, second key): sign in with it, open Sign-in security,
   **Remove** the lost device, then **Add a device** to replace it.
2. **No other device, but the recovery codes are at hand**: at the passkey step choose "Lost your device? Use a
   recovery code". Each code works once. Then remove the lost device and register a new one; if few codes remain,
   **Make new codes** (the old ones stop working).
3. **No device and no recovery codes**: the operator (shell access) runs
   `npm run ops -w @jerp/backend -- reset-second-factor --username <gm> --confirm`. All passkeys and codes are
   revoked and sessions ended; the GM signs in with the password and registers again. If the password may also be
   compromised, run `reset-gm-password` too. Both are recorded in the audit log as System (operator-cli).
4. If the device was **stolen** rather than lost, also use "This wasn't me" (or the operator reset) and change the
   password: a stolen device plus a known password is a full compromise under `preferred`.

5. **Account security-locked** (the GM reported a recovery-code sign-in as "not me", or cannot sign in at all and
   the audit log shows `ACCOUNT_SECURED` with a recovery code): only the operator can restore it.
   1. Confirm with the GM **in person or by phone** that they asked for it (the lock is the safe state; do not
      lift it on an e-mail).
   2. Run `npm run ops -w @jerp/backend -- unlock-security-lock --username <gm> --confirm`. It revokes every
      passkey and recovery code, ends the sessions and prints a **new one-time password**. The old password no
      longer works.
   3. Give the one-time password to the GM in person. The GM signs in, sets a new password, registers the PC and a
      second device, and prints the new recovery codes. Destroy the old sheet.
   4. Review the audit log from the reported sign-in onwards (`ACCOUNT_SECURED`, then the actions of that session).
   `reset-second-factor` refuses a locked account on purpose: the lock is never lifted without a new password.

### 8.7 Enforcement turned off (accepted risk)

Settings → Second factor → "Who must use a passkey" can untick the General Manager (password + passkey required to
do so; audited). Then a stolen GM password alone opens the account, and a red banner says so permanently. Only do
this temporarily, e.g. while replacing hardware, and record why in the "Reason" field. `TWO_FACTOR_REQUIRED_ROLES_INITIAL=`
(empty) starts a new installation this way, in production or demo mode (e.g. to try the app locally without a
passkey).

### 8.8 Before go-live (human)

- [ ] The final domain is set in `APP_ORIGIN` (and `WEBAUTHN_RP_ID` if a parent domain is wanted); the start-up log shows it.
- [ ] The GM registered the shop PC **and** a second device, printed the recovery codes, and signed in once with each device.
- [ ] Someone tried one recovery code (then made new codes) and knows where the sheet is kept.
- [ ] The operator knows the `reset-second-factor` command and has shell access.

## 9. Printing invoices and receipts

The browser prints: Chromium lays out the invoice (Arabic, the bundled font) and hands it to the **Windows printer
driver**. No ESC/POS commands, no printer-specific code. Decisions: `docs/decisions.md` §10 (D-print-*).

### 9.1 Choose the paper (Settings → Printing)

- **A4** (default) or **A5** for an office printer; **Receipt** for a thermal roll printer.
- **Receipt printable width**: the width the *driver* can print, **not** the roll width. Typically **72 mm on an 80 mm
  roll** and 48 mm on a 58 mm roll. Find it in the driver: Printer properties → Preferences / Advanced → Paper size
  (e.g. "80(72) x 297 mm", "Roll paper 80 x 3276 mm" with 72 mm printable).
- **Test print** prints a calibration page: a millimetre ruler as wide as the configured width, Arabic text, digits,
  a long line that must wrap, the logo and a barcode. The ruler must touch both paper edges and nothing may be cut off.

### 9.2 The shop PC

1. Install the printer's **Windows driver** (from the manufacturer; not "Generic / Text Only").
2. Make that printer the **Windows default printer** (Settings → Bluetooth & devices → Printers & scanners; turn off
   "Let Windows manage my default printer").
3. In the driver preferences set the paper (roll, 72 mm printable for an 80 mm roll), the cut mode ("cut after
   document/page") and, if offered, "paper saving / reduce top margin".
4. Open the ERP, Settings → Printing → **Test print**, and adjust the width (section 9.5) until the ruler is exact.

### 9.3 Silent printing (optional, recommended for the counter)

Chrome and Edge can print without the print window when started with `--kiosk-printing`. Use the template
`scripts/windows/create-erp-shortcut.cmd`: edit `APP_URL` (and the shortcut name), copy it to the shop PC, double-click it
once. It creates a desktop shortcut:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --no-first-run ^
  --user-data-dir="%LOCALAPPDATA%\JewelryERP\BrowserProfile" --app=https://erp.example.com
```

- `--kiosk-printing`: every print goes straight to the printer.
- `--user-data-dir`: a **dedicated browser profile**. The flag only takes effect when Chrome *starts*; a separate
  profile guarantees a fresh process even if Chrome is already open, and keeps its own print settings and no
  extensions. Sign in to the ERP once inside it (passkeys work there as well).
- `--app=<url>`: the ERP in its own window, without tabs or address bar.
- **Which printer**: the destination of the profile's last print; in a fresh dedicated profile that is the **Windows
  default printer**. Do not print from this profile to another printer, or that printer becomes the destination.
- Headers and footers: the template sets the per-user Chrome/Edge policy `PrintHeaderFooter = 0` so the date/URL lines
  never print, even on A4 (set `DISABLE_HEADER_FOOTER=0` in the file to skip this). Check `chrome://policy`.
- **No feedback**: silent printing reports neither success nor failure (paper out, printer off, wrong default). The
  sale is always saved first; if nothing came out, a **manager uses Reprint** (marked "نسخة / COPY n", audited).
- Without the shortcut the normal print window opens: choose the printer, Margins "Default", Headers and footers
  **off**, Scale 100 %.

### 9.4 Who may print what

- The cashier prints the invoice **once, right after the sale** (same session). Further prints are reprints.
- **Reprint** (Branch Manager, General Manager, permission `sales.reprint`) from the sale's page: every reprint is
  marked **"نسخة / COPY n"** with its date, increments the sale's reprint counter and writes `INVOICE_REPRINTED` to the
  audit log.
- Printed documents never show cost, acquisition cost, profit or gold debt, for any role.

### 9.5 Verify on the client's printer (the CSS page size is a request, not a guarantee)

Chrome sends `@page { size: 72mm <length>mm; margin: 0 }` for receipts and `size: A4/A5; margin: 10mm` for pages.
**Whether a given thermal driver honours that size must be checked on the real printer.** Symptoms and what to change:

| What you see | Cause | Fix |
|---|---|---|
| Text is tiny / the receipt looks shrunk | The driver kept an A4/Letter page and Chrome scaled to fit | In the print window set Scale 100 % once (kiosk keeps it), and in the driver choose the roll paper size (e.g. 80 × 297 mm / "80(72) x Receipt") |
| Right or left edge cut off | Width larger than the printable area | Lower **Receipt printable width** (72 → 70 → 68) and Test print again |
| Blank strip on one side | Width smaller than the printable area, or driver left margin | Raise the width, or set the driver's left margin to 0 |
| Long blank paper after each receipt | Driver ignores the page length and feeds a fixed page | Driver: paper "Receipt" / "roll", feed "cut at end of document", "reduce bottom margin / paper saving" on |
| Several receipts' worth of paper, cut mid-text | Driver page shorter than the receipt | Driver: a long roll paper size (e.g. 80 × 3276 mm) |
| Arabic letters disconnected or as boxes | Not the ERP: printer in "text/ESC-POS" mode or a generic driver | Install the manufacturer's Windows **graphics** driver |
| Faint barcode | Print density low | Driver: density/darkness up one step |

### 9.6 Before go-live (human)

- [ ] Test print on the real printer at the chosen width: ruler edge to edge, Arabic joined, nothing cut.
- [ ] One real sale printed from the POS (original), one reprint by a manager (COPY 1 visible, audit entry present).
- [ ] If silent printing is used: the shortcut opens the ERP, prints without a window, and the cashiers know that a
      missing receipt means "ask a manager to reprint".

## Remaining limits (known and accepted for now)

- **One instance.** The per-IP throttle and the dummy counters for unknown usernames are in memory, so a
  second instance would double the effective allowance, and settings changes reach other instances within
  5 s. Move the counters to PostgreSQL or Redis before scaling out.
- **Passkeys and the domain.** Moving to another domain invalidates every passkey (section 8.1).
- **The proxy's header format.** The app relies on `X-Forwarded-For` as the proxy writes it. If a CDN is
  added in front of Render, repeat section 4: the hop count usually changes.
