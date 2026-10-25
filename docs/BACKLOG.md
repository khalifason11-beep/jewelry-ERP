# Jewelry ERP — Backlog

Version 1.0 · 2026-10-05 · Place this file at `docs/BACKLOG.md`. Read `docs/SPEC.md` first: this file refers to its sections and question IDs (Q-n).

**ملخص بالعربية:** هذه قائمة المتابعة الوحيدة المعتمدة. فيها ما أُنجز، وما يجب حذفه (المصروفات، صفحات حصاد، البيانات التجريبية)، وما يجب إصلاحه (زر التحويل في سلة البيع، رقم عملية التحويل البنكي)، وما يجب بناؤه (كتالوج الأنواع، التسعير المحسوب، الرصيد الافتتاحي)، ثم التصميم، ثم الجاهزية للإنتاج. كل بند له معيار قبول مكتوب.

---

## 0. Working agreement for the new session

1. **One phase at a time.** Propose a plan for the phase first (files, migrations, risks, questions) and wait for approval. Stop after each phase with a report.
2. **Do not reopen [BUILT] items** unless a backlog item says so. Do not guess [OPEN] questions: ask, or implement a setting with the conservative default and flag it.
3. **Every phase ends with:** typecheck (including `check:docs`), tests on PGlite and real PostgreSQL, build, `npm run i18n:check`, migration applied to a copy of an existing database, docs updated (`README.md`, `docs/FEATURES.md`, `docs/DATA_MODEL.md` for any schema change) and `docs/decisions.md` updated, push, and **a short manual acceptance script** the owner can follow in a desktop browser.
4. **Acceptance of any user-facing flow includes the empty-database rehearsal (REH-1).** Automated tests passed for every earlier phase and still missed that an empty production database cannot receive stock. Do not repeat that.
5. When a client-facing flow is ambiguous, show the owner a screenshot or a sketch **before** building the whole flow. Two earlier misreadings (the transfer button, the hidden pricing gap) cost more than a sketch would have.
6. Update the status of every item in this file at the end of each phase.

**Legend.** Status: DONE, PARTIAL, TODO, BLOCKED (needs an answer), DEFERRED. Size: S (about a day), M (2–4 days), L (a week or more). Priority: **P0** blocks the first real data, **P1** before the pilot branch goes live, **P2** before a second branch, **P3** later.

---

## A. Done (reference only)

Details and reasons are in `docs/decisions.md` and `docs/DEPLOYMENT.md`.

| Area | Commit | Summary |
|---|---|---|
| Analysis | `6c34b83` | Phase 0 report, findings and plan |
| Production safety, auth | `041ebcb` | `APP_MODE`, bootstrap, argon2id, lockout, sessions, CSRF, CSP |
| Settings, branding, permissions | `0e0e7c2` | Typed settings with history, branding, branches, route matrix, cost redaction |
| Integrity | `911b3ba`, `2dd1c93` | CHECK constraints, append-only tables, idempotency, real-PostgreSQL tests, burst-safe lockout, separate DB roles |
| Cost model and money ledger | `aa186c0` | Item origin and cost, sale-line profit, per-branch ledger, reconciliation, cash count |
| Backups | `e4cff19` | Encrypted off-site backups, restore drill, health warnings |
| Purchases, scrap, supplier | `38d1f92`, `b3866fe` | Karat restriction, broken-scrap pool, supplier gold settlement, POS payment methods, Hasad receivable settlement |
| Second factor | `adb0cb8`, `1ef63ba` | Passkeys, recovery codes, security lock, operator recovery |
| Printing | `ced586f`, `08f5b80`, `80ea307` | Browser and Windows-driver printing, reprints, footer, lockfile guard |

---

## B. Remove and clean

### REM-1 — Remove Expenses · DONE · M · P0
**Why:** the client gives staff a fixed operating amount; no expenses screen is wanted (SPEC §9).
**Scope:** navigation entry, pages, routes and services, permissions `expenses.*` and their role grants, expense settings (approval thresholds and similar), pending-expense notifications, expense lines in the Cash screen and the daily reconciliation, expense columns in reports, i18n strings, demo/test seed rows, tests, docs.
**Database:** forward-only and non-destructive. Keep the tables, columns and the ledger event type so history stays valid; stop all writes; mark them deprecated in `docs/DATA_MODEL.md`.
**Acceptance:**
- No word "expense" or "مصروف" is visible anywhere in either language.
- Routes return 404; the permission matrix, generated tests and the field registry are updated.
- The reconciliation equals the old result for sales, scrap purchases, making charges and settlements.
- Depends on Q-6 only for CSH-3 (what replaces it; named CSH-2 before the funding work), not for the removal.
- The daily reconciliation keeps the SPEC §18 invariant: its lines sum exactly to each account's movement in the ledger; event types without a line of their own (e.g. a historical `EXPENSE` entry) appear under "Other".

**Done:** routes, service, permissions (deleted from existing databases by migration 0013), setting, notification, dashboard and report figures (with "contribution", which equalled gross profit once expenses were gone), Cash-screen lines, i18n, seed and tests removed. The `expenses` table, its CHECKs and the `EXPENSE` ledger event type stay for history; migration 0013 adds triggers that refuse new expense rows and new `EXPENSE` ledger entries. See `docs/decisions.md` D-rem1-*.

### REM-2 — Reduce Hasad to a sales channel · DONE · L · P0
**Why:** SPEC §10. The word Hasad stays only as a payment method.
**Remove:** the `modules/hasad` backend module, `frontend/src/pages/hasad/*` (workspace, list, branch table, simulator), the `integrations/hasad` workspace package, the Hasad simulator and mock mode, counter sessions and entitlement/weight-difference settlement, settings `hasad.*`, permissions `hasad.*` and their grants, navigation entries, notifications, report columns, `docs/HASAD_INTEGRATION.md`, related tests and e2e scripts.
**Keep (pending Q-7):** the HASAD payment method with its manual reference fields, the `HASAD_RECEIVABLE` account and the settle-by-bank action. A prepaid pickup is an ordinary sale paid through Hasad.
**Database:** keep historical tables and columns, mark deprecated; no new writes.
**Acceptance:**
- `grep -ri hasad` in the source finds only: the payment-method enum and labels, the POS reference fields, the receivable account and its settlement (if kept), migrations and historical records in `docs/decisions.md`.
- A new D-entry in `docs/decisions.md` supersedes the earlier Hasad decisions.
- All gates pass; sales reports can be grouped by channel (cash, bank, Hasad).

**Done:** the module, pages, `integrations/hasad` workspace package (lockfile regenerated: pure removals), simulator, mock mode, counter sessions, weight-difference settlements, Hasad delivery receipt, `hasad.*` / `mockHasad.*` settings, `hasad.*` permissions, navigation, notifications, report and dashboard figures, branch Hasad code field, i18n strings, seed rows and tests. **Kept:** the HASAD payment method and its references (the invoice prints them), the `HASAD_RECEIVABLE` account and the settle-by-bank action (Q-7 still open). Sales reports show completed sales **by payment channel**. Migration 0014 releases pieces still reserved by an open counter session, deletes the permissions and refuses new rows in the historical tables (including the `hasad_mock` schema) and new `HASAD_SETTLEMENT` ledger entries; historical entries show under "Other" in the reconciliation. The mock table definitions moved to `database/src/deprecated-hasad-mock-schema.ts` only so that drizzle-kit never generates an accidental DROP. Superseding decision: `docs/decisions.md` D-rem2-*.
**Guarded by `npm run check:hasad`** (part of `npm run typecheck`; allow-list `scripts/hasad-footprint-allowlist.json`, one reason per entry). **`grep -ri hasad` (source) still finds, besides the payment method, its references and the receivable:** the deprecated table definitions, CHECK lists, enum values and field classifications kept for history until REM-5, migrations 0013/0014, and comments explaining the removal.

