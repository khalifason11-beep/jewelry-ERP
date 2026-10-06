# Jewelry ERP — Product Specification

Version 1.0 · 2026-10-05 · Place this file at `docs/SPEC.md`.

**Audience:** the engineer (Claude Code) starting a fresh session on this repository, and the product owner.
**Rule:** read this file and `docs/BACKLOG.md` completely before proposing any work. Do not write code until you have produced a plan for the first backlog phase and the owner has approved it.

---

## 0. Reading guide

| Tag | Meaning |
|---|---|
| **[CLIENT]** | Stated by the client. So far by phone call only; to be confirmed in the in-person meeting. |
| **[OWNER]** | Decided by the product owner. |
| **[INVARIANT]** | Engineering rule that holds whatever anyone asks. Do not trade it away for convenience. |
| **[BUILT]** | Already implemented. Details and reasons are in `docs/decisions.md`. |
| **[OPEN]** | Unanswered. Do not guess: ask, or implement as a setting with the conservative default and flag it in the report. |
| **[REMOVED]** | Explicitly out of scope. |

**ملخص بالعربية:** نظام ERP لمحلات الذهب متعدد الفروع، ويعمل كتطبيق ويب عربي أولًا. العميل يبيع عيار 21 فقط ويشتري الكسر بأي عيار. السعر يُحسب وقت البيع من سعر جرام يحدده المدير العام. المصروفات وصفحات حصاد حُذفت من النطاق، وتبقى كلمة "حصاد" كقناة بيع فقط. التحويل بين الفروع يبدأ من سلة البيع عند مدير الفرع. التحويل البنكي يتطلب رقم عملية. لا بيانات تجريبية في النظام. كل ما هو [OPEN] يحتاج جوابًا قبل البناء.

---

## 1. Product and context

- **[OWNER]** A multi-branch retail ERP for gold jewelry shops: item-level inventory, point of sale, purchases from suppliers and from customers, inter-branch transfers, a money ledger per branch, reporting, audit. Web application (React + Express + PostgreSQL), **Arabic-first, right-to-left**, with an English toggle. Amounts are whole Sudanese pounds (SDG), weights are integer milligrams, digits are Western (0–9).
- **[OWNER]** The owner holds the right to resell the system to other jewelry businesses. Nothing client-specific may be hardcoded: company name, logo, footer, tagline, allowed karats, rates, payment methods and similar live in settings.
- **[CLIENT]** First client: a gold retailer with several branches (Khartoum, Omdurman, Bahri, Port Sudan are the names used so far; the real list is to be confirmed). The **pilot is one branch**; others are added gradually after the results are verified.
- **[CLIENT]** Staff use **Windows PCs with desktop browsers**. Branch internet is stable. **No offline mode** is required; do not add one.
- **[CLIENT]** The client keeps paper records in parallel for the first two weeks.
- **[OWNER]** Hosting is not decided yet (see §17 and `docs/DEPLOYMENT.md`).

## 2. Roles and access

Source of truth for permissions: `shared/src/permissions.ts` and `shared/src/route-matrix.ts`. Deny by default. Authorization is enforced on the server; hiding a button is never protection.

| Role | Scope | Can | Cannot |
|---|---|---|---|
| **General Manager (GM)** | All branches | Create users and set their passwords; set gold and scrap rates; settings and branding; see cost and profit; approve scrap price overrides; view audit and sessions | Destructive operations on business data in production |
| **Branch Manager** | Own branch | Scrap and supplier purchases; settle suppliers with broken-scrap weight; start item transfers **from the POS cart** and confirm incoming ones; cash count; void a sale with a reason; reprint invoices | See cost or profit; edit rates |
| **Cashier** | Own branch | Sell at the POS; print the original invoice once, right after the sale | Purchases, transfers, cash screen, rates, reports, any cost |

