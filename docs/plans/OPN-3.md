# OPN-3 — Broken scrap in the opening balance (plan, approved 2026-10-30)

Owner request of 2026-10-30 (first written as SCR-1, plan `e283f21`). Branch `claude/scr-1` from `origin/main` 12c09f1.
Part A is the item; part B (§12) is a proposal only and is **not built**.

## 0. Owner decisions (2026-10-30)

- **Name:** OPN-3 everywhere (this file, `docs/acceptance/OPN-3.md`, BACKLOG "OPN-3 — Broken scrap in the opening
  balance", decisions D-opn3-*). The cancelled SCR-1 in the BACKLOG stays untouched.
- **Q1:** used opening pieces keep origin OPENING with the used-piece rate (D-opn2-1). No change.
- **Q2:** opening broken scrap accepts **any karat 1–24**, as a scrap purchase does.
- **Q3:** one weight per line, the net weight.
- **Q4:** movement types OPENING «رصيد افتتاحي» and OPENING_CORRECTION «تصحيح رصيد افتتاحي».
- **Q5:** an opening with broken scrap and no pieces may be sealed.
- **Q6:** corrections as proposed in §4; no time limit.
- **Q7:** **no CSV for broken scrap**: keyboard entry only. The pieces importer is untouched; no scrap template or import
  route, no `kind` column on `opening_imports`.
- **Q8:** several lines of the same karat, one pool movement per line.
- **Q9:** the optional note (≤ 120 characters) stays.
- **Q10:** the opening stays General Manager only.
- **Part B:** not approved now; §12 stays a proposal waiting for the client's answers.
- **Migration:** this item takes **0037**; MNY-1 moves to 0038 when it is built.
- Reminder: the seal still asks for the password and passkey once only (UX-3); every new route is in the route matrix.

## 1. Findings of step 1 (code read + a real run on a fresh database)

**How it was run.** A throwaway test (not committed; kept in the session scratchpad) on a **fresh PGlite database**:
migrations only, then `bootstrapProduction` (the General Manager and one branch, nothing else, no fixture world), the
GM signed in over HTTP with a passkey and acknowledged recovery codes, the new-piece and used-piece rate of 18K set
through `POST /api/gold-rates`, one item type created; then through the real routes: `POST /openings`, two typed lines
(one NEW, one USED), a two-row CSV import (one مستعمل, one جديد), `POST /openings/:id/seal` (password + fresh passkey);
then the inventory list, the pool, the stock weight, and a cash sale of a used piece.

| Check | Result |
|---|---|
| New and used pieces entered (keyboard and CSV, Arabic words normalized) | **Works.** 4 lines, seal 200, codes J-1001…J-1004 in the sheet's order (imported first, then typed). |
| A used opening piece is sellable at the **used-piece rate** of its karat | **Works.** `rate_kind` USED; inventory list shows 80,000/g (the used rate) vs 100,000/g for the new ones; the price = weight × rate (5.500 g → 440,000). |
| The sale of a used piece | **Works.** 200, `final_price` 440,000 = `price_gold_value`; `acquisition_cost`, `unit_cost` and `profit` all **NULL**. |
| Cost stays NULL, never 0 | **Works.** `acquisition_cost` NULL on all 4 pieces, `cost_is_estimated` false; the 4 `ADJUSTMENT +1` movements have `cost_value` NULL. |
| No money, no pool | **Works.** 0 ledger entries, 0 pool entries after the seal. |
| Stock weight | **Works.** Items 29.500 g (18K) = 22.125 g 24K; broken scrap 0. |
| Seal refused without the needed rate / on FIXED_TAG / without passkey | Covered by the existing tests (`opn2-condition`, `opn1-openings`); fresh settings start at RATE_COMPUTED. |
| **A used opening piece has origin SCRAP** | **No — by design.** Its origin is **OPENING** and its *condition* (rate kind) is USED (owner decision D-opn2-1, 2026-10-25: "The origin stays OPENING"). It sells and prices exactly like a used piece bought from a customer, but the inventory filter "origin = scrap" does **not** list it (the run: 0 rows); the new/used filter does. The owner's message of today says "origin SCRAP / condition used": question **Q1**. |
| **Broken scrap at the opening** | **Missing.** There is no way to record it: the opening covers pieces only, and the pool (`scrap_weight_entries`) accepts only SCRAP_PURCHASE, SUPPLIER_SETTLEMENT and REVERSAL. On day one the pool is 0, so no supplier order can be settled (settlement refuses "Not enough {karat}K broken scrap in the pool"). |

Other facts found that shape the design:

- The pool's balance is `SUM(weight_mg)` per branch and karat, never cached (`poolBalances`). **No reader filters it by
  event type** (stock weight, branch and company homes, the stock-weight report, the inventory report summary, the pool
  view, backup stats), so a new movement type is counted everywhere at once, once.
- The stock weight = AVAILABLE pieces + the pool (`stock/weight.ts`); `phase4.test.ts` already checks
  total = items + pool and that every screen shows the same pool figure.
- Buying broken scrap accepts **any karat 1–24** (SPEC §4: buying is not restricted); only *sellable* pieces must be an
  allowed karat. The owner's request says "karat from the branch's allowed karats": allowed karats are a **company**
  setting, not per branch, and they would forbid recording, say, 18K broken scrap in a 21K-only shop. Question **Q2**.
- A DAMAGED piece today leaves the stock weight entirely (only AVAILABLE pieces count, the DAMAGE movement is −1): its
  gold is in no total. Relevant to part B.
- `MNY-1` (plan pushed, not approved) also proposes migration 0037. Whichever item is built first takes 0037; the other
  takes the next number. Nothing else overlaps.

## 2. Data model (migration 0037, additive)

**`opening_scrap_lines`** — the broken scrap of a draft opening (one row per line, as entered):

| Column | Type | Rule |
|---|---|---|
| `id` | serial PK | |
| `opening_id` | int NOT NULL → `openings` | |
| `line_no` | int NOT NULL | UNIQUE (`opening_id`, `line_no`); keeps the entry order |
| `karat` | smallint NOT NULL | CHECK 1–24 (the service applies Q2) |
| `weight_mg` | integer NOT NULL | CHECK > 0; whole mg (the pool's column is `integer` too) |
| `note` | text NULL | ≤ 120 characters, optional ("bag 3", "the safe") |
| `created_by`, `created_at`, `updated_by`, `updated_at` | | |

No cost, no price, no money column. Several lines of the same karat are allowed (several bags); the seal writes one pool
movement per line, as the owner asked.

Trigger `jerp_opening_scrap_line_check` (same pattern as `jerp_opening_line_check`, migration 0026): INSERT, UPDATE and
DELETE are refused when the opening is SEALED; TRUNCATE refused (`jerp_forbid_modification`). A draft line may be edited (UPDATE) or removed (DELETE), audited by the service.

**`opening_scrap_corrections`** — append-only, a correction after the seal (§4):
`id`, `opening_id`, `branch_id` (the opening's branch), `karat`, `weight_mg_change` (signed, ≠ 0), `reason` (3–200),
`corrected_by`, `session_id`, `created_at`. Triggers: `jerp_forbid_modification` (no UPDATE/DELETE/TRUNCATE),
`jerp_lock_append_only`, and a check that the opening is SEALED and the branch is the opening's branch.

**`scrap_weight_entries.event_type`** — two new values, **OPENING** and **OPENING_CORRECTION** (names: Q4).
The CHECK `ck_scrap_weight_entries_event_type` is replaced (DROP CONSTRAINT then ADD with the wider list), so the
statement carries `-- allow-destructive: D-opn3-1 widen the event-type CHECK of the pool with OPENING and
OPENING_CORRECTION (no row changes)`. `SCRAP_WEIGHT_EVENT_TYPES` in `shared/src/enums.ts` and `db-checks.ts` follow.
Pool rows of the seal: `ref_type` 'opening_scrap_line', `ref_id` the line, `ref_number` `OPN-<branch code>`; of a
correction: `ref_type` 'opening_scrap_correction', `ref_id` the correction.

Grants as in 0032: the runtime role gets SELECT/INSERT on the new append-only table, SELECT/INSERT/UPDATE/DELETE on the
draft lines (the trigger guards the sealed ones). Drizzle schema, `APPEND_ONLY_TABLES`, `DATA_MODEL.md` updated.

**Upgrade safety:** nothing existing is updated or deleted. The migration does not touch `openings`, `opening_lines`,
`jewelry_items` or any pool row; an upgrade test (§9) proves a database that already holds a sealed opening, scrap
purchases, a void and a settlement has the same pool balances, the same opening and the same pieces after 0037.

## 3. Ledger and pool effect per step

No step of this item writes money: no `ledger_entries`, no drawer, no bank, no cost (the existing seal test counts the
ledger entries before and after; the new tests do the same for scrap lines and corrections).

| Step | Pool (`scrap_weight_entries`) | Pieces / movements | Other |
|---|---|---|---|
| Add / edit / remove a draft scrap line | nothing | nothing | the line; audit `OPENING_SCRAP_LINE_ADDED / _CHANGED / _REMOVED` (karat, weight before/after) |
| **Seal** | **+ weight_mg per line**, type OPENING, at the opening's branch and the line's karat | the pieces as today (unchanged) | opening SEALED; audit `OPENING_SEALED` now also carries the scrap totals |
| Correction after the seal (§4) | ± weight, type OPENING_CORRECTION | nothing | correction row; audit `OPENING_SCRAP_CORRECTED` |
| Later scrap purchases, voids, settlements | as today | as today | as today |

Invariant (unchanged, tested): the pool balance of a branch and karat = Σ of its movements. After the seal, for each
karat: Σ OPENING movements of the branch = Σ that karat's sealed scrap lines.

## 4. The opening's states

```
            add / edit / remove piece lines and scrap lines, import piece CSV
            ┌───────────────┐
            ▼               │
  (none) ──create──► DRAFT ─┘
                       │
                       │ seal: password + fresh passkey, once per branch; ONE transaction:
                       │   pieces → items (as today) + scrap lines → pool (OPENING)
                       ▼
                    SEALED ──── lines never change (service 409 OPENING_SEALED + database triggers)
                       │
                       ├── piece correction / void (OPN-FIX, as today)
                       └── scrap correction: an OPENING_CORRECTION movement ± weight (new)
```

**Who:** the General Manager only, everywhere (`opening.manage` for the draft and the seal, `opening.correct` for the
corrections; both already in `GM_ONLY_PERMISSIONS`). Branch managers and cashiers: 403 on every route.

**Seal rules (changed):** an opening can be sealed when it has **at least one piece line or one scrap line** (today: at
least one piece; a branch could start with broken scrap only — question Q5). The rate check (409
`OPENING_RATES_MISSING`) and the computed-prices check apply only when there are piece lines (scrap has no price).

**Scrap correction after the seal (proposal, question Q6):** like OPN-FIX: reason (3–200), the password in the request
and a fresh passkey. The GM gives a karat and a signed change ("21K: −12.500 g", "18K: +3.000 g"); a wrong karat is two
corrections in one request (−X at the wrong karat, +X at the right one, one transaction, one audit). A decrease is
refused when it would take the branch's pool for that karat below 0 (409 `SCRAP_POOL_SHORT`, the existing error with the
balance) — the scrap may already have paid a supplier. Proposed limit: the corrections of a karat can never take more
out than the opening put in for it (409 `OPENING_SCRAP_CORRECTION_TOO_LARGE`); otherwise it would not be an opening
correction.

## 5. API, permissions, idempotency

| Route | Permission | Re-auth | Idempotency-Key |
|---|---|---|---|
| `POST /openings/:id/scrap-lines` (karat, weightMg, note?) | `opening.manage` | no (as piece lines) | yes, in the transaction |
| `POST /openings/:id/scrap-lines/:lineId` (edit: karat, weightMg, note) | `opening.manage` | no | yes |
| `POST /openings/:id/scrap-lines/:lineId/remove` | `opening.manage` | no | yes |
| `POST /openings/:id/seal` (unchanged route) | `opening.manage` | **yes, as today** (`reauth: true`) | yes |
| `POST /openings/:id/scrap-corrections` (karat, weightMgChange, reason, confirmPassword; or a karat move) | `opening.correct` | **yes** (`reauth: true`, as OPN-FIX) | yes |

No conditional step-up is added, so no new `reauthWhen`; the two re-auth routes are declared `reauth: true` in
`shared/src/route-matrix.ts` and the UX-3 audit test covers them. All routes are `global` (GM only), as the other
opening routes. Error codes: existing `OPENING_SEALED`, `OPENING_EMPTY` (text changes: "no pieces and no broken
scrap"), `SCRAP_POOL_SHORT`; new `OPENING_SCRAP_CORRECTION_TOO_LARGE`. Every new error code
and route goes in the route matrix and `decisions.md` (check:docs).

**Responses:** `GET /openings/:id` gains `scrapLines` (all of them; there are few), `summary.scrap` =
`{ byKarat: [{ karat, lines, weightMg, pureMg24 }], weightMg, pureMg24 }`, `summary.total.pureMg24` for the pieces, and,
once sealed, `scrapCorrections` and `scrapNow` (sealed lines + corrections per karat). `GET /openings` gains
`scrapWeightMg` per opening. The seal response gains `scrap` (same shape). All new fields are weights, classified
**SAFE** in `shared/src/field-classification.ts` (the pool is visible to branch managers; these routes are GM-only
anyway). The 24K equivalent uses the one helper `pureGoldMg`, rounded once per karat, as the pool view.

## 6. Entry of broken scrap (keyboard only, Q7)

**Keyboard form** (on the draft page, its own card "Broken scrap" / "الكسر"): karat (a select of 1–24, Q2), weight in
grams (the usual weight input, 3 decimals, converted to mg on the server), an optional note, "Add". Below: the lines
(karat, weight, note, edit, remove) and a clear total per karat, all karats, and the 24K equivalent.

## 7. Screens (Arabic first, short text, UX-2 rules)

- **Draft page:** the summary shows two blocks side by side: **Pieces** (count, weight per karat, 24K) and **Broken
  scrap** (weight per karat, 24K), and one **Total gold** line (weight and 24K). The "Broken scrap" card with the form
  and the lines.
- **Seal checklist and dialog:** the same totals before the password: pieces count and weight, broken scrap per karat,
  24K equivalent of each and of the whole. One new line on the checklist: "Broken scrap goes into the branch's scrap
  stock and can settle suppliers." No technical codes.
- **Sealed page:** the sealed totals of both, the scrap lines as sealed, and the scrap corrections (who, when, karat,
  change, reason) with a "Correct broken scrap" button (GM, `opening.correct`) opening the reason + password dialog.
- **Stock-weight screens, branch and company homes, stock-weight report, pool view:** no change in code; the opening
  scrap enters through the pool and is counted once (tests §8).
- **FirstSteps (UX-4):** the opening step's wording "Enter the opening balance" stays; no change needed.
- Arabic strings via `i18n-ar.ts`; `npm run i18n:check` stays green.

## 8. Concurrency

| Case | What happens |
|---|---|
| Seal vs a draft edit (piece or scrap line) | Every draft write and the seal take the opening row `FOR UPDATE` first. The edit after the seal gets 409 `OPENING_SEALED`; the database trigger refuses it even if the service did not. |
| Two seals (double click, two tabs) | The second waits on the opening row, then sees SEALED → 409; the Idempotency-Key returns the first result on a retry. |
| Seal vs a scrap purchase / void / settlement of the same branch | The seal takes the pool lock (`lockPool`, advisory per branch) **after** the opening row and the pricing lock, before writing the movements. Purchases, voids and settlements take the pool lock too, so the movements are serialized; nothing is read-modify-written (append-only rows), so no movement is lost and the balance is Σ of all of them. |
| Scrap correction vs a settlement taking the same karat | Both take the pool lock; the correction re-reads the balance under it, so neither can take the pool below 0. |
| Lock order | opening row → pricing (shared, only with pieces) → item numbering → pool. No path takes the pool and then the opening or pricing, so no cycle. Proven by a PostgreSQL race test. |

## 9. Tests

- **Unit / API (both projects):** draft lines add, edit, remove (audited), karat rule (Q2), weight > 0, note ≤ 120;
  sealed → 409 and the trigger refuses INSERT/UPDATE/DELETE; seal writes one OPENING movement per line at the right
  branch and karat; nothing in the ledger; pieces unchanged; an opening with only scrap seals (if Q5 yes) and with
  neither is refused; the rate check ignores scrap; branch manager and cashier 403 on every new route; field
  classification and cost-visibility requests for the new GET fields; route-matrix and UX-3 audit tests.
- **Settlement on day one:** seal an opening with 21K broken scrap, then settle a supplier order with it (the bug that
  started this item).
- **Corrections:** + and −, the karat move, refused below 0 and beyond what the opening put in; audit; re-auth required.
- **Property-based (fast-check):** random sequences of scrap purchases, voids, settlements, draft scrap lines (added,
  edited, removed) and one seal, applied to a branch: before and after the seal, for every karat, the pool balance =
  Σ movements = Σ purchases − voids − settlements + Σ sealed lines (+ corrections); draft lines never count; stock weight
  = AVAILABLE pieces + pool, and the homes and the report show the same number (no double count).
- **Upgrade test:** a database at 0036 holding a sealed opening, scrap purchases, a void and a settlement → 0037 → same
  pool balances per branch and karat, same opening, lines, pieces.
- **PostgreSQL race test** (`test/pg/opening-scrap-race.test.ts`): a seal with scrap lines, broken-scrap purchases and a
  settlement of the same branch at once; final balance = Σ movements; edits racing the seal end in 409, never in a line
  added after the seal.
- **e2e (`scripts/e2e-openings.mjs`):** the scrap card, totals, seal dialog totals, the sealed page.

## 10. REH-1 additions (same commits as the routes and screens)

On the empty production database, in the existing opening step: add two broken-scrap lines by keyboard (21K and 18K,
Q2) and a second 21K one (Q8); check the draft totals and the 24K equivalent; the seal dialog shows both blocks; after
the seal the sealed page shows them, the branch's stock weight and the company home include them once, and the
existing supplier-order step settles **with the opening scrap** (today REH-1 buys broken scrap first; that purchase
stays, the settlement uses the pool). A correction after the seal (−1.000 g) with its dialog. Expected about +10
checks (336 now).

## 11. Docs and commits

Docs: SPEC §4 (broken scrap enters at the opening as weight), §7.1 (the pool can be funded at the opening), §13 (the
opening covers pieces new and used and broken scrap); DATA_MODEL (two tables, the two event types);
DEPLOYMENT (opening notes: the scrap card, the correction; migration 0037); decisions D-opn3-1… (the CHECK
replacement, names, seal rule, correction rule); BACKLOG; FEATURES; route matrix; acceptance
`docs/acceptance/OPN-3.md`.

Commits after approval, suite green and pushed after each, REH-1 run before every push:
1. migration 0037 + Drizzle schema + enums/db-checks + upgrade test + DATA_MODEL;
2. service (draft scrap lines, seal into the pool, corrections) + routes + route matrix + field classification + unit,
   property and API/role tests + PG race test + REH-1 (the new routes and response fields, by API);
3. screens + Arabic + e2e + REH-1 (the screens);
4. acceptance, docs, decisions, BACKLOG, `npm run verify -- --full`, report.

## 12. Part B (optional, separate approval): a damaged piece into the pool

**What:** a piece in DAMAGED status is broken up into broken scrap: it leaves the stock for good and its weight enters
its branch's pool at its karat.

**Effect (proposal):**
- Piece: a new terminal status **SCRAPPED** (ITEM_STATUSES, the status CHECKs replaced with an `allow-destructive`
  marker), status history row DAMAGED → SCRAPPED with the conversion as ref. No new inventory movement: the DAMAGE
  movement already took it out of the count and weight (−1); its cost left the stock value then too.
- Pool: + the weight, type **DAMAGED_PIECE** (new), `ref_type` 'scrap_conversion', in the piece's branch and karat.
- Record: append-only `scrap_conversions` (piece, branch, karat, net weight of the piece, weight put in the pool,
  reason, who, session, when); audit `PIECE_SCRAPPED`. One transaction: piece row `FOR UPDATE`, then the pool lock.
- Who: permission **`inventory.scrap_damaged`** — Arabic «تحويل قطعة تالفة إلى كسر» — for the branch manager (own
  branch only) and the General Manager; cashier 403. Because the branch manager holds it, it does **not** go into
  `GM_ONLY_PERMISSIONS` (that list is for GM-only grants); the role tests prove the cashier never has it. Route
  `POST /inventory/items/:id/scrap` in the route matrix, `reauth: true` as the other adjustments (QB4).
- Today's gap it closes: a DAMAGED piece is in no stock-weight total; after conversion its gold counts again.

**Questions for part B:** QB1 only DAMAGED pieces, or also AVAILABLE in one step? QB2 the weight that enters the pool:
the piece's recorded net weight, or re-weighed (and may it differ)? QB3 can a conversion be undone (GM only, a
reversing pool movement and SCRAPPED → DAMAGED)? QB4 re-auth for the branch manager: yes as other adjustments, or
none? QB5 opening pieces (cost unknown) and supplier pieces alike? QB6 an allowed-karat check does not apply (any karat
can be scrap): agreed?

## 13. Questions for the owner (answered 2026-10-30, see §0)

1. **Q1 — Used opening pieces' origin.** Today they are origin OPENING with the used-piece rate (your decision
   D-opn2-1); they sell and price exactly as a used piece bought from a customer, but the inventory filter "scrap" does
   not list them (the "used" filter does). Keep as is (proposed), or must they show as scrap?
2. **Q2 — Karats of opening broken scrap.** Your message says the allowed karats. Allowed karats are one company
   setting (not per branch), and buying broken scrap accepts any karat 1–24. Proposed: **any karat 1–24**, as a purchase,
   so 18K broken scrap in a 21K shop can be recorded. Or only the allowed karats?
3. **Q3 — One weight per line.** A broken-scrap purchase records gross and net and the pool takes the net. For the
   opening, proposed: **one weight** (the net, what the scale shows after removing stones), as you described. Agreed?
4. **Q4 — Names in reports.** Movement types OPENING and OPENING_CORRECTION, shown as «رصيد افتتاحي» and «تصحيح
   رصيد افتتاحي». Agreed?
5. **Q5 — An opening with broken scrap only** (no pieces): may it be sealed? Proposed yes.
6. **Q6 — Corrections after the seal.** Proposed: GM only (`opening.correct`), reason + password + passkey, never
   below the pool's balance, never more out than the opening put in for that karat; a wrong karat = a move between two
   karats in one step. Agreed, and is there a time limit?
7. **Q7 — CSV.** A separate small file for broken scrap (karat, weight, note) as proposed, or not needed at all
   (keyboard only, since there are few lines)?
8. **Q8 — Several lines of the same karat** (several bags) allowed, one pool movement each? Proposed yes.
9. **Q9 — The note column** (optional, ≤ 120 characters): wanted?
10. **Q10 — Branch manager visibility.** The draft and sealed opening stay General Manager only (as today); the
    branch manager sees the opening scrap only as part of the pool on the stock-weight screens. Agreed?
11. **Q11 — The item name.** SCR-1 is already the cancelled "Customer identification on scrap purchases" in the
    BACKLOG. Rename the old one SCR-0, or call this one OPN-3?
12. **Part B:** QB1–QB6 in §12, only if you want part B.
