# Manual acceptance: REM-2 (Hasad only as a payment channel)

For the owner, in a desktop browser (Chrome or Edge). About 15 minutes.

## A. The rehearsal (engineering runs it, the owner reads the output)

```bash
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>:<password>@localhost:5432/postgres npm run rehearsal
```

Expected last line: `REHEARSAL PASSED: 63 checks.` In production mode on an empty PostgreSQL database it now also checks
that no Hasad withdrawal wording or menu entry appears for the branch manager or the General Manager, in Arabic or
English, that the Hasad routes and report are gone, and that the POS still offers Cash, Bank transfer and Hasad.

## B. In the demo (`npm run demo`, http://localhost:4000)

Use a fresh demo database (delete the `PGLITE_DIR` folder or run `npm run db:reset` first).

| # | Step | Expected |
|---|---|---|
| 1 | Sign in as a **cashier** (Khartoum). Look at the sidebar and the top of the POS. | No "Hasad Withdrawals" / "سحوبات حصاد" entry, no dark Hasad band above the products. |
| 2 | At the POS add a piece, choose **Hasad** as the payment method and try to complete without a number. | The button stays disabled until the **Hasad invoice number** is typed. |
| 3 | Type an invoice number (and optionally a transaction reference) and complete the sale; print the invoice. | The sale is saved; the invoice shows the payment method Hasad and the references. No separate "Hasad delivery" receipt exists. |
| 4 | Sign in as the **branch manager**. Open **Cash**. | The Hasad receivable of the branch grew by the sale amount; "Settle Hasad receivable" records Hasad's bank transfer as before. The daily drawer and bank lists still end with "Other movements" and add up. |
| 5 | Open the **branch dashboard**. | No Hasad Withdrawals KPI, no Hasad Gold card, no Hasad column in the cashier table. The stock movement card shows "Other" where Hasad redemptions used to be. |
| 6 | Sign in as the **General Manager**. Open the **Company overview** and **Branches** → a branch. | No Hasad redemptions column, no "Hasad requests" or "Hasad settlements" in Needs attention, no Hasad tab or Hasad code on the branch page. |
| 7 | Open **Reports** → **Sales report**. | No "Hasad Withdrawal Report" in the list. The Sales report shows headline figures **per channel: Cash, Bank transfer, Hasad**; their sum equals the report total. |
| 8 | Open **Settings**. | No "Hasad Gold settlement" card and no "Mock Hasad Gold service". "Payment methods at the counter" still lists Hasad. |
| 9 | Type `http://localhost:4000/hasad` and `/hasad-simulator` in the address bar. | The app's "not found" page. |
| 10 | Switch to English and repeat steps 1, 5–8 quickly. | Same result. |
| 11 | Look at the login page. | No mention of Hasad withdrawals or of the client's city names. |

## C. Upgrading an existing database (engineering, already done once)

A demo database created before REM-2 (19 Hasad requests, 10 weight-difference settlements and their 10 ledger
entries, and one open counter session holding piece J-1001 RESERVED) was upgraded with migration 0014: history kept;
J-1001 released to AVAILABLE with a status-history row and an audit entry (System); the session aborted; the `hasad.*`
permissions removed; all 184 branch-days of the reconciliation add up with the old settlements under "Other"; the
stock ledger still reconciles; new rows in the Hasad tables are refused by the database.
