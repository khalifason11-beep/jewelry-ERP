# OPN-1 (with CAT-1): opening balance and stock entry without a product catalog

Branch `claude/opn-1-opening-balance` from main `e7210d2` (MIS-1 merged). **Waiting for the owner's approval; no code
yet.** Decisions already taken and not reopened: D-dec1-2 (Q-3: type + free-text description, product optional),
D-dec1-3 (Q-4: opening cost unknown = NULL, never 0), D-dec1-7 (labels later, LBL-1 deferred), SPEC §13.

## 1. What exists today (survey)

- **Every piece needs a product.**
  - `jewelry_items.product_id` is NOT NULL.
  - The karat of a supplier piece comes from its product.
  - The type (category) is reached only through product → category.
  - Every reader INNER JOINs `products` and `categories`: the item list and detail, POS search, the inventory report
    and its CSV, the sale detail, the printed invoice, transfer lines, purchase detail, and the profit report's
    category/karat/cashier/day groupings.
  - A piece without a product would therefore **disappear** from all of them.
- **Every cost is NOT NULL.** This covers `jewelry_items.acquisition_cost`, `sale_items.unit_cost/acquisition_cost/
  profit`, `sales.cost_total` and `inventory_movements.cost_value`.
  - The sale snapshot and every stock movement copy the piece's cost.
  - A NULL cost would **crash** the insert of a sale or a movement.
  - Where it did not crash, a NULL would be **silently counted as 0**, in two ways:
    - JS `total - null`: the sales list, the sale detail, and `grossProfit = revenue − costOfSales` on the homes;
    - SQL `sum()` skipping it: report totals, stock value at cost, and the inventory-ledger cost.
  - Both ways **overstate profit** and **understate stock cost** without saying so.
  - The CHECKs themselves accept NULL (e.g. `ck_sale_items_profit_sum`).
- **Names on sale lines.** Only `sale_items.product_name` is snapshotted, and it holds the English name or else the
  Arabic one. The Arabic product name and both type names are read live, so a rename would rewrite old invoices
  (D-cat0-3). **No rename exists** for types or products today.
- **Item codes and barcodes.** Codes are `J-1001…` from one company-wide sequence. Barcodes are
  `628100` + the number padded to 6 digits.
- **No spreadsheet library** is installed; CSV export is client-side only. **Express accepts JSON up to 100 kB.**
- **Re-authentication.** The route flag `reauth: true` requires a fresh password AND a fresh passkey **when the user
  has one**; a user without a passkey passes on the password alone. MIS-1 corrections also take `confirmPassword` in
  the body.

## 2. Data model: three migrations (additive → backfill → tighten)

**0026 `opn1_catalog_optional` (additive only; `DROP NOT NULL` is not destructive)**

- `jewelry_items`:
  - `category_id` (nullable, FK categories) and `description` (text, ≤ 120);
  - `product_id` DROP NOT NULL; `acquisition_cost` DROP NOT NULL.
- `sale_items`:
  - snapshot columns `product_name_ar`, `category_name`, `category_name_ar`, `description` (nullable);
  - `unit_cost`, `acquisition_cost`, `profit` DROP NOT NULL.
- `sales.unknown_cost_lines` (smallint, NOT NULL DEFAULT 0). `sales.cost_total` stays NOT NULL and becomes the
  cost of the **known** lines.
- `inventory_movements.cost_value` DROP NOT NULL.
- New tables:
  - `openings`: `id`, `branch_id` **UNIQUE**, `status` DRAFT|SEALED, `created_by/at`, `sealed_by/at`,
    `session_id`;
  - `opening_lines` (the draft, not stock yet): `opening_id`, `line_no`, `category_id`, `description`, `karat`,
    `gross_weight_mg`, `net_weight_mg`, `source` KEYBOARD|IMPORT, `import_id`, and `item_id` (set at sealing);
  - `opening_imports` (append-only): `opening_id`, `file_name`, `format`, `sha256`, `row_count`, `created_by/at`,
    with **UNIQUE (opening_id, sha256)**.
