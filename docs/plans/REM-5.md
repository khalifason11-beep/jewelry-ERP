# REM-5 plan: drop the deprecated tables, columns and values

Status: **APPROVED and implemented** (owner answers 1–5 and additions A–C; see docs/decisions.md D-rem5-* and docs/acceptance/REM-5.md).
Branch: `claude/hopeful-sagan-lehxyp`. Based on commit `6c2b65e` (after REM-3).

REM-1 (expenses) and REM-2 (Hasad as a sales channel only) removed features but kept their tables, columns and enum
values so that history stayed valid. Triggers refuse new rows. No production database exists yet, so this is the
cheapest moment to drop them. One new migration, **0016**, does it. It is the first migration checked by the REM-3
gate (`check:migrations`).

All facts below were checked against the code and against a freshly migrated database at `6c2b65e`.

---

## a. Inventory: what is deprecated and goes

### Tables and schema (DROP)

| Object | Since | Rows in a fresh DB | Notes |
|---|---|---|---|
| `expenses` | REM-1 (0013 refuses inserts) | 0 | 4 CHECKs (`ck_expenses_*`), index `exp_branch_date_idx`, trigger `trg_expenses_deprecated` go with it |
| `hasad_withdrawals` | REM-2 (0014) | 0 | CHECKs `ck_hasad_withdrawals_*`, trigger |
| `hasad_redemptions` | REM-2 | 0 | FK → `hasad_withdrawals`; CHECKs `ck_hasad_redemptions_*`, trigger |
| `hasad_redemption_items` | REM-2 | 0 | FK → `hasad_redemptions`; CHECKs, trigger |
| `settlements` (Hasad weight differences) | REM-2 | 0 | FK → `hasad_redemptions`; CHECKs `ck_settlements_*`, trigger |
| schema `hasad_mock` (`customers`, `withdrawals`, `api_calls`) | REM-2 | 0 | 3 triggers. File `database/src/deprecated-hasad-mock-schema.ts` is deleted, and its entry is removed from `database/drizzle.config.ts` (`schema` list and `schemaFilter`). |

Only these tables reference each other; **no kept table has a foreign key into a dropped one** (checked in
`pg_constraint`). 19 indexes belong to the dropped objects and go with them.

### Columns (DROP COLUMN)

| Column | Why it can go | Code that still touches it (to change first) |
|---|---|---|
| `sessions.is_simulated` | Written only by the demo "presence" (deleted in REM-3) and by the test fixture world | `backend/test/fixtures/world.ts` (live sessions), `shared/src/field-classification.ts` |
| `branches.hasad_branch_code` (+ its UNIQUE constraint) | Identifier of the removed Hasad integration; never written since REM-2 | field classification only |
| `jewelry_items.purchase_cost`, `making_cost`, `other_cost`, `total_cost` | Phase 2b replaced them with `acquisition_cost` + `making_charge`; still **written** "for compatibility". The per-line split stays in `purchase_items` (purchase_cost, making_cost, other_cost). | Writes: `purchases/service.ts`, `scrap/service.ts`. Reads: `sales/service.ts` (l. 258–288), `inventory/ledger.ts` (`itemColumns.totalCost`), `inventory/service.ts` (`COST_FIELDS`), `reports/metrics.ts` l. 62 and `dashboard/service.ts` l. 132 (`sum(total_cost)` → `sum(acquisition_cost)`) |
| `jewelry_items.reservation_ref`, `reserved_at`, `reserved_by` | Exist only for the RESERVED status (Hasad counter sessions); nothing reserves a piece any more | `inventory/ledger.ts` (set/clear on status change), `frontend/src/lib/types.ts` |

CHECKs dropped with the cost columns: `ck_jewelry_items_{purchase,making,other,total}_cost_nonneg` and
`ck_jewelry_items_total_cost_sum`. **Kept:** `ck_jewelry_items_acquisition_cost_nonneg` and
`ck_jewelry_items_making_in_acquisition`.

### Enum values (CHECK lists narrowed; TypeScript lists shortened)

