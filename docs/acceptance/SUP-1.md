# Manual acceptance: SUP-1 (a warning on a new supplier order while gold is still owed to that supplier)

For the owner, about 10 minutes. Plan `docs/plans/SUP-1.md`, decisions D-sup-1 to D-sup-4 (`docs/decisions.md` §23).
No migration.

What changed: when the General Manager chooses a supplier that the shop still owes gold to, the purchase form says so
**before saving**:

> "We still owe this supplier 1.250 g of 24K from order PO-123, open for 12 days."

It gives weights, the order number and days only, **never money**. **Record anyway** records the order, and the
confirmation is written to the audit log. It is never a block.

The check is **company-wide**: an order still open in any branch counts, because a supplier belongs to the company.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run typecheck` (every check, four packages) | passed |
| Backend tests, both projects | 1,851 passed, 3 skipped: PGlite 904, PostgreSQL 950. New: `sup1.test.ts` |
| `npm run build`, `npm run i18n:check` | passed |
| REH-1 rehearsal | `REHEARSAL PASSED: 231 checks.` |
| `e2e-print` / `e2e-passkeys` (on, off) / `e2e-states` / UI kit | 47 / 33, 3 / 96 / 24 |
| `perf-homes` | every p95 ≤ 89 ms (budget 300 ms); A6 now reads through the shared helper, with the same single query |

`sup1.test.ts` (PGlite and PostgreSQL) checks that:

- the first attempt is refused with the facts;
- the confirmed order is recorded and audited;
- there is no warning when nothing is owed;
- a debt in another branch warns too;
- the warning disappears once the gold is settled with broken scrap;
- A6 reads the same facts;
- the read route is GM only, with weights only.

REH-1 checks that:

- the warning shows on the form (3.500 g of 24K from the CAT-0 order);
- "Record anyway" records the order, and the audit log has it;
- the API asks first too.

e2e-states checks the warning and runs axe on the dialog.

## B. In a Codespace (sample data)

> **Codespace settings (CLN-3).** Do **not** set `APP_ORIGIN` in a Codespace: its port proxy rewrites the `Origin`
> header, so the sign-in would be refused. The Codespace sets `APP_MODE=demo` and `TRUST_PROXY=1` itself (a codespace
> created before CLN-3: run `export TRUST_PROXY=1` in the terminal before starting the server, or rebuild the
> container). In the **Ports** tab, set port 4000 to **Public**, then open the address shown there (the globe icon).

Start the sample as in `docs/acceptance/MKC-1.md` (recreate `.data/sample`, `npm run dev:sample`, `npm start`). The
sample's supplier still has gold owed from its two orders.

| # | Who | Check | Expected |
|---|---|---|---|
| 1 | General Manager | **Purchases › New purchase**, Branch A, choose the sample supplier | A warning under the form: "We still owe this supplier … g of 24K over 2 open orders; the oldest, …, has been open for … days. The supplier usually opens a new order only after it is settled. Record anyway?" No money amount |
| 2 | General Manager | Fill one piece (making charge 0), click **Receive into stock** | The same warning stays (the server asks too); nothing is recorded yet |
| 3 | General Manager | Click **Record anyway** | The order is recorded. **Audit log**: the order's entry |
| 4 | General Manager | **New purchase**, a **new** supplier (New supplier) | No warning |
| 5 | Branch manager A | On an order of that supplier, settle the gold owed in full with broken scrap (buy scrap first if the pool is empty) | Then, as the General Manager, choosing that supplier no longer warns once every one of its orders is settled |
| 6 | Branch manager A | — | No "New purchase" (orders are General-Manager-only, MKC-1); the warning never shows to the branch manager |

## C. Open client question

- After how many days should an open supplier debt turn the attention line A6 into a **warning**?
  `purchases.supplierDebtMaxAgeDays`, default **30**, not confirmed and not changed here.
- The form's warning shows the age whatever it is.
