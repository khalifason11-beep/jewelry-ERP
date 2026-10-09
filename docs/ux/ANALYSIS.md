# UX-0 — Analysis and proposed UX architecture

Status: **approved by the owner with decisions D-ux-0 … D-ux-16** (`docs/decisions.md` §14; summary in §10.2
below). No application code was changed for this document. Where a decision changed a proposal, the text below
is updated and marked *(decided)*.
Inputs: `docs/ux/BRIEF.md` (hierarchy, density, role focus), `docs/SPEC.md` (overrides the brief),
`docs/BACKLOG.md` (UI-A, UI-B, UI-C, FIX-1, FIX-2, REM-3, PRC-1, RPT-1), the Figma mockups (see §0.2) and the
baseline screenshots in `docs/ux/baseline/` (2026-10-06, demo and empty production databases; removed from the working copy by UI-A2, D-ui-10: open them at commit `00d0f89`, e.g. `git show 00d0f89:docs/ux/baseline/demo/ar-1366x768/01-gm-home-company-overview.jpg`).

Precedence used throughout: **SPEC > BRIEF**; the **approved mockups** (`docs/ux/mockups/`, tokens in
`docs/design-reference/tokens.md`) decide the visual language; the **brief** decides hierarchy, density and role
focus. *(decided, D-ux-0: no Figma export files will be provided; the Figma screenshots shown in the conversation
are not in the repository and are not relied on.)*

---

## 0. Ground rules for this document

### 0.1 Out of scope (removed by REM-1 / REM-2, SPEC overrides the brief)
Expenses, Hasad orders, prepaid-order fulfilment, the weight-difference flow and the Hasad pages. **Hasad remains
only as a payment method** (invoice number required, transaction reference optional) and as the per-branch
**Hasad receivable** settled by Hasad's bank transfer (Cash screen). Where the brief lists "Expenses" in a KPI row
or "Hasad orders" in a role's focus, this analysis drops them.

### 0.2 The Figma reference (historical)
*(decided, D-ux-0)* The design source is now the approved mockups; their CSS variables are written out in
`docs/design-reference/tokens.md`. The table below records what the Figma screenshots shown in the conversation
looked like when this analysis was written; it is **not** a source of values. Q-UX-1 is closed.

| Element | What the mockup shows | Approximate value |
|---|---|---|
| Sidebar | Full-height navy panel with rounded corners, detached from the page edge; groups "FINANCE" and "ADMINISTRATION"; the same diamond outline icon for every item; active item = lighter navy pill | navy ≈ `#0F1629`, active ≈ `#232D45` |
| Top bar | No bar: pills floating on white. Dark pill "● 1,070,000 SDG/gm" (gold dot), light pill "● 116.10 USD/gm", language pill "English", round avatar | light pill ≈ `#F4F5F8` |
| Accent | Muted gold: dots, icons, the login button | ≈ `#DDB874` |
| Surfaces | White page; light grey rounded panels; white rows inside panels | panel ≈ `#F4F5F8`, radius ≈ 24 px (panels), 12 px (rows), full pills for chips |
| KPI row | 4 separate rounded cards; the first is navy with white text, the others light grey | |
| Branch table | Rows as white rounded strips on a grey panel, a colour dot per branch | |
| Chart | Grouped bars per month, one bar per branch | branch palette: navy, gold, light cream ≈ `#FDE6BD`, periwinkle ≈ `#C3CEF0` |
| Sales list | Filter pills (Today, Yesterday, 7 days, 30 days, This month, All, State); collapsed icon-only sidebar; 9 columns | |
| Login | Image panel (cream/brown folded-paper photo) with "Logo" and a serif tagline; form on the right; script-font "Welcome Back" | |
| Typography | Sans-serif UI (Inter-like); a script display font for "Welcome Back"; a serif tagline on login | |

Mockup typos to fix when building (UI-A already says so): "Mange Everything", "Costumer", "Cache" (Cash), months
"Jun … Jun", "Total in gm" under a piece count, "Number of sold items" under an amount.

### 0.3 Current tokens (code)
`frontend/src/index.css`: ink (navy) `#0a1120`–`#b4bccb`, gold `#8a6a24`–`#fbf7ec` (500 = `#c9a24b`), canvas
`#f3f4f7`, lines `#e2e5eb`/`#cfd4de`, chart series blue `#2a78d6`, orange `#eb6834`, green `#1baf7a`, amber `#eda100`.
Fonts: IBM Plex Sans Arabic / IBM Plex Sans / IBM Plex Mono, bundled locally. The navy already matches Figma
closely. The gold is darker than Figma's. The chart palette does not match Figma at all.

---

## 1. Current-state audit of the two dashboards

Screens: `baseline/demo/*/01-gm-home-company-overview*.jpg` and `18-bm-home-branch-dashboard*.jpg`.

### 1.1 Company dashboard (`CompanyDashboardPage`, GM home "Executive Overview")

Height at 1366×768: about 1,900 px of content in a 712 px window (**2.7 screens**). Above the fold: the title,
the period selector, the 4 KPI cards and the first rows of the branch table.