- A trigger refuses any insert, update or delete of a sealed opening's lines.
- Permission **`opening.manage`**, General Manager only (also added to `GM_ONLY_PERMISSIONS`).

**0027 `opn1_backfill`**

- `jewelry_items.category_id` ← the product's category.
- `sale_items` snapshots ← the live product and type names (once).
- Guarded like 0021: it stops if a row is left unfilled.

**0028 `opn1_tighten`**

- `jewelry_items.category_id` SET NOT NULL (validated).
- CHECK `acquisition_cost IS NOT NULL OR origin = 'OPENING'`: only opening pieces may have an unknown cost.
- Upgrade tests run from 0025 with data.

## 3. CAT-1: the product becomes optional

- **What an item is.** A **type** (required, active) + **description** (optional free text, ≤ 120) + **karat** (an
  allowed karat) + weights. `product_id` may still be sent; then the type and karat must match the product. Existing
  products are not removed.
  - Supplier order lines take `categoryId`, `karat`, `description` (`productId` optional).
  - A sellable scrap piece likewise.
  - The opening uses the same fields.
- **Suggestions.** `GET /catalog/descriptions?categoryId=&q=` returns descriptions already used for that type,
  distinct, most used first, at most 20.
- **Readers:**
  - every item reader moves to `LEFT JOIN products` and `JOIN categories ON jewelry_items.category_id`;
  - display name = description, else product name, else type name;
  - search covers description, type and product names.
- **Sale lines** snapshot both product names, both type names and the description. The sale detail, printed
  invoice, sales report and profit-by-type report read the snapshots, never live names.
- **Rename of a type.**
  - `POST /categories/:id/rename { nameAr, name? }` (`catalog.manage`, General Manager).
  - Normalized-duplicate check as for create (409).
  - Audited with the old and new names.
  - Allowed only after the snapshots exist, so old sale lines keep their names (test: rename, then reprint an old
    invoice).
  - Product rename stays out (not asked).
- **Screens.** The supplier-order line, the scrap form and the opening entry use type + description (with
  suggestions) + karat. The Types screen gains "Rename".

## 4. OPN-1: one opening per branch, DRAFT → SEALED

- **Routes** (General Manager, `opening.manage`, branch scope):

  | Route | What it does |
  |---|---|
  | `GET /openings` | The branches and their opening status |
  | `POST /openings` `{branchId}` | Create the DRAFT; **409** if the branch already has an opening |
  | `GET /openings/:id` | The lines (paged), plus count and total net weight by karat and by type |
  | `POST /openings/:id/lines` | Keyboard entry, one piece |
  | `POST /openings/:id/lines/:lineId/remove` | Draft only |
  | `POST /openings/:id/import` | Spreadsheet import (§5) |
  | `POST /openings/:id/seal` | Sealing (below) |

  The write routes take an Idempotency-Key.
- **A draft is not stock.** Draft lines are not pieces: they cannot be sold, transferred or counted while the
  General Manager is still entering them.
- **Sealing**, in one transaction:
  - lock the opening row; then for every line create a piece:
    - origin OPENING, status AVAILABLE, `acquisition_cost` NULL;
    - `selling_price` 0, so the price follows the **new-piece rate** (PRC-1 computed prices; a fixed-tag
      installation would need tag prices: see Q4);
    - a status-history row, and an ADJUSTMENT +1 movement with `cost_value` NULL and ref `opening`;
  - **no ledger entry** (no cash: the books start at zero);
  - the opening becomes SEALED; audit `OPENING_SEALED` with the count and the weight by karat.
- **What sealing asks for:**
  - the summary is shown first: count and total weight by karat;
  - the **password** in the body (`reauthenticate`, as MIS-1);
  - a **fresh passkey confirmation** (`passkey_reauth_at` within the window), **always**: a General Manager without
    a passkey is refused (**403 `PASSKEY_REQUIRED`**, "register a passkey first").
