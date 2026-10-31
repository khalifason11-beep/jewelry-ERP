# DOC-2 — Go-live reset runbook (wipe the trial database, create the real General Manager)

Status: **plan, waiting for the owner's approval.** Documentation plus two small operator-side changes (preflight
message, bootstrap name guard) and one SQL helper file. No route, page, setting, permission or response field changes;
REH-1 is not touched.

> **Naming.** The request called this item DOC-1, but DOC-1 already exists and is DONE (README rewrite,
> `docs/plans/DOC-1.md`, BACKLOG). This plan uses **DOC-2** and leaves DOC-1's plan untouched. The working branch is
> `doc-1` as asked (from `origin/main` `db695df`). Question Q1.

## 1. What exists and what is missing (survey)

- `docs/runbooks/first-deploy.md` creates the database, the three roles and their grants once. It has two known gaps:
  - **The runtime role gets no `USAGE` on schema `drizzle`, and no `SELECT` on `drizzle.__drizzle_migrations`.**
    `/api/ready` and the preflight read that table as the runtime role. This was found at the first deploy.
  - **The Origin echo test stops the app, and nothing says to start it again** (`systemctl restart jerp`).
- **DEPLOYMENT §5's append-only list is out of date.** It shows the "switching to separate roles" SQL with 18 tables;
  `APPEND_ONLY_TABLES` now has 20 (`opening_scrap_corrections`, `money_transfer_events`). I'll fix it in the same item:
  it's a doc that disagrees with the code.
- **What a reset must redo.** Dropping a database deletes its database grants, schema grants and `ALTER DEFAULT
  PRIVILEGES` (they live inside the database). The roles are cluster-wide and survive with their passwords. So the reset
  keeps the same three roles and passwords, and therefore the same `/etc/jerp.env` and `/etc/jerp-backup.env`. It
  recreates the database and must redo **every** grant.
- **Bootstrap** (`backend/src/bootstrap-cli.ts`) already refuses usernames shorter than 8 characters and role-style
  words (`ROLE_STYLE_WORDS`: admin, manager, test, demo, owner, …). Nothing yet catches an Arabic name that a Windows
  console turned into `????` or mojibake. That garbled name would be stored and shown everywhere.
- **The General Manager can fix their own Arabic name later** (`PATCH /users/:id` allows self-edit of `fullNameAr`), and
  a branch's Arabic name can be edited in Branches.

## 2. Deliverables

