# Plan MKC-1: supplier making charges paid by the owner from his personal account

Status: **PLAN ONLY, waiting for the owner's approval.** Nothing here is implemented. CSH-2 is accepted; UI-C and
SCR-VOID are not started.

## 0. The client facts (owner, confirmed)

1. A making charge (the supplier's fee) is **always one full bank transfer**. Never cash, never split.
2. The owner, who is also the General Manager, pays it from his **personal** account.
   - The branch bank account does not move.
   - The branch does **not** reimburse him: a making charge is a **cost borne by the owner**, not a debt of the
     branch to the GM.
3. A single company account for all branches is a future wish. Build nothing for it, and block nothing.
4. The GM does this himself, outside the branch's working day. He opens supplier orders and records what is owed to
   suppliers.
5. Creating a supplier order is **GM-only**.

This plan changes only the **money side** of a supplier order. The gold side is unchanged (§8).

## 1. Today: routes, who calls them, and where the drawer is the default

There is **no separate "receive" or "pay" step**. One request creates the order, receives the pieces into the branch
(PURCHASED → RECEIVED → AVAILABLE) and pays the making charge, all in one transaction (`createPurchase`,
`backend/src/modules/purchases/service.ts`).

| Route | What it does | Permission | Who has it today |
|---|---|---|---|
| `POST /purchases` | Create the order, receive the pieces, pay the making charge | `purchases.create` | **GM, branch manager** |
| `GET /purchases`, `GET /purchases/:id` | List and detail (cost fields GM-only) | `purchases.view` | GM, branch manager |
| `POST /purchases/:id/settlements` | Settle the gold owed with broken-scrap weight (gold side) | `purchases.settle` | GM, branch manager |
| `GET /products` | Product list for the forms | any of `purchases.create`, `scrap.buy`, `catalog.create` | GM, branch manager |
| `POST /suppliers` | Create a supplier (only from the purchase form today) | `catalog.create` | GM, branch manager |
| `GET /suppliers` | Supplier list | any of `purchases.view`, `catalog.create` | GM, branch manager |

The cashier has none of these.

**Where the drawer is the default:**
- Service: `makingChargePaidFrom ?? 'CASH'`.
- Form: `useState<CashOrBank>('CASH')`, with a "Making charge paid from: Cash drawer / Bank" select.
- `dev:sample`: `makingChargePaidFrom: 'CASH'`.
- e2e world: `makingChargePaidFrom: 'CASH'`.
- Fixture world: CASH 70% of the time.
- REH-1: the form default, i.e. CASH.

## 2. Today: how a making charge is paid and posted

- **Amount:** `purchases.making_charge_paid` = Σ `purchase_items.making_cost`.
- **Source:** `purchases.making_charge_paid_from` = `CASH` | `BANK`. Both columns are NULL on orders recorded before
  Phase 4; a check ties them together.
- **No reference** of any kind is stored for a bank payment.
- **Ledger:**
  - one `SUPPLIER_MAKING_CHARGE` entry of −amount on the branch's CASH or BANK account (`paymentMethod` CASH or
    BANK_TRANSFER), ref `purchase`, posted at the order's time; a charge of 0 posts nothing;
  - since CSH-2, a CASH payment first passes the drawer BLOCK (`lockDrawerFor(..., 'MAKING_CHARGE')`), and a BANK one
    can raise A17.
- **Reconciliation:** the `MAKING_CHARGES` line on the drawer and on the bank, plus `makingChargesCash` and
  `makingChargesBank` in the response.
- **Audit:** `PURCHASE_CREATED` ("Purchase {number}: {n} item(s) received, cost {cost}"). It does not say how the charge
  was paid.
- **Cost basis:** each piece's `acquisition_cost` = purchase cost + making cost + other cost, and `making_charge` is
  kept on the piece. `purchases.total_cost` is the order total. **None of this reads the ledger.**

**What depends on it:**

