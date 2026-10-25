# OPN-FIX: correct a piece of a sealed opening

Part 2 of FIX-5 (`docs/plans/FIX-5.md`). Branch `claude/fix-5-opn-fix`; next migration **0032**. **This plan waits for
the owner's approval: nothing is implemented before it.** Each point has a recommendation; a point marked **[OPEN]** is
a business rule the owner decides.

Context: a sealed opening is final (D-opn1-3): nothing is added to or changed in it, and its lines are protected by
triggers. Before the seal, editing stays free as today (keyboard lines are removed and typed again; the import is all
or nothing). After the seal each line is a piece (`jewelry_items`, origin OPENING, cost NULL, `rate_kind` = the line's
condition, OPN-2). OPN-FIX corrects **the piece**, never the opening or its lines.

## 1. What can be corrected, and what each changes

| Correction | Price (live) | Stock valuation (weight × rate) | Stock weight / count | Notes |
|---|---|---|---|---|
| **Condition** NEW ↔ USED (`rate_kind`) | yes: the other rate of the same karat | yes | no | the most likely mistake since OPN-2 |
| **Karat** | yes: the rate of the new karat | yes | weight moves from one karat to the other in the stock-weight report | the new karat must be allowed (setting) |
| **Net weight** | yes (net × rate) | yes | yes (stock weight, inventory ledger) | gross ≥ net > 0 after the correction |
| **Gross weight** | no | no | no (reports use net weight) | display and labels only |
| **Void** (entered by mistake: the piece does not exist) | the piece leaves the price lists | yes: out of the valuation | count −1, weight −net | terminal status VOIDED (exists since MIS-1) |

One correction may change several values at once (condition, karat, weights); a void changes nothing else. A
correction that changes nothing is refused (422). **Recommendation:** all five, as listed.

## 2. Who

**Recommendation:** a new permission **`opening.correct`**, General Manager only, added to `GM_ONLY_PERMISSIONS`
(tested against the defaults and the database, as MIS-1). Reasons: it changes the stock valuation and the price of a
piece outside the normal entry flows, like `purchases.correct` and `scrap.void` (D-mis1-2), and the opening itself is
GM-only (`opening.manage`). A separate permission from `opening.manage` lets the owner later give one without the other.
The branch manager sees the correction history of a piece (who, when, why, before/after values: none of them is a
cost) but cannot correct.

## 3. Reauthentication

**Recommendation: the password in the request (`confirmPassword`, `reauthenticate`, as MIS-1) AND a fresh passkey
confirmation, exactly as the seal (D-opn1-5).** A correction undoes part of a seal and changes the valuation and a
selling price; the seal asked for both, so its exception should not be easier to make than the seal itself. The General
Manager already has a passkey (the seal needed one). The checks run in the same order as the seal: `PASSKEY_REQUIRED`
(403) without a registered passkey, `REAUTH_REQUIRED` (403) without a fresh confirmation, `CONFIRM_PASSWORD_REQUIRED` /
`REAUTH_FAILED` (403) for the password. **[OPEN] Q1:** the owner may choose the password alone (as MIS-1) if the passkey
step is too heavy for a frequent correction.

## 4. Which pieces

- Only a piece of **origin OPENING** whose opening is SEALED → otherwise **409 `NOT_AN_OPENING_PIECE`** (supplier and
  scrap pieces have their own corrections: PUR-FIX, SCR-VOID).
- Only an **AVAILABLE** piece → otherwise **409 `OPENING_PIECE_NOT_AVAILABLE`** naming its code and status:
  - SOLD: the sale snapshotted karat, weight and price; correct the sale by its return (existing flow), never the piece;
  - **TRANSFERRED (in an open transfer):** refused, "receive it first": the transfer is in progress between two
    branches and its receipt checks the piece; after the receipt it is AVAILABLE again in the receiving branch;
  - DAMAGED, RETURNED: refused (owner addendum: AVAILABLE only);
  - VOIDED: refused (a void is final).
  There is no "reserved" status (carts live in the browser, REM-5): a piece in a cashier's cart is AVAILABLE, and the
  sale's confirmation re-reads it under its lock (§6).
- **[OPEN] Q2:** an AVAILABLE piece in **another branch** than the opening's (transferred and received). Recommendation:
  allowed: the mistake is in the piece, wherever it is now, and the General Manager sees every branch. The audit and the
  history name both branches.
- **[OPEN] Q3:** a time limit (e.g. only within N days of the seal). Recommendation: none (MIS-1 has none; owner's
  answer there, Q6), the history shows when.

## 5. Reason

Required, 3–200 characters after trimming (MIS-1 bounds, CHECK in the database): **422 `CORRECTION_REASON_REQUIRED`**.

