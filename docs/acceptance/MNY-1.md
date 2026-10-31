# Manual acceptance: MNY-1 (money transfers between branches and to the General Manager)

For the owner, about 25 minutes, in a desktop browser, with three windows: the General Manager (with your passkey), the
manager of branch A and the manager of branch B. Engineering ran section A.

What changed (your decisions and approval of 2026-10-30, plan `docs/plans/MNY-1.md`, decisions D-mny1-1…5):

- A branch manager **sends money** from the drawer or the bank of the branch to another branch or to you, with the
  amount and a reason (3 to 300 characters). From the bank, the bank transfer reference is required. The drawer never
  sends more than it holds; there is no other limit.
- The money is **on the way** until the receiver confirms it. The receiving branch manager **confirms** it and chooses
  where it is now: the drawer or the bank (a reference for the bank). You confirm only a transfer sent to you, and you
  record nothing else. You never send money and never confirm a transfer between branches.
- The sending branch manager can **cancel** a transfer while it is on the way, with a reason; the money goes back to the
  drawer or the bank it left. A confirmed transfer cannot be cancelled.
- **A wrong amount (your procedure):** a transfer is never edited. Cancel it while it is on the way, with the reason
  (for example «المبلغ خطأ: 50,000 لا 5,000»), then send the right amount as a new transfer.
- You see **every transfer**, read only: its status (on the way, received, cancelled), who confirmed or cancelled it,
  when and why; on Cash, the money on the way for each branch.
- What a branch owes you (Funding) **never moves** with a money transfer. No step asks for the password again.
- Attention: **A18** "waiting for you to confirm" (the receiving branch manager; you for a transfer to you) and **A19**
  "waiting more than 24 hours" (the receiving branch manager and you). The 24 hours are the existing setting of the late
  piece transfers (`transfers.pendingClaimStaleHours`), reused as you asked: no new setting.
- A branch with money on the way cannot be deactivated.
- Cashiers see nothing of it.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| New tests | `mny1-migrations` (upgrade from 0037 with money in the ledger: nothing moves; the grants: the General Manager never holds `money_transfers.send`), `mny1-money-transfers` (the ledger entries of every step, roles and refusals, deactivation, reconciliation lines, the General Manager's view of a cancelled transfer, a property test over random sequences of send, confirm and cancel: money is conserved, the money on the way equals the transfers on the way, no drawer below zero, `OWED_TO_GM` never moves), `mny1-routes` (HTTP, expired re-confirmation windows, idempotent replays, 403/404 per role), `mny1-attention` (A18/A19 at 23:59 and 24:01 with a fixed clock), `pg/money-transfer-race` (double confirm, confirm against cancel, a send against a scrap purchase on a small drawer, A→B and B→A at once, a send against a deactivation) |
| REH-1 | 373 checks (was 347): the transfers above through the screens and the API on an empty production database, the reconciliation lines adding up |
| Browser scripts | `e2e-states` 98 (the new page in the sweep of both managers) |

## B. Walk-through

1. **Branch A's manager** → **Money transfers** → **Send money**: to branch B, from the drawer, 30,000, reason «سيولة».
   It shows under **Sent, not yet received**. On **Cash** the drawer of A is 30,000 lower.
2. **Branch B's manager**: the attention list shows «تحويل مالي بانتظار تأكيدك». **Money transfers** → **Waiting for you**
   → **Confirm** → the drawer → **Confirm receipt**. B's drawer is 30,000 higher.
3. **A's manager** sends 25,000 **from the bank**: without the reference the button stays disabled; with it, it sends.
   **B's manager** confirms it **into the bank** (with the bank's reference).
4. **The wrong amount:** A's manager sends 5,000 to B, then **Cancel transfer** with the reason «المبلغ خطأ: 50,000 لا
   5,000»; the 5,000 is back in A's drawer. Then A sends 50,000 and B confirms it.
5. **To you:** A's manager sends 20,000 to «المدير العام». **You** (company view): the attention line, then **Money
   transfers** → **Waiting for you** → **Confirm**. **Cash › Funding**: what branch A owes you has not changed.
6. **You:** Money transfers has no **Send money**, and no **Confirm** on a transfer between branches. The history shows the
   cancelled 5,000: «ملغاة», who cancelled it, when and the reason. **Cash** shows the money on the way per branch.
7. A's manager sends 1,000 to B and leaves it. **Branches** → branch B → deactivate: refused (money on the way). A's
   manager cancels it.
8. **Cash** of branch A for today: the lines «تحويلات مرسلة إلى الفروع» and «تحويلات إلى المدير العام» and, for B,
   «تحويلات مستلمة من الفروع»; the day still adds up.
9. A cashier: no Money transfers in the menu; typing the address shows «ليس لديك صلاحية لهذه الصفحة».

## C. Questions for you

- **Q1.** A confirmed transfer cannot be cancelled. If an amount turns out wrong after the receiver confirmed it, should
  the receiving branch simply send the difference back as a new transfer (with the reason)? Nothing else is built for
  that case.
- **Q2.** The page is **Money transfers** in the Money group of the menu, next to Cash, with a link from Cash (rather
  than a tab inside Cash). Is that where you want it?
