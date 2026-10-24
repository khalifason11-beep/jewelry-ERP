# MIS-1: mistake correction (SCR-VOID and PUR-FIX)

Branch `claude/mis-1-corrections` from main `86cf030` (DEC-1 merged). **Approved by the owner on 2026-10-19** with the
answers in §6.

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
  tables): `id`, `purchase_id` UNIQUE (checked by a trigger, not a foreign key: D-mis1-3), `reason`, `voided_by`, `session_id`, `created_at`.
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

## 4. PUR-FIX (owner answer Q1: option B, one piece at a time)

- **Table `purchase_corrections`** (append-only, same grants): `id`, `purchase_id`, `purchase_item_id` (set for
  `MAKING_COST`, null for `MAKING_CHARGE_REFERENCE`), `field`, `old_value`, `new_value` (text), `reason`,
  `confirmed_duplicate`, `corrected_by`, `session_id`, `created_at`. Effective value of a field = the latest correction
  of that (piece or order, field), else the original column. `purchases` and `purchase_items` are never updated.
- **`POST /purchases/:id/corrections`** `{ field, purchaseItemId?, newValue, reason, confirmPassword,
  confirmDuplicateReference? }`, General Manager; **422** when nothing changes; refused when the order's effective
  making charge is 0 (no charge and no reference to correct).
- **`MAKING_COST` of one piece:** lock the piece row `FOR UPDATE` first, then check: a SOLD piece → **409** naming its
  code (its sale line keeps its cost snapshot exactly). A new value ≥ 0 is allowed while the order's new effective total
  stays > 0; a correction that would make the total 0 while a transfer reference exists → **422** (Q5). The piece's live
  `acquisition_cost` and `making_charge` change (purchase + new making + other), with two ADJUSTMENT movements (−1 at
  the old cost, +1 at the new cost), so count, weight and stock value at cost reconcile. A sale confirmed after the
  correction snapshots the new cost; one confirmed before keeps the old cost (race test on real PostgreSQL: exactly one
  winner).
- **`MAKING_CHARGE_REFERENCE`:** `validBankReference` (4–40, Arabic-Indic digits and spaces normalized); the same
  effective reference on another order → **409** `DUPLICATE_REFERENCE` unless `confirmDuplicateReference` (audited).
- **Property tests (fast-check)** on random orders and corrections: (a) the order's effective total = Σ effective piece
  values; (b) sold pieces' costs never change; (c) the supplier gold debt never changes; (d) stock value at cost after =
  before − old cost + new cost for each changed unsold piece.
- **Reads:** the order detail shows the correction history (original, each correction, who, when, why); reports, the
  order list and CSV use the effective values. **The supplier gold debt never changes** (asserted).

## 5. Migration 0025 (forward-only, additive)

New tables with append-only triggers and grants; the two permissions granted to GENERAL_MANAGER; **VOIDED added to the
piece status checks** (needs `DROP CONSTRAINT` + `ADD CONSTRAINT` on `ck_jewelry_items_status` and the two
`item_status_history` checks: a pure widening, but the migration guard calls it destructive: §6 Q2). No data row is
changed. Upgrade test from 0024 with data: counts, money totals and triggers unchanged. The same definitions in
`shared/src/db-checks.ts`. **Owner approval (Q2): the three CHECK replacements carry `-- allow-destructive: D-mis1-…`.**

## 6. Owner answers (2026-10-19)

1. **Option B:** one piece's making cost at a time; the order total is the sum of the effective piece values; no share
   function. A SOLD piece is refused (409).
2. **Approved:** VOIDED added to the three status checks with `allow-destructive` markers and a decision recording the
   approval.
3. **Approved as in §3** (original day keeps the purchase; the void day shows the reversal; "excluded from totals" =
   the scrap lists, CSV and report).
4. **No scrap receipt:** the reprint requirement is out of scope.
5. **Approved:** a correction that would make the order's total 0 while a transfer reference exists → 422; a piece's
   making cost may become 0 while the total stays above 0.
6. No time limit on how old a voided scrap purchase may be.

## 7. Commits (after approval)

c1 migration 0025 + schema + permissions + docs (DATA_MODEL, FEATURES) + upgrade test · c2 SCR-VOID service, routes,
reads, tests (incl. race on PostgreSQL) · c3 PUR-FIX service (one piece at a time), routes, reads, property tests, race test ·
c4 screens (void dialog, status filter and badge, detail; correction dialog and history) + i18n · c5 REH-1, browser e2e,
perf, acceptance `docs/acceptance/MIS-1.md`, BACKLOG, decisions D-mis1-*, `verify --full`.

**As built:** the browser e2e (`scripts/e2e-corrections.mjs`) came with the screens in c4, so the screens were proven in
the commit that added them; c5 kept REH-1, perf, the acceptance script and the docs. Findings while building are in
`docs/decisions.md` D-mis1-3 (no foreign key to an append-only table), D-mis1-5 (no scrap CSV or report exists),
D-mis1-7 (a corrected piece out of stock moves no stock).

## 8. Out of scope (stated)

Wrong gold weight or wrong pieces on a supplier order (stay uncorrectable); voiding supplier orders or sales; un-void;
bulk corrections; any other role.
