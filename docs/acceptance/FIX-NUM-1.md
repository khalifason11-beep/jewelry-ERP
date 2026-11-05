# Manual acceptance: FIX-NUM-1 (number fields that can always be cleared and typed over)

For the owner, about 10 minutes, on the live server after the update, in a desktop browser (and a phone for step 6).
Engineering ran section A.

What changed (plan `docs/plans/FIX-NUM-1.md`, decisions D-fixnum-1…5):

- **Every number field of the app** (amounts, weights, karats, counts): Tab into a field that shows a number such as
  «100,000» and type: what you type **replaces** the number. Before, it was added to it (Tab, then 7, gave 1000007),
  which is why a number seemed impossible to delete. It is the same field everywhere, so one fix covers all of them.
- **Scrap purchase, the payment.** «المدفوع من الدرج» and «المدفوع بتحويل بنكي» both start **empty**. An empty field
  means **the rest of the amount**; that number is shown in grey inside the empty field, and the hint under both says
  «فارغ: باقي المبلغ». Neither field ever changes the other. To pay:
  - all in cash: type nothing;
  - all by transfer: type the amount in the bank field (the drawer field then shows 0 in grey);
  - part and part: type one part, the other field shows the rest; or type both.

  As before, the two must add up to the amount (the message says so and Buy stays grey), a bank part needs its
  reference, and the drawer cannot pay more than it holds. What is sent is exactly what the fields show. The only new
  case is a bank part with the drawer field empty: before, it was refused (the drawer field counted as the whole
  amount); now the drawer pays the rest, as the hint says.
- **Settings.** Saving one card no longer undoes what you typed, or cleared, in another card and have not saved yet.
- **POS discount** (only when you have set a discount cap; none by default). A discount above the cap is no longer
  replaced by the cap while it is typed: the typed number stays, «لا يزيد على …» (at most …) is shown under it, and
  «إتمام البيع» stays disabled until it is corrected (your answer Q2, D-fixnum-5). The API is unchanged.
- **Supplier purchase, making-cost correction.** The empty «New making cost» no longer shows a grey «0»: an empty field
  is not 0 there (Save stays grey until you type a cost; 0 is allowed when typed).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| Reproduced first | `e2e-numbers` on the unfixed code: Tab into «100,000» and type 7 gave «1000007»; on the scrap form the typed bank part (40,000) was replaced by 30,000 when the cash part changed; in Settings, a typed 777 and a cleared field came back as 0 and 30 after another card was saved |
| New tests | `inputs.property.test.ts` (`ungroupedOffset`: a caret in «150,000» lands on the same digits in «150000»); `scripts/e2e-numbers.mjs` (new, in `verify --full` and CI): typing over a grouped number, the scrap payment (type, clear, edit the other, all by transfer, the amounts sent, a 360 px screen with 44 px fields), Settings, and the sweep below |
| The sweep (D-fixnum-3) | as the branch manager and the General Manager, every visible number or phone field of: the scrap form, the POS (split payment), Cash (the count), Money transfers (send), Funding (advance), Settings, Prices, a new supplier purchase, an opening draft: typed in, cleared, left empty while another field is edited, typed in again |
| Updated tests | `e2e-states` and REH-1 asserted the old scrap behaviour (the rest written into the bank field); they now read it as the grey hint |
| POS discount (Q2) | `e2e-numbers` and REH-1: a discount above the cap stays as typed, «لا يزيد على …» is shown, «إتمام البيع» is disabled; cleared, the sale can go on |
| REH-1 | 379 checks (was 373) |

## B. The audit (every number field of the frontend, read in the code and swept in the browser)

Patterns: (1) a derived value shown as the field's value, or a field refilled or reset by another field or an effect;
(2) a non-empty default nobody typed; (3) empty silently read as 0; (4) a field that cannot go back to empty, or a
sticking digit; (5) linked amounts; (6) a read-only field that looks editable.

