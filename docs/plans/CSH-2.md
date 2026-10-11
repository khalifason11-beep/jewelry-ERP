# Plan: CSH-2 (branch funding by the General Manager, split payment on scrap purchases, negative balances)

Status: **plan only, for the owner's review.** Nothing here is implemented. UI-C is not started.

Binding inputs:
- the owner's brief of 2026-10-10: the facts from the client conversation and the three pieces A, B and C;
- `docs/SPEC.md` §9 (cash, ledger, reconciliation) and §18.10 (the reconciliation adds up);
- decisions D-2b-7 and D-2b-8 (expected cash, counts, migrations invent no ledger entries);
- decisions D-4-4 and D-4-14 (making charge paid at once; Hasad by bank transfer);
- decisions D-fix-2 (bank references, validated check with a guard) and D-ui-17 (attention list).

Rules kept throughout:
- nothing client-specific is hard-coded (no amounts, no names);
- every money amount in a test or the rehearsal is a test value, never a client default;
- [OPEN] client items are listed as questions (§9), never guessed.

**Naming.** BACKLOG already has a "CSH-2 — Cash-out entry for the operating amount" (blocked on Q-6). This plan takes
over the name for the funding work. It proposes renaming the old item to **CSH-3** (still blocked on Q-6; question
Q13), because the operating amount may turn out to be one more GM ↔ branch movement.

---

## 1. Why: where the −335,000 comes from

REH-1's main branch shows an expected drawer of **−335,000** (the sample database: −647,810). It comes from two
outflows:
- the counter purchase of a 3 g sellable scrap piece at the rehearsal's test scrap rate of 95,000 per gram:
  **285,000, paid in cash**;
- the making charge of the supplier order, pre-filled by the purchase form from the gold rate and paid **from the
  drawer** (the default).

**Nothing ever records money entering the drawer**, except cash sales; the rehearsal's sales are bank transfers. The
books start at zero cash (SPEC §9 [CLIENT]), and there is no event for "the owner put money in". So any cash outflow
on day one makes the expected cash negative. A real count can never be negative (`ck_cash_counts_counted_amount_nonneg`),
so the daily reconciliation can never match.

The fix is to **record the money the General Manager puts in** (piece B), not to hide the negative number.

---

## 2. What exists today (read from the code)

### 2.1 Scrap purchases (`backend/src/modules/scrap/service.ts`, `buyScrap`)

- **One payment method per purchase**:
  - `scrap_purchases.payment_method` is `CASH` or `BANK_TRANSFER` (`SCRAP_PAYMENT_METHODS` in `shared/src/enums.ts`);
  - database check `ck_scrap_purchases_payment_method` (migration 0007, NOT VALID then validated by the 0006
    validation loop);
  - zod `z.enum(SCRAP_PAYMENT_METHODS)` on `POST /scrap-purchases` (`backend/src/routes.ts`).
- **The amount** = `valueOfWeight(net mg, agreed rate)`, stored in `scrap_purchases.amount`.
- **Ledger:** one entry, inside the purchase's transaction:
  - `post(tx, [{ kind: CASH | BANK, amount: −amount, eventType: 'SCRAP_PURCHASE', paymentMethod }])`;
  - the account is `CASH` for cash and `BANK` for a bank transfer.
- **No bank reference.** `scrap_purchases` has no reference column, and the form does not ask for one.
- **No void, no reversal, no correction path.** `scrap_purchases` is **append-only**:
  - trigger `scrap_purchases_append_only`, migration 0007;
  - `jerp_lock_append_only('scrap_purchases')`;
  - listed in `APPEND_ONLY_TABLES`, `backend/src/core/startup.ts`.

  A wrong scrap purchase cannot be undone today.
- **No print, no receipt, no detail screen.** `frontend/src/pages/scrap/ScrapPage.tsx` has the form and a list with a
  "Paid by" column. A customer receipt is BACKLOG SCR-1, blocked on Q-12.
- **The reconciliation** (`backend/src/modules/ledger/service.ts`, `reconciliation`) already splits scrap by account:
  - `scrapPurchasesCash` sums the `SCRAP_PURCHASE` entries on CASH, and `scrapPurchasesBank` those on BANK;
  - the `SCRAP_PURCHASES` line of `cashLines` and `bankLines` comes from `reconciliationLines()`, which filters by
    account kind.

  So the cash line already counts only cash entries. A split purchase that posts two entries is counted correctly
  with no change to the reconciliation; a test will prove it (§7).
- **Who:**
  - `scrap.buy` (branch manager and GM) records a purchase;
  - `scrap.buy` or `purchases.view` lists them;
  - all `scrap_purchases` columns are SAFE (`shared/src/field-classification.ts`).

### 2.2 Supplier purchases (`backend/src/modules/purchases/service.ts`, `createPurchase`)

- The supplier is owed **gold** (`gold_owed_mg_pure24`), settled only with broken scrap (D-4-4). The only money that
  moves is the **making charge**, paid at once.
- **One source:** `makingChargePaidFrom: 'CASH' | 'BANK'` (default `CASH`), stored in
  `purchases.making_charge_paid_from`. It posts one `SUPPLIER_MAKING_CHARGE` entry and has **no bank reference**.