| Kind | Where |
|---|---|
| Backend tests | `phase4.test.ts` (paid from BANK → a BANK entry of −140,000; a branch manager creates orders), `negative-balances.test.ts` (making charge BLOCK and BANK cases), `pg/drawer-race.test.ts` (making charges racing scrap on one drawer), `ledger.test.ts` (the `MAKING_CHARGES` line), `catalog.test.ts`, `phase2a.test.ts`, `pg/settlement-race.test.ts` (branch manager creates orders), `phase1b.test.ts` (generated allow/deny/cross-branch for `POST /purchases`), `cost-visibility.test.ts` |
| Fixture world | `fixtures/world.ts`: each branch manager creates the orders, 70% paid from CASH, 30% from BANK |
| Sample | `backend/src/dev/sample-cli.ts`: the branch manager creates one order per branch, paid from CASH |
| e2e | `scripts/lib/e2e-world.mjs` (GM, CASH); `e2e-states.mjs` (list states only); `capture-ui-baseline.mjs` (the branch manager's "new purchase" and "new supplier" dialogs, screens 24 and 25) |
| REH-1 | CAT-0 section (the branch manager creates supplier, type and product from the purchase form and records the order, paid from the drawer); FIX-1 section (the branch manager creates stock through `POST /api/purchases`) |
| Screens | Purchases (the "New purchase" button, the form's "paid from" select, the detail's "Making charge paid from"); the branch manager's home "Your branch has no stock yet" (a "New purchase" link); the POS empty state ("Receive a supplier order…" for a branch manager); Cash (the `MAKING_CHARGES` line) |

## 3. Recommended design: record the payment fact only

I confirm the recommended design, with one addition (the transfer date, Q2).

**Each new order records:**
- that the making charge was **paid by the owner from his personal account, by bank transfer**;
- the **amount** (as today);
- the bank's **transfer reference** (§5);
- the **transfer date** (Q2).

It posts **no CASH, BANK or OWED_TO_GM ledger entry**.

**Schema** (`purchases` is not append-only: `gold_owed_mg_pure24` is updated by settlements):
- `making_charge_paid_from` (existing column, not renamed) takes a new value, **`OWNER_PERSONAL`**. The new enum is
  `MAKING_CHARGE_PAYERS = ['OWNER_PERSONAL']`. `CASH_OR_BANK` stays for funding.
- New columns:
  - `making_charge_reference` (text, normalized like sales and scrap);
  - `making_charge_transfer_date` (date, display only).
- Checks:
  - `making_charge_paid_from = 'OWNER_PERSONAL'` (the old CASH and BANK values cannot remain; see §5);
  - a reference of 4–40 characters exactly when `making_charge_paid > 0`;
  - the transfer date is present exactly when `making_charge_paid > 0`.

**Changing it later without rewriting history:**
- A company account would be one more value (for example `COMPANY_BANK`) with its own posting rule. Old
  `OWNER_PERSONAL` rows keep their meaning.
- If payments ever become separate from the order (several transfers, a later payment), a new append-only
  `supplier_payments` table takes over for new orders. The columns stay as history.
- Nothing is keyed on "one bank per branch".

**Why the alternatives are wrong now that the owner bears the cost:**

| Alternative | What it would record | Why it is wrong |
|---|---|---|
| **An advance into the branch bank, then the payment from it** (the CSH-2 workaround) | Branch bank +X −X; OWED_TO_GM +X | The branch would **owe the GM X**, which fact 2 denies. The bank lines would show money that never touched the branch account, so the day's bank movements stop matching the real bank statement. It also takes two entries for one fact, and the GM must remember both |
| **An OWED_TO_GM entry alone** | OWED_TO_GM +X | Again a debt that does not exist. It also breaks the funding rule that every OWED_TO_GM movement has its money side in the same transaction (D-csh-1), and "owed to the GM" would no longer be repayable money |
| **Keep "paid from BANK"** (today's other option) | Branch bank −X | The branch bank does not move (fact 2). The system's bank balance would drift below the real one by every charge, and A17 would raise false alarms |
| **Recommended: the payment fact only** | The amount, the reference and the date on the order; no ledger entry | True to the facts. The branch's money is untouched, and the piece's cost still carries the charge (§4) |

## 4. Cost and profit: unchanged, and how that is proved

The making charge **stays in each piece's cost basis**. `acquisition_cost` still includes `making_cost`, set when the
piece is received, from the order lines, exactly as today. Who paid the charge changes nothing in it. **Nothing that
computes cost, margin or profit reads the ledger.**

| Figure | Source | Shown in |
|---|---|---|
| Cost of sales, gross profit | `sale_items.unit_cost` / `sales.cost_total`, copied from `acquisition_cost` at the sale | GM home (gross profit, strips), the branch view of the GM home, company dashboard, Sales, Profit and Branch Performance reports and their CSV exports, sale detail (GM) |
| Purchases cost | `sum(purchases.total_cost)` | Purchases report, Branch Performance, purchase list and detail (GM) |
| Stock at cost | `sum(jewelry_items.acquisition_cost)` of AVAILABLE pieces | GM home "stock at cost", inventory valuation report, branch view |
| Piece cost breakdown | `purchase_items.purchase_cost / making_cost / other_cost` | Item detail and sale detail (GM) |

**What does change:** only money figures, never profit.
- The drawer and bank no longer drop by the making charge. This affects expected cash, the bank balance, the
  reconciliation lines and the BM home's expected cash (in the fixture world they rise by the charges that were posted
  before).
- No existing test asserts an exact drawer figure (verified in CSH-2).

**Tests (new, `mkc1.test.ts`, both projects):**
1. An order paid by the owner leaves **no ledger entry** with `ref_type = 'purchase'`. The drawer, the bank,
   OWED_TO_GM and every reconciliation line are unchanged.
2. **Cost equivalence.** Every cost or profit figure in the table above, for every `REPORT_KEYS` report and its
   export, the homes and the company dashboard, equals the arithmetic from the order lines. Each piece's
   `acquisition_cost = purchase + making + other`. Selling the piece gives profit = price − that cost.
3. The figures are snapshotted before and after the order's making charge is recorded. Only cost and profit move, and
   only by the order's cost. Money does not move.
4. The existing `home-numbers`, report and `cost-visibility` tests pass unchanged. `cost-visibility` also gains the
   new response field (§10).

## 5. The transfer reference and the existing rows

**The reference:** required when the making charge is above 0. It uses the same `normalizeBankReference` /
`validBankReference` as sales (FIX-2) and scrap (CSH-2): 4–40 letters or digits after normalization, Arabic digits
accepted. No duplicate check (as CSH-2 Q4), unless you want one (Q4 below).

**Existing rows the guard must catch** (migration 0022, before any change):

| Kind | How to recognise it | Exists when |
|---|---|---|
| (a) paid from the drawer | `making_charge_paid_from = 'CASH' AND making_charge_paid > 0` (a CASH ledger entry exists) | every database since Phase 4 (the default) |
| (b) paid from the bank, with no reference | `making_charge_paid_from = 'BANK' AND making_charge_paid > 0` (a BANK entry, and no reference column ever) | whenever "Bank" was chosen |
| (c) a charge of 0 with a source | `making_charge_paid_from IN ('CASH','BANK') AND making_charge_paid = 0` (no ledger entry) | REH-1's FIX-1 stock order, tests |
| (d) recorded before Phase 4 | both columns NULL | only databases from before migration 0007 |

Every order recorded since Phase 4 has a source (the column was always set), so **any database holding supplier
orders stops.** The message counts each kind; nothing is changed. The database is recreated, as for FIX-2 and CSH-2
Q1. I recommend this: rewriting a CASH row as "owner" would contradict its ledger entry. Keeping the old rows
alongside the new rule would leave two meanings of a making charge in one database.

The guard runs before the permission change, so a stop leaves the branch manager's grant untouched too. The message
points to `docs/DEPLOYMENT.md`, section "MKC-1".

## 6. Reconciliation, attention and day grouping

| Check | After MKC-1 |
|---|---|
| Cash reconciliation | A making charge never touches CASH or BANK, so every day still adds up (SPEC §18.10). The `MAKING_CHARGES` line has nothing left to show (Q7: I recommend removing the line and the `makingChargesCash` / `makingChargesBank` fields; `SUPPLIER_MAKING_CHARGE` stays a valid event type in the database check and moves to `OTHER_EVENT_TYPES` as "historical, MKC-1", so the guardrail stays complete) |
| A5 (no cash count yesterday) | Raised only by CASH entries, so **an order recorded at night or on a closed day no longer demands a count**. Test: a branch whose only event yesterday is a supplier order raises no A5 |
| A4 (count difference) | Unchanged; a late order can no longer move the expected cash after the count |
| A17 (bank below zero) | No longer raised by making charges; no false alarm for the owner's personal transfers |
| Drawer BLOCK | The `MAKING_CHARGE` outflow kind and its sentence are removed (the making charge never leaves the drawer) |
| OWED_TO_GM, funding | Untouched; the CSH-2 workaround is no longer needed (BACKLOG note updated) |
| Day grouping, reports | Orders and the Purchases report group by `purchases.created_at` in the company time zone, as today. The transfer date is shown, never used for grouping (Q2) |

## 7. Permissions: creating an order becomes GM-only

**Change:** `purchases.create` leaves `BRANCH_MANAGER` in `shared/src/permissions.ts`. Migration 0022 deletes the
`role_permissions` row of every role except `GENERAL_MANAGER` (Q9), with an allow-destructive marker. **Nothing else
changes.**

| A branch manager keeps | Why |
|---|---|
| `purchases.view` | The list and detail of the branch's orders (no cost, as today) |
| `purchases.settle` | Settling the gold owed with broken scrap (the gold side) |
| `catalog.create` | Types and products (from the scrap form). Suppliers: the only screen that creates one is the purchase form, so in practice only the GM creates suppliers (Q10) |
| `scrap.buy`, `inventory.*`, `cash.*` | Unchanged |

**Route matrix:** no line changes. `POST /purchases` still needs `purchases.create`. `GET /products` stays open to a
branch manager through `scrap.buy` / `catalog.create`.

**What depends on the branch manager having it today:**
- Generated tests (`phase1b.test.ts`): `POST /purchases` flips to 403 for the branch manager. Its cross-branch row
  moves to a GM-only case.
- `phase4`, `catalog`, `phase2a` and `pg/settlement-race` create orders as the branch manager. They switch to the GM,
  with a `branchId`.
- Fixture world and `dev:sample`: orders are created by the GM.
- Screens:
  - the "New purchase" button already hides by permission;
  - the BM home "no stock yet" link already hides;
  - the POS empty state's text for a branch manager becomes "Ask the General Manager to record a supplier order, or
    buy scrap" (it would otherwise say "Ask your branch manager");
  - `capture-ui-baseline.mjs` takes the purchase dialogs as the GM.
- REH-1:
  - CAT-0 moves to the GM (supplier, type and product created from the purchase form);
  - the branch manager gets **403 on `POST /api/purchases`** and sees no "New purchase";
  - the FIX-1 stock order is created by the GM.

**Existing open orders created by a branch manager:**
- Under the recommended guard (§5), a database with supplier orders is recreated, so none survive.
- If you choose to keep history instead (Q8), they stay exactly as they are: same creator, same gold owed, settleable
  by the branch manager with scrap, and their old CASH/BANK payment visible as history. The plan never edits them.

## 8. The gold side: unchanged

The supplier debt stays in pure-24K milligrams (`gold_debt_mg_pure24` / `gold_owed_mg_pure24`, one `pureGoldMg`
rounding per piece). It is settled only with broken-scrap weight (`POST /purchases/:id/settlements`,
`purchases.settle`). Nothing in this plan touches it; `phase4` and `pg/settlement-race` keep proving it.

## 9. Screens (minimum, no redesign)

**Purchase form (GM only):**
- The "Making charge paid from" select is replaced by a fixed line: "Paid by the owner from his personal account (bank
  transfer)".