- **After sealing:** any write to the opening → **409 `OPENING_SEALED`**; the trigger refuses it in the database too.
- **Barcode scanner entry.** The shop has no labels yet, so there is nothing to scan. The keyboard form is built
  so that Enter moves to the next field and saves the line.

## 5. The importer

- **Formats.** CSV (UTF-8, with or without BOM, comma or semicolon, quoted fields) and **XLSX** (first sheet,
  values only). The file is sent as `{ fileName, contentBase64 }` on a route-specific body limit of **2 MB**, at
  most **5,000 rows**.
- **Parsing is on the server**, so the same code serves the screen, REH-1 and the tests.
- **Columns** (header row in Arabic or English, any order):

  | Column | Rule |
  |---|---|
  | type | An existing **active** type, matched by its normalized name; the importer **never creates types** (nothing invented) |
  | description | Optional |
  | karat | An allowed karat |
  | gross weight (g) | 3 decimals, Arabic-Indic digits accepted, gross ≥ net > 0 |
  | net weight (g) | Same rules as gross weight |

- **Validation report.** Every error has its row number, the column and the reason. **One bad row rejects the
  whole file; nothing is written.** A good file returns the count and the weight by karat.
- **Idempotent.**
  - The SHA-256 of the file bytes is stored. The same file again returns the first result and **changes nothing**
    (UNIQUE `opening_id, sha256`).
  - The Idempotency-Key covers a retried request.
  - A different file adds its rows.

## 6. Unknown cost, everywhere

| Where | Today with a NULL cost | After OPN-1 |
|---|---|---|
| Sale line | Insert crashes | `unit_cost`, `acquisition_cost`, `profit` NULL; the sale counts `unknown_cost_lines`; `cost_total` = known lines |
| Sale profit (list, detail, sales report) | `total − null` = total (wrong) | Σ profit of the known lines; **"—"** when every line is unknown; "n line(s) with unknown cost not counted" next to it |
| Profit totals: sales list footer, sales report, profit report (all groupings), homes' gross profit, branch performance | Unknown counted as 0 (profit overstated) | Computed from `sale_items.profit` over known lines; revenue for the margin over the same lines; **`unknownCostLines` shown next to each total** |
| Stock value at cost: inventory list/report footers, homes, branch view, inventory-ledger opening/closing cost | `sum()` skips it silently | Known pieces only, plus **`unknownCostPieces`** shown next to each value |
| Movement | Insert crashes | `cost_value` NULL; the stock count and weight are unchanged (A15 still reconciles count and weight) |
| Item detail "Cost & margin" | Card hidden (as if redacted) or price shown as profit | "Cost: unknown (opening balance)"; margin "—" |
| Valuation by weight × current rate | — | Unaffected (test) |
| CSV exports, paged lists | 0 or a wrong number | Empty cell for the cost and profit, never 0 |

- **Classification.** `unknownCostLines`, `unknownCostPieces` and the new snapshot and opening columns are
  classified in `field-classification.ts`. The counts are **COST**: they only appear beside a cost or profit figure,
  General Manager only. The names, weights and karats are SAFE. The generated role tests cover them.
- **Tests.** A sale of an opening piece, alone and together with a supplier piece, checks every figure in the
  table, on PGlite and PostgreSQL.

## 7. Tests (besides §6)

- **Openings:** one per branch (a second → 409); keyboard lines.
- **Importer:**
  - a good file, a bad file (every error with its row) and a duplicate file (no change);
  - CSV and XLSX of the same rows give the same lines;
  - a **300-row file**;
  - a property test of the CSV and XLSX readers (round trip of random rows).
- **Sealing:**
  - refused without the password (403);
  - refused without a fresh passkey (403);
  - refused for a General Manager without a passkey (403);
  - refused for an empty draft (422);
  - after sealing: a write → 409, and the trigger refuses it.
- **CAT-1:** supplier order and scrap without a product; description suggestions; a type rename leaves old sale
  lines, the printed invoice and the profit-by-type report unchanged.
- **Roles and registries:** route-matrix and generated role tests (cashier and branch manager refused);
  cost-visibility; upgrade test from 0025.
