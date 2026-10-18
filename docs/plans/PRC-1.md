# PRC-1: computed selling prices from the General Manager's per-gram rates (plan)

Owner decisions (final, 2026-10-17): three per-gram rates per karat (new pieces, used pieces, scrap buying); price =
net weight × the current rate of the piece's karat and origin, **live**; no making charge (Q-1 open: a seam only); the
sale locks the price at confirmation; rounding `pricing.roundingStep` (provisional, Q-2); broken scrap unchanged; the
cashier may buy a sellable piece; supplier orders stay General-Manager-only (MKC-1).

## 1. Data model (additive; migration `0024_prc1_computed_prices.sql`)

| Need | Choice | Why |
|---|---|---|
| Used-piece selling rate | **`gold_rates.kind`** `text NOT NULL DEFAULT 'NEW'`, check `kind IN ('NEW','USED')`, index `(karat, kind, effective_at)` | One append-only history and one audited write path for both selling rates: the existing triggers and `REVOKE` keep covering it, the history screen reads one table, and every existing row stays what it was (the selling rate, now named NEW). A second table would need its own triggers, grants, history query and docs for the same thing. `ADD COLUMN … DEFAULT` is metadata-only: it fires no row trigger and rewrites no row. |
| Sale line | **Existing columns** (`pricing_mode`, `price_gold_value`, `price_rate_per_gram`, `price_making_charge`; D-2b-2 made them "so computed pricing can be added without a migration") | A computed line stores `pricing_mode = 'COMPUTED'`, the rate used, the gold value `round(mg × rate / 1000)`, `price_making_charge = NULL` (the Q-1 seam), `list_price` = the computed price, `discount`, `final_price`; profit = final − cost snapshot as today. Old lines keep `FIXED_TAG` and their values. |
| Settings | `pricing.mode` = `RATE_COMPUTED` \| `FIXED_TAG` (default RATE_COMPUTED), `pricing.roundingStep` whole units 1…1,000,000 (default 1, **provisional, Q-2**). GM only (`settings.manage`), audited by the settings history. | No client value in code. |
| An existing installation | The migration writes `pricing.mode = FIXED_TAG` (with its history row, actor `system:migration-0024`) **only when the database already holds pieces** | An upgraded database keeps today's prices exactly until the General Manager sets the rates and switches on the Prices screen; switching silently would reprice every piece (or make it unsellable without a rate). A new installation has no pieces: RATE_COMPUTED. |
| Cashier buys a sellable piece | New permission **`scrap.buy_sellable`** for CASHIER, BRANCH_MANAGER, GENERAL_MANAGER (defaults and migration) | `scrap.buy` keeps its meaning (both kinds, branch manager and GM); the cashier gets the sellable kind only, through the permission system. |
| Stored `selling_price` | Kept, never edited. FIXED_TAG reads it; RATE_COMPUTED ignores it. New pieces received under RATE_COMPUTED store **0** (= "no tag price"); a price ≤ 0 is never sold in either mode. | No data deleted or rewritten. |

The upgrade test builds a database at 0023 with sales (fixed-tag lines), pieces of every origin and gold rates,
applies 0024, and proves: row counts, money totals (`sales.total`, line prices, costs, ledger sums), trigger presence
on `gold_rates`, every old rate is `NEW`, the FIXED_TAG row is written when pieces exist (and not on an empty
database), and the role grants.

## 2. Formulas (`shared/src/pricing.ts`, through `money.ts` only)

- rate kind of a piece: `SCRAP → USED`, `SUPPLIER_NEW | OPENING → NEW`.
- `goldValue = mulDivRound(netMg, rate, 1000)` (whole units, the sale-line component).
- `price = mulDivRound(netMg, rate, 1000 × step) × step`: **one rounding**, after the exact product (BigInt), half
  away from zero; `step = 1` gives the gold value. Missing rate (none, or ≤ 0) → **no price** (never 0).
- SQL mirror for lists and sorting: `round(net_weight_mg::numeric * rate / (1000 * step)) * step` (PostgreSQL `round`
  on numeric is also half away from zero); a test compares SQL and TypeScript on random values on real PostgreSQL.
- Property tests: equals the BigInt reference; monotonic in weight and rate; no overflow at 10 kg × 100,000,000/g;
  rounded once (never round-then-round); Σ line prices = invoice subtotal; result is a multiple of the step.

## 3. API