- **No void.** `purchases` has a single status, `RECEIVED`.
- `total_cost` and `making_charge_paid` are **COST** (GM only). The ledger entry's amount is SAFE and visible to the
  branch manager in the reconciliation's "making charges" line.

**The brief says "scrap purchases"**, and this plan scopes piece A to the counter scrap purchase. Whether the supplier
making charge also needs a split is question Q2.

### 2.3 The ledger

- **Accounts.** `ledger_accounts` holds one row per branch and kind, for `CASH`, `BANK`, `FUNDS_IN_TRANSIT` and
  `HASAD_RECEIVABLE`. They are created for every new branch by trigger `branches_ledger_accounts`; migration 0008
  added the HASAD account to existing branches and to the trigger.
- **Entries.** `ledger_entries` is append-only (trigger plus privileges):
  - the balance is `SUM(amount)`, never cached;
  - each amount is signed whole SDG, never 0.
- **Corrections** (`ck_ledger_entries_reversal_type` and trigger `jerp_ledger_reversal_check`):
  - only `SALE_VOID` or `REVERSAL` entries may set `reverses_entry_id`;
  - a reversal uses the same account and the opposite amount;
  - it is unique, so an entry is reversed at most once;
  - `reverseRef()` reverses every open entry of one event type for one record.
- **Event types:** `SALE`, `SALE_VOID`, `REVERSAL`, `SCRAP_PURCHASE`, `SUPPLIER_MAKING_CHARGE` and
  `HASAD_RECEIVABLE_SETTLEMENT`, plus the historical `EXPENSE` and `HASAD_SETTLEMENT`, which are allowed by the check
  only.
- **Reconciliation lines** (`RECONCILIATION_LINES`, `LINE_OF_EVENT`, `OTHER_EVENT_TYPES`):
  - CASH: SALES, VOIDS, SCRAP_PURCHASES, MAKING_CHARGES, OTHER;
  - BANK: the same plus HASAD_RECEIVABLE_SETTLEMENTS;
  - a guardrail test fails when an event type has no line and no reason under OTHER;
  - **`REVERSAL` entries always land in OTHER.**
- **The pattern to copy:** the Hasad receivable settlement (`settleHasadReceivable`):
  - it locks the HASAD_RECEIVABLE account row with `SELECT … FOR UPDATE`;
  - it refuses an amount above the balance;
  - it writes an append-only record (`hasad_receivable_settlements`) and two entries;
  - it claims the idempotency key inside the transaction.
- **Expected cash** = the CASH balance (`cashBalance`). It is used by:
  - Cash (`drawer`, `reconciliation`);
  - the counts (`recordCount` stores the expected amount);
  - the homes (UI-B `expectedCash`, `lastCount`);
  - attention A4 (difference) and A5 (no count).
- **Nothing refuses a negative balance.** No outflow (scrap purchase, making charge, sale void) checks the CASH or
  BANK balance.

### 2.4 Who uses cash outflows in tests and samples (affected by piece C)

- **`backend/test/fixtures/world.ts`** (the fixture world behind most backend tests):
  - supplier orders with making charges paid in cash;
  - counter scrap purchases in cash;
  - no funding.
- **`backend/src/dev/sample-cli.ts`** (`npm run dev:sample`): the same, which gives the sample's −647,810.
- **REH-1** (`scripts/rehearsal/rehearsal.mjs`) gives −335,000. Since UI-B, its A4 check counts branch B's drawer
  because branch A's is negative. That workaround goes away with this plan.
- **e2e-states, e2e-print and capture** create data through the API with cash outflows.
- The perf harness (`backend/test/perf/perf-homes.ts`) writes SQL directly and is not affected.

---

## 3. Piece B (core): GM advances, repayments and "owed to the GM"

### 3.1 Model

Recommended: one **new ledger account kind per branch, `OWED_TO_GM`** (a liability), plus an append-only record table.
The amount owed is the account's balance, `SUM(amount)`: derived, never an editable field.

| Event | Entries (one transaction, same reference) | Effect |
|---|---|---|
| `GM_ADVANCE` X to CASH | CASH **+X**, OWED_TO_GM **+X** | the drawer and the debt to the GM both grow by X |
| `GM_ADVANCE` X to BANK | BANK **+X**, OWED_TO_GM **+X** | |
| `GM_REPAYMENT` X from CASH | CASH **−X**, OWED_TO_GM **−X** | |
| `GM_REPAYMENT` X from BANK | BANK **−X**, OWED_TO_GM **−X** | |
| Correction of either | `REVERSAL` of both entries (`reverseRef`) | exactly undoes the original |

`owed_to_gm(branch) = SUM(OWED_TO_GM entries)`. That equals Σ advances − Σ repayments − Σ reversed advances +
Σ reversed repayments, as the brief defines it, with corrections included. The company total is the sum over branches.

**Why an account rather than summing event rows:**
- the same `FOR UPDATE` lock pattern as the Hasad receivable;
- corrections through the existing `reverseRef` and reversal trigger;
- one definition of a balance in the whole system.

The CASH and BANK lines of the reconciliation never see the OWED_TO_GM account: lines are filtered by kind. The
`drawer` endpoint returns named kinds only, so nothing that shows money today changes meaning. Implementation will
grep every `balances(` and `ledger_accounts` reader to confirm.

