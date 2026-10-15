# BE-7: server-side pagination and sorting (plan)

Owner decision D-ux-15; BACKLOG BE-7. Six lists page and sort on the server: **sales, inventory, audit, purchases,
scrap purchases, transfers**. No screen is redesigned here; the existing pages change only as far as needed to keep
working (UI-B3 redesigns the sales list later).

## What is there today (read from the code)

| List | Route | Today | Order | Filters |
|---|---|---|---|---|
| Sales | `GET /sales` | array, cap 1,000 | `created_at desc` (no tiebreaker) | from/to, branch, cashier, status, q, mine |
| Inventory | `GET /inventory/items` | `{items,total}`, `limit` ≤ 1,000 + `offset` | code / weight / price / recent / closest (no tiebreaker) | branch, status list, karat, type, origin, weight range, q |
| Purchases | `GET /purchases` | array, cap 1,000 | `created_at desc` | from/to, branch, q |
| Scrap purchases | `GET /scrap-purchases` | array, cap 500 | `created_at desc, id desc` | from/to, branch, kind |
| Transfers | `GET /transfers` | array, cap 300 | `created_at desc` | branch (from or to), status |
| Audit | `GET /audit` | array, `limit` ≤ 5,000 (default 1,500) | `at desc, id desc` | period, branch, user, action, entity type, q |

The browser sorts, searches and exports CSV from whatever was loaded, so today a list longer than the cap is silently
cut, and the CSV exports only what the browser holds. **Finding (not changed here):** the Sales, Purchases and
Inventory **reports** are built on the same functions, so they inherit the 1,000-row cap; recorded in BACKLOG §G.

## Choice: offset pages, a unique tiebreaker, and a snapshot id

**Offset** (`page`, `pageSize`) and not keyset, because:

- the lists sort by several allowed columns in both directions (code, weight, price, date, total…); keyset needs a
  cursor per sort key and direction, and nullable sort columns make it fragile;
- the screens show "1–50 of 1,234" and a page number (R11, UI-B3); keyset cannot jump to a page or give the count;
- the depth is small: 20,000 sales are 400 pages of 50; the deepest page is measured below against the 300 ms budget.

**Stable order:** every sort is `ORDER BY <allowed column> <dir>, id <dir>`; `id` is unique, so rows with equal sort
values keep one order and never repeat or skip between pages.

**Snapshot:** page 1 answers `asOfId` (the highest id in the table when it was read); later pages and the CSV export
send it back and the query adds `id <= asOfId`. A row inserted while someone pages (a new sale on top) therefore
cannot push a row onto the next page twice. Limit (documented): a row whose filtered value changes meanwhile (a sale
voided while the list is filtered by "Completed") can still move; the next refresh shows it right.

**Total:** an exact `count(*)` with the same WHERE (branch scope included), not `hasMore`: the screens show the
count, and it is cheap at this size (measured). The count never includes rows the caller may not see.

## Request and response (one shared helper, `backend/src/core/paging.ts`)

- Query: `page` (≥ 1, default 1), `pageSize` (default **50**, values above **200** are clamped to 200), `sort`
  (an allowed key of that list; anything else is **400**, never put into SQL), `dir` (`asc` | `desc`, default per
  key), `asOfId`.
- Response: `{ rows, total, page: { number, size, pages, sort, dir, asOfId } }`, the same for all six lists
  (inventory's `items` becomes `rows`). New response field names are classified SAFE.
- Each list declares its sort keys: `{ key → column, field name, default dir }`. **A key whose field is classified
  COST** (`shared/src/field-classification.ts`) is refused with **403** for a caller without `profit.view`, so ordering
  cannot leak cost (e.g. inventory by acquisition cost, purchases by total cost, sales by gross profit). No list has a
  cost filter; `.strict()` refuses any unknown filter.
- Filters (R11: period, branch, status, search): sales, purchases, audit keep theirs; scrap purchases gain `q`
  (number, customer); transfers gain `from`/`to` and `q` (number, courier); inventory keeps its own (stock has no
  period).

## CSV export

The export keeps the whole filtered result: the browser walks every page (`pageSize` 200, same filters, same sort,
same `asOfId`) through one shared function (`shared/src/paging.ts`, `fetchAllPages`) and builds the CSV with the same
columns as before. Every row passes the same server-side scope and cost redaction as the screen. Tested: all pages
joined = the full filtered result, in order, with no duplicate.

## Frontend (only what the new shape needs)

`DataTable` gets an optional server mode: the column sort calls the server (only on allowed keys), the search box sends
`q` (where the list has it), and a small pager shows "1–50 of N" with Previous / Next. Pages updated: Sales, My
activity, Inventory, POS search, transfer picker, Purchases, Scrap, Transfers, Audit, plus REH-1, the e2e scripts and
the tests that read these routes.

## Indexes

Only what EXPLAIN on real PostgreSQL shows the new queries need, in a **new** migration (additive `CREATE INDEX`
only, hand-reviewed, checksum manifest recorded, upgrade test green). Candidates to verify: `sales(created_at, id)`
for the company-wide list, `purchases(branch_id, created_at)`, `transfers(created_at)`.

## Tests (both vitest projects)

Page boundaries (first, middle, last, beyond the last); stable order with equal sort values; page-size clamp; filters
+ sort + page together; unknown sort key 400; cost sort key 403 for non-GM; **cost visibility on every page of every
list for every role**; branch scoping on every page and in the total; snapshot (a sale inserted between pages); CSV
walk = whole filtered result; existing screens' calls. **Business-day boundary:** a sale at 23:30 and one at 00:30
Africa/Khartoum land on the right day in every list filter and the sales report, with the process in UTC (no such
DB-level test exists: `display-zone.test.ts` covers formatting only), added.

## Performance

`scripts/perf-homes.mjs` (60,144 sales, 90,372 pieces on PostgreSQL 16) gains list timings: page 1, a middle page
and the last page, default and one other sort, GM and branch manager, 20 runs each; p50/p95 per list against
**300 ms**. EXPLAIN of the main queries in the report.

## Commits

1. Plan. 2. Helper + shared types + classification. 3–5. Lists (sales; inventory; purchases, scrap, transfers,
audit) with their tests and consumers. 6. Index migration + EXPLAIN. 7. Perf timings. 8. Business-day test. 9. Docs
(DEPLOYMENT API note, decisions D-be7-*, BACKLOG).
