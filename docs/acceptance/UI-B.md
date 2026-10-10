# Manual acceptance: UI-B (role homes, the attention list, the shell's attention control)

For the owner, about 25 minutes. Engineering ran section A. Section B is a walk-through in a GitHub Codespace from the
Windows laptop's browser.

What changed:

- **The General Manager's home** follows `gm-home.html`:
  - level 1: Sales on its own dark card; one surface with gross profit, gold held and stock at cost;
  - "Needs attention" beside the branch strips;
  - Today by default, and the period you choose is remembered.
  - **One deliberate difference from the mockup (your answer Q9):** level 2 shows the company's sales of the last 14
    days as **one line**, instead of the sales-by-branch bars. The bars repeated the strips' sales column. Please
    look at it (row 3 below) and say if you want the bars back.
- **The branch manager's home** follows `bm-home.html`:
  - Sales today;
  - the expected cash in the drawer, with the last count;
  - the stock;
  - the gold owed to suppliers, in 24K grams;
  - "Needs attention" and "Team today";
  - no cost or profit anywhere.
- **The attention list** (BE-1) replaces the bell. It shows:
  - transfers;
  - cash counts;
  - supplier gold owed;
  - backups;
  - new devices;
  - failed sign-ins;
  - locked accounts;
  - stock that does not reconcile;
  - missing rates;
  - the one-passkey and touch-only-key reminders.

  A missing or old backup is **critical**, and its count shows in the top bar on every page.
- **Above the page** only three notices remain, exactly as before:
  - a security-locked account;
  - "Was this you?";
  - the second factor switched off for the General Manager.
- **The scope pill** on the General Manager's home switches between all branches and one branch.

Plan: `docs/plans/UI-B.md`. Decisions: D-ui-17 to D-ui-22 (`docs/decisions.md` §20). No migration. Two new settings
in Settings › Business rules: the cash-count tolerance (0) and the supplier-debt age (30 days).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run typecheck`: lockfile, Hasad footprint, migrations, drizzle, test imports, assets, four packages | passed |
| Backend tests, both projects | 1,695 passed, 3 skipped: PGlite 828, PostgreSQL 867. New: `attention`, `home-numbers` |
| `npm run build`, `npm run i18n:check` | passed |
| REH-1 rehearsal (production mode, real PostgreSQL) | `REHEARSAL PASSED: 191 checks.` |
| `node scripts/e2e-print.mjs` | 47 checks passed |
| `node scripts/e2e-passkeys.mjs` | 33 checks passed (mode on), 3 (mode off) |
| `node scripts/e2e-states.mjs` | 77 checks passed |
| `node scripts/perf-homes.mjs` (8 branches, 2 years, 60,144 sales, 90,372 pieces) | `PERF PASSED`: every p95 ≤ 86 ms (budget 300 ms) |

**What the tests prove, for each of your conditions:**

| Condition | Test |
|---|---|
| Home sales = the Sales report = the Sales list, every branch and every day | `home-numbers.test.ts`, both projects, 31 days × every branch of the fixture world |
| **A void on a later day changes an earlier day's home figure** (the sale leaves that day; the ledger keeps its history) | `home-numbers.test.ts`: voiding a sale from 3 days ago lowers that day's home figure; that day's ledger SALE entries are unchanged |
| **The tie to the ledger uses the ledger entry date** | `home-numbers.test.ts`: Σ SALE entries of a day = the home's sales of that day + the sales made that day and voided since; Σ SALE_VOID entries of a day = − the sales voided that day |
| Expected cash = the drawer; the strips add up to the company; gold owed = open supplier orders | `home-numbers.test.ts`; REH-1 (the branch manager's expected cash = Cash; gold owed = the order still owed) |
| No per-branch or per-person queries | `home-numbers.test.ts` and `attention.test.ts`: the same number of SQL statements with 4 more branches and 10 more staff |
| **Backup missing or old: critical, counted on every page for the GM** | `attention.test.ts` (A9 critical); REH-1: the count is critical on Settings, Inventory and Reports, not only on the home. The system has no separate operator role in the application, so this applies to the General Manager |
| **The three notices above the page are unchanged from UI-A2** | e2e-states: lock first, then "Was this you?", then second factor off, with the same texts, test ids and no dismiss button; the backup, touch-only and one-passkey notices are no longer above the page |
| **No cost, profit or supplier money amount in any attention line or on any home for the branch manager and the cashier** | `attention.test.ts` (no COST field in any signal for a branch manager); REH-1 in both languages: the BM home and the attention list show no cost or profit word or figure, and no attention line carries a cost, profit or supplier money parameter; the cashier has no attention control; e2e-states |
| **A branch manager still sees their own branch's failed sign-ins** | `attention.test.ts`: A11 own branch only; the old `/api/notifications` answers 404 |
| **Index only if the performance script shows the need** | `scripts/perf-homes.mjs`: no index needed (below), so there is no migration 0020 |

**Performance** (`node scripts/perf-homes.mjs`, 20 runs each, p50 / p95 in ms). Machine: Intel Xeon 2.10 GHz × 4,
16 GB RAM, PostgreSQL 16.14. Data: 8 branches, 2 years, 60,144 sales, 90,372 pieces, 152,361 stock movements, 61,376
ledger entries, 2,022 purchases.

| Request | Before UI-B | After the query rewrite (commit 2) | Final (old home blocks removed, commit 4) |
|---|---|---|---|
| GM home, today | 5,253 / 5,435 | 98 / 129 | 56 / 65 |
| GM home, 30 days | 15,196 / 16,307 | 102 / 136 | 59 / 68 |
| Branch home | 2,118 / 2,385 | 56 / 69 | 55 / 64 |
| Attention, GM | 82 / 94 (first version) | 64 / 77 | 74 / 86 |
| Attention, branch manager | 18 / 20 (first version) | 20 / 25 | 17 / 19 |

No new index at any point.

## B. In a Codespace, from the Windows browser (about 20 minutes)

On GitHub: switch to the branch `claude/hopeful-sagan-lehxyp`, then **Code → Codespaces → Create codespace on
claude/hopeful-sagan-lehxyp**. Wait for the dependencies to install, then in the terminal:

```bash
npm run build
PGLITE_DIR=.data/sample npm run dev:sample        # prints the sample accounts and passwords once
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