### REM-3 — No demo data · DONE · L · P0
**Why:** the owner rejected the demo data as confusing and unrealistic, including illogical item names in the scrap-purchase dropdown (SPEC §4, §16).
**Plan:**
- The shipped system and `npm run demo` start with **reference data only** (roles, permissions, what bootstrap creates). A guided "first steps" checklist replaces sample content.
- Automated tests move to their own fixture builders under the test tree; nothing in the product depends on seeded sales, items or customers.
- Remove the demo accounts list from the login page, the fake company name, the demo reset action and any text that mentions a prototype.
- An optional sample set may exist for development only, behind an explicit command, using client-approved names.
**First-run work (owner decision Q-H):** `ALLOWED_KARATS_INITIAL` (read only at the first start, while the setting row does not exist; the code default stays for other clients), a **mandatory** "allowed karats" step in the first-steps checklist, and the inventory karat filter derived from the setting instead of the hardcoded list.
**Risk to manage:** most of the test suite depends on the seed (baseline before REM-1, 2026-10-05: **1,424 tests** = 694 on PGlite + 730 on real PostgreSQL, 35 test files; after REM-1: 1,393 = 679 + 714; after REM-2: 1,249 = 606 + 643; after its follow-up: 1,251 = 607 + 644; after CAT-0: 1,336 = 648 + 688, 38 test files).
**Never leave the system without a way to enter stock:** CAT-0 must be done before the seed is deleted. Replace it with fixtures first, keep the suite green, then delete the seed.
**Acceptance:**
- A fresh database, in demo and production modes, shows no items, sales, customers or suppliers.
- The e2e scripts create their own data through the API.
- All tests pass on both projects; README and DEPLOYMENT no longer describe demo content.

**Done (7 commits, `20065c0` … step 7):** tests start from their own fixture world (`backend/test/fixtures/`, never shipped; step 1 kept the count at 1,336); the e2e scripts start an empty server, bootstrap it and build their data through the API (`scripts/lib/e2e-world.mjs`); the demo seed, catalog, reset (route, CLI, `npm run db:reset`, Settings card), demo ledger backfill, simulated presence sessions, demo-only route/setting mechanism, login-page accounts, `DEMO_TWO_FACTOR` and all "Prototype" wording are deleted; `npm run demo` asks for the GM username in an interactive terminal (normal rules) or prints the bootstrap command; a neutral "Demo" badge in demo mode only; the four-step **first-steps** checklist (`GET /setup/status`, audited `POST /setup/allowed-karats`, guarded setting `inventory.allowedKaratsConfirmed`), `ALLOWED_KARATS_INITIAL`, empty states (rate chip, branch home, POS) and the inventory karat filter from the setting; **`npm run dev:sample`** (development only, marked placeholder names); gates **`check:migrations`** (destructive statements after 0015 need `-- allow-destructive: <reason>`) and **`check:test-imports`**, both in `typecheck` and unit-tested. REH-1: 93 checks, including a fresh demo-mode database. Tests: **1,400** = 680 on PGlite + 720 on real PostgreSQL, 42 test files. Decisions D-rem3-1…11; acceptance `docs/acceptance/REM-3.md`.