- A **Transfer reference** field (normalized preview, as on the scrap form) and a **Transfer date** field (default
  today, not in the future), both required when the making charge is above 0.
- The info alert's last sentence becomes "The making charge is paid by the owner, by bank transfer; no branch money
  moves."

**Purchase detail:** "Making charge paid by: the owner (personal account) · reference · date".

**Purchase list:** a "Transfer reference" column (GM only if Q3 is answered as recommended).

**Cash:** the making-charge lines disappear (Q7).

**Texts:** Arabic and English for every new string. References and money isolated left to right. `i18n:check` stays
green.

## 10. API, field classification, audit

- **`POST /purchases`:**
  - `makingChargePaidFrom` is removed from the schema (strict: sending it is a 400);
  - `makingChargeReference` (text) and `makingChargeTransferDate` (YYYY-MM-DD) are added, required when the lines'
    making cost is above 0;
  - errors: "Enter the bank transfer reference (4 to 40 letters or digits)" (existing key) and "The transfer date
    cannot be in the future".
- **Field classification:**
  - `making_charge_paid` stays COST;
  - `making_charge_paid_from` stays SAFE (it only says "owner");
  - `making_charge_reference` and `making_charge_transfer_date` are **COST** (GM only; Q3), because they describe the
    owner's personal account.
