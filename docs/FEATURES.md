# Features

What the system does today, by capability. Each statement was checked against the code at the time of writing
(DOC-1). Business rules still waiting on a client answer are marked **open** and refer to the question (Q-n) in
`docs/SPEC.md` and `docs/BACKLOG.md`.

Permission codes are given in `code` form; the full catalogue and the grants of each role are in
`shared/src/permissions.ts`. `scripts/check-docs.mjs` fails if a permission code is missing from this file.

## 1. First start and setup

- Every database starts empty, in demo mode as in production. The first General Manager is created by the bootstrap
  command, or by `npm run demo`, which asks for the username. Either way the General Manager gets a one-time password,
  which must be changed at the first sign-in.
- The General Manager's home shows **five first steps** until they are done (`GET /api/setup/status`):
  1. Confirm the allowed karats (`POST /setup/allowed-karats`, with re-confirmation). The default list is 18, 21, 22
     and 24; `ALLOWED_KARATS_INITIAL` sets it on the first start.
  2. Set today's gold rate and the scrap rates.
  3. Create the first branch.
  4. Add a branch manager and a cashier.
  5. Fund the branch: record an advance into its drawer.
- The panel ends with: then the General Manager records the first supplier order, and selling can start.

## 2. Shell, homes and attention

- **The shell:**
  - The sidebar depends on the role (the cashier sees icons only).
  - The top bar shows today's selling rate of the allowed karats (one karat, or at most two plus "+n") and the
    attention count.
  - A **notice area** sits under the top bar for what must interrupt:
    - security-locked accounts;
    - the "Was this you?" new-sign-in alert;
    - the second factor switched off for the General Manager.

    Notices cannot be dismissed while their cause remains.
- **Screen states:** each list has a loading, empty, error and not-allowed state. An error boundary catches crashes,
  and client errors are reported to `POST /client-errors`.
- **The General Manager's home** (`/overview`, `dashboard.company`):
  - sales for the period, on a dark card;
  - gross profit, gold held, and stock value at cost;
  - "Needs attention" and the branch strips;
  - the 14-day sales line and the gold position: pieces, broken scrap, in transit, gold owed to suppliers as 24K.

  The period is remembered per person. `?branchId=` shows one branch's view.
- **The branch manager's home** (`/dashboard`, `dashboard.branch`):
  - sales of the day;
  - the expected cash in the drawer and the last count;
  - available stock, and gold owed to suppliers (weight only);
  - "Needs attention" and "Team today";
  - the 14-day sales line, and the day's stock movement.

  There is no cost or profit anywhere on it.
- **The attention list** (`GET /api/attention`) is computed live and depends on the role and the branch. It carries
  no cost, profit or supplier money.

  | Code | Signal | Who |
  |---|---|---|
  | A1 | Transfers in transit to a branch | `inventory.transfer` |
  | A2 | A transfer older than `transfers.pendingClaimStaleHours` (24 h) | `inventory.transfer` |
  | A4 | Last cash count differs from expected beyond the tolerance | `cash.view` |
  | A5 | Yesterday had cash movements but no count | `cash.view` |
  | A6 | Gold still owed to a supplier (24K weight, oldest order, days) | `purchases.view` |
  | A9 | Backup or restore drill too old (critical) | `backups.view`, company view |
  | A10 | New-device sign-ins in the last 7 days | `users.manage`, company view |
  | A11 | Failed sign-ins in 24 h | `audit.view` |
  | A12 | Temporarily locked accounts | `users.view` |
  | A15 | Stock movements do not reconcile with the available pieces | `inventory.view` |
  | A16 | Gold or scrap rate missing (critical) | `settings.manage`, company view |
  | A17 | Branch bank balance below zero (critical) | `cash.view` (branch manager: own branch) |
  | S1 | Only one passkey registered | the signed-in user |
  | S2 | Passkeys set to "touch is enough" | `settings.manage` |

## 3. Point of sale (`pos.access`, `sales.create`)

- The cashier sees only the available pieces of their own branch. There are no cost figures.
- **Discounts** (`sales.discount`) are limited per role by `sales.maxDiscountPercentByRole`: cashier 3 %, branch
  manager 10 %, General Manager 20 %.
- **Price changes:** any line sold at a price other than its tag needs one reason per sale. The reason is stored on
  the sale and audited.
- **Payment methods** (`sales.posPaymentMethods`): cash, bank transfer and Hasad.
  - A bank transfer needs its transfer reference. A reference already used on another sale returns `409
    DUPLICATE_BANK_REFERENCE`, which can be overridden with "Record anyway".
  - Hasad needs the Hasad invoice number and transaction reference.
