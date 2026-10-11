# Plan SUP-1: warn when a new supplier order is recorded for a supplier that still has gold owed

Small item. **No question blocks it**, so it is implemented in the same run (owner instruction).

## Facts

- **Client:**
  - a supplier allows **one open order at a time**; the next order opens only after the gold owed on the previous one
    is settled;
  - the shop works with several suppliers to have several open orders;
  - the owner wants a **warning, never a block**.
- **Today:**
  - `createPurchase` (GM only since MKC-1) records an order whatever the supplier still holds;
  - attention **A6** already computes, per supplier, the gold owed in 24K mg, the number of open orders and the oldest
    order (`backend/src/modules/attention/service.ts`).

## Scope: company-wide (your assumption is right)

- The `suppliers` table has **no branch**: a supplier belongs to the company.
- Orders carry a `branch_id`, but A6 in the General Manager's company view already sums a supplier's open orders across
  every branch.
- The rule belongs to the supplier, so the check counts the supplier's open orders in **all branches**, whichever branch
  the new order is for.

## Design

1. **One source of truth.** A6's query moves unchanged into one exported helper, `supplierGoldOwed(exec, { scope,
   supplierId? })`:
   - it adds the oldest order's **number** to its output;
   - A6 calls it, and so does the purchase check;
   - A6's signal, severity and `purchases.supplierDebtMaxAgeDays` (default 30) are **not changed**; the existing A6
     tests prove it.
2. **Server.** `POST /purchases` without `confirmOpenSupplierDebt` refuses the order with **409
   `SUPPLIER_GOLD_OWED`** when the supplier has open gold owed:
   - "We still owe this supplier {weight} of 24K from order {number}, open for {days} days. Record the new order
     anyway?";
   - `details` = { pureMg24, orders, oldestNumber, oldestPurchaseId, days };
   - with the flag the order is recorded and `PURCHASE_CREATED` gains `openSupplierDebtConfirmed: { pureMg24, orders,
     oldestNumber, days }`;
   - the check and the duplicate-reference check of MKC-1 are independent; the form sends both flags once each is
     confirmed.
3. **Read for the form.** `GET /suppliers/:id/gold-owed`, needing `purchases.create` (General Manager only), returns the
   same facts so the warning shows **as soon as the supplier is selected**, before saving.
4. **Form.**
   - An inline warning under the supplier field, with weights, the order number and the age only, never money
     (D-4-16).
   - A **"Record anyway"** button saves with the confirmation.
   - If "Receive into stock" is pressed instead, the server's 409 brings the same warning.
5. **Visibility.** Weights and days only; any new response field is classified SAFE (weights are operational, D-4-16).
6. **No migration.** No column or table is needed.

## Wording (a decision, not a question)

Your example "This supplier still owes 1,250 g…" reads as if the supplier owed the shop. In this system the **shop owes
the supplier**, so the sentence says "We still owe this supplier …".

The weight uses the system's gram format (`1.250 g`), and numbers are isolated left to right in Arabic.

## Tests, checks, docs

- **Backend, both projects:**
  - warn on the first attempt;
  - accept with the confirmation, which is audited;
  - no warning for a supplier with nothing owed;
  - the warning disappears once the gold is settled with broken scrap;
  - company-wide (an open order in another branch warns);
  - `GET /suppliers/:id/gold-owed` is 403 for the branch manager and the cashier;
  - A6 is unchanged.
- The generated route tests cover the new route.
- **REH-1 and e2e-states:** the inline warning, "Record anyway", and axe on the dialog.
- **Docs:** D-sup-1… in `docs/decisions.md`, `docs/acceptance/SUP-1.md`, BACKLOG status.
- **Gates:** as for MKC-1.

## Commits

1. This plan.
2. Backend and screens with tests, REH-1 and e2e.
3. Docs, acceptance and full gates.

## Open client question (not blocking)

- **The age at which an open supplier debt becomes a warning on the attention list:** A6 uses
  `purchases.supplierDebtMaxAgeDays`, default **30**, not confirmed by the client and not changed here.
- The SUP-1 warning on the form shows the age whatever it is.