1. **`docs/runbooks/go-live-reset.md`**, written for a non-technical operator. One command per step; every command
   is labelled **WHERE** it runs: "on the server, as root", "on the server, as postgres" or "on the owner's laptop
   (browser / terminal)". Each step ends with what you must see. Sections, in order:
   1. **Preconditions checklist (tick every box or stop):**
      - the BKP-1 restore drill passed and is recorded;
      - the domain is final, with `WEBAUTHN_RP_ID` and `APP_ORIGIN` fixed (passkeys stop working if it changes);
      - a Hostinger snapshot has been taken (name and time written down);
      - the person who will be the General Manager is present: the temporary password, the passkey and the recovery
        codes are theirs;
      - a maintenance window has been agreed.
   2. **Stop the service; trial data.** Choose one:
      - A: a last encrypted backup of the trial data (`npm run backup`, labelled TRIAL, kept off-site for a stated
        time), or
      - B: write down that the trial data is discarded.
   3. **Drop and recreate the database** with the same roles: one command running the new SQL file (item 2). It
      refuses unless the database name is typed twice.
   4. **Migrate, then preflight.** `npm run migrate` (owner role), then `node scripts/server/preflight.mjs`; every line
      must PASS, with the strict-role check: runtime role owns nothing and cannot alter the append-only tables.
   5. **Bootstrap the real General Manager.** The exact command and its rules: username of 8 or more characters, a
      personal name, no role-style words, with the list. Then what to do about Arabic:
      - **Recommended:** bootstrap with the English name only; the General Manager types the Arabic name in the
        browser (Users › their row) and creates the first branch in the app (Branches), where Arabic always works.
      - **Alternative:** `--full-name-ar` and `--branch` from a UTF-8 terminal; a garbled name is now refused.
   6. **Start and check:**
      - start the service and check `/api/ready`;
      - the Origin echo test **followed by `systemctl restart jerp`**;
      - first sign-in: change the password, register a passkey (and a second device), save the recovery codes;
      - check that no trial user, branch, rate, piece or sale exists, by the API and a fixed SQL query (read-only,
        backup role).
   7. **First backup right after, and the restore drill;** results written in the record table at the end of the
      runbook.
   8. **Rollback:** return to the Hostinger snapshot when any step fails. Lists when (any FAIL in steps 3–7 that the
      hint does not fix), how (panel steps in words, no promises about the provider's exact screens), and what the
      snapshot brings back (the trial server exactly as it was). After a rollback, nothing has changed for anyone.
2. **`scripts/server/go-live-reset.sql`**, a psql script run as the `postgres` admin on the server. In order:
   - checks that the three roles exist and that the confirmation matches the database name;
   - drops the database (`WITH (FORCE)`) and creates it again;
   - grants on the database and on schema `public`;
   - **creates schema `drizzle` owned by the owner role**, with `USAGE` for the runtime and backup roles;
   - `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` in `public` (runtime: tables, sequences, functions; backup: SELECT)
     and in `drizzle` (runtime and backup: SELECT).

   With this, the migrations create every table already readable by the right roles, and the drizzle gap cannot
   recur. Role names and the database name are psql variables, defaulting to `jewelry_erp`, `jerp_owner`, `jerp_app`
   and `jerp_backup`. No passwords appear anywhere, because the roles are kept.
3. **Preflight: a clear message when the drizzle grants are missing** (`backend/src/preflight.ts`). Before reading the
   migrations table, it checks `has_schema_privilege(... 'drizzle', 'USAGE')` and `has_table_privilege(...
   '__drizzle_migrations', 'SELECT')`. If either is missing, it prints FAIL "runtime role cannot read the migration
   history", with the exact `GRANT` lines as the fix, instead of a raw "permission denied for schema drizzle".
   Test in `backend/test/pg/preflight.test.ts`.
4. **Bootstrap: refuse a garbled Arabic name** (`backend/src/modules/bootstrap/service.ts`). `--full-name-ar` and the
   Arabic part of `--branch` are refused when they:
   - contain `?` or U+FFFD;
   - contain no Arabic letter;
   - look like UTF-8 read as a Windows code page (`Ø`/`Ù` followed by a Latin-1 character).

   The message says: leave it out and type it later in the app. It applies to the bootstrap CLI only, not to the app's
   forms. Tests: unit tests of the guard plus the bootstrap refusal.
5. **`backend/test/pg/go-live-reset.test.ts`, on real PostgreSQL 16** with three roles (owner, runtime, backup):
   - **Trial world:** build it with the first-deploy SQL, migrate, bootstrap a trial General Manager, then add a trial
     branch, rate and piece.
   - **Reset:** run `go-live-reset.sql` with `psql`, exactly as the runbook says.
   - **Migrate and preflight:** migrate as the owner; the preflight passes (spawned, every line PASS).
   - **Strict roles:** the runtime role owns nothing and cannot alter an append-only table.
   - **Bootstrap and app:** bootstrap the real General Manager; the app on the runtime role answers `/api/ready` 200.
   - **Nothing from the trial is left:** one user, no trial branch, rate, piece or sale; the audit log holds only the
     bootstrap.
   - **Backup role:** it can read every table (`pg_dump` succeeds, as `npm run backup` does), and a missing drizzle
     grant makes the preflight FAIL with the new message.
   - **Refusals:** the script refuses without the confirmation, or when a role is missing, and changes nothing.
   - **Where it runs:** in the existing `test-postgres` CI job (`psql` is on the runner; the test fails, never skips,
     if `psql` is absent with `REQUIRE_PG_TESTS=1`).
6. **A full local rehearsal of the runbook as written**, on this machine's PostgreSQL 16, as root:
   - roles, trial data, reset, migrate, preflight, bootstrap, start, sign-in by API, the emptiness check;
   - `npm run backup` with a real age key, then `npm run backup:verify`.

   The transcript summary goes into `docs/acceptance/DOC-2.md`. Not testable here, and said so in the runbook and the
   report: the Hostinger snapshot and its rollback, systemd, the reverse proxy and TLS, the real domain and real
   passkey devices.
7. **Doc fixes in the same item:**
   - `first-deploy.md`: the runtime and backup drizzle grants, `systemctl restart jerp` after the echo test, and a
     pointer to the reset runbook;
   - DEPLOYMENT §5: the append-only list (20) and the drizzle grant in "Separate owner and runtime roles";
   - DEPLOYMENT §6: restart after the echo test, and a pointer to the reset runbook;
   - BACKLOG: a DOC-2 entry, DONE;
   - README documentation map: the new runbook.

## 3. Commits (each green, each pushed)

| # | Commit |
|---|---|
| c0 | this plan |
| c1 | preflight: the drizzle-grant check with its fix + test |
| c2 | bootstrap: garbled Arabic name refused + tests |
| c3 | `scripts/server/go-live-reset.sql` + the real-PostgreSQL reset test |
| c4 | `docs/runbooks/go-live-reset.md`, first-deploy and DEPLOYMENT fixes, BACKLOG, README map, `docs/acceptance/DOC-2.md` with the local rehearsal; `npm run verify -- --full` |

## 4. Risks

- **A one-way operation.** Dropping the database cannot be undone except by the snapshot. The script has two guards:
  the confirmation must equal the database name, and the roles must exist. The runbook puts the snapshot first.
- **Tests run without a superuser.** CI's test role has CREATEDB and CREATEROLE but is not a superuser. Production runs
  the script as `postgres`. The test grants itself membership of the test owner role so that `ALTER DEFAULT PRIVILEGES
  FOR ROLE` works; the runbook runs it as `postgres`, where this is not needed. Both paths are exercised: the test runs
  it as non-superuser, and the local rehearsal as the real `postgres`.
- **The Arabic guard is a heuristic.** It refuses only text with no Arabic letter, `?` or U+FFFD, or the typical
  mojibake pattern. A real Arabic name always passes (tested with several names).

## 5. Questions for the owner

- **Q1.** Is **DOC-2** right for this item (DOC-1 is the finished README item), and is the branch name `doc-1` fine?
- **Q2.** Trial data: should the default be **discard** (B), with the TRIAL backup (A) optional? And if a TRIAL backup is
  kept, for how long before it is deleted?
- **Q3.** Arabic names: is "English at bootstrap, Arabic typed later in the app" enough, or do you also want a safe way
  to pass Arabic on the command line (for example a `--full-name-ar-base64` option)?
- **Q4.** First branch: should the runbook create it **in the app** (recommended: Arabic typed in the browser), or with
  `--branch` at bootstrap?
