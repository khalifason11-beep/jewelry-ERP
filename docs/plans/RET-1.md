# RET-1: customer returns (refunds and partial returns)

Status: **plan only, waiting for the owner's approval and the client's answers.** No code, no migration, no
deployment before both. Every business rule below marked **[OPEN — client decision]** is a question, not a decision.

**The owner's problem (2026-11-11).** Staff can easily refund a customer by bank transfer, even for a cash sale.
But when the drawer holds less than the cash part, the system refuses the cancellation. The owner wants the system to
allow refunding from the bank. The client's final rules for returns are not decided.

## 1. What exists today (verified in the code)

The owner's description is right. Details from the code:

- **Only a whole sale can be taken back:** `voidSale` (`backend/src/modules/sales/service.ts`), permission
  `sales.void` (branch manager and General Manager; never the cashier), a reason required, within the own branch.
  - The password is asked again above the setting `sales.voidReauthAboveAmount` (SEC-2). The default is 0, so every
    void asks.
  - In one transaction it:
    1. locks the sale row;
    2. locks the pieces;
    3. puts every piece back to **AVAILABLE** with a `RETURN` movement;
    4. puts every grain line back into its karat's pool with a `REVERSAL` row (WSL-1);
    5. marks the sale **VOIDED** (who, when, why);
    6. reverses the sale's own ledger entries one by one: `reverseRef` posts `SALE_VOID` entries with
       `reverses_entry_id`.
