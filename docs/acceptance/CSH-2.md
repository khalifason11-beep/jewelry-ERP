# Manual acceptance: CSH-2 (the General Manager's funding of a branch, split payment on scrap, negative balances)

For the owner, about 25 minutes. Engineering ran section A. Section B is a walk-through in a GitHub Codespace from the
Windows laptop's browser.

What changed:

- **The General Manager's advances and repayments** (piece B), on the **Cash** page, for the General Manager only:
  - an **advance** puts money into a branch's drawer or bank, with a reason (and the bank reference for the bank);
  - a **repayment** takes money back out to him, never more than the branch owes him;
  - "**Owed to the General Manager**" per branch and in total, derived from the ledger, never typed;
  - a wrong advance or repayment is **corrected** once (password re-confirmation), never edited or deleted;
  - an advance can be marked "paid directly to a seller" with the purchase number; this is a note only;
  - the drawer and bank lines gain "Advances from the General Manager" and "Repayments to the General Manager".
- **Scrap bought at the counter can be paid part cash, part bank transfer** (piece A):
  - the person types the cash part, and the bank part fills itself with the rest;
  - the bank part needs the transfer reference;
  - the list's "Paid by" shows both parts and the reference;
  - Cash has a "Scrap purchases (n)" drill-down under the drawer and under the bank.
- **Negative balances** (piece C):
  - **The drawer can never go below zero.** A cash payment it cannot cover is refused, with the shortfall and what to
    do. This covers the scrap cash part, the making charge, a cash refund, a repayment and the correction of an
    advance.
  - **The bank may go below zero**, because its figure lags your deposits. The attention list then shows "The bank
    balance of … is below zero" (A17, urgent).
  - The first steps on your home gain a fifth step, **"Fund the branch"**.

Plan: `docs/plans/CSH-2.md`. Decisions: D-csh-1 to D-csh-9 (`docs/decisions.md` §21). Migrations **0020** (funding)
and **0021** (split payment on scrap).

**Before opening day:** a database holding scrap purchases paid by bank transfer from before this change cannot be
upgraded. Migration 0021 stops and changes nothing; such a database is recreated, as with FIX-2. Trial databases only.

