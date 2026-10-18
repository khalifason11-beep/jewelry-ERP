# MIS-1: mistake correction (SCR-VOID and PUR-FIX)

Branch `claude/mis-1-corrections` from main `86cf030` (DEC-1 merged). **Status: plan only, waiting for the owner's
approval** (the item touches the money ledger and the append-only tables). Questions for the owner are in §6; nothing
in §6 is built before it is answered.

## 1. What exists today (read before deciding)

- **A counter scrap purchase** (`buyScrap`) writes, in one transaction: one `scrap_purchases` row (append-only); a
  SELLABLE piece → one `jewelry_items` row (origin SCRAP, `acquisition_cost` = amount paid), three
  `item_status_history` rows and one `inventory_movements` PURCHASE (+1, `cost_value`); BROKEN scrap → one
  `scrap_weight_entries` SCRAP_PURCHASE (+mg, under the branch pool lock); the money: `ledger_entries` SCRAP_PURCHASE
  −cash on CASH and −bank on BANK (a part of 0 posts nothing), under the drawer lock; one audit row.
- **`reverseRef`** reverses every not-yet-reversed entry of a ref and event type, one REVERSAL row per original
  (`reverses_entry_id`), dated `at` (now). The daily reconciliation files a REVERSAL under the line of the event it
  reverses (`ledger/service.ts`), so each account's lines still add up to its movement.
- **The pool** has a REVERSAL event type already; **inventory movements** have ADJUSTMENT (direction carried per row);
  the **ledger** has REVERSAL. None of these needs a constraint change.
- **Piece statuses** are `AVAILABLE, SOLD, TRANSFERRED, DAMAGED, RETURNED` (CHECK `ck_jewelry_items_status` and the two
  `item_status_history` checks, migration 0016). There is **no VOIDED**.
- **There are no server-side carts or reservations** (REM-5 removed them): a cart lives in the browser; a sale locks the
  pieces at confirmation and refuses one that is not AVAILABLE. "In transit" = status TRANSFERRED.
- **There is no scrap-purchase detail page and no scrap receipt** (only the list; SCR-1 was cancelled, Q-12).
- **Supplier orders: there is no per-piece share rule for the making charge.** Each line (= one piece) has its own
  typed `making_cost`; the order's `making_charge_paid` = Σ of the lines; each piece's `acquisition_cost` =
  purchase + making + other of its line, and its PURCHASE movement carries that cost. Stock value at cost =
  Σ direction × `cost_value` of the movements; a sale snapshots the piece's cost on its line.
- **The transfer reference** (`making_charge_reference`) exists only when the charge is above 0 (MKC-1), normalized by
  `validBankReference` (FIX-2); the same reference on another order warns (409 `DUPLICATE_REFERENCE`, confirm flag).

## 2. Shared rules (both parts)

- New permissions **`scrap.void`** and **`purchases.correct`**, General Manager only (migration grant; route matrix;
  the generated role tests refuse the cashier and the branch manager). One company, so no other-company case.
- Body: `reason` (SEC-2: 3–200 characters after trimming, else **422**), `confirmPassword` (checked by the same
  `reauthenticate` as DEC-1: wrong → **403 `REAUTH_FAILED`**, counted and audited; missing → **403**). The route keeps
  `reauth: true` (window) as every General-Manager money action does.
- Idempotency-Key required, claimed inside the transaction; a replay returns the first result.
- One transaction; the existing locks (piece row `FOR UPDATE`, branch pool advisory lock, drawer lock for consistency
  of balances); every state check after the locks.
- Whole SDG and integer mg; BigInt where products are formed; audit with actor, reason, ids, before/after.

## 3. SCR-VOID

- **Table `scrap_purchase_voids`** (append-only trigger + runtime grants SELECT/INSERT, as the other append-only
  tables): `id`, `purchase_id` UNIQUE → `scrap_purchases`, `reason`, `voided_by`, `session_id`, `created_at`.
  `scrap_purchases` is never updated.
- **`POST /scrap-purchases/:id/void`** `{ reason, confirmPassword }`, General Manager:
  1. lock: the purchase's void row by `purchase_id` (a second void → **409** "already voided" after the UNIQUE check,
     made after the lock); for SELLABLE the piece row `FOR UPDATE`; for BROKEN the branch pool lock.
  2. SELLABLE: the piece must be **AVAILABLE in the purchase's branch**, else **409** naming the code and its status
     (SOLD / TRANSFERRED = in transit / DAMAGED / RETURNED). The piece → **VOIDED** (status history row, an ADJUSTMENT
     −1 movement at its cost, so the stock count, weight and cost balances drop and A15 stays reconciled). It is never
     deleted; its page shows the history.
  3. BROKEN: the pool balance of that karat in that branch must be ≥ the purchase's net weight, else **409** with the
     current balance; post the opposite REVERSAL entry (−mg).
  4. Money: `reverseRef(SCRAP_PURCHASE → REVERSAL)` dated now: both parts of a split purchase are reversed, each
     pointing at its original. The drawer gets the cash back (no drawer block: money comes in).
  5. Insert the void row; audit `SCRAP_PURCHASE_VOIDED` (reason, amounts, piece or weight).
