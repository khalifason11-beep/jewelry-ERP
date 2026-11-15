# Manual acceptance: LBL-2 (a piece's label printed before the opening is sealed)

For the owner, about 20 minutes, on the live server after the update, at the shop PC with the Xprinter XP-246B and the
SuperLead 1600 scanner, in Brave or Chrome. Engineering ran section A.

What changed (your approval and answers of 2026-11-15, plan `docs/plans/LBL-2.md`, decisions D-lbl2-1…5). Phase 1
only:

- **The code is given when the line is added** «الرمز عند الإضافة». A typed piece gets its code (`J-…`) and barcode at
  once. An imported file gets one block of codes in the file's order. The seal gives each piece exactly the code shown
  on its line. Codes follow the order of entry: pieces from a supplier order entered in the meantime take numbers in
  between, so one opening's codes are no longer one unbroken range (your answer Q7).
- **«طباعة الملصق» on each draft line**, 1–20 copies, the same label as LBL-1: the 12-digit barcode in Code128, the
  same digits under it, at your label size. Only the branch manager of the branch and you can print; a cashier cannot.
- **Every print is recorded**: who, when, which line, how many copies, first label or reprint. A reprint needs no
  approval (Q4). The line shows «لم يُطبع» or «طُبع ×n». At the seal, these prints move to the piece's page
  («الملصقات المطبوعة») with their real date and person.
- **Removing a printed line** asks first: «طُبع ملصق هذه القطعة (الرمز J-…). إذا حذفت السطر فلن يُستعمل هذا الرمز
  مرة أخرى. انزع الملصق عن القطعة وأتلفه.» The branch manager and you may remove it after this (Q1). The removal is
  recorded.
- **Numbers of removed lines are never used again.** The opening lists them under «رموز الأسطر المحذوفة», with who
  removed each, when, and whether its label was printed (Q2).
- **The seal is not refused for unprinted labels** (Q5). The checklist and the seal dialog show «طُبعت ملصقات n من m
  قطعة».
- **Draft openings that existed before the update** got their codes during the update, in line order (Q6).
- **Not in this phase (your decision):** ticking several lines to print them together, and «طباعة كل ما لم يُطبع».

## A. What engineering ran

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| Migrations | 0042 (codes on the lines; the append-only table of prints before the seal), 0043 (codes for the draft openings that exist at the update), 0044 (every draft line has a code). 45 migrations (0000–0044). `lbl2-migrations`: an upgrade from 0041 with a draft and a sealed opening; a block crossing 999,999 keeps every digit; a line without a code stops 0044 |
| New tests | `lbl2-codes` (codes on entry, the file's block, a refused file takes none, removal, the seal uses exactly them); `lbl2-prints` (who and scope, size, copies, first and reprint, the audit, Idempotency-Key, append-only, the removal confirmation, the removed codes, the seal's copy into the piece history, the report); `pg/opening-label-race` on PostgreSQL (several people and an import at once: codes distinct, none lost; a print racing the removal; the seal racing a print) |
| Changed test | `opn1-openings` "codes in the sheet order" → each piece has exactly its line's reserved code, rising in entry order (D-lbl2-1 replaces D-opn1-1's rule) |
| Browser | `e2e-openings`: the codes of the draft, a line's label (Code128 × 2), «طُبع ×1», the removal warning (cancel, confirm), the removed code listed, 1024 px RTL, the counts before the seal, and the label printed before the seal scanned at the POS adds exactly that piece; `e2e-numbers` (the copies field); `e2e-labels` |
| REH-1 | 436 checks (was 423): codes in entry order and kept by the seal; a draft line printed, reprinted, refused for branch A and above 20 copies; a printed line removed only with the confirmation and listed; the piece history after the seal; the report; the draft page on screen |

## B. Checklist — قائمة الفحص

1. [ ] **الرمز عند الإضافة.** Open a draft opening and type one piece. Its line shows a code `J-…` at once.
2. [ ] **ملف CSV.** Import a small file of 3 pieces. The 3 lines show consecutive codes, in the file's order.
3. [ ] **طباعة الملصق.** On a line, press «طباعة الملصق», copies 1, then print (XP-246B, margins «بلا», scale 100 %).
   One label comes out. The line now shows «طُبع ×1». Stick the label on the piece.
4. [ ] **إعادة الطباعة.** Print the same line again. The line shows «طُبع ×2». No approval is asked.
5. [ ] **حذف سطر مطبوع.** Type a test piece, print its label, then press the bin icon on its line. The warning above
   appears. «إلغاء» keeps the line; «احذف السطر» removes it. «رموز الأسطر المحذوفة» lists its code with «طُبع
   ملصقه». Destroy that test label.
6. [ ] **قبل الختم.** The checklist says «طُبعت ملصقات n من m قطعة». The seal dialog shows the same and the removed
   codes. Seal as usual (password and passkey).
7. [ ] **المسح بعد الختم.** At the POS, scan the label you stuck on the piece in step 3. That piece is added to the
   cart, once.
8. [ ] **سجل القطعة.** Open that piece's page. «الملصقات المطبوعة» shows the two prints from before the seal, with your
   name and their times. A new «طباعة الملصق» there is marked «إعادة الطباعة».
9. [ ] **التقرير.** Reports › «طباعة الملصقات» lists the prints. The removed test line's label is listed as «رصيد
   افتتاحي قبل الختم».
10. [ ] **الكاشير.** Sign in as a cashier: the opening balance is not in the menu, so there is nothing to print.

## C. After the update (the server)

The normal `docs/runbooks/update-deploy.md`; nothing is run by hand:

1. the pre-update backup (`systemctl stop jerp`, `jerp_backup npm run backup`, `backup:verify` on the drill machine);
2. pull and build (`git fetch --tags && git checkout <tag>`, `npm ci --include=dev`, `npm run build`);
3. migrate: `jerp npm run migrate` (migrations 0042, 0043, 0044). A draft opening's lines get their codes here, and
   the next supplier order's first code moves on by that many;
4. preflight: `jerp node scripts/server/preflight.mjs` shows `migrations: 45 of 45 applied` and every line PASS;
5. start again: `systemctl start jerp`, and wait for `{"ready":true}` on `/api/ready`.

## D. Still open

- **HW-1:** silent printing, the driver's settings, the real printer and scanner test over time.
- Phase 2 (multi-select printing, «طباعة كل ما لم يُطبع») only if you ask for it later.