- **Pricing** is the piece's tag price (`FIXED_TAG`). Computed pricing (`PRICING_MODES.COMPUTED`) is **open** (PRC-1,
  Q-1/Q-2/Q-5).
- **Invoices:**
  - Invoices are built on the server from a list of fields that excludes cost (`POST /sales/:id/print`).
  - Paper sizes are A4, A5, or a thermal receipt.
  - The cashier prints once. Managers can reprint (`sales.reprint`); a reprint is marked "COPY n" and counted.
- **Pieces can also be transferred from the cart**, not only sold (FIX-1).
- **Lists:**
  - The cashier sees their own sales (`sales.view_own`, "My activity").
  - Managers see the sales list (`sales.view`).
- **Void** (`sales.void`):
  - A void needs a reason, and needs re-confirmation above `sales.voidReauthAboveAmount`. The default is 0, so every
    void needs it.
  - The refund goes back through the original payment method. A cash refund larger than the drawer is refused
    (`DRAWER_SHORT`).

## 4. Inventory

- **Pieces** (`inventory.view`; the cashier has `inventory.view_available`) each carry:
  - a code and a barcode;
  - the type and product;
  - the karat, and the gross and net weight in mg;
  - the origin (`OPENING`, `SUPPLIER_NEW` or `SCRAP`);
  - the rate that prices it (OPN-2): new (a supplier piece, a new opening piece) or used (sellable scrap, a used
    opening piece). The list shows a "Used" badge on a used opening piece and filters new or used; the piece page
    says "Priced at the new-piece / the used-piece rate";
  - the selling price and the status.

  The acquisition cost, and whether it is an estimate, are shown to the General Manager only.
- **Statuses** are `AVAILABLE`, `SOLD`, `TRANSFERRED`, `DAMAGED` and `RETURNED`. History also records `PURCHASED` and
  `RECEIVED`. Every change goes through one guarded function, so the same piece can never be sold twice. Each change
  writes `item_status_history` and `inventory_movements`.
- **Price edit** (`inventory.price_edit`) needs a reason and is audited.
- **Adjustments** (`inventory.adjust`, with re-confirmation) are: mark damaged, restock, and return to supplier.
- **Types, products and suppliers** (`catalog.create`) can be created inline from the purchase and scrap forms.
  Deactivating and reactivating them needs `catalog.manage`. Arabic names are required, and normalised names are
  unique. Item types without a product catalogue are **open** (CAT-1, Q-3).
- **Transfers** (`inventory.transfer`):
  - The branch manager ticks pieces and sends one transfer, with the courier's name.
  - The pieces are in transit until the receiving branch confirms receipt.
  - There is no cancel action.
- **A piece is a type + a description + a karat + weights** (CAT-1): the product is optional on a supplier order line,
  a sellable scrap purchase and the opening balance; the description (≤ 120 characters, searchable) has suggestions
  from the descriptions already used for the type. The General Manager renames a type; past sale lines keep the names
  they were sold under.
- **Opening stock** (OPN-1): see §7, "Opening balance". Pieces of unknown cost (opening pieces) are left out of every
  cost and profit total, which says how many it left out; their price and weight count as usual.

## 5. Supplier orders (General Manager only, `purchases.create`)

- An order is recorded after the pieces arrive. Each line creates one piece, with its purchase, making and other cost
  and its selling price.
- **Gold for gold:** the supplier is owed the order's weight as pure 24K (`gold_debt_mg_pure24`, and
  `gold_owed_mg_pure24` after settlements).
- **Making charge (MKC-1):**
  - It is paid by the owner from the owner's personal account (`making_charge_paid_from = OWNER_PERSONAL`).
  - When the charge is above 0, the transfer reference and date are required. Only the General Manager sees them.
  - No ledger entry is written and no branch money moves.
  - A reference already used on another order raises a warning, with "Record anyway".
- **Open debt warning (SUP-1):**
  - Recording an order for a supplier who is still owed gold returns `409 SUPPLIER_GOLD_OWED`. The warning shows the
    weight, the number of open orders, the oldest order and its age, and is company-wide.
  - "Record anyway" (`confirmOpenSupplierDebt`) records the order and audits the confirmation.
  - `GET /suppliers/:id/gold-owed` serves the same facts as attention A6.
- **Viewing and settling:**
  - Orders are listed and viewed with `purchases.view`. Branch managers see the weights and the gold owed, never the
    money.
  - **Settlement** (`purchases.settle`) is done with broken scrap from the branch pool only, by karat and weight,
    never with cash. Partial visits are allowed, and each one shows the balance after it.

## 6. Scrap bought from customers (`scrap.buy`)

- Scrap is bought at today's scrap rate per karat (`scrap_rates`, set by the General Manager), in any karat from 1 to
  24.
