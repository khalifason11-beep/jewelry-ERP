# Deployment behind a reverse proxy (Render or similar)

This guide covers a production deployment where the app runs behind a managed reverse proxy or load
balancer that terminates HTTPS, for example a Render Web Service with a Render PostgreSQL database.
The app is a single Node.js service: the API serves the built React app too, so no separate static
site is needed.

> Production mode refuses to start while the configuration is unsafe (see D-1a-10 in
> [decisions.md](decisions.md)). If the service does not come up, read the start-up log first: it lists
> every problem it found.

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
| `APP_MODE` | `production` | Turns off demo data, demo accounts, the Hasad simulator and "Reset demo data", and turns on the start-up refusals. |
| `DATABASE_URL` | Render's **Internal Database URL** (`postgresql://user:password@host/db`) | Required in production; embedded PGlite is refused. Render generates a strong password. Never reuse `postgres`, `password`, `admin`, `root`, `changeme`, `secret` or `123456`: they are refused. |
| `APP_ORIGIN` | `https://<your-service>.onrender.com`, or your custom domain, e.g. `https://erp.example.com` | Exact origin the browser uses (scheme + host, no trailing slash, no path). Must be `https://`. State-changing requests from any other origin are rejected (CSRF defence). If you add a custom domain later, update this value. |
| `TRUST_PROXY` | `1` to start with, then **verify** (section 4) | Number of proxy hops in front of the app. It decides which `X-Forwarded-For` entry becomes the client IP used in the audit log, the sessions list and the per-IP sign-in throttle. Unset means "no proxy": all users then appear with the proxy's IP. |
| `COOKIE_SECURE` | leave **unset** (defaults to `true` in production) | The session cookie is `__Host-jerp_session`: `Secure`, `HttpOnly`, `SameSite=Lax`. `false` is refused in production. |
| `LOG_LEVEL` | `info` | `warn` or `error` to reduce volume, `debug` only while diagnosing. Logs never contain bodies, query strings, cookies or passwords. |
| `NODE_VERSION` | `22` | Node 20 or newer is required; 22 is what the project is tested on. |
| `PORT` | **do not set** | Render provides it; the app reads it. |
| `MIGRATION_DATABASE_URL` | optional, recommended: the owner role (section 5) | Runs the migrations; the app then connects with `DATABASE_URL` as a runtime role that owns nothing. |
| `STRICT_DB_ROLES` | `true` once the roles are separated | Refuse to start if the runtime role could alter the audit log or the ledgers. |

Secrets: the only secret is the database password inside `DATABASE_URL`. Keep it in Render's
environment settings (or an Environment Group), never in the repository. The app needs no signing key:
CSRF tokens and session ids are random values stored in the database. Rotating the database password
means updating `DATABASE_URL` and redeploying; all sessions survive because they live in the database.

Not used in production: `PGLITE_DIR` (embedded demo database only).

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
3. Sign in as the GM, change the password, then open **Settings** and set the company names, currency
   labels, invoice footer and logo. Enable Hasad Gold per branch only when the Hasad integration is live.
4. Still in **Settings** (Phase 4):
   - **Business rules → Allowed karats**: set to **21 only** for this client. Only these karats can be bought from a
     supplier, bought as a sellable scrap piece, priced, sold or delivered; broken scrap of any karat can still be
     bought. (The code default lists 18/21/22/24; nothing in the code assumes 21.)
   - **Scrap buying rates (per gram)**: enter today's rate for every karat the branches buy as scrap. Without a rate
     for a karat, scrap of that karat cannot be bought.
   - **Sales & expenses → Payment methods at the counter**: Cash, Bank transfer and Hasad by default. Card and mobile
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
```

Both refuse to run unless `APP_MODE=production` and the production configuration is safe (pass
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
  purchase, create expense, review expense, create transfer, receive transfer and complete Hasad withdrawal.
  Without it the server answers `428`.

### Money ledger (Phase 2b)

- Upgrading an existing database creates the branch accounts (CASH, BANK, FUNDS_IN_TRANSIT) and backfills the
  item cost model, but **never creates ledger entries** for past sales, expenses or settlements. A real company's
  books start at the opening balance (Phase 3); until then the Cash screen only reflects events recorded after the
  upgrade. (Demo databases are the one exception: in `APP_MODE=demo` their history is re-posted at start-up.)
- API clients: create sale, void sale, create expense, review expense and complete Hasad withdrawal store their
  idempotency record in the same transaction as the money movement; a retry with the same key returns the first
  result, and nothing is ever posted twice.

### Purchases, scrap and supplier settlement (Phase 4)

- Migration 0007 adds a **HASAD_RECEIVABLE** account to every branch (and to every future branch). Sales paid with
  Hasad are held there; how Hasad pays the shop is not designed yet, so the balance only accumulates.
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
- No demo accounts are listed on the login page (they are listed only in demo mode).
- The start-up log has no `integrity constraints left NOT VALID` warning (see section 5).
- Settings show **Allowed karats = 21** and a scrap buying rate for each karat the branches buy.

## Remaining limits (known and accepted for now)

- **One instance.** The per-IP throttle and the dummy counters for unknown usernames are in memory, so a
  second instance would double the effective allowance, and settings changes reach other instances within
  5 s. Move the counters to PostgreSQL or Redis before scaling out.
- **The proxy's header format.** The app relies on `X-Forwarded-For` as the proxy writes it. If a CDN is
  added in front of Render, repeat section 4: the hop count usually changes.
