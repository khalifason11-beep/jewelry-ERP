# Manual acceptance: LBL-1 (barcode labels of pieces)

For the owner, about 20 minutes, on the live server after the update, at the shop PC with the Xprinter XP-246B and the
SuperLead 1600 scanner, in Brave or Chrome. Engineering ran section A.

What changed (your decisions of 2026-11-11, plan `docs/plans/LBL-1.md`, decisions D-lbl1-1…5):

- **A label** «ملصق» carries one barcode (Code128) of the piece's **12-digit barcode**, e.g. `628100001001`, with the
  same digits under the bars in Latin digits. Nothing else: no price, weight, karat or shop name.
- **Who prints:** the branch manager (the own branch's pieces only) and you. A cashier cannot.
- **Where:**
  - the piece page, «طباعة الملصق», 1–20 copies;
  - the stock list: tick pieces, then «طباعة الملصقات (n)», 1–5 copies each;
  - the supplier order and the sealed opening, «طباعة ملصقات هذه القطع»: every piece of the document.
- **Every print is recorded:** who, when, which piece, how many, first label «أول ملصق» or reprint «إعادة طباعة». You
  see it on the piece page («الملصقات المطبوعة») and in Reports › «طباعة الملصقات», which you can export as CSV. A
  reprint needs no approval, but it is always recorded and marked.
- **The label size** is yours to set: Settings › «ملصقات القطع». It is empty at first, and printing says «حدد مقاس
  الملصق في الإعدادات أولاً» until you set it.
- **The scan at the POS (F1):** before, a scan right after another search could add the wrong piece. Now the scanned
  value is looked up exactly; an unknown code says «لا توجد قطعة بهذا الرمز» and adds nothing.

> **Before you buy or print a label roll: check the minimum size.** The scanner needs bars of at least two printer
> dots (0.25 mm at 203 DPI). A 12-digit barcode then needs about **30.3 mm** of printable width: **32.3 mm** with the
> default 1 mm margins. The height must be at least **10 mm** with the margins: 5 mm of bars and the digits line. A
> smaller label is refused with the minimum, on the screen and by the server. The printer's maximum width is 48 mm.
> Between 45.4 mm and 48 mm of printable width the bars become 3 dots wide (easier to scan).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| Migration | 0041 (42 migrations, 0000–0041): the append-only table `label_prints`; `lbl1-migrations` (an upgrade from 0040 with pieces changes nothing; the rules) |
| New tests | `lbl1-labels` (the size rule against jsbarcode's own encoder, property tests, the settings and their refusals); `lbl1-prints` (who and scope, size refusals, copies, first then reprint, the audit, an Idempotency-Key retry, the history, append-only, a whole order, a draft opening, the report); `pg/label-print-race` (two prints of a never-printed piece at once: one first, one reprint) |
| The POS scan (F1) | `e2e-labels`: 12 digits and Enter typed with no delay right after a search showing one other piece: the scanned piece is added (on the old POS it added the other one); two scans back to back; the same piece twice; an unknown code |
| Labels in the browser | `e2e-labels`: refused until the size is set; `@page { size: 40mm 12mm; margin: 0 }`; one label per page × copies; the bars are jsbarcode's own Code128 of the piece's barcode in 2-dot modules; the digits under them; first then reprint; the printed value scanned at the POS adds that piece; no button for a cashier; the sample label; the stock list, the supplier order, the report |
| REH-1 | 423 checks (was 409): the size (empty, too small refused, saved), the scan, prints and reprints, the history, the opening's labels, the report |
| Sweeps | `e2e-numbers` (the label sizes and the copies), `e2e-states`, `e2e-print`, `e2e-openings` |

## B. Checklist on the real printer and scanner — قائمة الفحص

1. [ ] **المقاس.** Measure the label on the roll (width × height in mm, the label itself, not the backing paper).
   Settings › «ملصقات القطع»: type the width and the height (0.5 mm steps) and save. A size that is too small says
   «الملصق أصغر من أن يُقرأ باركوده» with the minimum. The line under the fields gives the narrowest bar in printer
   dots.
2. [ ] **الطابعة.** In Windows, open the XP-246B driver's preferences:
   - the paper (label) size equals what you typed;
   - the gap or black-mark sensor is set for your roll;
   - a darkness in the middle.
3. [ ] **ملصق تجريبي.** Press «طباعة ملصق تجريبي». In the print window choose the XP-246B, margins «بلا» (None), scale
   100 %, and headers and footers off. One label comes out: the bars, and `000000000000` under them, all on one label,
   nothing cut off, no blank label after it. If it is shifted or scaled, correct the driver's paper size (not the
   setting) and print the sample again.
4. [ ] **قطعة حقيقية.** Open a piece of your branch → «طباعة الملصق» → copies 1 → print. Stick the label on a tag.
   «الملصقات المطبوعة» on the page shows your name, the time, 1 copy, «أول ملصق».
5. [ ] **المسح.** At the POS, click the search box once and scan the label with the SuperLead 1600: the piece is added
   to the cart, once.
6. [ ] **مسح متتالٍ.** Scan a second, different label right after the first: the second piece is added (not the first
   again).
7. [ ] **رمز غير معروف.** Scan the sample label (`000000000000`): «لا توجد قطعة بهذا الرمز», nothing added.
8. [ ] **لوحة مفاتيح عربية.** Switch Windows to the Arabic keyboard and scan again: the piece is still found (the label
   is digits only).
9. [ ] **إعادة الطباعة.** Print the same piece's label again: the history marks it «إعادة الطباعة». Reports › «طباعة
   الملصقات» lists both prints; «تصدير CSV» exports them.
10. [ ] **دفعة.** The stock list: tick 2–3 pieces → «طباعة الملصقات (3)» → one label each. A supplier order (or a sealed
    opening) → «طباعة ملصقات هذه القطع» → every piece's label.
11. [ ] **الكاشير.** Sign in as a cashier: no «طباعة الملصق» on a piece page, no «طباعة الملصقات» in the stock list.

Silent printing (no print window), the driver's fine tuning, and a long real-use test are HW-1.

## C. After the update (the server)

The normal `docs/runbooks/update-deploy.md`; nothing is run by hand:

1. the pre-update backup (`systemctl stop jerp`, `jerp_backup npm run backup`, `backup:verify` on the drill machine);
2. pull and build (`git fetch --tags && git checkout <tag>`, `npm ci --include=dev`, `npm run build`);
3. migrate: `jerp npm run migrate` (migration 0041);
4. preflight: `jerp node scripts/server/preflight.mjs` shows `migrations: 42 of 42 applied` and every line PASS;
5. start again: `systemctl start jerp`, and wait for `{"ready":true}` on `/api/ready`.

## D. Still open

- **The real label size:** your setting, once you have measured the roll (the minimum is above).
- **HW-1:** silent printing, the driver's settings, and the real printer and scanner test over time.
- Not in this item: QR, price, weight or karat on the label, the electronic scale (SCL-1), photos (PHO-1), any change to
  how codes are made.