### 3.2 The record table (migration **0020**, hand-reviewed)

`gm_funding_events`, append-only like `hasad_receivable_settlements` (trigger `jerp_forbid_modification`,
`jerp_lock_append_only`, listed in `APPEND_ONLY_TABLES`):

| Column | Type | Rule |
|---|---|---|
| `id` | serial | |
| `number` | text unique | `<branch code>-GMA-000001` for an advance, `-GMR-` for a repayment, `-GMX-` for a correction (`nextNumber`) |
| `branch_id` | int, FK branches | |
| `kind` | text | `ADVANCE` · `REPAYMENT` · `REVERSAL` (check) |
| `account` | text | `CASH` · `BANK` (check). For a REVERSAL: the original's account |
| `amount` | money | `> 0` (check), whole SDG |
| `reason` | text | required, 3–300 characters after trim (check) |
| `bank_reference` | text | required when `account = 'BANK'` and kind ≠ REVERSAL, normalized like FIX-2 (`shared/src/references.ts`), 4–40 (check) |
| `reverses_event_id` | int | set only for `kind = 'REVERSAL'` (check both ways); **unique** (an event is corrected at most once); it must point at an ADVANCE or REPAYMENT of the same branch (trigger, like `jerp_ledger_reversal_check`) |
| `actor_id`, `session_id`, `idempotency_key`, `at` | | as in the Hasad table |

**Also in 0020:**
- **`ledger_accounts` kind check:**
  - drop and re-add `ck_ledger_accounts_kind` with `OWED_TO_GM`, **validated** (`-- allow-destructive: replace the
    kind check to add OWED_TO_GM; same rows stay valid`);
  - insert the OWED_TO_GM account for every existing branch (`INSERT … SELECT … ON CONFLICT DO NOTHING`; no ledger
    entry is invented, D-2b-8);
  - `CREATE OR REPLACE FUNCTION jerp_branch_ledger_accounts()` adds the kind for new branches.
- **`ledger_entries` event-type check:** drop and re-add `ck_ledger_entries_event_type` with `GM_ADVANCE` and
  `GM_REPAYMENT`, validated, with the same marker.
- **Payment method:** the check `ck_ledger_entries_payment_method` is unchanged. Funding entries carry `CASH` or
  `BANK_TRANSFER` on the CASH/BANK side and NULL on the OWED_TO_GM side.
- **Generation:** the migration is generated by drizzle-kit **from the complete schema** (`database/src/schema.ts` and
  `shared/src/db-checks.ts`). The hand-written parts (triggers, function, inserts) are appended and reviewed line by
  line. `check:drizzle` and `check:migrations` must pass. **No CASCADE.**

### 3.3 Reconciliation lines

`RECONCILIATION_LINES` gains, for both CASH and BANK, two lines before OTHER: **`GM_ADVANCES`** and
**`GM_REPAYMENTS`**. `LINE_OF_EVENT` maps `GM_ADVANCE → GM_ADVANCES` and `GM_REPAYMENT → GM_REPAYMENTS`. The guardrail
test then passes with no OTHER reason needed.

**Corrections:** a REVERSAL entry today always lands in OTHER. Recommended change (Q9): classify a REVERSAL **under
the line of the entry it reverses**. Then a corrected advance nets to zero inside "GM advances" instead of showing
+X there and −X under "Other". This is a reconciliation-only change: one join on `reverses_entry_id`. The day still
adds up, and SPEC §18.10's test covers it.

### 3.4 Repayment cannot exceed what is owed (concurrency)

`repayGm()` runs in one transaction:
1. `opts.idem.claim(tx)`: the Idempotency-Key is claimed **inside** the business transaction, as for transfers and the
   Hasad settlement.
2. Lock the branch's OWED_TO_GM account row: `SELECT … FROM ledger_accounts … FOR UPDATE`.
3. Read `SUM(amount)` of that account. If `amount > owed`, refuse with 400 "This is more than the branch owes the
   General Manager ({owed})".
4. If piece C is BLOCK: lock the paying account's row (CASH or BANK) too and refuse when the balance would go below
   zero (§5).
5. Insert the record, post the two entries, write the audit row, complete the idempotency key.

**Lock order:** when one transaction locks several `ledger_accounts` rows, it locks them in **ascending `id` order**,
so no deadlock is possible. One helper, `lockAccounts(tx, branchId, kinds)`, is used everywhere.

