# UX-1: adding stock must be easy and hard to get wrong (plan)

Screens and input only. No money, ledger, stock, permission or approval rule changes; selling prices are entered and
stored as today (PRC-1 comes next); the customer ID stays in the API and the database (SCR-1). No new dependency, no
migration.

## 1. The claims, checked in the code

| Claim | Verdict |
|---|---|
| `suggest()` pre-fills cost = net × selling rate, making = 10,000/g, price = (cost + making) × 1.22 to 5,000 | **True** (`PurchasesPages.tsx:173-182`, on blur of Net when the cost is empty). Also: the cost and making are rounded to 1,000 with float math, and the tip under the lines advertises it. The rate is the **selling** gold rate (D-ui-6). |
| `type="number"`: spinners, wheel, negatives, e/+/- ; many without `min` | **True**: 23 inputs in 9 files (purchases 6, scrap 7, settings 4 + 17 settings through one helper, cash 2, funding 1, inventory 1, POS 1). |
| Phone, customer ID, supplier invoice no. accept any text | **True in the UI.** The **server already refuses** a phone outside `+ digits spaces ( ) -` (`zPhone`); the ID and the invoice number are free text ≤ 60 on the server. |
| Transfer date shows mm/dd/yyyy in Arabic | **True with an English-US browser**: a native date field follows the *browser's* locale, never the page language. 7 native date fields (filters, cash day, branch day, company dashboard, transfer date). |
| The transfer reference is printed a second time | **True, on purpose (FIX-2):** the hint shows the *normalized* reference (Arabic digits → Latin, upper case) as a preview. Same pattern on the scrap and funding bank references. **Fix of the cause:** the field normalizes as you type, so the preview has nothing left to show and goes. |
| "Gross g", "Net g" unclear | **True**: headers only, no hint. |
| A sellable piece takes three dialogs | **True**: supplier order → "New product" dialog → "New type" dialog on top. |
| Scrap form shows customer fields as if needed | **True**: four fields in the main grid; none is required (UI or API). |

## 2. Shared number fields (PART 1)

- **Logic in `shared/src/inputs.ts`** (pure, property-tested from the backend suite; there is no frontend test runner and
  none is added): digit normalisation (٠-٩ ۰-۹ → 0-9, `٫` → `.`, thousands `,` `٬` and spaces dropped), the typing filter
  (letters, `e`, `+`, `-` refused, one decimal separator, at most N decimals), `parseMoney`, `parseWeightMg` (through the
  existing `gramsToMg`, not a copy), `parseInteger`, display grouping, and the text rules (phone, reference) and date
  (`dd/mm/yyyy` ↔ `yyyy-mm-dd`).
- **Kit components** (`components/ui/NumberInput.tsx`, `DateInput.tsx`): `MoneyInput` (whole units, currency suffix),
  `WeightInput` (≤ 3 decimals, g/جم), `IntegerInput` (min/max, optional suffix such as %), `DecimalInput` (for the one
  non-integer setting, the scrap tolerance %), `PhoneInput`, `ReferenceInput`, `DateInput`. A text input with
  `inputMode`, `dir="ltr"`: no spinner, the wheel does nothing, the value stays a string, empty stays empty; a refused
  key or paste leaves the field unchanged and says why inline; out of range shows the limit inline. Grouping
  (`1,250,000`) shows when the field is not focused; copy gives what is shown, paste of `1,250,000` works.
- **DateInput**: types `dd/mm/yyyy` (slashes added), stores `yyyy-mm-dd`, keeps the `max` (no future) rules; a calendar
  button opens the browser's picker (`showPicker`).
- **Text identifiers**: phone = digits, `+`, spaces (stricter than the server, which is unchanged); bank/transfer
  references = the FIX-2 set (A–Z 0–9 space `-` `/` `.`, upper-cased, ≤ 40); supplier invoice no. and customer ID
  document = the same set, ≤ 60. Hasad references stay free text (D-fix-2 leaves them untouched).
- **Server**: one table-driven test, `numeric-input.test.ts`, sends negative, zero (where invalid), `null`/`"NaN"`,
  fractional money, fractional mg (= more than 3 decimals of grams), above the cap and a string to every money, weight
  and count field of: `POST /purchases`, `/purchases/:id/settlements`, `/scrap-purchases`, `/inventory/items/:id/price`,
  `/gold-rates`, `/scrap-rates`, `/funding/advances`, `/funding/repayments`, `/cash/counts`, `/cash/hasad-settlements`,
  `/sales` (discount) and `PUT /settings` (numeric keys): 400 `BAD_REQUEST` naming the field. **Found:** the body karat
  of a scrap purchase and a settlement uses `z.coerce` (meant for query strings), so `true` becomes karat 1 and `[21]`
  becomes 21; fixed in its own commit (`z.number().int()`).

## 3. Invented numbers (PART 2)