## 6. The record, the lock and the write

- **Table `opening_piece_corrections`** (migration 0032, append-only): `id`, `item_id` → `jewelry_items`, `opening_id`
  → `openings`, `kind` VOID | CORRECT, `condition_before/after`, `karat_before/after`, `gross_weight_mg_before/after`,
  `net_weight_mg_before/after` (for a void, after = before), `reason`, `corrected_by` → `users`, `session_id`,
  `created_at`. CHECKs: kind, reason length, weights (net > 0, gross ≥ net), condition values, a CORRECT changes at
  least one value. Triggers `jerp_forbid_modification` (no UPDATE, DELETE, TRUNCATE) and `jerp_lock_append_only`; in
  `APPEND_ONLY_TABLES`. No foreign key **to** this table from elsewhere (D-mis1-3).
- **Effective value.** The opening's lines keep the values as sealed (never edited). The piece row is the live stock
  row and carries the **effective** value: the latest correction, else the sealed value. It is updated in the same
  transaction as the correction row, exactly as MIS-1 updates a corrected piece's cost (D-mis1-7) and as every status
  change updates the piece. So every reader (§7) reads the corrected value without a join, and the history is complete:
  the line (as sealed) + every correction row (before → after). A database check proves it: for each corrected piece,
  its row equals the `after` values of its latest correction.
- **The transaction:** Idempotency-Key claimed first (replay → the same answer); the piece row `SELECT … FOR UPDATE`
  (the lock a sale and a transfer take) **before** its status, branch and values are read; then the checks of §4 and
  §8; then the correction row, the piece row update, the movements (§9), the status history (void), the audit entry
  `OPENING_PIECE_CORRECTED` / `OPENING_PIECE_VOIDED` (actor, reason, code, before/after; never the password).