**Two races and how they are handled:**
- Two repayments at once: the second waits on the row lock, then reads the reduced balance.
- A repayment racing the reversal of an advance: reversing an advance **reduces** the amount owed, so it takes the
  same lock and is refused if it would make the amount owed negative ("This advance has already been repaid in part;
  correcting it would leave the branch owing less than nothing").

Proved on real PostgreSQL in `backend/test/pg/funding-race.test.ts` (§7).

### 3.5 API (route matrix rows, all with generated allow, deny and cross-branch tests)

| Route | Scope | Permissions | Flags |
|---|---|---|---|
| `GET /funding?branchId=` | branch | `funding.view` | — returns per-branch owed, company total, and the event history (paginated 50, newest first) |
| `POST /funding/advances` | branch | `funding.manage` | `reauth`, `idempotent`, `idempotencyInTx` |
| `POST /funding/repayments` | branch | `funding.manage` | same |
| `POST /funding/:id/reverse` | branch | `funding.manage` | same; body `{ reason }` |

- **Body:** `{ branchId, account: 'CASH' | 'BANK', amount, reason, bankReference? }`, zod `.strict()`. A bank reference
  is required when `account = 'BANK'`.
- **Permissions** (new): `funding.view` and `funding.manage`.
  - **Granted to the General Manager only.** The GM gets every permission by construction (`GENERAL_MANAGER = all
    PERMISSIONS`).
  - The branch manager and the cashier get neither, so every funding route answers **403** for them; the generated
    tests prove it.
- **Password re-confirmation** on every write (`reauth: true`, the existing window). A passkey is also required where
  the GM role requires one.
- **Audit** (`writeAudit`, both languages through keys): `GM_ADVANCE_RECORDED`, `GM_REPAYMENT_RECORDED` and
  `GM_FUNDING_REVERSED`. Each carries number, branch, account, amount and reason; metadata holds the owed amount
  before and after, and the bank reference.

### 3.6 The General Manager pays a seller personally (fact 3)

The flow the brief proposes:
1. the GM records a `GM_ADVANCE` to CASH (or BANK) for the branch;
2. the branch records the scrap purchase normally from CASH (or BANK).

No third payment method on purchases. **Four weaknesses I see:**

1. **Two steps, two people, a gap.** The GM records the advance; the branch manager records the purchase, maybe later.
   Between the two, the expected drawer is X higher than the real drawer, which never received the money. A count in
   that gap shows a shortage of X.
2. **The records say "from the drawer"** while the money went from the GM's pocket to the seller. The audit trail is
   arithmetically right (+X −X on CASH) but describes a movement that did not physically happen.
3. **By bank:** if the GM paid by transfer from his personal account, the branch bank account shows +X −X, but the
   branch's bank statement shows neither. Matching the branch account against the statement then has two entries
   with no counterpart. The reference on the purchase's bank part would be the GM's personal transfer.
4. **With BLOCK (piece C)** the order matters: the advance must be recorded first, or the purchase is refused.

**Recommended mitigation (Q5), still without a third payment method:**
- the advance form gets an optional **"paid directly to a seller"** marker and an optional link to the scrap purchase
  number (`linked_ref`);
- the reconciliation shows such advances and the linked purchase together as a pass-through (they net to zero on the
  account).

Alternative: accept the four points and document them for the client. Either way, the flow keeps "owed to the GM"
exactly right.

### 3.7 Where "owed to the GM" appears (no redesign)

- **Cash page, GM only** (`frontend/src/pages/cash/CashPage.tsx`): a "Funding from the General Manager" panel under
  the reconciliation:
  - the amount owed by this branch, and the company total when "All branches" is selected;
  - the history (advances, repayments, corrections with reason and reference);
  - buttons "Record an advance" and "Record a repayment", and "Correct" on a row.

  This is where the money of a branch is managed today. The reconciliation's new lines "GM advances" and
  "GM repayments" appear for everyone who sees the reconciliation (§6).
- **GM home** (UI-B): **one row** "Owed to the General Manager" in the existing "Gold position" panel is the only
  money-and-funding spot on level 2. It is not a redesign, but the panel is about gold, so the alternative is to show
  nothing on the home and keep it on Cash (Q10). The GM's branch view (`/overview?branchId=`) gets nothing new.

---

## 4. Piece A: PUR-PAY, split payment on counter scrap purchases

### 4.1 Rules (as the brief states them)

- **Amounts:** `cash_amount + bank_amount = amount` exactly. Both are whole SDG and ≥ 0; at least one is > 0 (implied
  by `amount > 0`).
- **Ledger:** the cash part posts a `SCRAP_PURCHASE` **CASH** outflow and the bank part a `SCRAP_PURCHASE` **BANK**
  outflow. Same event type and reference; `post()` skips a 0 part.
- **Bank reference:** a bank part > 0 requires one. It is normalized and validated exactly like a sale's
  (`shared/src/references.ts`, 4–40 after normalization). Whether duplicates are flagged as for sales is Q4.
- **Not in scope:** split payment on **sales** (open client question; BACKLOG SPL-1 stays as it is).

### 4.2 Schema (migration **0021**, hand-reviewed)

- **New columns on `scrap_purchases`:** `cash_amount money NOT NULL`, `bank_amount money NOT NULL` and
  `bank_reference text`.
- **`payment_method` stays**, as a derived label for lists and filters, with a third value `SPLIT`:
  - `CASH` ⇔ bank 0;
  - `BANK_TRANSFER` ⇔ cash 0;
  - `SPLIT` ⇔ both > 0.

  Alternative: drop the column and derive the label in queries (Q3).
- **Checks, all VALIDATED** (not NOT VALID, for the reason in D-fix-2):
  - `ck_scrap_purchases_payment_parts`: `cash_amount >= 0 AND bank_amount >= 0 AND cash_amount + bank_amount = amount`;
  - `ck_scrap_purchases_payment_method`: replaced, with `SPLIT` and the label tied to the parts as above
    (`-- allow-destructive: replace the payment-method check to add SPLIT`);
  - `ck_scrap_purchases_bank_reference`: `bank_amount = 0 OR (bank_reference IS NOT NULL AND length(btrim(bank_reference)) BETWEEN 4 AND 40)`.

**Backfill: the brief says "cash = total", but that is not right for every row.** Rows recorded as `BANK_TRANSFER`
were paid from the bank, and their ledger entry is on BANK. Writing cash = total would contradict the ledger and
break the reconciliation of past days. The backfill follows the row's own method:
- `CASH` → `cash_amount = amount, bank_amount = 0`;
- `BANK_TRANSFER` → `cash_amount = 0, bank_amount = amount`.

`scrap_purchases` is append-only, so the backfill must lift the trigger for the length of the migration's transaction:

```sql
-- 0021 outline (exact SQL in the commit, reviewed by hand)
DO $$ … guard 1 … $$;                    -- stops, changing nothing, when (a) or (b) below holds
ALTER TABLE scrap_purchases ADD COLUMN cash_amount bigint, ADD COLUMN bank_amount bigint, ADD COLUMN bank_reference text;
-- allow-destructive: one-time backfill of the new payment parts on an append-only table; trigger re-enabled below in the same transaction
ALTER TABLE scrap_purchases DISABLE TRIGGER scrap_purchases_append_only;
UPDATE scrap_purchases SET cash_amount = CASE WHEN payment_method = 'CASH' THEN amount ELSE 0 END,
                           bank_amount = CASE WHEN payment_method = 'BANK_TRANSFER' THEN amount ELSE 0 END;
ALTER TABLE scrap_purchases ENABLE TRIGGER scrap_purchases_append_only;
ALTER TABLE scrap_purchases ALTER COLUMN cash_amount SET NOT NULL, ALTER COLUMN bank_amount SET NOT NULL;
-- the three checks above, VALIDATED
DO $$ … guard 2: every row's parts equal its SCRAP_PURCHASE ledger entries per account … $$;
```

- **The guards stop** (like 0016 and 0018: `RAISE EXCEPTION`, nothing changed, since every pending migration runs in
  one transaction) when:
  - **(a)** any existing row's `SCRAP_PURCHASE` ledger entries do not match its method and amount (the backfill
    would contradict the books);
  - **(b)** any existing `BANK_TRANSFER` row has no bank reference. That is every bank row recorded before this
    change, because the reference never existed. Q1 asks how to treat them: stop and recreate (as FIX-2), or make the
    reference check apply only to new rows through a marker column.
