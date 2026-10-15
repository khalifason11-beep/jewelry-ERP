# UI-B3: the Branches page and the sales list (plan only)

BACKLOG UI-B ("still open … UI-B3, the Branches page and the sales list with filter pills, on BE-7 server-side
pagination, next, before UI-C"); ANALYSIS §0.2 (the Figma sales list and branch table), §2.2, §4, R10–R16, §8;
D-ux-1, D-ux-15, D-ui-17…22. **Not implemented**: the owner's acceptance notes on the finished screens may change it.

Note: `docs/ux/mockups/` holds the four homes only; there is **no** sales-list or Branches mockup. This plan follows
ANALYSIS §0.2 (what the Figma screenshots showed) and the tokens and components of the built homes (question Q1).

## 1. What changes on screen

### 1.1 Sales list (`/sales`, General Manager and branch manager; the cashier keeps "My activity")

- **Period pills** above the table, one row: **Today · Yesterday · 7 days · 30 days · This month · All**, and a
  **Custom** pill that opens the two date fields (today's From/To inputs move into it). The active pill is the dark
  pill of the homes. Default **Today** for both managers (ANALYSIS §6: "default filter today for managers"; today
  the list opens on the last 7 days; Q2).
- **Up to four visible filters (R11):** period (the pills), **branch** (General Manager only; the branch manager is
  always on their branch), **status** (All · Completed · Voided), **search** (invoice, customer, cashier: BE-7 `q`).
  "More filters" holds **cashier** (BE-7 `cashierId`). Every active filter except the period shows as a removable
  chip, with "Clear all".
- **Columns (Figma: 9):** Invoice · Date and time · Branch (only "All branches") · Cashier · Customer · Items · Net
  weight · Total · Payment (with the bank reference) · Status; the General Manager also sees Cost and Gross profit
  (R12 numbers: grams with three decimals, money without decimals, the currency once in the header). Sorting on the
  BE-7 keys only: date, invoice, branch, cashier, total, gross profit (GM).
- **Footer totals** from BE-7 `totals` (completed sales of the whole filtered result, not the page), and the pager
  from BE-7 ("1–50 of 1,234", previous / next; page size fixed at 50).
- A voided sale stays in the list, dimmed, with its status; "Completed" excludes it (D-ui-19 definition).
- Row → sale detail (unchanged). Export CSV stays (BE-7: the whole filtered result).

### 1.2 Branches page (`/branches`, General Manager)

- **Branch strips** (Figma "branch table": white rounded rows on the grey panel, a colour dot per branch from the
  `tokens.md` palette, labelled by name: D-ui-20), replacing today's two-column cards. Per strip: name and city ·
  Sales of the period · Gross profit (GM) · Sales count · Stock (pieces and grams) · expected cash · warnings from the
  attention list for that branch (count, the highest severity as a word) · chevron to the branch view. Sources, all
  existing: `GET /dashboard/company` (per-branch revenue, gross profit, sales count, stock), `GET /cash/drawer` (every
  branch's expected cash), `GET /attention` (signals carry their branch). No new endpoint is planned.
- The **same period pills** as the sales list (Today default; today the page is fixed on month-to-date, Q3).
- A click on a strip opens the existing branch view (`/branches/:id`, the GM home's scope pill view, D-ui-20).
- The **branch register** (master data, edit, New branch) moves under a second tab "Branch details" on the same page,
  so the comparison is the first thing seen (§2.2: "How does each branch compare?"; primary action New branch).

## 2. States (UI-A2 contract)

| State | Sales list | Branches |
|---|---|---|
| Loading | skeleton rows under the toolbar; the pills and filters stay usable | four skeleton strips |
| Refreshing (filter change) | the previous rows stay with the thin bar | same |
| Empty | "No sales in this period." + "Choose another period" (§8); with a search: "No results for “…”" + Clear search; with filters: "No sales match these filters" + Clear filters | no branch: "No branches yet…" + New branch (unchanged); a branch with no sales shows **0**, never "—" |
| Error | the error in the table area with Try again; the toolbar stays | the error in place of the strips with Try again |
| No permission | the cashier opening `/sales` gets the existing no-access page (route guard) | the branch manager opening `/branches` gets the no-access page |
| Cost refused | a non-GM never sees cost columns or the gross-profit sort (BE-7 refuses it with 403) | gross profit shown to the GM only |

## 3. Text keys (English → Arabic; to be checked by the owner)

| Key | Arabic |
|---|---|
| Yesterday | أمس |
| 7 days | ٧ أيام |
| 30 days | ٣٠ يومًا |
| This month | هذا الشهر |
| All | الكل |
| Custom | مخصص |
| More filters | مرشحات أخرى |
| Clear all | مسح الكل |
| Remove filter: {name} | إزالة المرشح: {name} |
| No sales match these filters | لا مبيعات تطابق هذه المرشحات |
| Branch details | بيانات الفروع |
| Comparison | المقارنة |
| {n} warnings | {n} تنبيهات |

Existing keys are reused: Today, Completed, Voided, Status, Branch, Cashier, Search, "No sales in this period.",
"{from}–{to} of {total}", "Previous page", "Next page", "Export CSV". `npm run i18n:check` gates every new key.

## 4. The URL keeps the view

`/sales?period=today|yesterday|7d|30d|month|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&branchId=&status=&q=&cashierId=&sort=&dir=&page=`
and `/branches?period=…&tab=details`. Business days are the company's (D-cln2: the display zone from the company
setting; BE-7 test `business-day.test.ts` for the boundaries). A reload, the browser back button and a shared link
show the same view. `asOfId` (BE-7 snapshot) is **not** in the URL: a reloaded page starts a fresh snapshot. A filter
change resets `page` to 1. The period choice is not remembered between visits (the homes remember theirs, D-ui; Q2).

## 5. At 1366×768

The shell, the page title and one toolbar row (pills · branch · status · search · More filters · Export) leave about
560 px for the table: 13 rows of 40 px are visible, the header row sticky, the 50 rows of a page scroll inside the
panel, the pager below. The General Manager's 12 columns do not fit 1366 px with Arabic labels: the customer and net
weight columns move into a row expansion (Q4). The branch strips fit 8 branches without scrolling (64 px each).
Screens at 1366×768 and 1920×1080, English and Arabic, are part of the acceptance.

## 6. Not in scope

A payment-method filter (no backend filter yet: BE-7 kept R11's four), saved views, a server-side CSV file, the
cashier's POS layout (UI-C1, D-ui-22), the branch view itself (UI-B done), any change to report pages, page size
choice, and infinite scroll.

## 7. Test plan

- Backend: nothing new is expected (BE-7 has the filters, sort, totals and scope); a period-to-range function in
  `shared` (Today, Yesterday, 7 days, 30 days, This month, All) with property tests at the month and year boundaries
  in the company zone.
- `scripts/e2e-states.mjs`: loading, refresh, empty per filter, error and no-access for both pages, axe on each.
- A new e2e (`scripts/e2e-lists.mjs`): the URL survives a reload and the back button; a filter change returns to page
  1; the pager on a world of 120 sales; the voided-sale dimming; the GM sorts by gross profit, the branch manager has
  no such column and the API refuses the sort.
- REH-1: the sales list opens on Today for both managers with the right count; the Branches strips show 0 for a new
  branch.
- Screenshots (`docs/ux/screens/`, WebP) at 1366×768 and 1920×1080 in both languages, compared with ANALYSIS §0.2.
- Gates: `npm run verify -- --full`.

## 8. Questions for the owner

1. **Mockups:** there is no sales-list or Branches mockup in `docs/ux/mockups/`. Build from ANALYSIS §0.2 and the home
   components, or wait for (or let me draw) two static mockups first for a 5-second check?
2. **Default period of the sales list:** Today for both managers (ANALYSIS §6), or keep 7 days? Remember the last
   choice per user like the homes?
3. **Branches page period:** Today like the homes, or keep month-to-date?
4. **The GM's 12 columns at 1366 px:** which two move into the row expansion (proposal: customer and net weight)?
5. **Branch register:** a second tab on the Branches page (proposal), or a separate Settings › Branches page?
6. **Payment-method filter** in "More filters": wanted now (a small BE change), or later?
