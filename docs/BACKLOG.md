# Jewelry ERP — Backlog

Version 1.0 · 2026-10-05 · Place this file at `docs/BACKLOG.md`. Read `docs/SPEC.md` first: this file refers to its sections and question IDs (Q-n).

**ملخص بالعربية:** هذه قائمة المتابعة الوحيدة المعتمدة. فيها ما أُنجز، وما يجب حذفه (المصروفات، صفحات حصاد، البيانات التجريبية)، وما يجب إصلاحه (زر التحويل في سلة البيع، رقم عملية التحويل البنكي)، وما يجب بناؤه (كتالوج الأنواع، التسعير المحسوب، الرصيد الافتتاحي)، ثم التصميم، ثم الجاهزية للإنتاج. كل بند له معيار قبول مكتوب.

---

## 0. Working agreement for the new session

1. **One phase at a time.** Propose a plan for the phase first (files, migrations, risks, questions) and wait for approval. Stop after each phase with a report.
2. **Do not reopen [BUILT] items** unless a backlog item says so. Do not guess [OPEN] questions: ask, or implement a setting with the conservative default and flag it.
3. **Every phase ends with:** typecheck, tests on PGlite and real PostgreSQL, build, `npm run i18n:check`, migration applied to a copy of an existing database, docs and `docs/decisions.md` updated, push, and **a short manual acceptance script** the owner can follow in a desktop browser.
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
- Depends on Q-6 only for CSH-2 (what replaces it), not for the removal.
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

### REM-3 — No demo data · TODO · L · P0
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

### REM-5 — Drop the deprecated tables, columns and enum values · TODO · M · P0
**Why:** REM-1 and REM-2 keep the expense and Hasad tables, columns and enum values (with triggers refusing new rows) so history stays valid. No production data exists yet, so dropping them before the first production deployment is the cheapest moment.
**Scope:** one separate, final migration: the `expenses` table, the Hasad withdrawal/redemption/settlement tables, the `hasad_mock` schema together with **`database/src/deprecated-hasad-mock-schema.ts` (delete the file in the same commit, and its line in `database/drizzle.config.ts`)**, `branches.hasad_branch_code`, the deprecated item cost columns (section G), the `EXPENSE` / `HASAD_SETTLEMENT` ledger event types and other retired enum values, the matching CHECKs in `shared/src/db-checks.ts`, the field-classification entries, the leftover `settings` rows of removed keys, the triggers added by REM-1/REM-2, the DEPRECATED entries of `scripts/hasad-footprint-allowlist.json`, and the EXPENSE / HASAD_SETTLEMENT entries of `OTHER_EVENT_TYPES` once no history can contain them.
**When:** after REM-3 and CAT-0 are proven (REH-1 green), before the first production deployment.
**Acceptance:** fresh database and an upgraded copy both migrate; backup/restore drill passes; all gates pass.

### REM-4 — Remove duplicate transfer entry points · TODO · S · P1
After FIX-1: remove the inventory multi-select transfer bar and the Transfers page's "New transfer" dialog. **Sub-question for the owner:** keep a GM emergency override (password plus reason, audited) somewhere out of the way, or drop it?

---

## C. Fix

### FIX-1 — Transfer button in the POS cart · TODO · M · P0
**Misreading to correct:** the owner asked for the button **in the sales cart, below the pay button**. The earlier build put multi-select on the inventory screen and a "New transfer" button on the Transfers page.
**Requirements (SPEC §8):**
- Visible only to branch managers (permission `inventory.transfer`, own branch), never to cashiers.
- Below "Complete sale". It opens a destination-branch list (own branch excluded), the courier's name (required) and an optional note, then creates **one** transfer containing every cart item.
- Items must be available; they become IN_TRANSIT and leave the cart; idempotent; audited; cost unchanged.
- The Transfers page remains a log, with the confirm-receipt action for incoming transfers.
**Acceptance:** a branch manager adds 3 items, transfers them from the cart, and the log shows one transfer with 3 items; a cashier never sees the button (role test); a double click creates one transfer; the receiving manager confirms and the items move with their data.

### FIX-2 — Bank transfer reference number · TODO · M · P0
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

### CAT-1 — Item types and stock entry without a product catalog · TODO · M · P0 · Q-3
**Note after CAT-0:** types and products can now be created (CAT-0), so the empty-database blocker is gone; what remains is the Q-3 question (catalog vs free text) and **rename**. Before allowing a rename, snapshot the Arabic product name and the type names on sale lines (today only the English product name is snapshotted; D-cat0-3).
**Problem:** a production database created by bootstrap holds categories only, and no screen creates a product. **No stock can enter an empty production system** (purchases and the future opening balance both need it).
**Requirements:**
- The GM manages a bilingual **list of item types** (create, rename, deactivate). Production ships empty; the names come from the client in real Sudanese terms. Do not invent them.
- An item is type + free-text description (with suggestions from previously used names) + karat + weights. A product catalog with SKUs becomes optional or is dropped, per Q-3.
- Replace the scrap-purchase "type and name" dropdown with the type list plus a free-text name.
**Acceptance:** on an empty production database created with the bootstrap command, a branch manager can record a supplier order and a scrap purchase with no seeded catalog. This is part of REH-1.

