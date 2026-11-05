# FIX-NUM-1: number fields that can always be cleared and typed over

Status: **in progress** (owner's task of 2026-11-05; no stop for approval was asked; a payment-semantics finding would
stop the work and be asked).

**Owner's report.** On the scrap purchase from a customer (`frontend/src/pages/scrap/ScrapPage.tsx`, the payment part:
"Paid from the drawer" and "Paid by bank transfer"), a number sits in an amount field and cannot be deleted: it comes
back.

## 1. What was reproduced (Playwright, on the built app, before any fix)

Two defects, one on the form and one in the shared number field:

1. **The form (D-fixnum-1).** The bank field showed a derived number as its value (`bankPart ?? String(bank)`: the
   rest of the amount, or "0" when all is in cash). The cash field's handler did `setBankPart(null)`, so every cash
   edit threw away what was typed in, or cleared from, the bank field and wrote the derived number back. Empty meant
   two things: an empty cash field was "all in cash", an empty bank field was 0 (`Math.floor(Number(''))`).
   Reproduced: type 100,000 in cash, 40,000 in bank, then change cash to 120,000: the bank field showed 30,000 again.
2. **The shared field (D-fixnum-2).** `NumberCore` shows "150,000" when not focused and "150000" while focused. The swap
   happened on the render after the focus, which moved the caret to the end and dropped the selection. Tab into a
   field holding "100,000" selects it; typing 7 gave **"1000007"**: the old number stayed and the digit was appended.
   Reproduced on the unfixed component (check 04 of `e2e-numbers`). This is the same symptom ("the number comes back")
   on every money, weight and count field of the app.

## 2. Fixes

- **D-fixnum-2 (c1), `NumberInput.tsx` + `shared/src/inputs.ts`:** the swap is made in the focus handler itself, with
  the caret or selection mapped to the same digits by a new pure function `ungroupedOffset` (property-tested in
  `inputs.property.test.ts`). Nothing else in the component changes (sanitising, grouping, units, errors).
- **D-fixnum-1 (c2), the scrap payment:** both fields hold only what the user typed (`''` at first). **One meaning of
  empty: the rest of the amount.** Cash empty = amount − bank; bank empty = amount − cash; both empty = all in cash. The
  rest is shown as the grey placeholder of the empty field and is exactly what is sent; no field changes the other. The
  hint under both fields reads "Empty: the rest of the amount" («فارغ: باقي المبلغ»). All in cash: nothing to type;
  all by transfer: one entry (the amount in the bank field). Unchanged: the mismatch message and the Buy rule
  (`cash + bank = amount`), the API, the drawer-shortfall refusal, the bank-reference rule.
  - The only new combination is "bank typed, cash empty": it used to be refused by the mismatch (cash read as the whole
    amount); it now pays the rest from the drawer, as the hint says. No amount the form could send before changes.

## 3. Audit (c3…)

Every page and dialog with `MoneyInput`, `WeightInput`, `IntegerInput`, `DecimalInput`, `PhoneInput`,
`ReferenceInput` or a raw `<input>` is read for the six patterns of the task (derived value shown as the value or a
field refilled by another; a non-empty default; `Number('')` turning empty into 0; a field that cannot return to empty;
linked amounts; read-only fields that look editable). The findings go in a table in `docs/acceptance/FIX-NUM-1.md`
(page, field, pattern, severity, fixed or not). Clear-cut ones are fixed, one small commit per page, each with a test.
**A fix that would change what an amount means stops the work and is asked.**

## 4. The generic browser test and the rule

`scripts/e2e-numbers.mjs` (in `verify --full` and the CI smoke job) visits the main pages and dialogs with number
fields and checks for each: it can be typed in, cleared to empty and typed in again, typing over a shown grouped number
replaces it, and no value reappears on its own after another field is edited. A short rule in `CLAUDE.md` and
`CONTRIBUTING.md` (if present) states the pattern to avoid.

## 5. Commits

| # | Commit |
|---|---|
| c0 | this plan |
| c1 | D-fixnum-2: the shared number field keeps the selection on focus; `ungroupedOffset` + property test; `e2e-numbers` (typing over); REH-1 |
| c2 | D-fixnum-1: the scrap payment fields; `e2e-numbers` (the payment), `e2e-states` and REH-1 updated |
| c3… | one commit per page with a clear-cut audit finding, each with a test |
| cN | the generic sweep in `e2e-numbers`, the rule, `docs/acceptance/FIX-NUM-1.md` with the audit table, decisions, BACKLOG, `verify --full` |

## 6. Risks

- The focus swap now writes the input's value in the handler; React keeps it because the next render shows the same
  text. Covered by `e2e-numbers`, `e2e-states`, REH-1 and every e2e that types in number fields.
- Tests that use Playwright's `fill` on a number field shown grouped (not focused): `fill` selects before it focuses,
  which no person does, and the swap loses that selection. Such a test clicks the field first.