| # | Block | Purpose / question answered | Who needs it | Verdict |
|---|---|---|---|---|
| 1 | Backup banner (only when a backup is overdue) | "Is my data safe?" | GM | **Move into "Needs attention"** as one line with severity; a full-width banner pushes everything down (empty production: 2 banners before any figure) |
| 2 | Passkey hint banner ("you have one passkey…") | Security setup | GM | **Move to Security / the user menu**; at most a one-line notice, never above level 1 |
| 3 | Period selector (Today / 7 days / MTD / 30 days / Custom) | Scope of every figure | GM | **Keep**, as Figma's filter pills; default "Today" for the home, or MTD (DECIDE D-4) |
| 4 | KPI: Total sales (dark) + invoice count | "How much did we sell?" | GM | **Keep, level 1 (primary)** |
| 5 | KPI: Cost of sales | Rarely a decision on its own; it is sales − profit | GM | **Remove from level 1** → level 2/report (redundant: derivable) |
| 6 | KPI: Gross profit (gold card) + margin | "Are we making money?" | GM | **Keep, level 1** |
| 7 | KPI: Inventory value at cost + pieces + weight | "What do we hold?" | GM | **Keep, level 1**, with **weight first** (the business thinks in grams; SPEC §4) and value second |
| 8 | Branch performance table (sales, purchases, profit, stock value, total row, footnote, "Full report") | "Which branch is doing what?" | GM | **Keep, level 2**, as Figma's branch strips: 4 numeric columns max; the footnote moves to a tooltip |
| 9 | Daily sales by branch (stacked bars, 4 colours) | "Why did sales change?" | GM | **Keep, level 2**, one chart; Figma's grouped bars or a single line per branch (DECIDE D-5) |
| 10 | "Needs attention" (transfers in transit, users signed in now) | "Is anything waiting for me?" | GM | **Promote to level 1** and give it real signals (§3); "users signed in now" is not an attention item: **move to Active users** |
| 11 | Sales by category (horizontal bars) | Product mix | GM | **Move to level 3** (Profit by type report; the link already exists). Its Arabic axis labels are clipped (baseline) |
| 12 | Inventory valuation by karat (table + retail value footnote) | Stock value per karat | GM | **Move to level 3** (Inventory report); with one sellable karat (21K) it is one row that repeats the KPI |
| 13 | Total stock weight by karat (pieces / scrap / total / 24K) | Gold position | GM | **Merge** into one level-2 "Gold position" block: total weight, of which pieces vs broken scrap, 24K equivalent; the per-karat table → Inventory report |

Counts: **8 cards/panels** (4 KPI cards + 4 panels) + 1 standalone table card, **4 KPIs** plus 9 secondary
figures in sub-lines, **3 tables** (branch, karat valuation, stock weight), **2 charts** (stacked bars, horizontal
bars), **3 "full report" links**, **colours**: navy, gold, emerald, sky, amber + the 4 branch series colours
(blue, orange, green, amber) → **9 hues** on one screen, 2 of them (amber) with two meanings.

Redundancy: the inventory value appears 4 times (KPI, branch table total, karat table total, karat table footnote
as retail); the piece count 3 times; the stock weight 3 times (KPI sub-line, karat table, stock weight table).

### 1.2 Branch dashboard (`BranchDashboardPage`, branch-manager home, also embedded in Branch detail for the GM)

Height at 1366×768: about 1,680 px (**2.4 screens**). Above the fold: the title, the date, the 4 KPI cards, the
stock weight table header.

| # | Block | Purpose / question | Who | Verdict |
|---|---|---|---|---|
| 1 | Business-date picker | Look at another day | BM | **Keep**, smaller (secondary); "Today" is the default and should read as such |
| 2 | KPI: Today · sales (dark) + invoices + pieces | "How is today going?" | BM | **Keep, level 1** |
| 3 | KPI: Today · purchases (count for the BM) | "Did stock arrive?" | BM | **Move to level 2** ("Stock today": in/out) |
| 4 | KPI: Gross profit | **Always "—" for the branch manager** (cost rules, Q15) — a level-1 slot that says nothing | GM only | **Remove for the BM**; keep only in the GM's embedded view |
| 5 | KPI: Available inventory (pieces + grams + reserved) | "What can I sell?" | BM | **Keep, level 1**, weight first |
| 6 | Total stock weight by karat (table) | Gold held incl. scrap pool | BM | **Merge** into one "Gold position" line (pieces g + scrap g = total g, 24K eq.); table → Inventory report |
| 7 | Inventory movement (9-row equation, reconciled badge) | "Does the stock add up?" | BM | **Replace** with one line: "Today: +10 in, −3 sold · stock reconciles ✓"; the equation → level 3 (Inventory movement report). A mismatch becomes an **attention item** |
| 8 | Sales: last 14 days (line; profit line GM only) + MTD subtitle with a stray "$" | Trend | BM | **Keep, level 2**, compact; fix the "$" typo (bug, UI-B) |
| 9 | Cashier activity (7 columns: invoices, value, cancelled, first sign-in, last activity, session) | "Is my team working, any voids?" | BM | **Level 2, slimmer**: name, invoices, value, voids (warning colour only if above the threshold), signed in yes/no; sign-in times → Active users |

Counts: **7 cards/panels** (4 KPI cards + 3 panels; the cashier table is a 4th panel), **4 KPIs** (one always
empty for the BM) + 6 secondary figures, **3 tables** (stock weight, movement, cashiers), **1 chart** (line),
**colours**: navy, gold, emerald, rose + chart ink/gold → **6 hues**; rose is used both for "minus" signs and for
"cancelled" counts. On the empty production database the whole page is **zeros in tables** (27 cells of
"0.000 g") with a green "reconciled" badge — no guidance at all.

### 1.3 What competes for attention today (both dashboards)
- Four equal-weight KPI cards, two of them filled (navy and gold): the eye goes to colour, not to meaning.
- Three tables of numbers in grams with three decimals, at the same visual level as the KPIs.
- Full-width warning banners above the figures.
- Gold used for: a KPI card, links ("Full report"), the active nav marker, a chart line, focus rings, the
  primary POS button. Gold carries no single meaning.