- `GET /gold-rates`: `current` (NEW, for the top bar, as today), `used`, `history` (with `kind`, who, when).
  `POST /gold-rates`: `{ rates?: {karat: n}, usedRates?: {karat: n} }`; karats = **any karat in
  `inventory.allowedKarats`** (the fixed 18/21/22/24 enum is removed; the setting accepts 8–24); refused otherwise.
  Re-auth and audit as today (`GOLD_RATE_CHANGED`, now with the kind).
- Every item reader (`/inventory/items`, item detail, report, POS grid, transfers, purchase detail, valuation)
  returns the **live** `sellingPrice` (null when the rate is missing), `pricePerGram` and `priceMissing`; FIXED_TAG
  returns the stored price as today.
- `POST /sales` (RATE_COMPUTED): each line carries `listPrice` = the price the cashier saw. The server locks the
  pieces, prices them from the current rates and compares: any difference → **409 `PRICES_CHANGED`** "Rates changed:
  the prices were updated. Check the cart and confirm again." with `details.lines` (id, code, new price, rate). The
  POS updates the cart; the cashier confirms again. A missing rate → 400 "No selling rate for {karat}K
  ({kind}): this piece cannot be sold until the General Manager sets it". Discount limits, payment rules, SEC-2
  reason, voids: unchanged (the discount limit is a percentage of the price at confirmation).
- `POST /inventory/items/:id/price` in RATE_COMPUTED: refused ("prices follow the rates").
- Receiving: `sellingPrice` is no longer required on supplier-order lines and the sellable scrap purchase in
  RATE_COMPUTED (still required and positive in FIXED_TAG; refused if sent in RATE_COMPUTED, never silently dropped).

## 4. Concurrency

A rate change takes `pg_advisory_xact_lock(PRICING)`; a sale confirmation takes the shared form
`pg_advisory_xact_lock_shared(PRICING)` before reading rates. A sale either commits entirely before the new rate
or waits and then sees it (and answers 409 because the cashier saw the old price). Pieces are still locked
`FOR UPDATE` in id order. Tested on real PostgreSQL with two connections (a rate change held open while a sale
waits; many parallel sales and rate changes, every line equals `price(weight, its stored rate)`).

## 5. Screens

- **Prices** (new page, GM, sidebar): three tables per allowed karat (new selling, used selling, scrap buying),
  history with who/when/kind, the mode and rounding step settings. `/settings#rates` and `#scrap-rates` redirect.
- Inventory, item detail, POS grid, transfers: live price; "no rate" badge; POS refuses to add a no-rate piece, with
  an Arabic and English message. Cart: on 409 the new prices replace the old ones with a warning; confirm again.
- Invoice and sales list: price per gram used (computed lines). Receiving forms: no selling-price field
  (RATE_COMPUTED). Scrap page opens to the cashier (sellable kind only). Item price-change button hidden.
- A16 covers both selling rates for every allowed karat; the first-steps "rates" step uses the same list.

## 6. Tests (both projects)

Price math properties; SQL = TS; rate change → inventory, POS, valuation change at once; a confirmed sale keeps its
price; new vs used by origin; missing rate refused and shown; 409 flow; race; cashier: sellable scrap allowed, broken
scrap, supplier orders and rates refused, tolerance/override, drawer BLOCK and bank WARN enforced; FIXED_TAG exactly
as before (the existing suites run the fixture world in FIXED_TAG, set explicitly; the new suites in RATE_COMPUTED);
cost visibility for every new field in both modes; allowed karats 9, 12, 14; RPT-2 guards; upgrade test. REH-1,
e2e print (price per gram), states, UI kit: updated only where the screens change. Perf: POS grid and inventory list
at 10,000 pieces, computed pricing, 300 ms p95.

## 7. Risks

- Live prices change between the grid and the confirmation: handled by the 409 (never a price not seen).
- An upgraded installation stays FIXED_TAG until the GM switches (§1); the acceptance page says so.
- Pieces received under RATE_COMPUTED have no tag price: switching back to FIXED_TAG makes them unsellable (shown as
  "no price"), never priced at 0.
- The correlated rate lookup in lists: indexed `(karat, kind, effective_at)`; measured at 10,000 pieces.

## 8. Questions (not blocking)

1. Q-2 rounding: nearest 1 (default), 100 or 1,000? It is a setting.
2. Should an upgraded installation switch to computed prices automatically once every allowed karat has both
   selling rates? (Built: the GM switches.)