| Value | List / CHECK | Still referenced by |
|---|---|---|
| `EXPENSE`, `HASAD_SETTLEMENT` | `LEDGER_EVENT_TYPES` / `ck_ledger_entries_event_type` | `ledger/service.ts` `OTHER_EVENT_TYPES` |
| `HASAD_REDEMPTION` | `MOVEMENT_TYPES`, `MOVEMENT_DIRECTION` / `ck_inventory_movements_type` | `reports/service.ts` (l. 217, 223), `BranchDashboardPage.tsx` ("Other" line), i18n |
| `RESERVED` | `ITEM_STATUSES`, `STOCK_STATUSES` / `ck_jewelry_items_status`, `ck_item_status_history_{from,to}_status` | stock queries `IN ('AVAILABLE','RESERVED')` in `reports/metrics.ts`, `dashboard/service.ts`, `stock/weight.ts`, `inventory/service.ts`; `PosPage.tsx` (reserved display), `InventoryPages.tsx` |
| `REDEEMED` (proposed, see f.) | same lists and CHECKs | `reports/service.ts` status filter, status badge in `components/ui`, i18n |
| `EXPENSE_CATEGORIES`, `EXPENSE_STATUSES`, `HASAD_WITHDRAWAL_STATUSES`, `HASAD_EXTERNAL_STATUSES`, `HASAD_REDEMPTION_STATUSES`, `SETTLEMENT_DIRECTIONS`, `SETTLEMENT_TYPES` | whole lists | only the CHECKs of the dropped tables |

### Audit action names (TypeScript list and Arabic labels only)

