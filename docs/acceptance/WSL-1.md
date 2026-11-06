# Manual acceptance: WSL-1 (grains «حبات» of broken scrap sold at the POS)

For the owner, about 15 minutes, on the live server after the update, in a desktop browser, with two windows: a
cashier (or the branch manager) of one branch, and the branch manager of that branch for the cancellation. Engineering
ran section A.

What changed (your rules of 2026-11-06, plan `docs/plans/WSL-1.md`, decisions D-wsl1-1…5):

- The point of sale shows, above the pieces, **one product per karat** that has broken scrap in the branch's pool:
  «كسر مكسر 21 — متاح 1.250 جم», with the selling rate per gram of that karat.
- The cashier adds it and types **the number of grains** (a whole number; **1 grain = 0.1 g**). The line shows the
  grains, their grams, the rate per gram and the line's price: the karat's rate × the whole weight, rounded once
  (3 grains at 123,456 per gram = 0.300 g = 37,037). No markup, no making charge, no discount, no cost.
- **More than the pool holds** is said under the field («أكثر من المتاح…») and the sale cannot be completed.
- The sale takes the weight out of the pool **of the karat chosen**, in that branch. The pool never goes below zero,
  even when two cashiers sell the last grains at the same moment (one of the two is refused).
- **Cancelling the sale** (the branch manager or you, as for any sale) puts the grains back into the same karat's pool.
- Supplier settlements can only use what is left in the pool after grain sales.
- The receipt and the printed invoice show the grain line: «كسر مكسر 21 — 3 حبة = 0.300 جم».
- Nothing else about broken scrap changes: buying it from customers, settling suppliers, the opening balance.
- Everyone who sells at the POS can sell grains (cashier, branch manager, you). No new permission.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| Migration | 0040 (41 migrations, 0000–0040): the new table `sale_scrap_lines` and the pool movement `SCRAP_SALE`; `wsl1-migrations` (an upgrade from 0039 with broken scrap in the pool changes nothing; the checks; a line must leave the pool exactly once) |
| New tests | `wsl1-grains` (both databases: the owner's example, the refusals, several karats, the void, an Idempotency-Key retry deducts once, a supplier settlement on the remaining pool, profit, the POS list, property tests of the unit, the rounding and the pool's conservation); `pg/scrap-grains-race` (the last grains sold twice at once: exactly one; a sale against a settlement; a void against a sale) |
| REH-1 | 409 checks (was 398): the grain sale through the API (the offer, a price not shown, the sale, one grain too many, the void) and the screens (the POS product, more than available blocked, a sale from the POS, its void) |
| Browser scripts | `e2e-grains` (new): the product, the focus, more than available blocked, 3 grains = 0.300 g = 57,000, the sale, the receipt and the printed line, the pool, the void; `e2e-numbers`: the grains field in the POS sweep; `e2e-states`, `e2e-print` |

### Every place that reads the broken-scrap pool or a sale's lines (requirement 5)

| Place | How it handles grain sales |
|---|---|
| Pool balance (`poolBalances`): Scrap page pool, branch stock weight, Stock Weight report, GM and branch homes | Sums every movement, SCRAP_SALE and REVERSAL included: the pool shows what is left |
| Supplier settlement (`settleWithScrap`) | Reads the balance under the same pool lock: only what grain sales left (tested) |
| Scrap purchase void (`voidScrapPurchase`), opening scrap correction (OPN-3) | Read the balance under the pool lock: they see the grains sold |
| Backup statistics (`backup/stats.ts`) | Sums the pool per branch and karat: unchanged |
| Sale page (`GET /sales/:id`), receipt on screen, printed receipt and A4/A5 invoice (`POST /sales/:id/print`) | Show the grain line (grains = grams, rate, price) |
| Sales list and report footers, Sales report | The total includes grains; the gross profit leaves grain revenue out (no cost); "lines of unknown cost" counts them |
| Branch metrics (GM dashboard, branch performance, profit by branch) | Grain revenue left out of the profit; counted as lines of unknown cost |
| Profit report by type, karat, cashier or day | Grain lines are lines of their karat under the type «كسر مكسر», unknown cost, so each group still adds up |
| Branch home trend (profit per day) | Per-sale profit of the known lines: grains never add profit |
| Cash reconciliation and the ledger | The sale's money is the sale's payment lines, as for any sale: unchanged |
| Items sold and weight sold (dashboards, sale lists) | Count pieces only (unchanged); grain weight is on the grain lines and in the pool |

## B. Checklist (the live server) — قائمة الفحص

Prepare: the branch's 21K broken-scrap pool holds some weight (buy a little broken scrap from a customer first, e.g.
1.250 جم, if it holds none), and today's 21K selling rate is set.

1. [ ] **الصنف في نقطة البيع.** Sign in as a cashier of the branch → «نقطة البيع». Above the pieces there is
   «كسر مكسر 21 — متاح …» with the 21K rate per gram. A karat without a selling rate shows «لا يوجد سعر» and cannot be added.
2. [ ] **عدد الحبات.** Click it: the cart shows the line and the cursor is in «الحبات». Type more grains than
   available (for 1.250 جم: 13): the line says «أكثر من المتاح…» and «إتمام البيع» stays disabled.
3. [ ] **السعر.** Change it to 3: the line shows «3 حبة = 0.300 جم», the rate per gram, and the price = the rate ×
   0.3, rounded once (no markup).
4. [ ] **البيع والفاتورة.** Complete the sale (cash). The receipt shows the grain line with its grains and grams. Print
   it: the printed receipt shows the same line.
5. [ ] **المخزون.** «ذهب الكسر» (the scrap pool) of the branch: 21K is 0.300 g lower.
6. [ ] **الإلغاء.** As the branch manager: «المبيعات» → the sale → cancel it (with the reason and the password). The
   pool's 21K is back where it was. A cashier cannot cancel a sale (as before).
7. [ ] **التسوية.** (optional) A supplier settlement with 21K broken scrap can only use what is left in the pool.
8. [ ] **قطعة وحبات معاً.** One sale with a piece and grains: the total is both; on the sale page (as you), the profit
   is the piece's only.

## C. After the update (the server)

The normal `docs/runbooks/update-deploy.md`; nothing is run by hand:

1. the pre-update backup (`systemctl stop jerp`, `jerp_backup npm run backup`, `backup:verify` on the drill machine);
2. pull and build (`git fetch --tags && git checkout <tag>`, `npm ci --include=dev`, `npm run build`);
3. migrate: `jerp npm run migrate` (migration 0040);
4. preflight: `jerp node scripts/server/preflight.mjs` shows `migrations: 41 of 41 applied` and every line PASS;
5. start again: `systemctl start jerp`, and wait for `{"ready":true}` on `/api/ready`.

## D. Not built (your scope)

Barcode labels (LBL-1), product photos (PHO-1), mixed-karat pool logic, cost tracking for grains, a dedicated grain
rate.