- **REH-1 on an empty production database:**
  - create types, import a file, seal (password + virtual passkey), and sell an opening piece;
  - the stock-weight report equals the sheet's totals;
  - the profit report shows the excluded line.
- **Perf:**
  - a 5,000-row import and seal;
  - the existing list and home cases re-measured with 5,000 opening pieces present;
  - every budget unchanged.

## 8. Commits

| Commit | Content |
|---|---|
| c0 | This plan |
| c1 | 0026 + schema + permission + classification + db-checks + docs + upgrade test |
| c2 | 0027 backfill; CAT-1: readers by type/description, product optional on supplier order and scrap, sale-line snapshots, type rename; tests |
| c3 | Unknown cost everywhere (§6), with tests that sell a piece of unknown cost |
| c4 | Openings: service, CSV/XLSX importer, sealing, routes, tests (300 rows, bad, duplicate, idempotent, sealing refusals) |
| c5 | 0028 tighten + upgrade test |
| c6 | Screens (Types rename, type + description forms, Opening page with import report, summary and seal) + i18n + browser e2e |
| c7 | REH-1, perf, acceptance `docs/acceptance/OPN-1.md`, BACKLOG (CAT-1, OPN-1 → DONE), DATA_MODEL, FEATURES, decisions D-opn1-*, `verify --full` |

## 9. Questions for the owner

1. **Codes of opening pieces (no labels yet, LBL-1 deferred).**
   - Proposal: at sealing every piece gets the next system code (`J-…`) and barcode, in the sheet's order. The
     sealed opening can be exported (CSV: code, type, description, karat, weights), so staff can write the code on
     each piece's tag by hand until labels exist.
   - **Do the pieces already carry the shop's own numbers that must become the code?** If yes, the sheet gets an
     optional "code" column, unique and kept as given, and the system codes are used only where it is empty.
2. **Spreadsheet formats and library.**
   - Proposal: CSV and XLSX, **with no new dependency**. CSV is read by a small parser in `shared/`. XLSX is read by a
     small reader of the first sheet's values: `node:zlib` to unzip, plus the sheet and shared-string XML (about 200
     lines, property-tested).
   - Alternatives:
     - `exceljs@4.4.0`: maintained, but a large transitive tree to pin and to check on Windows;
     - SheetJS: the npm package is stuck at 0.18.5 with published advisories, and newer versions are not on the npm
       registry;
     - CSV only: Excel users "Save as CSV UTF-8".
   - **Approve the no-dependency reader, or choose CSV only?**
3. **What a sealed opening allows afterwards** (SPEC §13 "only audited adjustments").
   - **What exists today** for any piece: the audited inventory adjustments (mark damaged, restock, return to
     supplier: reason, password window), transfers, and price edits.
   - **Nothing corrects a piece entered wrong** (wrong weight or karat, or a piece that does not exist).
   - Proposal: **out of scope here.** The opening is final once sealed. A follow-up item **OPN-FIX** would add a
     General-Manager correction of an opening piece while it is AVAILABLE: void it (VOIDED, as MIS-1) or correct its
     weight or karat, with a reason and the password. **Agree, or build OPN-FIX now?**
4. **A fixed-tag installation.**
   - Opening pieces have no tag price. With computed prices (the default for new installations) they are priced
     from the new-piece rate.
   - Proposal: on a FIXED_TAG installation, sealing is refused until the General Manager switches to computed
     prices. **Agree?** (This client is RATE_COMPUTED, D-prc1.)
5. **Rate for opening pieces.** Should opening pieces sell at the **new-piece** rate (proposal) or the **used-piece**
   rate?
6. **Sealing without a passkey.** The task says password and passkey. Proposal: always both; a General Manager
   without a registered passkey cannot seal. **Agree?** (In production the General Manager must have one already.)

## 10. Out of scope (stated)

- Labels (LBL-1).
- Opening cash (none, by decision).
- Product rename.
- Correcting a sealed opening (Q3, unless approved).
- Auto-creating types from a sheet.
- Per-piece tag prices for opening pieces.
