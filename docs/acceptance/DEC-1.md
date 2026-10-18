# Manual acceptance: DEC-1 (the owner's decisions of 2026-10-18; discounts off; the gold-rate edit guard)

For the owner, about 15 minutes, in a desktop browser (Codespace or local). Engineering ran section A.

What changed:

- **Your decisions are written down** so no later session reopens them: `docs/SPEC.md` §20 (each question keeps
  its text, with your answer and the date), `docs/BACKLOG.md` (CSH-3 and SCR-1 cancelled, TAX-1 not needed, LBL-1
  deferred, RAT-2 done as built; SPL-1, MNY-1 and the new HSD-2 rewritten with your design; OPN-1 and CAT-1 updated;
  the new order DEC-1 → SCR-VOID + PUR-FIX → PAY-1 → MNY-1 → CAT-1 → OPN-1), and `docs/decisions.md` (D-dec1-1 to
  D-dec1-13).
- **No discounts:** every role's discount cap is 0 by default. The POS shows no discount field. The setting stays
  in Settings › Sales, so another client can give discounts.
- **A large gold-rate change asks first** (new-piece rate, used-piece rate, scrap buying rate):
  - up to **10 %**: saved as today;
  - more than 10 % up to **30 %**: a written **reason**;
  - more than 30 %: the **reason and your password** again;
  - the first rate of a karat is not checked.

  Both percentages are settings on the Prices page. Every change is in the audit log with its percentage, and the
  reason when one was asked.
- **Allowed karats:** a rate can be set for every karat the Settings screen offers (9, 12, 14 included), and for no
  karat that is not allowed (fixed by PRC-1; DEC-1 adds the proof test).

Plan: `docs/plans/DEC-1.md`. No migration.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | see the report: summary pasted there |
| New tests (both projects) | `dec1-discounts`, `dec1-rate-guard`, `dec1-karats`, `rate-guard.property` (fast-check); real PostgreSQL only: `pg/rate-guard-race` (two edits at once cannot both pass; it fails if the lock is removed) |
| Browser | `e2e-prices` (the change shown before saving, the reason dialog at +20 %, reason and password at +40 %, a wrong password saves nothing), `e2e-print` (no discount field at cap 0, a field once a cap is set), REH-1 |

## B. Walk-through

Sign in as the General Manager.

### 1. No discounts

1. Settings › Sales: "Max discount" is **0 %** for the cashier, the branch manager and the General Manager.
2. Sign in as a cashier, open the POS and add a piece: the cart line has **no discount field**.
3. (Optional) As the General Manager set the cashier to 3 %, save (your password is asked). The cashier's cart now
   shows a discount field with "max 3%". Set it back to 0.

### 2. The gold-rate edit guard

On the Prices page, 21K new-piece rate (use the current value; examples assume 190,000):

1. Type **209,000** (+10 %). The line under the field says "+10.00% from the current rate". Save: saved, nothing
   asked.
2. Type a value about **+20 %** higher. The line turns amber: "… · needs a reason". Save: a dialog asks for the
   reason only, and Save stays grey until you write at least 3 characters. Write a reason and save.
3. Type a value about **+40 %** higher. The line turns red: "… · needs a reason and your password". Save: the dialog
   asks for the reason and your password. Try a wrong password: nothing is saved and the dialog stays. Then the right
   one: saved.
4. A lower value works the same way (−10 % passes, below it a reason, below −30 % the password).
5. Audit log, filter "GOLD_RATE_CHANGED": the guarded changes read "… (+20.00%): <your reason>".
6. Prices page, "How selling prices are worked out": the two numbers **10** and **30** can be changed (the first
   must be smaller than the second, the second at most 100). Change them back afterwards.

### 3. Allowed karats

1. Settings › Business rules: tick 9K (keep 21K), save.
2. Prices page: 9K has a line in both selling tables ("no rate" in red until set). Set both: saved.
3. Untick 9K again: 9K disappears from the selling tables; a rate for it can no longer be set.

## C. Still open with the client

Q-1 (making charge), Q-5 (clean scrap at another karat), Q-11 (hosting, sign-in hardware, backups), Q-13 (written
agreement), and whether the General Manager's funding is a loan or capital (CSH-2).
