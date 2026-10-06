# Jewelry Retail ERP

A multi-branch jewelry retail ERP: item-level inventory, point of sale (cash, bank transfer and Hasad as
payment channels), purchases from suppliers and customers, a money ledger per branch, branch profitability,
executive dashboards, user & password administration, active-session monitoring and a full audit trail.

> **No demo data.** Every database, in demo mode as in production, starts **empty**: no items, sales, customers,
> suppliers or accounts (BACKLOG REM-3). There is **no connection** to any external system: Hasad is a payment method
> with manually typed references.

## Quick start

Requirements: **Node.js 20+** (nothing else — the database is embedded).

Locally (Node.js ≥ 20):

```bash
npm install
npm run demo          # builds the UI, creates the first General Manager if needed, starts http://localhost:4000
```

`APP_MODE=demo` (the default) is a local trial installation: an embedded PostgreSQL (PGlite) database in `.data/`,
plain `http://localhost`, and a small neutral **Demo** badge in the header. It starts **empty**, exactly like
production. On the first run `npm run demo` sees that no General Manager exists and:

- **in an interactive terminal**, asks for the General Manager's username (the normal rules: at least 8 characters,
  letters, digits, `.`, `-`, `_`, no role-style words such as "admin" or "manager"), runs the real bootstrap and
  prints a **one-time password** (changed at first sign-in); then the server starts;
- **without a terminal** (Codespaces start-up, CI), prints the full bootstrap command and exits without starting:

  ```bash
  npm run bootstrap -w @jerp/backend -- --username <your.name> --full-name "<Your Name>" [--full-name-ar "<الاسم>"]
  npm run demo
  ```

Then sign in as the General Manager. A General Manager needs a **passkey** at first sign-in (the default security
setting; passkeys work on `http://localhost`). To try the app without one, start the server the first time with
`TWO_FACTOR_REQUIRED_ROLES_INITIAL=` (empty), which sets the stored setting once (`TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm run demo`).

The home screen then shows the **first steps** checklist:

1. **Allowed karats** (mandatory): confirm the karats the shop works with (default 18, 21, 22 and 24;
   `ALLOWED_KARATS_INITIAL=21` sets the initial list on the first start).
2. **Today's gold rate and the scrap rates** (Settings).
3. **The first branch** (Branches).
4. **A branch manager and a cashier** (Users).

Until stock exists, the branch dashboard and the point of sale say so instead of showing empty tables.

To start over, stop the server and delete the `.data/` folder (the embedded database is single-process).

**No local install:** on GitHub open the repository → **Code → Codespaces → Create codespace**
(`.devcontainer/devcontainer.json`). The codespace installs the dependencies; in its terminal run `npm run demo`
and answer the username question, then open port 4000 (set its visibility to *Public* in the **Ports** tab to open
it on a phone).

### A populated local database (screenshots, trials)

```bash
PGLITE_DIR=.data/sample npm run dev:sample                       # fill a NEW, empty demo-mode database
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start   # serve it (no passkey needed)
```

`dev:sample` is a development tool: it refuses `APP_MODE=production` and any database that already has a user. It
creates two branches, staff, types, products, a supplier order per branch, a few sales (cash, bank transfer, Hasad),
scrap purchases and one transfer in transit, all through the real services. Names come from
`backend/src/dev/sample-names.json` and are **marked placeholders** (`[عينة] …`) until the owner supplies real,
client-approved names. Generated passwords are printed once (`--json` prints the accounts as JSON).
`scripts/capture-ui-baseline.mjs` uses it for the screenshot baseline.