- **Races:** two corrections of the same piece run one after the other (the second sees the first's values and its
  `before` is the first's `after`); a correction and a sale: if the sale locks first, the piece is SOLD and the
  correction is refused (409); if the correction commits first, the sale's confirmation re-prices the piece (PRC-1) and
  refuses with **409 `PRICES_CHANGED`** carrying the new price (or refuses a VOIDED piece). A real-PostgreSQL race test
  covers both orders and both kinds.

## 7. Every reader returns the corrected value

The piece row holds the effective values, so `priceOf` (sale), `liveRateSql` and `rateCaseSql`/`livePriceSql` (item
list, its sort and totals, POS search and grid, piece page, purchase detail, inventory valuation report, branch metrics
and the homes) read them unchanged. **Proof:** a test like `opn2-condition` on PGlite and PostgreSQL: before and after
each correction (condition, karat, net weight, void), the piece page, the list row, the list sorted by price, the list
totals, the cashier's POS search, the inventory valuation report, the branch metrics and the stock-weight report all
change by exactly the expected amount, and nothing else moves.

## 8. Rate availability

A corrected condition or karat needs the current selling rate of its (karat, condition) under the pricing lock (as the
seal): otherwise **409 `OPENING_RATES_MISSING`** with the same message as the seal (it names the karat and the rate).
The new karat must be in `inventory.allowedKarats` (400 otherwise). **[OPEN] Q4:** on a FIXED_TAG installation the
opening pieces have no tag price; recommendation: refuse condition and karat corrections while FIXED_TAG
(`OPENING_NEEDS_COMPUTED_PRICES`, as the seal), allow weights and void.

## 9. Cost, movements and the sealed totals

- **The cost stays unknown** (NULL, never 0): a correction never writes `acquisition_cost`; the movements carry a NULL
  cost (as the seal's).
- **Net weight correction:** an `ADJUSTMENT` −1 movement with the old net weight, then +1 with the new (ref
  `opening_correction`), both at NULL cost: the count is unchanged and the inventory ledger's weight moves by new − old
  (as D-mis1-7's pair). **Karat or condition only:** no movement (count and weight unchanged); the stock-weight report
  reads the pieces by karat, so a karat correction moves the weight from one karat's line to the other at once.
- **Void:** AVAILABLE → VOIDED (status history with the reason) and an `ADJUSTMENT` −1 at the piece's net weight and
  NULL cost.
- **The sealed opening** keeps its totals **as sealed** (its lines never change). Its page adds **Corrections after the
  seal** (code, void or correction, before → after, reason, who, when) and its summary a second line **now**: count and
  weight by karat and condition of its pieces as they are now (voided pieces out, corrected values in, sold pieces as
  sold). The CSV export keeps its columns (as sealed) and adds *Status now*, *Condition now*, *Karat now*, *Net weight
  now*, *Gross weight now*.

## 10. Migration, routes, permissions, classification, screens

- **Migration 0032 (additive only):** the table with its CHECKs, triggers and `jerp_lock_append_only`; the permission
  `opening.correct` and its grant to GENERAL_MANAGER (seed, `ON CONFLICT DO NOTHING`). No DROP, no change to an
  existing constraint, no `allow-destructive` (none needed: VOIDED and ADJUSTMENT exist since MIS-1 and the cost model).
  Upgrade test from 0031 with data (a sealed opening, a corrected piece after the upgrade); `check:migrations`,
  `check:drizzle`, DATA_MODEL rows.
- **Route:** `POST /openings/:id/pieces/:itemId/correction` `{ action: 'VOID' | 'CORRECT', condition?, karat?,
  grossWeightMg?, netWeightMg?, reason, confirmPassword }`: route matrix row (`opening.correct`, `reauth`, Idempotency-Key
  in the transaction), generated role tests (403 for the branch manager and the cashier), the idempotent-routes list.
  The corrections are read through `GET /openings/:id` (its new section) and the piece page (`GET /inventory/items/:id`
  adds `openingCorrections`).
- **Field classification:** the new response names (`openingCorrections`, `conditionBefore/After`, `karatBefore/After`,
  weights before/after, `kind`, `correctedByName`, `now` totals) are SAFE: none is a cost. The cost stays NULL and is
  never sent by this route.
- **Error codes** (DEPLOYMENT): `NOT_AN_OPENING_PIECE`, `OPENING_PIECE_NOT_AVAILABLE`, `OPENING_CORRECTION_UNCHANGED`
  (422), and the existing `OPENING_RATES_MISSING`, `CORRECTION_REASON_REQUIRED`, `PASSKEY_REQUIRED`, `REAUTH_*`.
- **Screens:** on the piece page of an AVAILABLE opening piece, the General Manager sees **Correct this opening piece**:
  a dialog with *Void* or *Correct* (condition, karat, weights prefilled with the current values), the reason, the
  password and the passkey step; the piece page shows its correction history. The sealed opening's page shows the
  corrections table and the "now" summary. Arabic for every text.
- **REH-1** (same commit as the route and the screen, CLAUDE.md rule): on the production rehearsal, after the seal,
  correct one piece's condition (its price changes to the other rate), correct one piece's net weight (the stock-weight
  report moves by the difference), void one piece (count −1), and check the opening's "now" summary and the refusals
  (a sold piece, no reason, a branch manager).
- **e2e:** `e2e-openings` extended with the dialog (void and correct, with the virtual passkey).
- **Docs:** acceptance script `docs/acceptance/OPN-FIX.md`, decisions **D-opnfix-1…**, FEATURES, BACKLOG (OPN-FIX
  DONE), DATA_MODEL, DEPLOYMENT.

## 11. Commits, tests, risks, questions

| Commit | Content |
|---|---|
| c1 | 0032 + schema + permission + classification + docs + upgrade test |
| c2 | Service + route + matrix + role tests: correct and void, every refusal, idempotency, audit; the consistency test of §7 (both projects); a property test (any sequence of corrections leaves the piece equal to the last `after`, the ledger weight equal to Σ pieces, the cost NULL) |
| c3 | `pg/opening-fix-race.test.ts`: correction vs sale, correction vs correction, void vs sale (real PostgreSQL) |
| c4 | The sealed opening: corrections table, "now" summary, export columns |
| c5 | Screens + Arabic + e2e + REH-1 (REH-1 updated in the same commit) |
| c6 | Perf (unchanged; PERF-1), acceptance, decisions, BACKLOG, FEATURES, `verify --full`, report |

**Risks:** the piece row changes karat/weights (the live row, as status and cost already do); every reader is already
on it, which is why §7's test covers every path. A karat correction moves the piece's whole movement history to the new
karat in any per-karat view of past days (the movements carry no karat); acceptable for an opening mistake ("as if
entered right"), and no current report shows past movements by karat. The passkey step (Q1) adds friction.

**Questions for the owner:**

1. **[OPEN] Q1** Reauthentication: password **and** fresh passkey (recommended, as the seal), or password only (as
   MIS-1)?
2. **[OPEN] Q2** An AVAILABLE opening piece now in another branch (transferred and received): correctable
   (recommended) or only in the opening's branch?
3. **[OPEN] Q3** A time limit after the seal: none (recommended), or N days?
4. **[OPEN] Q4** FIXED_TAG installations: refuse condition and karat corrections (recommended), or allow?
5. **[OPEN] Q5** Gross weight: correctable (recommended: it is printed on labels later, LBL-1), or net weight only?