### REM-5 — Drop the deprecated tables, columns and enum values · DONE · M · P0
**Why:** REM-1 and REM-2 keep the expense and Hasad tables, columns and enum values (with triggers refusing new rows) so history stays valid. No production data exists yet, so dropping them before the first production deployment is the cheapest moment.
**Scope:** one separate, final migration: the `expenses` table, the Hasad withdrawal/redemption/settlement tables, the `hasad_mock` schema together with **`database/src/deprecated-hasad-mock-schema.ts` (delete the file in the same commit, and its line in `database/drizzle.config.ts`)**, `branches.hasad_branch_code`, the deprecated item cost columns (section G), the `EXPENSE` / `HASAD_SETTLEMENT` ledger event types and other retired enum values, the matching CHECKs in `shared/src/db-checks.ts`, the field-classification entries, the leftover `settings` rows of removed keys, the triggers added by REM-1/REM-2, the `sessions.is_simulated` column (no longer written since REM-3), the DEPRECATED entries of `scripts/hasad-footprint-allowlist.json`, and the EXPENSE / HASAD_SETTLEMENT entries of `OTHER_EVENT_TYPES` once no history can contain them.
**When:** after REM-3 and CAT-0 are proven (REH-1 green), before the first production deployment.
**Acceptance:** fresh database and an upgraded copy both migrate; backup/restore drill passes; all gates pass. Every destructive statement carries its own `-- allow-destructive: <reason>` comment (`check:migrations`, D-rem3-6).
**Done (3 commits, `348c219`, `40bee23`, step 3; plan `docs/plans/REM-5.md`, decisions D-rem5-1…7, acceptance `docs/acceptance/REM-5.md`):** migration **0016** with a guard that stops (and changes nothing) when any row still uses a removed table or value; the expense and Hasad tables, `hasad_mock`, the old item cost and reservation columns, `sessions.is_simulated`, `branches.hasad_branch_code`, RESERVED/REDEEMED, `HASAD_REDEMPTION`, `EXPENSE`/`HASAD_SETTLEMENT`, the deprecation triggers and function and the leftover `hasad.enabledPerBranch` row are gone; `UNIQUE (purchase_items.item_id)`; item cost derived from `acquisition_cost` and the supplier line. New gate `check:drizzle`. Hasad allow-list 251 → 174 allowed lines, 10 → 7 entries, none added (the 4 new lines are REH-1's REM-5 checks, under the existing GUARD entry). Tests: **1,476** = 718 on PGlite + 758 on real PostgreSQL (3 drizzle-gate tests run in the PGlite project only), 46 test files.

### REM-4 — Remove duplicate transfer entry points · DONE · S · P1
After FIX-1: remove the inventory multi-select transfer bar and the Transfers page's "New transfer" dialog. **Sub-question for the owner:** keep a GM emergency override (password plus reason, audited) somewhere out of the way, or drop it?
**Done with FIX-1 (`17300b7`, D-rem4-1).** Owner decision: the General Manager **keeps** "New transfer" on the Transfers screen as the GM's only start point, under the same rules as the POS transfer. Removed: the Inventory "Select & transfer" card view and the branch manager's "Select pieces in Inventory" button. Start points are exactly the BM's POS cart and the GM's "New transfer".

---

## C. Fix

### FIX-1 — Transfer button in the POS cart · DONE · M · P0
**Done (`17300b7`, D-fix-1, plan `docs/plans/POS-FIXES.md`, acceptance `docs/acceptance/POS-FIXES.md`):** "Transfer to branch" below "Complete sale" for the branch manager; courier's name required (`transfers.courier_name`, migration 0019); all or nothing with row locks (`ITEMS_UNAVAILABLE`, nothing changed); Idempotency-Key required and claimed in the transaction; races tested on PostgreSQL.
**Misreading to correct:** the owner asked for the button **in the sales cart, below the pay button**. The earlier build put multi-select on the inventory screen and a "New transfer" button on the Transfers page.
**Requirements (SPEC §8):**
- Visible only to branch managers (permission `inventory.transfer`, own branch), never to cashiers.
- Below "Complete sale". It opens a destination-branch list (own branch excluded), the courier's name (required) and an optional note, then creates **one** transfer containing every cart item.
- Items must be available; they become IN_TRANSIT and leave the cart; idempotent; audited; cost unchanged.
- The Transfers page remains a log, with the confirm-receipt action for incoming transfers.
**Acceptance:** a branch manager adds 3 items, transfers them from the cart, and the log shows one transfer with 3 items; a cashier never sees the button (role test); a double click creates one transfer; the receiving manager confirms and the items move with their data.

### FIX-2 — Bank transfer reference number · DONE · M · P0
**Done (`1a14985`, D-fix-2):** required for Bank transfer, normalized (Arabic-Indic and Persian digits, spaces, case) and validated (4–40); stored in the existing `payment_ref_transaction` (Hasad references unchanged; no per-method migration needed); duplicates in the branch warn with 409 and are audited when confirmed; shown on the invoice and receipt, sale detail and list, and the Cash drill-down "Bank-transfer sales"; validated database check after a guard (migration 0018). The list does not need a separate export: the Cash drill-down and the sales list (CSV) show the references.
**Why:** selecting Bank transfer shows no transaction-number field; that causes trouble at review.
**Requirements:**
- Mandatory reference when the method is Bank transfer (trimmed, 3–40 characters). Store it on the sale; a generic `payment_reference` is preferred over per-method columns (migrate the Hasad reference fields consistently).
- Show it in the sales list, the sale detail, optionally on the invoice (a setting), and in an exportable list for matching bank statements.
- Warn and require confirmation when the same reference exists on another sale (audited).
- Voids keep the reference; the cost-visibility registry is updated.
**Acceptance:** the POS blocks completion without the number; tests cover all three methods, duplicates and voids; the reconciliation screen lists bank sales with their references.

### FIX-3 — Direction of negative amounts · DONE · S · P3
Done in commit `c056506` (an `Amount` component: the U+2212 sign and the digits are one `dir="ltr"` run in the summary, the table and the receipt; PDFs in `docs/print-check/` regenerated).
In the invoice summary a negative discount renders as "32,000−" while the line table shows "−32,000". Wrap signed numbers consistently (`dir="ltr"` span or U+2212) in the summary, the table and the receipt, and regenerate the PDFs.

### FIX-4 — Windows native binding on the owner's laptop · BLOCKED (owner) · S · P1
`@node-rs/argon2` fails to load on the owner's Windows machine although the lockfile is correct (verified). Findings: `Test-Path node_modules\@node-rs\argon2-win32-x64-msvc\argon2.win32-x64-msvc.node` returned `False`, Node reports `x64`. Next steps: `npm config get omit`, `npm ci` after deleting `node_modules`, check antivirus quarantine, fall back to WSL2 or Codespaces. Not a repository defect. Add the final cause to the README's Windows note.

---

## D. Build

### CAT-0 — Minimal "create product" · DONE · S/M · P0
**Why:** today only the demo seed creates products, so an empty production database cannot receive stock (SPEC §4). REM-3 deletes the seed; this must exist first.
**Requirements:** create a product with name, karat and type (category); General Manager and branch manager; also inline in the supplier purchase and scrap purchase forms. Audited; karat limited by `allowedKarats` for sellable pieces. No invented names are shipped.
**Acceptance:** on an empty production database (REH-1) a branch manager creates a product inline and records a supplier order and a sellable scrap purchase. CAT-1 stays as written and still waits for Q-3.
**Done:** "New type", "New product" and "New supplier" dialogs (Arabic name required, English optional), inline from the supplier-purchase line and supplier select and from the sellable-scrap form (karat fixed); a **Types & products** screen (GM deactivates/reactivates with a reason). Duplicates refused after normalization (migration 0015, unique indexes, `jerp_normalize_name`). A supplier purchase now requires a supplier. Production bootstrap seeds no types. Filters use the type id. REH-1 does all of it on an empty production database. See `docs/decisions.md` D-cat0-*; manual script `docs/acceptance/CAT-0.md`.

### CAT-1 — Item types and stock entry without a product catalog · DONE · M · P0
**Done (with OPN-1, plan `docs/plans/OPN-1.md`, migrations 0026–0028, `docs/acceptance/OPN-1.md`):** a piece is a
**type** (required, active) + a free-text **description** (≤ 120 characters, searchable, suggestions from the
descriptions already used for the type) + **karat** + weights. The product is optional on the supplier order line, the
sellable scrap purchase and the opening balance; when given, it fixes the type and the karat. Existing products stay.
Every reader joins the product LEFT and the type through the piece (static guard `check:item-joins`). The General
Manager creates, **renames** (`POST /categories/:id/rename`, audited, duplicates refused) and deactivates types; sale
lines snapshot both product names, both type names and the description (0027 filled the old lines), so a rename never
changes a past sale, invoice or profit-by-type report.
**Q-3 closed (owner, 2026-10-18, D-dec1-2):** the General Manager adds item types by hand (nothing shipped); an item is
type + free-text description + karat + weights; **a product catalog is not required: CAT-1 makes the product optional**
on every stock entry (supplier order, sellable scrap, opening balance) without removing existing products.
**Note after CAT-0:** types and products can now be created (CAT-0), so the empty-database blocker is gone; what remains is the Q-3 question (catalog vs free text) and **rename**. Before allowing a rename, snapshot the Arabic product name and the type names on sale lines (today only the English product name is snapshotted; D-cat0-3).
**Problem:** a production database created by bootstrap holds categories only, and no screen creates a product. **No stock can enter an empty production system** (purchases and the future opening balance both need it).
**Requirements:**
- The GM manages a bilingual **list of item types** (create, rename, deactivate). Production ships empty; the names come from the client in real Sudanese terms. Do not invent them.
- An item is type + free-text description (with suggestions from previously used names) + karat + weights. A product catalog with SKUs becomes optional or is dropped, per Q-3.
- Replace the scrap-purchase "type and name" dropdown with the type list plus a free-text name.
**Acceptance:** on an empty production database created with the bootstrap command, a branch manager can record a supplier order and a scrap purchase with no seeded catalog. This is part of REH-1.

### PRC-1 — Computed pricing · DONE · L · P0 · Q-1, Q-2, Q-5 open
**Done (plan `docs/plans/PRC-1.md`, decisions D-prc1-1…10, `docs/acceptance/PRC-1.md`, migration 0024):** per allowed
karat the General Manager sets a selling rate for new pieces, one for used pieces and the scrap buying rate (Prices
page, append-only history, audited); price = round(net weight × rate) once, by `pricing.roundingStep` (provisional,
Q-2); no making charge (Q-1: a documented seam, `sale_items.price_making_charge` stays NULL). Receiving asks for no
price; the POS sends piece ids and the price shown, the server prices at confirmation (409 `PRICES_CHANGED` when a
rate moved); the sale line stores the rate and the gold value. `FIXED_TAG` keeps the old behaviour (existing
installations stay on it until the General Manager switches). The cashier buys a sellable piece (`scrap.buy_sellable`).
**Open:** Q-1 (making charge), Q-2 (rounding), Q-5.
**Requirements (SPEC §5):**
- New pricing mode `RATE_COMPUTED`: price = GM sell rate (per karat) × net weight, with the making charge, override and rounding per the answers to Q-1/Q-2 (settings until answered).
- Receiving stock no longer asks for a selling price. The inventory list and the POS show the live computed price.
- The price is locked at confirmation; if the GM changes the rate while a cart is open the cart warns and reprices. The sale line stores the rate used, the gold value and the final price; profit = final price − cost, unchanged.
- A **Prices screen** for the GM (gold and scrap rates, history), moved out of Settings; the header shows the current 21K rate.
- Exact integer arithmetic through `shared/src/money.ts`; property tests; a concurrency test of a rate change racing a sale; invoice and sales list show the price per gram; migration keeps existing fixed-tag lines valid.
**Acceptance:** after the GM changes the rate, a new cart shows the new price; a confirmed sale keeps its price; all money tests and cost-visibility tests pass.

### OPN-1 — Opening balance, import and sealing · DONE · L · P0 · CAT-1
**Done (plan `docs/plans/OPN-1.md`, decisions D-opn1-1…7, `docs/acceptance/OPN-1.md`):** General Manager only
(`opening.manage`), one per branch (409), DRAFT → SEALED. Keyboard entry (Enter moves on; no labels exist to scan,
LBL-1) and **CSV import** (`text/csv` body on that route only, 1 MB, 5,000 rows; Arabic or English headers; types matched
by name, never created; one bad row rejects the file with every problem by row and column; the same bytes again change
nothing), a CSV template, the review (count and weight by karat and by type, lines paged and searchable) and the CSV
export. Sealing: computed prices (409 on FIXED_TAG), the password and a fresh passkey always (403 `PASSKEY_REQUIRED`
without one); codes in the sheet's order; pieces origin OPENING, cost NULL, price from the new-piece rate, ADJUSTMENT +1
at a NULL cost, no ledger entry; then 409 `OPENING_SEALED` and database triggers. **Unknown cost everywhere**: every
profit figure covers the lines of known cost and carries `unknownCostLines` (profit "—" when none is known; margin over
the known revenue); stock value at cost carries `unknownCostPieces`; valuation by weight × rate unaffected (D-opn1-6).
The used-pieces question was answered on 2026-10-25 and built by OPN-2.
**Requirements (SPEC §13):** GM-only, one per branch, DRAFT → SEALED.
- Entry by keyboard and barcode scanner; **CSV import** with a validation report (row numbers, the whole file rejected on errors, idempotent) and a CSV template. **CSV only (owner, 2026-10-24, D-opn1-2):** XLSX only if the client's real data needs it later.
- Items get origin OPENING with **weight and karat only**. **Q-4 closed (owner, 2026-10-18, D-dec1-3): their cost is
  UNKNOWN (null), never zero.** A sale line of a piece with unknown cost shows profit as "—", is **excluded from profit
  totals**, and every report that totals profit says how many lines were excluded. Valuation by weight × current rate
  is unaffected. Supplier-piece cost stays as built. **No cash entries** (books start at zero).
- Before sealing show count and total weight by karat; sealing needs password and passkey confirmation; afterwards only audited adjustments.
**Acceptance:** importing a 300-row file creates the items, the stock-weight report matches the sheet's totals, and sealing locks the draft. Part of REH-1.

### OPN-2 — Condition (new or used) of opening pieces · DONE · S · P0 · OPN-1
**Done (plan `docs/plans/OPN-2.md`, decisions D-opn2-1…4, migrations 0029–0031, `docs/acceptance/OPN-2.md`):** owner,
2026-10-25: the existing stock includes used pieces; a used piece sells at the USED rate, exactly like sellable scrap.
Every piece carries `rate_kind` (NEW or USED; required from 0031, tied to the origin: scrap USED, supplier NEW), read by
every price (sale, lists, their sort and totals, POS search, piece page, reports, homes). Every opening line has a
condition, required with no default (keyboard choice reset for every piece; CSV column, Arabic or English, normalized;
missing or unknown → row and column, file refused); template, export and review by karat **and** condition; sealing
refused with 409 `OPENING_RATES_MISSING` naming the karats; 0030 stops on a draft with lines (D-opn2-2); openings
sealed before OPN-2 keep their pieces NEW (D-opn2-3). Inventory: a "Used" badge, a new/used filter, the piece page names
its rate. Not built: correcting the condition after the seal (OPN-FIX).

### OPN-FIX — Correct a piece of a sealed opening · TODO · S · P1 (before real operation) · OPN-1
**Owner, 2026-10-24 (D-opn1-3):** a sealed opening is final. A General-Manager correction of an opening piece while it
is AVAILABLE: void it (VOIDED, as MIS-1 does for a scrap piece) or correct its weight or karat, with a reason and the
password, audited, never by editing history (status history, ADJUSTMENT movements). Not built by OPN-1, which adds a
review screen and a CSV export of the draft so mistakes are caught before the seal.

### LBL-1 — Barcode labels for physical pieces · DEFERRED (Q-9: labels later) · M · P3
Print a label (code, karat, weight, Code128 or QR) for each piece, from the opening import and from every receipt. Needs the printer model and label size.

### CSH-2 — The General Manager's funding of a branch, split payment on scrap, negative balances · DONE · M · P0
**Done (plan `docs/plans/CSH-2.md`, decisions D-csh-1…9, `docs/acceptance/CSH-2.md`):** GM_ADVANCE / GM_REPAYMENT per branch into or out of the drawer or the bank, with "owed to the General Manager" derived from an `OWED_TO_GM` ledger account (migration 0020), corrections by reversal, GM only (Cash page); counter scrap purchases paid part cash, part bank transfer (migration 0021); CASH outflows blocked below zero, BANK below zero raises attention A17; the first step "Fund the branch". **Open with the client (Q11):** is the General Manager's funding a loan to be repaid or capital? Until answered, opening money recorded as an advance is a debt of the branch to him.

### CSH-3 — Cash-out entry for the operating amount · CANCELLED (Q-6)
**Q-6 closed (owner, 2026-10-18, D-dec1-4):** the fixed operating amount is handled outside the system; nothing is
recorded. Do not build. (Original text kept below for reference.)
(Was CSH-2 before the funding work took that name.) If the operating amount leaves the drawer: a minimal audited cash-out record (amount, reason, actor) posted to the ledger. Not an expenses module. It may turn out to be one more General Manager ↔ branch movement (see CSH-2).

### Mistake correction (before real operation)

Two P1 items share one goal: a General-Manager-only, audited way to correct a record entered by mistake, with a
reason and the password re-confirmation, never by editing or deleting history.

#### SCR-VOID — Correct a wrong counter scrap purchase · DONE · S · P1 (before real operation)
**Done by MIS-1** (plan `docs/plans/MIS-1.md`, decisions D-mis1-1..5, acceptance `docs/acceptance/MIS-1.md`): `POST /scrap-purchases/:id/void`, General Manager only (`scrap.void`), reason and password; the money reversed (both parts), the sellable piece → VOIDED (only while available in its branch) or the pool weight taken back (only if the pool holds it); the list and the new detail show VOIDED with who, when and why; totals leave voided purchases out. Original request:
A wrong scrap purchase cannot be corrected today: `scrap_purchases` is append-only and has no void. A General-Manager-only void that reverses the ledger entries (both parts of a split payment: `reverseRef` already does it, tested in `scrap-split.test.ts`), the inventory piece or the pool weight, with a reason and the password re-confirmation. Needed before the shop works on the system.

#### PUR-FIX — Correct a wrong supplier order amount or transfer reference · DONE · S · P1 (before real operation)
**Done by MIS-1** (owner answer Q1 option B; decisions D-mis1-6..8): `POST /purchases/:id/corrections`, General Manager only (`purchases.correct`), reason and password; one unsold piece's making cost at a time (the order's charge is the sum of the pieces; a sold piece is refused) or the order's transfer reference; append-only history; every reader uses the effective values; the gold debt never changes. Wrong gold weight or wrong pieces stay uncorrectable (out of scope). Original request:
MKC-1 (owner decision Q13): a supplier order recorded with a wrong making-charge amount or a wrong transfer reference
cannot be corrected today. A General-Manager-only correction, with a reason and the password re-confirmation, audited,
that keeps the original values in the history. It moves no branch money (the owner pays making charges personally,
D-mkc-1); a correction of the pieces' costs must keep every sold piece's cost snapshot as it was.

