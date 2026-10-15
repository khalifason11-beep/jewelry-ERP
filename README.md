# Jewelry Retail ERP

A multi-branch ERP for a jewelry retailer. The interface is Arabic first (right to left), with an English switch.
It covers:

- item-level inventory, tracked by weight;
- the point of sale;
- supplier orders paid for in gold, and gold scrap bought from customers;
- a money ledger for each branch;
- the General Manager's funding of the branches;
- dashboards and reports;
- user and session administration;
- an append-only audit trail.

Gold is bought from suppliers and sold only in the karats chosen in Settings. Scrap is bought from customers in any
karat from 1 to 24. Nothing is connected to an external system: Hasad is a payment method whose references are typed
in by hand.

> **Status: pre-production.** Do not enter real client data until the production-readiness items in
> [docs/BACKLOG.md](docs/BACKLOG.md) §F are done: the hosting decision, the staging deployment, backups with a restore
> drill done by a person, passkeys on the real devices, hardware checks, training, a pilot run and a security review.
> Business questions that are still open with the client are listed in [docs/SPEC.md](docs/SPEC.md) and the backlog
> (Q-n).

Every database starts **empty**, in demo mode as in production: there are no seeded items, sales, customers,
suppliers or accounts.

## Quick start

Requirements: **Node.js 20 or newer** (22 LTS is the version tested). Nothing else is needed: the database is
embedded.

```bash
npm install
npm run demo          # builds the UI, creates the first General Manager if needed, starts http://localhost:4000
```

**`APP_MODE` is required** (`demo` or `production`, exactly; nothing else starts). `npm run demo`, `npm run dev` and
`npm run dev:sample` set `APP_MODE=demo` themselves, and the Codespace sets it too; anything else (for example
`npm start`) needs it in the environment. `APP_MODE=demo` is a local trial installation. It uses an embedded PostgreSQL database (PGlite) in
`.data/`, plain `http://localhost`, and shows a small **Demo** badge. On its first run, `npm run demo` sees that no
General Manager exists:

- **In an interactive terminal**, it asks for the General Manager's username, runs the real bootstrap and prints a
  **one-time password**, then starts the server. The username needs at least 8 characters and no role-style words
  such as "admin" or "manager". The one-time password must be changed at the first sign-in.
- **Without a terminal** (Codespaces start-up, CI), it prints the bootstrap command and stops:

  ```bash
  APP_MODE=demo npm run bootstrap -w @jerp/backend -- --username <your.name> --full-name "<Your Name>" [--full-name-ar "<الاسم>"]
  npm run demo
  ```

By default the General Manager must register a **passkey** at the first sign-in; passkeys work on
`http://localhost`. To try the app without one, start the server the first time with
`TWO_FACTOR_REQUIRED_ROLES_INITIAL=` (empty). This sets the stored setting once.

The home screen then shows **five first steps**:

1. Confirm the allowed karats.
2. Set today's gold rate and the scrap rates.
3. Create the first branch.
4. Add a branch manager and a cashier.
5. Fund the branch by recording an advance into its drawer.

To start over, stop the server and delete `.data/`. The embedded database supports only one process at a time.

**Codespaces:** on GitHub, open **Code → Codespaces → Create codespace** on `main`. The codespace runs `npm install`;
then run `npm run demo` in its terminal and open port 4000.

In a Codespace, do **not** set `APP_ORIGIN`: the port proxy rewrites the `Origin` header, and with `APP_ORIGIN` set the
sign-in is refused (403). The Codespace sets `APP_MODE=demo` and `TRUST_PROXY=1` itself (one proxy hop), so passkeys
use the public `…app.github.dev` address. Set the forwarded port to **Public** in the **Ports** tab and open the
address from there.

**A populated database** (for screenshots and trials):

```bash
PGLITE_DIR=.data/sample npm run dev:sample                             # fill a NEW, empty demo-mode database
APP_MODE=demo PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start   # serve it without a passkey
```

`dev:sample` refuses `APP_MODE=production` and any database that already has a user. It goes through the real
services to create:

- two branches and their staff, each branch funded;
- types and products, and a supplier order for each branch;
- sales paid by cash, bank transfer and Hasad;
- two scrap purchases and one transfer in transit.

Names are marked placeholders (`[عينة] …`) from `backend/src/dev/sample-names.json`. Generated passwords are printed
once.

