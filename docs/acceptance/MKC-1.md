# Manual acceptance: MKC-1 (supplier making charges paid by the owner; supplier orders GM-only)

For the owner, about 20 minutes. Engineering ran section A. Section B is a walk-through in a GitHub Codespace from the
Windows laptop's browser.

**Operating rule: the General Manager records a supplier order only after the pieces have arrived at the branch.**
Recording it receives the pieces into the branch at once (they are on sale).

What changed:

- **A supplier order records how its making charge was paid.**
  - The charge is paid **by the owner, by bank transfer from the owner's personal account**.
  - The order keeps the **transfer reference** and the **transfer date**. Only the General Manager sees them; the
    branch manager sees "Paid by the owner".
  - **No branch money moves.** The drawer and the branch bank are untouched, and the branch owes nothing.
- **Cost and profit are unchanged.** The making charge stays in each piece's cost.
- **The same transfer reference on a second order** asks "Record it anyway?" and never blocks.
- **Only the General Manager records supplier orders.** The branch manager keeps viewing orders, settling the gold
  owed with broken scrap, and creating types and products.
- **The gold side is unchanged.** Supplier debt is still in pure 24K and is settled only with broken scrap.
- **The Cash page** no longer has a "Supplier making charges" line. A day with only a supplier order does not ask for
  a cash count.

Plan: `docs/plans/MKC-1.md`. Decisions: D-mkc-1 to D-mkc-10 (`docs/decisions.md` §22). Migration **0022**.

**Before opening day:** a database holding supplier orders from before this change cannot be upgraded. Migration 0022
stops, changing nothing, and the database is recreated, as for CSH-2 and FIX-2. **This is allowed only before real
client data exists** (D-mkc-5); from then on a migration must transform data, never reject it.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run typecheck`: lockfile, Hasad footprint, migrations, drizzle, test imports, assets, four packages | passed |
| Backend tests, both projects | 1,829 passed, 3 skipped: PGlite 893, PostgreSQL 939. New: `mkc1`, `mkc1-migrations` (with the CSH-2 migration tests on one shared harness) |
| `npm run build`, `npm run i18n:check` | passed |
| REH-1 rehearsal (production mode, real PostgreSQL) | `REHEARSAL PASSED: 228 checks.` |
| `node scripts/e2e-print.mjs` | 47 checks passed |
| `node scripts/e2e-passkeys.mjs` | 33 checks passed (mode on), 3 (mode off) |
| `node scripts/e2e-states.mjs` | 95 checks passed (new: the branch manager has no "New purchase"; the form asks for the reference and date; axe on the purchase dialog) |
| `node scripts/capture-ui-kit.mjs` | 24 checks passed (the kit screenshots are not committed) |
| `node scripts/perf-homes.mjs` | `PERF PASSED`: every p95 ≤ 109 ms (budget 300 ms) |
| Migration upgrade checks (`mkc1-migrations.test.ts`, `csh2-migrations.test.ts`) | 0022 on databases at 0021, PGlite and PostgreSQL |

**What the tests prove:**

| Condition | Test |
|---|---|
| **No branch money moves** | `mkc1.test.ts`: after an order, the balances, what is owed to the GM, the drawer endpoint, the day's reconciliation and the branch home's expected cash are identical. The order has no ledger entry. The fixture world holds no `SUPPLIER_MAKING_CHARGE` entry and no purchase entry at all. REH-1: the drawer and the bank are unchanged by the General Manager's order |
| **Cost and profit unchanged (Q6)** | `mkc1.test.ts`: each piece's cost = purchase + making + other. The sale snapshot, and the totals of the purchases, inventory, sales, profit and branch-performance reports, equal the order lines' arithmetic. So does the GM home strip. All nine reports run (their CSV exports are built from the same rows). REH-1: profit and cost of sales unchanged by the order; purchases cost up by exactly the order |
| **Reference and date** | `mkc1.test.ts`: required above 0; FIX-2 rules with Arabic digits normalized; a real day, never in the future; none for a charge of 0. A validated database check ties them to the charge. REH-1: the form cannot be saved without them, the reference typed in Arabic digits is shown normalized |
| **Repeated reference: warn, never block (Q4)** | `mkc1.test.ts`: 409 with the other order's number, then recorded with the confirmation, which is audited |
| **GM only** | `mkc1.test.ts`: 403 for the branch manager and the cashier; the old payment source is refused. The reference and date are absent from the branch manager's list and detail. The generated route tests. REH-1 and e2e-states: no "New purchase" for the branch manager; REH-1: 403 on `POST /api/purchases` |
| **No role can be given it later** | No screen or API edits role grants (only `GET /roles` exists). `mkc1.test.ts`: `funding.view`, `funding.manage` and `purchases.create` are in no other role's defaults, and after the seed (run twice) only the General Manager holds them |
| **Night-time order: no cash count asked** | `mkc1.test.ts`: an order recorded at 23:00 yesterday raises no A5; a cash advance at the same time does (control). REH-1 cannot move the server clock, so it checks that the order produces no drawer movement |
| **Gold side unchanged** | `mkc1.test.ts` and REH-1: the order owes its pure-24K weight; the branch manager settles 1 g of broken 21K scrap and the order owes 0.875 g less |
| **Migration 0022** | `mkc1-migrations.test.ts`, PGlite and PostgreSQL. The guard counts each kind (drawer, bank, a charge of 0 with a source, before Phase 4), alone and together, and points to DEPLOYMENT "MKC-1". A stop leaves no new column, the old check, and every role's grant. A clean upgrade validates the checks, leaves `purchases.create` to the General Manager only (a custom role loses it too) and refuses inconsistent rows |
| **Exact figures in tests** | No test asserted a drawer or bank figure that depended on making charges. The fixture world keeps its random sequence (it still draws the old drawer/bank choice), so every other figure is identical; only drawer and bank balances rise by the charges no longer paid from them |

**Performance.** `node scripts/perf-homes.mjs` (8 branches, 2 years, 60,137 sales, 90,375 pieces; Intel Xeon 2.80 GHz × 4,
16 GB RAM, PostgreSQL 16.14; 20 runs, p50 / p95 in ms): GM home today 67 / 78, 30 days 73 / 103, branch home 72 / 88,
attention GM 99 / 109, attention BM 25 / 30. All within 300 ms. MKC-1 adds no query to any home; recording an order
does one indexed lookup more (the repeated-reference check) and one ledger write less.

## B. In a Codespace, from the Windows browser (about 20 minutes)

On GitHub: switch to the branch `claude/hopeful-sagan-lehxyp`, then **Code → Codespaces → Create codespace on
claude/hopeful-sagan-lehxyp**. Wait for the dependencies to install, then in the terminal:

```bash
npm run build
rm -rf .data/sample                                # a database from before MKC-1 is recreated, not upgraded
PGLITE_DIR=.data/sample npm run dev:sample        # prints the sample accounts and passwords once
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

