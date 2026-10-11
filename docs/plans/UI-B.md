# Plan: UI-B (role homes, the attention list, the shell's notices, the GM's branch view, dashboard numbers)

Status: **PLAN, awaiting the owner's approval. No code has been written.**
Branch: `claude/hopeful-sagan-lehxyp`, based on `121bb9a` (POS-FIXES done and approved).

Sources, by rank:
1. the owner-approved mockups `docs/ux/mockups/gm-home.html`, `bm-home.html`, `cashier-home.html`, `empty-gm-home.html`
   and `docs/design-reference/tokens.md`;
2. `docs/ux/ANALYSIS.md` (§1–§4 homes and attention, §5 rules R1–R16, §8 empty states) and decisions D-ux-0…16;
3. `docs/ux/BRIEF.md` (hierarchy, density, role focus; SPEC overrides it).

Also binding: `docs/SPEC.md` §11 and §18; BACKLOG BE-1 and UI-B; decisions D-ui-1…16 (shell, states, notices), D-lock-1
(the security-lock notice) and D-ui-5 (the GM branch switcher was left to UI-B).

---

## 0. Summary

| # | Item | Schema change? | Content or decision still missing? |
|---|---|---|---|
| 1 | **BE-1 `/api/attention`**: minimum set A1, A2, A4, A5, A6, A9, A10, A11, A12, A15, A16 | **None** (two new settings: registry rows, no migration) | Two thresholds (Q6, Q7); everything else is defined |
| 2 | **Dashboard numbers**: one definition per figure, tests that tie them to the ledger and the sales, no per-row queries | **None required.** Recommended: **one additive, index-only migration (0020)**, decided by measurement (Q12) | One figure definition (Q10, gold in transit) |
| 3 | **Shell**: the attention control replaces the bell; the minor notices move into the attention list | None | — |
| 4 | **GM home** (and its empty versions) | None | Level-2 chart (Q9) |
| 5 | **BM home** (and its empty version); the GM's view of one branch | None | Voids in the mockup (Q8, A13 is deferred) |
| 6 | **GM branch switcher** | None | Decision Q3 |
| 7 | **Cashier home** (the POS) | None | Scope decision Q4 (the POS layout is UI-C1) |

**Not in this plan, moved out** (listed in §11): the Branches page, the sales list and server-side pagination (the rest of
BACKLOG UI-B, with BE-7), and the deferred signals A3, A7, A8, A13, A14 and A17.

---

## 1. BE-1: the attention list (`GET /api/attention`)

### 1.1 Current behaviour

- **The bell**, `components/layout/TopBar.tsx` `Notifications`, polls `GET /api/notifications` every 30 s
  (`modules/notifications/service.ts`). It knows two things:
  - transfers in transit: incoming ones for a branch manager, all of them for the GM; at most 5;
  - failed sign-ins in 24 h: for `audit.view`, the own branch for a manager.
- **The GM home** (`pages/dashboard/CompanyDashboardPage.tsx`, `GET /dashboard/company`) has a "Needs attention" card
  with two figures: transfers in transit, and users signed in now.
- **The shell notice area** (`components/layout/Notices.tsx`, D-ui-13, D-lock-1) shows, in this order:
  security-locked accounts, the new-sign-in alert, second factor off, backups, touch-only keys, only one passkey.
- **Data that already exists but nothing reads:**
  - `transfers.pendingClaimStaleHours` (24 h);
  - the cash-count difference (only per branch and day, on Cash);
  - `purchases.gold_owed_mg_pure24` per supplier;
  - `sign_in_events.new_device` company-wide;
  - `users.locked_until` and `users.mfa_locked_until`;
  - the movement-versus-status check (branch dashboard only);
  - the rate tables (only the header chip uses them).

### 1.2 Proposed behaviour

One endpoint returns a list of **signals**, computed live (no table, no cache). Each signal:

```
{ id: 'A4:3', code: 'A4', severity: 'critical' | 'warning' | 'info', branchId: 3 | null, count: 1,
  key: 'Cash count difference', params: { branch: …, amount: …, day: … }, link: '/cash?branchId=3&day=…' }
```

- **Text:** a translation key plus SAFE params (the same rule as audit descriptions: no free text from the server).
- **Order:** by severity, then by age (oldest first), then by branch.
- **Empty list:** the page shows "No urgent actions." / «لا توجد إجراءات عاجلة.».

**Signals in the minimum set: rules and who sees them**