| Where | Value | Kind | Action |
|---|---|---|---|
| `PurchasesPages.tsx:178-181` `suggest()` | selling rate as cost, 10,000/g making, ×1.22, round 1,000/5,000 | **invented, pre-fill** | **removed**, with its tip |
| `PurchasesPages.tsx:134` | other cost starts at `0` | pre-fill | empty, placeholder 0 (empty is sent as 0, as today) |
| `ScrapPage.tsx:336`, `PosPage.tsx:359`, `SettingsPage.tsx:234,242,293` | `step` 500 / 1,000 / 0.5 | invented, input hint | gone with the spinners |
| `ScrapPage.tsx:215,336` agreed price = today's scrap rate | setting | D-4-7 | kept |
| `settings.ts` defaults: currency SDG/ج.س, Africa/Khartoum, discounts 3/10/20 %, tolerance 2 %, debt 30 days, karats 18/21/22/24 … | settings | D-1b-7, D-1b-9, D-ux-12 | kept; **discounts 3/10/20 % and the zone value are not in decisions.md** (owner) |
| `routes.ts` `MAX_MONEY` 1e12, `MAX_WEIGHT_MG` 10 kg, gold rate ≤ 1e8/g | validation caps | not documented | kept, recorded as D-ux1-4 |
| `enums.ts` `KARATS` 18/21/22/24; `SettingsPage.tsx:23` choices 9/12/14/18/21/22/24 | caps / choices | D-rem3-5 | kept. **Surprise:** 9/12/14 K can be allowed but never get a gold rate (`POST /gold-rates` takes `KARATS` only): question 2 |

Nothing that affects stored money or stock is changed.

## 4. Supplier-order wording (PART 3) — order and behaviour unchanged

| Field | English label · hint | Arabic label · hint |
|---|---|---|
| Product | Product · Type to search, or create it here. | المنتج · اكتب للبحث، أو أنشئه هنا. |
| Gross | Gross weight · The whole piece, with any stones or other parts. | الوزن القائم · القطعة كاملة، بما فيها الأحجار أو الأجزاء الأخرى. |
| Net | Net gold weight · Gold only: the weight that counts for the karat and for the gold owed to the supplier. | الوزن الصافي للذهب · الذهب وحده: الوزن الذي يُحسب به العيار والذهب المستحق للمورد. |
| Cost | Purchase cost · Your value of the piece for cost and profit; the supplier is paid in gold, not money. | تكلفة الشراء · قيمة القطعة عندك لحساب التكلفة والربح؛ المورد يُسدَّد ذهباً لا نقداً. |
| Making | Making charge · Paid by the owner from the owner's personal account; needs the transfer reference. | أجرة المصنعية · يدفعها المالك من حسابه الشخصي؛ تتطلب مرجع التحويل. |
| Other | Other costs · Any other cost of the piece, such as stones; part of its cost, no money moves. | تكاليف أخرى · أي تكلفة أخرى للقطعة مثل الأحجار؛ تدخل في تكلفتها ولا تتحرك أموال. |
| Selling price | Selling price · The price the branch sells the piece at. | سعر البيع · السعر الذي يبيع به الفرع القطعة. |
| Under the lines | Net weight of all pieces: {weight} — compare with the supplier's invoice. | الوزن الصافي لكل القطع: {weight} — قارنه بفاتورة المورد. |
| Scrap | Customer details (optional) | بيانات العميل (اختياري) |

Disabled-button reasons (one at a time): Choose the receiving branch · Choose the supplier · Piece {n}: choose the
product · Piece {n}: enter the gross weight · Piece {n}: enter the net gold weight · Piece {n}: the net weight is more than the gross weight · Piece {n}: enter
the purchase cost · Piece {n}: enter the selling price · Enter the transfer reference of the making charge · Enter the
transfer date · The transfer date cannot be in the future (each with its Arabic in `i18n-ar.ts`). As built, the Arabic
labels reuse the existing terms: الوزن الصافي للذهب and أجرة المصنعية (already used elsewhere in the app). Inline create: Create "{name}" · New type ·
Create and use (أنشئ "{name}" · نوع جديد · أنشئ واستخدم).

## 5. One "add piece" flow (PART 4)

- **`ProductPicker`** (Catalog.tsx), used by the supplier line and the sellable scrap: one searchable list (the shared
  `normalizeName`, so أ/ا and digits match), recently picked first (this browser), then by name; keyboard (↑ ↓ Enter
  Esc). When the typed name matches nothing and the user has `catalog.create`: **Create "<name>"** opens a small panel
  under the field: Arabic name (pre-filled) and optional English name, karat (fixed when the scrap karat is chosen,
  otherwise a select), type (select, last used type first, or "New type" with a text field). One confirm posts
  `/categories` if needed, then `/products` (existing routes: unique names, length, permission, audit, "already exists →
  use it"), selects it and returns to the line. The Types & products page and its dialogs stay.
- **Supplier order:** "Add another piece" copies the previous line's product only and focuses its gross weight; Enter
  moves to the next field; totals stay in the footer; the receive button stays disabled with the first missing reason
  next to it; the sum of net weights under the lines (information only). Lines become stacked cards below 768 px
  (44 px controls, no horizontal scroll); a table-like row with header hints at 1366×768.
- **Scrap:** customer name, phone, ID document and note in one closed `<details>` "Customer details (optional)".

## 6. Tests and gates

`backend/test/inputs.property.test.ts` (digits, Arabic digits, paste, pasted negatives, decimals, empty, round trips);
`numeric-input.test.ts`; the UI kit page gains the new fields and `capture-ui-kit` checks typing, paste, wheel, keypad
mode and suffixes in the browser; a new `scripts/e2e-add-piece.mjs` (verify `--full` and the CI smoke job) covers inline
create, add another piece, Enter flow, the disabled reason and the closed customer section. REH-1 stops expecting the
suggested cost (it now checks the cost stays empty) and uses the picker. Screenshots `docs/acceptance/UX-1/`.

## 7. Questions for the owner

1. Discount caps 3/10/20 % and the time zone default are settings without a recorded decision: confirm or set them.
2. 9/12/14 K can be allowed in Settings but can never receive a gold selling rate. Restrict the choices to the karats
   with a rate, or widen the rate list? (Not changed here.)
