# Manual acceptance: OPN-3 (broken scrap in the opening balance)

For the owner, about 20 minutes, in a desktop browser, signed in as the General Manager with your passkey. Engineering
ran section A.

What changed (your request and decisions of 2026-10-30, plan `docs/plans/OPN-3.md`, decisions D-opn3-1…4):

- The opening balance of a branch now also holds its **broken scrap** (كسر): weight only, by karat (any karat from 1 to
  24), the net weight, an optional note; several lines of the same karat are fine (one per bag). Typed in only: there is
  no CSV for broken scrap.
- The draft page, the checklist and the seal dialog show the **pieces**, the **broken scrap** and the **total gold**,
  each with its 24K equivalent. The same seal (password and passkey, once) puts the broken scrap into the branch's
  scrap stock («رصيد افتتاحي»), so a supplier can be settled on the first day.
- An opening with broken scrap only (no pieces) can be sealed.
- After the seal you can **correct** the broken scrap (less, more, or a wrong karat moved to the right one) with a
  reason, your password and your passkey («تصحيح رصيد افتتاحي»). A correction never takes out more than the opening put
  in for that karat, nor more than the scrap stock still holds.
- Nothing else changes: new and used opening pieces work as before (a used piece stays "opening" and sells at the
  used-piece rate, your answer Q1).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| New tests | `opn3-migrations` (upgrade from 0036 with a sealed opening, scrap purchases, a void and a settlement: nothing moves), `opn3-opening-scrap` (draft lines, roles, the seal, homes and stock weight count the scrap once, scrap-only seal, day-one settlement, corrections, a property test: the pool equals the sum of its movements before and after the seal), `pg/opening-scrap-race` (the seal against scrap purchases, a settlement and late edits; a correction against a settlement) |
| REH-1 | 347 checks (was 336): broken scrap typed in the draft (by the API and in the card), the pool unchanged until the seal, the seal dialog's scrap line and total gold, the pool, report and company home after the seal, a correction, the sealed page, a branch whose opening is broken scrap only settling a supplier order on day one |
| Browser scripts | `e2e-openings` 55 checks (was 41: the scrap card: add, edit, remove, totals; the seal dialog; the sealed card; a correction through its dialog); `e2e-states` 98, `e2e-corrections` 19 |

## B. Walk-through

1. **Opening balance** → start the opening of a branch (or open its draft).
2. In **Broken scrap**: choose **21K**, type **10.500**, note «كيس 1», **Add the scrap**. Add **18K 2.000**. Edit the 18K
   line to **3.000** (pencil), then add **22K 1.000** and remove it (bin). The card shows 21K 10.500, 18K 3.000, total
   13.500 g and its 24K equivalent; **Total gold** at the top adds the pieces and the scrap.
3. **Scrap stock** (Scrap › pool) of that branch: unchanged (a draft is not stock).
4. **Seal the opening balance**: the dialog shows the pieces, the broken scrap by karat and the total gold before you
   type your password and confirm your passkey. Seal.
5. **Scrap stock** of the branch: up by exactly 13.500 g (21K 10.500, 18K 3.000). The company home and the stock-weight
   report show the same figure.
6. The sealed page: **Broken scrap** shows 13.500 g sealed and now. **Correct the broken scrap** → **Less weight**, 21K,
   0.500 g, a reason, your password, your passkey → save. The scrap stock falls by 0.500 g and the correction is listed.
   Try **Less weight** 18K **4.000** g: refused (more than the opening put in).
7. A second branch: start its opening, add only broken scrap (say 21K 12.000), seal. Then record a supplier order for
   that branch and settle part of it with 21K broken scrap: it works on the first day.

## C. Questions for you

- **Q1.** One line can hold at most 10 kg (the system-wide weight limit of one entry); more is entered as several lines.
  Is that right for your largest bags of broken scrap?
- Part B (turning a damaged piece into broken scrap) waits for the client's answers (plan §12).
