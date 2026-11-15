# LBL-2: print a piece's label while the opening balance is still a draft

Status: **plan only, waiting for the owner's approval.** No code, no migration, no deployment before it. This item
changes how piece codes and barcodes are given out, so every rule below marked **[OPEN]** is a question, not a decision.

**The owner's need (2026-11-15).** The owner wants each piece's label printed as soon as its line is added to the
opening balance, while the opening is still a DRAFT. The piece is then tagged on the spot, not days later after the
seal. Who may print: the people with `opening.enter` (a branch manager for the own branch, and the General Manager),
with the same scope rules as OPN-4.

## 1. What exists today (verified in the code)

- **A draft line has no code.**
  - `opening_lines` holds `line_no`, type, description, karat, condition and weights. Its `item_id` is NULL until the
    seal.
  - `sealOpening` (`backend/src/modules/openings/service.ts`) reads the lines in sheet order (`line_no`), calls
    `nextItemCodes(tx, n)` (`backend/src/core/numbering.ts`) and inserts `jewelry_items` with that consecutive block. It
    then sets `opening_lines.item_id`. This is D-opn1-1: "codes in the sheet's order".
- **Numbering.**
  - One counter, `document_sequences` scope `ITEM` (starting at 1001), is shared by **every** piece in the system:
    supplier orders, openings, any piece created.
  - `nextItemCode` allocates one number; `nextItemCodes(n)` allocates a consecutive block in one atomic upsert.
  - Code `J-n`; barcode `628100` + n padded to 6 digits (12 digits; 13 once n passes 999,999).
  - The counter row stays locked until the transaction commits, so allocations are serialized and numbers are never
    handed out twice.
- **Draft lines are deleted for real.**
  - `POST /openings/:id/lines/:lineId/remove` deletes the row. An audit row `OPENING_LINE_REMOVED` keeps what the line
    held.
  - A piece line has no edit route: a wrong line is removed and typed again.
  - `line_no` is `max + 1`, so a removed last number can be taken again by the next line (`nextLineNo`).
- **The draft lock.** Every draft write (add, remove, import, seal) first takes `FOR UPDATE` on the opening row
  (`lockDraft`). Trigger `jerp_opening_line_check` refuses any write to a sealed opening's lines.
- **LBL-1.**
  - `label_prints` has an `item_id` that is NOT NULL, with a foreign key to `jewelry_items`.
  - Trigger `jerp_label_print_check`:
    - the piece must be in the row's branch;
    - FIRST only when the piece has no earlier print, REPRINT only after one;
    - one FIRST per piece (`label_prints_first_uq`).
  - The table is append-only.
  - Printing an opening needs it SEALED (409 `OPENING_NOT_SEALED`).
  - The label carries **only** the barcode (Code128 of the 12 digits) and the same digits under it.
- **Tests that assume seal-time codes:**
  - `opn1-openings` "sealed: codes in the sheet order…" expects consecutive codes in `line_no` order and
    `firstCode` = the first line's code;
  - `lbl1-prints` expects a draft opening's document print to be refused.

## 2. The core design: how a label can exist before the seal

### Option A — reserve the code and barcode when the line is added (recommended)

- `opening_lines` gets two new nullable columns, `reserved_code` and `reserved_barcode`. Each is **unique** across the
  table.
- The add-line transaction calls `nextItemCode(tx)` and stores the result on the line.
- The CSV import calls `nextItemCodes(tx, rows)` once and gives the block to the rows in the file's order.
- The seal inserts each `jewelry_items` row with **exactly** its line's reserved code and barcode. It allocates nothing.
- Before the seal, the piece does not exist anywhere but in its draft line. No stock list, count, report, POS search,
  transfer or valuation can see it, because none of them read `opening_lines`.

Risks and how they are handled:

