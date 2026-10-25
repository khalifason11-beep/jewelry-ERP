# Manual acceptance: OPN-FIX (correcting a piece of a sealed opening)

For the owner, about 10 minutes, in a desktop browser. Engineering ran section A.

What changed (your approval of 2026-10-25 and its answers Q1–Q5, additions 1–2):

- On the page of a piece of a **sealed opening** that is still **available** (in any branch), the General Manager sees
  **Correct this opening piece**. The dialog offers:
  - **Correct its values**: the condition (new or used), the karat, the gross and the net weight, prefilled with the
    current values;
  - **Void it (entered by mistake)**: the piece leaves the stock for good.
- **Before you confirm**, the dialog shows the server's preview: the **price now**, the **price after the
  correction** and the **change in the stock valuation** (and the stock weight when a weight changes). A refusal (a
  rate not set for the new karat or condition, nothing changed…) shows there too. The preview changes nothing.
- The confirmation asks a **reason** (3–200 characters), your **password** and your **passkey**, as the seal.
- A sold piece, a piece in transit (receive it first), a damaged, returned or voided piece cannot be corrected. On an
  installation with tag prices, the condition and the karat cannot be corrected (weights and void can).
- The cost of an opening piece stays **unknown**. The sealed opening keeps its totals **as sealed** and shows
  **Now, after the corrections** and the list of corrections (before → after, reason, who, when, the branch the piece
  was in). The piece's page lists its corrections. The opening's export adds the values now.

Plan `docs/plans/OPN-FIX.md`. Migration **0032** (additive: the corrections table and the permission). Decisions
D-opnfix-1 to D-opnfix-6.

Not built: correcting a sold piece (its sale is corrected by a return), correcting the opening itself (it stays as
sealed), a time limit (none, Q3).

## A. What engineering ran (all green on the last commit, except as noted)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report; the perf CSV walk is PERF-1 (known, over budget on main too) |
| New tests | `opnfix-corrections` (both projects: roles, confirmation, every refusal writes nothing, FIXED_TAG, missing rate, every reader before/after for condition, karat, net weight and void, a piece in another branch, replay, a property test, the opening's "now", corrections and export), `opnfix-migrations` (0031 with a sealed opening), `pg/opening-fix-race` (correction/void vs sale, two corrections; 11 runs, 0 failures), upgrade test from 0031 |
| Browser | `e2e-openings` (41 checks: the dialog, its preview, the grey Save, the correction, the history, the opening page); REH-1 (278 checks: the preview and a correction, a void from the screen, a re-weigh, the opening's "now", a refused sold piece) |

## B. Walk-through

Sign in as the General Manager (with your passkey).

1. **Inventory**, origin "Opening balance": open an available opening piece.
2. **Correct this opening piece** → **Correct its values** → change **Condition** to the other one. Read the preview:
   the price now, the price after, the change in the stock valuation. Save stays grey.
3. Write a reason, your password, **Confirm with your passkey**, then **Save the correction**. The page shows the new
   price and **Corrections after the seal** with your reason.
4. On another available opening piece: **Void it** → the preview says "out of stock (voided)" → reason, password,
   passkey, **Void the piece**. The piece is VOIDED.
5. **Opening balance** → the sealed branch: the totals are still as sealed; **Now, after the corrections** shows the
   pieces now (one fewer); the list shows both corrections. **Export the pieces with their codes (CSV)**: the last
   columns are the values now.
6. Try a sold opening piece: there is no button (and the server refuses).

## C. Questions for you

None open for this item.
