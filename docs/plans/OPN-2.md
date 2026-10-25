# OPN-2: the condition (new or used) of opening pieces

Branch `claude/opn-2-condition` from main `22d18b4` (OPN-1 merged). Owner answer 2026-10-25: the existing stock
includes used pieces; a used opening piece sells at the USED rate, exactly like sellable scrap (PRC-1). No open
question: the code settles the rest, so this plan goes ahead without a stop (working agreement).

## 1. Where the rate kind is decided today

Every price comes from one module, `backend/src/modules/pricing/service.ts`, and all three places read `origin`
(SCRAP → USED, anything else → NEW, `rateKindFor` in `shared/src/pricing.ts`):

| Place | Used by |
|---|---|
| `priceOf` (`rateKindFor(item.origin)`) | the sale's price at confirmation and its `PRICES_CHANGED` check (sales/service.ts), `dev:sample` |
| `liveRateSql` (sub-query `gr.kind = CASE origin…`) | piece detail and lists without a rate snapshot (inventory/ledger.ts) |
| `rateCaseSql` (snapshot CASE on karat and origin) | `livePriceSql`: inventory list, its sort and totals, purchase detail, the homes' valuation by weight × rate (metrics.ts), every report |

**All three change** to read a new column of the piece, `rate_kind`, instead of `origin`. Nothing else decides a rate:
the frontend only shows what the server sends.

## 2. Data (three migrations: additive → backfill → tighten)

- **0029 `opn2_condition`** (additive):
  - `jewelry_items.rate_kind` text, nullable for now: the rate that prices the piece, NEW or USED (CHECK on the
    values).
  - `opening_lines.condition` text NEW|USED (CHECK on the values), nullable at the database level for the lines of an
    opening sealed before OPN-2 (see §4); **every new line must have one**: the trigger `jerp_opening_line_check`
    refuses an INSERT or UPDATE without it, and the service and the importer require it.
- **0030 `opn2_backfill`**: `rate_kind` = USED for `origin = 'SCRAP'`, NEW for every other piece (today's behaviour,
  so no price moves). Guard: **a DRAFT opening that already has lines stops the migration** with a clear message
  ("finish or empty the draft of branch X before upgrading: its lines have no condition"). Nothing is guessed: a draft
  is a person's unfinished count, and silently calling its pieces new is the error this item removes. No real opening
  exists yet, so this costs nothing in practice.
- **0031 `opn2_tighten`**: `rate_kind` NOT NULL; CHECK `origin <> 'SCRAP' OR rate_kind = 'USED'` and
  `origin <> 'SUPPLIER_NEW' OR rate_kind = 'NEW'` (only an opening piece may be either). **No default**: every insert
  says which rate prices the piece.

Pieces are created in three places: a supplier order (NEW), a sellable scrap purchase (USED), and the seal (the line's
condition). Nothing else sets `rate_kind`; no screen changes it (correcting the condition after the seal is OPN-FIX).

## 3. Behaviour

- **Keyboard entry**: a required choice New / Used, nothing preselected; the line is not added without it.
- **CSV**: a required column **condition** (header "الحالة" or "Condition"; values جديد / مستعمل / new / used, in any
  case, Arabic spelling normalized; the feminine forms جديدة / مستعملة accepted). A missing or unknown value is a
  problem with its row and the column `condition`, and the whole file is refused, as today. The template and the
  export gain the column; the export of a sealed opening shows the condition the piece is priced at.
- **Review**: count and weight by karat **and condition** (21K new, 21K used…), plus by type as today.
- **Sealing**: refused with **409 `OPENING_RATES_MISSING`** when the draft has pieces of a kind whose rate for their
  karat is not set, naming them ("set the used-piece rate of 21K…"). The checklist says "the new-piece **and the
  used-piece** rate of every karat and condition in the sheet". Each piece gets `rate_kind` = its line's condition.
- **Prices**: a used opening piece sells at the USED rate of its karat, a new one at the NEW rate; changing the used
  rate changes only used pieces (scrap and used opening pieces). The sale, its profit "—" (unknown cost) and every
  report work as before.
- **Inventory**: the list shows a "Used" badge on used opening pieces (sellable scrap already says "Scrap"), and a
  filter New / Used (on `rate_kind`); the piece page says which rate prices it ("Priced at the used-piece rate").

## 4. Openings sealed before OPN-2 (tests, staging)

Their pieces were created and priced as NEW; 0030 gives them `rate_kind` NEW, and their lines keep no condition (the
sealed opening is never edited; its export shows the piece's NEW). Recorded as D-opn2-3.

## 5. Tests

- Pricing proof (both projects): a new and a used opening piece of the same karat and weight have different prices in
  the piece detail, the list, the POS search and the valuation; changing only the used rate changes only the used
  piece; scrap and supplier pieces unchanged.
- Importer: good file with both conditions, bad file (missing and unknown condition: row and column), duplicate, 300
  rows; keyboard line without a condition refused.
- Sealing refused when the used (or new) rate of a karat in the draft is missing, accepted once set; pieces carry the
  condition.
- Sale of a used opening piece: price at the used rate, profit "—".
- Upgrade test from 0028 with data (a sealed opening's pieces become NEW; scrap USED; a draft with lines stops the
  upgrade); route-matrix and role tests unchanged (no new route).
- REH-1: a sheet with both conditions, seal, both prices, one sale of each. Browser e2e: the condition field and the
  CSV column. Perf unchanged.

## 6. Commits

| Commit | Content |
|---|---|
| c0 | This plan |
| c1 | 0029 + 0030 + schema; pricing reads `rate_kind`; pieces created with it; tests of the pricing proof |
| c2 | Openings: the condition (keyboard, CSV, template, export, review, seal check) and tests |
| c3 | 0031 tighten + upgrade test |
| c4 | Screens (form, review, checklist, inventory badge/filter, item page) + i18n + e2e; REH-1 and browser scripts re-run |
| c5 | REH-1, perf, acceptance, BACKLOG, DATA_MODEL, FEATURES, decisions D-opn2-*, `verify --full` |

## 7. Out of scope

Correcting the condition after sealing (OPN-FIX); any other new column; any change to how scrap pieces are priced.