**Other ways to run it:**

- `npm run dev`: hot reload, with the UI on http://localhost:5173.
- `DATABASE_URL=postgres://… npm run demo`: use a real PostgreSQL server instead of the embedded one.
- `APP_MODE=demo npm start`: serve an existing demo database without rebuilding.

**Windows:**

- PowerShell sets variables with `$env:NAME="value"`, for example
  `$env:TWO_FACTOR_REQUIRED_ROLES_INITIAL=""; npm run demo`, or `$env:APP_MODE="demo"; npm start`.
- If the server stops at start with "Cannot find native binding" (from `@node-rs/argon2`), delete `node_modules` and
  `package-lock.json` and run `npm install` again. Commit the regenerated lockfile only if `npm run check:lockfile`
  still passes.

## Roles and what each one sees

There are three fixed roles. The permissions are listed in `shared/src/permissions.ts`; the role grants cannot be
edited in the app.

| Role | Scope | Works with |
|---|---|---|
| Cashier | Own branch | Point of sale (available pieces only, discount up to the role limit), own sales, own sessions. No cost, profit or supplier figure anywhere. |
| Branch manager | Own branch | Everything the cashier does, plus: branch home, sales list, voids, reprints, inventory (price edits, damage/restock/return), types, products and suppliers, scrap purchases, supplier settlement with scrap, transfers, Cash (reconciliation, counts, Hasad settlement), reports, users and sessions of the branch (read), audit. No cost or profit figures. |
| General Manager | All branches | Everything, plus three things only the General Manager can do: record supplier orders (`purchases.create`), see and manage funding (`funding.view`, `funding.manage`), and see cost and profit. Also manages users, settings, rates, branches and the second factor. |

## Money model

- Money is stored as integers in the currency's smallest unit. Each branch has five ledger accounts:

  | Account | What it holds |
  |---|---|
  | `CASH` | The drawer |
  | `BANK` | The branch's bank account |
  | `FUNDS_IN_TRANSIT` | Money on its way |
  | `HASAD_RECEIVABLE` | Hasad sales that Hasad has not paid yet |
  | `OWED_TO_GM` | What the branch owes the General Manager. A liability, never counted as money. |

- Ledger entries are append-only and signed; a balance is the sum of its entries. An entry is written in the same
  transaction as the business change it records, and a correction is a reversing entry. The event types are:
  - `SALE`, `SALE_VOID` and `REVERSAL`;
  - `SCRAP_PURCHASE`;
  - `HASAD_RECEIVABLE_SETTLEMENT`;
  - `GM_ADVANCE` and `GM_REPAYMENT`;
  - `SUPPLIER_MAKING_CHARGE`, which is historical and no longer written.
- **Sales** post to the account of their payment method:
  - cash goes to `CASH`;
  - bank transfer goes to `BANK`, with the transfer reference;
  - Hasad goes to `HASAD_RECEIVABLE`, with the Hasad invoice and transaction references.

  When Hasad's bank transfer arrives, a manager records it and the amount moves from `HASAD_RECEIVABLE` to `BANK`.
- **The General Manager's funding:**
  - An advance into a branch's drawer or bank increases that account and `OWED_TO_GM`.
  - A repayment does the reverse.
  - A mistaken event can be corrected once, by a reversal.
  - Only the General Manager sees this, on the Cash page.
- **The drawer never pays out money it does not hold.** A cash outflow larger than the drawer balance is refused
  (`409 DRAWER_SHORT`), and the message says what to do. The outflows covered are the cash part of a scrap purchase,
  a cash refund on a void, a repayment from the drawer, and the correction of a drawer advance.
- **The bank may go below zero.** A bank payment is never refused. Instead it raises a critical attention signal
  (A17) until an advance is recorded.
- **Scrap** is paid in cash, by bank transfer, or both (split). The two parts are stored separately, and the bank
  part carries a bank reference.
- **Making charges on supplier orders** are paid by the owner from the owner's personal account (`OWNER_PERSONAL`). The order
  records only the fact of the payment, with the transfer reference and date, which only the General Manager sees. No
  branch money moves and no ledger entry is written. A reference already used on another order raises a warning,
  never a refusal.
- **Cost and profit** are visible to the General Manager only. Every database column and API field is classified COST
  or SAFE (`shared/src/field-classification.ts`).