### SUP-1 — Warn on a new supplier order while gold is still owed to that supplier · DONE · S · P1
**Done (plan `docs/plans/SUP-1.md`, decisions D-sup-1…4, `docs/acceptance/SUP-1.md`, no migration):** a supplier
allows one open order at a time (client fact). When the General Manager chooses a supplier that is still owed gold (any
branch: a supplier belongs to the company), the purchase form says how much (24K grams), from which order and for how
many days, before saving; "Record anyway" records it. The server asks the same (409 `SUPPLIER_GOLD_OWED`) and audits
the confirmation. Never a block, never a money amount. The facts come from the same query as attention A6, which is
unchanged. **Open client question:** after how many days should an open supplier debt become a warning on the
attention list? (`purchases.supplierDebtMaxAgeDays`, default 30, not confirmed.)

### MKC-1 — Supplier making charges paid personally by the owner · DONE · S–M · P1
**Done (plan `docs/plans/MKC-1.md`, decisions D-mkc-1…10, `docs/acceptance/MKC-1.md`, migration 0022):** a supplier
order records the payment fact of its making charge: paid by the owner by one bank transfer from the owner's
personal account (`OWNER_PERSONAL`), with the transfer reference and date (General Manager only). It moves **no
branch money**: no drawer, bank or OWED_TO_GM entry, and the branch owes nothing. The making charge stays in each
piece's cost, so cost and profit are unchanged. A reference already on another order asks "record anyway?" (never a
block). Creating supplier orders is General-Manager-only. The General Manager records an order only after the pieces
have arrived at the branch. The gold side (debt in pure 24K, settled only with broken scrap) is unchanged.
**The CSH-2 workaround is no longer needed:** recording the owner's making charge as an advance into the branch bank
(and paying the order "from the bank") was a way to keep the branch's money right before MKC-1. Do not use it any more:
it would make the branch owe the owner a cost he bears himself.