| Code | Signal | Rule | Severity | GM | Branch manager | Link |
|---|---|---|---|---|---|---|
| A1 | Transfer in transit | IN_TRANSIT transfers. GM: all, one line per destination branch with a count. BM: **incoming** only | info | ✓ all | ✓ incoming to own branch | `/transfers` |
| A2 | Transfer stale | IN_TRANSIT longer than `transfers.pendingClaimStaleHours` (24 h, exists) | warning (replaces A1 for that transfer) | ✓ | ✓ if own branch sends **or** receives it | `/transfers` |
| A4 | Cash-count difference | The **latest** count of the last business day that has one (today or earlier, at most 7 days back) differs from that day's expected cash by more than `cash.countDifferenceTolerance` (**new, default 0**) | warning (critical: Q6) | ✓ all | ✓ own | `/cash?branchId=&day=` |
| A5 | No cash count | Yesterday (company time zone) had at least one CASH ledger entry for the branch, and no count exists for that business day. A day without cash movements, such as a closed Friday, never raises it | warning | ✓ | ✓ own | `/cash?branchId=&day=` |
| A6 | Supplier gold owed, ageing | Per **supplier**: open orders (`gold_owed_mg_pure24 > 0`). The line shows grams of 24K and the age of the oldest; older than `purchases.supplierDebtMaxAgeDays` (**new, default 30**, D-ux-12) means warning, younger means info. **Weights only, never money** (D-4-16) | warning / info | ✓ all branches | ✓ own branch's orders | the oldest open order `/purchases/:id` (there is no Suppliers page yet: UI-C3) |
| A9 | Backup health | As `/backups/status` today: BACKUP_NEVER/STALE, VERIFY_NEVER/STALE; the existing settings. In demo mode only after a first backup (D-2c-6) | warning | ✓ (`backups.view`) | — | `/settings#backups` (section anchors are added in commit 1) |
| A10 | New-device sign-ins (company) | `sign_in_events.new_device` in the last 7 days. A manager account means warning; others info | warning / info | ✓ | — (each person keeps their own "Was this you?" alert, D-2fa) | `/sessions` |
| A11 | Failed sign-ins | `LOGIN_FAILED` audit rows in 24 h. At least 1 means info; at least `security.lockoutThreshold` means warning | info / warning | ✓ all | ✓ own branch (as today's bell, Q11) | `/audit?action=LOGIN_FAILED` |
| A12 | Locked accounts | `locked_until > now()` or `mfa_locked_until > now()`. **Security-locked** accounts are not listed again: they stay in the shell's lock notice (D-lock-1) | warning | ✓ all | ✓ own branch's staff | `/users` |
| A15 | Stock does not reconcile | For each branch, the inventory movements' closing balance now differs from the count of AVAILABLE pieces or their weight (the check already on the branch dashboard) | critical | ✓ all | ✓ own | `/reports/inventory-movement?branchId=` |
| A16 | No gold or scrap rate | No 21K selling rate, or a sellable karat has no scrap rate | critical | ✓ | — (cannot set rates; the rate chip already says "No rate set yet") | `/settings#rates` |

**Personal and system notices that join the list** (see §3; this extends BE-1, Q2):

| Code | Signal | Severity | Who |
|---|---|---|---|
| S1 | Only one passkey (today `second-passkey-nag`) | info | the person themself |
| S2 | Touch-only security keys accepted (today `uv-preferred-banner`) | warning | GM |

### 1.3 API, permissions, route matrix

- **New route** `r('GET', '/attention', 'branch', { any: ['dashboard.company', 'dashboard.branch'] })` with an
  optional `?branchId=`:
  - the GM: all branches, or one branch (used by the GM's branch view);
  - a branch manager: their own branch; another branch gets 403;
  - a cashier: 403 (no attention control in the cashier's shell; D-ux-14 "cashier: none").
- **Generated matrix tests** (`phase1b.test.ts` SAMPLE and CROSS rows): allow (GM, BM), deny (cashier 403),
  cross-branch (BM with `branchId` of another branch, 403).
- **Field classification:**
  - the response keys (`signals`, `code`, `severity`, `count`, `key`, `params`, `link`) are SAFE;
  - `params` is an **opaque container searched for COST names** (like `metadata`);
  - plus an explicit allow-list of param names per signal, tested.
- **New settings** (registry, defaults in code, no migration; Settings › Business rules; GM only, saved with the
  password, audited):
  - `cash.countDifferenceTolerance`, money, default **0**;
  - `purchases.supplierDebtMaxAgeDays`, days, default **30**.
- **No permission change.** Cost: no signal carries a cost, profit or money owed to suppliers. A4 carries a cash
  difference, which the branch manager already sees on Cash (`cash.view`).

### 1.4 Performance

- Every signal is **one grouped query** over all branches in scope; there are no per-branch or per-row queries.
- A test counts SQL statements per request, with 4 branches and with 8 branches: the count must be equal (about 11).
- Polling: 60 s on the home and in the top bar (today's bell polls every 30 s).

### 1.5 Tests

Backend, `attention.test.ts`, both projects:

- **Each signal raises and clears.** A1/A2 by creating, then receiving a transfer, and moving the clock past the stale
  hours; A4 by a count with a difference and then a corrected recount; A5 by a day with cash and no count; A6 by an
  order with gold owed and a settlement; A9 through backup runs; A10 through a new-device sign-in; A11 through failed
  sign-ins; A12 through a lockout and an unlock; A15 through an inconsistent movement row inserted directly; A16 on a
  database without rates.
- **The visibility matrix:**
  - GM: all;
  - branch manager: own branch only, incoming A1 only, A2 for both ends, never A9, A10, A16 or S2;
  - cashier: 403;
  - branch manager with another `branchId`: 403.
- **Thresholds come from the settings:** raising the tolerance clears A4; changing the debt age moves A6 between
  warning and info.
- **No COST field** for a branch manager, at any depth (the registry walk), plus the per-signal param allow-list.
- **Constant statement count** with 4 and 8 branches; A5 respects the company time zone at midnight.

---

## 2. The dashboard numbers: sources, reconciliation, performance

### 2.1 Current behaviour

`modules/dashboard/service.ts` and `modules/reports/metrics.ts`:

- **Sales and profit** come from `sales` (`status = 'COMPLETED'`, `created_at` in the period).
- **Item count and sold weight** use a subquery per sale on `sale_items`, which has **no index on `sale_id`**.
- **The cashier table** uses six correlated subqueries per user.
- **The company dashboard also builds blocks that leave level 1–2:**
  - daily trend per branch;
  - stock by karat;
  - sales by category;
  - users signed in.
- **Its default period is month-to-date**, against D-ux-2 (Today, remembered).
- **The branch dashboard returns blocks the new home drops for a branch manager:** purchases KPI, profit KPI (always
  "—" for them), hourly sales, the 9-line movement equation.
- **Gold held** = AVAILABLE pieces + the broken-scrap pool (`modules/stock/weight.ts`, D-4-3). Pieces **in transit**
  belong to no branch and are **left out of the company total**.

### 2.2 Proposed figures, each with one definition and a test that ties it down

**GM home (all branches, or one branch through the switcher)**

| Figure | Definition | Ties to (test) |
|---|---|---|
| Sales (dark card) + invoices | Σ `sales.total` and count, `status = COMPLETED`, created in the period (the Sales list and Sales report definition) | (a) = Sales report total and Σ of the Sales list for the same filters; (b) **ledger identity** per branch and day: Σ ledger `SALE` entries on day D = dashboard sales of D + Σ totals of the sales created on D and voided since; Σ ledger `SALE_VOID` on D = Σ totals of sales voided on D (Q1) |
| Gross profit + margin | Σ (`total − cost_total`) of the same sales; margin = profit ÷ sales | = Σ `sale_items.final_price − acquisition_cost` of those sales; = Profit report |
| Gold held (g) + of which scrap | AVAILABLE pieces' net weight + the broken-scrap pool, all branches; **plus pieces in transit as a sub-line in the company total** (Q10) | = Inventory report stock weight; Σ branch strips + in transit = company total |
| Stock value at cost + pieces + grams | Σ `acquisition_cost`, count and weight of AVAILABLE pieces | = Inventory report valuation; Σ branches = total |
| Branch strip: sales, profit, gold (g), available pieces, attention dot | the same definitions per branch; the dot = this branch has any warning or critical signal | Σ strips = the company figures; the dot = `/attention` |
| Level 2 "Gold position" | gold held, 24K equivalent, pieces and scrap split, **gold owed to suppliers (24K g)** = Σ `gold_owed_mg_pure24 > 0` | = supplier purchases' open debt |

**BM home (one branch, one business day)**

| Figure | Definition | Ties to |
|---|---|---|
| Sales today + invoices + pieces | as above for the branch and the day | as above; Σ of the team table = the branch figure (grouped by `cashier_id` from `sales`, so a deactivated seller still counts) |
| Expected cash in the drawer | the ledger CASH balance now (as Cash) + the latest count ("Last count: yesterday, matches / short 35,000") | = `/cash/drawer` expectedCash = opening + reconciliation lines (SPEC §18.10) |
| Available stock (g) + pieces + scrap (g) | AVAILABLE pieces and the branch's scrap pool | = Inventory list and the scrap pool |
| Gold owed to suppliers (24K g) + order count | the branch's open supplier orders, **weights only** | = Supplier purchases |
| Team today | per seller: invoices, sales, **voids**, signed in (an ACTIVE session) | Σ = branch sales |
| Level 2: last 14 days | sales per day, line; month-to-date sum | = Sales report by day |
| Level 2: stock today | in (purchases, transfers in, restock) / out (sales, transfers out, damage, returns), now, "✓ matches" | = the movement equation; the mismatch is A15 |

### 2.3 Performance on a real database

- **Grouped queries only:**
  - `branchMetrics` items and weight become a join with `sale_items` grouped by sale branch (no per-sale subquery);
  - the team table becomes one query grouped by `cashier_id` (sales, voids) plus one for live sessions;
  - the blocks the homes no longer show are removed from the home endpoints. They stay in the reports.
- **Statement-count test:** the same number of SQL statements with 4 and with 8 branches, and with 1 and with 30 sellers.
- **Measured, not guessed: a new `scripts/perf-homes.mjs`** (not in the regular suite; run as a phase gate):
  - fills a PostgreSQL database with a scaled fixture world: 8 branches, 2 years, about 60,000 sales, 90,000 pieces,
    400,000 movements, 250,000 ledger entries;
  - times `/dashboard/company` (today, 30 days), `/dashboard/branch` and `/attention` (20 runs each, p50/p95);
  - prints `EXPLAIN (ANALYZE, BUFFERS)`;
  - fails above a **budget of 300 ms p95**.
- **Indexes (Q12):** these are the ones the plans will most likely need. Each is added only if the measurement shows
  the need, in **one additive migration 0020, indexes only**:
  - `sale_items (sale_id)`: a foreign key without an index, also used by the sale detail and printing;
  - `sales (created_at)`: company-wide ranges cannot use `(branch_id, created_at)` well;
  - `sales (cashier_id, created_at)`;
  - `purchases (branch_id, created_at)`;
  - a partial index on `transfers (to_branch_id) WHERE status = 'IN_TRANSIT'`;
  - a partial index on `purchases (supplier_id) WHERE gold_owed_mg_pure24 > 0`.

  `check:migrations` and `check:drizzle` pass; no data changes.

### 2.4 API changes (same routes, same permissions)

**`GET /dashboard/company`**
- Default period **today** (the page remembers the choice, D-ux-2).
- Returns:
  - totals: sales, invoices, profit, margin, gold held, scrap, in transit, stock value, pieces, grams, gold owed;
  - per-branch strips;
  - level 2: sales by branch for the period (or the trend line, Q9).
- **Removed** from this response (they live in the reports): the daily trend per branch, stock by karat, sales by
  category, users signed in, `attention` (now `/attention`).

**`GET /dashboard/branch`**
- Adds: `expectedCash`, `lastCount { day, difference }`, `goldOwed { pureMg24, orders }`, a grouped `team`, and
  `stockToday` (in, out, now, reconciles).
- Removes: the purchases KPI and `hourly` for the home.
- Profit only with `profit.view` (the GM's branch view), as today.

Every new field is classified SAFE, except profit and stock value at cost, which are COST and already redacted by the
existing rules. `cost-visibility.test.ts` walks every GET route for every role, so it covers both changes automatically.

### 2.5 Tests

- **`home-numbers.test.ts`, both projects, every branch and every day of the fixture world:**
  - all the ties in §2.2;
  - the ledger identity for sales and voids;
  - Σ strips = totals;
  - team = branch sales;
  - expected cash = drawer = the reconciliation (SPEC §18.10);
  - gold held = the inventory report (+ in transit);
  - the statement count.
- `ledger.test.ts` §18.10 stays as it is.

---

## 3. The shell: the bell, the attention control, where the minor notices live

### 3.1 Current behaviour

- The top bar has a **bell** (`notifications`, kept "until UI-B", D-ui-6).
- The notice area above every page holds **six kinds of notice** (D-ui-13, D-lock-1): two lines, then "+ N more".
- On the GM home, the backup and one-passkey notices push level 1 down by about 40–80 px (UI-A2 acceptance, known).
- The mockups have **no bell**.
- `empty-gm-home.html` shows the backup and one-passkey notices **inside the attention list**.

### 3.2 Proposed behaviour (Q2)

**What stays above the page, on every screen** (the shell notice area, D-ui-13 rules unchanged), only what must
interrupt:
1. the security-locked accounts (lock, managers);
2. the new-sign-in "Was this you?" alert (lock, the person);
3. the second factor off for the GM (critical).

Normally none of them is present, so **the home starts at its title**.

**What moves into the attention list** (home and top-bar control):
- backups (A9);
- touch-only keys (S2);
- only one passkey (S1).

Each still links to the screen that fixes it; nothing is dismissible while its cause remains (same rule as D-ui-13).

**The bell becomes the attention control** (`attention-button`, the same place in the top bar):
- **Badge:** the count of warning and critical items, coloured by the highest severity.
- **Popover:** up to 5 lines, then "Open the list on my home".
- **On the home itself:** the control only shows the count (the list is on the page).
- **Cashier:** no control (403, D-ux-14).

**Removed:**
- `GET /notifications` and its module: the matrix row is deleted and the deny tests follow;
- the bell's text keys.

Its two signals are A1 and A11.

### 3.3 Tests

- **e2e-states:**
  - with the backup, uv and one-passkey causes forced (the `/auth/me` and `/backups/status` rewrite already in the
    script), they appear **in the attention list and not above the page**;
  - lock and critical notices still appear above the page and first;
  - the attention control's popover;
  - an error from `/attention` shows an error state in the panel while the rest of the home still renders;
  - axe on each.
- **REH-1:** the shell check no longer opens the bell. It opens the attention control for the branch manager and
  keeps the "no cost word or figure in the shell" check (D-ui-6) on the popover.
- **The UI-A2 notice tests change with this commit:**
  - e2e-states "+ 4 more notices" becomes the new split;
  - the order check keeps lock, new sign-in, then critical.

---

## 4. GM home (`/overview`) and its empty versions

### 4.1 Current behaviour

`CompanyDashboardPage.tsx`:
- **Stack:** first steps (until complete) → 4 equal KPI cards (sales, cost of sales, profit, inventory value) → branch
  table → daily trend (stacked bars) → "Needs attention" (2 figures) → sales by category → stock by karat → stock
  weight card.
- **Default period:** month-to-date.
- **Height:** about 2.7 screens (ANALYSIS §1.1).

### 4.2 Proposed behaviour (as `gm-home.html`)

**Header**
- "Home", date, scope ("All branches" or the branch: Q3).
- Period pills: Today, 7 days, This month, 30 days, Custom. Default **Today**, remembered per user (localStorage,
  D-ux-2).

**Level 1** (fits 1366×768 in Arabic and English, R14; checked in REH-1 and the capture)
- **Sales** as its own dark card (D-ux-1).
- One light surface with three figures:
  - gross profit (margin);
  - gold held (of which scrap, and in transit if Q10);
  - stock value at cost (pieces · grams) (D-ux-4).
- Side by side:
  - **Needs attention**: up to 5 lines + "Show all" (expands in place), or "No urgent actions.";
  - **Branches**: strips with colour swatch, name, available pieces, sales, profit, gold (g), attention dot and a link
    into the branch.

**Level 2**
- Sales by branch, labelled bars in the D-ux-5 palette (or a trend line, Q9).
- **Gold position:** total, 24K equivalent, pieces versus scrap bar, gold owed to suppliers.

**Removed from the home** (still in reports): cost of sales, daily trend per branch, sales by category, stock by karat,
users signed in (→ Active users).

### 4.3 Empty versions (ANALYSIS §8, `empty-gm-home.html`)

- **First steps not complete (no branch or no staff):** the home is the first-steps panel plus the attention list
  (backup, one passkey) and nothing else.
  - The first-steps panel is restyled, `first-steps` kept.
  - It has **four** steps, not the mockup's three: REM-3 added "Confirm the karats you sell". The data decides; the
    mockup is older.
- **Branches but no sales in the period:** the figures show **0** (never "—"), with "No sales yet in this period";
  the attention list shows "No urgent actions." or its signals; the strips show zeros.

### 4.4 Tests

- **e2e-states:** skeletons per block while data loads; an error in one block leaves the others; the period
  remembered across a reload; the empty versions; axe.
- **REH-1:**
  - on the empty production database: first steps and attention only, no figures of "—";
  - after the first steps: zeros and "No sales yet";
  - after the rehearsal's sales and transfers:
    - the dark card equals the API;
    - A1 appears and leaves on receipt;
    - A4 appears after a count with a difference, and a corrected count clears it;
  - **level 1 measured**: the bottom of the strips is within the 768 px window, in Arabic and English.
- **Capture:** the homes at 3 sizes in both languages; the empty-production homes.

---

## 5. BM home (`/dashboard`), the GM's view of one branch, empty version

### 5.1 Current behaviour

`BranchDashboardPage.tsx`:
- 4 KPI cards: sales, purchases, **profit "—" for the BM**, available;
- stock weight by karat; 14-day line; cashier activity (7 columns); the 9-line movement equation.
- **Embedded** for the GM in `/branches/:id` (overview tab, `BranchPages.tsx`).

### 5.2 Proposed behaviour (as `bm-home.html`)

**Header:** "<branch> · Today", date, pills "Today | Another day…" (the existing date choice).

**Level 1**
- **Sales today** (invoices, pieces) as the dark card.
- One surface:
  - **expected cash in the drawer**, with the last count's result;
  - **available stock** (g; pieces; scrap g);
  - **gold owed to suppliers** (24K g; orders).
- Side by side: **Needs attention** (own branch) and **Team today** (seller, invoices, sales, voids, signed in).

**Level 2:** 14-day line with month-to-date; **stock today** (in, out, now, ✓ matches).

**No cost or profit anywhere for the branch manager:** the server omits it; REH-1 checks the page in both languages.

**The GM's view of a branch** (`/branches/:id`, and the switcher if Q3) uses the same layout, plus gross profit and
stock value at cost in the surface. The GM sees them; the server already sends them only with `profit.view`.

**Empty version (no stock):** the existing "Your branch has no stock yet" with New purchase and Buy scrap
(`no-stock-yet` kept), plus the attention list.

### 5.3 Tests

- **e2e-states:** blocks and states as for the GM.
- **REH-1:**
  - the branch manager's home after the rehearsal sale;
  - expected cash = Cash;
  - gold owed = the supplier order;
  - incoming transfer A1 for the receiving branch's manager;
  - no cost or profit word or figure;
  - level 1 within 768 px.
- **Backend:** the branch figures' ties in §2.5.

---

## 6. The GM branch switcher (deferred from UI-A1, D-ui-5)

### 6.1 Current behaviour

- No switcher in the shell (owner answer to UI-A1 Q1).
- Each screen has its own branch filter: Sales, Inventory, Cash, Purchases, Reports.
- The GM home links branches to `/branches/:id`.

### 6.2 Options

| Option | What it does | Pro | Contra |
|---|---|---|---|
| A. Global switcher in the top bar | One choice scopes every screen | One place | Hidden state: a GM looking at "Sales" may not notice the scope; every screen needs it; it contradicts the owner's UI-A1 answer |
| **B. Scope pill on the GM home only** (recommended) | "All branches ▾" in the home's header switches the home between the company view and **one branch's view** (the §5 layout with profit); a branch strip opens the same; the URL holds it (`/overview?branchId=3`), so back and refresh work | Answers the owner's "required" switcher where the GM looks; no hidden global state; the other screens keep their filters | One more control on the home |
| C. None | Strips → `/branches/:id` | Nothing to build | The owner asked for a switcher |

- **Recommendation: B.**
- Other screens: when opened from a branch's view (a strip, an attention line), they receive `?branchId=` and preselect
  it in their own filter. That is the only coupling.

---

## 7. Cashier home (the POS)

### 7.1 Current behaviour

`/pos`, `pages/pos/PosPage.tsx`, already level 1 only. It now carries FIX-1/FIX-2/SEC-2. Empty states: UI-A2.

### 7.2 What UI-B would change (Q4)

The **POS layout** of `cashier-home.html` (type chips, cart panel order, payment buttons, "Hold / Clear" row) is
BACKLOG **UI-C1**, with a rule that the owner reviews a screenshot first.

**Recommendation:** UI-B touches the cashier home only through the shell:
- no attention control;
- the rate chip's "No rate set yet";
- the attention-free top bar.

The POS layout stays in UI-C1, with its screenshot review.

---

## 8. Disagreements between the mockups, ANALYSIS, BRIEF and the backlog

| # | Where | Disagreement | Proposal |
|---|---|---|---|
| X1 | BRIEF §5 "Business health" | lists Expenses and "Number of branches"; the mockups show neither | Expenses are removed (REM-1). The branch count is implicit in the strips. Follow the mockup |
| X2 | BRIEF §5C | asks for a **sales trend and a profit trend**; the GM mockup's level 2 is sales **by branch** (comparison), and ANALYSIS puts the trend in the sales report | Q9 |
| X3 | `gm-home.html` | level 2 "sales by branch" repeats the strips' sales column | Q9 (a trend line instead removes the repetition) |
| X4 | `bm-home.html` | an attention line "two voids today, threshold 2 per day" and a warning colour in the team table: that is **A13**, deferred by D-ux-14, with no setting | Q8 |
| X5 | `empty-gm-home.html` | **3** first steps; REM-3 made it **4** (karats) | Keep 4 (the data decides) |
| X6 | `empty-gm-home.html` | backup and one passkey **in the attention list**; D-ui-13 put them **above the page** | Q2 (follow the mockup) |
| X7 | mockups | **no bell**; D-ui-6 kept the bell "until UI-B" | Replace it with the attention control (§3); Q5 if the owner wants none |
| X8 | ANALYSIS A11 | "GM" only; today's bell also shows a branch manager their branch's failed sign-ins | Q11 |
| X9 | BACKLOG UI-B | also "Branches page and sales list with filter pills and server-side pagination (BE-7)"; this request covers the homes | Move out to a separate plan with BE-7 (§11), Q13 |
| X10 | ANALYSIS §2.1 GM | "which branch is behind or unusual" suggests sorting the strips; the mockup sorts by sales | Sort by sales in the period, descending; branches with a critical signal first |
| X11 | Company dashboard code | default period month-to-date | D-ux-2 says Today, remembered: fixed in commit 4 |
| X12 | ANALYSIS A16 | "warning if older than N days"; N is not given | Q7 |

---

## 9. Commit sequence

Suite green after each commit; push after each.

| # | Commit | Extra checks |
|---|---|---|
| 1 | **BE-1:** `/api/attention` (A1, A2, A4, A5, A6, A9, A10, A11, A12, A15, A16; S1, S2 if Q2), the two settings and their Settings fields, route matrix, classification, `attention.test.ts` | matrix and cost-visibility tests |
| 2 | **Home numbers (backend):** reshaped `/dashboard/company` and `/dashboard/branch`, grouped queries, `home-numbers.test.ts` and the statement-count test, `scripts/perf-homes.mjs`; [+ migration 0020 indexes if Q12 yes] | perf script, `check:migrations`, `check:drizzle` |
| 3 | **Shell:** attention control replaces the bell; notices split (§3); `/notifications` removed | e2e-states, REH-1 shell check |
| 4 | **GM home** + empty versions + branch scope (Q3) | e2e-states, REH-1, level-1 fit |
| 5 | **BM home** + the GM's branch view + empty version | e2e-states, REH-1 |
| 6 | **Docs and evidence:** decisions D-ui-17…22, `docs/acceptance/UI-B.md`, BACKLOG (BE-1 done, UI-B homes done, the rest listed), SPEC §11 note, the slim WebP screens (homes at 3 sizes, both languages; empty-production homes); `check:assets` | all gates |

---

## 10. Docs

**`docs/decisions.md` §20:**
- D-ui-17: the attention model (signals, severities, rules, visibility matrix, settings);
- D-ui-18: the shell (attention control replaces the bell; what stays above the page);
- D-ui-19: the home figures' definitions and their ties to the ledger and the sales;
- D-ui-20: the GM's branch scope;
- D-ui-21: the performance budget and the indexes;
- D-ui-22: the cashier home's scope.

**`docs/acceptance/UI-B.md`:** engineering's runs (gates, perf numbers) and a Codespace checklist:
- GM: Today default and remembered, attention list, a strip into a branch;
- BM: incoming transfer, cash-count difference, no cost words;
- the cashier's shell;
- the empty-database first steps.

---

## 11. Moved out of UI-B (need content, decisions or their own plan)

| Item | Why | Where |
|---|---|---|
| Branches page, sales list, filter pills, **server-side pagination** | BACKLOG UI-B3 depends on BE-7 (P1), which is a backend change across six lists | its own plan, "UI-B3 + BE-7", next (Q13) |
| POS layout (`cashier-home.html`) | UI-C1, with the owner's screenshot review | UI-C1 (Q4) |
| A3 transfer item dispute | needs a new feature | BE-10, deferred |
| A7 Hasad receivable ageing | depends on Q-7 | BE-5, deferred |
| A8 scrap override purchases | report only (D-ux-9) | RPT-1 |
| A13 voids and A14 reprints thresholds | deferred by D-ux-14, no settings | BE-8 (Q8) |
| A17 unusual sales decline | not now | — |
| A4 "critical" second threshold | not defined | Q6 |
| A16 rate staleness | N days not defined | Q7 |
| USD chip | Q-10 | — |
| Suppliers page (the A6 link target) | UI-C3 | A6 links to the oldest open order until then |

---

## 12. Risks

- **Level 1 at 1366×768 in Arabic.** Long branch names and five attention lines could overflow. Mitigations:
  - one line per item, ellipsis with the full text on hover;
  - "Show all" expands in place;
  - REH-1 measures the fit in both languages.
- **Attention cost on every poll.** About 11 grouped queries per minute per open home. Mitigations: the perf script's
  budget, and the statement-count test.
- **A5 false alarms** on closed days or around midnight. Mitigations: the rule needs cash movements yesterday and uses
  the company time zone; tested at midnight.
- **Moving notices out of the shell.** A warning becomes less visible on non-home pages. Mitigations: the top-bar
  attention badge, coloured by severity, on every page; lock and critical notices stay above the page.
- **Changed figures.** The GM home stops showing cost of sales and the per-category chart. The reports still have
  them; the acceptance doc says where each moved.
- **Removing `/notifications`.** Any open old tab gets a 404 on its next poll. The bell code goes in the same commit;
  the old tab shows nothing.
- **Indexes on a large table.** `CREATE INDEX` on `sale_items` locks writes briefly. Before the pilot the tables are
  small; DEPLOYMENT notes it.

---

## 13. Questions for the owner (recommendation after each)

| # | Question | Recommendation |
|---|---|---|
| Q1 | **Sales on the homes:** the sales made in the period that are still valid (today's definition, the same as the Sales list and reports), with a test that ties it to the ledger's sales and voids? Or the ledger's net of the day (sales minus refunds made that day, which can be negative)? | **Still-valid sales**, tied to the ledger by the identity test (§2.2) |
| Q2 | **Minor notices:** move backups, touch-only keys and one passkey from above the page into the attention list (as `empty-gm-home.html`), keeping only the security lock, the new-sign-in alert and "second factor off" above the page? | **Yes** |
| Q3 | **GM branch switcher:** A global top-bar switcher, **B a scope pill on the GM home only** (company or one branch, kept in the URL; other screens receive the branch when opened from it), or C none? | **B** |
| Q4 | **Cashier home:** shell only in UI-B (no attention control) and the POS layout in UI-C1 with your screenshot review? | **Yes** |
| Q5 | **The bell:** replace it with the attention control (count + popover) for GM and BM, or remove it and rely on the home only (the mockups show no bell)? | **Replace** (managers work on other screens too) |
| Q6 | **A4 cash difference:** warning only, or also "critical" above a second amount (a new setting, no default proposed: you set it)? | **Warning only** for now |
| Q7 | **A16 rates:** critical only when a rate is missing, or also warn when the latest rate is older than N days (a new setting)? | **Missing only**; staleness when PRC-1 defines daily rates |
| Q8 | **Voids on the BM home:** the mockup shows a voids attention line and a warning colour (A13, deferred). Show the voids count in the team table **without** colour or an attention line until A13 is approved? | **Yes** |
| Q9 | **GM level 2:** the mockup's sales-by-branch bars (they repeat the strips' sales) or a **14-day company sales line** (the trend BRIEF §5C asks for)? | **14-day line**; the branch comparison is the strips |
| Q10 | **Gold held (company):** include pieces in transit as a sub-line ("of which in transit … g") so the company total matches what it owns? | **Yes** (company total only; branches show their own stock) |
| Q11 | **Failed sign-ins (A11) for a branch manager:** keep showing their branch's failed sign-ins (as the bell does today), or GM only (ANALYSIS)? | **Keep for the BM** (own branch only) |
| Q12 | **Indexes:** allow one additive, index-only migration (0020), limited to the indexes the perf script proves necessary? | **Yes** |
| Q13 | **The rest of BACKLOG UI-B** (Branches page, sales list, server-side pagination BE-7): a separate plan after this one? | **Yes**, next, before UI-C |
| Q14 | **Thresholds:** `cash.countDifferenceTolerance` default **0** and `purchases.supplierDebtMaxAgeDays` default **30**, as D-ux-12 already says; both editable by the GM? | **Yes** (already decided; listed to confirm no change) |