> **Open client question Q11 (answer before opening day).** Opening money recorded as an **advance** becomes a **debt
> of the branch to the General Manager**, shown as "Owed to the General Manager" until repaid. If the client
> considers the opening money **capital**, a separate event is needed. It is not built, by your decision.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run typecheck`: lockfile, Hasad footprint, migrations, drizzle, test imports, assets, four packages | passed |
| Backend tests, both projects | 1,805 passed, 3 skipped: PGlite 881, PostgreSQL 927. New: `funding`, `scrap-split`, `negative-balances`, `csh2-migrations`, `pg/funding-race`, `pg/drawer-race` |
| `npm run build`, `npm run i18n:check` | passed |
| REH-1 rehearsal (production mode, real PostgreSQL) | `REHEARSAL PASSED: 218 checks.` |
| `node scripts/e2e-print.mjs` | 47 checks passed |
| `node scripts/e2e-passkeys.mjs` | 33 checks passed (mode on), 3 (mode off) |
| `node scripts/e2e-states.mjs` | 91 checks passed |
| `node scripts/capture-ui-kit.mjs` | 24 checks passed (the kit screenshots are not committed) |
| `node scripts/perf-homes.mjs` | `PERF PASSED`: every p95 ≤ 119 ms (budget 300 ms) |
| Migration upgrade checks (`csh2-migrations.test.ts`) | 0020 and 0021 applied to databases at 0019 and 0020, on PGlite and PostgreSQL |

**What the tests prove, for each of your conditions:**

| Condition | Test |
|---|---|
| **OWED_TO_GM is never counted as money** | `funding.test.ts` GUARDRAIL. (1) Every function in `backend/src` that reads `ledger_entries` or `ledger_accounts` is listed with why it filters by kind; a new reader fails the test until reviewed (it caught `voidSale` in commit 5). (2) A 987,654,321 entry on OWED_TO_GM alone changes nothing in: the drawer endpoint, the reconciliation (every line and total), both homes, the company dashboard, the attention list, every report and its export |
| One lock helper, ascending id | `lockAccounts(tx, branchId, kinds)` in `modules/ledger/service.ts`, used by funding, the Hasad settlement and every drawer check |
| Two purchases racing on a drawer cannot both pass BLOCK | `pg/drawer-race.test.ts`, 8 rounds: two scrap purchases and two making charges of 600,000 on a drawer of 1,000,000, exactly one goes through, the drawer ends at 400,000. **The same test fails with the row lock removed** (2 went through), so it really tests the lock |
| Repayment vs repayment; repayment vs reversal of an advance | `pg/funding-race.test.ts`: ten parallel repayments (exactly three of 30% fit); a repayment racing the correction of an advance (never both); 40 mixed operations with overlapping locks, no deadlock |
| Migration 0021: guards, trigger back on, no CASCADE | `csh2-migrations.test.ts`. Guard (a): a purchase whose ledger entries disagree with its method stops the upgrade, nothing changed. Guard (b): a bank-paid purchase stops it. Clean upgrade: the parts backfilled from each row's own method. On PostgreSQL the trigger is enabled again (`tgenabled = 'O'`), an UPDATE is refused, and no role holds UPDATE (`has_table_privilege` false). `check:migrations` requires the allow-destructive markers; `check:drizzle` matches the complete schema |
| BLOCK refuses every drawer outflow, with the shortfall and what to do; nothing is recorded | `negative-balances.test.ts`: making charge, scrap cash part, cash refund of a void, repayment from the drawer, correction of a drawer advance (409 `DRAWER_SHORT`, the amounts in the message); exactly the drawer is allowed; the bank part is never refused; the recovery path (an advance, then the void) works; every sentence has its Arabic with the money isolated left to right |
| WARN: A17 | `negative-balances.test.ts`: critical for the General Manager, the branch manager of that branch sees it, another branch's does not, and it clears after an advance into the bank |
| A reversal is classified under its original line, also on a later day | `funding.test.ts` (a correction recorded the day after its advance; both days add up) |
| Fifth first step | `setup.test.ts`: open until every active branch has an uncorrected advance into its drawer; a bank advance or a corrected one does not count; a new branch opens it again |
| Split payment | `scrap-split.test.ts`: two entries, the label, the drawer line counts only the cash part, the drill-down adds up to each line, the database refuses an inconsistent row, `reverseRef` reverses both parts |
| 403 for the branch manager and the cashier on every funding route | the generated route tests (`phase1b.test.ts`), and REH-1 through the browser for both |
| Fixtures and samples record advances before any outflow | the fixture world, `dev:sample`, the e2e world and REH-1. REH-1's main drawer was −335,000 and the sample's −647,810; both are now positive because the money is recorded. No test asserted an exact drawer figure, so none had to change |

**Ledger readers** (the guardrail's list; each filters by account kind or is not a sum of money):

| Function | Why it is safe |
|---|---|
| `ledger/service.ts` `accountId`, `lockAccounts`, `lockDrawerFor` | look up or lock **named** kinds only |
| `ledger/service.ts` `post`, `reverseRef` | write entries; they read nothing to show |
| `ledger/service.ts` `balances` | one balance per (branch, kind); every caller picks a kind: `cashBalance` (CASH), the drawer endpoint (named kinds), the homes through `cashBalance` |
| `ledger/service.ts` `reconciliation` | every sum names a kind, or an event type only CASH, BANK or HASAD_RECEIVABLE carry |
| `ledger/service.ts` `entriesFor` | the entries of one record (detail screens) |
| `attention/service.ts` `attentionFor` | A4 and A5 read CASH only, A17 BANK only |
| `sales/service.ts` `voidSale` | the cash refund sums the sale's own SALE entries on CASH only |
| `funding/service.ts` `owedToGm` | OWED_TO_GM only, on purpose |
| `backup/stats.ts`, `backup/checks.ts` | integrity counts and one labelled balance per account in the backup summary |
| Indirect readers: `cashBalance`, the drawer endpoint, `settleHasadReceivable`, the scrap, purchase and funding writes | through `balances` / `lockAccounts` with named kinds |

**Performance.** `node scripts/perf-homes.mjs` (8 branches, 2 years, 60,137 sales, 90,375 pieces, 61,387 ledger
entries; Intel Xeon 2.80 GHz × 4, 16 GB RAM, PostgreSQL 16.14; 20 runs, p50 / p95 in ms): GM home today 72 / 92,
30 days 80 / 95, branch home 74 / 90, attention GM 103 / 119, attention BM 22 / 37. All within 300 ms. The homes and
the attention list take **no lock**; A17 adds one grouped query to the attention list. The BLOCK locks are on the
**write** path only. Timed directly on PostgreSQL (60 cash scrap purchases, the first 10 dropped), the drawer lock
and its balance read add about **2 ms** per cash payment: p50 7.0 ms with the lock against 5.2 ms without. Payments
on the **same** drawer wait for each other, which is the point (`pg/drawer-race.test.ts`).

## B. In a Codespace, from the Windows browser (about 25 minutes)

On GitHub: **Code → Codespaces → Create codespace on main** (`main` is the default branch). A codespace created
earlier on `claude/hopeful-sagan-lehxyp` can be moved to `main` in its terminal: `git fetch origin`, then
`git checkout main`, `git pull` and `npm install`. Wait for the dependencies to install, then in the terminal:

```bash
npm run build
PGLITE_DIR=.data/sample npm run dev:sample        # prints the sample accounts and passwords once
APP_MODE=demo PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