- **The money goes back through the original payment method:**
  - the **cash** part leaves the drawer. The amount is read from the sale's own `SALE` entries on the CASH account.
    If the drawer holds less, the void is **refused 409 `DRAWER_SHORT`** (*"…Ask the General Manager to record an
    advance into the drawer, then cancel the sale again"*);
  - the **bank** part (bank transfer, card, mobile wallet) is reversed on the BANK account, **never refused**. A
    negative bank balance raises attention **A17** (critical), CSH-2;
  - the **Hasad** part moves no branch money (PAY-1): the General Manager refunds it outside the system. The void's
    answer gives `hasadAmount`.
- **The reconciliation** (Cash page) shows `VOIDS` as its own line on the drawer and on the bank, `voidsByMethod`, and
  the Hasad voids for information. A voided sale leaves the sales totals, the profit, the dashboards and the reports.
- **Not supported:**
  - a partial return (one piece of a sale of several);
  - an exchange;
  - a time limit;
  - a fee or deduction;
  - repricing at today's rate;
  - refunding a cash part from the bank.
- **Discounts are per line** (`sale_items.discount`, SEC-2): there is no sale-level discount to spread over lines. A
  line's `final_price` is exactly what was paid for it.
- **The status RETURNED** exists for pieces, but it means "returned to the supplier" (inventory adjustment
  `RETURN_TO_SUPPLIER`): it is not a customer return.

## 2. Phase 1: refund the cash part from the bank (small; solves the drawer problem)

**What changes:** the existing whole-sale void only. When the sale has a cash part, the void dialog asks where the cash
part is refunded from:

- **the drawer** (as today), or
- **the bank**, with the transfer reference (4–40 letters or digits, as everywhere, FIX-2). The duplicate-reference
  warning works as for sales.

The bank, card and mobile-wallet parts are refunded from the bank as today; the Hasad part as today.

### 2.1 Ledger entries (the owner's options; recommended A)

| | A. Refund from the bank, the drawer untouched (recommended) | B. Move drawer → bank, then reverse |
|---|---|---|
| Entries | The sale's CASH `SALE` entries are **not** reversed; one `SALE_VOID` of −cash on **BANK** (payment method BANK_TRANSFER, no `reverses_entry_id`, allowed by the CHECK), plus the reference. The other parts reversed as today | An internal transfer drawer → bank that never physically happened, then today's reversal |
| Drawer | Keeps the cash it really holds (the day's expected cash still includes that sale's cash) | Shows money leaving that never left |
| Bank | −cash on the day, with the reference: what the bank statement shows | Same net, two extra lines |
| Recommendation | **A**: the books say what happened | No |

- **Where the reference is kept** (option, recommended): two additive columns on `sales`, `void_cash_refund_from`
  (CASH or BANK) and `void_refund_reference`. They are written at the void, like `voided_at`; `sales` is not
  append-only.
- **Alternative:** an append-only `sale_refunds` table (one row per refunded part). It is the same table phase 2
  needs, so it may be preferable if phase 2 is approved. **[OPEN — owner's choice]**
- **The reconciliation and the daily report:**
  - the bank's `VOIDS` line includes the refund, and the drawer's does not;
  - the drill-down "Cancelled sales" under the bank lists the sale with its reference, for **bank-statement matching**
    (as the scrap purchases' bank drill-down does);
  - `voidsByMethod` gains the split "cash part refunded from the bank", so the day still adds up per account.
- **A17:** a bank refund is never refused (consistent with every bank payment today). If the bank goes below zero,
  A17 is raised as today.
- **Who may choose "from the bank" [OPEN — client decision]:** (1) the branch manager alone, as the void itself; or
  (2) the branch manager asks and the General Manager approves. Option 2 needs a pending state and a new flow, so it is
  not small any more.
- **The screen:**
  - the void dialog shows the cash part and «يُرد من: الدرج / التحويل البنكي»;
  - with "bank", the reference field;
  - with "drawer" and a short drawer, the same refusal as today, plus the hint «أو رُدّ الجزء النقدي بتحويل بنكي».
- **Audit:** `SALE_CANCELLED` gains `cashRefundFrom` and the reference in its metadata, so it is visible in the audit
  log and on the sale page.
- **Migration:** one additive migration (two nullable columns, a CHECK that the reference is present iff BANK); or the
  `sale_refunds` table.
- **Tests:**
  - the ledger entries per option;
  - the drawer untouched;
  - the reconciliation adds up per account;
  - A17 on a negative bank;
  - the reference rules;
  - the duplicate warning;
  - `pg/` races: a void from the bank racing a sale, and two voids of one sale;
  - `home-numbers` ties.
- **REH-1:** a cash sale voided "from the bank" with a short drawer, the lines, the drill-down.

## 3. Phase 2: partial returns (a return document)

Two options:
- **(a) recommended:** a return document linked to the sale;
- **(b)** keep whole-sale void only and tell staff to void and sell again.

**[OPEN — client decision]** whether (a) is wanted at all.

### 3.1 The return document (option a)

- **Tables** (new, append-only, migration):
  - `sale_returns`: number `XXX-RET-000001`, sale, branch, reason, refund total, who, when, re-confirmation;
  - `sale_return_lines`: the sale line (piece or grain line), the refund for it. **A sale line is returned at most
    once** (UNIQUE);
  - `sale_return_payments`: per refunded part: method, account, amount, bank reference.
- **The sale stays COMPLETED.**
  - Its returned lines are marked "returned in RET-…" (derived from the return lines).
  - A sale whose every line is returned reads «مرتجعة بالكامل» (fully returned). Its status could stay COMPLETED, or
    become a third status RETURNED. **[OPEN — owner's choice]**
- **Ledger:** a new event type **`SALE_RETURN`** (a migration widens the event-type CHECK, marked
  `-- allow-destructive: D-ret1-x`, as D-mny1-1 did). It posts:
  - −refund on CASH or BANK per refunded part;
  - its own reconciliation line **RETURNS**, beside VOIDS.
- **Totals:**
  - the sale's revenue for reports = sales − returns;
  - the sales report shows a "Returns" column (or returns as their own rows);
  - the sale's own `total` never changes: history is not edited.
- **Profit (never overstated):**
  - a returned piece line's profit leaves the profit (the line's `profit` snapshot is subtracted);
  - its cost comes back with the piece (the piece returns at its original acquisition cost, unchanged);
  - a returned grain line has no cost, so only its revenue leaves.
- **Printing:**
  - the return prints its own receipt «إيصال مرتجع» (the sale number, the lines returned, the refund per method, the
    reference);
  - the sale's reprint shows the returned lines struck through, with "returned in RET-…".
- **The refund per line:** the line's `final_price` (what was paid for it). Discounts are per line, so there is nothing
  to spread.
- **Split payments (cash + bank + Hasad) [OPEN — client decision]:** in which order the refund is taken from the
  sale's payment methods:
  - (1) proportionally to what each method paid;
  - (2) cash first, then bank, Hasad last;
  - (3) staff choose the split (it must add up, and it is never more per method than that method paid minus earlier
    refunds);
  - (4) like phase 1: always refund to the customer from the drawer or the bank, whatever they paid.

  The Hasad part is never refunded by the system: the screen shows «يرد المدير العام جزء حصاد خارج النظام: …».
- **A void after a partial return [OPEN]:**
  - (1) refused: return the remaining lines instead; or
  - (2) the void refunds only what was not returned.

  Recommended (1): one path per piece.

### 3.2 Value of the refund (options) [OPEN — client decision]

| Rule | How it is recorded | Notes |
|---|---|---|
| Exactly what was paid (today) | refund = the line's final price | Nothing new |
| A deduction or fee | A General-Manager setting `returns.feePercent` and/or `returns.feeFixed`, **no default value** (empty = no fee). refund = paid − fee; the fee is shown as its own line on the receipt and stays as revenue of the sale | The number is the client's; never guessed |
| Repricing at today's rate | refund = the piece's weight × today's selling (or used) rate, never more than paid (or also more? **[OPEN]**); the rate used is stored on the return line | Which rate (new or used) is a question |

Every refund amount is computed by the server and shown before the confirmation; staff never type an amount.

### 3.3 Time limit [OPEN — client decision]

- A General-Manager setting `returns.maxDays` (empty = no limit).
- The server counts the days from the sale's date in the company time zone, and refuses later returns with
  `RETURN_TOO_LATE` (the days and the limit).
- **Override:**
  - (1) never;
  - (2) the General Manager only, with a reason (audited);
  - (3) the branch manager with a reason.

  This is a question for the client.

### 3.4 Exchange (later, not in the first version)

An exchange is two linked operations:
1. the return document (refund);
2. a new sale.

- The new sale carries `exchange_of_return_id`.
- The difference is paid (or refunded) by the normal payment lines.
- The customer gets one paper with the two parts: «مرتجع RET-…: −X» and «بيع INV-…: +Y», and the net to pay or
  receive.
- Nothing of this is built before the return document exists.

### 3.5 Grains (WSL-1)

Today a void puts the grains back into the pool. Grains that left the shop cannot be checked as a piece can (no code).
**Options [OPEN — client decision]:**
1. grains are returnable only by a whole-sale void (as today), never by a partial return;
2. returnable to the pool after the manager confirms the weight (typed again, never more than sold);
3. never returnable (a grain sale is final). This needs a change to the void too, which is a client decision.

### 3.6 The returned piece

- **It comes back with the same code and barcode.** The old label is valid; a new label is an audited reprint
  (LBL-1).
- **Inspection before sale [OPEN — client decision]:**
  - (1) straight back to AVAILABLE, as a void does today;
  - (2) a new status **CUSTOMER_RETURN** «مرتجع من عميل — ينتظر الفحص»: not sellable until a branch manager restocks
    it (AVAILABLE) or marks it damaged (DAMAGED).
- **Not RETURNED:** today's RETURNED status means "returned to the supplier", so a customer return gets its own status.
  - It needs a migration adding the status to the status CHECKs and `item_status_history`.
  - The stock list filters, reports and the stock-weight counts must treat it as "held, not sellable".
- **Inventory movement:** `RETURN` (as the void uses today), in direction +1.

## 4. Permissions, scope, safety

- **Who:**
  - phase 1: `sales.void` (branch manager, General Manager; the cashier never);
  - phase 2: either the same `sales.void`, or a new `sales.return` granted to BRANCH_MANAGER and GENERAL_MANAGER by
    migration. **[OPEN — owner's choice]**
- **Re-confirmation:** the password above `sales.voidReauthAboveAmount`, as the void; a return could use its own
  setting **[OPEN]**.
- **Scope:** a branch manager returns sales of the own branch only (another branch's sale answers 404); the General
  Manager any.
- **Route matrix:**
  - phase 1: no new route (the void's body gains `cashRefundFrom` and `bankReference`);
  - phase 2: `POST /sales/:id/returns` (idempotent, money: the key claimed in the transaction),
    `GET /sales/:id/returns`, `GET /returns/:id` (+ print). Each goes through the matrix, the guard tests
    (phase1b CROSS, cost-visibility), the SAFE classification of every new field, and REH-1.
- **Transactions and locks:** one transaction, the Idempotency-Key first. The locks are taken in this order:
  1. the sale row FOR UPDATE (the same lock as the void);
  2. the pieces (id order);
  3. the branch's pool (grains);
  4. the accounts.

  The drawer is checked under its lock (DRAWER_SHORT) when refunding from it.
- **Tests** (both databases, plus `pg/` races):
  - two returns of the same piece at once: exactly one;
  - a return racing a void of the same sale: one wins, the other is refused;
  - a return racing a sale of the returned piece;
  - an Idempotency-Key retry: nothing refunded twice;
  - property tests: Σ refunds ≤ Σ paid per method, conservation of the drawer and the bank, the profit never above
    the sale's.
- **Migrations:** every one is additive first and hand-reviewed; the event-type and status CHECK widenings are marked
  with a D-ret1-* decision; the append-only tables are locked like the others.
- **REH-1:**
  - phase 1: a void from the bank;
  - phase 2: a partial return, its receipt, the reconciliation's RETURNS line, the profit, a refused second return, a
    refused late return (if a limit).

## 5. Reports and money controls

- **Daily reconciliation:**
  - RETURNS beside VOIDS on the drawer and the bank;
  - the bank drill-down lists the references;
  - the day adds up per account (the existing guardrail tests extend to the new event type).
- **Sales report:** returns as their own column (or rows), with a net. The footer's gross profit leaves the returned
  lines out.
- **Profit report and dashboards:** the returned lines' profit leaves; the `home-numbers` ties (homes = reports =
  ledger) gain the returns.
- **Cash report / Cash page:** the returns and the voids, per method.
- **Hasad:**
  - the Hasad part of a return or a void is never paid from a branch account;
  - the screen and the receipt show the amount for the General Manager to refund outside the system;
  - the report lists it.

## 6. Risks

- **Money:**
  - a refund from the bank without a real transfer;
  - the reference is required and duplicate-checked, but the system cannot see the bank. Matching the bank statement
    (the drill-down) is the control.
- **Stock:** a returned piece that is not the one sold. The same code and barcode must be scanned or checked; the
  optional inspection status helps.
- **Grains:** cannot be checked once they left (§3.5).
- **Reports:** every reader of `SALE`/`SALE_VOID` must learn `SALE_RETURN`. Guardrail tests (the reconciliation adds
  up, homes = reports) catch a missed one.
- **Scope creep:** exchange, fees and repricing are each a client rule; phase 1 needs none of them.

## 7. Phases (proposal)

| Phase | What | Size | Needs |
|---|---|---|---|
| **1** | The whole-sale void may refund the cash part from the bank (with the reference); the drawer is untouched; reconciliation and drill-down; audit | Small: one additive migration (two nullable columns), the void dialog, tests, REH-1 | Q1, Q2 |
| **2** | Partial returns: the return document, refunds per method, the returned piece's status, reports, receipt | Large: three append-only tables, a new ledger event, a status, reports | Q3–Q11 |
| **3** | Exchange; fee or repricing if wanted | Medium | Q6, Q7, Q12 |

## 8. Open questions for the client (to forward as they are)

**Q1. Refund from the bank (phase 1).** When a customer returns a whole sale paid in cash, may the branch refund the
cash by bank transfer instead of from the drawer? Who decides: the branch manager alone, or must the General Manager
approve each one?
س١. الاسترداد عن طريق البنك: إذا أعاد العميل فاتورة كاملة دُفعت نقداً، هل يجوز للفرع أن يرد له المبلغ بتحويل بنكي بدلاً
من الدرج؟ ومن يقرر ذلك: مدير الفرع وحده، أم يلزم موافقة المدير العام في كل مرة؟

**Q2. The transfer reference.** For a refund by bank transfer, is the transfer reference (رقم الحوالة) always required,
as for sales paid by transfer?
س٢. هل يُشترط دائماً إدخال رقم الحوالة عند الرد بتحويل بنكي، كما في المبيعات المدفوعة بتحويل؟

**Q3. Returning part of a sale.** May a customer return one piece of a sale of several pieces (and keep the others),
or only the whole sale?
س٣. هل يجوز للعميل أن يُرجع قطعة واحدة من فاتورة فيها عدة قطع ويحتفظ بالباقي، أم الإرجاع للفاتورة كاملة فقط؟

**Q4. Paid by two methods.** If a sale was paid part cash and part by transfer (or Hasad) and the customer returns
part of it, how is the refund split: in proportion, cash first, or as the manager chooses?
س٤. إذا دُفعت الفاتورة جزءاً نقداً وجزءاً بتحويل (أو حصاد) وأرجع العميل جزءاً منها، كيف يُقسم المبلغ المرتجع: بالنسبة، أم
النقد أولاً، أم حسب اختيار المدير؟

**Q5. Time limit.** Is there a time limit for returns (for example, a number of days after the sale)? If yes, how many
days, and may anyone accept a return after it (who)?
س٥. هل هناك مدة محددة للإرجاع (عدد أيام بعد البيع)؟ إن وُجدت فكم يوماً، ومن يحق له قبول الإرجاع بعدها؟

**Q6. Deduction.** Is the full amount paid always refunded, or is something deducted (a fee or a percentage)? If
deducted, how much, and is it the same for every piece?
س٦. هل يُرد المبلغ المدفوع كاملاً دائماً، أم يُخصم منه شيء (رسوم أو نسبة)؟ وإن خُصم فكم، وهل هو نفسه لكل القطع؟

**Q7. Today's gold price.** Should a returned piece be refunded at the price paid, or recalculated at today's gold
price? If today's price: the new-piece or the used-piece rate, and can the refund be more than what was paid?
س٧. هل تُرد القطعة بالسعر الذي دُفع، أم يُعاد حسابها بسعر الذهب اليوم؟ وإن كان بسعر اليوم: سعر الجديد أم المستعمل، وهل
يجوز أن يزيد المبلغ المرتجع عما دُفع؟

**Q8. Inspection.** Does a returned piece go straight back on sale, or must the branch manager inspect it first (it
stays "returned, waiting for inspection" until then)?
س٨. هل تعود القطعة المرتجعة للبيع مباشرة، أم يجب أن يفحصها مدير الفرع أولاً (وتبقى «مرتجعة بانتظار الفحص» حتى ذلك)؟

**Q9. Grains (حبات).** May grains of broken scrap sold to a customer be returned? If yes, does the weight go back to
the scrap stock of that karat?
س٩. هل يجوز إرجاع حبات الكسر المباعة للعميل؟ وإن جاز، هل يعود وزنها إلى رصيد كسر ذلك العيار؟

**Q10. Who.** Who may accept a return: the branch manager and the General Manager (as cancellations today), or the
General Manager only? (The cashier never.)
س١٠. من يحق له قبول الإرجاع: مدير الفرع والمدير العام (كإلغاء الفواتير اليوم)، أم المدير العام فقط؟ (الكاشير لا).

**Q11. Hasad.** For the part of a sale paid through Hasad, the General Manager refunds it outside the system (as
today). Is that still right for returns?
س١١. الجزء المدفوع عن طريق حصاد يرده المدير العام خارج النظام (كما اليوم). هل يبقى هذا صحيحاً في المرتجعات؟

**Q12. Exchange.** Will customers exchange a piece for another (return + a new sale on one paper)? Is that needed now,
or later?
س١٢. هل يستبدل العملاء قطعة بأخرى (إرجاع + بيع جديد في ورقة واحدة)؟ وهل نحتاج ذلك الآن أم لاحقاً؟
