# SAFE-1 — change safely, deploy safely

A hardening item. No business rule, screen, route behaviour, setting, text or number the owner sees changes. One
concern per commit, the suites green after each, each pushed. The branch was fast-forwarded to `main` (`eb40856`).

## What I checked in the code (before relying on the brief)

- **Destructive migrations:** a gate already exists, `scripts/check-migrations.mjs`, run by `typecheck`.
  - It is **stricter** than the brief: every `DELETE FROM`, `DROP COLUMN`, `RENAME`, `REVOKE` and more is refused
    unless the statement carries `-- allow-destructive: <reason>`.
  - What is missing is detection of an edited applied migration (checksums).
- **Migrations are forward-only** (drizzle journal plus `drizzle.__drizzle_migrations`). A second run is a no-op by
  design; a test will prove it.
- **The upgrade harness exists:** `backend/test/migration-harness.ts`, `openAt(n)`. It works on PGlite and on a fresh
  PostgreSQL database.
  - Data fixtures cannot contain supplier orders: migration 0022 refuses, by design, any database holding orders paid
    from branch money (D-mkc-5), and orders from before 0022 always are.
  - The upgrade fixtures therefore cover everything except `purchases`. That refusal is already tested in
    `mkc1-migrations.test.ts`.
- **Production start-up already refuses** a missing or invalid `APP_MODE`, `DATABASE_URL`, `APP_ORIGIN` (https only),
  insecure cookies, an inconsistent WebAuthn RP ID, demo passwords and, with `STRICT_DB_ROLES=true`, an owning runtime
  role.
  - **Missing:** an explicit `TRUST_PROXY` decision, an explicit `STRICT_DB_ROLES` decision, and the migration-role
    strategy.
- **Health:** `/health` always answers 200 with the backup status. There is no readiness check.
- **Shutdown:** SIGTERM closes the pool and exits at once. The HTTP server is never closed, so in-flight requests are cut.
  - Money writes are single transactions, so a cut can roll back but cannot leave half a write. A test will prove it
    with SIGKILL during concurrent sales.
- **Pool:** `max: 10`, no timeouts, and **no `error` listener**. node-postgres emits `error` when an idle connection
  dies (a database restart), and with no listener **the process crashes**. This is a real bug.
- **Logging:**
  - One JSON line per API request, with secret-named keys redacted.
  - No request id.
  - Errors carry a code but never a stack, in every mode.
- **Limits:**
  - Body 100 kB (the logo 512 kB).
  - Sign-in: 5 failures lock the account for 15→60 min, and 30 failures per IP per 15 min.
  - The passkey step has its own failure lock on the same thresholds.
  - Write endpoints have **no** rate limit (needs your decision).
- **Time:** server code computes days with `company.timezone`. No local-time call was found.
- **Static files:** the backend serves `frontend/dist`. Every file is cached for 1 h, hashed assets included, so they
  are not immutable. `index.html` revalidates. Fix: hashed assets immutable for 1 year, `index.html` `no-cache`.
- **Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities.
- **Secrets:** none in the tree; test passwords only. `.env` is ignored. There is **no `.env.example`**.

## Commits (in order)

0. `CLAUDE.md` with the standing rules and gate commands; linked from the README.
1. CI: `.github/workflows/ci.yml`.
   - Jobs: `typecheck`, `test-pglite`, `test-postgres` (PostgreSQL 16 service), `build`, and `smoke` (REH-1 and the
     headless e2e scripts).
   - `smoke` is separate and is proposed as **not required at first**: it is slow (≈10 min).
   - Required checks are listed in the README and `CLAUDE.md`.
2. Migration checksums:
   - `database/migrations/checksums.json` (committed manifest, sha256 per file).
   - `check:migrations` fails if an applied file changed, or if a file is not in the manifest.
   - New migrations (above 0022) must cite a `D-` decision in their `allow-destructive` marker.
   - Why a manifest: it works in shallow CI clones and offline, and every change to it shows up in review.
3. Upgrade test:
   - Fixtures at 0015 and at 0019 with realistic rows (branches, users, sessions, passkeys, items, history, movements,
     sales, sale lines, ledger, scrap, cash counts, audit, settings, rates).
   - Upgrade to the latest version, then assert: row counts and money and ledger sums identical; append-only triggers
     present and refusing; no `NOT VALID` constraint; `/health` answers.
   - A second migrate run is a no-op.
   - Rollback story in DEPLOYMENT.
4. Pool: the `error` listener plus explicit env settings, with safe defaults.
   - `PG_POOL_MAX` 10, `PG_STATEMENT_TIMEOUT_MS` 30000, `PG_IDLE_IN_TX_TIMEOUT_MS` 60000,
     `PG_CONNECT_TIMEOUT_MS` 10000.
   - Applied to the app pool only, never to migrations.
   - Test: terminate every backend connection, and the app still answers.
5. Graceful shutdown: close the HTTP server, let in-flight requests finish (15 s timeout), then close the pool.
   - Test: SIGKILL during concurrent sales leaves no partial rows; SIGTERM finishes the in-flight ones.
6. Request id (`X-Request-Id`):
   - in every access-log line and in error bodies;
   - a test scans the logs of a sign-in and a sale for passwords, tokens, cookies, idempotency keys and recovery codes.
7. Readiness: `GET /ready` (public, route matrix).
   - It answers 200 `{ready:true}` or 503 `{ready:false}`, status only; the details go to the log.
   - Checks: database reachable, migrations at the expected count, append-only triggers present.
   - `/health` stays as it is (liveness).
8. Production start-up: `TRUST_PROXY` and `STRICT_DB_ROLES` must be set explicitly, and `STRICT_DB_ROLES=true` needs
   `MIGRATION_DATABASE_URL`. `TZ=UTC` is set in the process. Tests are updated for the new required variables.
9. Static cache headers, with a test.
10. `.env.example` and the runbooks in `docs/runbooks/` (first deploy, update, rollback, restore drill).
11. `scripts/server/preflight.mjs` (read-only) plus a test.
12. `npm run verify` (`--full`).
13. BACKLOG.

## Needs your decision (not built)

- **Rate limits for write endpoints:** none exist; the numbers are a business choice.
- **Reverse proxy and how the frontend is served:** proposed: the backend serves the frontend, behind a TLS proxy.
- **Backup destination:** HOST-1.