- **Audit:** `PURCHASE_CREATED` metadata gains `makingChargePaidBy: 'OWNER_PERSONAL'`, the reference and the transfer
  date. No new action.

## 11. Tests, REH-1 and e2e

- **Backend:**
  - `mkc1.test.ts` (both projects):
    - no ledger entry for an order;
    - the cost equivalence (§4);
    - no A5 for a day with only an order;
    - the reference rules (missing, too short, Arabic digits normalized, a 0 charge needs none);
    - `makingChargePaidFrom` refused;
    - the branch manager 403;
    - DB checks refuse an inconsistent row.
  - `mkc1-migrations.test.ts`:
    - guard counts for kinds (a)–(d), nothing changed;
    - a clean upgrade with no orders;
    - the role_permissions rows gone for every role but the GM;
    - on PostgreSQL, the checks validated.
  - Updates:
    - `phase4` (the BANK-posting test becomes an owner-paid test);
    - `negative-balances` and `pg/drawer-race`: the making-charge cases are replaced by a cash repayment and scrap
      purchases, so the race still mixes two outflow kinds;
    - `ledger` (lines);
    - `catalog`, `phase2a`, `settlement-race` (GM creates);
    - `phase1b` (generated);
    - fixture world (owner-paid with test references `TEST-MKC-…`).