- **Reads:** the list, a new **detail** (`GET /scrap-purchases/:id`), the CSV and the scrap report join the void:
  status VALID/VOIDED, who, when, why; a status filter (all / valid / voided); totals exclude voided purchases and say
  how many were excluded. **The daily reconciliation keeps the true money flow**: the purchase stays on its own day (the
  money did leave) and the reversal appears on the void day under "Scrap purchases" (money back), so every day's lines
  still add up to the account movement; the scrap drill-down marks the voided row and lists the reversal (§6 Q3).
- **VOIDED status:** excluded from every stock reader (they already filter on AVAILABLE / STOCK_STATUSES); never
  selectable, priced, valued, transferable or sold; shown with a badge in the item page and the inventory list filter.
- **Concurrency:** a sale of the piece and a void of its purchase both lock the piece row; whoever is second sees the
  other's status → exactly one wins, the other gets 409 (real-PostgreSQL race test).

## 4. PUR-FIX

- **Table `purchase_corrections`** (append-only, same grants): `id`, `purchase_id`, `field`
  (`MAKING_CHARGE` | `MAKING_CHARGE_REFERENCE`), `old_value`, `new_value` (text), `reason`, `corrected_by`,
  `session_id`, `created_at`, plus `confirmed_duplicate` (boolean). Effective value = the latest correction of the
  field, else the original column. `purchases` and `purchase_items` are never updated.
- **`POST /purchases/:id/corrections`** `{ field, newValue, reason, confirmPassword, confirmDuplicateReference? }`,
  General Manager. Refused with **422** when nothing changes; refused when the order has no making charge (0) for
  either field (no amount and no reference exist to correct).
- **Reference:** `validBankReference` (4–40, Arabic-Indic digits and spaces normalized); the same effective reference on
  another order → **409** `DUPLICATE_REFERENCE` unless `confirmDuplicateReference` (audited), as FIX-2/MKC-1.
- **Amount:** a new total > 0 (§6 Q1, Q2). Sold pieces keep their cost snapshot; pieces not sold take the new making
  cost (§6 Q1 for the share rule). For each changed piece: its `acquisition_cost` and `making_charge` on
  `jewelry_items` change (the live cost of a piece, not history), **and** two ADJUSTMENT movements (−1 at the old cost,
  +1 at the new cost) so stock value at cost follows and count/weight are unchanged; a per-piece line in the audit.
  The share is a pure function in `shared/` with a fast-check test: the new piece making costs (sold ones unchanged)
  add up exactly to the new total; whole SDG; no piece below 0.
- **Reads:** the order detail shows the correction history (original, each correction, who, when, why); reports, the
  order list and CSV use the effective values. **The supplier gold debt never changes** (asserted).

## 5. Migration 0025 (forward-only, additive)

New tables with append-only triggers and grants; the two permissions granted to GENERAL_MANAGER; **VOIDED added to the
piece status checks** (needs `DROP CONSTRAINT` + `ADD CONSTRAINT` on `ck_jewelry_items_status` and the two
`item_status_history` checks: a pure widening, but the migration guard calls it destructive: §6 Q2). No data row is
changed. Upgrade test from 0024 with data: counts, money totals and triggers unchanged.

## 6. Questions for the owner (blocking)

1. **The making-charge share (PUR-FIX).** Today each piece has its own typed making cost; there is no share rule to
   keep. Choose: **(A) recommended** — the General Manager corrects the order's total; the difference goes to the
   pieces not yet sold, **in proportion to their current making cost** (equal shares if they are all 0), whole SDG,
   the remainder one unit at a time to the largest fractional parts (ties: lowest piece id); refused (409) when every
   piece is sold, or when the new total is below what the sold pieces already carry. **(B)** the General Manager
   corrects each piece's making cost one by one (the order total follows as the sum). (B) needs a per-piece form.
2. **VOIDED status = replacing three CHECK constraints** (widening only, no data change). CLAUDE.md asks for the
   owner's approval and a `-- allow-destructive: D-mis1-…` marker on any DROP CONSTRAINT. Approve, or prefer another
   way (there is no existing status that means "voided").
3. **Reconciliation:** confirm the reading in §3 — the original day keeps the purchase (true money flow) and the void
   day shows the reversal; "excluded from totals" applies to the scrap-purchase lists, CSV and report, not to past
   cash days (changing a past day would break the reconciled figures and the counts already made).
4. **Receipt:** there is no scrap receipt to reprint (SCR-1 cancelled). Skip that requirement, or build a printed
   scrap receipt now (new screen, out of the stated scope)?
5. **Amount to 0 / from 0:** a correction to 0 would leave a transfer reference with no charge. Refuse a new amount of
   0 (proposed), or allow it and clear the effective reference?

## 7. Commits (after approval)

c1 migration 0025 + schema + permissions + docs (DATA_MODEL, FEATURES) + upgrade test · c2 SCR-VOID service, routes,
reads, tests (incl. race on PostgreSQL) · c3 PUR-FIX share function + property test, service, routes, reads, tests ·
c4 screens (void dialog, status filter and badge, detail; correction dialog and history) + i18n · c5 REH-1, browser e2e,
perf, acceptance `docs/acceptance/MIS-1.md`, BACKLOG, decisions D-mis1-*, `verify --full`.

## 8. Out of scope (stated)

Wrong gold weight or wrong pieces on a supplier order (stay uncorrectable); voiding supplier orders or sales; un-void;
bulk corrections; any other role.
