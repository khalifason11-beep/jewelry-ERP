# Manual acceptance: REM-3 (no demo data; first steps on an empty system)

For the owner, in a desktop browser (Chrome or Edge). About 25 minutes.

## A. The rehearsal (engineering runs it, the owner reads the output)

```bash
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>:<password>@localhost:5432/postgres npm run rehearsal
```

Expected last line: `REHEARSAL PASSED: 93 checks.` It starts with `ALLOWED_KARATS_INITIAL=21` in production mode on an
empty PostgreSQL database. Besides the earlier checks, it checks the following:

- **First steps.** The GM home shows the four steps, none done, and the header says "Set today's rate".
  - Production shows no "Demo" badge.
  - The allowed karats start as [21], not yet confirmed. The GM confirms them with the password and step 1 is done.
  - No screen shows prototype or demo-account wording, in Arabic or English.
  - After the branch, the staff, the scrap rate and today's gold rate exist, the checklist disappears and the header
    shows the rate.
- **Empty states.** The branch manager sees "Your branch has no stock yet". The cashier sees "No pieces in this branch
  yet" at the point of sale.
- **Audit.** The audit log shows the karat confirmation.
- **A fresh demo-mode database.**
  - `npm run demo` without a terminal prints the bootstrap command and creates nobody.
  - The database holds no items, sales (customers exist only on sales), purchases, suppliers, products, types or scrap.
  - The login page lists no accounts.
  - The small "Demo" badge is shown.

## B. `npm run demo` on a new database

Stop any running server, then delete the local trial database (`.data/pglite`, or the folder in `PGLITE_DIR`).

| # | Step | Expected |
|---|---|---|
| 1 | In a terminal run `npm run demo`. | After the build it says the database is empty and asks for the **General Manager username**. |
| 2 | Answer `admin1`, then `gm.manager01`. | Both are refused: the first is shorter than 8 characters, and the second has a role-style word. The same rules apply as in production, with no demo shortcut. It asks again. |
| 3 | Answer a real-looking username, e.g. `o.abdelrahman`. | It prints a **one-time password** once, then the server starts on http://localhost:4000. |
| 4 | Open the login page. | No list of accounts, no "Prototype" or fictional company name. |
| 5 | Sign in with the one-time password and set a new password. Register a passkey and save the recovery codes, as in production. | You reach the home screen. To skip the passkey on a trial database, start the first time with `TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm run demo`. |
| 6 | Look at the header. | A small neutral **Demo** badge (تجريبي) and "Set today's rate" where the gold rate is shown. |
| 7 | Look at the home screen. | Only the **first steps** checklist, with four steps and none ticked: allowed karats (mandatory), today's gold rate and scrap rates, first branch, branch manager and cashier. No tables of zeros or invented data anywhere (Inventory, Sales, Purchases, Types & products, Audit log). |
| 8 | Step 1: tick **21** only, untick the others, click **Confirm**, enter the password. | Step 1 shows done. Only 21K is offered in inventory filters and purchase forms. |
| 9 | **Settings**: enter today's 21K gold rate and save it. Add a 21K scrap rate. | Step 2 shows done. The header shows the rate. |
| 10 | **Branches → New branch**; **Users**: create a branch manager and a cashier for it. | Steps 3 and 4 show done, and the checklist disappears. |
| 11 | Sign in as the branch manager (new browser window). | The dashboard says "Your branch has no stock yet", with New purchase / Buy scrap. |
| 12 | Sign in as the cashier. | The point of sale says "No pieces in this branch yet". |
| 13 | As the branch manager record a supplier order (CAT-0), then look at the cashier's point of sale again. | The pieces appear. |
| 14 | Run `npm run demo < /dev/null` against another new database (`PGLITE_DIR=.data/other npm run demo < /dev/null`). | It prints the full `npm run bootstrap …` command and exits, without starting the server and without creating a user. |

## C. A populated database for screenshots (`npm run dev:sample`)

| # | Step | Expected |
|---|---|---|
| 1 | `PGLITE_DIR=.data/sample npm run dev:sample` | It prints a table of accounts (`sample.alpha`, `sample.bravo.a/.b`, `sample.charlie.a/.b`) with passwords shown once. |
| 2 | Run the same command again. | It is refused because the database already has users. Nothing changes. |
| 3 | `APP_MODE=production PGLITE_DIR=.data/x npm run dev:sample` | It is refused: never in production. |
| 4 | `PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start`, then sign in as `sample.alpha`. | There are two branches, a few sales (cash, bank transfer, Hasad), supplier orders, scrap and a transfer in transit. Every name is a marked placeholder `[عينة] …`; no invented Sudanese names. |

## D. Gates (engineering)

- `npm run typecheck` now also runs these:
  - `check:migrations`: a migration after 0015 with DROP/TRUNCATE/DELETE/RENAME/… fails unless it carries
    `-- allow-destructive: <reason>`.
  - `check:test-imports`: product code may not import `backend/test` or a `fixtures` folder.
- Both gates are unit-tested with sample SQL and sources (`backend/test/gates.test.ts`).
- Production still refuses to start while an account accepts a password published by the old demo login page
  (test kept).

## E. Upgrading an existing database

REM-3 adds no migration. A database from before REM-3 still starts. This was checked once by engineering:

- A demo database was created and seeded by the pre-REM-3 code (commit `d6375a3`): 127 sales and 378 pieces, and the
  old GM signs in.
- The REM-3 code was then started on the same database. It started, the old GM still signs in, and the same 127
  sales and 378 pieces are there. The checklist shows rates, branch and staff done and only "confirm the allowed
  karats" open. The login page lists no accounts.
- The old seed itself could not build a fresh database on that date (a weekday-dependent settlement weight, the bug
  fixed in the test world in step 7). For this check only, the throw-away copy of the old code was patched.

Details:

- The new guarded setting `inventory.allowedKaratsConfirmed` has a default (`false`), so its checklist step shows
  until the GM confirms.
- An old demo database keeps its seeded rows. It is no longer re-seeded, reset or "back-filled".
- Old demo databases are for local trials only. Production refuses them while their published passwords still work.

## Not in REM-3

- REM-5 drops the deprecated tables and columns, including the `sessions.is_simulated` column that is no longer
  written. It uses the `-- allow-destructive:` comments.
- Real, client-approved names for the sample replace the placeholders in `backend/src/dev/sample-names.json` when the
  owner supplies them.