- **[CLIENT]** The GM creates users and sets each user's password when assigning the role. A user cannot choose their own password at creation; **[BUILT]** the user must change it at first sign-in and may change it later.
- **[CLIENT]** No extra roles unless the client asks. The system must still let the GM add users and assign them one of the existing roles.
- **[OWNER]** Custom, GM-defined roles are **deferred** (YAGNI). Keep permission identifiers granular and centrally listed so a data-driven role layer can reuse them later.
- **[OWNER]** The GM tells staff that their activity is monitored. **[BUILT]** Active sessions, last activity and the audit log are visible to the GM.

## 3. Authentication and security [INVARIANT unless noted]

- **[BUILT]** Argon2id passwords, atomic lockout (reserve the failure before verifying), identical failure responses for unknown user, locked account and wrong password, session idle timeout **60 minutes for every role** (a GM setting), absolute timeout 12 hours, session rotation, password re-confirmation for sensitive actions (window is a GM setting, default 5 minutes), CSRF protection, strict CSP.
- **[BUILT]** The GM's second factor is a **passkey** (WebAuthn): Windows Hello or a USB security key, two devices registered, recovery codes, security lock after a reported recovery-code sign-in, operator command-line recovery. Setting `webauthnUserVerification` is `required` (default) or `preferred`.
- **[OPEN]** Which hardware the GM will use (Windows Hello with fingerprint, face or PIN, or a USB key). It decides the verification setting. The final production domain must be fixed **before** any passkey is registered.
- **[INVARIANT]** Production refuses to start without HTTPS origin, a real PostgreSQL server and safe settings; no demo data, demo reset or demo accounts exist in production.
- **[INVARIANT]** Cost, acquisition cost, making charge paid and profit are visible to the GM only. Enforced in API responses by the field-classification registry; the build fails on any unclassified field.
- **[INVARIANT]** The audit log, ledgers and histories are append-only (database triggers and revoked privileges). Corrections are new rows.

## 4. Inventory model

- **[OWNER]** Item-level inventory: each physical piece is one record with code/barcode, type, description, karat, gross and net weight, status, branch, acquisition cost (GM-only), origin.
- **[CLIENT]** **The sellable stock has two kinds of pieces, shown in one list:**
  1. **New (جديد)** — from a supplier.
  2. **Clean scrap (كسر نضيف)** — a sound used piece bought from a customer and resold as it is.
  The list must be **filterable by weight, karat and kind**.
- **[CLIENT]** **Broken scrap (كسر مكسور)** — an irreparable piece (a broken ring, a cut chain) — is **never an inventory item**. It exists only as a **weight pool per branch**, by karat. It **counts in the branch's total stock weight** (raw weight by karat and the 24-karat equivalent), is visible, and is used to pay suppliers (§7).
- **[BUILT]** The broken-scrap pool is an append-only weight ledger; balance = sum of entries.
- **[CLIENT]** The client sells **21 karat only**. This is the setting `allowedKarats = [21]` for this deployment (never hardcode 21). It restricts what can be created and sold as a sellable piece. **Buying is not restricted**: customers' scrap may be any karat from 1 to 24.
- **[OPEN]** A clean-scrap piece bought at another karat (for example 18): today it cannot be sold, repriced or delivered. Does the client melt it, sell it anyway at its real karat, or reject such purchases?
- **[OPEN] Item types and names.** The type and name lists must use **real Sudanese jewelry terminology supplied by the client**. The demo data used Modern Standard Arabic categories (خواتم، أساور، قلائد…) and invented names, which the owner rejected. **Do not invent names.** Production ships with an empty catalog. Items need a type and a free-text description with suggestions from previously entered names.
- **[OPEN]** Whether a separate product catalog (with SKUs) is needed at all, or whether an item is simply type + description + karat + weights. **A new production database must be able to receive stock without a catalog being seeded.** (Today there is no screen to create a product; this blocks every stock entry in production.)

## 5. Pricing