### DOC-1 — README as a description of the system; docs brought up to date · DONE · S · P1
**Done (plan `docs/plans/DOC-1.md`, documentation only, no migration, no behaviour change):** `README.md` rewritten by
capability (status: pre-production until §F is done); new `docs/FEATURES.md`; `docs/ARCHITECTURE.md` replaced and
`docs/DATA_MODEL.md` rewritten to the current schema (migrations 0000–0022, ledger accounts and event types,
append-only tables); `docs/DEMO_SCRIPT.md` and `docs/DEPLOYMENT.md` corrected (hosting undecided, neutral example
names); the acceptance scripts open the codespace on `main`. New gate `npm run check:docs` (in `typecheck`): every
migration and append-only table named in DATA_MODEL, every permission code in FEATURES.

### CLN-1 — Clean-up found during DOC-1 · DONE · S · P1
**Done (plan `docs/plans/CLN-1.md`, decisions D-cln1-1…3, no migration):** `APPEND_ONLY_TABLES` includes
`gm_funding_events`, with a drift test against the migrations (both projects); the first steps say the General Manager
records the first supplier order; the top bar's rate follows the allowed karats instead of a hardcoded 21K; the
settings nothing reads (`rates.rateChangeMaxPct`, `rates.goldRateScope`) are hidden and refuse writes (RAT-1, RAT-2);
real-looking names replaced by marked placeholders (fixture world, tests, CLIs, docs); the root package is
`jewelry-erp`; DEPLOYMENT keeps Render only as a worked-example appendix; `docs/phase0-report.md` is in `docs/archive/`.
**Security:** `APP_MODE` is required (D-cln1-1 supersedes D-1a-2): absent, empty or misspelt stops the server and every
CLI; the demo and development entry points set `APP_MODE=demo` themselves.

### CLN-2 — Display time zone from the company setting; unused fixture translations · DONE · S · P1
**Done (plan `docs/plans/CLN-2.md`, no migration):** the browser no longer hardcodes `Africa/Khartoum`: dates, times
and "today" use the company time zone sent with the session (`frontend/src/lib/zone.ts`; the settings default is the
visible fallback before the session loads). A business-day key is formatted as that calendar day in every zone (it
moved by one day in zones more than 12 h from UTC). Test `backend/test/display-zone.test.ts`. The backend already used
`company.timezone` everywhere. The Arabic dictionary entries of the old fixture branch and city names are removed.

### CLN-3 — Codespaces and proxies that rewrite Origin · DONE · S · P0
**Done (plan `docs/plans/CLN-3.md`, decisions D-cln3-1, D-cln3-2, no migration):** behind the Codespaces port forwarder
(which rewrites Origin and Host), passkeys now use the public host from the trusted forwarded headers when
`TRUST_PROXY` is on and `APP_ORIGIN` is unset (`backend/src/core/origin.ts`); production (APP_ORIGIN required) is
unchanged. The Codespace sets `TRUST_PROXY=1`; the docs say never to set `APP_ORIGIN` there. A browser with a leftover
valid session cookie can sign in again (the sign-in steps need no CSRF token but keep the Origin check; the old session
is ended). DEPLOYMENT §6 checks that the reverse proxy passes Origin unchanged. Tests `proxy-origin.test.ts`,
`login-stale-cookie.test.ts` (both projects).

### SAFE-1 — Change safely, deploy safely · DONE · M · P0

Hardening only; no screen, text, setting or number changed (plan `docs/plans/SAFE-1.md`). `CLAUDE.md` (standing rules,
gates, what needs the owner's approval); CI on every push and pull request (required checks `typecheck`, `test-pglite`,
`test-postgres`, `build`; `smoke` not yet required); migration checksums and a destructive-statement gate; an upgrade
test from 0015 and 0019 with realistic data; the rollback story; pool limits and survival of a database restart;
graceful shutdown; request id and a working API access log; `/api/ready`; explicit `TRUST_PROXY` and `STRICT_DB_ROLES`
in production; `TZ=UTC`; cache headers; `.env.example`; `docs/runbooks/`; the read-only `scripts/server/preflight.mjs`;
`npm run verify`.

### DEC-1 — The owner's decisions of 2026-10-18 · DONE · S · P0
**Done (plan `docs/plans/DEC-1.md`, D-dec1-1…13, `docs/acceptance/DEC-1.md`, no migration):** Q-2, Q-3, Q-4, Q-6,
Q-7, Q-8, Q-9, Q-10, Q-12 and RAT-2 recorded in SPEC §20 and here; discounts off (every role's cap defaults to 0, the
setting stays editable); the gold-rate edit guard (RAT-1); the UX-1 allowed-karats finding closed with a test.

### SPL-1 — Split payments · TODO · M · P1 · planned with HSD-2 as **PAY-1**
**Q-7 closed (owner, 2026-10-18, D-dec1-5):** one invoice may be paid by two methods (rare, e.g. cash + bank transfer).
**Design:** a payment is **one or two lines**; each line has a **method**, an **amount** and a **reference** (required
for bank transfer and Hasad, as today); the lines **sum exactly to the invoice total** (integer money, refused
otherwise); one ledger entry per line in the same transaction as the sale; a void reverses each line through its own
method; the invoice **prints one line per method**. Idempotency-Key and audit as for every sale.

### MNY-1 — Money transfers between branches and to the General Manager · TODO · M · P1
**Q-8 closed (owner, 2026-10-18, D-dec1-6):** required. **Design:**
- Parties: **branch ↔ branch** and **branch → General Manager**.
- The **sender** (branch manager of the sending branch, or the General Manager; **never a cashier**) records an amount
  from either the **cash drawer** or the **bank account** of the branch. The sending balance drops at once (the drawer
  rule applies: it cannot go below zero) and the transfer is **IN_TRANSIT** (through `FUNDS_IN_TRANSIT`).
- The **receiver** (branch manager of the receiving branch, or the General Manager) **confirms**; the receiving
  balance rises.
- A confirmed amount that **differs** from the sent one leaves the transfer **DISPUTED** for the General Manager;
  nothing is adjusted silently.
- Idempotency-Key required; every step audited; one transaction with row locks per step.

### HSD-2 — Hasad is a sales channel only: no receivable · TODO · M · P1 · planned with SPL-1 as **PAY-1**
**Q-7 closed (owner, 2026-10-18, D-dec1-5):** Hasad money lands in the General Manager's own account, not in the branch.
- Remove the `HASAD_RECEIVABLE` account and the **settle-by-bank** action (Cash › Hasad transfers).
- Hasad stays a **payment method with a required reference**, and appears as **its own channel** in the sales reports
  and the daily summary (Hasad versus direct sales).
- The branch cash reconciliation **never expects Hasad money**.
- A **forward-only migration with the usual guard** (stop and report on data it cannot transform; no history edited).
- Plan it together with SPL-1 under the name **PAY-1**.

### RAT-1 — Maximum change of a gold rate in one edit · DONE (DEC-1)
**Done (owner decision 2026-10-18, D-dec1-11, D-dec1-13, `docs/acceptance/DEC-1.md`):** a change of a selling rate
(new or used) or a scrap buying rate above `rates.warnChangePercent` (10) needs a reason (422), above
`rates.confirmChangePercent` (30) the reason and the password in the request (403); first rates are not checked;
compared inside the transaction under the rate lock; audited with the percentage. History of the item below.
The setting `rates.rateChangeMaxPct` (default 5) existed on the Settings screen but nothing read it. Since CLN-1 it is
hidden and every write is refused (stored default and history untouched). **Open client question:** is there a maximum
percentage by which a rate may change in one edit, and what happens above it (refuse, or ask for a confirmation)?
Build only after the answer, then make the setting writable again.

### RAT-2 — One gold rate for the company, or one per branch · DONE (as built)
**Closed (owner, 2026-10-18, D-dec1-10):** one gold-rate set for the whole company, shared by all branches, exactly as
built. `rates.goldRateScope` stays hidden (GLOBAL). Nothing to build.
The setting `rates.goldRateScope` (default GLOBAL) existed on the Settings screen but nothing read it: the rate has
always been company-wide. Since CLN-1 it is hidden and every write is refused (stored default and history untouched).
**Open client question:** is the gold rate one for the whole company, or can each branch have its own? A per-branch
rate needs rate history per branch, the POS and the top bar reading the branch's rate, and the reports.

