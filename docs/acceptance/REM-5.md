# Manual acceptance: REM-5 (deprecated schema dropped)

For the owner, about 15 minutes. Engineering ran sections A, C and D. Section B is what the owner checks in the
browser.

What changed is mostly invisible: migration **0016** removes database objects that REM-1 (expenses) and REM-2
(Hasad as a sales channel only) had kept for history. Plan: `docs/plans/REM-5.md`. Decisions: D-rem5-1…7.

## A. The rehearsal (engineering runs it, the owner reads the output)

```bash
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>:<password>@localhost:5432/postgres npm run rehearsal
```

Expected last line: `REHEARSAL PASSED: 97 checks.` New in the REM-5 section, on the production-mode PostgreSQL
database it has just used end to end:

- none of the removed tables, the `hasad_mock` schema, the removed columns, the deprecation function or the
  `hasad.enabledPerBranch` setting exist;
- all 17 migrations (0000–0016) are applied;
- `UNIQUE (purchase_items.item_id)` exists (one supplier line per piece).

## B. In the browser (`npm run demo` on a NEW database)

An existing local demo database stops at start-up by design (section C). Delete the `PGLITE_DIR` folder (default
`.data/pglite`) first.

| # | Step | Expected |
|---|---|---|
| 1 | Create the GM (`npm run demo`), confirm 21K, set the rates, create a branch, a branch manager and a cashier. Record one supplier order with two pieces (purchase cost, making charge and other cost filled in). | As in REM-3. |
| 2 | As GM: **Inventory**, open one of the pieces. | Purchase cost, making charge, other cost and total cost show the values typed on the supplier order; the margin is computed from the total. |
| 3 | Buy one **sellable scrap** piece and open it. | Its purchase cost is what the customer was paid; making and other cost are 0. |
| 4 | Sell a piece at the POS, then open the sale as GM. | The sale lines show the same cost breakdown as the inventory. |
| 5 | Dashboard and **Reports → Inventory**. | Stock value and weight include the new pieces. There is no "reserved" count and no "Other" line in the inventory movement. |
| 6 | **Inventory** status filter. | AVAILABLE, SOLD, TRANSFERRED, DAMAGED and RETURNED only (no RESERVED, no REDEEMED). |
| 7 | **Cash**, the daily reconciliation. | The lines add up as before; HASAD sales still go to the Hasad receivable, and "Hasad transfer received" still works. |
| 8 | Sign in as a branch manager and a cashier. | No change from REM-3: no cost figures for them. |

## C. Old databases stop, unchanged (engineering, done once)

**Automated** (`backend/test/rem5.test.ts`, on PGlite and on real PostgreSQL):

- A database is migrated to 0015 and given one legacy row of a given kind. The full migration must then stop, name
  that kind, leave the migration log at 0015 and leave the deprecated objects in place. This runs once for **each of
  the 17 kinds**: expenses, the four Hasad tables, the three `hasad_mock` tables, EXPENSE/HASAD_SETTLEMENT ledger
  entries, HASAD_REDEMPTION movements, RESERVED/REDEEMED history, a RESERVED/REDEEMED piece, old cost columns that
  differ, a removed audit action, a Hasad branch code, a simulated session, and a piece with two supplier lines.
- With all of them at once, the message printed by the test is:

  ```
  Migration 0016 (REM-5) stopped: this database still holds data from removed features:
    expenses (removed by REM-1): 1
    hasad_withdrawals (removed by REM-2): 1
    hasad_redemptions (removed by REM-2): 1
    hasad_redemption_items (removed by REM-2): 1
    settlements: Hasad weight differences (removed by REM-2): 1
    hasad_mock.customers: 1
    hasad_mock.withdrawals: 1
    hasad_mock.api_calls: 1
    ledger_entries with event EXPENSE or HASAD_SETTLEMENT: 1
    inventory_movements of type HASAD_REDEMPTION: 1
    item_status_history through RESERVED or REDEEMED: 1
    jewelry_items RESERVED or REDEEMED, or with a reservation: 1
    jewelry_items whose old cost columns differ from acquisition_cost or the supplier line: 1
    audit_logs with a removed action: 1
    branches with a Hasad branch code: 1
    sessions marked simulated (demo presence): 1
    pieces with more than one supplier line (purchase_items): 1
  Nothing was changed. Databases with demo or pre-REM-3 history are not upgraded: create a new database
  (local: delete the PGLITE_DIR folder, default .data/pglite, and run `npm run demo`; server: a new database and `npm run bootstrap`).
  ```


**Manual, on a real pre-REM-3 demo database:**

- A demo database was seeded by commit `d6375a3` (the last commit before REM-3): 140 sales, 376 pieces, and the
  old GM signs in. The REM-5 code was then run on it with `npm run migrate`. It exited with code 1 and this message:

  ```
  Migration 0016 (REM-5) stopped: this database still holds data from removed features:
    sessions marked simulated (demo presence): 6
  Nothing was changed. Databases with demo or pre-REM-3 history are not upgraded: create a new database
  (local: delete the PGLITE_DIR folder, default .data/pglite, and run `npm run demo`; server: a new database and `npm run bootstrap`).
  ```

- Opened again by the pre-REM-3 code, the database was unchanged: 140 sales, 376 pieces, and the GM signs in.
- That seed already postdated REM-1 and REM-2, so it had no expense or Hasad rows; what stops it is the demo
  presence sessions that every demo seed wrote. Older demo databases also carry expenses and Hasad history, and
  stop on those too.

**Clean upgrade** (automated, both projects): a database at 0015 holds a HASAD sale with its invoice and transaction
references, a SALE and REVERSAL pair, and a Hasad receivable settlement with its ledger entry. It upgrades. Those
rows are intact afterwards, and the `hasad.enabledPerBranch` row is gone.

## D. Gates (engineering)

- `npm run typecheck` runs:
  - `check:hasad`: 174 allowed lines in 7 entries (4 of them are the new REH-1 REM-5 checks, under the existing GUARD entry). The list held 251 lines in 10 entries before REM-5; entries were
    removed, none added.
  - `check:migrations`: 1 migration after 0015 checked. Every destructive statement of 0016 has its
    `-- allow-destructive:` reason.
  - **`check:drizzle`** (new): `drizzle-kit generate` on a throw-away copy of the migrations writes nothing. Its tests
    show that it fails on a cut-down schema file and on a schema change without its migration.
  - `check:test-imports`, and the four TypeScript projects.
- Both test projects, the build and `i18n:check` pass. The test counts are in the BACKLOG REM-5 entry.

## Not in REM-5

- `CARD` and `MOBILE_WALLET` stay in the data model, hidden at the POS.
- `docs/ARCHITECTURE.md` and `docs/DATA_MODEL.md` still describe the prototype (BACKLOG section G).
- Backups taken before REM-5 restore only with the pre-REM-5 code (DEPLOYMENT, "Deprecated schema dropped").