- **The agreed price** may deviate within `purchases.scrapPriceTolerancePct` (2 %). Beyond that it needs
  `scrap.override`, which only the General Manager has, when `requireGmApprovalForScrapOverride` is on.
- **Sellable** scrap becomes a piece (origin `SCRAP`). **Broken** scrap adds weight to the branch's scrap pool
  (`scrap_weight_entries`).
- PRC-1: the cashier holds `scrap.buy_sellable`: a **sellable** piece only (no broken scrap), with every limit of the
  purchase (tolerance and its override, drawer BLOCK, bank WARN). Its price is computed from the used-piece rate.
- **Payment** (CSH-2):
  - Payment is cash, bank transfer, or split (`cash_amount` + `bank_amount`).
  - The bank part needs a bank reference.
  - The cash part is refused when the drawer is short (`DRAWER_SHORT`); the bank part never is.
- Customer identification on scrap purchases is **open** (SCR-1, Q-12). Voiding a scrap purchase is not built
  (SCR-VOID).

## 7. Cash and money (`cash.view`, `cash.count`, `cash.settle_hasad`)

- **Cash page:**
  - It shows the expected cash in each drawer now.
  - The daily reconciliation lists, line by line: the opening cash, sales by payment method, drawer and bank
    movements, the expected cash, the counted cash, and the difference.
  - Every line adds up to the ledger.
- **Cash count** (`cash.count`): the counted cash is recorded against the expected cash; a difference beyond
  `cash.countDifferenceTolerance` (0) raises attention A4.
- **Hasad settlement** (`cash.settle_hasad`): when Hasad's bank transfer arrives, the amount moves from
  `HASAD_RECEIVABLE` to `BANK`.
- **General Manager's funding** (`funding.view`, `funding.manage`; re-confirmation, idempotent):
  - **Advances** go into a branch's drawer or bank, with a reason. A bank advance needs a bank reference.
  - **Repayments** take money back the same way.
  - A **correction** (a reversal) undoes one event, once.
  - `OWED_TO_GM` shows what each branch owes the General Manager.
- **Opening balance** (OPN-1, `opening.manage`, General Manager only): one per branch, DRAFT → SEALED.
  - The draft is not stock. Pieces are typed in (Enter moves to the next field) or imported from a CSV file (template
    in Arabic and English; comma or semicolon; one wrong row rejects the file with every problem by row and column; the
    same file twice changes nothing; at most 5,000 rows and 1 MB a file).
  - Every line says whether the piece is **new or used** (OPN-2): a required choice when typing (nothing preselected,
    chosen again for every piece) and a required CSV column (جديد / مستعمل / new / used).
  - The review shows count and weight by karat and condition and by type and the lines (paged, searchable); the draft
    exports as CSV.
  - Sealing needs computed prices, the password and a passkey. Each line becomes a piece with the next code in the
    sheet's order, origin OPENING, cost unknown (never 0), price from the new-piece or the used-piece rate by its
    condition (sealing is refused while a needed rate is missing); no cash moves. Then nothing
    can change (correcting a sealed piece is OPN-FIX); the export lists the codes.
- **Mistake correction** (MIS-1, General Manager only, reason and password asked again, idempotent):
  - **Void a scrap purchase** (`scrap.void`): the money is reversed, the sellable piece becomes VOIDED (only while
    still AVAILABLE in its branch) or the broken-scrap weight leaves the pool (only if the pool still holds it).
  - **Correct a supplier order** (`purchases.correct`): one unsold piece's making cost, or the order's transfer
    reference. The original stays; the history shows every correction. The supplier gold debt never changes.
- **Negative balances:**
  - **The drawer is blocked.** A cash outflow larger than the drawer returns `409 DRAWER_SHORT`, with the shortfall
    and what to do. This covers the scrap cash part, a cash refund on a void, a repayment from the drawer, and the
    correction of a drawer advance.
  - **The bank only warns.** It may go below zero, and attention A17 is raised.
- Expenses were removed (REM-1). A cash-out for the operating amount is **open** (CSH-3, Q-6). So are split payments
  at the point of sale (SPL-1, Q-7) and money transfers between branches (MNY-1, Q-8).

## 8. Reports (`reports.view`)

| Report | Extra permission | Content |
|---|---|---|
| Sales | profit columns with `profit.view` | Invoices, discounts, cost and gross profit |
| Purchases | `purchases.view` | Stock received from suppliers |
| Inventory | `inventory.view` | Every piece with weights and status (costs GM only) |
| Stock weight | `inventory.view` | Pieces plus broken scrap, by karat and as 24K |
| Inventory movement | `inventory.view` | Opening → movements → closing, pieces and grams |
| Inventory ledger | `inventory.view` | Line-by-line stock movements with references |
| Profit | `profit.view` | Gross profit by branch, category, karat |
| Branch performance | profit columns with `profit.view` | Branches side by side |
| User activity | `users.view` | Sign-ins, transactions and actions per user |
| Audit | `audit.view` | Every important action, filterable |