### PRC-1 — Computed pricing · TODO · L · P0 · Q-1, Q-2, Q-5
**Requirements (SPEC §5):**
- New pricing mode `RATE_COMPUTED`: price = GM sell rate (per karat) × net weight, with the making charge, override and rounding per the answers to Q-1/Q-2 (settings until answered).
- Receiving stock no longer asks for a selling price. The inventory list and the POS show the live computed price.
- The price is locked at confirmation; if the GM changes the rate while a cart is open the cart warns and reprices. The sale line stores the rate used, the gold value and the final price; profit = final price − cost, unchanged.
- A **Prices screen** for the GM (gold and scrap rates, history), moved out of Settings; the header shows the current 21K rate.
- Exact integer arithmetic through `shared/src/money.ts`; property tests; a concurrency test of a rate change racing a sale; invoice and sales list show the price per gram; migration keeps existing fixed-tag lines valid.
**Acceptance:** after the GM changes the rate, a new cart shows the new price; a confirmed sale keeps its price; all money tests and cost-visibility tests pass.

### OPN-1 — Opening balance, import and sealing · TODO · L · P0 · CAT-1, Q-4
**Requirements (SPEC §13):** GM-only, one per branch, DRAFT → SEALED.
- Entry by keyboard and barcode scanner; **CSV/Excel import** with a validation report (row numbers, the whole file rejected on errors, idempotent).
- Items get origin OPENING and `cost_is_estimated`; cost per piece, or a default cost-per-gram rule that marks every piece estimated, until Q-4 is answered. **No cash entries** (books start at zero).
- Before sealing show count and total weight by karat; sealing needs password and passkey confirmation; afterwards only audited adjustments.
**Acceptance:** importing a 300-row file creates the items, the stock-weight report matches the sheet's totals, and sealing locks the draft. Part of REH-1.

### LBL-1 — Barcode labels for physical pieces · BLOCKED (Q-9) · M · P1
Print a label (code, karat, weight, Code128 or QR) for each piece, from the opening import and from every receipt. Needs the printer model and label size.

### CSH-2 — Cash-out entry for the operating amount · BLOCKED (Q-6) · S · P1
If the operating amount leaves the drawer: a minimal audited cash-out record (amount, reason, actor) posted to the ledger. Not an expenses module.

### SPL-1 — Split payments · BLOCKED (Q-7) · M · P2
If a prepaid Hasad balance can fall short of the price, one sale must carry several payments (for example Hasad plus cash). Ledger entries per payment, one reference per payment.

### MNY-1 — Inter-branch money transfers · BLOCKED (Q-8) · M · P2
A claim by the sender, confirmation by the receiver, through `FUNDS_IN_TRANSIT`, with the bank reference number. Never built.

### SCR-1 — Customer identification on scrap purchases · BLOCKED (Q-12) · S · P2
Name, phone, optionally an ID number, and a printed receipt for the customer.

### RPT-1 — Report review after the removals · TODO · M · P1
Re-verify every report after REM-1, REM-2 and PRC-1; add reporting by payment channel and the bank-reference list; confirm no report shows cost to non-GM roles.

### TAX-1 — Official tax invoice · BLOCKED (Q-9) · ? · P2
Only if the client is legally required to issue one.

### ROL-1 — Custom roles · DEFERRED · L · P3
Do not build. Keep permission identifiers granular and centralized.

---

## E. User interface redesign

Reference: Figma mockups in `docs/design-reference/` (login, dashboard, branches, sales list, login background), exported SVG assets, and `tokens.md`. Figma's generated CSS is a reference for values only.

Do this **after** REM-1/2/3, FIX-1/2, CAT-1, PRC-1 and OPN-1 so the screens being restyled are the final ones.

### UI-A — Design system, shell, login · TODO · M · P1
CSS-variable tokens in one place; locally bundled fonts; the app shell with a grouped sidebar by permission, distinct icons, collapsible to icons; top bar with the 21K rate chip, language toggle and user menu; login page with the image panel, logo and tagline from settings (new branding setting); restyled shared components. Fix the mockup typos; dark text on gold; AA contrast; RTL as the primary layout. Do not touch the print documents. Keep every e2e script green. Screenshots at 1366×768 and 1920×1080 in Arabic and English.

### UI-B — Dashboard, branches, sales list · TODO · M · P1 · Q-10
As in the mockups. The GM's dashboard shows sales, purchases, stock and values per branch with the branch palette; the branch manager's dashboard excludes cost figures. Branch color field or automatic palette. USD chip only if Q-10 says yes.

### UI-C — All other screens · TODO · L · P1
POS first (speed and clarity for the cashier, owner reviews a screenshot before the build), then scrap and supplier purchases, cash, transfers, inventory, settings, security, users, reports.

---

## F. Production readiness