- No single primary action: neither dashboard has one (correct for a dashboard) but neither tells the user
  where to go next either.

---

## 2. Primary goals and questions per role and page

### 2.1 Home screens — what each role must be able to answer within 10 seconds

**General manager — "Is anything in the business that needs me right now?"**
1. Is there anything I must act on? (attention list, or "No urgent actions")
2. How much did we sell today / this period, and did we make money? (sales, gross profit)
3. Which branch is behind or unusual? (branch strip, sorted)
4. What gold do we hold — pieces and broken scrap, in grams? (gold position)
5. Are the systems healthy? (backup, sign-in alerts — inside the attention list, not as banners)

**Branch manager — "Is my branch running normally today?"**
1. How are today's sales going? (sales today, invoices, pieces)
2. Does anything need me: a transfer to receive, last night's cash count, voids, a stock mismatch?
3. Does my cash drawer match? (expected cash; yesterday's count difference)
4. What can I sell, and how much gold do I owe suppliers? (available pieces/grams; gold owed in grams)
5. Who of my team is working? (signed-in yes/no, sales per person)

**Cashier — "Can I sell the next piece quickly?"** (home = POS)
1. Where is the piece? (search/scan, type chips)
2. What is in the cart and what is the total?
3. How is the customer paying, and what must I type for it? (Cash / Bank transfer + reference (FIX-2) / Hasad + invoice number)
4. Did it go through and print? (receipt dialog, print)

### 2.2 One primary goal per main page

| Page | Primary goal (the one question) | The one primary action |
|---|---|---|
| Executive overview (GM) | Is anything wrong in the business? | none (navigation to the attention item) |
| Branch dashboard (BM) | Is my branch running normally today? | none (navigation to the attention item) |
| POS | Sell this piece now | Complete sale |
| Sales | What did we sell? | Export (secondary) — no primary |
| Sale detail | What exactly was sold, and can it be reprinted or voided? | Print (reprint for managers); Void is a danger action, not primary |
| Inventory | What do we have, and where? | none (row → item) |
| Item detail | What is this piece's state and history? | Change price / adjust (danger, with reason) |
| Types & products | What can we stock? | New product |
| Supplier purchases | What came in from suppliers, and what gold do we owe? | New purchase |
| Purchase detail | What is still owed on this order? | Record settlement (broken scrap) |
| Scrap gold | Buy gold from a customer | Buy (the form must be first, above the pool) |
| Transfers | What is moving between branches, and what must I receive? | Receive (on incoming rows); "New transfer" moves to the POS cart (FIX-1) |
| Cash | Does the drawer match the ledger today? | Record cash count |
| Reports | What happened, and why? | Open a report |
| Audit | Who did what, and when? | none (filters) |
| Users | Who can use the system? | New user |
| Active users | Who is signed in now, from where? | Revoke (danger) |
| Settings | How does the business work? | Save (per section) |
| Security | Are my sign-in factors safe? | Add passkey |
| Branches (GM) | How does each branch compare? | New branch |

---

## 3. ATTENTION table

Rules are deterministic, thresholds set by the GM in Settings, no anomaly detection. "Exists" = the data and a
query already exist; "small query" = data exists, a new aggregate is needed; "new setting" = a threshold to add;
"new feature" = model or workflow change. Everything except the "Exists" rows is a **backend change** and is listed
again in §10.1 for separate planning.

| # | Signal | Status today | Rule (proposed default) | Who sees it | Backend change |
|---|---|---|---|---|---|
| A1 | Transfer in transit | **Exists**: `attention.transfersInTransit` (company dashboard) and a TRANSFER notification for the receiving branch | Count of IN_TRANSIT transfers; for the BM only incoming ones | GM (all), BM (own incoming) | — (BM dashboard needs the count: **small query**) |
| A2 | Transfer stale | Setting `transfers.pendingClaimStaleHours` (24) **exists but nothing reads it** | IN_TRANSIT longer than the setting → warning | GM, BM of both branches | **Small query** |
| A3 | Disputed / missing transfer items | **New feature**: receipt is all-or-nothing (statuses IN_TRANSIT / RECEIVED / CANCELLED), no per-item dispute | Receiving branch marks an item missing/damaged → critical until the GM resolves | GM, both BMs | **New feature** (belongs with FIX-1 / a transfer item) |
| A4 | Cash-count difference | **Exists per branch and day** (`difference` in the reconciliation); no cross-branch view; no tolerance | Last count's difference ≠ 0 (or above a tolerance) → warning; above a second threshold → critical | GM (all), BM (own) | **Small query** + **new setting** `cash.countDifferenceTolerance` (default 0) |
| A5 | No cash count recorded | Counts exist; nothing checks for a missing one | Business day closed without a count → warning the next morning | GM, BM | **Small query** |
| A6 | Open supplier gold debt (per supplier) | Data **exists**: `purchases.gold_owed_mg_pure24` + `supplier_id` (required since CAT-0); no per-supplier aggregate, **no supplier page** | Gold owed per supplier (24K g); older than N days → warning | GM; BM for own branch's orders (weight only, D-4-16) | **Small query** + **new setting** `purchases.supplierDebtMaxAgeDays` (e.g. 30); a supplier list page is a UI-C item |
| A7 | Hasad receivable ageing | Balance **exists** (Cash screen); no ageing | Oldest unsettled amount (FIFO over HASAD sales vs settlements) older than N days → warning | GM, BM | **Small query** + **new setting** (name without "hasad" in the key, e.g. `cash.receivableMaxAgeDays`, or an allow-list entry, D-rem2-7) |
| A8 | Scrap price awaiting GM approval | **Does not exist as a queue**: beyond the tolerance a BM is simply refused and the GM must enter the purchase (`requireGmApprovalForScrapOverride`) | (a) Approval queue = **new feature**; or (b) informational: scrap bought at an override price this week (data exists: agreed rate vs rate) | GM | (a) **new feature**, (b) **small query** — DECIDE D-9 |
| A9 | Backup health | **Exists**: `/backups/status` (BACKUP_NEVER/STALE, VERIFY_NEVER/STALE) | As today (thresholds already in Settings) | GM | — (move from banner to the list) |
| A10 | Sign-in from a new device | **Exists per user** (`sign_in_events.new_device`, own alert on Security); no company-wide view | Any new-device sign-in in the last 7 days → info; for a manager role → warning | GM | **Small query** |
| A11 | Failed sign-ins | **Exists** (SECURITY notification, 24 h) | Count in 24 h ≥ 1 → info, ≥ lockout threshold → warning | GM | — |
| A12 | Locked accounts | Data **exists** (`users.locked_until`, `mfa_locked_until`); the Users page shows it per user | Any account locked now → warning with "Unlock" link | GM; BM for own branch's users | **Small query** |
| A13 | Voids | **Exists** per cashier per day (cashier table) | Voids per cashier per day > N → warning | GM, BM | **New setting** `sales.voidsPerDayWarn` (e.g. 2) + small query for the company view |
| A14 | Reprints | Data **exists** (`sales.reprint_count`, INVOICE_REPRINTED audit) | Reprints per branch per day > N → info | GM | **Small query** + **new setting** `sales.reprintsPerDayWarn` |
| A15 | Stock does not reconcile | **Exists** on the branch dashboard (movement vs item statuses) | Mismatch → critical | GM, BM | **Small query** for the company view |
| A16 | No gold / scrap rate set (today) | Rates **exist** with `effectiveAt`; the header chip shows "—" on a new database | No 21K sell rate, or no scrap rate for a sellable karat → critical on a new database, warning if older than N days | GM | **Small query**; first-steps text belongs to REM-3 |
| A17 | Unusual sales decline | **Not proposed now** (needs a baseline; the brief asks for it, but deterministic rules come first) | e.g. today < X % of the same weekday average → later, RPT-1 | GM | Later |

Severity and colour: **critical** (red) — act today; **warning** (amber) — act soon; **info** (neutral) — know.
An empty list reads "No urgent actions." (in Arabic "لا توجد إجراءات عاجلة."). Each item: one line, a count or
value, the branch, and a link to the page that resolves it.

---

## 4. New information architecture

### 4.1 Sidebar (real screens only; no Expenses, no Hasad pages)

Labels are the existing Arabic terms. Groups follow the work, not the database.

**General manager**
| Group | Items |
|---|---|
| — | الرئيسية (Executive overview) |
| المبيعات (Sales) | المبيعات *(decided, D-ux-7: no POS entry for the GM; no permission change)* |
| المخزون والذهب (Stock and gold) | المخزون · التحويلات · ذهب الكسر · الأنواع والمنتجات |
| الموردون (Suppliers) | مشتريات الموردين · *later:* الموردون, only once the page exists (UI-C3, BE-3) |
| المال (Money) | النقدية والتسوية · *later:* الأسعار, only once the Prices page exists (PRC-1) |
| التحليل (Analysis) | الفروع · التقارير |
| الإدارة (Administration) | المستخدمون · المستخدمون النشطون · سجل التدقيق · الإعدادات |

**Branch manager**
| Group | Items |
|---|---|
| — | الرئيسية (Branch dashboard) |
| البيع (Selling) | نقطة البيع · المبيعات |
| المخزون والذهب | المخزون · التحويلات · ذهب الكسر · الأنواع والمنتجات |
| الموردون | مشتريات الموردين |
| المال | النقدية |
| التحليل | التقارير |
| الفريق (Team) | المستخدمون · المستخدمون النشطون · سجل التدقيق (if permitted) |

**Cashier**: نقطة البيع · نشاطي (My activity). Nothing else — two icons, as today.

Security (passkeys, recovery codes) and the language switch stay in the **user menu**, not in the sidebar.
Icons: *(decided, D-ux-6)* one distinct icon per item; the diamond only as the logo.
*(decided, D-ux-16)* The sidebar shows **only screens that exist**: no dead links (Prices, Suppliers) until those pages are built.

### 4.2 Dashboard levels

**GM — Executive overview**
- **Level 1 (one 1366×768 window, no scrolling):** period pills (default **Today**, remembered per user in the
  browser, D-ux-2) · **Sales** (with invoices) as its own dark card · one light surface with **Gross profit** (with
  margin), **Gold held** (grams, of which scrap) and **Stock value at cost** (with pieces and grams: D-ux-4) ·
  **Needs attention** list (max 5 lines + "show all") or "No urgent actions." · **Branch strips** (4 branches:
  sales, profit, gold held, one attention dot).
- **Level 2 (below the fold, same page):** sales by branch for the period (horizontal bars **labelled by branch
  name**, D-ux-5; the daily trend per branch is in the sales report) · gold position (pieces / scrap / 24K, gold
  owed to suppliers).
- **Level 3 (other pages):** branch detail → sale → item; inventory report (karat valuation, retail value);
  profit by type; inventory movement; cash reconciliation; audit.

**BM — Branch dashboard**
- **Level 1:** Today's **sales** (amount, invoices, pieces) as its own dark card · one light surface with
  **Expected cash in drawer**, **Available stock** (pieces, grams) and **Gold owed to suppliers** (24K g) · **Needs attention** (transfers to receive, cash count,
  voids, stock mismatch, supplier debt age) or "No urgent actions."
- **Level 2:** 14-day sales line · team today (name, invoices, value, voids, signed in) · stock today (+in / −out,
  reconciles ✓).
- **Level 3:** inventory movement equation, stock by karat, sales list, cash reconciliation, sessions.

**Cashier — POS** (already level-1 only): search + type chips; cards; cart; payment; Complete sale. Level 2:
held sales, my activity.

Level-1 fit check at 1366×768 (712 px of content height under a 56 px top bar): page header 64 + KPI strip 96 +
attention list 5 × 40 + header 48 = 248 + branch strips 4 × 56 + header 48 = 272 + gaps 3 × 20 → **≈ 740 px**.
It fits only with **compact** spacing (row height 40, strip 88) or with the attention list and the branch strips
**side by side** (the mockups use side by side: `docs/ux/mockups/`).
*(re-checked after D-ux-1 and R16 13/15/17/24)*: in `gm-home.html` and `bm-home.html` level 1 ends at about
570 px of the 768 px window at 1366×768 (top bar, header, KPI row, attention list and branch strips/team), so R14
holds in Arabic; English is shorter.

---

## 5. Measurable rules (proposed values — confirm or change)

| # | Rule | Proposed value |
|---|---|---|
| R1 | Primary KPIs on a dashboard | **≤ 4** (GM 4, BM 4, none for the cashier) |
| R2 | KPI presentation | *(decided, D-ux-1, replaces "one strip")* **Sales is its own dark card**, separated by a gap; the other three figures share **one light surface divided by thin lines** (GM: gross profit, gold held, stock value at cost; BM: expected cash, available stock, gold owed). If the owner later says four fully separate cards were meant, only this rule changes |
| R3 | Cards/panels per screen | **≤ 4** on a dashboard; **≤ 3** on an operational page (filters + table count as one) |
| R4 | Primary actions per screen | **Exactly one** filled navy button (or none on dashboards/lists that only navigate); everything else secondary/ghost; danger actions are red-outlined, never primary |
| R5 | Accent colour | **One** accent: gold = brand + "current selection" (active nav, selected chip, focus ring). Never a KPI fill, never a link colour, never a chart series (DECIDE D-5) |
| R6 | Meaning colours | normal = ink/neutral; **warning** = amber (`#B45309` text on `#FEF3C7`); **critical** = red (`#B91C1C` on `#FEE2E2`); **success** = green (`#047857` on `#D1FAE5`), used only for a completed state, never decoration. Information = neutral, not blue |
| R7 | Chart types | **≤ 2** in the product: bars (comparison between branches/categories) and a line (trend over time). No pies, no stacked bars on a dashboard. ≤ 1 chart per dashboard level 1–2 |
| R8 | Table default columns | **6–7** visible by default; the rest in a "Show details" drawer per row and a column chooser (remembered per user, in the browser) |
| R9 | Table headers | **Sticky** headers and a sticky first column (the code) on long tables |
| R10 | Pagination | **Server-side** (50 rows per page, max 200) for sales, inventory, audit, purchases, scrap, transfers; today lists load up to 1,000 rows into the browser (`limit: 1000` on inventory) |
| R11 | Filters per table | ≤ **4** visible (period, branch, status, search); more in a "More filters" popover; the active filters shown as removable chips |
| R12 | Numbers | *(decided, D-ux-11, Q-14 closed)* **Grams are shown with three decimals everywhere** (dashboards, details, invoices, receipts, reports, CSV); **money has no decimals**; the currency label once per block, not per cell |
| R13 | Banners | **None above level 1**; system notices go into the attention list or the user menu |
| R14 | Level-1 fit | Every home's level 1 visible at **1366×768 without scrolling** in Arabic and English |
| R15 | Empty states | Every list says *what* is empty and offers the *next action* (§8); never a table of zeros |
| R16 | Text sizes | *(decided, D-ux-11)* **13** (meta), **15** (body/tables), **17** (section titles), **24** (KPI figures); page title **20** |

---

## 6. Flow review (real workflows)

Clicks counted from the screen where the flow starts, with a mouse; typing counts as one step per field.

| Flow | Today | Unnecessary or confusing steps | Proposal | Controls that must NOT be weakened |
|---|---|---|---|---|
| Sign in → POS sale, **cash** → print | sign in (3: user, password, submit) → POS opens · click piece (1) · Cash is default (0) · Complete (1) · receipt dialog → Print (1) = **3 clicks** after sign-in | none; auto-print setting can remove the last click | keep; show "Cash" as selected more clearly | idempotent sale key (double click = one sale) |
| POS sale, **bank transfer** | piece (1) · Bank transfer (1) · Complete (1) · Print (1) = 4 | **No reference field** — FIX-2 | FIX-2: reference field appears under the methods, required, Complete disabled until filled = 5 steps | FIX-2's duplicate-reference confirmation |
| POS sale, **Hasad** | piece (1) · Hasad (1) · invoice no. (type) · optional txn ref · Complete (1) · Print (1) = 5 | none | keep; FIX-2 unifies the reference field | invoice number required |
| **Void** a sale | Sales → find (search) → open sale (1) → Void (1) → reason (type) → confirm (1) = 4 + typing | finding the sale: the sales list has 10 columns and no "today, my branch" default for the BM | default filter "today" for managers | **reason (≥ 3 chars), `sales.void` permission, audit, idempotency**; no re-auth today (DECIDE D-10: add password re-confirmation for voids?) |
| **Reprint** | Sale detail → Print (1) → "COPY n" | none | keep | `sales.reprint` (managers only), reprint counter, audit |
| **Scrap purchase** (broken) | Scrap → scroll down to the form (the pool is first) → type: karat, gross, net (3) → payment → Buy (1) | the form is below the pool, below the fold | form first; pool to the side | GM-only override beyond tolerance; idempotency |
| Scrap purchase (sellable) | + kind (1) + product (select or **New product** inline, CAT-0) + selling price | none since CAT-0 | keep | karat must be sellable; deactivated products refused |
| **Supplier order** | Purchases → New purchase (1) → supplier (select or New supplier) → per line: product (select or +), gross, net, cost, price (5) → Receive (1) | 5 fields per line; the cost is pre-filled from the rate only on blur | PRC-1 removes the selling price; keep one line per piece | supplier required (CAT-0); making charge account; idempotency |
| **Supplier settlement** | Purchase → Settlement form at the bottom: karat, weight (2) → Settle (1) | the form is at the bottom of the detail page; no list of "orders with gold owed" | a "Gold owed" list (per supplier, A6) with a Settle action per order | weight ≤ owed and ≤ pool (DB CHECKs); idempotency |
| **Transfer** (send) | Transfers → "Select pieces from stock" (1) → tick pieces (n) → Send → destination (1) → confirm (1) | the owner wanted it **in the POS cart** (FIX-1) | FIX-1: cart → "Transfer" below Complete sale → destination + courier → confirm | `inventory.transfer`, BM only, idempotent, audited |
| Transfer (**receive**) | Notification or Transfers → the row's Receive button — **cut off at 1366** (the table overflows sideways) → confirm | the action column is off-screen | incoming transfers as an attention item with "Receive" | idempotent receive, audit |
| **Cash count** | Cash → (GM: choose a branch) → counted amount (type) → note → Record (1) | GM must pick a branch first ("Select a branch" empty box) | for the GM, a per-branch row with "Count"/"Difference" | append-only counts, audit |
| Create **type, product, supplier** inline | Purchase line "+" → dialog (name, karat, type or "+ New type") → Create (CAT-0) = 3–5 steps | none | keep | duplicates refused after normalization; GM-only deactivation with reason |

### 6.1 Dangerous actions and their existing controls

| Action | Permission | Reason | Password re-confirmation (+ passkey for the GM) | Audit | Other |
|---|---|---|---|---|---|
| Void a sale | `sales.void` (BM, GM) | **required** (≥ 3) | no | yes | idempotent |
| Reprint an invoice | `sales.reprint` | no | no | yes (`INVOICE_REPRINTED`) | "COPY n" on paper |
| Inventory adjustment (damaged, restock, return to supplier) | `inventory.adjust` | **required** | **yes** | yes | — |
| Change a piece's selling price | `inventory.price_edit` | optional | no | yes | — |
| Change gold rates / scrap rates | `settings.manage` (GM) | no | **yes** | yes | max change % setting for gold |
| Settings, branding, second-factor rules | `settings.manage`, security | optional | **yes** | yes (`settings_history`) | — |
| Create/edit branch; create user; reset password | GM / `users.manage` | no | **yes** | yes | — |
| Disable/unlock user; revoke session | `users.manage`, `sessions.revoke` | no | no | yes | — |
| Supplier settlement with scrap | `purchases.settle` | no | no | yes | DB CHECKs, idempotent |
| Settle Hasad receivable | `cash.settle_hasad` | no | no | yes | idempotent |
| Deactivate/reactivate type or product | `catalog.manage` (GM) | **required** | no | yes | — |
| Remove a passkey | self | no | **yes** | yes | — |
| Demo reset | demo only | — | **yes** | — | — |

None of these controls is weakened by any proposal here. Proposed additions (DECIDE): re-confirmation for voids
above an amount; a reason for price changes.

---

## 7. Non-negotiables

1. **Cost, profit and gold-debt money figures stay General-Manager-only**, enforced by the server and the
   field-classification registry (`shared/src/field-classification.ts`). The UI may only *hide* what the API
   already omits; no new screen may show a COST field to a branch manager or cashier. Gold **weights** owed are
   operational and visible to the BM (D-4-16).
2. **RTL is the primary layout.** Every screen is designed in Arabic first; English (LTR) must work equally.
   Numbers stay LTR inside RTL text.
3. **The print module is untouched** (invoices, receipts, `frontend/src/print/*`, `shared/src/print.ts`).
4. **Every e2e script and REH-1 keep working**; selectors used by REH-1 (`data-testid`) are preserved or moved
   together with the script in the same commit.
5. **No business-logic change without a separate, approved backlog item.** Every backend item from §3 is listed
   in §10.1 and needs its own approval.
6. Permissions and routes do not change in UI phases; a hidden button is never the only protection.
7. Screens stay keyboard-usable (POS: `/` focuses search, Enter adds, Esc closes only the top dialog).

---

## 8. Empty states (brand-new production database)

Baseline: `baseline/empty-production/`. Today: the GM sees 2 banners and 4 KPI cards of "—"; the BM sees 27 cells
of "0.000 g" and a green "reconciled" badge; the cashier sees "No matching pieces" although the branch simply has no
stock; the rate chip shows "—/g". First-steps guidance itself is REM-3; the texts below are the contract.

| Screen | What the empty state must say | What it must offer |
|---|---|---|
| GM home (no branch) | "Welcome. Three steps before the first sale: set today's gold rate, create a branch, add its staff." with progress (0/3) | Set rates · New branch · New user |
| GM home (branches, no sales yet) | KPIs show **0** (not "—") with "No sales yet in this period"; attention list: "No urgent actions." | Open POS (if allowed) · Record a supplier purchase |
| BM home (no stock) | "Your branch has no stock yet. Receive a supplier order or buy scrap to start." | New purchase · Buy scrap |
| POS (no stock) | "No pieces in this branch yet." (not "no matching pieces"); a cashier: "Ask your branch manager to receive stock." | BM: New purchase; cashier: none |
| POS (filters hide everything) | "No pieces match these filters." | Clear filters |
| Sales | "No sales in this period." | Change period |
| Inventory | "No pieces in stock." | New purchase · Buy scrap |
| Types & products | "No types or products yet. Create the first type (for example rings), then a product." | New type · New product |
| Supplier purchases | "No supplier orders yet." | New purchase |
| Suppliers (new page) | "No suppliers yet. Add one while recording a purchase." | New supplier |
| Scrap gold | Pool: "The broken-scrap pool is empty." List: "No scrap bought yet." | (the form is on the same page) |
| Transfers | "No transfers yet. Send pieces from the POS cart." (FIX-1) | — |
| Cash | "No movements today. Expected cash is the opening amount." | Record cash count |
| Reports | each report: "No data for this period." | Change period |
| Audit | "No events match these filters." (a new DB has bootstrap events) | Clear filters |
| Users | (never empty: the GM exists) | New user |
| Rates chip (top bar) | "Set today's rate" instead of "—/g" | link to Prices/Settings |

---

## 9. Static mockups

`docs/ux/mockups/` — self-contained HTML, RTL, fake and clearly labelled data, **approved by the owner; their CSS
variables are the design tokens** (`docs/design-reference/tokens.md`), no application code, no external requests
except the Google Fonts stylesheet for IBM Plex Sans Arabic. Updated after the decisions: D-ux-1 KPI layout, R16
type scale, D-ux-5 palette with labelled bars, D-ux-16 no dead links, and the cashier mockup with **Cash first and
selected by default** and the Hasad fields shown only when Hasad is selected:

- `gm-home.html` — Executive overview, level 1 in one 1366×768 window, level 2 below.
- `bm-home.html` — Branch dashboard.
- `cashier-home.html` — POS.
- `empty-gm-home.html` — the GM's first sign-in on a new database.

Open them in Chrome at 1366×768 (and 1920×1080). They show hierarchy, density and colour use only; they are not a
pixel design.

### 9.1 5-second test (the owner runs it with a real user on the mockups)

Show the mockup for 5 seconds, hide it, ask "What did you see? What would you do next?". Pass if the user says,
unprompted:

**General manager (`gm-home.html`)**
- [ ] how much the company sold (roughly the number) and that it made a profit;
- [ ] that **something needs attention** and what kind (e.g. "a transfer is late", "a cash difference in Omdurman");
- [ ] which branch is doing best or worst;
- [ ] how much gold the company holds (grams);
- [ ] where they would click next (the attention item).
- Fail if the user mentions a chart first, or cannot name one attention item.

**Branch manager (`bm-home.html`)**
- [ ] today's sales so far;
- [ ] that there is a transfer to receive and/or a cash-count issue;
- [ ] the expected cash in the drawer;
- [ ] that stock and gold owed are shown in grams;
- [ ] what to do next.
- Fail if the user asks "where is profit?" (it is GM-only by design) more than they notice the attention list.

**Cashier (`cashier-home.html`)**
- [ ] where to search/scan a piece;
- [ ] the cart total;
- [ ] the three payment methods, and that Cash is already selected;
- [ ] the one button that completes the sale.

**Empty database (`empty-gm-home.html`)**
- [ ] the three first steps and that none is done yet.

---

## 10. Phases, backend items and questions

### 10.1 Proposed phases (UI only unless marked)

| Phase | Content | Depends on |
|---|---|---|
| **UI-A1** Design system + shell *(done; owner instruction 2026-10-09 moved the shell and a plain login here, D-ui-1…9)* | Tokens from `docs/design-reference/tokens.md` (D-ux-0): colours (ink, one gold accent, meaning colours R6), type scale R16, spacing (4/8/12/16/24/32), radii (pill, 20/16/12/10/6), one shadow for pop-ups, buttons (primary/secondary/ghost/danger), inputs, tables, badges, alerts, dialogs, empty/loading/error/permission-denied states, skeletons; a `/ui` page in development only. **Shell**: grouped role-aware sidebar (§4.1), distinct icons, collapse to icons (the cashier always icons); top bar: rate chip, Demo badge, bell (until UI-B), language pill, user menu (Security inside). **Plain login page** (logo, company name, form) | REM-3 (D-ux-13) |
| **UI-A2** Login and first-run polish | Login redesign: tagline from a new branding setting, display font, image panel only if `login-background.jpg` is added with a confirmed licence; per-screen empty states. The banners (R13) were kept as they are by the owner (UI-A1, answer Q5) | UI-A1 |
| **UI-B1** GM home | §4.2 GM levels; attention list from BE-1 | UI-A2, BE-1 |
| **UI-B2** BM home | §4.2 BM levels; attention from BE-1; remove the empty profit KPI; fix the "$" typo | UI-A2, BE-1 |
| **UI-B3** Branches + sales list | Figma branches grid and sales list; filter pills; server-side pagination (backend) | UI-A2, BE-7 |
| **UI-C1** POS | Owner reviews a screenshot first (UI-C in BACKLOG); together with FIX-1 (transfer from cart) and FIX-2 (bank reference) | FIX-1, FIX-2 |
| **UI-C2** Stock & gold | Inventory (7 columns + drawer), Types & products, Scrap (form first), Transfers (no horizontal overflow; receive action visible) | — |
| **UI-C3** Suppliers & money | Supplier purchases, purchase detail, **Suppliers list** (gold owed per supplier), Cash (GM per-branch rows) | BE-3 |
| **UI-C4** Admin | Users, Active users, Audit, Settings (sections, one save per section), Security, Reports hub | — |
| **UI-C5** Empty states | §8 texts everywhere (first-steps flow itself is REM-3) | REM-3 |

**Backend items (separate approval each; none is part of a UI phase):**

| ID | Item | Signals |
|---|---|---|
| BE-1 | Attention endpoint: one extensible `/api/attention`, role and scope aware; each signal carries severity, count, branch and link. *(decided, D-ux-14)* **Pilot minimum set: A1, A2, A4, A5, A6, A9, A10, A11, A12, A15, A16**; tests prove a branch manager never receives a signal exposing a COST field | pilot set |
| BE-2 | Transfer staleness using `pendingClaimStaleHours`; incoming count for the BM | A1, A2 |
| BE-3 | Supplier gold owed per supplier (+ setting `purchases.supplierDebtMaxAgeDays`); supplier list API | A6 |
| BE-4 | Cash-count difference across branches, missing count (+ setting `cash.countDifferenceTolerance`) | A4, A5 |
| BE-5 | Receivable ageing (+ setting) — *deferred (Q-7)* | A7 |
| BE-6 | Security signals: new devices (company-wide), locked accounts | A10, A12 |
| BE-7 | Server-side pagination and sorting for sales, inventory, audit, purchases, scrap, transfers — *(decided, D-ux-15)* **P1, before the pilot** | R10 |
| BE-8 | Voids/reprints thresholds (+ settings) and company view — *deferred* | A13, A14 |
| BE-9 | Stock reconciliation per branch for the company view; missing-rate check | A15, A16 |
| BE-10 | Transfer item dispute (new feature, with FIX-1) — *deferred* | A3 |
| BE-11 | ~~Scrap override approval queue~~ — *(decided, D-ux-9)* not built; A8 is a report of override purchases only (small query, part of RPT-1) | A8 |

### 10.2 Questions for the owner — answered

The owner's answers are recorded as D-ux-0 … D-ux-16 in `docs/decisions.md` §14. In short: Q-UX-1 closed
(mockups are the design source); D-1 Sales as its own dark card + one surface for the other three; D-2 Today,
remembered; D-3 USD hidden until Q-10; D-4 grams and value together; D-5 palette with teal and darkened sand and
periwinkle, labelled bars; D-6 distinct icons; D-7 no POS entry for the GM; D-8 script font on login only; D-9
report only; D-10 SEC-2; D-11 rules confirmed (R16 13/15/17/24, R12 three decimals for grams); D-12 thresholds as GM settings;
D-13 UI-A1/A2 right after REM-3, before PRC-1, OPN-1, FIX-1/2. The table below is the original proposal.


| # | Question | My recommendation |
|---|---|---|
| Q-UX-1 | Commit the Figma images, the exported SVG assets and `tokens.md` to `docs/design-reference/` (only the images in this conversation exist; colours here are estimates). | Yes, before UI-A1 |
| D-1 | **KPI row**: Figma's 4 separate cards (first one navy) vs the brief's "no card per metric". | One strip with 4 figures on one surface; keep Figma's navy only for the first figure's background *or* drop it |
| D-2 | **Home period** for the GM: Today or Month to date by default? | Today (decisions are daily); MTD one click away |
| D-3 | **USD chip** in the top bar (Figma shows it; BACKLOG says only if Q-10 says yes). | Hide until Q-10 |
| D-4 | Show **value at cost** in the GM's level 1, or **grams only** with value at level 2? | Grams + value both at level 1 for the GM (one figure, value as sub-line) |
| D-5 | **Branch colours**: Figma's palette includes gold (navy, gold, cream, periwinkle); R5 says gold is never a chart colour. Keep Figma's palette or replace gold with a fourth neutral hue? | Figma's palette but replace gold by a teal/grey; cream on white fails contrast for bars — darken |
| D-6 | **Sidebar icons**: Figma uses the same diamond for every item. | Distinct icons (faster scanning), diamond only for the logo |
| D-7 | Does the **GM sell at the POS**? (today the GM sees "Point of sale") | Hide POS for the GM unless the owner sells |
| D-8 | **Script font** ("Welcome Back") and serif tagline on login: keep for login only? | Login only, never inside the app; Arabic equivalent font needed (question for the designer) |
| D-9 | Scrap price beyond tolerance: build an **approval queue** (new feature) or only report overrides? | Report only (small query) for now |
| D-10 | Add **password re-confirmation for voids** (above an amount) and a **required reason for price changes**? | Yes for both (separate backlog item, security) |
| D-11 | **Rules R1–R16**: confirm the values. | — |
| D-12 | **Thresholds** for A4, A6, A7, A13, A14: confirm the defaults. | as proposed |
| D-13 | Order of phases: UI work waits for REM-3, FIX-1/2, CAT-1, PRC-1, OPN-1 (BACKLOG §E). Do you want UI-A1/A2 (design system + shell) earlier, since they do not change screens' content? | Yes: UI-A1/A2 can start after REM-3 |

### 10.3 Bugs noticed while auditing (small, fix in the phase that touches the screen)
- Branch dashboard: stray "$" after the month-to-date subtitle ("… 12 فاتورة$").
- Company dashboard: Arabic labels of "Sales by category" are clipped on the left axis.
- Transfers list overflows sideways at 1366 px; the status/receive column is cut off.
- Terminology: the inventory filter says "Category / الفئة" while the menu says "Types / الأنواع" (CAT-0 naming).
- Cash (GM): the reconciliation shows "Select a branch" in a blue info box (looks like an error).
- Rate chip on a new database: "—/g" with no hint how to set it.