- **[CLIENT]** The **selling price is computed at the time of sale**: the GM sets the gold sell rate (SDG per gram, per karat), and the price of a piece is derived from it. **[OWNER]** The GM sets the rate manually; there is no automatic feed.
- **[CLIENT]** Scrap buying: the GM sets a **scrap buying rate per karat** (any karat 1–24) manually. **[BUILT]** A branch manager may deviate within `scrapPriceTolerancePct`; beyond it, the GM must approve.
- **[BUILT]** Gold and scrap rates are effective-dated with immutable history; changes need password re-confirmation and are audited.
- **[BUILT]** Each sale line stores an acquisition-cost snapshot and profit = final price − cost, enforced by a database CHECK. Price-component columns (`pricing_mode`, gold value, making charge, rate per gram) exist; only `FIXED_TAG` is implemented.
- **[OPEN] Formula details** (ask the client; implement as settings until answered):
  - Is a **making charge (المصنعية)** added to the customer price? If so, fixed per piece, per gram, or a percentage?
  - One sell rate for new and clean-scrap pieces, or separate?
  - A **fixed-price override** for pieces with stones.
  - Rounding of the computed price (whole SDG today; nearest 100 or 1,000?).
  - Cashier discount and who may change a price (today: discount up to 3 %, a setting).
- **[OWNER] Proposed behavior:** the price is locked when the sale is confirmed. If the GM changes the rate while a cart is open, the cart warns and reprices. The sale line stores the rate used.
- **[OPEN]** Cost estimation: the cost of existing pieces at handover is estimated from market price "and other factors the client will define". Those factors are not defined yet. **[BUILT]** `cost_is_estimated` exists.

## 6. Sales and the point of sale

- **[BUILT]** POS cart, completion with idempotency (a double click creates one sale), original invoice printed once by the cashier, void with a reason by a branch manager (ledger reversal through the original method).
- **[CLIENT]** **Payment methods in the POS: Cash, Bank transfer, Hasad.** Card and mobile wallet stay in the data model but are hidden and refused unless the GM enables them.
- **[OWNER] Bank transfer requires the transaction (reference) number.** The field is mandatory, stored on the sale, shown in the sales list and available for review and export. Warn on a reference already used on another sale. *(Not implemented: see FIX-2.)*
- **[BUILT]** Hasad payments require the app's invoice number; the transaction reference is optional. This is manual entry only; **there is no connection to any external system.**
- **[OWNER]** One payment method per sale today. **[OPEN]** If a prepaid Hasad balance does not cover the exact price, the difference must be paid by cash or bank: that needs **split payments**. Ask the client whether differences occur.
- **[OWNER]** The sales list shows: order number, kind (new/scrap), weight, value, price per gram, customer, payment method with reference, date and time; quick date filters (today, yesterday, 7 days, 30 days, this month, all). Price per gram is displayed derived from the sale; it becomes the real computed rate once §5 is built.
- **[OWNER] Transfer button in the cart:** the branch manager's POS cart shows a **"Transfer to branch" button below the "Complete sale" button**. See §8.

## 7. Purchases

### 7.1 From suppliers (gold for gold) [CLIENT, BUILT]
- A purchase order records the supplier, the invoice reference and the delivered items (origin New).
- The **making charge (المصنعية) is paid immediately** in cash or bank and posts to the ledger. This is the **only money** that ever goes to a supplier.
- The rest is a **gold debt measured in pure-24K weight**: sum over items of `round(net_weight_mg × karat / 24)`, per purchase order.
- The shop never initiates collection. When the **supplier's representative visits**, the branch manager settles that order **only with broken-scrap weight from the branch pool** (any karat, converted to 24K). Partial settlements are allowed until the debt is exactly zero; over-settlement is refused. Never cash, never bank.
- Gold debt and settlement weights are visible to the branch manager. Money costs are GM-only.
- **[OPEN]** The acquisition cost of supplier items for profit reporting ("market price and other factors"): the formula is undefined.

### 7.2 From customers (scrap) [CLIENT, BUILT]
- Counter purchase at the GM's scrap rate for the karat, paid from the drawer or the bank. Sellable scrap becomes an item (§4); broken scrap goes to the pool.
- **[OPEN]** Customer identification on a scrap purchase (name, phone, ID) and the printed receipt for the customer.

