# LBL-1: print barcode labels for pieces

Status: **plan, waiting for the owner's approval.** No code is written before it.

**Owner's decisions (2026-11-11), taken as given:**
- Code128 only (the SuperLead 1600 is a 1D scanner); no QR.
- The label carries the piece's code only: no price, weight, karat or shop name.
- The label size is a General-Manager setting, with no default in code; printing is refused until it is set.
- The printer is an Xprinter XP-246B (203 DPI, 48 mm maximum print width), printed from the browser; HW-1 does the
  rest.
- Read-only: no code is ever generated or changed here.

## 1. What exists today (survey)

- **Every piece has two identifiers, both unique and NOT NULL** (`jewelry_items.code` and `.barcode`), made by
  `core/numbering.ts` when the piece is created:
  - purchase receipt, sellable scrap and opening seal → `code` = `J-<n>`, `barcode` = `628100` + `n` padded to 6
    digits (`628100000123`);
  - no other path writes them, and no import keeps an old value: the old shop number goes into the description.
- **What the POS scan matches** (`PosPage.tsx` `onSearchKey`): on Enter, a loaded row whose `barcode` equals the typed
  text, or whose `code` equals it (case-insensitive); else the only row, if exactly one is loaded. The server search
  (`inventory/service.ts`) is a substring `ilike` on code, barcode, description, type and product. **Both values are
  found exactly.**
- **Code128 in the app:** `jsbarcode` (^3.12.3, already a dependency) renders the invoice's barcode in
  `frontend/src/print/documents.tsx` (`Barcode`, `format: 'CODE128'`, auto code set). **No new dependency.**
- **Measured with jsbarcode's own encoder** (bars only, without the quiet zones):

  | Value | Modules |
  |---|---|
  | `628100000123` (12 digits, code set C) | 101 |
  | `6281000001234` (13 digits, after piece 999,999) | 123 |
  | `J-123` | 90 |
  | `J-12345` | 101 |
  | `J-123456` | 101 |

- **Where the pieces are seen:**
  - the piece page `GET /inventory/items/:id` and the stock list `GET /inventory/items`: `inventory.view` (branch
    manager, General Manager) or `inventory.view_available` (cashier: available pieces only); both return `barcode`;
  - the supplier order `GET /purchases/:id` (`purchases.view`): its lines carry `code` but **not** `barcode` today;
  - the sealed opening `GET /openings/:id`: its lines carry both.
- **Settings:** the registry (`shared/src/settings.ts`) already holds `print.*` keys (`print.receiptWidthMm` int 48–80);
  a nullable key exists (`branding.logoAssetId`). Every setting is General Manager only, versioned and audited
  (`settings_history`).

### A finding to decide before labels are useful (F1, question Q1)

The POS resolves the scanned code against the rows **already loaded** for the previous (debounced, 200 ms) search, not
against the code just typed. A scanner types 12 digits and Enter in about 50 ms, so:
- the scan usually finds nothing (the rows are still those of the previous search; the cashier presses Enter again);
- worse, if the previous search had **exactly one row**, Enter adds **that** piece, not the scanned one.

A label is only as good as this lookup. Proposed fix, inside LBL-1 if the owner agrees:
- on Enter, look the typed text up exactly (barcode or code, own branch) with one request, and add the match;
- if nothing matches, say «لا توجد قطعة بهذا الرمز»;
- never use "the only row" of another search.

It changes the POS, so it is asked (Q1), not assumed.

## 2. Design

### 2.1 What is printed (question Q2)

- **Encoded:** `jewelry_items.barcode` (proposed), not `code`. Reasons:
  - **Keyboard layout.** A USB scanner types like a keyboard. On a Windows Arabic layout the letter `J` and the `-`
    of `J-123` can come out as other characters; digits do not.
  - **Width.** The barcode is a fixed 12 digits (101 modules) for the first 999,999 pieces, so one label size always
    fits. A J-code grows with the number.
  - **It is already the barcode,** and the invoice shows it.

  `code` would also be found exactly at the POS; it is the alternative.
- **Human-readable line** under the bars: the encoded value (`628100000123`), as Code128 labels normally show it, in
  Latin digits.
  - **A default the owner can veto (Q3):** no text, or the J-code instead (staff know pieces by their J-code), or
    Arabic-Indic digits (Q4).
  - The text is never what is scanned.
- **Nothing else** on the label.

### 2.2 Rendering and the size rule (scannable at 203 DPI)

- 1 dot = 25.4 / 203 = 0.125 mm.
- The narrowest bar (one module) is a whole number of dots, **at least 2 dots (0.25 mm)**. One-dot bars blur on a
  thermal head and many 1D scanners cannot read them, so they are refused.
- The quiet zone is 10 modules on each side (Code128 needs at least 10 × the module).
- **Width rule:**
  - printable width = label width − 2 × margin;
  - module = ⌊printable dots ÷ (modules + 20)⌋ dots, at least 2;
  - for a 12-digit barcode the label's printable width must be at least 121 × 2 dots = 242 dots = **30.3 mm**
    (3 dots per module from 45.4 mm);
  - computed per value with jsbarcode's encoder, not assumed.