A review of the reports after the removals is still to do (RPT-1).

## 9. Users, sessions and audit

- **Users** (`users.view`, `users.manage`):
  - create a user, with a temporary password shown once;
  - edit a user (changing the role or branch needs re-confirmation);
  - disable and enable a user, unlock a user, and reset a password, which can never be retrieved.

  Roles are fixed (custom roles: ROL-1, deferred). `GET /roles` lists them.
- **Sessions** (`sessions.view_own`, `sessions.view`, `sessions.revoke`): the active sessions, with device, IP and
  current screen. A manager can end a session. Presence uses `security.sessionIdleMinutes` (10).
- **Audit** (`audit.view`): an append-only log with the user, role, branch, IP and session. Descriptions are stored
  as a key plus parameters, so they show in the reader's language.
- **Scopes:** `scope.all_branches` gives the General Manager every branch; everyone else is limited to their own
  branch. Requests for another branch's data return 403.

## 10. Sign-in security

- **Passwords:**
  - Argon2id, with a minimum length of 10.
  - An account locks after 5 failures, for 15 minutes, doubling up to 60.
  - Sign-in is throttled per IP.
  - Users cannot change their own password unless `allowSelfPasswordChange` is on; the forced change at first
    sign-in always happens.
- **Sessions:** the cookie is HttpOnly and SameSite=Lax. A session signs out after 60 minutes idle and ends after 12
  hours at most. Changes require a CSRF token.
- **Passkeys and recovery codes:**
  - A passkey is required for the roles in `security.twoFactorRequiredRoles` (General Manager by default; branch
    manager optional; never cashiers).
  - Users get 10 recovery codes, a list of their last sign-ins, and new-device alerts with "This wasn't me".
  - The second-factor settings are changed under Settings → Second factor (`PUT /security/second-factor`).
- **Re-confirmation:** for the actions listed in the README, the password must have been entered within the last 5
  minutes (`reauthWindowMinutes`), plus the passkey for users who have one.
- **Operator commands** (shell only): `unlock`, `reset-gm-password`, `reset-second-factor --confirm` and
  `unlock-security-lock --confirm`.

## 11. Settings, branding and branches (`settings.manage`, `branches.manage`)

- **Settings:**
  - Each setting has a typed registry entry with a default (`shared/src/settings.ts`) and a version.
  - Its history is append-only (`settings_history`).
  - Every change needs re-confirmation and is audited.
- **Gold rates** (`POST /gold-rates`): the selling rate per gram and karat, recorded in a history; one company-wide rate.
  The settings `rates.rateChangeMaxPct` and `rates.goldRateScope` are stored but not in use: hidden from Settings, writes
  refused, their meaning **open** (RAT-1, RAT-2).
- **Branding:**
  - The company names, currency labels, invoice footer, sign-in tagline and logo come from Settings. Nothing
    client-specific is coded.
  - The logo may be PNG, JPEG or WebP, at most 512 KB and 1024 × 1024 px; SVG is refused.
- **Branches:** each branch has a unique, permanent code, plus an Arabic name and a city. A new branch starts with zero
  in every account.
- **Printing:** paper A4, A5 or receipt (72 mm printable width), auto-print after a sale (off by default), and a test
  page.
- **Backups** (`backups.view`): the status of the last backup and the last restore drill. Warnings are raised after 26
  hours (backup) and 7 days (drill).

## 12. Language and formats

- Arabic (RTL) is the default, with an English switch. English strings are the translation keys, and the Arabic
  translations are in `frontend/src/lib/i18n-ar.ts`.
- Amounts and weights always use Western digits. API errors and audit entries carry a key plus parameters.
- `npm run i18n:check` finds hardcoded English and missing Arabic translations.

## 13. Not built or open (summary)

- Computed pricing (PRC-1).
- Correcting a piece of a sealed opening (OPN-FIX); XLSX import of the opening.
- Barcode labels (LBL-1).
- Tax invoice (TAX-1).
- Cash-out for the operating amount (CSH-3).
- Split payment at the point of sale (SPL-1).
- Money transfers between branches (MNY-1).
- Customer identification on scrap (SCR-1).
- Voiding a scrap purchase, and correcting a purchase (SCR-VOID, PUR-FIX).
- Server-side pagination (BE-7).
- The remaining screens of the redesign (UI-C).

See `docs/BACKLOG.md`.