## 8. Transfers between branches

- **[OWNER] Items:** a branch manager moves items from the **POS cart** with the **"Transfer to branch" button under the pay button**. It is visible to branch managers only, never to cashiers. The manager picks the destination branch from a list and the courier's name; one transfer carries all items in the cart.
- **[BUILT]** Lifecycle: items become **IN_TRANSIT** (not sellable anywhere) until the **receiving branch manager confirms**; then they join the receiving branch's stock with every attribute, **cost unchanged**. Support for partial receipt with disputed items visible to the GM, and cancellation by the sender before receipt.
- **[OWNER]** The Transfers page is a **log** (outgoing and incoming, with status) and the place where the receiving manager confirms. **It has no "new transfer" button.**
- **[OPEN] Money transfers between branches** (bank-based: the sender records a claim, the receiver confirms): mentioned early on, **never built** (only the `FUNDS_IN_TRANSIT` account type exists). Is it still required?

## 9. Cash, the ledger and reconciliation

- **[BUILT]** One append-only ledger per branch with CASH, BANK, FUNDS_IN_TRANSIT and HASAD_RECEIVABLE accounts. Balance = sum of entries. Every money event is written in the same transaction as the business change.
- **[BUILT]** Expected cash in the drawer, a daily reconciliation per branch, and a **manual cash count**. A count difference is **only a note for the GM**; it is not posted to the ledger. **[CLIENT]**
- **[CLIENT]** Books start at **zero cash** on handover day; only items are entered.
- **[REMOVED] Expenses.** The client gives employees a fixed operating amount, so there is no expenses screen, approval flow or expense reports. Removed by BACKLOG REM-1; the old table stays (no new rows) until REM-5.
- **[OPEN]** Where the operating amount comes from. If it leaves the shop drawer, the daily count will show a shortage unless it is recorded. Recommended: a minimal **cash-out entry** (amount, reason, actor, audited), not an expenses module.

## 10. Hasad

- **[OWNER]** The word **Hasad appears only as a payment method / sales channel** in the POS and in reports grouped by channel.
- **[REMOVED, done by REM-2]** The withdrawal workspace and list, the counter sessions, the entitlement and weight-difference settlement, the simulator, the mock integration package, all `hasad.*` settings and permissions, the Hasad navigation entries and notifications, and `docs/HASAD_INTEGRATION.md`. A customer picking up jewelry against a prepaid balance is **an ordinary sale paid through Hasad**.
- **[BUILT, OPEN]** Sales paid through Hasad post to a separate `HASAD_RECEIVABLE` account because the money is held elsewhere until Hasad pays the shop by **bank transfer**; the branch manager records that arrival (receivable → bank, one transaction). **[OPEN]** Does the client want to track this receivable, or only tag the channel?

## 11. Reports and dashboards

- **[BUILT]** Branch dashboard, company overview (GM), sales, inventory, stock weight (including the broken-scrap pool), cash and daily reconciliation, audit.
- **[OWNER]** Add reporting **by payment channel** (cash / bank / Hasad). Re-verify every report after expenses are removed and pricing changes.
- **[INVARIANT]** Cost, inventory value at cost and profit appear for the GM only; the branch manager's dashboard is designed without them.
- **[OPEN]** The header shows the current **21K sell rate**; a **USD per gram chip** (in the design) needs an exchange-rate setting entered by the GM. Does the client want it?

## 12. Printing [BUILT]