- **Height rule:** bars at least 5 mm, plus the text line when shown (2.5 mm text at ≥ 8 pt, 0.5 mm gap) → printable
  height at least 5 mm without text, **8 mm with it**.
- **A size that cannot give a scannable code is refused with the reason,** e.g. «عرض الملصق 25 مم لا يكفي: أقل عرض
  لهذا الرمز 31 مم». This holds both when the setting is saved and when a label is printed: a later 13-digit code
  needs 36.5 mm with 2-dot bars.
- **The constants are documented in one place** (`shared/src/labels.ts`, pure and property-tested):
  - the minimum module (2 dots);
  - the DPI (203);
  - the quiet zone (10 modules);
  - the minimum bar height (5 mm);
  - **the maximum label width, 48 mm, as the printer-class maximum:** a constant named for the printer class, not a
    client value.
- The bars are drawn as an SVG with whole-dot widths in mm (module × 0.125 mm), so the browser does not resample them.
  Black on white, no anti-aliasing (`shape-rendering: crispEdges`).

### 2.3 The setting (General Manager, Settings › Printing)

- **Keys:**
  - `print.labelWidthMm` and `print.labelHeightMm`: nullable, **null by default (not set)**;
  - `print.labelMarginMm`: default 1 mm, a generic print margin, not a client value (Q5).
  - Whole millimetres (Q6: or 0.5 mm steps).
  - Width up to the 48 mm constant; height 5–60 mm.
- **Validation:**
  - the registry's zod schema (ranges);
  - the scannability rule above on save (409 `LABEL_TOO_SMALL` with the minimum, in Arabic);
  - the same rule again at print time.
- **Who and the audit:** General Manager only, versioned and audited like every setting.
- **Screen:**
  - three number fields (the FIX-NUM-1 kit; added to the `e2e-numbers` sweep);
  - a live line under them: «أقل عرض للرمز الحالي: 31 مم» and the bar width in dots;
  - **"Print a sample label"** (§2.5).
- **Docs:** `DEPLOYMENT.md` lists the keys.
- **REH-1:** the label setting is not set on a new database, and printing says so; the General Manager sets it; a
  too-small size is refused.

### 2.4 Where printing is offered (the minimal useful set)

| Place | What | Why |
|---|---|---|
| **(a) The piece page** (`/inventory/:id`) | "Print label", copies 1–20 | A lost or damaged label is replaced where the piece is looked up |
| **(c) The stock list** (`/inventory`) | Tick pieces → "Print labels" (one label each, copies per piece 1–5) | Covers (b) without new screens: filter the list by the new order's pieces (origin, date) or by the opening, tick all, print. It also reprints any selection |
| **(b) After a receipt or the opening seal** | One button "Print labels of these pieces" on the supplier order page and the sealed opening page | The day's real job (dozens of new pieces at once). It needs `barcode` on the order's lines (a new SAFE field in `GET /purchases/:id`); the opening lines already have it |

- **Proposed:** (a) + (c) in this item, and (b) as two buttons that open the same print page with the document's
  pieces (Q7: keep (b) or leave it for later).
- **Only pieces that exist are printed, whatever their status:**
  - sold or voided pieces too (a reprint for the records);
  - the label never shows the status; the POS refuses to sell a sold piece as before.
- Scrap and used pieces have codes like any piece and print the same.
- Broken scrap and grains (WSL-1) are no pieces: nothing to print.

### 2.5 Printing mechanics

- **A print page `/labels/print`.** It takes:
  - the piece ids (or `sample=1`);
  - the copies;
  - the size from the setting.
- **The page itself:**
  - one label per page;
  - `@page { size: <W>mm <H>mm; margin: 0 }`, with the label's own margin inside;
  - a content box of exactly W × H mm;
  - `page-break-after: always`;
  - no header or footer, no scaling.
- **What the user does:** in the browser dialog, "Margins: none", "Scale: 100", "Headers and footers: off"; the
  acceptance doc says it.
- **What the page does:**
  - it fetches the pieces through the existing routes (`GET /inventory/items/:id`, or the list with ids) and prints;
  - it never writes anything: no audit row, no route, no migration;
  - Q8: or should a label print be audited, as an invoice reprint is.
- **"Print a sample label"** in Settings prints a fixed sample value: a 12-digit `000000000000`-style code that no
  piece has, marked «تجربة». It lets the owner calibrate:
  - the driver's label size;
  - darkness;
  - the gap sensor.
- **Left to HW-1:**
  - silent printing (no dialog);
  - the Windows driver's page and gap settings;
  - the darkness and speed;
  - the real-printer and real-scanner test;
  - any ZPL/TSPL direct printing.

### 2.6 Permissions and scope

- **No new permission and no new route.** A label shows only `barcode`, which the person can already read:
  - `inventory.view` (branch manager, General Manager);
  - `inventory.view_available` (cashier: available pieces).
