# UX baseline screenshots (UX-0)

The application as it was on 2026-10-06 (commit `eb33e45`, after CAT-0), captured **before** REM-3 deleted the demo
data. Use these to compare every later UI phase (UI-A, UI-B, UI-C) against the starting point.

**Updated after REM-3 (2026-10-07):** the `empty-production/` set was captured again (first-steps checklist and
empty states). The `demo/` set was **not** recaptured: it still shows the old demo seed (4 branches, 30 days) as the
pre-REM-3 reference. A new run of `--only=demo` fills the database with `npm run dev:sample` instead (two branches,
marked placeholder names `[عينة] …`).

## How they were made

```bash
node scripts/capture-ui-baseline.mjs                    # both sets (builds the UI first)
node scripts/capture-ui-baseline.mjs --only=demo        # demo set only
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>@localhost:5432/postgres \
  node scripts/capture-ui-baseline.mjs --only=empty      # empty production set (runs REH-1)
```

- **Languages and sizes:** every screen in Arabic (RTL, `ar-…`) and English (LTR, `en-…`) at 1366×768 and 1920×1080.
- **`-full` images:** the app scrolls inside its main area, so at 1366 wide a screen whose content is taller than the
  window also gets a second image of the whole page (`…-full.jpg`). The image without `-full` is exactly what fits in
  one window, which shows what is "above the fold".
- **Format:** JPEG, quality 72 (about 18 MB in total).

## `demo/` — a populated database

As committed: the old demo seed (before REM-3), 4 branches and 30 days of seeded sales, purchases, scrap, transfers
and cash counts. Since REM-3 the script builds this set from `npm run dev:sample` instead. It is viewed as the General Manager (`gm`), the Khartoum branch manager (`bm`) and a Khartoum cashier (`cashier`).

| # | Who | Screen |
|---|---|---|
| 01 | GM | **Home**: Executive Overview (company dashboard), month to date |
| 02 | GM | Branches |
| 03 | GM | Branch detail (the branch dashboard embedded, with tabs) |
| 04 | GM | Sales list |
| 05 | GM | Sale detail |
| 06 | GM | Inventory |
| 07 | GM | Types & products |
| 08 | GM | Supplier purchases |
| 09 | GM | Supplier purchase detail (gold owed, settlements) |
| 10 | GM | Cash and daily reconciliation (all branches; a branch must be chosen for the reconciliation) |
| 11 | GM | Reports hub |
| 12 | GM | Sales report |
| 13 | GM | Audit log |
| 14 | GM | Users |
| 15 | GM | Active users (sessions) |
| 16 | GM | Settings |
| 17 | GM | Security (passkeys, recovery codes) |
| 18 | BM | **Home**: branch dashboard (today) |
| 19 | BM | Scrap gold (buy form and pool) |
| 20 | BM | Transfers |
| 21 | BM | Cash and daily reconciliation (own branch) |
| 22 | BM | Dialog: New product |
| 23 | BM | Dialog: New type |
| 24 | BM | Dialog: New purchase (supplier order) |
| 25 | BM | Dialog: New supplier (on top of the purchase) |
| 26 | Cashier | **Home**: point of sale |
| 27 | Cashier | My activity |

## `empty-production/` — a brand-new production database

Taken by REH-1 (`scripts/rehearsal/rehearsal.mjs` with `UI_BASELINE_DIR` set): production mode, real PostgreSQL
behind TLS, the database created by the bootstrap command. Each role's home right after that role's first sign-in:

| File | Moment |
|---|---|
| `01-general-manager-home.jpg` | GM after setting a password and registering a passkey: **no branch exists yet**; the four-step first-steps checklist, "Set today's rate" in the header |
| `02-branch-manager-home.jpg` | Branch manager of the new, empty branch after the first sign-in: "Your branch has no stock yet" |
| `03-cashier-home.jpg` | Cashier of the new branch at the point of sale: "No pieces in this branch yet" |

## Notes

- The demo badge ("تجريبي / Demo") and the seeded names in the demo set do not exist in production.
- Visible in the new set, older than REM-3 and left for UI-A: a stray `$` after "0 invoices" on the branch dashboard,
  and the POS payment buttons showing the raw codes `CASH` / `BANK_TRANSFER` / `HASAD` in English.
- On one of two runs, the rehearsal with screenshots enabled failed while creating the first user (the "Create user"
  button stayed disabled after the screenshots had reloaded the page); the second run passed all 72 checks. REH-1
  without screenshots is unaffected. If it happens, run it again. (The REM-3 recapture passed all 93 checks on the
  first run.)