- **Privileges:** the migration runs as the owner role (`MIGRATION_DATABASE_URL`). The runtime role still cannot
  UPDATE the table.
- **Tests:** a migration test on PostgreSQL proves that the trigger is enabled again and that an UPDATE is still
  refused afterwards.
- **No CASCADE.** Generated from the complete schema; `check:drizzle` and `check:migrations` pass.

### 4.3 API and screens

- **`POST /scrap-purchases`:** `paymentMethod` is replaced by `cashAmount` and `bankAmount` (whole SDG,
  `zNonNegMoney`) and `bankReference`.
  - **The server computes the amount** from the weight and the agreed rate. The form already shows that amount live.
    The person types the **cash part**; the **bank part fills itself** with the rest (editable), and the request
    sends both parts explicitly.
  - The server refuses with 400 "The cash and bank parts must add up to the amount ({amount})" when they differ, so a
    rate changed between screen and save can never post a wrong split.
- **Lists:** "Paid by" shows Cash, Bank transfer, or "Cash 200,000 + bank 85,000" with the reference.
- **The Cash page drill-down** gets "Scrap purchases (n)" per account, like FIX-2's "Bank-transfer sales": each
  purchase with its cash or bank part, adding up to the line.
- **Receipt and print: none exists today** (§2.1; SCR-1 is blocked on Q-12). The wording of a printed split payment
  is an open client question (§10), so nothing is printed in this plan.
- **Detail:** there is no scrap detail screen. The list row and the drill-down carry both parts.
- **Void or reversal: none exists today.** If a scrap void is added later, `reverseRef(ref, 'SCRAP_PURCHASE',
  'REVERSAL')` already reverses **every** open entry of the purchase, so both parts are reversed. A test with a split
  purchase will lock that in now, through the service helper, without adding a void route (Q6 asks whether a scrap
  void is wanted).

---

## 5. Piece C: negative CASH or BANK balances

### 5.1 What can make a balance negative

