# Manual acceptance: PRC-1 (selling prices computed from the General Manager's rates)

For the owner, about 25 minutes. Engineering ran section A. Section B is a walk-through in a GitHub Codespace from the
Windows laptop's browser. Screenshots (1366×768, Arabic) are in `docs/acceptance/PRC-1/`.

What changed:

- **Three rates per gram for every allowed karat, set by the General Manager only** (new page **الأسعار / Prices**):
  - the **selling rate of new pieces** (from suppliers and opening stock);
  - the **selling rate of used pieces** (bought from customers and put on sale);
  - the **scrap buying rate** (unchanged, moved here from Settings).

  Every change is audited and kept for good in the rate history, with who and when. The karats are the allowed karats
  of Settings (9, 12 or 14 work too), not a fixed list.
- **Price = net weight × the current rate of the piece's karat and origin.** No making charge is added (Q-1 is still
  open). The rounding step (whole currency units, default 1) is applied once, after the multiplication; it is
  provisional until Q-2 is answered.
- **The price is live.** The inventory list, the item page, the POS grid, the stock value by selling price and the
  reports show today's price. Receiving stock (a supplier order, a sellable piece bought from a customer) no longer
  asks for a selling price.
- **A sale locks its price when it is confirmed.** The sale line keeps the rate used, the gold value, the list price
  and the final price after discount. Past sales never change. Profit = final price − cost, as before.
- **The POS never charges a price the cashier has not seen.** If a rate changes while a piece is in the cart,
  "Complete sale" refuses (409), the cart shows the new prices and says "Rates changed: the prices were updated.
  Check the cart and confirm again."; the cashier reviews and confirms again.
- **A karat without a rate cannot be sold** (never at 0): the POS card says "No rate", the inventory says "no rate",
  attention A16 and the first-steps "rates" step stay open until both selling rates are set.
- **The invoice and the sales list show the price per gram** the sale used.
- **The cashier may buy a sellable piece from a customer** (sidebar: "Buy a piece from a customer"). Every limit
  applies as before: the rate tolerance and the override that needs a higher role, the drawer block, the bank warning.
  The cashier sees no cost. Broken scrap and supplier orders stay with the branch manager and the General Manager.
- **Existing installations keep fixed prices** (`FIXED_TAG`) until the General Manager switches on the Prices page.
  New installations and the sample start with computed prices.

Plan: `docs/plans/PRC-1.md`. Decisions: D-prc1-1 to D-prc1-10 (`docs/decisions.md`). Migration **0024** (additive: it
rewrites no sale, piece or money row).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | see the report: summary pasted there |
| Backend tests, both projects | new: `pricing.property` (fast-check), `prc1-migrations`, `prc1-rates`, `prc1-pricing`, `prc1-receiving`, `pg/pricing-race` (real PostgreSQL) |
| `node scripts/e2e-prices.mjs` (new) | the Prices page, the Sunday/Monday example, the 409 in the cart, the invoice per gram, the cashier's scrap form |
| REH-1 rehearsal | the rates set on the Prices page (new, used, scrap), the forms without a price field, the cashier's sidebar |
| Perf (`node scripts/perf-homes.mjs`) | the POS grid and the inventory list with computed prices, budget 300 ms p95 |

## B. Walk-through (Codespace)

Start the sample (`npm run dev:sample`, then the server) and sign in as the General Manager (`sample.alpha`).

### 1. The Prices page

1. Sidebar › **الأسعار**. Expect three tables side by side: "سعر البيع · القطع الجديدة", "سعر البيع · القطع
   المستعملة", "سعر شراء الكسر", one line per allowed karat, each with "منذ …" (since when) or, in red, "لا يوجد سعر:
   لا يمكن بيع قطع هذا العيار". Below: the rate history with who and when (`prices.webp`).
2. Open `/settings#rates` in the address bar. Expect to land on the Prices page (old links still work).
3. The card "كيف يُحسب سعر البيع" shows the mode "من سعر الجرام (الوزن × السعر)", the rounding step 1 and a worked
   example.

### 2. Sunday 100 → Monday 110 (the owner's example, test values)

1. Record a supplier order with one piece of **1 g net**, 21K (Supplier purchases › New). Expect **no selling-price
   field** on the line, and the line "لا حاجة لكتابة سعر البيع…".
2. "Sunday": on the Prices page set the 21K new-piece rate to **100,000**, Save. Inventory: the 1 g piece shows
   **100,000**.
3. "Monday": set the rate to **110,000**, Save. Refresh the inventory: the same piece shows **110,000**. Nothing else
   was edited (`inventory.webp` shows the list with live prices).
4. Sell it at the POS (as the cashier): the cart line shows "110,000 للجرام"; the invoice shows the column
   "السعر للغرام" with 110,000 (`invoice.webp`).
5. Set the rate back to 100,000. Open the sale: it still shows **110,000** and 110,000 per gram. Past sales never
   change.

### 3. A rate change while a piece is in the cart (the 409)

1. As the cashier, put a piece in the cart (`pos.webp`: the grid shows live prices).
2. In another browser, as the General Manager, raise the 21K rate.
3. The cashier presses "إتمام البيع". Expect: **nothing is sold**; the cart shows the new price and per-gram rate and
   the notice "تغيّرت الأسعار: حُدِّثت أسعار السلة. راجعها ثم أكّد البيع من جديد." (`cart-rates-changed.webp`).
4. Press "إتمام البيع" again: the sale goes through at the price now shown.

### 4. A karat without a rate

1. Settings › allowed karats: add 18K and save. Do not set its rates.
2. Expect attention A16 (rates missing) linking to the Prices page; on the Prices page the 18K lines say "لا يوجد سعر".
3. A piece of 18K (if any) shows "لا يوجد سعر" in the inventory and on the POS card; it cannot be added to the
   cart. Set both 18K selling rates: A16 goes away and the piece is priced.

### 5. The cashier buys a sellable piece

1. Sign in as a cashier. The sidebar has a third icon, "شراء قطعة من زبون".
2. The form offers a sellable piece only (no broken scrap, no pool, no list) and **no selling-price field**: "يتبع
   سعر الجرام للقطع المستعملة" (`scrap-form.webp`).
3. Agree a price per gram far above the scrap rate: refused, it needs the General Manager. Pay more cash than the
   drawer holds: refused with the shortfall. Pay by bank transfer: accepted.
4. The new piece appears in the inventory at net weight × the **used-piece** rate. The audit log names the cashier.

### 6. Fixed prices still work

1. Prices page › "أسعار البيع" › "سعر ثابت يُكتب لكل قطعة", Save.
2. Supplier orders and the sellable-scrap form ask for a selling price again; the POS sells at the typed price; the
   invoice has no per-gram column. Switch back to "من سعر الجرام" afterwards.

## C. Open questions (settings until answered)

- **Q-1** making charge: none is added; `sale_items.price_making_charge` is the seam, always empty.
- **Q-2** rounding: `pricing.roundingStep` (default 1), applied once after weight × rate.
- **Q-5**: unchanged by this item.
