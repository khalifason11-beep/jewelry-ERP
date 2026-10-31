# Acceptance: DOC-2 (go-live reset runbook)

For the owner. The runbook is `docs/runbooks/go-live-reset.md`. **Do not run it before BKP-1 passed and the domain is
final.** This page records how it was tested, and what could not be tested here.

What changed (owner approval of 2026-10-31, plan `docs/plans/DOC-2.md`):

- **The runbook**, one command per step, each marked with where it runs:
  - preconditions;
  - stop; the trial is discarded (an optional TRIAL copy is deleted after the reset);
  - drop and recreate the database;
  - migrate and the preflight;
  - the real General Manager, English name only;
  - start, checks and first sign-in (Arabic name and first branch typed in the app);
  - the first backup and the drill;
  - rollback to the Hostinger snapshot.
- **`scripts/server/go-live-reset.sql`** refuses and changes nothing:
  - unless the database name is typed twice and agrees;
  - when a role is missing, or two roles are the same;
  - for a system database;
  - when the database is not the trial one named (its General Manager must be the given `trial_gm`).

  An empty database left by an interrupted reset is finished by running the same command again.
- **The preflight** says "cannot read the migration history" and gives the two `GRANT` lines when the runtime role lacks
  the drizzle grants. This was the gap of the first deploy, which used to show as a bare "permission denied".
- **The bootstrap** refuses an Arabic name a console garbled (`????`, U+FFFD, mojibake) and says to type it later in the
  app.
- **`first-deploy.md` and DEPLOYMENT §5/§6:**
  - the drizzle schema created and granted before the first migration;
  - the `public` grant given by the admin (as the owner it granted nothing: "no privileges were granted");
  - `systemctl restart jerp` after the Origin echo test;
  - the append-only list completed (20 tables).

## A. Automated (CI, every push)

| Test | What it proves |
|---|---|
| `backend/test/pg/go-live-reset.test.ts` (real PostgreSQL 16, three roles, psql) | 8 refusals change nothing; the reset → migrate → preflight with no FAIL (runtime role PASS with `STRICT_DB_ROLES=true`) → the runbook's bootstrap command (and a role-style name refused) → `/api/ready` 200 on the runtime role → nothing of the trial left → `pg_dump` as the backup role; an interrupted reset finished by the same command |
| `backend/test/pg/preflight.test.ts` (new case) | no USAGE on drizzle → FAIL naming both grants with the GRANT lines; then no SELECT → FAIL naming it; then PASS |
| `backend/test/doc2-bootstrap.test.ts` (both projects) | garbled Arabic recognised (`????`, U+FFFD, mojibake, Latin only, a stray `?`), real names pass; refused for the GM and a branch, nothing created; the General Manager types the Arabic name later |

## B. Local rehearsal of the runbook as written (2026-10-31, PostgreSQL 16.14)

Run as `root` on a Linux machine with the real `postgres` admin, a `jerp` system user, the roles `jerp_owner`,
`jerp_app` and `jerp_backup`, and the env files filled as `.env.example` and DEPLOYMENT §7.4 say:

| Step | Result |
|---|---|
| Trial built as `first-deploy.md` §3 (old text) + `npm run migrate` + `npm run dev:sample` (real services) | 39 migrations; 5 users, 2 branches, 17 pieces, 3 sales; GM `sample.alpha` |
| Preflight on that trial | **FAIL `jerp_app cannot read the migration history: it lacks USAGE on schema drizzle`** with the GRANT fix (the first-deploy gap, reproduced; §9's `GRANT USAGE ON SCHEMA public` as the owner printed "no privileges were granted") |
| 2 · TRIAL copy (`jerp_backup npm run backup`) | `BACKUP OK … copied off-site`. The env file needed single quotes around `BACKUP_UPLOAD_COMMAND`; the runbook says so |
| 3 · reset with a wrong `trial_gm` | `REFUSED: … the user khalid.osman is not a General Manager: this is not the trial database you named`, exit 3, still 5 users |
| 3 · reset | `The TRIAL database jewelry_erp of General Manager sample.alpha is dropped now: 5 users, 2 branches, 17 pieces, 3 sales.` then `DONE …` |
| 4 · `jerp npm run migrate`, preflight | `Migrations applied`; `preflight: 11 PASS, 1 WARN, 0 FAIL` (the WARN: no backup yet, expected) |
| 5 · bootstrap `admin.khalid` / with `????` Arabic / `khalid.osman` | refused (role-style) / refused (garbled Arabic) / `General Manager "khalid.osman" created. Branches created: none.` + one-time password |
| 6 · start, `/api/ready`, log | `{"ready":true}`; `server started`; no `SECURITY WARNING`, no `refusing to start` |
| 6 · first sign-in (by the API) | the one-time password signs in with `mustChangePassword: true`; the change clears it |
| 6 · emptiness query | users `khalid.osman`; branches, gold rates, scrap rates, pieces, sales, ledger entries all 0 |
| 6 · Origin echo test | `{"origin":"https://erp.example.com",…}`; afterwards nothing listened (`000`) until the restart, then `{"ready":true}` |
| 7 · TRIAL copy deleted; first backup; drill | `BACKUP OK`; `RESTORE DRILL OK … 6 integrity checks passed` (51 tables, 20 append-only tables refuse 22 attempts); `/api/health` → `"backup":{"status":"OK"}` |
| Corrected `first-deploy.md` §3/§9 on a fresh database | migrate, then preflight `0 FAIL` with no manual grant; `pg_dump` as the backup role OK |

## C. Not tested here (the runbook marks them ⚑)

- **The Hostinger snapshot and the rollback to it.** It is the provider's panel; the runbook names the steps in words.
- **systemd:** the rehearsal ran the service with `npm start` as the `jerp` user, not `systemctl`.
- **The reverse proxy and TLS:** the echo test ran without a proxy.
- **The real domain.**
- **Real passkey devices and the recovery codes:** the first sign-in was tested by the API up to the password change.
- **The drill on a separate machine:** here the drill ran on the same machine, with a scratch admin role.

## D. What the owner checks on the day

Steps 1 to 8 of the runbook, with the record table of step 7 filled in.