Today these outflows exist:
- counter scrap purchase (cash and bank parts);
- making charge (CASH or BANK);
- sale void refund (the original sale's account);
- with B: repayment to the GM, and the correction of an advance.

Inflows (sales, advances, Hasad settlements) can only raise a balance.

### 5.2 BLOCK vs WARN

| | **BLOCK**: refuse an outflow that would take CASH or BANK below zero | **WARN**: record it, and flag the negative balance |
|---|---|---|
| Books | Never negative. The reconciliation can match from day one | Can go negative, as today. Matching needs a later advance |
| Staff experience | The purchase is refused: "The drawer holds {balance}; this needs {amount}. Ask the General Manager to record an advance." The customer waits | Never stopped. A critical attention line for the GM: "Branch A's drawer is below zero (−X)" |
| Risk of the policy | **Blocking a real purchase when money exists but is not recorded**: the GM put cash in the drawer and forgot to record it, or funded the bank, which the system learns only when he records it. The customer at the counter is turned away | **The problem we have today persists**: nothing forces anyone to record the funding, so negative drawers and unmatched counts become normal and are ignored |
| BANK specifically | The system's bank balance always lags reality. Sales by transfer are recorded at once, but GM deposits only when he enters them. A BANK block will misfire more often than a CASH block | Same lag, but harmless |
| Sale void refunds | A refund of a cash sale is refused when the drawer is short. That is physically true (the cash is not there) but surprising | No change |
| Cost to build | Account row locks on every outflow (the same `lockAccounts` helper as B, in ascending id order); fixture world, sample data, e2e and REH-1 must record an advance first; about 1 day | A new attention signal (**A17** negative balance, critical, GM; the branch manager sees their own branch); about ½ day |
| Concurrency | Two purchases at once could each pass a check on the old balance. **Locks are mandatory** (row lock on the CASH or BANK account) and tested on PostgreSQL | No lock needed |

**My recommendation** (the decision is yours, Q7):
- **BLOCK for CASH.** A drawer cannot physically pay out money it does not hold. If the system says it would, either
  the money is missing or a funding was not recorded, and both should stop the line.
- **WARN for BANK** (with the A17 line), because the system's bank figure lags the GM's deposits by nature.
- **Same rule for every outflow**, including sale void refunds and repayments to the GM. One rule, no exceptions to
  explain.
- **A recovery path within a minute:** the message names the shortfall and says "Ask the General Manager to record an
  advance". The GM can record it from the phone (Cash page, password), and the branch retries.

If you prefer BLOCK for both, the plan is the same, with BANK in the locked set. A `cash.negativeBalancePolicy` GM
setting (BLOCK or WARN per account) is possible, but its default would be a guess at client policy, so I do not
propose one unless you ask.

### 5.3 Opening day

- The GM records the opening money as **advances**:
  - the float placed in the drawer → `GM_ADVANCE` to CASH;
  - the bank funding → `GM_ADVANCE` to BANK, with the bank reference.
- SPEC §9's "books start at zero cash" becomes "books start at zero; the first money in is the GM's recorded advance".
- **With BLOCK:** the first steps on the GM home (REM-3) get a **fifth step, "Fund the branch"**. It is done when
  every active branch has an advance on CASH. Otherwise the first scrap purchase is refused on day one with no
  explanation on the home. Without BLOCK the step is optional (Q8).
- **Is all opening money a loan to be repaid?** That depends on Q11 (capital vs advance).

### 5.4 Effect on attention, reconciliation, REH-1 and the samples

- **A4 (count difference) and A5 (no count):**
  - unchanged mechanics: once advances are recorded, expected cash is real, and A4 fires only on a real difference;
  - an advance recorded **after** that day's count changes the day's expected cash and can raise A4 for a matched
    count. The answer is to record the advance when the money moves;
  - advances are not backdated (Q12).
  - An advance is a cash movement, so A5 expects a count the next day. That is correct.
- **Reconciliation screen:**
  - two new lines per account ("GM advances" and "GM repayments") in both languages;
  - the scrap drill-down;
  - corrections shown under their original line (Q9).
- **REH-1:**
  - right after branch A is created, the GM records a test advance to CASH and to BANK, through the UI, with password
    re-confirmation;
  - the −335,000 disappears **because the money is recorded**: the drawer is the advance − 285,000 − the making charge
    + cash sales;
  - checks are added for:
    - a split scrap purchase (both parts; the cash line counts only the cash part);
    - the BLOCK refusal and its message;
    - "owed to the GM" on Cash;
    - a repayment;
    - a correction;
    - the funding routes answering 403 to the branch manager and the cashier;
  - UI-B's A4 check returns to branch A.
- **dev:sample:** records a test advance per branch before the purchases, so the sample's −647,810 disappears for
  the same reason.
- **Fixture world (backend tests):** records an advance per branch on its first day before any outflow. Tests that
  assert exact drawer figures are updated by the same amount, with the change explained in the commit.
  `home-numbers.test.ts` keeps its identities (expected cash = the drawer).
- **e2e-states, e2e-print, capture:** fund the world's branches through the API before their cash outflows.

---

## 6. Cost visibility and security

- **Field classification** (`shared/src/field-classification.ts`):
  - `gm_funding_events`: every column **SAFE**. They are money movements of a branch, like `ledger_entries` and
    `hasad_receivable_settlements`, and not cost or profit.
  - `scrap_purchases.cash_amount`, `bank_amount` and `bank_reference`: **SAFE**, like `amount` and `payment_method`
    today.
  - The response words `owedToGm`, `cashAmount`, `bankAmount`, `advances`, `repayments` and `account` go into SAFE.
  - No new COST field.
- **Visibility is by permission, not classification:**
  - `funding.view` and `funding.manage` are the GM's only;
  - the branch manager **does see** the two new reconciliation lines for their own branch. Without them their drawer
    would not add up (SPEC §18.10), and the amounts are drawer movements, not cost;
  - the branch manager **does not see** the amount owed, the reasons or the history.

  Whether the branch manager may see "owed to the GM" is Q10.
- **No new route for the cashier** (`cash.view` already excludes them). The generated matrix tests prove:
  - 403 for BM and cashier on every `/funding` route;
  - 403 for cross-branch access;
  - `cost-visibility.test.ts` gets a concrete request for `GET /funding` (GM).
- **The attention list:** no funding line carries a cost (A17 is a balance, and only if WARN is chosen).
- **Operator CLI:** **none needed.** Every correction goes through a GM REVERSAL in the app, with password and audit.
  The append-only rules stand. If the GM account is locked, the existing operator unlock (D-lock-1) applies.

---

## 7. Tests

**Unit and integration (both projects, PGlite and PostgreSQL):**
- `funding.test.ts`:
  - advance and repayment on CASH and BANK move both accounts;
  - `owed = Σ` (per branch and total);
  - a repayment above the amount owed is refused;
  - the bank reference is required for BANK and normalized;
  - the reason is required (3–300);
  - a correction reverses both entries, only once (a second answers 409);
  - correcting an advance that would make the amount owed negative is refused;
  - audit rows, both languages;
  - an idempotent replay returns the same event, and a refusal consumes no key;
  - password re-confirmation is required (403 with the re-auth code).
- `scrap-split.test.ts`:
  - the parts must add up;
  - a 0 part posts nothing;
  - the bank part needs a reference;
  - the label (CASH / BANK_TRANSFER / SPLIT) follows the parts;
  - the database check refuses an inconsistent row inserted directly;
  - `reverseRef` reverses both parts;
  - the list shows both parts.
- `ledger.test.ts`:
  - the reconciliation lines still add up for every branch and day of the fixture world, now with advances,
    repayments, corrections and split purchases;
  - the cash line counts only the cash part of a split purchase;
  - the guardrail test (every event type has a line or an OTHER reason);
  - corrections land under their original line (if Q9 is accepted).
- **Negative balance** (per the decision on Q7):
  - BLOCK refuses each outflow kind (scrap cash part, making charge, void refund, repayment) with the message;
  - a balance of exactly 0 after the outflow is allowed;
  - WARN raises A17 and clears it after an advance.
- **Migrations:**
  - 0020 on a database with branches: each gets OWED_TO_GM, with no entries;
  - 0021 backfills by method;
  - guard (a) stops on a mismatch with the ledger, and guard (b) stops per Q1;
  - after 0021 an UPDATE on `scrap_purchases` is still refused, and the trigger is enabled.

**Concurrency, real PostgreSQL** (`backend/test/pg/funding-race.test.ts`, like `pg/settlement-race`):
- many parallel repayments: total repaid ≤ owed, never below 0;
- a repayment racing the correction of an advance: exactly one succeeds when both cannot;
- (BLOCK) parallel scrap purchases and making charges on one drawer never take it below 0;
- the lock order holds: a purchase with both parts against a repayment, no deadlock in 200 runs.

**Route matrix:** the generated allow, deny and cross-branch tests for the four new routes and the changed scrap
route (`phase1b.test.ts` SAMPLE and CROSS rows); `cost-visibility.test.ts` gets the GET request.

**REH-1 and e2e:** as listed in §5.4.
- e2e-states adds:
  - the funding panel's states (loading, error, empty "No advances recorded yet");
  - the BLOCK refusal shown inline in the scrap form;
  - the split inputs (the bank part fills itself, the reference appears only when the bank part > 0);
  - axe.
- e2e-print: unchanged (no scrap print exists).

---

## 8. Order and commit sequence

**Recommended order: B → A → C.**
- B gives the system a way to record the money that is really there, so the negative drawer goes away for the right
  reason.
- A is self-contained.
- C comes last because its block check covers both of A's parts and its recovery path is B's advance.

Each commit: suite green (both projects) and pushed; REH-1 and e2e-states where the commit touches them.

| # | Commit | Migration |
|---|---|---|
| 1 | **B backend:** account kind, event types, `gm_funding_events`, permissions, service (lock, cap, corrections), routes and matrix, reconciliation lines, audit, i18n keys; `funding.test.ts`, `pg/funding-race.test.ts`, migration test | **0020** |
| 2 | **B screens and data:** the Cash page funding panel (GM), the two reconciliation lines; REH-1 records the opening advances; `dev:sample`, fixture world and e2e fund their branches; e2e-states; the GM home row only if Q10 says yes | — |
| 3 | **A backend:** columns, backfill with guards, checks, `buyScrap` with parts, API, list; `scrap-split.test.ts`, migration tests | **0021** |
| 4 | **A screens:** the split inputs on the scrap form, the list column, the Cash drill-down "Scrap purchases (n)"; REH-1 and e2e checks | — |
| 5 | **C:** the decided policy (BLOCK locks, or WARN with A17), the fifth first step if BLOCK, tests, REH-1 refusal check | — (no migration either way) |
| 6 | **Docs and evidence:** D-csh-1…, `docs/acceptance/CSH-2.md`, BACKLOG (CSH-2 done, old item renamed CSH-3), SPEC §9 and §18, DATA_MODEL, slim screens of the changed screens; all gates | — |

---

## 9. Effort

| Piece | Estimate | Why |
|---|---|---|
| B: funding and owed to the GM | **M (about 2½ days)** | One table, one account kind, four routes, locking, corrections, concurrency tests, Cash panel, and the data set-ups (fixture, sample, REH-1, e2e) |
| A: split payment on scrap | **M (about 1½ days)** | A migration on an append-only table with two guards, API change, form, drill-down |
| C: negative balances | **S–M (½ to 1 day)** | WARN is ½ day (attention line). BLOCK is about 1 day (locks on every outflow, the first-steps step, test updates) |
| Docs, acceptance, screens, gates | **S (about ½ day)** | |

---

## 10. Questions for the owner (recommendation after each)

| # | Question | Recommendation |
|---|---|---|
| Q1 | **Existing bank-paid scrap purchases have no bank reference** (the field never existed). The validated reference check fails on them. Stop the migration (as FIX-2: pre-production databases are recreated), or exempt rows recorded before this change through a marker column? | **Stop, as FIX-2.** No production database exists; a marker column would keep a permanent exception |
| Q2 | **Supplier making charges**: one source today (drawer or bank), no bank reference. Split them too, or at least require a reference when paid by bank? | **Not now**; ask the client whether making charges are ever paid partly by transfer. Adding a reference for bank is small and can ride with A if you want it |
| Q3 | Keep `payment_method` on scrap purchases with a third value `SPLIT` (derived from the parts, enforced by a check), or drop it? | **Keep with `SPLIT`**: lists, filters, reports and the Hasad-footprint gate keep working unchanged |
| Q4 | Flag a **duplicate bank reference** on scrap purchases (as for sales, with "record anyway")? | **No**: an outgoing transfer is issued by the shop itself; the check exists for incoming customer transfers |
| Q5 | **The GM pays a seller personally**: accept the two-step flow as is, or add a "paid directly to a seller" marker and a link to the purchase on the advance (§3.6)? | **Add the marker and link** (no third payment method); it explains the pass-through on Cash |
| Q6 | A **void of a scrap purchase** (none exists; a wrong purchase cannot be undone today). Add one, GM only, with REVERSAL entries? | **Separate item**, not in CSH-2; the split design already reverses both parts |
| Q7 | **Negative balances: BLOCK or WARN, per account?** | **BLOCK for CASH, WARN for BANK (A17)**, the same rule for every outflow including void refunds; your decision |
| Q8 | With BLOCK: a fifth first step "Fund the branch" on the GM home? | **Yes** with BLOCK; no step with WARN |
| Q9 | Show a **correction (REVERSAL)** under the line of the entry it corrects, instead of "Other"? | **Yes** (all event types, not only funding); the day still adds up |
| Q10 | Where "owed to the GM" shows: the **Cash page only**, or also one row in the GM home's "Gold position" panel? And may the **branch manager** see the amount their branch owes? | **Cash page only** for now (the home is reviewed in UI-C); **GM only** |
| Q11 | **Is all GM funding a loan to be repaid?** If the bank funding (fact 1) is capital the owner never takes back, recording it as an advance makes "owed to the GM" grow forever. A `GM_CAPITAL` event would then be needed | **Ask the client.** Until then: advances only; a capital event is additive later (one more event type, no rework) |
| Q12 | May an advance be **backdated** to when the money actually moved (e.g. the GM gave cash yesterday evening)? | **No**: the ledger time is the recording time; a note says when the money moved |
| Q13 | The old BACKLOG "CSH-2" (cash-out for the staff operating amount, Q-6): rename to **CSH-3**? | **Yes**, still blocked on Q-6. It may be one more GM ↔ branch movement (see §11) |

---

## 11. Open client questions (kept open, not guessed)

- Is an **end-of-day cash count** expected? Is the drawer **topped up or emptied** each day, and by whom? If it is
  emptied to the GM, that is a GM_REPAYMENT, or a movement of its own (a "cash pick-up"), depending on Q11.
- The **printed wording** on a purchase receipt when the payment is split (there is no scrap receipt yet; SCR-1,
  Q-12).
- **Split payment on sales** (separate; SPL-1, Q-7). Out of scope here.
- Whether **any other money movement** exists between the GM and a branch besides advance and repayment. Examples:
  - capital (Q11);
  - the GM taking profits out of the bank: today only a repayment exists, and it is capped at the amount owed;
  - the staff operating amount (Q-6, CSH-3);
  - transfers between branches (MNY-1, Q-8).

---

## 12. Documents written with the implementation

- **`docs/decisions.md` §21, decisions D-csh-1 …:**
  - the OWED_TO_GM account and the derived amount owed;
  - funding events and corrections;
  - the repayment cap and the lock order;
  - split payment on scrap and the backfill by method;
  - the negative-balance policy as decided;
  - visibility (permissions, field classes);
  - opening day.
- **`docs/acceptance/CSH-2.md`:** gates, a test map for each rule above, and a manual owner checklist for a
  Codespace:
  1. fund a branch (cash and bank);
  2. buy scrap part cash, part transfer;
  3. check the Cash lines and the drill-down;
  4. try a purchase larger than the drawer (BLOCK message, or the WARN line);
  5. repay and correct;
  6. sign in as the branch manager: the funding routes are refused and the lines show.
- **SPEC §9** (opening money, funding) and §18.10 (new lines); `docs/DATA_MODEL.md` (the table, account kind and
  columns); **BACKLOG** (CSH-2 done; CSH-3; a scrap void if Q6 says so).
