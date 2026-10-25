# OPN-1 (with CAT-1): opening balance and stock entry without a product catalog

Branch `claude/opn-1-opening-balance` from main `e7210d2` (MIS-1 merged). **Approved by the owner on 2026-10-24**
with the answers in §9. Decisions already taken and not reopened: D-dec1-2 (Q-3: type + free-text description, product optional),
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
  | `POST /openings/:id/import` | CSV import (§5) |
  | `GET /openings/:id/export` | The draft (or, once sealed, the pieces with their codes) as CSV |
  | `GET /openings/template.csv` | The CSV template: the header row only, Arabic and English column names |
  | `POST /openings/:id/seal` | Sealing (below) |

  The write routes take an Idempotency-Key.
- **A draft is not stock.** Draft lines are not pieces: they cannot be sold, transferred or counted while the
  General Manager is still entering them.
- **Review before sealing (owner answer Q3).** A review screen of the draft shows the count and weight by karat and
  by type, and the lines paged and searchable (type, description, karat). The draft can be exported as CSV, so
  mistakes are caught before the seal.
- **Codes (owner answer Q1).** At sealing each piece gets the next system code (`J-…`) and barcode, in the sheet's
  order (then the keyboard lines in entry order). No custom code column: an old shop number goes in the description
  (free text, up to 120 characters, searchable). After sealing the export lists code, type, description, karat and
  weights, so staff can write the codes on the tags until labels exist (LBL-1).
- **Sealing**, in one transaction:
  - lock the opening row; then for every line create a piece:
    - origin OPENING, status AVAILABLE, `acquisition_cost` NULL;
    - `selling_price` 0, so the price follows the **new-piece rate** (owner answer Q5; PRC-1 computed prices);
    - a status-history row, and an ADJUSTMENT +1 movement with `cost_value` NULL and ref `opening`;
  - **no ledger entry** (no cash: the books start at zero);
  - the opening becomes SEALED; audit `OPENING_SEALED` with the count and the weight by karat.
- **What sealing asks for:**
  - computed prices: on a FIXED_TAG installation sealing is refused (**409 `OPENING_NEEDS_COMPUTED_PRICES`**) until
    the General Manager switches them on (owner answer Q4);
  - the summary is shown first: count and total weight by karat, with a checklist ("register a passkey", "set the
    new-piece rate of every karat in the sheet", "review the draft");
  - the **password** in the body (`reauthenticate`, as MIS-1);
  - a **fresh passkey confirmation** (`passkey_reauth_at` within the window), **always**: a General Manager without
    a passkey is refused (**403 `PASSKEY_REQUIRED`**, "register a passkey first").
- **After sealing:** any write to the opening → **409 `OPENING_SEALED`**; the trigger refuses it in the database too.
- **Barcode scanner entry.** The shop has no labels yet, so there is nothing to scan. The keyboard form is built
  so that Enter moves to the next field and saves the line.

## 5. The importer (CSV only, owner answer Q2)

- **Format.** CSV only: UTF-8 with or without BOM, comma or semicolon (detected from the header row), quoted fields
  with doubled quotes, Arabic-Indic digits accepted. Excel users "Save as CSV UTF-8". XLSX only if the client's real
  data needs it later. No new dependency: a small parser in `shared/` with a property test (round trip of random
  rows, separators, quotes, BOM, digits).
- **Template.** `GET /openings/template.csv`: the header row only, each column named in Arabic and English.
- **Transport and size.** The file is sent as the raw request body (`text/csv`), with a parser on **this route
  only**, limited to **1 MB**; at most **5,000 rows**. Sizing: a typical row (a type of about 15 Arabic letters, a
  short description, the karat and two weights, with separators) is about 110 bytes in UTF-8, so 5,000 rows are about
  550 kB. The worst case (120-character Arabic descriptions) is about 360 bytes a row, about 1.8 MB for 5,000 rows:
  such a sheet is split into two files (each idempotent). The global JSON limit stays 100 kB.
- **Parsing is on the server**, so the same code serves the screen, REH-1 and the tests.
- **Columns** (header row in Arabic or English, any order):

  | Column | Rule |
  |---|---|
  | type | An existing **active** type, matched by its normalized name; the importer **never creates types** (nothing invented) |
  | description | Optional, at most 120 characters |
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
  table, on PGlite and PostgreSQL. An opening piece is also **transferred** (sent, received) and **adjusted**
  (damaged, restocked, returned to a supplier) with its NULL cost: the movements and every report that sums cost stay
  consistent (known-cost pieces only, with the `unknownCostPieces` count), and the inventory ledger's cost totals
  reconcile on the known pieces only.
- **Static guard (owner requirement).** A check in `npm run typecheck` (beside the RPT-2 guard) fails if code joins
  `jewelry_items` to `products` with an inner join: the join must be LEFT, and the type join goes through
  `jewelry_items.category_id`.

## 7. Tests (besides §6)

- **Openings:** one per branch (a second → 409); keyboard lines.
- **Importer:**
  - a good file, a bad file (every error with its row) and a duplicate file (no change);
  - a **300-row file**; comma and semicolon, with and without BOM; a file over 5,000 rows or 1 MB refused;
  - the template's header imports as an empty file (422, nothing written);
  - a property test of the CSV parser (round trip of random rows).
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
| c4 | Openings: service, CSV importer and template, review and export, sealing, routes, tests (300 rows, bad, duplicate, idempotent, sealing refusals) |
| c5 | 0028 tighten + upgrade test |
| c6 | Screens (Types rename, type + description forms, Opening page: entry, import report, review, export, checklist and seal) + i18n + browser e2e |
| c7 | REH-1, perf, acceptance `docs/acceptance/OPN-1.md`, BACKLOG (CAT-1, OPN-1 → DONE; OPN-FIX added), DATA_MODEL, FEATURES, decisions D-opn1-*, `verify --full` |

## 9. Owner answers (2026-10-24)

1. **Codes:** system codes (`J-…` and barcode) at sealing, in the sheet's order; a CSV export after sealing; no custom
   code column; an old shop number goes in the description (searchable).
2. **CSV only** (no XLSX reader); a CSV template; the BACKLOG text says CSV, XLSX later only if the real data needs it.
3. **Correcting a sealed opening is out of scope:** OPN-FIX is added to the BACKLOG as P1 (void an AVAILABLE opening
   piece as MIS-1 does, or correct its weight or karat, with a reason and the password). Built now instead: the
   review screen of the draft and its CSV export.
4. **FIXED_TAG:** sealing refused until computed prices are on.
5. **Rate:** opening pieces sell at the new-piece rate. Open question for the client: "does the existing stock include
   used pieces?" No condition column now.
6. **Passkey:** always the password and a fresh passkey; without a passkey → 403 `PASSKEY_REQUIRED`; "register a
   passkey" is in the pre-seal checklist and the acceptance script.

## 10. Out of scope (stated)

- Labels (LBL-1).
- Opening cash (none, by decision).
- Product rename.
- Correcting a sealed opening (OPN-FIX, BACKLOG P1).
- XLSX import (CSV only, Q2).
- A condition (new/used) column for opening pieces (Q5).
- Auto-creating types from a sheet.
- Per-piece tag prices for opening pieces.
