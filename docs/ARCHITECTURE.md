# Architecture

> Replaced in DOC-1. The previous file described the prototype: a Hasad simulator, demo seed, scrypt hashes,
> reservations and expenses. None of that exists any more. What follows is the current system. For features see
> [FEATURES.md](FEATURES.md); for tables see [DATA_MODEL.md](DATA_MODEL.md); for the reasons behind each choice see
> [decisions.md](decisions.md).

## 1. Stack and packages

npm workspaces, TypeScript everywhere, Node.js ≥ 20. It runs as one process: the API also serves the built UI.

| Package | Role | Main libraries |
|---|---|---|
| `shared` (`@jerp/shared`) | Code used by both server and browser: enums, permissions and roles, the route matrix, the settings registry, the field classification, the DB-check list, money and weight arithmetic | zod |
| `database` (`@jerp/database`) | Drizzle schema (`src/schema.ts`), client factory, SQL migrations `migrations/0000…0023` | drizzle-orm, pg, @electric-sql/pglite |
| `backend` (`@jerp/backend`) | Express API, auth, central guard, business modules, CLIs, tests | express 5, helmet, @node-rs/argon2, @simplewebauthn/server, vitest |
| `frontend` | React single-page app, Arabic RTL and English | react 19, react-router 7, @tanstack/react-query, tailwindcss 4, vite |

**Database:**

- Production uses PostgreSQL.
- Demo, development and the default test project use PGlite, an embedded PostgreSQL in WebAssembly, so the SQL is
  the same.
- Migrations are plain SQL and run at start-up (`npm run migrate` runs them alone). They run as an owner role
  (`MIGRATION_DATABASE_URL`). The app runs as a runtime role that owns nothing (`STRICT_DB_ROLES=true`).

## 2. Request path

```
browser ──HTTPS──▶ reverse proxy ──▶ Express
   helmet (CSP) → JSON body → /api: authenticate (session cookie) → CSRF check → central guard
   → zod-validated handler → module service (one DB transaction) → cost redaction → JSON
```

- **Authentication** (`backend/src/auth/middleware.ts`):
  - Sessions are held on the server; only a hash of the token is stored.
  - The cookie is `__Host-jerp_session` in production.
  - Sessions have an idle and an absolute limit.
  - The client sends a heartbeat that feeds presence on the sessions screen.
- **CSRF** (`core/csrf.ts`): a token per session, required on every change, plus an origin check against
  `APP_ORIGIN`.
- **Central guard** (`core/guard.ts` + `shared/src/route-matrix.ts`):
  - Every route is declared once, with its permission, its scope (`public`, `self`, `none`, `global` or `branch`) and
    its flags: `reauth`, `idempotent` and `idempotencyInTx`.
  - Access is denied by default. A route missing from the matrix cannot be registered.
  - The tests are generated from the matrix for every route and role.
- **Branch scope:** `scope.all_branches` (the General Manager) sees every branch. Everyone else is pinned to their own
  branch, and a request for another branch's data gets 403.
- **Re-confirmation** (`auth/reauth.ts`): routes flagged `reauth` need the password, plus the passkey for users who
  have one, within the last `security.reauthWindowMinutes` (5).
  - Some handlers ask for it conditionally: a user's role or branch change, and a sale void above
    `sales.voidReauthAboveAmount`.
- **Idempotency** (`core/idempotency.ts`): routes that create business records require an `Idempotency-Key`.
  - Repeating a request returns the stored response.
  - On money routes (`idempotencyInTx`), the key is claimed inside the same transaction that writes the ledger.
- **Cost redaction** (`core/cost-redaction.ts`):
  - Services already leave out cost and profit for callers without `profit.view`.
  - The response filter is a second line: it removes every field classified COST in
    `shared/src/field-classification.ts`, at any depth, including the parameters of audit texts.
  - A test fails on any field that is not classified.
- **Errors** carry a stable English `key` plus `params`. The browser translates them, so the backend has no Arabic
  text.

## 3. Business modules (`backend/src/modules`)

| Module | Owns |
|---|---|
| `auth`, `sessions`, `users` | Sign-in, passkeys, recovery codes, new-device alerts, sessions, user administration |
| `settings`, `branding`, `branches`, `setup`, `bootstrap` | Settings with history, logo and names, branches, first steps, first General Manager |
| `catalog`, `inventory`, `stock` | Types, products, suppliers; pieces, price edits, adjustments; stock and weight figures |
| `sales`, `print` | Point of sale, voids, invoices and reprints |
| `purchases`, `supplier-settlements` | Supplier orders (gold owed, making charge paid by the owner, SUP-1 warning), settlement with broken scrap |
| `scrap` | Scrap rates, scrap purchases (cash, bank or split), the broken-scrap pool |
| `ledger`, `funding` | Branch ledger accounts and balances, drawer-short refusal; the General Manager's advances, repayments, corrections |
| `transfers` | Two-step transfers between branches |
| `dashboard`, `attention`, `reports` | Homes, the attention list, reports |
| `backups`, `ops` | Backup status; operator commands |