### SCR-1 — Customer identification on scrap purchases · CANCELLED (Q-12)
**Q-12 closed (owner, 2026-10-18, D-dec1-9):** not needed; the optional customer fields stay as they are.
Name, phone, optionally an ID number, and a printed receipt for the customer.

### RPT-1 — Report review after the removals · TODO · M · P1
Re-verify every report after REM-1, REM-2 and PRC-1; add reporting by payment channel and the bank-reference list; confirm no report shows cost to non-GM roles. Add the **scrap bought at an override price** list (A8, report only, D-ux-9).

### RPT-2 — Reports never silently drop rows · DONE · S · P0
Found in BE-7: the Sales, Purchases and Inventory reports added up their totals from at most 1,000 rows. Now the totals
and summaries are SQL aggregates over every row, the screen shows at most the cap with the true count and a warning, and
the CSV holds every row (plan `docs/plans/RPT-2.md`, D-rpt2-1…4, `test/report-caps.test.ts`).

### UX-1 — Adding stock is easy and hard to get wrong · DONE · M · P1
One number field for the whole app (money, grams, integers; no spinner or wheel, digits only with Arabic digits
accepted, refused keys and pastes say why, units, grouping, empty stays empty), identifier rules (phone, references),
a dd/mm/yyyy date field; the server refuses bad numbers on every stock, rate, cash, funding and sale field (one fix:
the scrap karat was coerced); the invented supplier-order pre-fill (×1.22, 10,000/g) removed; labelled and hinted
supplier-order fields; one searchable product picker with inline create on both stock entries; "Add another piece",
Enter flow, net-weight sum, plain disabled reason; the scrap customer details in one closed optional section (plan
`docs/plans/UX-1.md`, D-ux1-1…9, `docs/acceptance/UX-1.md`). Open for the owner: plan §7 questions 1 and 2.

### WGT-1 — Weight precision per deployment · DEFERRED · M · P3
**Q-14 closed (owner):** this client's scales read to **0.001 g** (1 mg), which is exactly how the system already works (integer milligrams, three decimals). **Nothing changes for this client.** Build WGT-1 only if another client weighs to two decimals: then a per-deployment setting for the number of weight decimals, input validation on every form, import and the API, one formatter everywhere, and documented totals.
**No quantisation of the pure-24K debt is needed:** at milligram precision the 24K equivalent of a net weight is rounded to the nearest milligram, and every integer debt can be settled exactly: for every karat 1–24 the conversion step (`round((n+1)·k/24) − round(n·k/24)`) is at most one milligram, so every integer owed value is reached by some whole-milligram weight. REM-3 adds a property test for this.
**PRC-1 note:** the computed price (rate per gram × net weight in mg / 1000) applies its rounding rule (Q-2) once, after the multiplication.

### SEC-2 — Void re-confirmation and reasons for price changes · DONE · S · P1
**Done (`97a07f5`, D-sec2-1, D-sec2-2):** `sales.voidReauthAboveAmount` (default **0** = every void asks, owner decision; GM only); one reason per sale for any price change (`SALE_PRICE_CHANGED`, `sales.price_change_reason`, migration 0017, never printed); item price-edit reason required. **Also in this bundle, LOCK-1 (`bd478fb`, D-lock-1):** managers see security-locked accounts as the first notice; the reporter sees a note in their own tab only.
**Owner decision D-ux-10.** (1) Voiding a sale **above an amount set in Settings** (GM setting, default to be proposed) requires the **password re-confirmation** used elsewhere (and the passkey where the role requires it). (2) Changing a piece's selling price requires a **reason** (today optional). Both audited as today. Not part of any UI phase.
**Acceptance:** a void above the threshold without re-confirmation is refused (403 with the re-auth code), below it is unchanged; a price change without a reason is refused; tests on both projects; route matrix and permission tests updated.

### BE-1 — Attention endpoint · DONE · M · P1
**Done (UI-B commits `200aa14`, `9f24345`, D-ui-17, D-ui-18):** `GET /api/attention` with the pilot set below plus S1 (only one passkey) and S2 (touch-only keys), which moved out of the shell's notice area; A9 backups is **critical** for the GM on every page. Settings `cash.countDifferenceTolerance` (0) and `purchases.supplierDebtMaxAgeDays` (30) in Settings › Business rules. Each signal raises and clears in `attention.test.ts` (both projects); no line carries a cost or a supplier money amount; the statement count is constant with more branches. `GET /notifications` (the bell) is removed.
**Owner decision D-ux-14.** One extensible endpoint **`/api/attention`**, role- and scope-aware (GM: all branches; BM: own branch; cashier: none). Each signal: type, **severity** (critical / warning / info), **count**, **branch**, **link**, short text key + params. Thresholds are **GM settings** (D-ux-12).
**Pilot minimum set** (`docs/ux/ANALYSIS.md` §3): **A1** transfers in transit, **A2** transfer stale (`transfers.pendingClaimStaleHours`), **A4** cash-count difference (+ `cash.countDifferenceTolerance`, default 0), **A5** missing cash count, **A6** supplier gold owed per supplier and its age (+ `purchases.supplierDebtMaxAgeDays`, default 30), **A9** backup health, **A10** sign-in from a new device, **A11** failed sign-ins, **A12** locked accounts, **A15** stock does not reconcile, **A16** no gold/scrap rate set. **Deferred:** A3 (needs a dispute feature), A7 (depends on Q-7), A8 (report only, RPT-1), A13, A14; A17 not now.
**Acceptance:** each signal has a test that raises and clears it; **tests prove a branch manager never receives a signal that exposes a COST field** (field-classification registry); the route is in the route matrix with its scope.

### BE-7 — Server-side pagination and sorting · DONE · M · P1
**Owner decision D-ux-15.** Sales, inventory, audit, purchases, scrap purchases and transfers page and sort on the server (50 rows per page, max 200), with the filters of R11. Today inventory loads up to 1,000 rows into the browser. CSV export keeps exporting the whole filtered result.
**Acceptance:** lists stay correct and fast with 10,000 pieces and 20,000 sales on real PostgreSQL; cost-visibility tests still pass on every page.
**Done (plan `docs/plans/BE-7.md`, D-be7-1…7):** offset pages with an id tiebreaker and a snapshot id, exact totals, fixed sort keys (cost keys GM only), whole-result table totals, CSV by walking every page, migration 0023 (`sale_items(sale_id)`). Measured on 60,140 sales and 90,376 pieces (PostgreSQL 16): every list p95 ≤ 177 ms (budget 300). `test/paging.test.ts` (every page of every list for every role), `test/business-day.test.ts` (the Khartoum midnight in every list).

### TAX-1 — Official tax invoice · NOT NEEDED (Q-9)
**Q-9 closed (owner, 2026-10-18, D-dec1-7):** the current invoice is enough; a thermal receipt printer.
Only if the client is legally required to issue one.

### ROL-1 — Custom roles · DEFERRED · L · P3
Do not build. Keep permission identifiers granular and centralized.

---

## E. User interface redesign

**Design source (D-ux-0):** the owner approved the static mockups in `docs/ux/mockups/`; **their CSS variables are the source of truth for the tokens**, written out in `docs/design-reference/tokens.md`. No Figma export files will be provided; the Figma screenshots shown earlier are not in the repository. Hierarchy, density and role focus: `docs/ux/BRIEF.md` and `docs/ux/ANALYSIS.md` (rules R1–R16 as decided in `docs/decisions.md` §14).

**Order (D-ux-13):** UI-A1 and UI-A2 come **right after REM-3** and **before** PRC-1, OPN-1 and FIX-1/FIX-2, so the new screens are built on the new design system. UI-B and UI-C follow the functional items they depend on.

