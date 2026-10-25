# PAY-1: split payments (SPL-1) and Hasad as a sales channel only (HSD-2)

Branch `claude/pay-1-split-hasad` from main `7351065` (OPN-2, FIX-5 and OPN-FIX merged; last migration 0032, so PAY-1
starts at **0033**). Money-touching: this plan is committed and pushed, then **stop for the owner's approval**. Nothing
is implemented before it.

Sources read: CLAUDE.md, BACKLOG SPL-1 and HSD-2, SPEC §9, §10, §20 Q-7, decisions D-dec1-5, D-2a-5, D-2b-4, D-2b-6,
D-2b-7, D-4-6, D-4-14, D-fix-2, D-csh-7, D-csh-9, D-rem2-1; the sales, void, ledger, reconciliation, Cash drill-down,
sales report, print, POS, Cash and sales screens, the fixture world, perf and REH-1.

## 0. Owner decisions taken (not reopened)

- A sale is paid by **1 or 2 payment lines**: method, amount, reference. The lines **sum exactly** to the sale total
  (whole SDG, no rounding), otherwise the sale is refused.
- **Bank transfer** lands in the **branch's** bank account; its reference stays required, normalized and validated
  (D-fix-2), with the duplicate-reference warning (409, audited when confirmed).
- **Hasad** money lands in the **General Manager's own account**, never in the branch. Hasad stays a payment method
  (Hasad invoice number required, transaction reference optional) and becomes its own **channel** in the reports and
  the daily summary.
- `HASAD_RECEIVABLE` and the settle-by-bank action go. The branch reconciliation never expects Hasad money; a Hasad line
  moves no branch balance.
- The invoice and the receipt print **one line per method** (with its reference).
- Idempotency-Key claimed in the transaction, row locks, audit (D-2b-6). A void reverses each line through its own
  method. No discounts, rounding or stones change.

## 1. Data model

### 1.1 A new append-only table `sale_payments` (recommended)