- Documents render in the browser and print through the **Windows printer driver** (no raw ESC/POS, which failed in the owner's previous project). Formats: A4, A5, thermal receipt (default 72 mm printable width, to be verified on the real printer). Page size for receipts is `size: <width> <measured height>`; `size: 72mm auto` is invalid CSS.
- Content: company, branch, invoice number, date, cashier, customer, lines (code, description, karat, net weight, price), totals, payment method (and reference), Code128 barcode, **footer = a friendly thank-you only** (a setting; no business claims). **No cost, profit or gold-debt figure on any printout, for any role.**
- Reprints show "نسخة / COPY n", are audited and counted; the cashier may print only the original, once, in the same session.
- Silent printing uses the browser's `--kiosk-printing` flag with a dedicated profile (see `docs/DEPLOYMENT.md` §9).
- **[OPEN]** Invoice format (A4, A5 or receipt), printer model and connection, paper size in the driver, **whether item tags/labels are needed** (a different printer), and whether an official **tax invoice** is legally required.

## 13. Handover day and the opening balance [not built]

**[OWNER]** Procedure, at the end of a business day:
1. Create the branch (and users) from the GM's screens.
2. The GM enters **the list of the branch's jewelry with exact weights and karats** (items only; no opening cash) so the system computes the branch stock. Each item has an estimated cost (`cost_is_estimated`).
3. The GM creates the staff users, assigns roles, sets passwords, and tells them their activity is monitored.
4. The cashier starts working normally.

Requirements: GM-only, once per branch, then **sealed** (changes only through audited adjustments); fast entry (keyboard and barcode scanner); **import from a spreadsheet** (CSV/Excel) for hundreds of pieces; **barcode labels** to stick on the physical pieces (printer unknown); nothing invented in the books. **[OPEN]** the cost formula (§5).

## 14. Branding and settings

- Company name (Arabic/English), logo, invoice footer, login tagline, currency label come from settings (GM-editable, audited). Logo upload: PNG/JPEG/WebP only, checked by content, 512 KB, 1024×1024 px.
- Typed settings registry with history; a setting never silently changes a business rule.

## 15. User interface

- **[OWNER]** The visual design exists as **Figma mockups** (login, dashboard, branches, sales list): navy sidebar, white/cream cards with large radii, gold accent, pill chips in the top bar, bar charts in a four-color branch palette. Reference images and exported tokens go in `docs/design-reference/`. Figma's generated CSS is a **reference for exact values only**; never paste it into the project.
- **[INVARIANT]** Arabic RTL is the primary layout; the English LTR layout must be equally correct. Colors, type scale, radii and shadows are CSS variables in one place so another client's brand can be applied by changing tokens. Fonts are bundled locally (the CSP forbids external fonts).
- **Corrections to the mockups:** "Mange" → "Manage", "Cache" → "Cash", "Costumer" → "Customer". The diamond icon repeated for every menu item is a placeholder: use distinct icons. Text on pale gold must be dark navy (white on that gold is about 2:1 contrast). Body text ≥ 14 px, secondary ≥ 12 px, WCAG AA.
- **Not designed, so extrapolated and reviewed by the owner:** POS (most important: cashier speed and clarity), scrap and supplier purchases, cash and reconciliation, transfers, settings, security, users, reports.
- **Sidebar**, by role and permission: Home, Branches, Prices (the GM's gold and scrap rates), Sales, Inventory, Purchases, Scrap, Transfers, Cash, Reports; Administration: Users, Active users, Security, Audit log, Settings. POS for cashiers and branch managers. **No Expenses, no Hasad entries.**
- Branch colors: a color per branch used in dots and charts (a branch field or an automatic palette by order).

## 16. Data policy

- **[OWNER]** The system contains **no demo or sample business data**. A fresh database holds reference data only (roles, permissions, and what the first-run bootstrap creates). Automated tests use their own fixtures, separate from anything shipped. An optional, clearly labelled sample set may exist only for development, using names approved by the client.
- **[INVARIANT]** Production starts from an empty database; no ledger entry is ever invented; migrations are additive and tested on a copy of an existing database.

## 17. Operations and production readiness

- **[BUILT]** Encrypted off-site backups (age public-key encryption, read-only backup role, retention, off-site hook), a restore drill with integrity checks run on a separate machine that holds the secret key, health warnings in the GM dashboard, owner and runtime database roles (`STRICT_DB_ROLES`), operator console for lockouts and password recovery (needs **shell access** to the server).
- **[OPEN]** Hosting provider, managed PostgreSQL (paid), domain, region, whether Shell access is available, backup schedule and off-site target. The recovery target with daily backups is up to 24 hours of data loss; decide with the client whether hourly backups or point-in-time recovery is needed after the parallel run.
- **[OWNER]** Before real data: backups configured and **a restore performed by someone other than the developer**; a rehearsal on an empty production-mode database (BACKLOG REH-1); hardware tests on the client's real printer, scanner and sign-in device; staff training and a written runbook; a two-week parallel run with paper using the checklist; an independent security review before the second branch.

## 18. Engineering rules [INVARIANT]

1. Money is whole SDG in integers, weights integer milligrams; **exact integer arithmetic** (BigInt intermediates), rounding half away from zero, one rounding entry point (`shared/src/money.ts`). No floating point for money or weight.
2. Every state-changing POST carries an **idempotency key**; money routes claim the key and store the result inside the business transaction.
3. Every money event is written to the ledger in the same transaction. Concurrency uses row locks; races are proven by tests on **real PostgreSQL**.
4. Statuses and amounts are constrained in the database (CHECK constraints); the list lives in `shared/src/db-checks.ts`.
5. Every new column and API field is classified COST or SAFE in `shared/src/field-classification.ts`; secrets never appear in responses, logs or audit.
6. New routes are added to the permission matrix; tests are generated from it (allow, deny, cross-branch).
7. Tests run on both PGlite and real PostgreSQL. Phase gate: typecheck, tests, build, `npm run i18n:check`, migration applied to a copy of an existing database, docs and `docs/decisions.md` updated, push.
8. **Acceptance of any phase that changes a user flow includes the empty-database rehearsal** (BACKLOG REH-1), not only automated tests.
9. Decisions made under ambiguity are recorded in `docs/decisions.md` with the option chosen and how to change it.
10. **The daily cash reconciliation adds up.** Its lines sum exactly to each account's movement of the day in the ledger (for CASH: opening cash + lines = expected cash). A ledger event type without a dedicated line appears in an "Other" line; nothing may silently disappear. Tested.

## 19. Glossary

| Arabic | English |
|---|---|
| جديد | New (from a supplier) |
| كسر نضيف | Clean scrap: a sound used piece, resold as it is |
| كسر مكسور | Broken scrap: unsellable, tracked only as weight |
| المصنعية | Making charge |
| عيار | Karat |
| الوزن القائم / الوزن الصافي | Gross weight / net weight |
| مندوب المورّد | Supplier's representative |
| المدير العام / مدير الفرع / الكاشير | General Manager / Branch Manager / Cashier |
| حصاد | Hasad: a sales channel (payment method) |

## 20. Open questions (consolidated)

| ID | Question | Blocks |
|---|---|---|
| Q-1 | Making charge in the customer price: yes/no, fixed, per gram or percentage? | PRC-1 |
| Q-2 | One sell rate for new and clean scrap, or two? Fixed-price override for pieces with stones? Rounding? Who may change a price or discount? | PRC-1 |
| Q-3 | Item type and name lists in real Sudanese terms; is a product catalog needed? | CAT-1 |
| Q-4 | Cost estimation formula for existing and supplier items | OPN-1, reports |
| Q-5 | Clean scrap at a karat other than 21: melt, sell as it is, or refuse? | PRC-1, stock |
| Q-6 | How the fixed operating amount for staff is recorded (cash-out entry or outside the system) | CSH-2 |
| Q-7 | Hasad: keep tracking the receivable? Do prepaid pickups ever have a difference to pay (split payment)? | REM-2, SPL-1 |
| Q-8 | Is the branch-to-branch **money** transfer still required? | MNY-1 |
| Q-9 | Invoice format; printer model; labels printer; tax invoice requirement; footer contents | PRN, LBL-1 |
| Q-10 | USD chip in the header? | UI-A |
| Q-11 | The GM's sign-in hardware; hosting provider and domain; backup frequency | HOST-1 |
| Q-12 | Customer identification on scrap purchases | SCR |
| Q-13 | Written agreement with the client: hosting cost, support hours, who holds keys and credentials, what happens if the developer is unavailable | go-live |