`audit_logs.action` has **no CHECK**, so nothing changes in the database. These are removed from `AUDIT_ACTIONS`
and `i18n-ar.ts`; no code writes them any more:
`HASAD_WITHDRAWAL_RECEIVED`, `HASAD_WITHDRAWAL_OPENED`, `HASAD_WITHDRAWAL_COMPLETED`, `HASAD_WITHDRAWAL_CANCELLED`,
`HASAD_REDEMPTION_ABORTED`, `HASAD_SETTLEMENT_CONFIRMED`, `EXPENSE_CREATED`, `EXPENSE_APPROVED`, `EXPENSE_REJECTED`,
`DEMO_DATA_RESET`, `ITEM_RESERVED`, `ITEM_RELEASED`. The Arabic key written by migration 0014 ("released back to
AVAILABLE") goes too.

### Triggers and function

- On dropped tables: `trg_expenses_deprecated`, `trg_hasad_*_deprecated` (3), `trg_settlements_deprecated`, and
  `trg_hasad_mock_*_deprecated` (3). They go with their tables.
- On a kept table: `trg_ledger_entries_no_expense` and `trg_ledger_entries_no_hasad_settlement` on `ledger_entries`.
  These are explicit `DROP TRIGGER`s; the narrowed CHECK replaces them.
- `jerp_refuse_deprecated_insert()`: `DROP FUNCTION` after its last trigger is gone.

### Leftover rows

- **`settings` row `hasad.enabledPerBranch`.** It is present in **every** database, fresh ones included: migration
  0003 inserts it and REM-2 did not remove it. 0016 deletes it (not history: `settings` is not append-only).
- `settings_history` rows of removed keys stay. The table is append-only history, has no CHECK on the key, and is
  harmless.
- `permissions` / `role_permissions`: **nothing left**. A fresh DB matches `shared/src/permissions.ts` exactly
  (0013/0014 already deleted the expense and Hasad codes).

### Dead code that goes with them

- `database/src/client.ts` `wipe()`: no caller since REM-3 removed the demo reset. It also drops the `hasad_mock`
  schema.
- The REM-1/REM-2 comments that explain why historical figures still count (`REMOVAL_COMMENT` allow-list entries).

## b. What must stay

| Kept | Where |
|---|---|
| `HASAD` payment method | `PAYMENT_METHODS`, `PAYMENT_ACCOUNT`, POS default methods, `ck_sales_payment_method`, `ck_ledger_entries_payment_method` |
| Hasad references on a sale | `sales.payment_ref_invoice`, `sales.payment_ref_transaction`, `ck_sales_hasad_reference`, the POS fields, the printed invoice |
| `HASAD_RECEIVABLE` account | `LEDGER_ACCOUNT_KINDS`, `ck_ledger_accounts_kind`, `jerp_branch_ledger_accounts()` |
| Its settlement | table `hasad_receivable_settlements` (append-only), event `HASAD_RECEIVABLE_SETTLEMENT`, audit `HASAD_RECEIVABLE_SETTLED`, permission `cash.settle_hasad`, routes `/cash/hasad-settlements` (Q-7 still open) |
| `REVERSAL` | `LEDGER_EVENT_TYPES` and `SCRAP_WEIGHT_EVENT_TYPES`; `ck_ledger_entries_reversal_type` unchanged |
| `SALE_VOID` | unchanged |
| `CARD`, `MOBILE_WALLET` | stay in the data model (hidden by the POS setting); out of scope |
| `purchase_items` cost split | unchanged; it is the record of what each supplier line cost |
| Append-only tables | unchanged: `APPEND_ONLY_TABLES` still lists the same 13 tables |

## c. The append-only problem: stop, do not rewrite history

Rows that use a removed value cannot be deleted or rewritten: `ledger_entries`, `inventory_movements`,
`item_status_history` and `audit_logs` refuse UPDATE, DELETE and TRUNCATE. Even if they could be, rewriting history
is wrong. A narrowed CHECK would also fail to validate on such rows.

**Proposal.** The first statement of 0016 is a guard (`DO $$ … $$`). It counts every legacy row and, if any count is
non-zero, raises an exception. The migrator runs all pending migrations in **one transaction** (checked in
drizzle-orm's `dialect.js`), so **nothing is changed**, exactly like the CAT-0 duplicate-name guard in 0015.
Example message:

```
Migration 0016 (REM-5) stopped: this database still holds data from removed features:
  expenses: 59 rows; ledger_entries with event EXPENSE: 58; hasad_withdrawals: 19; …
Nothing was changed. Databases with demo or pre-REM-3 history are not upgraded: create a new database
(local: delete .data/pglite and run `npm run demo`; server: a new database and `npm run bootstrap`).
```

What the guard counts (each line reported separately):

| Table | Legacy rows |
|---|---|
| `expenses`, `hasad_withdrawals`, `hasad_redemptions`, `hasad_redemption_items`, `settlements` | any row |
| `hasad_mock.customers`, `.withdrawals`, `.api_calls` | any row (if the schema exists) |
| `ledger_entries` (append-only) | `event_type IN ('EXPENSE','HASAD_SETTLEMENT')` |
| `inventory_movements` (append-only) | `type = 'HASAD_REDEMPTION'` |
| `item_status_history` (append-only) | `from_status` or `to_status` IN (`RESERVED`, `REDEEMED`) |
| `jewelry_items` | `status IN ('RESERVED','REDEEMED')`, or any `reservation_*` / `reserved_*` value set |
| `audit_logs` (append-only) | `action` IN the removed names above |
| `branches` | `hasad_branch_code IS NOT NULL` |
| `sessions` | `is_simulated = true` |

The guard does **not** count:

- the `hasad.enabledPerBranch` settings row (every DB has it; 0016 deletes it);
- `settings_history` rows of removed keys;
- the deprecated item cost columns (every item has values). Dropping them loses nothing: `acquisition_cost`,
  `making_charge` and `purchase_items` hold the information. Step 1 below proves on the fixture world that
  `total_cost = acquisition_cost` for every piece before the reports switch columns.

So a fresh database and any database created after REM-3 by real use upgrade. Old demo databases, from before
REM-3 or with REM-1/REM-2 history, stop and are **recreated, not upgraded**. They are local trial databases only;
DEPLOYMENT and the acceptance doc will say so.

## d. Migration design

1. **Generate from the COMPLETE schema, never a cut-down file** (the CAT-0 drizzle-kit incident):
   - Edit `database/src/schema.ts` in place, removals only.
   - Delete `deprecated-hasad-mock-schema.ts`, but keep `hasad_mock` in `schemaFilter` for this one generation, so
     drizzle-kit emits the DROPs for the mock tables and the schema itself.
   - Run `npm run generate -w @jerp/database -- --name rem5_drop_deprecated`.
   - Remove `hasad_mock` from `schemaFilter`, and run generate again: it must report **no changes**.
   - The result is `0016_rem5_drop_deprecated.sql`, `meta/0016_snapshot.json` and one `_journal.json` entry, all
     from drizzle-kit.
   - REM-5 only removes, so drizzle-kit asks no rename questions.
2. **Hand-review** the generated SQL against the inventory in section a. Every statement must match a line there,
   and no other table may appear. `DROP TABLE … CASCADE` is rewritten to drop in dependency order **without
   CASCADE** (redemption items → settlements → redemptions → withdrawals), so an unexpected dependent makes the
   migration fail instead of silently dropping something.
3. **Hand-written additions** to the same file, in this order:
   1. the guard (section c);
   2. `DROP TRIGGER` × 2 on `ledger_entries`;
   3. drizzle's DROP TABLE / DROP SCHEMA / DROP COLUMN statements;
   4. replace the narrowed CHECKs: `ck_ledger_entries_event_type`, `ck_inventory_movements_type`,
      `ck_jewelry_items_status`, `ck_item_status_history_from_status`, `ck_item_status_history_to_status`
      (DROP CONSTRAINT + ADD CONSTRAINT, validated; the guard ensured no row violates them);
   5. drop the cost-column CHECKs explicitly;
   6. `DROP FUNCTION jerp_refuse_deprecated_insert()`;
   7. `DELETE FROM settings WHERE key = 'hasad.enabledPerBranch'`.
4. **Every destructive statement carries its own `-- allow-destructive: <reason>`** line, naming REM-5 and the
   object (D-rem3-6). Replacing a CHECK needs it, as decided. `check:migrations` then checks a real migration for
   the first time.
5. **Snapshots consistent:**
   - CHECKs and triggers are not in drizzle snapshots (`checkConstraints` is empty in every snapshot; ours are
     hand-written from `shared/src/db-checks.ts`), so hand edits do not desynchronise them.
   - **Proposed new gate `check:drizzle`** (part of `typecheck`): run `drizzle-kit generate` against a temporary
     copy of `migrations/` and fail if it would write anything. It needs no database and would catch both a
     forgotten snapshot and a cut-down schema file.
6. **Shared definitions follow the schema** in the same commit:
   - `shared/src/enums.ts` and `shared/src/db-checks.ts`;
   - `shared/src/field-classification.ts` (its test walks the schema and fails on stale entries);
   - `OTHER_EVENT_TYPES`; the frontend types and labels.
7. **Hasad footprint allow-list shrinks** (`scripts/hasad-footprint-allowlist.json`):
   - Delete both `DEPRECATED_UNTIL_REM5` entries and the `MIGRATION` entry. Trim `REMOVAL_COMMENT` to what remains.
   - Keep `PAYMENT_METHOD`, `POS_REFERENCES`, `RECEIVABLE` and `GUARD`.
   - Migrations 0013/0014/0016 stay outside the scan, as now.
   - Expected: the "allowed lines" count drops well below today's 251. The report gives the exact number, and the
     gate must pass with **no new entry**.

Proposed order of commits (suite green after each):

1. **Code stops reading and writing the deprecated item columns and reservations** (no schema change):
   - add a fixture-world assertion that `total_cost = acquisition_cost` for every piece, then switch the reports;
   - stop writing `is_simulated` in the fixture world.
2. **Migration 0016 with the guard; schema, shared lists, CHECKs, classification; delete the mock schema file and
   `wipe()`; tests updated** (the REM-1/REM-2 "no new rows" trigger tests become "the table no longer exists / the
   CHECK refuses the value").
3. **Allow-list shrink, i18n, `check:drizzle` gate, REH-1 checks, docs**:
   - docs: decisions D-rem5-*, DEPLOYMENT, BACKLOG;
   - `docs/acceptance/REM-5.md`.

## e. Tests and verification

| Case | How |
|---|---|
| **Fresh empty database** | Every test file already migrates a fresh DB on PGlite and on real PostgreSQL (both projects). New test `rem5.test.ts`: no removed table, column or schema exists (information_schema); the constraint list equals `db-checks.ts` (existing phase2a test); the two triggers and the function are gone; the `hasad.enabledPerBranch` row is gone; inserting a removed value into `ledger_entries`, `inventory_movements` or `jewelry_items.status` fails on the CHECK. |
| **Production-mode start** | REH-1 in production mode on real PostgreSQL, behind TLS. It gains a check, through its admin connection, that the rehearsal database has none of the removed objects and that `migrations OK: 1 migration(s) after 0015` was printed. The production start-up refusals are unchanged. |
| **Legacy database with rows → stops** | The test migrates a DB to **0012** with a copy of the migrations folder truncated in `_journal.json`, so the deprecation triggers do not exist yet. It inserts one row of each legacy kind by SQL, migrates to 0015, then runs the full migration. It expects the exception, with each count named, and checks that **nothing changed**: the migration log still ends at 0015 and the tables still exist. It runs once per legacy kind, so each line of the guard is proven to fire. |
| **Clean upgrade** | Migrate to 0015 and add kept-value rows: a HASAD sale with references, a receivable settlement, a SALE_VOID / REVERSAL pair, the settings row. Then upgrade: it succeeds, the kept rows are intact and the settings row is gone. Run once more by hand on a database made with `dev:sample` at `6c2b65e`. |
| **Old demo database** | Manual, recorded in the acceptance doc: a pre-REM-3 demo database (as in the REM-3 upgrade check) must stop with the message, and its data must be unchanged. |
| **Backups** | The existing backup / restore-drill tests (row counts, append-only refusals) on the new schema. |
| **Gates** | `typecheck` (with `check:migrations` now really checking 0016, `check:hasad` with the smaller list, the new `check:drizzle`), i18n:check, build, both test projects, REH-1, the e2e print and passkey scripts. |

## f. Risks and open questions

**Questions for the owner**

1. **REDEEMED.** It was the status of a piece handed over in a Hasad withdrawal and is only written by the removed
   workspace. I propose to drop it together with RESERVED. Yes?
2. **RESERVED and its columns.** Today nothing reserves a piece; held carts live on the device. Dropping it means a
   future "hold this piece for a customer" feature must add it back with its own migration. Acceptable?
3. **Audit names in the guard.** I propose that audit rows with removed action names also stop the migration: a
   uniform rule, and such rows exist only in demo databases. The alternative is to leave them as plain history and
   keep their labels. Which do you prefer?
4. **Is there any database that must be upgraded rather than recreated** (a staging service, or the old hosted demo)?
   The plan assumes none exists outside local trial databases.
5. **`check:drizzle` gate**: add it in REM-5 (proposed), or separately?

**Risks**

- **Irreversible.** Dropped tables cannot come back. This is acceptable only because no production data exists.
  The guard makes it impossible to drop rows that exist. Backups taken before REM-5 restore with the pre-REM-5 code.
- **Reports change source column** (`total_cost` → `acquisition_cost`). Mitigation: the equality assertion on the
  fixture world (step 1) before the switch, plus the existing report tests.
- **drizzle-kit output.** Generated SQL may use `CASCADE` or an order we do not want. Mitigation: hand review and
  the rewrite without CASCADE (d.2). The second generate run must show no changes.
- **Test count changes** (deprecation-trigger tests replaced by CHECK and absence tests, a new rem5 test). The report
  gives the numbers per project.
- **PGlite and PostgreSQL** both run `DO $$` plpgsql (0013 already depends on it); both projects run the new tests.
- **Old local demo databases stop working** after REM-5 by design. The message says what to do.
