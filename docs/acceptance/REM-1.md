# Manual acceptance: REM-1 (expenses removed) and the REH-1 skeleton

For the owner, in a desktop browser (Chrome or Edge). About 15 minutes.

## A. The rehearsal (engineering runs it, the owner reads the output)

```bash
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>:<password>@localhost:5432/postgres npm run rehearsal
```

Expected last line: `REHEARSAL PASSED: 39 checks.` It runs in **production mode** on an empty PostgreSQL database behind
https, so it proves a real first day: bootstrap, the General Manager's first sign-in with a passkey, a branch, a branch
manager and a cashier, and no expense wording on any screen in either language.

## B. In the demo (`npm run demo`, http://localhost:4000)

Use a fresh demo database (delete the `PGLITE_DIR` folder or run `npm run db:reset` first).

| # | Step | Expected |
|---|---|---|
| 1 | Sign in as the General Manager. Look at the sidebar. | No "Expenses" / "المصروفات" entry. |
| 2 | Open the **Company overview**. | KPI row: Total sales, Cost of sales, Gross profit, Inventory value. No "Total expenses", no "Net contribution". Branch table has no Expenses or Contribution columns. "Needs attention" has no expense line. |
| 3 | Open **Branches** → any branch. | The cards show no "Contribution". The branch page has no "Expenses" tab. |
| 4 | Open **Reports**. | No "Expenses Report". The Profit and Branch performance reports have no Expenses / Contribution columns. |
| 5 | Open **Settings**. | The card is called "Sales" (not "Sales & expenses") and has no "Expense approval threshold". |
| 6 | Open **Cash**, pick a branch and today. | Two lists: **Drawer (cash) movements** and **Bank movements**, each ending with **Other movements** and **Total of the day**. The drawer total equals the "Cash movements of the day" figure, and opening cash + that total = expected cash. |
| 7 | Switch the language to English (and back) and repeat steps 1–6 quickly. | Same result; no "expense" / "مصروف" anywhere. |
| 8 | Type `http://localhost:4000/expenses` in the address bar. | The app's "not found" page. |
| 9 | Sign in as a branch manager (Khartoum). Check the sidebar, the dashboard and Cash. | No expense entry, no expense KPI, no expense card; the Cash lists add up as in step 6. |
| 10 | As the branch manager, sell one piece in cash at the POS, then reopen Cash. | "Sales" in the drawer list and the total both grow by the sale amount. |

## C. Upgrading an existing database (engineering, already done once)

A demo database created before REM-1 (59 expenses, 58 expense ledger entries) was upgraded with migration 0013:
history kept, expense permissions removed, all 184 branch-days of the reconciliation add up, historical expenses show
as "Other movements", and a new expense row is refused by the database.