- **REH-1:**
  - CAT-0 as the GM, with a reference typed in Arabic digits and shown normalized;
  - the order leaves the drawer and the bank unchanged;
  - the branch manager has no "New purchase" and gets 403 on the API;
  - no A5 the next day from an order alone (if the clock step is practical; otherwise covered by the backend test).
- **e2e:**
  - `e2e-world.mjs`: owner-paid with a test reference;
  - `e2e-states.mjs`: the form's reference field and axe;
  - `capture-ui-baseline.mjs`: purchase dialogs as the GM.
- **Gates:**
  - typecheck (all `check:*`), both projects, build, `i18n:check`;
  - REH-1;
  - e2e print, passkeys on and off, states, ui kit, perf;
  - the migration upgrade check;
  - slim screenshots (purchases form and detail as the GM).

## 12. Docs

- `docs/decisions.md` §22, D-mkc-1…:
  - payment fact only;
  - schema and future values;
  - cost unchanged;
  - reference rules;
  - guard and recreate;
  - GM-only creation;
  - reconciliation line.
- `docs/acceptance/MKC-1.md`: the gates, the cost-equivalence proof, and a Codespace checklist:
  - the GM records an order with a reference;
  - the drawer and bank are unchanged;
  - the BM sees no "New purchase" and gets 403;
  - the BM settles gold with scrap as before.
- `docs/BACKLOG.md`: MKC-1 marked done; the CSH-2 interaction note replaced; a correction of a wrong order or
  reference added if you want it (Q13).
- `docs/SPEC.md` §7 (supplier orders: GM only, owner-paid making charge) and §9 (the making charge never touches
  branch money).
- `docs/DATA_MODEL.md` (the purchases columns), `docs/DEPLOYMENT.md` (section "MKC-1", migration 0022).

## 13. Commit sequence and effort

| # | Commit | Content |
|---|---|---|
| 1 | Backend | Migration 0022 (guard, columns, checks, permission rows), service (no posting, reference and date, `MAKING_CHARGE` BLOCK kind removed), routes, reconciliation line (per Q7), field classification, db-checks, every backend test and the fixture world |
| 2 | Screens and data | Purchase form, detail and list; BM POS text; i18n; `dev:sample`; e2e world and states; capture script; REH-1 |
| 3 | Docs and gates | Decisions, acceptance, BACKLOG, SPEC, DATA_MODEL, DEPLOYMENT, slim screens, full gates |