### UX-0 — UX analysis · DONE
`docs/ux/ANALYSIS.md`, baseline screenshots `docs/ux/baseline/` (at commit `00d0f89`; `scripts/capture-ui-baseline.mjs`), static mockups `docs/ux/mockups/`. Approved with decisions D-ux-0 … D-ux-16.

### UI-A1 — Design system, app shell and plain login · DONE
Done on 2026-10-09 (plan `docs/plans/UI-A1.md`, decisions D-ui-1 … D-ui-9, acceptance `docs/acceptance/UI-A1.md`). The owner moved the **shell and a plain login into UI-A1** (instruction of 2026-10-09).
- Tokens from `tokens.md` in `frontend/src/index.css` (the old colour names point at the new values until UI-B/UI-C), contrast test; white page and flat grey panels everywhere.
- Base components split per file; outlined danger buttons (filled red only for the last confirm in a dialog); dialog focus trap; toasts announced; `/ui` page in development only with `scripts/capture-ui-kit.mjs` (screenshots, keyboard checks, axe-core).
- English labels for every code (`lib/i18n-en.ts`, enforced by `i18n:check`); the stray "$" on the branch dashboard.
- App shell per role as in the mockups (`layout/nav.ts`): no POS link for the GM, Active users for the branch manager, icons only for the cashier; rate chip, Demo badge, bell, language pill, avatar menu; no clock; security banners unchanged; no cost or profit in the shell for non-GM roles (REH-1).
- Plain centred sign-in, one frame for sign-in, password change and passkey enrolment.
- Before/after screenshots at 1366×768, 1536×864 and 1920×1080: `docs/ux/baseline-ui-a1/` at commit `36e4e1e`; the slim WebP selection in `docs/ux/screens/` (D-ui-10).

### UI-A2 — Screen states, notices, sign-in tagline · DONE
Done on 2026-10-09 (plan `docs/plans/UI-A2.md`, decisions D-ui-10 … D-ui-16, acceptance `docs/acceptance/UI-A2.md`).
- **Screenshots policy:** only the latest "after" set, WebP, in `docs/ux/screens/`; `check:assets` (4 MB, 150 KB per image); the old sets left the working copy (history not rewritten).
- **One state contract on every screen:** skeleton on first load (title and filters stay), previous rows kept while filters reload, empty texts with next actions, neutral prompts, errors with Try again, API refusals as no-access, missing records as not-found, a crash page with a reference id (details to the server log). Audit bugs fixed and tested (Settings endless spinner, errors shown as "empty", vanishing filters, POS "no pieces" before branches, reports by address).
- **Notice area:** all security and system notices in one compact place on every screen, two lines then "+ N more", the new-sign-in alert first; nothing dismissible.
- **Sign-in:** tagline from the new settings (public endpoint reduced to an allow-list), "Welcome back" and the tagline in self-hosted Amiri.
- **Still open, decided elsewhere:** GM branch switcher and the attention list (UI-B); login image panel only if a licensed image is added; USD chip until Q-10.

### UI-B — Homes, branches, sales list · HOMES DONE · M · P1 · UI-A2, BE-1, BE-7
**Homes done (commits `200aa14` to `98f0848` and the UI-B docs commit; D-ui-17…22, `docs/acceptance/UI-B.md`):** the GM home (Sales dark card, one surface, attention list, branch strips, 14-day sales line instead of the branch bars, gold position; Today by default, remembered; scope pill `/overview?branchId=`; empty versions) and the branch manager's home (expected cash with the last count, stock, gold owed in grams, attention, Team today; no cost); the attention control replaces the bell; the home figures tied to the Sales report, the list and the ledger by entry date; home requests p95 ≤ 86 ms on 60,000 sales without a new index. **Still open, a separate plan (owner answer Q13), next, before UI-C:** **UI-B3** the Branches page and the sales list with filter pills, on **BE-7** server-side pagination: **planned** in `docs/plans/UI-B3.md` (six questions), not built, waiting for the owner's acceptance notes on the finished screens. The cashier's POS layout is UI-C1 (D-ui-22).
GM home and BM home as in `docs/ux/mockups/gm-home.html` and `bm-home.html`: **Sales as its own dark card**, the other three figures on one light surface (D-ux-1); default period **Today**, remembered per user in the browser; GM level 1 shows grams and value together; attention list from BE-1; branch bars **labelled by branch name** in the palette of `tokens.md`. The branch manager's home has no cost figures. Branches page and sales list with filter pills and server-side pagination (BE-7). Level 1 fits 1366×768 without scrolling (R14).

### UI-C — All other screens · TODO · L · P1
POS first (as `cashier-home.html`: Cash first and selected by default, Hasad fields only when Hasad is selected; owner reviews a screenshot before the build; built with FIX-1 and FIX-2), then scrap (form first) and supplier purchases, a Suppliers page (gold owed per supplier, A6), cash, transfers (no horizontal overflow), inventory (7 default columns + drawer), settings, security, users, reports. Empty states as in `docs/ux/ANALYSIS.md` §8.

---

## F. Production readiness

| ID | Item | Owner | Priority | Depends on |
|---|---|---|---|---|
| **REH-1** | **Empty-database rehearsal script** (`npm run rehearsal`, Playwright). Bootstraps an empty database in **production mode on real PostgreSQL**, behind a local TLS proxy with a self-signed certificate that the script starts itself (passkey RP `localhost`; the production start-up checks are not relaxed), then runs: branch → users → item types → opening import → sale by cash, bank (with reference) and Hasad → print and reprint → void → scrap purchase (clean and broken) → supplier order and settlement → transfer from the cart and receipt → cash count → backup and verify. Build it incrementally and run it before accepting any phase. **PARTIAL:** bootstrap → GM first sign-in (password change, passkey, recovery codes) → branch → branch manager and cashier → their first sign-in → no expense wording on any screen in Arabic or English, expense routes gone, no Hasad withdrawal wording or menu entry, Hasad routes and report gone, the POS offers Cash / Bank transfer / Hasad, reconciliation lines add up → CAT-0 catalog entry in the forms → audit trail; REM-3: first-steps checklist (karats confirmed, gold and scrap rates, branch, staff), empty states, no Demo badge in production, and a fresh demo-mode database that is empty, lists no accounts and shows the Demo badge; the New branch and New user dialogs keep typing in the field the person chose, checked deterministically with paused timers; REM-5: the production database has none of the removed objects, all 17 migrations applied, one supplier line per piece; UI-A1: the plain sign-in page, the sidebar per role equal to the mockups (no POS for the GM, icons only for the cashier), no cost or profit word or figure in the shell for the branch manager and the cashier in both languages, "Bank transfer" in the English POS; UI-A2: every list's empty text in both languages, the shell notices (one line each, none for the branch manager, no USD chip), the sign-in tagline in self-hosted Amiri, the public answer limited to the branding allow-list (130 checks). | Engineering | **P0** | grows with each phase |
| HOST-1 | Decide hosting (Q-11): managed PostgreSQL (paid), region, domain, Shell access for operator commands; separate staging and production. The domain must be final before any passkey is registered. | Owner | **P0** | |
| DEP-1 | Staging deployment in production mode following `docs/runbooks/first-deploy.md`: `STRICT_DB_ROLES=true`, `TRUST_PROXY` verified (real client IPs in the audit log), the preflight all PASS, monitors on `/api/health` (backup warning) and `/api/ready` (any 503). Make `smoke` a required CI check once it has been green for two weeks. | Owner + engineering | P1 | HOST-1 |
| BKP-1 | Backup key pair stored in two places; off-site target; daily schedule; weekly drill on a separate machine; **a restore performed by someone other than the developer**; result recorded. | Owner | **P0** | HOST-1 |
| 2FA-1 | Enroll passkeys on the GM's real devices (two), print recovery codes, test the lost-device procedure on staging. | Owner | P1 | HOST-1, Q-11 |
| HW-1 | Hardware tests on the client's real printer (the 15-item checklist in the printing report and `docs/DEPLOYMENT.md` §9), barcode scanner, silent-printing shortcut (the `.cmd` template has never run on Windows). | Owner | P1 | |
| TRN-1 | Staff training for cashier, branch manager and GM; a written runbook for the operator commands (unlock, GM password, security lock). | Owner | P1 | |
| PIL-1 | Two-week parallel run with paper using the checklist. Proposed go/no-go: daily sales total, item count and stock weight match the paper records for 10 consecutive business days. | Owner + client | P1 | all of the above |
| SEC-1 | Independent human security review and `docs/SECURITY.md` (threat model, pass/fail checklist, residual risks) before a second branch. | Owner + reviewer | P2 | |
| LEG-1 | Written agreement with the client (Q-13): hosting cost, support hours, who holds keys and credentials, continuity if the developer is unavailable. | Owner | P1 | |
| **DEMO-1** | **A plan for a public demo.** The old hosted demo (a service started with `npm start` in demo mode, which seeded fictional data and listed demo accounts) cannot run from the default branch since REM-3: `npm start` creates no General Manager and no data, so it starts empty and nobody can sign in; `npm run demo` needs a terminal; PGlite on an ephemeral disk is lost at every deploy. Decide before showing the system publicly: where it runs (its own service and database, never next to production), who bootstraps it, which sample data (client-approved names, see `dev:sample`), how and how often it is reset, and that it never shares credentials or data with production. | Owner + Engineering | P2 | REM-3 |