Open port **4000**. The sample has two branches, A and B, each funded with test advances (3,000,000 in the drawer,
2,000,000 in the bank).

| # | Who | Check | Expected |
|---|---|---|---|
| 1 | General Manager | **Cash** | The "Funding from the General Manager" panel: what each branch owes you, the total, the history with reasons |
| 2 | General Manager | **Fund a branch**: "Record an advance", Branch A, the **drawer**, 500,000, reason "Test: morning float" (password) | The amount owed by Branch A goes up by 500,000; the drawer too; today's drawer line "Advances from the General Manager" shows it |
| 3 | Branch manager A | **Scrap**, broken, 21K, a few grams; type a **cash part** below the amount | The bank part fills itself with the rest and asks for the **transfer reference**. Without it, "Buy and pay" stays disabled |
| 4 | Branch manager A | Enter a reference, then "Buy and pay" | The list's "Paid by" shows "Cash … + bank …" and the reference. On **Cash**: "Scrap purchases (n)" under the drawer and under the bank, each adding up to its line |
| 5 | Branch manager A | **Scrap**, broken, enough grams that the amount is **above the drawer**, all in cash | **Refused on the form**: "The drawer holds …: the cash part of … is … more than that. Pay … more by bank transfer, or ask the General Manager to record an advance into the drawer". Nothing is recorded |
| 6 | General Manager | **Repay**: "Record a repayment", Branch A, the drawer, 100,000 (password) | The amount owed goes down by 100,000. Try a repayment above what is owed: refused with the amount owed |
| 7 | General Manager | **Correct**: on the history, "Correct" the advance of row 2, with a reason | The amount owed and the drawer go back down by 500,000. The original stays in the history, marked corrected; it cannot be corrected twice |
| 8 | Branch manager A | **Cash** | The drawer and bank lines, including "Advances from / Repayments to the General Manager", but **nothing** about what is owed, the reasons or the history |
| 9 | Branch manager A | Open `/api/funding` in the address bar | `403` ("You do not have permission…"). Same as the cashier |
| 10 | General Manager | Home, in Arabic and English | No new line unless a bank is below zero (A17); the amounts read left to right inside Arabic text |

## C. Known and accepted

- **Q11 is open:** opening money recorded as an advance is a debt to the General Manager until the client says
  otherwise. Ask before opening day.
- **No scrap void yet (SCR-VOID, P1, before real operation).** A wrong scrap purchase cannot be corrected; the ledger
  helper that will reverse both parts is tested.
- **Supplier making charges are unchanged (MKC-1).** The client facts are recorded in the BACKLOG. Today, a making
  charge still leaves the branch's drawer or bank. Under these facts, the drawer BLOCK can refuse a supplier order
  paid "from the drawer" on a branch that was never funded; the General Manager would choose "bank" instead, which
  is never refused but may raise A17 on a branch bank he did not fund (see MKC-1 for the interaction).
- **No backdating (Q12):** an advance is dated when it is recorded; the reason says when the money really moved.
- **A cash refund can be refused** when the drawer is short (Q7: one rule for every outflow). The message says to
  ask the General Manager for an advance, then cancel the sale again.
- **No print of a split payment** (there is no scrap receipt yet, SCR-1); the printed wording is a client question.
