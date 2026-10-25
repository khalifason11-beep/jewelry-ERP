# Manual acceptance: OPN-2 (the condition, new or used, of opening pieces)

For the owner, about 10 minutes, in a desktop browser. Engineering ran section A.

What changed (your answer of 2026-10-25: the existing stock includes used pieces; a used piece sells at the used-piece
rate, exactly like sellable scrap):

- **Every opening line says new or used.** Typing a piece: the **Condition** field starts at "Choose…" and the piece
  cannot be added without it; it starts at "Choose…" again for the next piece (the type and the karat carry over).
  The CSV file has a required column **الحالة / Condition** with جديد or مستعمل (new or used, in any case; جديدة and
  مستعملة work too). A missing or unknown value is listed with its row, and nothing of the file is imported. The
  template and the export have the column.
- **The review counts by karat and condition** (21K new, 21K used…), as do the checklist and the seal dialog.
- **Sealing needs every rate the sheet uses**: the new-piece rate for the new pieces and the used-piece rate for the
  used ones, of each karat. Without one, sealing is refused and the message names the karats.
- **Prices**: a used opening piece sells at the used-piece rate of its karat, a new one at the new-piece rate.
  Changing only the used-piece rate changes only used pieces (used opening pieces and sellable scrap).
- **Inventory**: a "Used" badge on used opening pieces, a **New / Used** filter, and the piece page says which rate
  prices it.

Plan `docs/plans/OPN-2.md`. Migrations **0029** (the columns), **0030** (every existing piece keeps the rate it was
priced at; an opening still in DRAFT with lines stops the upgrade) and **0031** (the rate is required). Decisions
D-opn2-1 to D-opn2-5.

Not built (as agreed): correcting the condition after the seal (OPN-FIX); other new columns; any change to scrap
pricing.

## A. What engineering ran (all green on the last commit, except as noted)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| New tests (both projects) | `opn2-condition` (required condition; CSV values; errors by row and column; review by karat and condition; seal refused then accepted; the pricing proof in the piece page, the list, its price sort and totals, the POS search, the inventory valuation and the homes' stock value; the new/used filter; a used piece's sale at the used rate with profit "—"), `opn2-migrations` (from 0028 with a sealed opening; a draft with lines stops the upgrade; 0031 stops on a bad row); upgrade test from 0015, 0019, 0023, 0024, 0025 and 0028 |
| Browser | `e2e-openings` (35 checks: the condition field, the CSV column, an unknown condition, the review by condition, both prices, the badge, the filter, both piece pages); REH-1 (267 checks: a sheet with both conditions, the seal, both prices, one sale of each) |
| Perf | unchanged against main (4 runs each); the sales CSV walk is above its 30 s budget on this machine on main too (see the report) |

## B. Walk-through

Sign in as the General Manager. **Prices**: computed prices on, and for the karat you test both a **new-piece** and a
**used-piece** rate.

1. **Opening balance › Start** for a branch (or use a draft without lines).
2. Type one piece: choose the type and karat, leave **Condition** at "Choose…": **Add the piece** stays grey. Choose
   **Used**, enter the weights, Enter: the line shows "Used"; the next piece's condition is back at "Choose…".
3. Download the **CSV template**: it has the **الحالة / Condition** column. Fill two rows (one جديد, one مستعمل) and a
   third with "قديم": **Import** lists the third row's problem and imports nothing. Correct it to مستعمل and import.
4. **By karat and condition**: compare with your paper count.
5. If a karat in the sheet has no used-piece (or new-piece) rate yet, **Seal** is refused and the message names the
   karat: set it on **Prices** and seal again.
6. **Seal** (password and passkey). **Inventory**, origin "Opening balance", **Used**: the used pieces with the badge.
   Open one: "Priced at the used-piece rate"; its price is its net weight × the used-piece rate.
7. **Prices**: raise the **used-piece** rate a little. The used opening piece's price changes; a new one's does not.
8. **POS**: sell the used piece. The sale shows the used rate per gram and profit "—".

## C. Questions for you

1. **OPN-FIX** (correcting a sealed opening piece, its condition included) is next in the BACKLOG as P1 before real
   operation. Same order as agreed?

## D. Still open with the client

Q-1 (making charge), Q-5 (clean scrap at another karat), Q-11 (hosting, sign-in hardware, backups), Q-13 (written
agreement), whether the General Manager's funding is a loan or capital (CSH-2).