## Gold model

- Weights are integers in milligrams, and the karat is 1–24. Stock is also shown as its 24K equivalent.
- **Allowed karats** (Settings, confirmed at the first step) limit what can be bought from suppliers, priced and sold.
- **Pieces** are items with a code, a weight, a karat, a selling price and a status. Every status change and stock
  movement is logged. A piece comes from opening stock, a supplier, or sellable scrap bought from a customer.
- **Broken scrap** is not an item. It is weight added to the branch's scrap pool, and it counts in the branch's total
  stock weight.
- **Supplier orders are gold for gold.** The supplier is owed the order's weight as pure 24K gold. A manager settles
  that debt with broken scrap from the pool only, in as many partial visits as needed.
- Recording a new order for a supplier who is still owed gold triggers a warning (`SUPPLIER_GOLD_OWED`) with the
  weight, the oldest order and its age. The General Manager can then "Record anyway", which is audited.
- **Scrap purchases** use today's scrap rate per karat. A price outside the tolerance needs the General Manager.
- **Transfers** move pieces between branches in two steps: sent (in transit), then received. The courier's name is
  recorded.

## Security summary

- **Passwords:** hashed with Argon2id. An account locks after 5 failures, for 15 → 30 → 60 minutes. Sign-in is also
  throttled per IP.
- **Sessions** are held on the server. The cookie is HttpOnly and SameSite=Lax (Secure in production). A session signs
  out after 60 minutes idle and ends after 12 hours at most. Changes require a CSRF token.
- **Second factor:** passkeys (WebAuthn) with 10 single-use recovery codes. The General Manager must use one by
  default; the branch manager is optional.
  - A sign-in from a new device raises an alert with "This wasn't me".
  - If that sign-in used a recovery code, "This wasn't me" puts the account under a security lock, which only the
    operator can lift.
- **Re-confirmation** of the password, plus the passkey for users who have one, is required for:
  - settings, rates, scrap rates, allowed karats and the logo;
  - branches;
  - creating users, password resets, and changes to a user's role or branch;
  - inventory adjustments, funding, the second-factor settings, and removing a passkey;
  - sale voids (every void, by default).
- **Authorization:** one table (`shared/src/route-matrix.ts`) maps each route to a permission and a scope, and a
  central guard enforces it. A route that is not in the table cannot be registered, and the tests are generated from
  the table.
- **Database integrity:**
  - CHECK constraints (`shared/src/db-checks.ts`) keep values valid.
  - Append-only tables are protected by triggers, and by revoked privileges for the runtime role.
  - Money and stock writes require an `Idempotency-Key`; a retry returns the first result.
- Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/decisions.md](docs/decisions.md).

## Testing and gates

```bash
npm test                     # every suite on embedded PGlite
TEST_DATABASE_URL=postgres://<role with CREATEDB, CREATEROLE, not superuser>@localhost:5432/postgres npm test
                             # …and again on real PostgreSQL, plus the race and privilege tests (backend/test/pg)
npm run test:pg -w @jerp/backend   # CI: fail instead of skipping when TEST_DATABASE_URL is missing
npm run typecheck            # check:lockfile, check:hasad, check:migrations, check:drizzle, check:test-imports,
                             # check:assets, check:docs, then tsc on every workspace
npm run i18n:check           # hardcoded English, missing Arabic keys (--strict exits non-zero)
npm run build
```

Browser and system checks (they use Playwright with the pre-installed Chromium):

- `scripts/e2e-states.mjs`: screen states, notices and axe accessibility checks.
- `scripts/e2e-print.mjs`: invoices exported to PDF.
- `scripts/e2e-passkeys.mjs`: a virtual authenticator.
- `scripts/capture-ui-baseline.mjs` and `scripts/capture-ui-kit.mjs`: screenshots.
- `npm run rehearsal` (REH-1, needs `REHEARSAL_ADMIN_URL`): the first day of an installation on an empty database, in
  production mode, on real PostgreSQL, behind a local TLS proxy.
- `node scripts/perf-homes.mjs` (needs `REHEARSAL_ADMIN_URL`): times the homes and the attention list on a large
  database, and fails above a p95 of 300 ms.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request (no secrets, read-only permissions). Its jobs:

| Check name | What it runs | Required for `main` |
|---|---|---|
| `typecheck` | `npm run typecheck` (every static gate, then tsc) | yes |
| `test-pglite` | the test suites on embedded PGlite | yes |
| `test-postgres` | the test suites on PostgreSQL 16, including the race and privilege tests | yes |
| `build` | `npm run build` and `npm run i18n:check` | yes |
| `smoke` | REH-1 and the headless e2e scripts | not at first (slow, browser-dependent) |

Locally, `npm run verify` runs the same gates in order (`-- --full` adds REH-1, the e2e scripts and perf).

## Production mode

`APP_MODE=production` removes the Demo badge, refuses `dev:sample`, and **refuses to start** while the configuration is
unsafe. The start-up log lists every problem it finds.

| Variable | Notes |
|---|---|
| `APP_MODE` | **Required**, exactly `production` (absent, empty or misspelt stops the server and every CLI) |
| `DATABASE_URL` | Real PostgreSQL (PGlite and well-known default passwords are refused) |
| `APP_ORIGIN` | The `https://` origin users open; mutations from any other origin are rejected |
| `TRUST_PROXY` | Number of proxy hops in front of the app; decides the client IP in the audit log |
| `MIGRATION_DATABASE_URL`, `STRICT_DB_ROLES=true` | Migrations run as the owner role; the app runs as a runtime role that owns nothing |
| `COOKIE_SECURE` | Defaults to `true` (`__Host-` cookie) |

**Hosting is not decided yet** (BACKLOG HOST-1). The application needs:

- one Node.js process (single instance for now);
- a managed PostgreSQL database;
- HTTPS terminated by a reverse proxy;
- a final domain before any passkey is registered;
- shell access for the operator commands;
- a schedule for `npm run backup` and `npm run backup:verify` with an off-site copy.

The first General Manager is created once with `npm run bootstrap -w @jerp/backend -- --username … --full-name …
[--branch CODE:NameEn:NameAr:City]`. It creates the roles and permissions, the listed branches and the General Manager,
and prints a one-time password; it refuses to run again. Migrations run at start-up (`npm run migrate` runs them
alone).

Environment variables, roles SQL, backups, passkeys and printing: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Operator commands

These need shell access to the server. They refuse to run outside production unless given `--allow-non-production`,
and every action is audited.

```bash
npm run ops -w @jerp/backend -- unlock --username <user>                           # lift a sign-in lock
npm run ops -w @jerp/backend -- reset-gm-password --username <gm>                  # one-time password for a GM
npm run ops -w @jerp/backend -- reset-second-factor --username <user> --confirm    # lost every passkey and code
npm run ops -w @jerp/backend -- unlock-security-lock --username <user> --confirm   # after "This wasn't me"
```

## Documentation map

| Document | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Standing rules for every change: workflow, hard rules, gates, what needs the owner's approval |
| [docs/FEATURES.md](docs/FEATURES.md) | What the system does today, by capability |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, layers, request path, security mechanisms |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables, migrations 0000–0022, ledger, append-only tables |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production configuration, database roles, upgrades, backups, passkeys, printing; Appendix A: Render as a worked example, not a decision |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | How to present the system |
| [docs/BACKLOG.md](docs/BACKLOG.md) | The single backlog: done, to do, blocked on client questions, production readiness |
| [docs/SPEC.md](docs/SPEC.md) | The specification and the open client questions (Q-n) |
| [docs/decisions.md](docs/decisions.md) | Every decision, with its reason (append-only) |
| `docs/plans/`, `docs/acceptance/` | Plan and owner acceptance script of each phase |
| `docs/ux/`, `docs/design-reference/` | UX analysis, tokens, mockups |
| [docs/archive/](docs/archive/) | Historical documents: the first analysis of the prototype (`phase0-report.md`) |

## Repository layout

```
shared/      enums, permissions and roles, route matrix, settings registry, field classification, DB checks, money
database/    Drizzle schema, client (PostgreSQL or PGlite), SQL migrations 0000–0022
backend/     Express API: auth, authorization guard, modules (sales, inventory, purchases, scrap, ledger, funding,
             cash, transfers, attention, reports, …), CLIs (bootstrap, demo, migrate, ops, backup), dev sample, tests
frontend/    React + Tailwind UI, Arabic (RTL) and English
scripts/     gates (check-*), i18n check, demo, e2e and capture scripts, REH-1 rehearsal, perf
docs/        see the map above
```
