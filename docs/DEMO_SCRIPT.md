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
2. **First steps.** The home screen shows the four-step checklist and nothing else:
   allowed karats → today's gold rate and scrap rates → first branch → branch manager and cashier.
   The header says "Set today's rate".
3. **Allowed karats** (mandatory): tick 21 only, confirm with the password. The audit log records it.
4. **Settings**: enter today's gold rate for 21K and a scrap rate. The header now shows the rate.
5. **Branches → New branch**, then **Users**: a branch manager and a cashier (temporary passwords shown once).
   The checklist disappears when the four steps are done.
6. Sign in as the branch manager: the dashboard explains there is **no stock yet**. Sign in as the cashier: the
   point of sale says the same. Stock arrives with the first supplier order (part B).

## Part B — daily work (sample database)

Preparation:

```bash
PGLITE_DIR=.data/sample npm run dev:sample                         # prints the accounts and passwords once
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

The sample has two branches, a General Manager (`sample.alpha`), a branch manager (`sample.bravo.a`, `.b`) and a
cashier (`sample.charlie.a`, `.b`) per branch, supplier orders, three sales (cash, bank transfer, Hasad), two scrap
purchases and one transfer in transit.

1. **Cashier** (`sample.charlie.a`): the point of sale shows only the own branch's stock and **no cost or profit
   figures**. Add a piece, choose the payment method (Hasad needs its reference), complete the sale, print the
   invoice. The piece leaves the grid (AVAILABLE → SOLD).
2. **Branch manager** (`sample.bravo.a`): dashboard, inventory with each piece's lifecycle, a **new supplier
   order** (new types, products and suppliers can be created inside the form), a **scrap purchase**, the
   **transfer** in transit, and **Cash** (daily reconciliation of drawer and bank).
   Another branch's data is refused (403).
3. **General Manager** (`sample.alpha`): the company overview, then drill down: a branch → its sales → an invoice
   → a piece. **Reports**, **Active users** (sessions can be ended), **Users** (reset a password: never
   retrievable, only reset), the **Audit log** (every action with user, branch, IP and session) and **Settings**.
4. Switch to English to show the left-to-right layout.