**Effort: S–M, about 1 to 1½ days.** Most of it is moving test and rehearsal steps from the branch manager to the GM;
the money change itself is small (one ledger post removed, three columns).

## 14. The two CSH-2 checks

1. **Does the audit list reveal the number of hidden funding rows to a role without `funding.view`? No, no leak, so
   no fix commit.**
   - `listAudit` filters `entity_type <> 'gm_funding_event'` in the `WHERE` clause, before the limit.
   - The endpoint returns a plain list with **no total, no count and no offset**; the screen's "n rows" counts what
     came back.
   - The only other audit counters:
     - the User Activity report's "actions" per user: scoped to users **of the branch manager's own branch**; the GM
       has no branch, so his funding rows are never counted for a branch manager;
     - A11 (failed sign-ins only).
   - Audit row ids are sequential, so a gap shows that *some* row exists between two ids. Rows of other branches and
     company-level rows (settings, the GM's sign-ins) make the same gaps, so a gap cannot be attributed to funding.
     I do not consider this a leak.
2. **"Fund the branch" for a branch whose first money is a BANK advance only:** the step **stays open**.
   - It requires an uncorrected advance into the **drawer** (D-csh-9), and `setup.test.ts` covers this case.
   - This is consistent with the drawer BLOCK: such a branch cannot pay any cash outflow (scrap cash part, cash
     refund), so the reminder is useful.
   - The step's text names the drawer. It closes as soon as any drawer advance is recorded. If a branch is meant never
     to hold cash, the step would stay open forever. That is a client question rather than a bug (Q15).

## 15. Questions for you, each with my recommendation

| # | Question | Recommendation |
|---|---|---|
| Q1 | Store the payment as columns on the order, or in a separate append-only payments table? | **Columns** (one payment per order, at the order, fact 1). Switch to a table only if payments ever separate from orders |
| Q2 | Record the transfer date separately from the recording time? | **Yes**, a required date (default today, not in the future), **display only**. The order and the reports keep the recording time. A date, not a backdated ledger entry, so Q12 of CSH-2 is respected |
| Q3 | Who sees the transfer reference and date? | **GM only** (COST classification): it is the owner's personal account. The branch manager sees "Paid by the owner" without the reference |
| Q4 | Warn on a reference already used on another order? | **No** (as CSH-2 Q4). One transfer may cover several orders; ask the client if that ever happens |
| Q5 | A making charge of 0: allowed, with no reference? | **Yes**, as today; no reference, no date |
| Q6 | Keep the making charge in the piece's cost and in profit, although the owner pays it personally? | **Yes, unchanged** (§4). Otherwise profit would rise by every charge and stock at cost would drop. **Ask the client** if they ever want "profit before the owner's charges" as a separate figure |
| Q7 | The Cash page's "Supplier making charges" line, now always 0 | **Remove the line and the two fields**; keep the event type valid in the database as historical ("Other") |
| Q8 | Databases holding supplier orders (every one since Phase 4) | **Stop and recreate** (as FIX-2, CSH-2 Q1). Alternative: keep the old CASH/BANK orders as read-only history, with two meanings of a making charge in one database (not recommended) |
| Q9 | Remove `purchases.create` from every non-GM role, or only from the branch manager? | **Every role except the GM** (fact 5 says GM-only, and custom roles may exist in the table) |
| Q10 | A branch manager can no longer reach the only screen that creates suppliers (`catalog.create` stays) | **Leave it**: suppliers come with orders, which the GM records. No new screen |
| Q11 | Creating an order **receives the pieces into the branch at once** (AVAILABLE). When the GM records it outside the working day, are the pieces already at the branch? | **Ask the client.** If pieces arrive later, a separate "receive" step by the branch manager is a new BACKLOG item, not part of MKC-1 |
| Q12 | The wording "paid by the owner from his personal account" | Keep the role neutral in the interface ("the owner's personal account"); no person's name anywhere |
| Q13 | Correcting a wrong order, amount or reference | **Not now.** Add a BACKLOG item (a GM-only correction, like SCR-VOID) if you want it |
| Q14 | A future company account | **Nothing now**: it would be one more `making_charge_paid_from` value and its own posting rule, additive |
| Q15 | "Fund the branch" for a branch that never holds cash (§14.2) | **Keep** the drawer rule; revisit only if the client has such a branch |