---

## G. Technical debt and known limits

- The per-IP sign-in limiter lives in process memory: run **one server instance** until it moves to the database.
- ~~`docs/ARCHITECTURE.md` and `docs/DATA_MODEL.md` date from the prototype~~: **resolved by DOC-1** (rewritten; `check:docs` guards migrations, append-only tables and permission codes).
- Branch and city names of the test fixture world (Khartoum, Omdurman, Bahri, Port Sudan) remain in the fixture (places, not people); their Arabic dictionary entries were removed in CLN-2. The UI kit page says "21K" / "Khartoum" as sample values (development only).
- Several screens pass **data** through the UI dictionary (`t(r.branchName)`, `t(b.city)` in the sales, purchases, scrap, users, sessions, audit and branch lists), so a branch or city name shows its English form in the Arabic UI unless the dictionary happens to contain it. Show the stored Arabic name (`nameAr`) instead (found in CLN-2, not changed).
- The English fallback of audit descriptions writes money as `… SDG` (`shared/src/audit.ts`), not the company's currency label; the UI renders audit entries from key + params with the configured label, so only the stored English fallback text is affected (found in CLN-2).
- `scripts/i18n-check.mjs` still has a scan for English text in `/seed/` files; no such folder exists since REM-3 (harmless; remove when the script is next touched).
- The test fixture world (copied from the old demo seed) is built relative to *today* in Khartoum time, so its content changes with the weekday and the hour. REM-3 step 7 fixed the three date-dependent failures it found: a fixed supplier-settlement weight exceeding the debt on one weekday in seven; an audit lookup that assumed today's purchase exists in the first minutes after midnight; and sale-line counts that included a voided sale of the same piece. It was then checked on 14 consecutive dates at three hours of the day. A fixed clock for the world would remove the class of problem (open).
- The silent-printing `.cmd` template is untested on Windows; CSS page size on a given thermal driver is a request, not a guarantee.
- ~~Hasad double-notification risk (D-2a-8)~~: **resolved by scope change** (REM-2 removed the Hasad integration).
- Single-role database deployments still work but log a security warning.
- **No rate limit on write endpoints** (SAFE-1 audit). Sign-in and passkey failures are limited (5 per account, then
  15→60 min; 30 per IP per 15 min) and bodies are capped at 100 kB (512 kB for the logo), but an authenticated session
  can send writes as fast as it likes. Needs an owner decision (a per-session limit, and its numbers) before a second
  branch.
- A request for a hashed file that no longer exists (an old browser tab after an update asks for the previous
  `/assets/index-<old>.js`) gets `index.html` with status 200, so the tab fails to load its script instead of getting a
  clear 404; a reload fixes it (found in SAFE-1, not changed).
- ~~REH-1 failed now and then on the CI runner after check 66~~: **fixed in SAFE-1** (a race in the rehearsal script,
  not in the app). The diagnostics added in SAFE-1 showed the cashier still on the change-password form with no error:
  the URL changes before the sign-in form is replaced, so the first fill could land in the sign-in form's password field
  and the required temporary-password field stayed empty, which makes the browser refuse the submit silently. The script
  now waits for the change-password form alone and checks the typed values before submitting.
- `npm run test:pg -w @jerp/backend` sets its variable with POSIX shell syntax, so it does not run in the Windows
  command prompt (`npm test` with `TEST_DATABASE_URL` does).
- ~~**The Sales, Purchases and Inventory reports read at most 1,000 rows**~~ (found in BE-7): **fixed by RPT-2** (totals
  in SQL over every row; a visible cap on screen with the true count; every row in the CSV; D-rpt2-1…4).
- ~~Found in UX-1: Settings offers 9, 12 and 14 K as allowed karats, but `POST /gold-rates` takes only `KARATS`~~:
  **fixed by PRC-1** (D-prc1-7, rates follow `inventory.allowedKarats`); DEC-1 closes it with `dec1-karats.test.ts`.
  ~~The discount caps 3/10/20 %~~: **decided** (Q-2, D-dec1-1: no discounts; caps default 0, DEC-1). The time-zone
  default is still a setting without a recorded decision.
- Two lists outside the reports still cap silently (RPT-2 plan, items 6 and 7): Cash › Hasad transfers (newest 200,
  CSV included) and Active users (300 sessions; its four tiles count those rows). Page them with the BE-7 helper, or
  leave them: owner decision.
- BE-7 limits that the screens show: the POS grid and the transfer picker hold the largest page (200 pieces) and offer
  the search for the rest (the picker says so); a page changed under a filter by a void can still move a row (the
  snapshot only stops new rows). The next index if sales grow far beyond 60,000: `sales(created_at, id)` (D-be7-6).
- **PERF-1 (known debt, FIX-5):** the perf script's sales CSV walk (`/reports/sales`, 60,137 rows in 301 pages) takes
  about 35 s against its 30 s budget on the development container, on main as on the OPN-2 branch: median 35,132 ms
  on main (`22d18b4`, 4 runs: 33,643 / 35,547 / 38,486 / 34,716 ms) against 35,220 ms on the branch (4 runs, alternated
  with main: 35,113 / 35,843 / 35,326 / 35,067 ms), every other perf row within budget. Not an OPN-2 regression (the sales report code is unchanged). The
  budget is **not** changed. Re-measure on the production server (Hostinger VPS) at the first deployment; only if it
  still fails there, open an investigation (profile the paged `/reports/sales` query). Owner, 2026-10-25.
- ~~The API access log never logged a request~~ (`req.path` was read after Express rewrote it under `/api`): **fixed in
  SAFE-1**, with a request id in the `X-Request-Id` header and every log line.

---

## H. Suggested sequence

Updated by DEC-1 (owner decisions of 2026-10-18). Done items are no longer listed.

| Step | Items | Why this order |
|---|---|---|
| 1 | **DEC-1** (done) | Record the owner's decisions; discounts off; the gold-rate edit guard (RAT-1) |
| 2 | **SCR-VOID + PUR-FIX** (done, MIS-1) | Mistake correction before real operation |
| 3 | **PAY-1** (SPL-1 + HSD-2) | Two-method payments and Hasad as a channel only, one plan |
| 4 | **MNY-1** | Money transfers branch ↔ branch and branch → General Manager |
| 5 | **CAT-1** | Product becomes optional (Q-3) |
| 6 | **OPN-1** | Opening balance with unknown cost (Q-4), after CAT-1 |
| — | RPT-1, UI-C (still TODO; not placed in the owner's order) | — |
| — | HOST-1, DEP-1, BKP-1, 2FA-1, HW-1, TRN-1, LEG-1; then PIL-1, SEC-1 | Owner tasks in parallel; before relying on the system and before a second branch |

**Still open with the client:** Q-1 (making charge), Q-5 (clean scrap at another karat), Q-11 (hosting, sign-in
hardware, backups), Q-13 (written agreement), Q11 of CSH-2 (funding: loan or capital).
