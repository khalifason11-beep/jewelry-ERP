# Presentation Script (≈ 20 minutes)

Since REM-3 there is no demo data: every database starts empty. A presentation therefore uses either

- **a fresh empty database**, to show the first start exactly as the client will live it (part A), or
- **a sample database** made by `npm run dev:sample`, to show daily work with a few records (part B).

The sample uses **marked placeholder names** (`[عينة] …` / `[Sample] …`) from `backend/src/dev/sample-names.json`
until the owner supplies real, client-approved names. Say so when presenting; do not invent names on screen.

Use two browser windows (e.g. a normal and a private window) to be signed in as two users at the same time.
The UI opens in Arabic; the header switch shows English.

---

## Part A — the first start (empty database)

Preparation:

```bash
rm -rf .data/pglite                                   # only a local trial database
TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm run demo       # asks for the GM username, prints a one-time password
```

(Omit `TWO_FACTOR_REQUIRED_ROLES_INITIAL=` to show the passkey registration as well; it works on `http://localhost`.)

1. **Sign in as the General Manager** with the one-time password and choose a new password.
2. **First steps.** The home screen shows the five-step checklist and the attention list:
   allowed karats → today's gold rate and scrap rates → first branch → branch manager and cashier → fund the branch.
   The header says "Set today's rate".
3. **Allowed karats** (mandatory): tick the karats the shop sells, confirm with the password. The audit log records it.
4. **Settings**: enter today's gold rate for each allowed karat and the scrap rates. The header now shows the rate
   (it always shows the 21K rate: a known limit, BACKLOG §G).
5. **Branches → New branch**, then **Users**: a branch manager and a cashier (temporary passwords shown once).
6. **Cash → Record an advance** into the new branch's drawer (the fifth step). Explain: the drawer can never pay out
   money that was never recorded; the branch now owes the General Manager that amount (only the GM sees it).
   The checklist disappears when the five steps are done.
7. Sign in as the branch manager: the home explains there is **no stock yet**. Sign in as the cashier: the
   point of sale says the same. Stock arrives with the first supplier order, which only the General Manager records
   (part B).

## Part B — daily work (sample database)

Preparation:

```bash
PGLITE_DIR=.data/sample npm run dev:sample                         # prints the accounts and passwords once
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

The sample has two branches, a General Manager (`sample.alpha`), a branch manager (`sample.bravo.a`, `.b`) and a
cashier (`sample.charlie.a`, `.b`) per branch, each branch funded (drawer and bank advances), a supplier order per
branch, three sales (cash, bank transfer, Hasad), two scrap purchases (broken and sellable) and one transfer in transit.

1. **Cashier** (`sample.charlie.a`): the point of sale shows only the own branch's stock and **no cost or profit
   figures**. Add a piece, choose the payment method (Hasad needs its reference), complete the sale, print the
   invoice. The piece leaves the grid (AVAILABLE → SOLD).
2. **Branch manager** (`sample.bravo.a`): the home (sales of the day, expected cash, stock, gold owed to suppliers as
   a weight, "Needs attention"), inventory with each piece's lifecycle, a **scrap purchase** paid in cash, by bank
   transfer or **split** (part cash, part transfer with its reference; a cash part larger than the drawer is refused
   with what to do), the **transfer** in transit, a supplier order's page with **settlement in broken scrap**, and
   **Cash** (daily reconciliation of drawer and bank, cash count). The branch manager cannot record a supplier order
   and sees no cost, profit or making charge. Another branch's data is refused (403).
3. **General Manager** (`sample.alpha`): the company home and the attention list, then drill down: a branch → its
   sales → an invoice → a piece. **Purchases → New purchase** for the sample supplier: a warning says gold is still
   owed to that supplier (weight, oldest order, days) and offers **Record anyway**. The making charge is paid by the
   owner personally: the form asks for the transfer reference and date, and no branch money moves. **Cash** shows
   the funding panel (advances, repayments, corrections, owed to the General Manager). **Reports**, **Active users** (sessions can be ended), **Users** (reset a password: never
   retrievable, only reset), the **Audit log** (every action with user, branch, IP and session) and **Settings**.
4. Switch to English to show the left-to-right layout.
