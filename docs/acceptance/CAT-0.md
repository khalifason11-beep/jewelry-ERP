# Manual acceptance: CAT-0 (types, products and suppliers created where they are needed)

For the owner, in a desktop browser (Chrome or Edge). About 20 minutes.

## A. The rehearsal (engineering runs it, the owner reads the output)

```bash
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>:<password>@localhost:5432/postgres npm run rehearsal
```

Expected last line: `REHEARSAL PASSED: 72 checks.` In production mode on an empty PostgreSQL database it now also
checks that bootstrap invented no types, products or suppliers; the General Manager sets the 21K scrap rate; the branch
manager adds a supplier, a type and a product **from the purchase form**, records a supplier order that shows the
supplier and the gold owed (4.375 g of 24K for 5 g of 21K), is offered the existing type when typing it with a
different spelling, buys a sellable scrap piece with a product created inline, finds both pieces by filtering on the
new type, and sees the Arabic names on the English screen; the audit log shows all of it.

## B. In the demo (`npm run demo`, http://localhost:4000)

Use a fresh demo database (delete the `PGLITE_DIR` folder or run `npm run db:reset` first).

| # | Step | Expected |
|---|---|---|
| 1 | Sign in as the **branch manager** (Khartoum). Open **Types & products** in the menu. | Two tabs, Products and Types, with codes, karat and type. No Deactivate buttons (General Manager only). |
| 2 | Click **New type**, type `أساور ذهب` (Arabic only), save. | The type appears with a code like `T-001`. |
| 3 | Click **New type** again and type `اساور  ذهـب` (no hamza, two spaces, a tatweel). | Refused: "This type already exists: أساور ذهب", with a button to use it. Nothing new in the list. |
| 4 | Open **Purchases** → **New purchase**. Try to receive without choosing a supplier. | "Receive into stock" stays disabled until a supplier is chosen. |
| 5 | Next to Supplier click **New supplier**, type an Arabic name only, save. | The dialog closes and the new supplier is selected. Press Escape only once in a dialog: only that dialog closes. |
| 6 | On the first line click **+** (New product). Type an Arabic name, choose 21K, click **New type** inside it, create a type, then create the product. | The new type is selected in the product dialog; the new product is selected on the line. |
| 7 | Fill gross 5.2, net 5, cost and selling price; receive. | The purchase page shows the supplier's Arabic name and the gold owed to the supplier (24K). |
| 8 | Open **Scrap gold**, choose **Sellable piece**, karat 21K, click **New product** next to Product. | The product dialog shows the karat fixed to 21K. Create a product; it is selected. Buy the piece. |
| 9 | Open **Inventory** and filter by the new type. | Both new pieces appear (the filter works with types created today). |
| 10 | Switch to **English** and look at the inventory list, the purchase page, Types & products and the POS. | Names that have no English version show in Arabic, never blank. |
| 11 | Sell one of the new pieces at the POS and print the invoice (English and Arabic). | The invoice shows the product's Arabic name in both languages. |
| 12 | Sign in as the **General Manager** → **Types & products**. Deactivate the new product with a reason. | It shows "Deactivated". In a new purchase or sellable scrap it is no longer offered; the piece already in stock still sells. Reactivate it (reason required) and it is offered again. |
| 13 | Open **Audit log**. | Entries for the supplier, the types and products created, and the deactivation/reactivation with its reason. |
| 14 | Sign in as a **cashier**. | No "Types & products" in the menu. |

## C. Upgrading an existing database (engineering, already done once)

A demo database created with the previous version (commit `15ef97b`: 7 types, 29 products, 4 suppliers, 169 sale
lines) was upgraded with migration 0015: counts unchanged, every type and product active, every normalized name
filled, no duplicates in the demo seed. A copy where a second type `خواتـم` (tatweel) and two suppliers `مصنع الامل` /
`مصنع الأمل` had been added stopped with *"Migration 0015 (CAT-0) stopped: names that are the same after
normalization: type "خواتم" (ids 1,8); supplier "مصنع الامل" (ids 5,6) … Nothing was changed."*, and indeed nothing was
applied (the migration log still ended at 0014).

## Not in CAT-0

- **Renaming** a type or product: not yet. Sales store only the English product name; the Arabic name and the type
  names are read live, so a rename would change old invoices. CAT-1 will store them on the sale line first.
- The first-steps guidance on an empty system stays in REM-3.
