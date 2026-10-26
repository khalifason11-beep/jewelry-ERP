# Manual acceptance: PAY-1 (split payments; Hasad is a sales channel only)

For the owner, about 15 minutes, in a desktop browser. Engineering ran section A.

What changed (your approval of the plan `docs/plans/PAY-1.md` and its answers Q1–Q7, additions 1–2):

- **Split payment (SPL-1).** At the point of sale, **Split payment** lets the cashier take two methods: the first
  method and its amount, then the **second method (the rest)**, whose amount is the rest of the total. The two methods
  must differ (Q1); cash + bank transfer, cash + Hasad and Hasad + bank transfer are all allowed (Q2). Each method keeps
  its own reference (the bank transfer reference, the Hasad invoice number). The amounts must add up **exactly** to the
  total; otherwise the server refuses (`422 PAYMENT_TOTAL_MISMATCH`) and nothing is written.
- One method stays the default (**One method**), as before. The old request shape with one method is still accepted
  (Q7) and recorded as one line of the whole total; it is to be removed before go-live (BACKLOG REM-6).
- The receipt, the sale page and the sales list show **one line per method**, with its amount and reference. Old sales
  have one line (made from their single method by migration 0034) and reprint as before, in the new block.
- **A void** reverses each line through its own account: the cash part leaves the drawer (refused if the drawer does
  not hold it, as before), the bank part leaves the bank. **A Hasad part returns no money in the system** (Q4): the
  void dialog states the Hasad amount and that the General Manager refunds the customer through Hasad, outside the
  system.
- **Hasad is a sales channel only (HSD-2).** A Hasad payment moves no branch account: the money is paid to the General
  Manager's own account. The Hasad receivable, its "settle by bank" action, the Cash › Hasad transfers part and the
  permission are gone (migration 0036). A database that ever recorded a Hasad receivable entry stops the upgrade and
  changes nothing (Q5); such a database is recreated.
- **Hasad versus direct sales (Q6).** The Cash screen's reconciliation shows **Hasad versus direct sales** (direct
  sales in cash and bank; Hasad sales paid to the General Manager's account; cancelled Hasad sales; all sales of the
  day). The expected cash and the bank never include Hasad money. The sales report has the tiles **Direct sales (cash
  and bank)**, **Hasad (paid to the General Manager's account)** and **Sales paid by two methods**; each row lists its
  payment lines (screen and CSV); the channel tiles add up to the total.
- **Addition 1 (homes).** Revenue and sale counts on the dashboard and the branch and company homes include Hasad
  sales; no figure labelled cash, drawer or bank includes Hasad money (tested: the branch home figures and expected
  cash, the company home revenue and sale count, the Cash drawer, attention items A4, A5 and A17).

Migrations **0033** (the payment lines table, additive), **0034** (one line per existing sale, guarded), **0035** (the
database checks that the lines match their sale), **0036** (Hasad receivable removed, guarded). Decisions D-pay1-1 to
D-pay1-8.

Not built: a Hasad statement (Q3); a refund through Hasad (outside the system, Q4); more than two methods on one sale.

## A. What engineering ran (all green on the last commit, except as noted)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report; the perf CSV walk is PERF-1 (known, over budget on main too) |
| New tests | `pay1-migrations` (0033–0036 on a database with data, every guard stops and changes nothing, a reprint of an old sale), `pay1-split` (every pair of methods, the ledger per line, every refusal writes nothing, the drawer rule on a void, the database checks, a property test of the accounts against the lines), `pay1-reports` (reconciliation, sales report, homes: addition 1), `pg/split-sale-race` (two voids at once, a void racing the report, the same Idempotency-Key five times, a void racing a repayment of the same cash) |
| Browser | REH-1 (the split sale at the POS, its receipt, the reconciliation, the report tiles, the void dialog's Hasad note, the removed routes); `e2e-print` (a split sale prints two lines, a one-method sale one); `e2e-states` |

## B. Walk-through

Sign in as a cashier.

1. **Point of sale**: add a piece. Choose **Split payment**. First method **Cash**, amount a part of the total; second
   method **Bank transfer (the rest)**: its amount is the rest. Enter the transfer reference. Confirm.
2. The receipt shows two payment lines: cash and its amount; bank transfer, its amount and reference.
3. Try a first amount of 0, or equal to the total: the screen says "Each part must be more than 0 and less than the
   total" and the sale cannot be confirmed. (The screen always computes the rest; a request whose amounts do not add
   up is refused by the server, tested in section A.)
4. Sell another piece by **Hasad + Cash** with the Hasad invoice number.

Sign in as the branch manager.

5. **Cash**: the drawer rose by the two cash parts only; the bank by the bank part only. **Hasad versus direct
   sales** shows the Hasad part under Hasad, never in the expected cash.
6. **Reports › Sales**: the tiles **Direct sales (cash and bank)**, **Hasad (paid to the General Manager's account)**
   and **Sales paid by two methods** (2). The rows list their payment lines.

Sign in as the General Manager (with your passkey).

7. **Sales**: open the Hasad + Cash sale → **Cancel sale**. The dialog says how much was paid through Hasad and that
   you refund the customer through Hasad, outside the system, and how much cash leaves the drawer. Confirm.
8. **Cash**: the drawer dropped by the cash part only; the cancelled Hasad sale shows under **Cancelled Hasad sales**.
9. **Reprint** an old sale (made before this change): it shows one payment line, as before.

## C. Questions for you

None open for this item. The Hasad refund process itself stays an open client question (Q4); the system moves no
money for it either way.
