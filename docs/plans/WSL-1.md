# WSL-1: sell "grains" (حبات) from the broken-scrap pool at the POS

Status: **fast-track** (the owner waived the plan-approval stop on 2026-11-06); built in small commits.

## Business rules (the owner's, unchanged)

- 1 grain = 0.1 g = 100 mg. The quantity is a whole number of grains (> 0); weight = grains × 100 mg.
- The source is the branch's broken-scrap pool of the karat the cashier chooses; that karat decides the price and the
  pool that is reduced. Every existing role of broken scrap (purchase, supplier settlement, opening OPN-3) is unchanged.
- Price: the karat's normal per-gram selling rate (the NEW-piece rate, `gold_rates`), `valueOfWeight(weightMg, rate)`
  on the whole line. No markup, no making charge, no grain rate, no discount on a grain line.
- No cost: a grain line has an unknown cost, like an opening piece (the sale's profit stays NULL for it).
- Who: everyone who may sell at the POS (`sales.create`); no new permission.

## Survey: how the pool is stored (no conflict with the rules)

`scrap_weight_entries` is append-only, one signed row per movement, per **branch and karat**; the balance is
`SUM(weight_mg)`; `lockPool(tx, branchId)` (an advisory transaction lock per branch) serialises every change of a
branch's pool. A sale of grains of karat K is one −weight row of branch B, karat K. **One structural point:**
`sale_items.item_id` is NOT NULL (every sale line is a jewellery piece). Grains are no piece, so they get their own
append-only table `sale_scrap_lines` (additive), and nothing in `sale_items` is loosened.

## Design

- **Migration 0040 (additive):** `sale_scrap_lines` (sale, karat 1–24, grains > 0, weight_mg = grains × 100, the rate,
  the price = the whole-line value > 0; append-only); the pool's event-type CHECK replaced with the wider list
  (`SCRAP_SALE`), marked `-- allow-destructive: D-wsl1-1` as D-opn3-1 did (no row changes).
- **The sale (`POST /sales`)** takes `scrapLines: [{ karat, grains, listPrice }]` next to `items` (either may be empty,
  not both). In the sale's one transaction: the idempotency key, the pricing lock, `lockPool` of the branch, the
  balance re-read per karat under the lock (more than available → 409 `SCRAP_POOL_SHORT`, the existing code), the
  price from the current rate (a difference from what the cashier saw → 409 `PRICES_CHANGED`, as for pieces), one
  `sale_scrap_lines` row and exactly one −weight `SCRAP_SALE` pool row per line (`ref_type` sale_scrap_line).
- **Void (`POST /sales/:id/void`, `sales.void`, unchanged rules):** under `lockPool`, one +weight `REVERSAL` row per
  grain line, same karat.
- **Read:** `GET /sales/:id` returns `scrapLines`; the POS items answer lists the branch's karats with pool weight and
  the rate (`scrapGrains`); the receipt prints a grain line (grains + grams).
- **Screens:** the POS shows one product per karat with pool weight ("كسر مكسر 21 — متاح X جم"); adding it asks the
  number of grains (a whole-number field, the FIX-NUM-1 kit); the line shows grains, grams, the rate and the total; more
  than available is said in Arabic and blocks the sale.

## Tests

Unit and property (weight = grains × 100, whole-line rounding, conservation, never below zero, a void restores
exactly), the route × role tests, an idempotent retry, a PostgreSQL race (two sales of the last grains: exactly one
succeeds), a void racing a settlement, supplier settlement on the remaining pool, the migration upgrade test, REH-1,
e2e (the POS end to end) and the `e2e-numbers` sweep.

## Commits

| # | Commit |
|---|---|
| c0 | this plan |
| c1 | migration 0040, the schema, the enums and DB checks, the upgrade test, DATA_MODEL; REH-1 (41 migrations) |
| c2 | the backend: sale, void, reads, the POS list; tests; the route matrix and SAFE fields; DEPLOYMENT; REH-1 (API) |
| c3 | the screens: POS, sale page, receipt; Arabic; e2e; the sweep; REH-1 (screens) |
| c4 | acceptance, decisions D-wsl1-*, BACKLOG, `verify --full` |
