# Manual acceptance: UX-1 (adding stock is easy and hard to get wrong)

For the owner, about 15 minutes, in Arabic, on a 1366×768 screen. Plan `docs/plans/UX-1.md`, decisions D-ux1-1 to
D-ux1-9 (`docs/decisions.md`, section "UX-1"). No migration; no money, stock, permission or price rule changed.

Screenshots (Arabic, 1366×768) in `docs/acceptance/UX-1/`:

| File | What it shows |
|---|---|
| `supplier-order-empty.webp` | The supplier-order dialog, empty: the hints under each field, the reason beside the disabled button |
| `inline-create-product.webp` | The "new product" panel opened from the product field (with a new type) |
| `supplier-order-filled.webp` | Two pieces typed, the net-weight sum, the transfer reference, the button enabled |
| `scrap-customer-closed.webp` / `scrap-customer-open.webp` | The scrap purchase with the customer details closed, then open |
| `supplier-order-narrow.webp` | The same dialog on a 390 px phone-width screen (stacked, 44 px fields) |

## A. What engineering ran

See the report for the commit hashes and the `npm run verify -- --full` summary. The checks behind this page:
`backend/test/inputs.property.test.ts` (typing rules), `backend/test/numeric-input.test.ts` (the server refuses bad
numbers), `scripts/capture-ui-kit.mjs` (the fields in a real browser: wheel, paste, keypad, Arabic digits),
`scripts/e2e-add-piece.mjs` (this page's flows, 30 checks) and REH-1.

## B. What to click and what to expect

Sign in as the General Manager.

1. **Number fields (any screen, e.g. Purchases › New purchase).**
   - Click a weight field and turn the mouse wheel, or press ↑/↓: **the value does not change**.
   - Type `12a5`: the `a` is refused with "أرقام فقط" and the field shows `125`.
   - Type Arabic digits `٤٫٢٠٥`: the field shows `4.205`.
   - Paste `-5`: **refused**, with a message. Type a 4th decimal in a weight: refused.
   - Click away from an amount: it shows `1,500,000` with its currency label. Click back: plain `1500000`.
   - Clear a field: it **stays empty** (no 0 appears).
2. **Dates.** The transfer date (and every date filter) shows **dd/mm/yyyy**, even on an English-US Windows. Type
   `17102026`: the slashes appear. A future date says "لا يتجاوز …" and is not taken. The calendar button opens the
   browser's calendar.
3. **No invented numbers.** In a new supplier order, type the net weight and leave the field: **the costs and the price
   stay empty**. (Before, they were filled from the selling rate × 1.22.)
4. **Labels and hints.** Under each column header: a one-line hint. Gross = the whole piece with stones; net = the gold
   only, used for the karat and the gold owed to the supplier; making charge = paid by you, needs the transfer
   reference.
5. **The disabled button says why.** With nothing filled, beside "Receive into stock": "اختر الفرع المستلم". Fill the
   fields one by one: the reason moves on ("القطعة 1: اختر المنتج", … "أدخل مرجع تحويل أجرة المصنعية") and disappears
   when the order is complete.
6. **Create a product without leaving the line.** In the product field type a new name, e.g. `قلادة تجربة`. The list
   offers **أنشئ «قلادة تجربة»**: press Enter (or click it). A panel opens **inside the form**: the name is filled in;
   choose the karat and a type, or "+ نوع جديد…" and type the new type's name. Press **أنشئ واستخدم**: the product (and
   the type) are created, selected on the line, and the cursor is in the gross weight.
   - Typing a name that exists, spelled differently (أ/ا), shows the existing product in the list instead.
   - The Types & products page is unchanged.
7. **Keyboard.** Type the weights, costs and price pressing **Enter** after each: the cursor moves to the next field.
8. **Add another piece.** Click "إضافة قطعة أخرى": the new line has **the same product**, empty weights and prices,
   and the cursor is in its gross weight.
9. **Net weight sum.** Under the lines: "الوزن الصافي لكل القطع: … جم — قارنه بفاتورة المورد". Compare it with the
   supplier's invoice. Information only: nothing is blocked by it.
10. **Transfer reference.** Type `mkc-٧٧`: the field shows `MKC-77` as you type, and it is **not** printed a second time
    under the field.
11. **Scrap purchase (sign in as the branch manager, Scrap gold).** Choose "قطعة صالحة للبيع" and a karat. In the
    product field, type a new name: the "Create" panel has the **karat fixed** to the scrap karat and the **last type
    used** already chosen. Below the weights: **"بيانات العميل (اختياري)" is closed**. Buy without opening it: the
    purchase is recorded. Open it: name, phone (digits, spaces and a leading + only), ID document and note.
12. **Narrow screen.** On a phone-width window the supplier order shows one card per piece, no sideways scrolling.

## C. Questions for you (plan §7)

1. The discount caps 3/10/20 % and the time-zone default are settings without a recorded decision: confirm or set them.
2. Settings lets you allow 9, 12 or 14 K, but a gold selling rate can only be set for 18, 21, 22 and 24 K. Restrict the
   choices, or widen the rate list? Nothing was changed.