| Column | Type | Rule |
|---|---|---|
| `id` | serial PK | |
| `sale_id` | integer FK `sales.id` | NOT NULL |
| `line_no` | smallint | 1 or 2; `UNIQUE (sale_id, line_no)` |
| `method` | text | one of `PAYMENT_METHODS`; `UNIQUE (sale_id, method)` (§2.2) |
| `amount` | bigint | `> 0`, whole SDG |
| `ref_invoice` | text | the Hasad invoice number: required for HASAD, NULL otherwise |
| `ref_transaction` | text | BANK_TRANSFER: the bank reference, required, 4–40 characters (same check as today's sales check); HASAD: optional transaction reference; NULL for the other methods |
| `created_at` | timestamptz | default now() |

- Index `sale_payments (sale_id)` (the UNIQUE covers it) and `sale_payments (method, ref_transaction)` for the
  duplicate-reference check.
- **Append-only** (`jerp_forbid_modification` triggers for UPDATE, DELETE, TRUNCATE, `jerp_lock_append_only`), listed in
  `APPEND_ONLY_TABLES` (`backend/src/core/startup.ts`). A void never touches the lines: the sale's status says it.
- **A deferred constraint trigger** (`DEFERRABLE INITIALLY DEFERRED`, on INSERT into `sales` and into `sale_payments`)
  checks at commit that every sale has **1 or 2 lines** and **Σ amount = sales.total**. The database itself refuses a
  sale without lines or with a wrong sum, whatever writes it.

Why a table and not two column pairs on `sales` (the CSH-2 shape): a sale line needs its own method **and** its own
references (a Hasad + bank sale has three references), and the owner expects lines. The scrap shape (`cash_amount`,
`bank_amount`) only works for two fixed methods.

### 1.2 What happens to the existing columns of `sales` (recommended)

- **`sales.payment_method` stays, as a stored label**: the line's method for a one-line sale, **`SPLIT`** for two lines
  (as D-csh-7). A check ties it to the lines (in the deferred trigger: `SPLIT` ⇔ 2 lines, otherwise = the one line's
  method). The sales list, its CSV walk (PERF-1) and the dashboard keep reading one column, no join for the label.
  Display of `SPLIT` is built from the lines ("Cash + bank transfer", "Hasad + cash"…), never from a fixed text.
- **`sales.payment_ref_invoice` and `sales.payment_ref_transaction` are frozen**: kept with their history (never
  rewritten), copied into the lines by the backfill, **no longer written** for new sales. Every reader reads the lines.
  Their two checks (`ck_sales_hasad_reference`, `ck_sales_bank_transfer_reference`) are dropped in 0035 because the line
  checks enforce the same rules (destructive marker, **D-pay1-3**). Dropping the columns is not part of PAY-1.

### 1.3 Converting existing sales (forward-only)

- **0033 (additive):** the table, its checks, indexes and append-only triggers; `SPLIT` added to the
  `sales.payment_method` check (a replaced check: marker, D-pay1-3). Nothing existing changes. The deferred trigger is
  **not** created yet (old code still writes sales without lines).
- **0034 (backfill, guarded):** one line per existing sale (`line_no` 1, its method, `amount = total`, its references).
  The guard **stops and changes nothing**, naming the sales, when:
  - a sale's own `SALE` ledger entries disagree with it (the sum differs from its total, or an entry's payment method
    differs from the sale's method), or
  - a sale would break a line check (a BANK_TRANSFER sale without a valid reference, a HASAD sale without an invoice
    number: impossible after 0018 and 0014, but checked).

  A sale recorded before the ledger (no entries) is converted from its own method, as the void already treats it.
- **0035 (tighten):** the deferred constraint trigger (1–2 lines, sum, label); the two old sales reference checks
  dropped (D-pay1-3).
- **0036 (HSD-2 removal, guarded):** §4.

The drizzle migrator runs every pending migration in **one transaction** on PostgreSQL: a guard failure in 0034 or 0036
rolls back 0033–0036 together. The upgrade tests check that a stopped upgrade leaves the database at 0032 exactly.

### 1.4 Every reader, and how it keeps working

| Reader | Today | After PAY-1 |
|---|---|---|
| `createSale` (sales/service) | one method, refs on `sales`, one ledger entry | lines inserted, one entry per CASH/BANK line, nothing for HASAD (§3) |
| Duplicate bank reference | `sales.payment_method='BANK_TRANSFER'` + `sales.payment_ref_transaction` | `sale_payments` BANK_TRANSFER line with the same normalized reference, joined to a COMPLETED sale of the same branch; same 409 and audit |
| `voidSale` | refund = Σ SALE CASH entries; pre-ledger fallback by method | unchanged rule (reverseRef reverses every CASH and BANK entry of the sale); pre-ledger fallback from the **lines**; the response says how much of it was Hasad (§3.4) |
| Sales list and CSV (`saleListBase`, `pageSales`) | method + bank ref on the row | label from `sales.payment_method`; `payments[]` fetched per page with the sale lines (one indexed query by the page's sale ids, like the item lines today); CSV columns §5.3 |
| Sale detail | method + refs | `payments[]` (one row per method, amount, reference) |
| Invoice and receipt (print/service, `shared/src/print.ts`) | `paymentMethod`, `hasad{}`, `bankTransfer{}` | `payments[]`: one printed line per method with its amount and reference |
| Sales report by channel (`salesReportAggregates`, `salesByChannel`) | group by `sales.payment_method` | Σ line amounts by line method, plus Hasad versus direct (§5) |
| Daily reconciliation (`ledger.reconciliation`) | `salesByMethod` / `voidsByMethod` from entries incl. HASAD_RECEIVABLE; `hasadReceivableToBank` | CASH and BANK lines from entries (unchanged per entry); Hasad figures from lines, outside the money (§5.2); settlement line removed |
| Cash drill-down "Bank-transfer sales" | SALE entries with BANK_TRANSFER joined to `sales.payment_ref_transaction` | same entries, the reference from the sale's BANK_TRANSFER line; the amount is the **line's** (still adds up to the bank-transfer sales line) |
| `drawer()` | `hasadReceivable` per branch | field removed |
| Cost and profit (`cost_total`, `sale_items.profit`, unknown cost) | independent of payment | **unchanged**; a test proves it for split sales |
| Sale-line snapshots (names, karat, weights, prices) | independent of payment | **unchanged** |
| Dashboard and homes (revenue, count, trend) | `sales.total`, `count(*)` | **unchanged**: a Hasad sale is a sale; revenue includes it (§5.4) |
| Audit `SALE_CREATED` / `SALE_VOIDED` | `payment: method`, `bankReference` | `payment: label`, metadata `payments: [{method, amount, reference}]`, `duplicateBankReferenceOf` as today |

## 2. Validation

1. **1 or 2 lines** only; each **amount > 0** (an integer, BigInt-safe); **Σ = total exactly**, the total being the
   server's total at confirmation (PRC-1 prices are recomputed then). The price check (409 reprice) comes first; then a
   mismatch answers **422 `PAYMENT_TOTAL_MISMATCH`** with the total and the sum, and writes nothing.
2. **The same method twice in one sale: refused (recommended).** No stated use; one line per method keeps "one printed
   line per method" true, keeps the duplicate-reference check and the bank drill-down one row per sale, and makes the
   void's per-method reversal unambiguous. Enforced by the API and by `UNIQUE (sale_id, method)`. **[OPEN Q1]** Is two
   bank transfers (or two Hasad invoices) for one sale ever needed?
3. **Allowed pairs:** any two **different** methods the counter accepts. **[OPEN Q2]** Is **Hasad + bank transfer**
   allowed? Recommended: yes (no rule forbids it; the owner's examples are cash + bank and Hasad + cash).
4. **References per line:**
   - CASH, CARD, MOBILE_WALLET: none (a reference is refused, as today);
   - BANK_TRANSFER: `refTransaction` required, normalized and validated by `shared/src/references.ts` (D-fix-2);
     `refInvoice` refused;
   - HASAD: `refInvoice` required (free text, D-fix-2 leaves Hasad references untouched); `refTransaction` optional.
5. **`sales.posPaymentMethods` per line:** every line's method must be in the setting, otherwise 400
   "{method} is not accepted at the counter". CARD and MOBILE_WALLET stay refused unless enabled.

## 3. Ledger

### 3.1 Posting

- In the same transaction as the sale: **one entry per CASH or BANK line** (CASH → CASH; BANK_TRANSFER, CARD,
  MOBILE_WALLET → BANK, as `PAYMENT_ACCOUNT` today), event `SALE`, the entry keeps its line's method and the sale ref.
  A one-line sale posts exactly what it posts today.
- **A HASAD line posts nothing** to any branch account. `PAYMENT_ACCOUNT.HASAD` becomes `null` and the type says so
  (`accountKindFor` returns no account; the caller skips it).

### 3.2 What proves a Hasad sale

The **`sale_payments` line itself** (method HASAD, amount, Hasad invoice number, optional transaction reference) in the
same transaction as the sale, its stock movements and its audit row. It is append-only and is the only Hasad money
record in the system; there is no ledger entry for it because no branch account holds that money.

### 3.3 How it appears as "money received by the General Manager's account"

A figure read from the lines (Σ HASAD lines of COMPLETED sales, by branch and day or period), labelled
"Hasad (paid to the General Manager's account)" / "حصاد (يُدفع إلى حساب المدير العام)", shown in the sales report and
the daily reconciliation **beside** the branch money, never inside expected cash or bank (§5). There is no GM account
in the ledger and PAY-1 does not add one. **[OPEN Q3]** Does the General Manager need a statement of Hasad money per
period beyond the report (e.g. to match Hasad's payouts to him)? Recommended: not in PAY-1.

### 3.4 Void

- The sale row is locked first (as today); every CASH and BANK entry of the sale is reversed as `SALE_VOID` through its
  own method (`reverseRef`). The cash refund = Σ the sale's CASH entries; `lockDrawerFor` and **409 `DRAWER_SHORT`**
  apply to it exactly as today (a split cash + bank sale refunds the cash part from the drawer, the bank part from the
  bank, which may go below zero with A17 per D-csh-8).
- **The Hasad line moves no branch money.** The void response carries `hasadAmount`; the void dialog says before
  confirming: "X of this sale was paid through Hasad to the General Manager's account. Voiding does not return it; the
  General Manager refunds the customer through Hasad." **[OPEN Q4]** Is that the Hasad refund process, or should a void
  of a Hasad sale be refused / restricted to the General Manager?
- A pre-ledger sale's void keeps its stand-alone refund entry, computed from its (backfilled) lines.

## 4. HSD-2 removal

| What | How |
|---|---|
| `POST /cash/hasad-settlements`, `GET /cash/hasad-settlements` | routes, matrix entries and generated role tests removed |
| permission `cash.settle_hasad` | removed from `shared/src/permissions.ts`; 0036 deletes its `role_permissions` and `permissions` rows (marker) |
| `settleHasadReceivable`, `listHasadSettlements` | removed from `ledger/service.ts` |
| account kind `HASAD_RECEIVABLE` | removed from `LEDGER_ACCOUNT_KINDS`; 0036 redefines the per-branch account-creation trigger function (`CREATE OR REPLACE`), deletes the empty `HASAD_RECEIVABLE` `ledger_accounts` rows and replaces the account-kind check (markers) |
| event `HASAD_RECEIVABLE_SETTLEMENT` | removed from `LEDGER_EVENT_TYPES`, `LINE_OF_EVENT`, `RECONCILIATION_LINES`; the event-type check replaced (marker) |
| audit action `HASAD_RECEIVABLE_SETTLED` | removed from the enum (the guard proves no row uses it) |
| table `hasad_receivable_settlements` | **dropped** (marker), with its checks, index and triggers; removed from the schema, `APPEND_ONLY_TABLES`, db-checks and the field classification |
| fields `hasadReceivable`, `hasadReceivableToBank`, `hasadReceivableBalance` | removed from responses and the classification |
| Cash screen: Hasad receivable column, "Settle Hasad receivable" button and dialog, "Hasad transfers" list, the reconciliation line | removed, with their Arabic and English strings |
| tests and scripts | `pg/settlement-race` (Hasad part), ledger, phase4, rem5, funding, flow, cost-visibility, phase1b/2a matrix lists, the fixture world's settlement loop, perf's HASAD_RECEIVABLE inserts, REH-1's settlement steps, e2e scripts touching it |
| `scripts/hasad-footprint-allowlist.json` | the **RECEIVABLE** category removed; no entry added; `check:hasad` must pass with a smaller footprint (the count before and after goes in the report) |
| `check:drizzle`, `check:docs` | schema and migrations agree; DEPLOYMENT/route matrix/decisions updated |

**Guard of 0036 (stops and changes nothing, naming what it found):**
- any row in `hasad_receivable_settlements`;
- **any** `ledger_entries` row on a `HASAD_RECEIVABLE` account, whatever its balance (a voided Hasad sale leaves a zero
  balance but two entries; deleting them would delete history, so they cannot be "converted");
- any `HASAD_RECEIVABLE_SETTLEMENT` entry or `HASAD_RECEIVABLE_SETTLED` audit row.

Consequence: **any database that ever recorded a Hasad sale stops at 0036.** There is no production database yet (the
installation is pre-production); such databases are recreated, as FIX-2 (Q1) and CSH-2 (Q1) decided. **[OPEN Q5]**
Confirm: stop and recreate (recommended), or keep `HASAD_RECEIVABLE` as a frozen legacy account (no new entries, its old
entries kept and shown as history), which keeps the removed code paths alive in every reader.

**Destructive statements**, each with `-- allow-destructive: D-pay1-4 <reason>`: the dropped and replaced checks, the
`DELETE` of the empty accounts and the permission rows, the `DROP TABLE hasad_receivable_settlements`, the dropped
triggers. D-pay1-4 is written in `docs/decisions.md` in the same commit and needs the owner's approval of this plan.

## 5. Reports and the daily summary

There is no screen called "daily summary" today; **the daily reconciliation (Cash) is that summary**, and the sales
report is its period view. **[OPEN Q6]** Confirm that, or name the screen meant.

### 5.1 Sales by channel (sales report)

- Computed from the **lines** of the period's COMPLETED sales: one tile per method, **amount = Σ that method's line
  amounts**, so the tiles add up to the report's total exactly.
- Two figures added: **Hasad** (Σ HASAD lines: paid to the General Manager's account) and **Direct** (Σ the other
  lines: the branch's cash and bank), Hasad + Direct = total.
- The **sale count is never double-counted**: the report's count stays `count(*)` of sales; a per-channel count (if
  shown) counts the sales with a line of that method and is labelled so; a "split sales" count shows how many have two
  lines.

### 5.2 Daily reconciliation

- **Expected cash and bank exclude Hasad**: cash and bank lines come from ledger entries, and a Hasad line has none.
- `salesByMethod` keeps one row per method; the CASH and BANK rows come from entries as now (a split sale's cash line
  is in CASH, its bank line in BANK_TRANSFER); the **HASAD row comes from the lines** and is shown apart, under
  "Not in the branch: Hasad (paid to the General Manager's account)". Same for `voidsByMethod`.
- A **Hasad versus direct** block for the day: Hasad sales, direct sales (cash + bank), their sum.
- The "Hasad receivable → bank" line is gone.

### 5.3 Columns that change meaning (stated in the acceptance script)

| Where | Column / figure | Change |
|---|---|---|
| Sales list, CSV, report rows | Payment | may read **Split** (both methods shown) |
| Sales CSV | new: Payment 1 method, amount, reference; Payment 2 method, amount, reference | the bank reference column now comes from the bank line |
| Sales report summary | per-method tiles | Σ line amounts instead of Σ totals of sales of that method; a split sale contributes to two tiles |
| Reconciliation | `salesTotal` / `voidsTotal` | **branch money only** (cash + bank); Hasad is reported beside it (`hasadSales`, `hasadVoids`) |
| Reconciliation | HASAD row | informational, outside the movement (it was the receivable's movement) |
| Cash drill-down | amount | the sale's bank line, not the sale total |

### 5.4 Not changed

Dashboard, homes and attention: revenue, counts and profit include Hasad sales (they are sales); none reads the
receivable except `drawer().hasadReceivable`, removed. Cost and profit lines are unchanged.

## 6. POS (Arabic, RTL)

- The payment area offers **"One method"** (default, today's flow) or **"Split"** (تقسيم الدفع).
- Split: two rows, each a method picker (only the accepted methods; the second excludes the first) and a `MoneyInput`.
  The **second amount is prefilled with the remainder and kept equal to total − first** as the first changes (read-only,
  computed); a first amount of 0 or ≥ total shows "Each part must be more than 0 and less than the total".
- References shown **per row** for its method (bank reference; Hasad invoice number and optional transaction reference),
  with the same inline rules as today.
- **Confirm stays disabled** until the sum equals the total and every row is valid; the server's 422 is shown inline if
  it still happens (a price change between screens).
- The duplicate-reference 409 shows the existing confirmation for the bank row.
- **One Idempotency-Key per attempt** (D-2a-5): the cart's key covers the payment choice; it changes only after
  success, never when the cashier edits the split.
- The receipt and the invoice (print and on-screen) print **one line per method**: method, amount, reference.

## 7. API shape

```
POST /sales  (Idempotency-Key)
{ items: [...], customer…, priceChangeReason?, confirmDuplicateReference?,
  payments: [ { method, amount, refInvoice?, refTransaction? } ]   // 1 or 2
}
```

- **The old shape stays accepted** (recommended, as D-csh-9): `paymentMethod`, `paymentRefInvoice?`,
  `paymentRefTransaction?` means **one line of the whole total**. **Both shapes at once: 400.** Strict schemas.
- Why: 39 test files, the fixture world, `dev:sample`, the perf script, REH-1 and the e2e scripts post the old shape;
  keeping it lets the commits stay small and the suite green, and no existing test changes for the API alone. New tests
  cover `payments`. The POS posts `payments` always. **[OPEN Q7]** Keep the old shape permanently, or remove it in a
  later item once every caller is moved?
- Responses: `payments[]` added to the sale (detail, create, list rows); `paymentMethod` stays (label, now possibly
  `SPLIT`); `paymentRefInvoice` / `paymentRefTransaction` stay in responses for one-line sales as read from the line
  (kept so old readers work), removed from new screens.

## 8. Concurrency

- **Lock order (fixed):** the sale row (`FOR UPDATE`, voids) → the pieces (ascending id) → the ledger accounts
  (ascending id, `lockAccounts` / `lockDrawerFor`). Create takes pieces → accounts. No path takes them in another order.
- **Two voids of the same split sale:** the second waits on the sale row, then sees VOIDED and gets 409; every entry is
  reversed once (the refusal comes before any reversal, under the sale's row lock).
- **A void racing a report:** a report reads in one statement (or one snapshot); the sale's status, its lines and its
  entries are written in one transaction, so a report sees the sale before or after, never half; lines never change.
- **Double submit with the same key:** the key is claimed in the transaction (D-2b-6): the second blocks on the unique
  index, then replays; one sale, one set of lines and entries.
- **Real PostgreSQL race test** `test/pg/split-sale-race.test.ts`: parallel voids of one split sale; void vs the sales
  report and the reconciliation (totals always consistent); same-key double submit; split sales selling the same piece;
  a cash-part void racing a GM repayment on a short drawer. Run ≥ 10 times, failures reported.

## 9. Tests

- **Property tests** (`shared` and backend): random totals and random splits always sum; the POS remainder rule;
  for random sequences of one-line and split sales and voids per branch, **ledger CASH = Σ CASH lines − voided** and
  **BANK = Σ bank-account lines − voided**; a void restores every balance exactly; **Hasad lines never move a branch
  balance**.
- **Service tests (both projects):** every pair of methods; 1, 2, 3 lines; amount 0, negative, fractional; sum off by 1
  either way; the same method twice; references per method; methods outside `posPaymentMethods` per line; both shapes
  at once; the duplicate bank reference on a split sale (409, confirmed and audited); void of each kind (cash+bank,
  Hasad+cash, Hasad only, pre-ledger); `DRAWER_SHORT` on a split void; idempotent replay; every reader of §1.4
  before/after; cost and profit unchanged; the bank drill-down adds up with split sales; the database refuses a sale
  without lines or with a wrong sum (deferred trigger).
- **Upgrade tests from 0032 with real data:**
  - a database with CASH, BANK_TRANSFER, CARD (enabled), pre-ledger and voided sales and no Hasad: converts; one line
    per sale equal to its total; nothing else changes; balances unchanged;
  - the same plus a Hasad sale (receivable entries), and separately plus a settlement row: **stops at 0036**, the
    database stays at 0032;
  - a sale whose entries disagree with it: **stops at 0034**.
- **Route matrix and generated role tests** (the removed routes and permission; the changed sales responses),
  **cost-visibility** (new fields SAFE), the field-classification test.
- **Browser:** `e2e-prices`, `e2e-print` (one line per method on receipt and invoice), `e2e-states` updated; the
  Hasad settlement steps removed wherever they exist.
- **REH-1 additions:** a split sale cash + bank; a split Hasad + cash; a mismatched split refused (Confirm disabled, and
  the server's 422 through the API); a void of each split sale (drawer and bank back exactly, Hasad untouched); the
  reconciliation excludes Hasad and shows Hasad versus direct; the sales report by channel; the removed Cash screen
  parts are absent. The report states the new and previous counts (278 before).

## 10. Commits

| Commit | Content |
|---|---|
| c0 | this plan (then stop) |
| c1 | migrations 0033 (additive) and 0034 (backfill + guard), schema, db-checks, classification of the new table, `APPEND_ONLY_TABLES`, upgrade test for 0034, DEPLOYMENT/decisions (D-pay1-1…3). No behaviour change. |
| c2 | sales service: `payments`, validation, per-line posting, Hasad posts nothing, duplicate check and void on lines, old shape as one line; 0035 (deferred trigger, old checks dropped); every backend reader of §1.4 except reports; property and service tests; matrix/role/cost-visibility; REH-1 updated for the response changes |
| c3 | reports and reconciliation: channels from lines, Hasad versus direct, drill-down; tests; REH-1 |
| c4 | HSD-2: 0036 + guard, removal of §4, fixture world, perf, sample, allow-list, check:hasad; upgrade tests; REH-1 |
| c5 | screens: POS split, Arabic/English strings, sale detail/list, void dialog, Cash reconciliation; print one line per method; e2e scripts; REH-1 |
| c6 | `pg/split-sale-race`, perf vs PERF-1, `docs/acceptance/PAY-1.md`, SPEC/BACKLOG/FEATURES/DATA_MODEL, `verify -- --full`, report |

Every commit keeps the suite green and REH-1 green and is pushed; REH-1 changes ride in the commit that changes the
route, response or screen. No pull request is opened.

## 11. Risks

- **Every database with a Hasad sale stops at 0036** (Q5). Fine pre-production; it must be stated before any
  installation holds real data.
- **PERF-1:** the CSV walk gains one indexed query per page for the payment lines (expected small; it is already over
  budget). Measured and compared with PERF-1 in the final report.
- **Reprints of old sales** show the new payment block (one line per method with its amount): the content is the same
  money, the layout differs from the original print.
- **Report meaning changes** (§5.3): the reconciliation's sales total no longer includes Hasad.
- **Migration size:** 0036 is destructive (guarded); a mistake would be caught by the upgrade tests on both PGlite and
  PostgreSQL.

## 12. Questions for the owner

1. **[OPEN Q1]** The same method twice in one sale (two bank transfers): refuse (recommended)?
2. **[OPEN Q2]** Hasad + bank transfer in one sale: allowed (recommended)?
3. **[OPEN Q3]** A Hasad statement for the General Manager beyond the report: not in PAY-1 (recommended)?
4. **[OPEN Q4]** The Hasad part of a voided sale: the void returns nothing and the General Manager refunds through Hasad
   (recommended), or restrict/refuse such voids?
5. **[OPEN Q5]** Databases with any past Hasad receivable entry: stop and recreate (recommended), or keep a frozen
   legacy account?
6. **[OPEN Q6]** "Daily summary" = the daily reconciliation on the Cash screen (plus the sales report)?
7. **[OPEN Q7]** Keep the old single-method API shape permanently (recommended for now), or remove it later?