- **Scope** is the existing branch scope of those routes. A branch-bound user prints only the own branch's pieces;
  another branch's piece answers 404/403 as today.
- (b)'s buttons follow their pages: `purchases.view` and `opening.enter`.
- The sample label needs `settings.manage`.
- **Q9:** may a cashier print labels at all, or only managers? Today a cashier can open an available piece, so the
  proposal shows the button to whoever can open the piece.

## 3. Tests

- **Unit and property** (`shared/src/labels.ts`):
  - the module count and the minimum width for 12- and 13-digit codes and J-codes (against jsbarcode's encoding);
  - module = ⌊…⌋ ≥ 2 dots;
  - a size below the minimum is refused with the minimum;
  - bar widths are whole dots;
  - fast-check over sizes and values.
- **Backend:**
  - the settings: nullable, ranges, the General-Manager-only refusal, the audit row, 409 `LABEL_TOO_SMALL`;
  - the new `barcode` field on order lines (SAFE classification, cost-visibility);
  - branch scope (another branch's piece is not printable).
- **e2e** (`scripts/e2e-labels.mjs`, in `verify --full` and the CI smoke job):
  - before the setting: «حدد مقاس الملصق في الإعدادات»;
  - the General Manager sets 40 × 12 mm, and 25 × 12 is refused;
  - the label page has `@page` 40 mm × 12 mm and one page per label × copies;
  - the SVG's `data-barcode` equals the piece's barcode, and the encoded bars decode to it (via jsbarcode's encoding);
  - **"scanning":** that value typed into the POS search with Enter (as the scanner types) adds exactly that piece;
  - the stock list's ticked pieces print one label each;
  - another branch's piece cannot be printed.
- **The sweeps:**
  - `e2e-numbers` (the label fields);
  - `e2e-states` (the print page's empty, error and too-small states);
  - RTL and a tablet width (the stock list's selection and the dialog at 768 px).
- **REH-1:** the setting (not set → refused; set; too small → refused); a piece's label page and its barcode; the
  scan into the POS.
- **i18n:** every new text in Arabic (UX-2, short).

## 4. Docs

- `docs/acceptance/LBL-1.md`: the manual checklist on the real printer, in short Arabic-friendly steps.
  1. Set the size.
  2. Print a sample label: check that the driver's paper size equals it, then darkness and gap.
  3. Print a real piece's label.
  4. Scan it with the SuperLead 1600 in the POS search: the piece is added once.
  5. Scan a second label right after: the right piece again (F1).
  6. Set the Windows keyboard to Arabic and scan: still found (the digits-only value).
- Also: decisions D-lbl1-*, `DEPLOYMENT.md` (the settings, the error code), BACKLOG, FEATURES.

## 5. Commits (after approval)

| # | Commit |
|---|---|
| c0 | this plan |
| c1 | `shared/src/labels.ts` (the size rule, property tests); the three settings (registry, Settings › Printing, validation, `LABEL_TOO_SMALL`), DEPLOYMENT; REH-1 |
| c2 | (if Q1) the POS exact lookup on Enter; its test; REH-1 |
| c3 | the label print page and "Print label" on the piece page; the sample label; e2e-labels; REH-1 |
| c4 | the stock list's selection and (if Q7) the order and opening buttons with `barcode` on order lines; tests; REH-1 |
| c5 | acceptance, decisions, BACKLOG, `verify --full` |

## 6. Risks

- **The browser path is the weak link.** The driver can scale or offset the page unless its paper size equals the
  label size. The sample label and the checklist catch it; silent and exact printing is HW-1.
- **2-dot bars are near the limit for a small label.** At 30–35 mm width, a cheap scanner may need 3-dot bars (45 mm).
  The real test (HW-1) decides; the rule can be raised by a constant without a migration.
- **Piece 1,000,000** makes 13-digit barcodes (123 modules, 36.5 mm minimum). A label size chosen for 12 digits then
  refuses those pieces with the reason; it is years away.
- **F1** (the POS lookup) can make labels look broken if it is not fixed.

## 7. Open questions for the owner

- **Q1.** May LBL-1 fix the POS scan lookup (F1: exact lookup on Enter, never "the only row" of another search)?
  Recommended: **yes**.
- **Q2.** Encode the 12-digit `barcode` (proposed) or the `J-` code?
- **Q3.** The human-readable line under the bars: show the encoded digits (proposed default), the J-code, or nothing?
- **Q4.** If text is shown: Latin digits (proposed, as encoded) or Arabic-Indic digits?
- **Q5.** A 1 mm margin inside the label by default (generic), or 0?
- **Q6.** The label size in whole millimetres (proposed) or 0.5 mm steps?
- **Q7.** The "print labels of these pieces" buttons on the supplier order and the sealed opening, now or later? (The
  stock list covers the same need with more taps.)
- **Q8.** Should printing labels be audited (who printed which pieces), as invoice reprints are? Proposed: **no** (read
  only).
- **Q9.** May a cashier print labels, or only managers?
- **Q10.** Copies: the proposed maxima are 20 per piece on the piece page and 5 per piece in a batch. Do they fit?