| Risk | Handling |
|---|---|
| Stock and reports see draft pieces | Impossible: no `jewelry_items` row exists before the seal. Nothing that reads stock changes. |
| Numbering races (two users, or a purchase at the same time) | The existing counter row lock serializes them. Each line's number is allocated in its own transaction, so two people adding lines at once get different numbers. The PostgreSQL race test proves it (§7). |
| Uniqueness | `reserved_code` and `reserved_barcode` are unique in `opening_lines`, and `jewelry_items.code` and `barcode` stay unique. The counter never goes back, so a reserved number is never handed to a purchase. The seal checks once more (§5). |
| Gaps | A removed line's number is never used again (§3.2). |
| Codes no longer consecutive within an opening | Purchases entered during the weeks of the opening take numbers in between. This is accepted: only uniqueness matters to the scanner. |
| Long imports hold the counter lock | Already true today at the seal. The import's transaction is short: parse first, then one insert. |
| Existing tests | `opn1-openings` "codes in the sheet order" becomes "codes in entry order, as reserved". This is a deliberate change of D-opn1-1, written up as D-lbl2-1. It is **not** a loosening: the test still asserts the exact code of every piece. |

### Option B — create a real `jewelry_items` row in a draft state (rejected)

- A new piece status, `DRAFT`, would exist from the line's entry.
- **Why rejected:**
  - Every reader of `jewelry_items` would have to exclude `DRAFT`. That covers the stock list, counts, stock weight,
    valuation, the POS search and scan, transfers, adjustments, supplier returns, every report and export, the
    dashboards, `piecesOf` and the item triggers. One forgotten filter would show a piece that is not in stock, or let
    it be sold.
  - A piece row can never be deleted (history rules). Removing a draft line would therefore need a new "voided draft
    piece" state that stays in the table forever.
  - It would need an inventory movement at creation, or a special case in the movement rules.
- The leak risk is permanent and grows with every new report. Option A has none.

### Option C — a temporary label at entry, the real one at the seal (rejected)

- A temporary label would be printed at entry and replaced by the real one at the seal.
- This defeats the purpose: every piece would be labelled twice.

**Recommendation: Option A.**

## 3. Numbering rules

### 3.1 Codes follow entry order, not sheet order (supersedes D-opn1-1)

**What changes:**

- D-opn1-1 said: "At sealing every piece gets the next system code and barcode, in the sheet's order."
- The new rule, D-lbl2-1: "Every opening line gets its piece code and barcode **when it is added**, in the order of
  entry. The seal gives each piece the code reserved on its line."

**What stays:**

- `J-…` codes from the same counter, and the same barcode form;
- no custom code column;
- the old shop number still goes in the description.

**The CSV import:**

- An import of n rows reserves **one consecutive block** of n numbers in the same transaction that inserts the lines.
- The rows get the numbers in file order.
- A refused file (any row invalid) reserves nothing, because the transaction rolls back. The counter is transactional
  (one row, updated in the transaction), so no number is lost.
- Lines typed by hand between two imports get their numbers between the two blocks.

**The seal response.** `firstCode` stays the lowest code of the opening. A new field, `lastCode`, gives the highest.
Both are documented in the route matrix.

### 3.2 Numbers of removed lines are never reused