Open port **4000**. The sample has two branches, A and B.

| # | Who | Check | Expected |
|---|---|---|---|
| 1 | General Manager | **Home** | "Home", today's date, "All branches". **Today** is selected. Sales on a dark card; profit, gold held and stock at cost on one light surface; "Needs attention" beside the branch strips. Level 1 fits the screen without scrolling |
| 2 | General Manager | Choose **7 days**, reload the page | Still 7 days. Choose Today again |
| 3 | General Manager | Scroll down | **"Sales: last 14 days" as one line** (the deliberate difference from the mockup's branch bars), and "Gold position" with gold owed to suppliers. **Tell us: line or bars?** |
| 4 | General Manager | The scope pill: **Branch A** | The branch layout: expected cash, profit, stock, gold owed, stock at cost, attention, team. Back to "All branches" |
| 5 | General Manager | Open **Sales**, then the **!** button at the top | A count, and a list of up to 5 lines with a word for each level (Urgent, Warning, For information); "Open the list on my home" |
| 6 | Branch manager A | **POS**: transfer a piece to Branch B (courier's name) | — |
| 7 | General Manager | **Home** | "1 transfer(s) on the way to Branch B". Branch B confirms receipt (or you do, on Transfers): the line leaves |
| 8 | Branch manager A | **Home** | Sales today, expected cash (same as **Cash**), stock, gold owed (grams), "Team today". **No profit or cost** anywhere, in Arabic and English |
| 9 | Branch manager A | **Cash**: record a count that differs from the expected cash | Back on Home: "Cash count difference at Branch A". Record the right amount: the line leaves |
| 10 | Branch manager A | Cancel a sale made on an earlier day (Sales › the sale › Cancel) | On the General Manager's home, choose a period that includes that day: its sales went down by that amount. The ledger keeps the original sale entry and records the cancellation on today's date |
| 11 | Cashier A | Top bar | No **!** button. The POS is unchanged (its new layout is UI-C1) |

**Backups.** In demo mode (the sample) the backup line appears only after a first backup has been made, as before.
The critical count on every page is proved in production mode by REH-1 (Settings, Inventory and Reports).

## C. Known and accepted

- **A void changes an earlier day's home figure.** Home sales are the sales made in the period that are still valid,
  as on the Sales list and in the Sales report. The ledger keeps the day's history; the identity between the two is
  tested by ledger entry date (D-ui-19).
- **The GM's level 2 is a line, not the mockup's branch bars** (Q9, D-ui-20). It is waiting for your review by eye.
  Restoring the bars is a small change.
- **Voids on the branch home** are a plain count in "Team today", with no colour and no attention line, until A13 is
  approved (Q8).
- **Removed from the GM home** (still in the reports): cost of sales, the daily trend per branch, sales by category,
  stock by karat, users signed in.
- **A cash count with a difference** is a warning only (Q6). A critical level needs a second amount you would set.
- **Rates:** the attention line appears only when a rate is missing, not when it is old (Q7). Rate staleness comes
  with PRC-1.
- **The cashier's POS is not restyled** (UI-C1, D-ui-22). The Branches page and the sales list with server-side
  pagination are the next plan (UI-B3 with BE-7, Q13).
- **The rehearsal's main drawer is below zero** (it paid out more cash than it took). The home shows it as a negative
  amount, as Cash does.