- **Status changes:** every status change of a piece goes through one guarded function, a conditional update on the
  current status, so a piece can never be sold twice.
- **Numbering:** document numbers come from `document_sequences` within the transaction, in the form
  `<branch>-<type>-NNNNNN`. The types are:
  - `INV` invoices; `PO` supplier orders; `SCR` scrap purchases;
  - `SST` supplier settlements; `HRS` Hasad settlements;
  - `GMA`, `GMR`, `GMX` for funding (advance, repayment, correction);
  - `CO-TRF` for transfers.

  Pieces are numbered `J-n`, with a barcode.
- **Time:** the business day is computed in `company.timezone`.

## 4. Data integrity

- **Integers only:** money is an integer in the currency's smallest unit, and weight is an integer in milligrams. The
  arithmetic is in `shared/src/money.ts`.
- **CHECK constraints** (`shared/src/db-checks.ts`) cover statuses, signs, net ≤ gross, karat 1–24, and totals equal
  to their parts. A test compares the live database with this list.
- **Append-only tables** are protected by `jerp_forbid_modification` triggers (UPDATE, DELETE and TRUNCATE), and on
  PostgreSQL by revoked privileges for the runtime role (`jerp_lock_append_only`). The list of tables is in
  DATA_MODEL.md.
  - At start-up, a check verifies that the runtime role can alter none of the tables in `APPEND_ONLY_TABLES`
    (`backend/src/core/startup.ts`). A test (`backend/test/append-only-list.test.ts`, both projects) fails if that list
    differs from the tables the migrations lock (CLN-1).
- **Ledger:** a balance is always the sum of its entries, and entries are written in the same transaction as the
  business change.
  - A cash outflow takes a row lock on the branch's accounts before checking the drawer (`DRAWER_SHORT`).
  - Readers filter by account kind, so `OWED_TO_GM` is never counted as money (guardrail test).

## 5. Production safety

`APP_MODE` is required and must be exactly `demo` or `production`; absent, empty or misspelt stops the server and
every CLI before anything is opened (`parseAppMode`, D-cln1-1).

`APP_MODE=production` refuses to start when:

- the database is PGlite;
- a database password is well known;
- `APP_ORIGIN` is not HTTPS;
- an old demo account still accepts its published password;
- or the configuration is otherwise unsafe.

The checks are in `productionConfigProblems` (`core/startup.ts`), and the start-up log lists every problem. Bootstrap
and the operator commands are CLIs that need shell access (`backend/src/*-cli.ts`). Backups are `pg_dump` encrypted
with age, run by a read-only role, with a restore drill (`npm run backup`, `npm run backup:verify`).

## 6. Frontend

- Routes are in `frontend/src/App.tsx`. Each one is wrapped in a permission `Guard` that mirrors the server.
- The server is the authority: the UI only hides what the user cannot use.
- Data is fetched with React Query. Every list has loading, empty, error and not-allowed states.
- The shell has a top bar with the attention count, and a notice area for what must interrupt.
- **Homes:** the General Manager's is `/overview`; the branch manager's is `/dashboard`.
- **i18n:** English strings are the keys, and Arabic is in `frontend/src/lib/i18n-ar.ts`. RTL is the default.
- Design tokens and mockups are in `docs/ux/` and `docs/design-reference/`.
- Dates, times and "today" are shown in the company time zone from the session (`lib/zone.ts`), never the
  browser's zone; the server computes business days in the same `company.timezone`.
- Printing: one print module renders into a print-only container with its own `@page` rule, and the browser prints
  it.

## 7. Tests and gates

- `npm test` runs vitest. There are two projects, PGlite and real PostgreSQL (`TEST_DATABASE_URL`); the latter adds
  the race and privilege tests. Every test file gets its own database.
- `npm run typecheck` chains the static gates and then `tsc`:
  - `check:lockfile`: native binaries for every OS;
  - `check:hasad`: the Hasad footprint allow-list;
  - `check:migrations`;
  - `check:drizzle`: the schema matches the migrations;
  - `check:test-imports`;
  - `check:assets`;
  - `check:docs`: the documentation drift guard.
- `npm run i18n:check` finds hardcoded English and missing Arabic translations.
- The browser scripts are listed in the README. `npm run rehearsal` (REH-1) replays the first day on an empty
  production-mode database. `scripts/perf-homes.mjs` sets a 300 ms p95 budget for the homes and the attention list.