| ID | Item | Owner | Priority | Depends on |
|---|---|---|---|---|
| **REH-1** | **Empty-database rehearsal script** (`npm run rehearsal`, Playwright). Bootstraps an empty database in **production mode on real PostgreSQL**, behind a local TLS proxy with a self-signed certificate that the script starts itself (passkey RP `localhost`; the production start-up checks are not relaxed), then runs: branch → users → item types → opening import → sale by cash, bank (with reference) and Hasad → print and reprint → void → scrap purchase (clean and broken) → supplier order and settlement → transfer from the cart and receipt → cash count → backup and verify. Build it incrementally and run it before accepting any phase. **PARTIAL:** bootstrap → GM first sign-in (password change, passkey, recovery codes) → branch → branch manager and cashier → their first sign-in → no expense wording on any screen in Arabic or English, expense routes gone, no Hasad withdrawal wording or menu entry, Hasad routes and report gone, the POS offers Cash / Bank transfer / Hasad, reconciliation lines add up → audit trail (63 checks). | Engineering | **P0** | grows with each phase |
| HOST-1 | Decide hosting (Q-11): managed PostgreSQL (paid), region, domain, Shell access for operator commands; separate staging and production. The domain must be final before any passkey is registered. | Owner | **P0** | |
| DEP-1 | Staging deployment in production mode: `STRICT_DB_ROLES=true`, `TRUST_PROXY` verified (real client IPs in the audit log), health monitor on `/api/health`. | Owner + engineering | P1 | HOST-1 |
| BKP-1 | Backup key pair stored in two places; off-site target; daily schedule; weekly drill on a separate machine; **a restore performed by someone other than the developer**; result recorded. | Owner | **P0** | HOST-1 |
| 2FA-1 | Enroll passkeys on the GM's real devices (two), print recovery codes, test the lost-device procedure on staging. | Owner | P1 | HOST-1, Q-11 |
| HW-1 | Hardware tests on the client's real printer (the 15-item checklist in the printing report and `docs/DEPLOYMENT.md` §9), barcode scanner, silent-printing shortcut (the `.cmd` template has never run on Windows). | Owner | P1 | |
| TRN-1 | Staff training for cashier, branch manager and GM; a written runbook for the operator commands (unlock, GM password, security lock). | Owner | P1 | |
| PIL-1 | Two-week parallel run with paper using the checklist. Proposed go/no-go: daily sales total, item count and stock weight match the paper records for 10 consecutive business days. | Owner + client | P1 | all of the above |
| SEC-1 | Independent human security review and `docs/SECURITY.md` (threat model, pass/fail checklist, residual risks) before a second branch. | Owner + reviewer | P2 | |
| LEG-1 | Written agreement with the client (Q-13): hosting cost, support hours, who holds keys and credentials, continuity if the developer is unavailable. | Owner | P1 | |

---

## G. Technical debt and known limits

- The per-IP sign-in limiter lives in process memory: run **one server instance** until it moves to the database.
- Deprecated cost columns on `jewelry_items` (`purchase_cost`, `making_cost`, `other_cost`, `total_cost`) and the deprecated tables from REM-1/REM-2: drop in a later migration once nothing reads them.
- `README.md` still describes a "Client Demo Prototype"; `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md` and `docs/DEMO_SCRIPT.md` date from the prototype stage. Update or delete after REM-3.
- The silent-printing `.cmd` template is untested on Windows; CSS page size on a given thermal driver is a request, not a guarantee.
- ~~Hasad double-notification risk (D-2a-8)~~: **resolved by scope change** (REM-2 removed the Hasad integration).
- Single-role database deployments still work but log a security warning.

---

## H. Suggested sequence

| Step | Items | Why this order |
|---|---|---|
| 0 | Commit `SPEC.md` and `BACKLOG.md`; start REH-1 with the bootstrap → branch → users part | The rehearsal grows with the system |
| 1 | REM-1, REM-2, CAT-0, REM-3 (FIX-3 already done) | Shrink the surface before adding to it; CAT-0 before the seed goes, so stock can always be entered |
| 1b | REM-5 | Drop the deprecated schema once REM-3 and CAT-0 are proven, before the first production deployment |
| 2 | FIX-1, FIX-2, REM-4 | Small, visible corrections the owner already asked for |
| 3 | CAT-1 | An empty production system cannot receive stock without it |
| 4 | PRC-1 | Needs Q-1, Q-2, Q-5 answered |
| 5 | OPN-1 (+ LBL-1) | Needs CAT-1 and Q-4 |
| 6 | CSH-2, SPL-1, MNY-1, SCR-1, RPT-1 | According to the answers |
| 7 | UI-A, UI-B, UI-C | Restyle the final screens |
| 8 | HOST-1, DEP-1, BKP-1, 2FA-1, HW-1, TRN-1, LEG-1 | Owner tasks that run in parallel with steps 1–7 |
| 9 | PIL-1, then SEC-1 | Before relying on the system and before a second branch |

**Questions to put to the client first** (they unblock steps 4–6): Q-1, Q-2, Q-3, Q-4, Q-5, Q-6, Q-7, Q-8, Q-9.