Development mode (hot reload, UI on http://localhost:5173):

```bash
npm run dev
```

Use a real PostgreSQL server instead of the embedded one:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/jewelry_erp npm run demo
```

Run the tests. Without `TEST_DATABASE_URL` every suite runs on embedded PGlite (fast, no install) and a warning says the
real-PostgreSQL project was skipped. With it, every suite runs a second time on real PostgreSQL, plus the race and
privilege tests in `backend/test/pg/` (each test file gets its own database, dropped afterwards):

```bash
npm test
# real PostgreSQL too — the role needs CREATEDB and CREATEROLE and must NOT be a superuser:
TEST_DATABASE_URL=postgres://jerp_test:secret@localhost:5432/postgres npm test
# CI: fail instead of skipping when TEST_DATABASE_URL is missing
npm run test:pg -w @jerp/backend
```

### Windows install

- Use **Node.js 22 LTS** (the version the project is tested on; 20 is the minimum).
- PowerShell sets environment variables with `$env:NAME="value"` (not `NAME=value` as in the Linux examples), e.g.

  ```powershell
  $env:TWO_FACTOR_REQUIRED_ROLES_INITIAL=""; $env:PORT="4000"; npm run demo
  ```

- If the backend stops at start with **"Cannot find native binding"** (from `@node-rs/argon2`), npm skipped a native
  binary (npm bug #4828; typically a `node_modules` folder copied from another computer or left over from an older
  install). Fix: delete the `node_modules` folder **and** `package-lock.json`, then run `npm install` again
  (in PowerShell: `Remove-Item -Recurse -Force node_modules, package-lock.json; npm install`). Do not commit the
  regenerated lockfile unless `npm run check:lockfile` still passes.
- `npm run check:lockfile` (also part of `npm run typecheck`) fails if `package-lock.json` lacks the Windows, Linux or
  macOS binary of any native package.

## What to show the client

See **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)**: the first start on an empty database (first-steps checklist,
empty states), then daily work for the cashier, branch manager and General Manager on a `dev:sample` database.

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, layout, domain rules, configurable items, assumptions, plan |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables, relationships, traceability, ledger |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | Step-by-step presentation on a sample database |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production behind a reverse proxy (Render): env vars, first start, operator console, verifying client IPs |
| [docs/decisions.md](docs/decisions.md) | Every decision taken under ambiguity, with how to change it |

## Repository layout

```
shared/               domain enums, permissions & default roles, route matrix, settings defaults
database/             Drizzle schema, client factory (PostgreSQL | PGlite), SQL migrations
backend/              Express API: auth, authz, modules (sales, inventory, purchases, ledger, …), dev sample, tests
frontend/             React + Tailwind UI (POS, dashboards, reports, admin), i18n EN/AR (RTL)
docs/                 architecture & presentation material
scripts/i18n-check.mjs  localization scanner (`npm run i18n:check`)
```

### Production mode

`APP_MODE=demo` (default) is the local trial installation described above: embedded database, plain
`http://localhost`, the **Demo** badge; it starts empty and has no demo data, demo accounts or reset action.
**`APP_MODE=production`** removes the badge, refuses `npm run dev:sample`, and refuses to start unless the
deployment is safe:

| Variable | Required in production | Notes |
|---|---|---|
| `APP_MODE` | `production` | |
| `DATABASE_URL` | yes | Real PostgreSQL; embedded PGlite and well-known default passwords are refused |
| `APP_ORIGIN` | yes | `https://…` origin of the app; mutations from other origins are rejected |
| `COOKIE_SECURE` | (default `true`) | Session cookie is `__Host-jerp_session`, HttpOnly, Secure, SameSite=Lax |
| `TRUST_PROXY` | when behind a proxy | e.g. `1` for one reverse proxy; otherwise `X-Forwarded-For` is ignored |
| `LOG_LEVEL` | no | `info` (default), `warn`, `error`, `debug` |

First start of a production database:

```bash
APP_MODE=production DATABASE_URL=… APP_ORIGIN=https://erp.example.com \
  npm run bootstrap -w @jerp/backend -- --username o.abdelrahman --full-name "Owner Name" --full-name-ar "الاسم" \
  --branch "KRT:Khartoum Branch:فرع الخرطوم:Khartoum"
```

This creates the roles, permissions and categories, the listed branches and the first General Manager, and prints
a one-time password (it must be changed at first sign-in). It refuses to run again once a General Manager exists.
The server also refuses to start while any account from the old (pre-REM-3) demo data still accepts its published
demo password.

Authentication: Argon2id password hashes, lockout after 5 failures (15 → 30 → 60 min, the GM can unlock), per-IP
throttling, idle sign-out after 60 min without user input (all roles, changeable by the GM in Settings) and a 12 h absolute
session limit, CSRF tokens, and password re-confirmation for rate, role, settings, branding, branch and
inventory-adjustment changes. See `docs/decisions.md`.

Deploying behind Render or another reverse proxy: follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** (exact env
vars, and how to check that real client IPs reach the audit log).

Migrations run automatically at start-up; `npm run migrate` applies them alone. For production, run migrations as an
owner role (`MIGRATION_DATABASE_URL`) and the app as a runtime role that owns nothing (`DATABASE_URL`), with
`STRICT_DB_ROLES=true`: see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) §5 for the exact SQL.

Operator console (needs shell access to the server; refuses to run outside `APP_MODE=production` unless given
`--allow-non-production`; every action is audited):