- The counter only moves forward. A removed line takes its reserved number with it.
- The audit row `OPENING_LINE_REMOVED` records the reserved code, and whether its label was printed.
- **The seal summary** (shown before the seal, and in the sealed opening's page) shows:
  - the number of pieces;
  - the code range;
  - **"n numbers in this range are not used: removed lines (m of them had printed labels)"**;
  - a list of the removed codes (from the audit), so a stray printed label can be recognised.

  **[OPEN Q2]** Is this wanted, or only a count?
- **Reports.** The stock list and every report show only the pieces that exist, so gaps are invisible there.
- **The removal warning.** Removing a line whose label was printed needs a confirmation in Arabic. The server refuses
  the removal without `confirmLabelPrinted: true`, with 409 `OPENING_LINE_LABEL_PRINTED` (a new error code), so the
  warning cannot be skipped by an old screen:

  > «طُبع ملصق هذه القطعة (الرمز J-1234). إذا حذفت السطر فلن يُستعمل هذا الرمز مرة أخرى. انزع الملصق عن القطعة وأتلفه.»
  > *"This piece's label was printed (code J-1234). If you remove the line, this code is never used again. Take the
  > label off the piece and destroy it."*

  Who may remove a printed line is **[OPEN Q1]**.
- **`line_no`.** It still follows `max + 1`. It is the line's place on the screen, not its code, and it does not need
  to change.

### 3.3 Concurrency

- **Add line.** `lockDraft` (opening FOR UPDATE), then `nextItemCode` (counter row lock), then insert. Two people adding
  to the same opening are serialized by the opening lock. Two openings, or an opening and a purchase, are serialized by
  the counter lock. All locks are taken in the same order everywhere (opening, then counter), as the seal does today.
- **Generator.** `core/numbering.ts` is used **unchanged**: `nextItemCode` and `nextItemCodes` already exist.
- **Tests on PostgreSQL** (§7):
  - two users adding lines at once;
  - an import at the same time as a purchase.

  The codes must be distinct, every one must parse back to its barcode, and none may be lost.

## 4. Printing before the seal

- **On each draft line** (the opening's lines table, for people with `opening.enter` while the opening is DRAFT):
  - the reserved code;
  - a printed mark: «لم يُطبع» (not printed), or «طُبع ×n» (printed n times) with the last date;
  - a button «طباعة الملصق».

  One line prints 1–20 copies (LBL-1 limit).
- **Multi-select (phase 2):** tick lines → «طباعة الملصقات (n)», 1–5 copies each (LBL-1 batch limit). At most 2000
  lines at once (`LABEL_MAX_DOCUMENT_PIECES`).
- **«طباعة كل ما لم يُطبع» (print every line not yet printed), phase 2, [OPEN Q3]:** one label of each draft line with
  no print yet, in `line_no` order. The button shows the count first.
- **Same label as LBL-1:**
  - the same size settings (`print.labelWidthMm`, `labelHeightMm` and `labelMarginMm`; not set gives 409
    `LABEL_SIZE_NOT_SET`, too small gives 409 `LABEL_TOO_SMALL`);
  - the same Code128 of the reserved 12-digit barcode;
  - the same print module, format `LABEL` (`frontend/src/print/labels.tsx`);
  - the same one-label-per-page rule.

  Nothing about the label itself changes.
- **After the seal:**
  - the draft buttons disappear;
  - LBL-1's «طباعة ملصقات هذه القطع» and the piece page work unchanged;
  - the first print after the seal of a piece already printed as a draft is a REPRINT (§5).

## 5. The print record

`label_prints.item_id` cannot point at a piece that does not exist yet. Making it nullable would loosen an LBL-1
guarantee, and updating it at the seal would break append-only. So:

- **A new append-only table, `opening_label_prints`:**
  - `id`;
  - `opening_id` (FK);
  - `opening_line_id` (no FK, so a printed line can still be removed: the record outlives it);
  - `code` and `barcode` (the reserved values, copied);
  - `branch_id`, `copies`, `kind` (FIRST/REPRINT), `batch_id`, `printed_by`, `session_id`, `idempotency_key`,
    `created_at`.
- **Its trigger, mirroring `jerp_label_print_check`:**
  - the line exists in that opening;
  - the opening is DRAFT and of that branch;
  - the line's reserved code equals `code`;
  - FIRST if and only if this code has no earlier draft print;
  - a unique partial index gives one FIRST per code;
  - append-only and no-truncate triggers, and `jerp_lock_append_only`.
- **At the seal**, in the seal's transaction, for every piece:
  - one `label_prints` row is inserted per draft print of its code, in `id` order;
  - the row keeps the same `kind`, `copies`, `printed_by`, `session_id`, `batch_id` and `created_at`, with
    `source = 'OPENING'`;
  - a new nullable column `label_prints.draft_print_id` (unique, FK to `opening_label_prints`) links it to the
    original.

  Because they are copied in order, the LBL-1 trigger accepts them unchanged: the first is FIRST, the others REPRINT.
  The piece is in the opening's branch at the seal, so the branch rule holds.
- **Results:**
  - the piece page history («الملصقات المطبوعة») shows the draft prints with their real dates and people, with no
    change to its query;
  - the report «طباعة الملصقات» lists them once;
  - the report reads `label_prints` after the seal, plus `opening_label_prints` rows with no copy, marked
    «قبل الختم» (before the seal), so a removed line's prints stay visible.
- **What is kept from LBL-1:**
  - the trigger rules;
  - one FIRST per piece;
  - branch scope (a branch manager prints only the own branch's draft: 404 otherwise);
  - an Idempotency-Key on the route;
  - the audit (`LABELS_PRINTED` with `source: 'OPENING_DRAFT'` in metadata, and each line's code, copies and kind);
  - append-only.

  The `ck_label_prints_source` CHECK is **not** changed.

## 6. Seal and corrections

- **What the seal checks** (new, in the seal's transaction, after `lockDraft`):
  1. every line has a reserved code and barcode (else 409 `OPENING_CODES_MISSING`; it cannot happen after the backfill,
     but is checked);
  2. no reserved code is already used by a `jewelry_items` row (else 409 `OPENING_CODE_TAKEN`; the counter makes it
     impossible, the unique index enforces it);
  3. the existing `expectedLines` and `expectedNetWeightMg` checks;
  4. labels printed vs not: **not a refusal**. The pre-seal summary shows «طُبعت ملصقات n من m قطعة» (labels printed
     for n of m pieces). **[OPEN Q5]** Should the seal be refused while lines are unprinted? The recommendation is no.
- **An edited line does not need a new label: confirmed.**
  - The label carries only the barcode, and the barcode depends only on the reserved number.
  - There is no edit route today. If one is added later (not in this item), it must keep `reserved_code` and
    `reserved_barcode` unchanged. The trigger will refuse an UPDATE that changes them.
- **A line removed after printing:** the warning and confirmation (§3.2), the audit, and the gap shown at the seal.
  Its draft print rows remain, with no piece. Retyping the same piece gives a **new** code, and its new label must be
  printed.
- **After the seal:**
  - LBL-1 buttons work unchanged;
  - corrections (`opening.correct`) keep the piece's code;
  - the scan at the POS finds the piece by the barcode printed before the seal.

## 7. Permissions, routes, migration

**Permissions:**

- `opening.enter` is reused: a branch manager for the own branch, and the General Manager.
- A cashier never prints (403).
- A branch manager asking about another branch's opening gets 404.
- **No new permission is needed.** If the owner wants "only the General Manager may remove a printed line" (Q1), that
  is the existing `opening.manage`, checked in the remove route only for printed lines.

**Routes (route matrix and REH-1 in the same commit):**

| Route | Scope | Permission | Notes |
|---|---|---|---|
| `POST /openings/:id/labels` (new) | branch | `opening.enter` | `{ lineIds: number[], copies }` or `{ unprinted: true, copies: 1 }` (phase 2); idempotent in the transaction; DRAFT only (409 `OPENING_NOT_DRAFT`) |
| `GET /openings/:id` (changed) | branch | `opening.enter` | each line gains `code`, `barcode`, `labelPrints` (count) and `lastPrintedAt`; the summary gains `printedCount`, `removedCodes` |
| `POST /openings/:id/lines/:lineId/remove` (changed) | branch | `opening.enter` | `confirmLabelPrinted`; 409 `OPENING_LINE_LABEL_PRINTED` |
| `POST /openings/:id/seal` (changed) | global | `opening.manage` | uses the reserved codes, copies the prints; response gains `lastCode` |
| `GET /openings/:id/export` (changed) | branch | `opening.enter` | the draft export gains the code column (the sealed export already has it) |

- The new response fields are classified SAFE (`shared/src/field-classification.ts`).
- New error codes go in `decisions.md`.
- No new setting.

**Migrations** (additive first; 42 today, 0000–0041):

1. **0042, additive:**
   - `opening_lines.reserved_code` and `reserved_barcode` (nullable, unique indexes);
   - the table `opening_label_prints` with its trigger and append-only locks;
   - `label_prints.draft_print_id` (nullable, unique, FK);
   - `jerp_opening_line_check` extended to refuse an UPDATE that changes a reserved code.
2. **0043, the backfill for DRAFT openings that exist today:**
   - in one statement per opening, ordered by `opening_id, line_no`, it reserves a block from `document_sequences`
     `ITEM` (the same upsert as `nextItemCodes`);
   - it writes the codes onto the draft lines that have none;
   - sealed openings' lines are untouched (they already have `item_id`, and the trigger forbids writing them);
   - it is idempotent: lines with a code are skipped.

   **[OPEN Q6]** Backfill at the update (recommended), or only when a line is first printed?
3. **0044, tightening:** `CHECK (item_id IS NOT NULL OR reserved_code IS NOT NULL)` on `opening_lines`, added
   `NOT VALID`, then `VALIDATE`. Every line of a draft then has a code, and sealed lines keep `item_id`.

- No DROP, TRUNCATE or DELETE. Each migration runs against a database with data. `checksums.json` is updated.

**REH-1:** about +10 checks (423 today):

- add a line, which shows its code;
- print it (FIRST);
- reprint it (REPRINT);
- removing a printed line is refused without confirmation, then confirmed;
- an import reserves a block;
- seal;
- the piece page shows the draft prints;
- the scan finds the piece;
- a cashier gets 403;
- another branch gets 404.

## 8. Tests to plan

**Unit and property tests:**

- the reserved barcode always equals `628100` + n padded, for any n from the counter, including n past 999,999
  (13 digits; the label size rule still applies);
- an import of k rows reserves exactly k consecutive numbers in file order;
- a refused import reserves none;
- FIRST/REPRINT across draft and sealed prints;
- copies limits (1–20 for one line, 1–5 in a batch);
- the remove guard;
- the seal uses exactly the reserved codes, copies every draft print in order, and the piece history equals the draft
  history;
- a removed line's prints stay in the report;
- scope (cashier 403, other branch 404);
- an Idempotency-Key retry prints once;
- append-only.

**Stale-test update (not a loosening):** `opn1-openings` "sealed: codes in the sheet order" becomes "codes as reserved
at entry". It asserts that each piece's code equals its line's `reserved_code`, and that the codes increase with entry
order.

**PostgreSQL races** (`backend/test/pg/`):

- two users adding lines to the same opening, and to two openings, at once: distinct codes, none lost;
- a print racing a delete of the same line: either the print is recorded and the delete then needs the confirmation, or
  the delete wins and the print gets 404, never a print of a removed line;
- the seal racing a print: either the print lands before the seal and is copied, or it gets 409 `OPENING_NOT_DRAFT`,
  never a draft print left uncopied;
- an import racing a purchase: blocks never overlap.

**Migration upgrade test:** start from 0041 with a DRAFT opening of 5 lines (one removed, so `line_no` has a gap) and a
sealed opening. Upgrading:

- gives the draft lines consecutive codes in `line_no` order after the counter's current value;
- leaves the sealed lines untouched;
- moves the counter past them;
- passes the 0044 validation;
- makes a later purchase take the next number.

**e2e** (extend `scripts/e2e-labels.mjs`, or a new `e2e-opening-labels.mjs`):

- add a line, print it, and check the label's value;
- seal, then scan that value at the POS: exactly that piece is added;
- deleting a printed line shows the Arabic warning, and cancelling keeps the line;
- a CSV import shows the reserved codes on every row.

**Other gates:**

- REH-1;
- `e2e-numbers`: the copies field in the new dialog, if it is not the existing LBL-1 component;
- `e2e-states`, `e2e-openings`;
- `i18n:check` (new Arabic strings);
- tablet width and RTL screenshots of the lines table with the new columns.

## 9. Acceptance outline (for `docs/acceptance/LBL-2.md`)

- **«الرمز عند الإضافة»** (the code on entry): add a line, and its code appears at once.
- **«طباعة الملصق»** (print the label): one copy, the label scans as its barcode, and the line shows «طُبع ×1».
- **«إعادة الطباعة»** (reprint): the line shows ×2, recorded.
- **Remove a printed line:** the warning, then the confirmation. The code is not used again, and the seal summary shows
  the gap.
- **Import a CSV:** every row has its code, in file order.
- **Seal:** every piece has the code printed on its label. The piece page shows the prints made before the seal, and
  the POS scan finds it.
- **«الكاشير»** (the cashier): no button.
- **Another branch:** not visible.

**Decisions to record:**

- **D-lbl2-1:** codes at entry, in entry order (supersedes D-opn1-1's "sheet order").
- **D-lbl2-2:** removed numbers are never reused, and the gaps are shown at the seal.
- **D-lbl2-3:** draft prints live in `opening_label_prints` and are copied into `label_prints` at the seal.
- **D-lbl2-4:** who may remove a printed line (Q1).
- **D-lbl2-5:** whether the seal requires every label printed (Q5).

## 10. Phases and sizes

- **Phase 1, medium–large (about 7–9 commits):**
  - migrations 0042–0044;
  - reservation at add and import;
  - the seal uses the reserved codes and copies the prints;
  - the per-line print button;
  - the remove guard and warning;
  - the seal summary;
  - tests (unit, PostgreSQL races, upgrade, e2e);
  - REH-1, the docs and the acceptance.
- **Phase 2, small–medium (about 3 commits):**
  - multi-select;
  - «طباعة كل ما لم يُطبع»;
  - their tests and REH-1.

## 11. Risks

- **The change to D-opn1-1.** Openings no longer get one consecutive block of codes. Anyone who expected «J-1001 to
  J-1500 is the opening» must use the opening's own export instead.
- **A printed label of a removed line** stays on a piece if nobody takes it off. Its code never exists, so a scan says
  «لا توجد قطعة بهذا الرمز» and nothing wrong is sold. It is still confusing at the counter, hence the warning and the
  list of removed codes.
- **A retyped piece.** Someone may stick the old label on a piece that was retyped with a new code. The removal warning
  says to destroy the label.
- **Counter contention.** Each line takes the counter lock briefly, so a purchase saved during a large import waits for
  the import (seconds).
- **The backfill moves the counter.** The update changes the next purchase's first code; this is expected.
- **13-digit barcodes past 999,999.** These are already possible today; the label size rule handles them.

## 12. Not in this item

- Any code, migration or deployment before approval.
- QR codes; price, weight or karat on the label.
- The scale (SCL-1), returns (RET-1), silent printing (HW-1).
- An edit route for draft lines.
- Scrap (weight) lines of the opening: they are not pieces and get no code.

## 13. OPEN questions for the owner (to forward as-is) — أسئلة للمالك

1. **May a line whose label was already printed be removed, and by whom?**
   (a) the branch manager and the General Manager, after the warning; (b) only the General Manager; (c) nobody, once
   printed.
   *هل يجوز حذف سطر طُبع ملصقه؟ ومن يحذفه: مدير الفرع والمدير العام بعد التحذير، أم المدير العام فقط، أم لا أحد؟*
2. **Should the seal summary show the numbering gaps (the removed codes)?**
   (a) the list of removed codes; (b) only how many; (c) nothing.
   *هل يعرض ملخص الختم الأرقام غير المستعملة (رموز الأسطر المحذوفة): قائمة بها، أم عددها فقط، أم لا شيء؟*
3. **Is the button "print all labels not yet printed" wanted?**
   *هل تريدون زر «طباعة كل ما لم يُطبع»؟*
4. **May a branch manager reprint a line's label without approval?** Every reprint is always recorded and marked, as in
   LBL-1.
   *هل يجوز لمدير الفرع إعادة طباعة ملصق سطر دون موافقة؟ (كل إعادة طباعة تُسجَّل دائماً.)*
5. **Should the seal be refused while some lines have no printed label?** The recommendation is no: only show «طُبعت
   ملصقات n من m».
   *هل يُمنع الختم إذا بقيت أسطر لم تُطبع ملصقاتها؟ (نوصي بعدم المنع والاكتفاء بالعرض.)*
6. **The draft openings that exist today:** give their lines their codes at the update (recommended), or only when a
   line is first printed?
   *الأرصدة الافتتاحية غير المختومة الموجودة الآن: هل تأخذ أسطرها رموزها عند التحديث أم عند أول طباعة؟*
7. **Codes in entry order:** you accept that one opening's codes are no longer one unbroken range (purchases entered
   meanwhile take numbers in between, and removed lines leave gaps).
   *هل توافقون أن رموز الرصيد الافتتاحي تتبع ترتيب الإدخال ولن تكون سلسلة متصلة؟*
