# Client Demo Script (≈ 25 minutes)

Preparation: `npm run demo`, open http://localhost:4000. For a clean run, reset the data first
(`npm run db:reset` or *Settings → Reset demo data*). Use two browser windows, e.g. a normal and
a private window, to be signed in as two users at the same time.

---

### 1. "This is what the cashier sees"
Sign in as **cashier.kh.01** / `demo-cashier-2026`.

- The POS opens: product grid on the left, current invoice on the right.
- Top bar: branch, user, date/time, the **21K gold price**, notifications.
- The dark band at the top is the separate **HASAD GOLD WITHDRAWALS** section.
- Point out: the cashier sees **only Khartoum** stock and **no cost or profit figures**.

### 2. "This is how a normal jewelry sale works"
- Type `J-10` or a product name, or scan a barcode and press Enter. Filter by karat or category.
- Click a piece to add it; show the weight, price and the discount field (capped at 3% for cashiers).
- Choose a payment method and click **Complete Sale**. The invoice appears with a *Print* button.
- The piece disappears from the grid: status **AVAILABLE → SOLD**.

### 3. "This is how a Hasad Gold customer withdrawal works"
- Click **HG-10025 · Ahmed Mohamed · 4.200 g** in the Hasad band.
- Explain: Hasad sent only an *entitlement* (4.200 g, 21K). **No piece has been chosen.**
- Enter pickup code **482913** and click *Verify & start*.

### 4. "The system does not reserve inventory until the customer selects a real item"
- The *Inventory impact* panel reads **None**. Browsing and filtering pieces reserves nothing.
- Click *Select for customer* on **J-1002 · Gold Ring · 4.180 g**. Only now does J-1002 become **RESERVED**.
  In the other window (e.g. cashier.kh.02 at the POS) it shows as reserved and cannot be sold.

### 5. "This is how weight differences are handled"
- **Case A:** 4.200 g entitled, 4.180 g delivered, difference −0.020 g → **Branch pays customer**
  (0.020 g × 190,000 = **3,800 SDG**).
- Click *Release* and select **J-1003 · 4.350 g** instead. J-1002 goes back to AVAILABLE.
- **Case B:** difference +0.150 g → **Customer pays branch 28,500 SDG**.
- Click *Review settlement & complete*, tick the customer-acknowledgement box and confirm.
  The piece becomes **REDEEMED**, Hasad is notified, and the settlement is recorded.
- Optional: *Customer left — release* shows RESERVED → AVAILABLE when a customer walks away.
  Reservations also auto-release after 30 minutes (configurable).

### 6. "This is how branch inventory changes"
Sign in as **branch.manager.kh** / `demo-bm-2026`.
- Dashboard → **Inventory movement**: Opening + Purchases + Transfers in − Sales − Hasad
  redemptions − Transfers out = Closing, in **pieces and grams**, with a *Reconciled* badge.
- Click through to *Inventory* → a piece → its **lifecycle** (PURCHASED → RECEIVED → AVAILABLE →
  RESERVED → REDEEMED) with the documents and users behind every step.
- *Transfers*: a transfer from Bahri is **in transit**. Click *Confirm receipt*.

### 7. "This is how branch profit is calculated"
- KPI *Gross Profit* = selling price after discount − item total cost (purchase + making + other).
- *Contribution* = gross profit − approved branch expenses. Show *Expenses → New expense*.
- *Reports → Profit Report*, grouped by branch, category, karat, cashier or day.

### 8. "This is what the branch manager sees"
- Hasad section: new requests, waiting, completed, cancelled, amounts **paid to** and
  **collected from** customers. Cashier activity table.
- Try to open another branch's data (e.g. change `branchId` in the URL): the API returns **403**.

### 9. "This is how the general manager sees all branches"
Sign in as **general.manager** / `demo-gm-2026`.
- **Executive Overview**: six KPIs, the *Branch Performance* table, daily sales by branch,
  items needing attention (a pending expense approval, a transfer in transit).
- **Drill-down:** click *Khartoum*, then the *Sales* tab, then an invoice (items, cost, profit,
  cashier, timestamp), then a piece (its full lifecycle).

### 10. "This is how user activity and active sessions are monitored"
- **Active Users**: who is signed in, role, branch, login time, last activity, device, IP,
  current module. Note **cashier.pzu.01 is signed in on two devices**. It is flagged, because the
  system always shows the account that actually signed in. Sessions can be ended.
- **Users**: create a user (a temporary password is shown once), **reset password** (never
  retrievable, only reset), disable an account. Sessions end immediately.

### 11. "This is how the audit trail works"
- **Audit Log**: filter by user, branch or action (e.g. `HASAD_WITHDRAWAL_COMPLETED`, `LOGIN_FAILED`).
  Every event carries timestamp, user, role, branch, entity, IP and session reference.

### 12. Integration & configuration
- **Hasad Simulator**: act as a customer in the Hasad app. Pick *Yousif Kheir* (8.400 g) and send a
  request to Khartoum. It appears in the cashier's Hasad band within seconds, and again **nothing
  is reserved**. The integration log shows every call the ERP made to the Hasad API.
- **Settings**: gold rates, settlement basis, discount limits, expense approval threshold, session
  timeouts, and a *simulated Hasad outage* switch that shows how failures are handled safely.
- Switch the UI to **العربية** to show the right-to-left layout.