```bash
npm run ops -w @jerp/backend -- unlock --username <user>
npm run ops -w @jerp/backend -- reset-gm-password --username <gm user>
```

### Settings, branding and branches

- **Settings** (GM, Settings screen): each setting is one row with a version and an append-only history
  (`settings_history`: old value, new value, who, when, optional reason). The typed registry with each key's
  validation and default is `shared/src/settings.ts`. Every change needs the password re-entered and is audited.
- **Branding**: company names (EN/AR), currency labels, invoice footer and logo come from Settings and appear on the
  login page, header, browser title and invoices. Nothing company-specific is hard-coded. Logos: PNG, JPEG or WebP
  (checked by content), at most 512 KB and 1024×1024 px; SVG is refused.
- **Branches** (GM, Branches → New branch / Edit): validated, audited, re-auth required. Branch codes are unique and
  can never be changed.
- **Permissions**: one route → permission → scope table (`shared/src/route-matrix.ts`) drives a central guard;
  a route not in the table cannot be registered, and the tests are generated from the table for every route and
  role. Cost, acquisition cost and profit figures are removed from API responses for everyone except the General
  Manager.

### Data integrity (Phase 2a)

- **Database rules**: every status column only accepts its known values, weights and money cannot be negative, net
  weight ≤ gross, karat 1–24, totals equal their parts. The list lives in `shared/src/db-checks.ts`; a test fails if
  the database and the list ever differ.
- **Append-only ledgers**: the audit log, inventory movements, item history, gold rates and settings history cannot be
  edited, deleted or emptied — refused by database triggers and, on PostgreSQL, by the app role's missing privileges.
- **No duplicates from double clicks or retries**: sales, voids, purchases, transfers,
  transfer receipts and cash counts require an `Idempotency-Key` header; a repeated request returns the first
  result instead of creating a second record.
- **Exact arithmetic**: money and weights are integers; rounding is exact and symmetric (`shared/src/money.ts`).
- **Cost visibility**: every database column and every API field is classified COST or SAFE in
  `shared/src/field-classification.ts`; tests fail if anything is unclassified or if a cost figure reaches a branch
  manager or cashier (including amounts inside audit texts).

### Cost model and money ledger (Phase 2b)

- **Items** record where they came from (opening stock, supplier, scrap), their **acquisition cost** (for supplier
  pieces including the making charge, also kept apart) and whether that cost is an estimate. **Sale lines** store the
  acquisition-cost snapshot and the profit. Cost and profit are General-Manager-only.
- **Every branch has a money ledger** (CASH drawer, BANK, funds in transit). Sales, cancellations (through the
  original payment method), scrap purchases, supplier making charges and Hasad bank transfers post their entries
  in the same database transaction as the business change. Entries can never be edited or deleted; a balance is
  always the sum of its entries; corrections are reversing entries.
- **Cash** screen (branch managers: own branch; GM: all): expected cash in each drawer now, and the daily
  reconciliation — opening cash, sales by payment method, the drawer and bank movements line by line (they always
  add up to the ledger; anything without its own line shows as "Other"), expected cash, the counted cash and the
  difference. (Expenses were removed: BACKLOG REM-1.)

### Purchases, scrap gold and supplier settlement (Phase 4)

- **Karat restriction**: only the karats in *Settings → Allowed karats* (21 for this client) can be bought from a
  supplier, priced, sold or delivered. Broken scrap of any karat from 1 to 24 can still be bought.
- **Three kinds of stock**: new pieces from suppliers, sellable scrap pieces bought from customers (both are items in
  Inventory, filterable by origin, karat and weight), and **broken scrap**, which is never an item but weight in the
  branch's **scrap pool**. The pool counts in the branch's **total stock weight** (raw by karat and as 24K) on the
  dashboards, in the inventory report and in the new *Stock Weight* report.
- **Scrap gold** screen (branch managers, GM): buy from a customer at today's scrap buying rate (set by the GM in
  Settings, per karat), within the allowed price tolerance; paid from the drawer or by bank transfer.
- **Supplier purchases are gold for gold**: the supplier is owed the pieces' weight as 24K pure gold; the making
  charge is the only money paid, immediately, from the drawer or the bank. When the supplier's representative visits,
  the branch manager settles the order on its purchase page **with broken scrap from the pool only** (weight and
  karat; never cash or bank), in as many partial visits as needed. The branch manager sees the gold still owed and
  the balance after each settlement; money costs (making charge, acquisition cost) stay GM-only.
