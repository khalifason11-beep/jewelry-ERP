# RPT-2: reports never silently drop rows (plan)

Found in BE-7 (BACKLOG §G, D-be7-5): three reports read at most 1,000 rows and add up their totals from those rows,
so a long period gives missing rows **and** wrong totals, with no warning. Hardening only: no business rule, setting or
money rule changes; the only screen change is the truncation warning.

## 1. Audit: every capped read (backend/src, `grep -n "\.limit(\|limit:"`; line numbers at the start of RPT-2)

| # | File:line | Cap | What reads it | Feeds | Silent truncation? | RPT-2 |
|---|---|---|---|---|---|---|
| 1 | `sales/service.ts:286` (`listSales`) | 1,000 | Sales **report** | rows, totals, summary by channel, CSV | **yes** (rows, totals, channels) | totals + channels in SQL; rows (b)+(a) |
| 2 | `purchases/service.ts:277` (`listPurchases`) | 1,000 | Purchases **report** | rows, totals, CSV | **yes** | totals in SQL; rows (b)+(a) |
| 3 | `reports/service.ts:151` → `inventory/service.ts:95` (`searchItems`) | 1,000 | Inventory **report** | rows, totals, CSV (the summary is SQL already) | **yes** | totals in SQL; rows (b)+(a) |
| 4 | `reports/service.ts:273` | 2,000 | Inventory **ledger** report | rows, CSV (no totals) | **yes** (rows) | rows (b)+(a) |
| 5 | `reports/service.ts:500` (`listAudit`) | 1,500 (max 5,000) | Audit **report** | rows, CSV (no totals) | **yes** (rows) | rows (b)+(a) |
| 6 | `ledger/service.ts:506` | 200 | Cash › Hasad transfers list | rows, CSV (no totals) | yes, outside the reports | **not changed**: a list, not a report (question 2) |
| 7 | `sessions/service.ts:224` | 300 | Active users page | rows, **the four KPI tiles** ("Signed in now"…) | yes, beyond 300 live sessions | **not changed** (question 2): bounded in practice by staff × devices |
| 8 | `funding/service.ts:247` | page + 1 | GM funding history | rows | no: paged with `hasMore` | none |
| 9 | `auth/second-factor.ts:136` | 500 | new-device check (internal) | a yes/no | no (30 days of one user) | none |
| 10 | `auth/passkeys.ts:562` | 10 | "Recent sign-ins" | rows | no: the screen says "the last 10" | none |
| 11 | `settings/store.ts:162,189` | 20 / 40 | setting and rate history | rows | no: labelled "recent" | none |
| 12 | `*:limit(1)` lookups, BE-7 pages | 1 / page | single rows, paged lists | — | no | none |

Not capped (SQL aggregates over a fixed dimension: branches, karats, categories, cashiers, days, users): stock weight,
inventory movement, profit (all groupings), branch performance, user activity, every home and dashboard figure
(`dashboard/service.ts`, `reports/metrics.ts`, attention). Their one `LIMIT 1` reads the last cash count.

## 2. What changes

- **Totals and summaries in SQL** over the whole filtered result, same filters, branch scope and cost rules: sales
  (items, weight, discount, total, cost, gross profit of completed sales; sales by payment channel), purchases (items,
  weight, total cost), inventory (net weight, purchase cost, total cost, selling price). Cost sums keep their COST
  field names (the response filter strips them without `profit.view`, as today).
- **Rows, per report:**
  - **On screen: (b), a visible cap.** The first 1,000 rows (2,000 for the inventory ledger, 1,500 for the audit
    report) as today, in the same order, plus `rowCount` (the true count) and `truncated`. The screen shows a warning
    above the table, in Arabic and English, that also prints. The footer totals are the true totals.
    Why (b): the report screen sorts and searches its rows in the browser; paging it is UI-B/UI-C work, not RPT-2.
  - **CSV: (a), every row.** When `truncated`, the export walks the report in pages of 200 (`page`, `pageSize`,
    `asOfId` on the same route, the BE-7 helper and snapshot), so the file has every row, in the same order.
- **Identical under the cap:** same rows, order, totals and text; only `rowCount` and `truncated: false` are added.
- **Guard:** a unit test fails if a report path uses `.limit(<number>)` or `limit: <number>`: report caps are named in
  one registry (`REPORT_ROW_CAPS`) and every capped report answers `truncated`. Other constant limits in the backend
  are listed with a reason; a new one fails until it is listed.
- No unbounded query: screens read at most the cap, the CSV pages of 200.

## 3. Tests (both projects)

A fixture with 1,200+ sales, purchases and pieces and 1,600+ audit rows (bulk SQL copies): row count = true count,
totals = an independent SQL SUM, the CSV walk = every row once, as the GM and as a branch manager (own branch only);
totals unchanged with the caps lowered (test-only option); the static guard; the Khartoum midnight in the purchases
and audit reports too.

## 4. Performance

`perf-homes` gains the reports on 60,000+ sales: the screen request and the full CSV walk. Budget: **1,000 ms p95**
for a report screen (one request returning up to 1,000 rows plus SQL totals, opened on demand, not on every page
like the lists' 300 ms); the CSV walk of 60,000 rows is measured and reported, budget 30 s.

## 5. Questions

1. A report over a very long period still shows 1,000 rows on screen (with the warning and true totals); the CSV has
   all. Is that acceptable until the reports page gets server paging (UI-C)?
2. Items 6 and 7 (Hasad transfers list, Active users) have silent caps outside the reports: page them with the BE-7
   helper next, or leave them?