| Page | Field | Pattern | Severity | Status |
|---|---|---|---|---|
| Every page | every `MoneyInput`, `WeightInput`, `IntegerInput`, `DecimalInput` (the shared field) | 4: Tab into a grouped number and type appended to it («1000007»); the selection was lost when «100,000» became «100000» on focus | **high** (all money and weight fields) | **fixed**, c1 (D-fixnum-2) |
| Scrap purchase | Paid by bank transfer | 1: the rest written into the field as its value (`bankPart ?? String(bank)`) | **high** (the owner's report) | **fixed**, c2 (D-fixnum-1) |
| Scrap purchase | Paid from the drawer → bank | 1: every cash edit reset the bank field (`setBankPart(null)`) | **high** | **fixed**, c2 |
| Scrap purchase | both payment fields | 3, 5: empty cash = all in cash, empty bank = 0 (`Math.floor(Number(''))`) | medium | **fixed**, c2: empty = the rest, in both |
| Settings | every number setting | 1: saving one card replaced the whole draft; unsaved numbers in other cards came back | medium | **fixed**, c3 (D-fixnum-4) |
| Supplier purchase › correction | New making cost | 3: a grey «0» in a field where empty is refused, not 0 | low | **fixed**, c4 |
| Scrap purchase | Agreed rate per gram, when the karat changes | 1: typing or changing the karat empties the agreed rate (`setAgreed('')`), so a negotiated rate typed before the karat is lost | low (visible: the field empties, the grey hint shows the new karat's rate) | **kept on purpose** (your answer Q1): a rate belongs to a karat |
| POS | Discount (shown only when a role cap > 0; none by default, D-dec1-12) | 1: a discount above the role's cap was replaced by the cap as you typed (and again when the prices changed) | low (visible) | **fixed**, c6 (your answer Q2, D-fixnum-5): kept as typed, «لا يزيد على …», the sale blocked until corrected |
| Opening piece correction | Gross / net weight | 3: a weight cleared to empty is sent as "unchanged" (the server's preview shows the result) | low | **not changed**: it is what the correction means (only the changed values are sent) |
| Scrap purchase | Agreed rate per gram | — | — | correct: empty = today's rate, shown as the grey hint |
| Scrap purchase | Scrap rate | 6: a read-only box showing today's rate, next to the agreed rate | low | **not changed**: it cannot be typed in (read-only) and sits on the page's background, unlike the white fields; the agreed rate beside it is the field to type in |
| POS | Split payment, first part | — | — | correct: typed; the rest is shown as text, not in a field |
| Supplier purchase (new) | Making cost, other cost | 3: empty = 0, hinted «0» | — | correct: empty really is 0 there, and the hint says so |
| Supplier purchase (new) | Gross, net, purchase cost, price | — | — | correct: empty is refused with the missing item named |
| Supplier settlement | Weight | — | — | correct |
| Cash | The count | — | — | correct: empty keeps Save grey |
| Money transfers, Funding | Amount | 3: `Number(amount)` | — | correct: guarded by `amount !== ''` |
| Prices | Rates (new, used, scrap), rounding step, guard %, extra karat | 1: the draft is reset from the server data | — | correct: it resets only when the server's rates change (React Query keeps the same data object on an unchanged refetch) |
| Openings | A piece (gross, net), broken scrap (karat, weight), its edit and correction | — | — | correct |
| Piece page | Change price (fixed-tag pricing only) | 2: starts at the current price | — | correct: an edit of an existing value |
| Phone fields (POS, scrap, supplier) | Phone | — | — | correct |

## C. Checklist (the live server)

Prepare: a branch whose drawer and bank hold enough for two small scrap purchases. Note the drawer and bank balances on
**Cash** before you start.

1. [ ] **Tab replaces, it does not append.** Scrap purchase: karat 21, net weight 1. Type 100000 in «المدفوع من الدرج»,
   click elsewhere (it shows «100,000»), then press Tab (or Shift+Tab) until you are back in it and type 120000: the
   field holds 120,000, not 100,000120,000. Do the same in any other amount or weight field.
2. [ ] **Nothing comes back.** Type 40000 in «المدفوع بتحويل بنكي»; change the drawer field: the bank field still holds
   40,000 (the message says the parts do not add up). Clear the bank field and change the drawer field again: the bank
   field stays empty.
3. [ ] **Pay all in cash: type nothing.** Clear both payment fields. Both are empty; the drawer field shows the amount
   in grey, the bank field 0 in grey; no reference is asked; «شراء ودفع» is enabled.
4. [ ] **Pay all by transfer: one entry.** Type the whole amount in the bank field only, and the reference: the drawer
   field stays empty and shows 0 in grey; Buy. The list's «طريقة الدفع» shows bank transfer.
5. [ ] **Split.** Type 100000 in the drawer field: the bank field stays empty and shows the rest in grey; the reference
   is asked. Type the reference and Buy. The list shows both parts.
6. [ ] **Bank part typed, drawer empty: the drawer pays the rest.** A new purchase (karat 21, net weight 1): type
   50000 in the bank field only, and the reference. The drawer field shows the rest in grey, «شراء ودفع» is enabled, Buy.
   Check that what was recorded matches what was on the screen:
   - the list's «طريقة الدفع» shows the drawer part (the rest) and 50,000 by bank transfer with the reference;
   - on **Cash**, the drawer is lower by the rest, and the bank by 50,000 (against the balances you noted, with the
     purchases of steps 4 and 5).
7. [ ] On a phone: the two payment fields are full-height (easy to tap), nothing scrolls sideways.
8. [ ] **Settings.** Type a number in one card without saving, change and save another card: your typed number is
   still there (and it is not saved until you save its card).
9. [ ] **POS discount** (only if you have set a cap): type a discount above the cap: the number stays, «لا يزيد على …»
   is shown, «إتمام البيع» is disabled. Correct it: the sale can go on.

## D. Your answers (2026-11-05)

- **Q1 (kept).** On the scrap form, changing the karat empties the agreed rate per gram: a rate belongs to a karat.
- **Q2 (changed, c6).** A discount above the cap is kept as typed, «لا يزيد على …» is shown under it, and the sale is
  blocked until it is corrected; it is never replaced silently. The Sell button's rule gains this condition; the API is
  unchanged.