- **POS payment methods**: Cash, Bank transfer and **Hasad** (with the Hasad invoice number and transaction
  reference). Hasad payments are held in the branch's Hasad receivable; when Hasad's bank transfer arrives, the
  branch manager records it on the Cash screen (*Settle Hasad receivable*) and the amount moves to the bank.
- **Transfers**: a branch manager ticks pieces on the Inventory screen and sends them with one *Transfer selected*
  button (one transfer); the Transfers screen keeps the full log and the receipt confirmation.

### Backups (Phase 2c)

- `npm run backup`: encrypted (age) `pg_dump` by a read-only role, checksummed, copied off-site by an operator
  command, with 14 daily / 8 weekly / 6 monthly retention. `npm run backup:verify`: restore drill into a throwaway
  database with integrity checks (ledger and pool balances, append-only triggers, CHECK constraints, row counts).
- The health check and a GM banner warn when the last backup (26 h) or drill (7 days) is too old.
- Setup, schedules, off-site examples and the step-by-step restore are in [docs/DEPLOYMENT.md §7](docs/DEPLOYMENT.md).
  **The first restore drill must be done by a person before real data is entered.**

### Passkeys: second sign-in factor (Phase 2fa)

- The General Manager signs in with the **password, then a passkey**: Windows Hello (fingerprint, face or PIN) on
  the shop PC, a USB FIDO2 security key, or a phone. Built on `@simplewebauthn/server` and `@simplewebauthn/browser`.
- First sign-in: register a device and save **10 single-use recovery codes**; nothing else opens until both are done.
  A banner asks for a second device until one exists. Screen: user menu → **Sign-in security** (passkeys, recovery
  codes, last 10 sign-ins, phone instructions).
- Sensitive actions ask for the password **and** the passkey (users who have one). New-device sign-ins raise an alert
  with **"This wasn't me"** (ends every session, revokes the passkeys, forces a new password; if that sign-in used a
  recovery code, the remaining codes are cancelled and the account is locked until the operator runs
  `unlock-security-lock`).
- Settings → **Second factor**: who must use it (GM by default; Branch Manager optional; never cashiers) and what a
  passkey must check (`required` = fingerprint/face/PIN, or `preferred` = a touch is enough). Changes need password + passkey.
- Lost everything: `npm run ops -w @jerp/backend -- reset-second-factor --username <u> --confirm` (shell only).
- **Demo mode** follows the same rules (works on `http://localhost`). `TWO_FACTOR_REQUIRED_ROLES_INITIAL=` (empty) on
  the first start sets "nobody must use it" once, to try the app without a passkey.
  Browser check with a virtual authenticator: `scripts/e2e-passkeys.mjs`.
- Setup, domain warning, hardware and the lost-device procedure: [docs/DEPLOYMENT.md §8](docs/DEPLOYMENT.md).

### Printing invoices and receipts

- One print module renders each document (invoice, recovery codes, printer test page) into a
  print-only container with its own `@page` rule, then the browser prints through the Windows driver (no ESC/POS).
- Settings → **Printing**: A4 (default), A5 or a thermal **Receipt** at the driver's printable width (72 mm on an 80 mm
  roll), auto-print after a sale (off by default) and a **Test print** calibration page.
- Invoice data is built on the server from a cost-free whitelist (`POST /sales/:id/print`): never cost, profit or gold
  debt, for any role. The cashier prints once right after the sale; managers **Reprint** (marked "نسخة / COPY n",
  counted, audited).
- Silent printing shortcut for Chrome/Edge: `scripts/windows/create-erp-shortcut.cmd`. Browser check with PDF export:
  `scripts/e2e-print.mjs` (sample PDFs in `docs/print-check/`). Setup and driver troubleshooting:
  [docs/DEPLOYMENT.md §9](docs/DEPLOYMENT.md).

### Language

The UI opens in Arabic (RTL) by default; the header switch toggles English. English source strings are the
translation keys (`t('…')`, with `{param}` interpolation); Arabic lives in `frontend/src/lib/i18n-ar.ts`.
Amounts and weights always use Western digits; dates use Arabic month names in Arabic. API errors carry a
stable `key` + `params` so the client shows them in the active language. Audit-log entries work the same way:
`writeAudit({ key, params })` stores `description_key` + `description_params` (money and weights stay numeric via
`ap.money()` / `ap.mg()` and are formatted by the client); `description` keeps the English rendering as a fallback.

`npm run i18n:check` reports hardcoded English in JSX and toast/`done()` calls, keys without an Arabic
translation (UI, API errors, audit keys, field labels), English template-literal `description:` values in the
backend (`--strict` exits non-zero).