Open port **4000**. The sample has two branches, A and B.

| # | Who | Check | Expected |
|---|---|---|---|
| 1 | General Manager | **Cash**: note Branch A's drawer and bank | — |
| 2 | General Manager | **Purchases › New purchase**: Branch A, a supplier, one line with a making cost of 40,000 | "Making charge: paid by the owner, by bank transfer from the owner's personal account". A **transfer reference** and a **transfer date** (today) appear; "Receive into stock" stays disabled until the reference is filled |
| 3 | General Manager | Type a reference (Arabic digits are fine), save | The order opens: "Making charge paid by: the owner (personal account)" and "Owner's transfer: reference · date". The list shows the reference |
| 4 | General Manager | **Cash** again | Branch A's drawer and bank are **exactly** as in row 1. No "Supplier making charges" line |
| 5 | General Manager | Another order with the **same reference** | "This transfer reference is already on supplier order …. Record it anyway?" with **Record anyway** |
| 6 | General Manager | **Reports › Profit**, then the home | Profit and cost of sales are unchanged by the orders; the purchases cost rose by the orders' totals (making charge included) |
| 7 | Branch manager A | **Purchases** | The orders are listed; there is **no "New purchase"**. The order shows "Paid by the owner" **without** the reference or the date |
| 8 | Branch manager A | **Home** and **POS** with no stock | The text says the General Manager records supplier orders and offers buying scrap (the API also refuses a branch manager's order with 403, tested) |
| 9 | Branch manager A | **Scrap**: buy 1 g of broken 21K; then on the order, **settle** with 1 g of 21K | The gold still owed drops by 0.875 g of 24K, as before MKC-1 |

## C. Known and accepted

- **A wrong order amount or reference cannot be corrected yet.** BACKLOG **PUR-FIX** (P1, before real operation), next
  to SCR-VOID ("mistake correction").
- **The transfer date is display only.** The order, the reports and the day grouping use the recording time.
- **Open client questions:**
  - can one transfer ever pay several orders? (today: it is warned about, then allowed);
  - would the client like a "profit before the owner's charges" figure? (today: the making charge is in cost).
