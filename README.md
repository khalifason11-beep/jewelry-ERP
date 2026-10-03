# Jewelry Retail ERP — Client Demo Prototype

A working prototype of a multi-branch jewelry retail ERP: item-level inventory, point of sale,
**Hasad Gold** withdrawal redemption with weight-difference settlement, branch profitability,
executive dashboards, user & password administration, active-session monitoring and a full audit trail.

> **Prototype scope.** All data is fictional demo data. There is **no connection** to any real
> server, database, or the real Hasad Gold system. Hasad Gold is simulated by a mock service that
> implements the same interface the real integration will use.

## Quick start

Requirements: **Node.js 20+** (nothing else — the database is embedded).

**No local install:** on GitHub open the repository → **Code → Codespaces → Create codespace**. Dependencies
and demo data are set up automatically, the app starts on port 4000 and opens in a browser tab
(`.devcontainer/devcontainer.json`). Set the port's visibility to *Public* in the **Ports** tab to open it on a phone.

Locally (Node.js ≥ 20):

```bash
npm install
npm run demo          # builds the UI and starts everything on http://localhost:4000
```

On first start the embedded PostgreSQL (PGlite) database is created in `.data/` and filled with
~30 days of realistic demo activity relative to *today*. To rebuild the demo data at any time:

```bash
npm run db:reset      # stop the server first (the embedded DB is single-process)
```

…or, while the app is running, sign in as General Manager → **Settings → Reset demo data**.

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

## Demo accounts (fictitious credentials)

| Username | Password | Role | Branch |
|---|---|---|---|
| `general.manager` | `demo-gm-2026` | General Manager | All branches |
| `branch.manager.kh` | `demo-bm-2026` | Branch Manager | Khartoum |
| `cashier.kh.01` | `demo-cashier-2026` | Cashier | Khartoum |
| `cashier.kh.02` | `demo-cashier-2026` | Cashier | Khartoum |
| `branch.manager.omd` | `demo-bm-2026` | Branch Manager | Omdurman |
| `cashier.omd.01` | `demo-cashier-2026` | Cashier | Omdurman |

Also available: `branch.manager.bhr`, `cashier.bhr.01`, `branch.manager.pzu`, `cashier.pzu.01`.
The login page lists the main accounts; click one to fill the form.

Hasad pickup codes for the demo: **HG-10025 → 482913** (Ahmed Mohamed, 4.200 g, Khartoum),
HG-10027 → 640218, HG-10026 → 193577, HG-10028 → 775104.

## What to show the client

See **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)**. It is a 12-step walkthrough covering cashier, branch manager
and general manager views, a normal sale, a Hasad withdrawal (both settlement directions),
inventory movement, profit, drill-down, active sessions and the audit trail.

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, layout, domain rules, configurable items, assumptions, plan |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables, relationships, traceability, ledger |
| [docs/HASAD_INTEGRATION.md](docs/HASAD_INTEGRATION.md) | The `HasadService` contract and how to replace the mock |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | Step-by-step client presentation |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production behind a reverse proxy (Render): env vars, first start, operator console, verifying client IPs |
| [docs/decisions.md](docs/decisions.md) | Every decision taken under ambiguity, with how to change it |

## Repository layout

```
shared/               domain enums, permissions & default roles, settlement rule, settings defaults
database/             Drizzle schema, client factory (PostgreSQL | PGlite), SQL migrations
integrations/hasad/   HasadService interface + MockHasadService (isolated `hasad_mock` schema)
backend/              Express API: auth, authz, modules (sales, hasad, inventory, …), seed, tests
frontend/             React + Tailwind UI (POS, dashboards, reports, admin), i18n EN/AR (RTL)
docs/                 architecture & presentation material
scripts/i18n-check.mjs  localization scanner (`npm run i18n:check`)
```

### Production mode

`APP_MODE=demo` (default) is the self-contained demo: embedded database, demo data, demo accounts on the
login page, Hasad simulator and "Reset demo data". **`APP_MODE=production`** turns all of that off and refuses
to start unless the deployment is safe:

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
The server also refuses to start while any demo account still accepts its published demo password.

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
- **No duplicates from double clicks or retries**: sales, voids, purchases, expenses, expense reviews, transfers,
  transfer receipts and Hasad completions require an `Idempotency-Key` header; a repeated request returns the first
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
  original payment method), approved expenses (from the drawer or the bank) and Hasad settlements post their entries
  in the same database transaction as the business change. Entries can never be edited or deleted; a balance is
  always the sum of its entries; corrections are reversing entries.
- **Cash** screen (branch managers: own branch; GM: all): expected cash in each drawer now, and the daily
  reconciliation — opening cash, sales by payment method, cancellations, expenses, settlements, expected cash, the
  counted cash and the difference.

### Purchases, scrap gold and supplier settlement (Phase 4)

- **Karat restriction**: only the karats in *Settings → Allowed karats* (21 for this client) can be bought from a
  supplier, priced, sold or delivered. Broken scrap of any karat can still be bought.
- **Three kinds of stock**: new pieces from suppliers, sellable scrap pieces bought from customers (both are items in
  Inventory, filterable by origin, karat and weight), and **broken scrap**, which is never an item but weight in the
  branch's **scrap pool**. The pool counts in the branch's **total stock weight** (raw by karat and as 24K) on the
  dashboards, in the inventory report and in the new *Stock Weight* report.
- **Scrap gold** screen (branch managers, GM): buy from a customer at today's scrap buying rate (set by the GM in
  Settings, per karat), within the allowed price tolerance; paid from the drawer or by bank transfer.
- **Supplier purchases are gold for gold**: the supplier is owed the pieces' weight as 24K pure gold; the making
  charge is the only money paid, immediately, from the drawer or the bank. When the supplier's representative visits,
  the branch manager settles the order on its purchase page **with broken scrap from the pool only** (weight and
  karat; never cash or bank), in as many partial visits as needed. The gold owed is visible to the GM only.
- **POS payment methods**: Cash, Bank transfer and **Hasad** (with the Hasad invoice number and transaction
  reference). Hasad payments are held in the branch's Hasad receivable.
- **Transfers**: a branch manager ticks pieces on the Inventory screen and sends them with one *Transfer selected*
  button (one transfer); the Transfers screen keeps the full log and the receipt confirmation.

### Language

The UI opens in Arabic (RTL) by default; the header switch toggles English. English source strings are the
translation keys (`t('…')`, with `{param}` interpolation); Arabic lives in `frontend/src/lib/i18n-ar.ts`.
Amounts and weights always use Western digits; dates use Arabic month names in Arabic. API errors carry a
stable `key` + `params` so the client shows them in the active language. Audit-log entries work the same way:
`writeAudit({ key, params })` stores `description_key` + `description_params` (money and weights stay numeric via
`ap.money()` / `ap.mg()` and are formatted by the client); `description` keeps the English rendering as a fallback.
Demo data is seeded in Arabic (customer names, expense descriptions, notes and reasons).

`npm run i18n:check` reports hardcoded English in JSX and toast/`done()` calls, keys without an Arabic
translation (UI, API errors, audit keys, field labels), English template-literal `description:` values in the
backend, and English free text in seed data (`--strict` exits non-zero).
