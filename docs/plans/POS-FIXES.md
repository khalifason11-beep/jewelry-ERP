# Plan: FIX-1, FIX-2, REM-4, SEC-2 (POS functional fixes before UI-B)

Status: **APPROVED and BUILT** (2026-10-09). Commits: LOCK-1 `bd478fb`, SEC-2 `97a07f5`, FIX-2 `1a14985`,
FIX-1 + REM-4 `17300b7`, docs (this update, `docs/acceptance/POS-FIXES.md`, decisions §19 D-lock-1, D-sec2-1, D-sec2-2,
D-fix-1, D-fix-2, D-rem4-1).

### Owner's answers and what changed from the text below

- **Q1** yes: the security-locked notice comes first. Addition: the sign-in page reveals a lock to nobody but the person
  who has just confirmed "This wasn't me" in that same tab; a locked account and an unknown username give identical
  answers in the same timing class (tested). A locked General Manager account can only be unlocked by the operator
  command. The notice is driven by `users.view` (a branch manager has `users.view`, not `users.manage`).
- **Q2 (REM-4), owner decision:** the General Manager **keeps** "New transfer" on the Transfers screen as the GM's only
  start point, with the same rules as the POS transfer (courier required, all or nothing, row locks, nothing changed when
  a piece is no longer available, Idempotency-Key required, audited, route-matrix allow/deny/cross-branch tests). The
  Inventory card-view selection and the branch manager's "Select pieces in Inventory" button are removed. Start points:
  the BM's POS cart and the GM's "New transfer"; no other (§4 row 2 below is therefore **kept**, not removed).
- **Q3** yes: `transfers.courier_name` (migration **0019**, additive, hand-reviewed; `check:migrations` and
  `check:drizzle` pass). Addition: row locks, `ITEMS_UNAVAILABLE` with no change, Idempotency-Key required (now claimed
  inside the transaction), PostgreSQL race tests (two transfers; a sale and a transfer).
- **Q4** yes, with proof: a `NOT VALID` check would still be enforced on every later UPDATE (voids, reprints) of old
  rows, so the check is **validated**, after a guard that counts bank sales without a reference and stops with a clear
  message, changing nothing (migration **0018**, like 0016). Tests: the guard stops; a clean upgrade keeps Hasad and
  allows UPDATEs of existing bank sales.
- **Q5** yes, with normalization: Arabic-Indic and Persian digits to ASCII, trim, collapse spaces, upper case, before
  validation and duplicate detection (same branch, unvoided sales).
- **Q6 NO:** `sales.voidReauthAboveAmount` defaults to **0 = every void asks**; the General Manager can raise it. No
  guessed money amount. (The 2,000,000 in §5 below is superseded.)
- **Q7** yes. **Q8** yes, one reason per sale. Addition: a price change is any final line price different from the list
  price, up or down; the reason goes to the audit log (`SALE_PRICE_CHANGED`) **and the sale record**
  (`sales.price_change_reason`, migration **0017**), never to customer printouts; the audit entry carries prices only (no
  cost). So SEC-2 did need an additive migration after all (§1 below said none).
- **Schema summary:** three additive migrations, 0017 (SEC-2), 0018 (FIX-2 check after a guard), 0019 (FIX-1 courier).
  LOCK-1 and REM-4 needed none.

---

Original plan text (kept for the record):
Branch: `claude/hopeful-sagan-lehxyp`, based on `2988ff5` (UI-A2 done and approved).

Sources: `docs/SPEC.md` §8 (transfers) and the POS section; `docs/BACKLOG.md` FIX-1, FIX-2, REM-4, SEC-2; decision D-ux-10
(SEC-2); the owner's instruction of 2026-10-09.

---

## 0. First answer: the notices, and the real security lock

### 0.1 Every notice type in the shell notice area, in their final order (today, UI-A2)

| # | Notice (test id) | Level | Shown when |
|---|---|---|---|
| 1 | **New sign-in to your account: "Was this you?"** (`new-device-alert`), with *It was me* / *This wasn't me* | `lock` (first, ringed red, never cut) | The signed-in person's account had a sign-in from a device or browser not seen before, in the last 30 days, not yet answered (`sign_in_events.new_device`, `dismissed_at` empty). Only for accounts that have a passkey or whose role requires one. |
| 2 | **Second factor OFF for the General Manager** (`enforcement-off-banner`) | critical | The viewer is the General Manager (`settings.manage`), the app is in production mode, and `GENERAL_MANAGER` is not in the roles that must use a passkey. |
| 3 | **Backups need attention** (`backup-banner`) | warning | The viewer may see backups (`backups.view`, the GM), and the last successful backup or restore drill is older than the limits in Settings, or never happened. In demo mode it shows only once a backup has ever been made. |
| 4 | **Touch-only security keys are accepted** (`uv-preferred-banner`) | warning | The viewer is the GM and passkey user verification is set to *preferred* (not *required*). |
| 5 | **You have only one passkey** (`second-passkey-nag`), with *Add a device* | info | The viewer's role requires a passkey and exactly one is registered. |

At most two lines show before "+ N more notices". None can be dismissed while its cause remains.

### 0.2 The real security lock is NOT one of these notices

The **new-sign-in alert (#1) is not the lock.** It is the question whose answer can *cause* the lock. Here is what
happens today when the person answers *This wasn't me* on a sign-in that used a **recovery code** (D-2fa-13):

1. **Before confirming,** the confirmation dialog warns in red: "That sign-in used a recovery code: your account
   will be locked", followed by the full explanation (`not-me-lock-warning`).
2. **On confirming,** the server does five things at once:
   - locks the account (`users.security_locked_at`);
   - invalidates the remaining recovery codes;
   - revokes the passkeys;
   - ends every session;
   - records `ACCOUNT_SECURED` in the audit log.

   It then answers `{ securityLocked: true }`.
3. **The person** is signed out and sent to the sign-in page, **with no message.**
4. **Every later sign-in** is refused with exactly the wrong-password answer ("Sign-in failed. Check your username
   and password…"). This is deliberate: no new way to learn which accounts exist. The person cannot reach the shell,
   so no notice can ever reach them there.
5. **The General Manager sees nothing on any screen.** The Users list shows only the timed password lockout
   (`lockedUntil`), not a security lock. The only trace is the `ACCOUNT_SECURED` audit entry. Only the operator
   console lifts the lock (`unlock-security-lock`, which also issues a new one-time password).

### 0.3 Proposal to cover the lock (commit 1 of this bundle, "LOCK-1")

- **The person who reported it.**
  - What changes: right after the confirmed "This wasn't me", the browser itself (not the server) remembers
    `securityLocked: true` for that tab. The sign-in page then shows a red note: "Your account is locked for your
    safety. Nobody can sign in to it until the system administrator unlocks it and gives you a new one-time
    password."
  - Why it is safe: it comes from the person's own action in their own tab, so it opens no enumeration channel. A
    later sign-in attempt still gets the wrong-password answer.
- **Managers: a new notice, first in the order (the owner's rule: the security-lock notice comes first).**
  - Text: **"Account {name} ({username}) is security-locked. Only the system operator can unlock it (operator
    console: unlock-security-lock)."**
  - Level: `lock`, the same style as the new-sign-in alert.
  - Who sees it: anyone with `users.manage`, for the accounts in their scope. The GM sees all; a branch manager
    sees their own branch's staff.
  - When: while any such account exists.
  - Dismissal: none. It disappears when the operator lifts the lock.
- **Users list.** A "Security-locked since {date}" badge on the account.
- **Final order of notices after LOCK-1:**
  1. account security-locked (managers);
  2. new sign-in to your account;
  3. second factor off;
  4. backups;
  5. touch-only keys;
  6. only one passkey.

  See question Q1.
- **Data and tests.**
  - `/auth/me` gains `lockedAccounts: [{ id, username, fullName, fullNameAr, lockedAt }]`, filled only for
    `users.manage` and scoped by branch. The Users list gains `securityLockedAt`. Both fields are classified SAFE.
  - No schema change: the column exists.
  - Tests:
    - a branch manager never sees another branch's locked account;
    - a cashier gets an empty list;
    - the reporter's tab shows the note, another browser does not;
    - the refusal at sign-in stays byte-for-byte the wrong-password answer (`security-lock.test.ts` unchanged).

---

## 1. Which of the four need no schema change

| Item | Schema change? |
|---|---|
| **REM-4** | **None** (frontend only). |
| **SEC-2** | **None.** The amount is a setting (registry row, default from code). The reason goes into the audit log (`metadata`). |
| **FIX-2** | **None needed.** The reference is stored in the existing `sales.payment_ref_transaction` and validated by the server. *Optional* defence in depth: a `CHECK` constraint "bank transfer ⇒ reference present" (`NOT VALID`, like Hasad's, migration 0017): Q4. |
| **FIX-1** | **None** if the courier's name goes into the transfer's `notes` and audit metadata. SPEC §8 asks for the courier's name, and a proper column (`transfers.courier_name`, nullable, additive, migration 0017/0018) makes it visible and searchable in the log: Q3. |
| **LOCK-1** (§0.3) | **None.** |

**Without schema changes the whole bundle can be built:** FIX-1 with the courier in the notes, FIX-2 without the
`CHECK`. My recommendation adds **one additive migration** (the courier column and the bank `CHECK` together).

---

## 2. FIX-1: transfer from the branch manager's POS cart

### Current behaviour

- `pages/inventory/InventorySelect.tsx`: the branch manager's Inventory "Select & transfer" card view. Multi-select,
  then **Transfer selected** (`transfer-selected`), then `TransferDialog`, then `POST /api/transfers`.
- `pages/transfers/TransfersPage.tsx`:
  - the GM's **New transfer** dialog (`NewTransferDialog`, any branch to any branch);
  - for the branch manager, a **Select pieces in Inventory** button (navigates to Inventory);
  - the log, with **Confirm receipt**.
- `pages/pos/PosPage.tsx`: no transfer at all.
- Server: `modules/transfers/service.ts` `createTransfer` (permission `inventory.transfer`; pieces must be AVAILABLE
  in the sending branch, then TRANSFERRED, with a `TRANSFER_OUT` movement; audited `INVENTORY_TRANSFER`; idempotent
  route). The cashier has no `inventory.transfer`.

### Proposed behaviour

- **Button.** In the POS cart, **below "Complete sale"**, a secondary button **"Transfer to branch"**
  (`pos-transfer`). It shows only when the viewer has `inventory.transfer` and is bound to a branch, which means the
  branch manager. It is never shown to the cashier (no permission), and the GM has no POS (D-ux-7).
  - Disabled when the cart is empty or holds a piece another branch owns.
  - Disabled while a sale is being completed.
- **Dialog** (`Dialog`, D-ui-11 states):
  - destination branch: own branch excluded, from `/branches/directory`;
  - **courier's name: required**, 2–80 characters;
  - optional note;
  - the list of cart pieces with their weight;
  - **Send transfer**.
- **On success:**
  - one transfer holds every cart piece;
  - the cart empties (customer fields and held sale untouched);
  - toast "Transfer CO-TRF-… sent: {n} pieces in transit", with a link to the log.
- **Errors:**
  - a piece no longer AVAILABLE (sold meanwhile, at another till): the server refuses the whole transfer, the
    dialog names the piece and offers "Remove it from the cart";
  - nothing is half-sent: one transaction.
- **The Transfers screen becomes the log only:**
  - list, status, receipt;
  - courier column;
  - "Confirm receipt" for the receiving branch.
- **Server:**
  - `createTransfer` gains `courierName` (required for new transfers; old rows have none);
  - stored in `transfers.courier_name` (Q3) and in the audit metadata;
  - everything else unchanged.

### API, permissions, route matrix

- No new route.
- `POST /transfers` body gains `courierName` (`zText(80).min(2)`, required).
- **Scope stays `branch` with `inventory.transfer`.** The generated matrix tests already cover allow (BM, GM),
  deny (cashier, 403) and cross-branch: a branch manager naming another branch's pieces or `fromBranchId` is
  refused.
- The `SAMPLE` body in `phase1b.test.ts` gains `courierName`.

### Idempotency and ledger

- The route is already idempotent: the POS passes its action key, so a double click creates one transfer (tested).
- **No money moves**: no ledger entry, cost unchanged.
- SPEC §18.10 reconciliation untouched.
- Inventory movements stay as today: `TRANSFER_OUT` now, `TRANSFER_IN` on receipt.

### i18n keys (new)

- Transfer to branch
- Courier's name
- Transfer {n} pieces to another branch
- Transfer {number} sent: {n} pieces in transit
- {code} is no longer available: remove it from the cart
- Remove from the cart
- Courier
- Enter the courier's name

### Tests

- **Backend** (both projects):
  - the courier is required;
  - one transfer per cart;
  - an idempotent replay returns the same transfer;
  - a piece sold meanwhile refuses the whole transfer and nothing changes;
  - a cashier gets 403;
  - a cross-branch piece is refused;
  - the audit row holds the courier.
- **e2e-states sweep:** the POS with the button, BM and cashier.

### REH-1

- **Branch manager:** adds 3 pieces to the POS cart, then "Transfer to branch" (destination, courier), then:
  - one transfer with 3 pieces in the log, courier shown;
  - the pieces are TRANSFERRED;
  - the cart is empty.
- **Cashier:** there is no `pos-transfer` button on the POS (DOM count 0).
- **Receiving manager:** confirms receipt, and the pieces are AVAILABLE there.

---

## 3. FIX-2: bank-transfer reference

### Current behaviour

- `modules/sales/service.ts` `createSale`:
  - `paymentRefInvoice` is required for HASAD;
  - `paymentRefTransaction` is optional for HASAD;
  - **any reference for another method is refused** ("Payment references are only recorded for Hasad payments").
- POS (`PosPage.tsx`): Hasad fields only. Bank transfer has **no field**.
- Invoice (`print/documents.tsx`): shows the Hasad references only.
- Cash (`pages/cash/CashPage.tsx`): the reconciliation shows "Bank movements" as summed lines. **There is no
  drill-down.**

### Proposed behaviour

- **POS.** When **Bank transfer** is selected, a required field **"Bank transfer reference"** (`bank-reference`)
  appears under the payment buttons. "Complete sale" stays disabled until it is filled.
- **Server validation.**
  - The reference is required for `BANK_TRANSFER`, trimmed, **4–40 characters**, and only letters, digits, space,
    `-`, `/` and `.` (Q5).
  - It is stored in **`sales.payment_ref_transaction`** (existing column; for Hasad it already means "transaction
    reference").
  - `paymentRefInvoice` stays Hasad-only.
  - For CASH, any reference is refused, as today.
- **Duplicates.**
  - If the same reference (case-insensitive) is on another **non-voided** sale in the same branch, the server
    answers **409 `DUPLICATE_BANK_REFERENCE`** with that sale's number.
  - The POS asks "This reference is already on sale {number}. Record it anyway?". Confirming resends with
    `confirmDuplicateReference: true`, and the sale's audit row records it (`duplicateOf`).
  - The idempotency claim happens inside the transaction, so the 409 consumes no key.
- **Where the reference is shown:**
  - the **invoice and receipt**, "Bank transfer reference: …" (the customer's own payment, so it may be printed);
  - the **sale detail** and the **sales list** (a column, also in the CSV);
  - the **cash reconciliation drill-down**: under "Bank movements", an expandable **"Bank-transfer sales"** list
    with number, time, amount and reference. Its sum must equal the bank-transfer sales line.
- **Existing HASAD references stay exactly as they are:**
  - same fields;
  - `ck_sales_hasad_reference` untouched;
  - same invoice rows;
  - no migration of old data.

  Old BANK_TRANSFER sales recorded before FIX-2 have no reference. They show "—" and are never refused or
  rewritten. An optional `CHECK` constraint would be `NOT VALID` for that reason (Q4).
- **Voids** keep the reference. The void's audit row repeats it.

### API, permissions, route matrix

- **No new route.**
- `POST /sales` body:
  - `paymentRefTransaction` is accepted for `BANK_TRANSFER` (required) as well as HASAD (optional);
  - new optional `confirmDuplicateReference: boolean`.
- `GET /cash/reconciliation` response gains `bankTransferSales: [{ saleId, number, at, amount, reference }]`:
  same route, same `branch` scope and `cash.view`. The cross-branch test of that route covers the new field.
- Field classification: `reference`, `bankTransferSales` and `confirmDuplicateReference` are SAFE (revenue, not cost).
  The cost-visibility test covers the response.

### Idempotency and ledger

- **Ledger unchanged:** BANK_TRANSFER sales already post to the branch **bank** account (`accountKindFor`).
- SPEC §18.10 test extended: for every branch and day, `sum(bankTransferSales.amount)` equals the
  bank-transfer-sales part of `bankLines`.

### i18n keys (new)

- Bank transfer reference
- Enter the bank transfer reference
- The bank transfer reference must be 4 to 40 letters or digits
- This reference is already on sale {number}. Record it anyway?
- Record anyway
- Bank-transfer sales
- Reference
- A reference is recorded only for bank transfer and Hasad payments (replaces the old Hasad-only message)

### Tests

Backend, both projects:

- each of the three methods: the reference is required or refused;
- the length and characters;
- the duplicate refused without confirmation, accepted with it, and audited;
- a void keeps the reference;
- the reconciliation drill-down sums;
- the cost-visibility classification;
- old HASAD sales unaffected.

### REH-1 and e2e

- **REH-1:**
  - a bank sale cannot be completed without a reference;
  - with one, the sale detail shows it;
  - the Cash drill-down lists it, and its sum matches;
  - a second sale with the same reference asks for confirmation.
- **e2e-print:** the A4 invoice and the 72 mm receipt show "Bank transfer reference" for a bank sale and not for a
  cash sale.

---

## 4. REM-4: one entry point for transfers

### Every entry point found today (frontend and server)

| # | Where | What | After REM-4 |
|---|---|---|---|
| 1 | `pages/inventory/InventorySelect.tsx` + the "Select & transfer" view toggle in `pages/inventory/InventoryPages.tsx` (`InventoryPage`) | BM multi-select cards, **Transfer selected** (`transfer-selected`), `TransferDialog`, `send-transfer` | **Removed.** The card view existed only for transferring; the table stays (Q2) |
| 2 | `pages/transfers/TransfersPage.tsx`, `NewTransferDialog` | GM **New transfer** (any branch to any branch) | **Removed** (Q2: or kept as a GM override, see Q2) |
| 3 | `pages/transfers/TransfersPage.tsx`, the BM header button | **Select pieces in Inventory** (navigates) | **Removed.** Its empty text points to the POS cart: "No transfers yet. Send pieces from the POS cart." (the §8 text that was waiting for FIX-1) |
| 4 | `pages/pos/PosPage.tsx` | — | **The one entry:** "Transfer to branch" below "Complete sale" (FIX-1) |
| 5 | Item detail (`InventoryPages.tsx` `ItemDetailPage`) | Mark damaged / Restock / **Return to supplier** (not a transfer) | Unchanged. Not a branch transfer |
| 6 | GM home attention row "Transfers in transit"; notifications (`/notifications`, kind TRANSFER) | Links to the **log** | Unchanged. They lead to the log, not to creation |
| 7 | Server `POST /api/transfers` | The only creation API (used by #1, #2, #4) | Kept; the POS is its only caller |

Searched for other paths and found none:

- no per-item transfer button exists;
- no other route creates `TRANSFER_OUT`;
- the dev sample (`backend/src/dev/sample-cli.ts`) calls the service directly to seed one transfer: a dev tool,
  unchanged.

### Permissions, API, ledger

- No permission change.
- No route change.
- No ledger change.
- If the owner drops the GM's dialog (Q2), the GM still has `inventory.transfer`, needed for the log and for
  confirming receipt on behalf of a branch. The API keeps accepting a GM transfer; there is just no screen for it.

### Tests

- REH-1 asserts the old test ids are gone: `transfer-selected` and `inventory-cards` on Inventory, "New transfer"
  on Transfers.
- e2e-states sweep unchanged.
- The capture script's Transfers screen stays.

---

## 5. SEC-2: void re-confirmation above an amount; a reason for price changes

### Current behaviour

- **Void.** `POST /sales/:id/void` (`sales.void`; the branch manager and the GM).
  - Requires a reason.
  - Not re-confirmed (no `reauth` in the route matrix).
  - `modules/sales/service.ts` `voidSale`: the reason is stored on the sale and in `SALE_CANCELLED`.
- **Price at sale time.** In the POS, a line discount (amount, capped by `sales.maxDiscountPercentByRole`, permission
  `sales.discount`). **No reason** is asked.
- **Item price edit.** `POST /inventory/items/:id/price` (`inventory.price_edit`): the reason is optional (`default('')`).

### Proposed behaviour

- **Void above an amount.**
  - New setting **`sales.voidReauthAboveAmount`**: money, integer ≥ 0, in the company currency.
    - Default: **2,000,000** (Q6).
    - **Where it lives:** the settings registry (`shared/src/settings.ts`), shown in **Settings › Business rules**.
    - **Who can edit it:** the General Manager only (`settings.manage`). The settings save already needs a password
      re-confirmation, and every change is audited (`SETTINGS_CHANGED` and `settings_history`).
  - **Rule:** a void of a sale whose **total is above** the amount needs a **recent re-confirmation**, the same
    window and dialog as everywhere else (`requireRecentReauth`, `security.reauthWindowMinutes`; password, plus
    passkey where the role requires it).
    - Below or equal: unchanged.
    - **0 = every void** asks.
  - **How:**
    - The route handler reads the sale's total and calls `requireRecentReauth` before the service. This is the same
      pattern as the user-role change in `routes.ts` (`PATCH /users/:id`).
    - The refusal is `403 REAUTH_REQUIRED`. The POS and the sale detail already open `ReauthDialog` and retry with
      the same idempotency key (claimed inside the transaction, so the refusal consumes none).
    - The audit row records `reauthenticated: true` and the threshold.
- **Price change at sale time.**
  - When any cart line has a discount, the POS asks for **one reason for the price changes** (required, 3–200
    characters) before "Complete sale".
  - The server refuses a discounted sale without `priceChangeReason`.
  - The reason is stored **only in the audit log**: the `SALE_CREATED` metadata and description, plus a separate
    `SALE_PRICE_CHANGED` entry listing each line's code, list price, discount and final price.
  - The sale's internal detail (managers) shows it from the audit log.
- **Never on customer printouts.** The print endpoints never read the audit log. Tests prove the reason text appears
  in neither the print payload nor the rendered A4 or receipt.
- **Item price edit** (`inventory.price_edit`): the reason becomes **required** (3–500 characters), as BACKLOG SEC-2
  says (Q7).

### API, permissions, route matrix

- `POST /sales/:id/void`: the rule is unchanged (static `reauth` stays false; the re-confirmation is conditional in
  the handler). The generated matrix tests cover allow, deny and cross-branch as today.
- **New explicit tests:**
  - above the threshold without re-confirmation: 403 `REAUTH_REQUIRED`;
  - with re-confirmation: 200;
  - below: 200 without it;
  - a cross-branch void: still 403 before any re-confirmation check;
  - an idempotent replay after re-confirmation returns the same result.
- `POST /sales` body gains `priceChangeReason` (`zText(200)`); it is required when any `discount > 0`.
- `POST /inventory/items/:id/price`: `reason` is required.

### Idempotency and ledger

- Voids still post their reversal exactly as today; SPEC §18.10 unchanged.
- Discounts are unchanged in amount.
- No ledger change.

### i18n keys (new)

- Confirm with your password to cancel a sale above {amount}
- Re-confirm voids above (amount)
- Every void above this total asks for the password again. 0 = every void.
- Reason for the price change
- Give a reason for the discount
- A reason is required for a price change
- Price changed at sale: {lines}

### Tests

Backend, both projects:

- the threshold: above, below, 0, the window expiring;
- the setting is GM-only and audited;
- a discounted sale needs a reason;
- the audit holds it;
- the print payload and the documents do not hold it;
- the item price edit needs a reason.

### REH-1 and e2e

- **REH-1:**
  - the GM sets the threshold to 0;
  - the branch manager voids a sale, the re-confirmation dialog appears, then the void succeeds;
  - a discounted POS sale asks for a reason, and the audit log shows it.
- **e2e-print:** a discounted receipt and A4 invoice never contain the reason.

---

## 6. Commit sequence

Suite green after each commit; push after each; REH-1 and the e2e scripts where noted.

| # | Commit | Extra checks |
|---|---|---|
| 1 | **LOCK-1**: lock note on the sign-in page after a confirmed "This wasn't me"; the managers' "account security-locked" notice first in the order; Users badge; `/auth/me.lockedAccounts` | e2e-passkeys (lock path), e2e-states, REH-1 |
| 2 | **SEC-2**: `sales.voidReauthAboveAmount` setting and conditional re-confirmation; price-change reason (POS and server); item price reason required | REH-1, e2e-print |
| 3 | **FIX-2**: bank reference (POS, server validation, duplicates, invoice, sale detail and list, reconciliation drill-down) [+ migration 0017 `CHECK`, if Q4 yes] | e2e-print, REH-1 |
| 4 | **FIX-1**: "Transfer to branch" in the BM's POS cart [+ `transfers.courier_name` in the same or the next migration, if Q3 yes]; Transfers shows the courier | REH-1, e2e-states |
| 5 | **REM-4**: remove the Inventory card view and transfer bar, the Transfers "New transfer" dialog (Q2) and the BM's "Select pieces" button; §8 empty text | REH-1, e2e-states |
| 6 | **Docs and evidence**: decisions, `docs/acceptance/POS-FIXES.md`, BACKLOG (four items DONE), SPEC §8 note, the slim screen set (POS, Cash, Transfers, sign-in) | all gates |

## 7. Docs

- **`docs/decisions.md` §19:**
  - D-fix-1: transfer from the POS cart, the courier, one entry;
  - D-fix-2: the bank reference, the column choice, duplicates, the drill-down;
  - D-rem4-1: the entry points removed;
  - D-sec2-1: the void threshold (setting, default, editor);
  - D-sec2-2: the price-change reason, audit only;
  - D-lock-1: lock visibility.
- **`docs/acceptance/POS-FIXES.md`:** engineering's runs, plus a Codespace checklist (BM transfer from the cart,
  cashier without the button, bank reference and drill-down, void above and below the threshold, discount reason
  not on the receipt, lock note).
- **BACKLOG:** the four items DONE with commits; REM-4's sub-question answered.
- **SPEC §8:** "courier's name" recorded.
- **DEPLOYMENT:** a note if a migration is added (backup before upgrading).

## 8. Risks

- **The POS changes in three commits** (2, 3, 4). Mitigations:
  - every POS test id is kept;
  - REH-1 and e2e-print run after each;
  - the visual redesign of the POS remains UI-C1 (built on these behaviours, so styled once).
- **A sale above the threshold voided at a busy counter** now needs a password. Mitigations: the window (default
  5 minutes, `security.reauthWindowMinutes`, 1–30) covers several voids; the GM can tune both.
- **The duplicate-reference check** could annoy if references repeat legitimately (two sales paid by one
  transfer). Mitigation: it warns and accepts with confirmation, and it is audited.
- **Removing the GM's transfer dialog** leaves the GM without a way to move stock urgently (Q2).
- **Old BANK_TRANSFER sales** have no reference: a `CHECK` must be `NOT VALID`, and reports show "—".
- **A migration (if Q3/Q4 yes)** must pass `check:migrations`, `check:drizzle` and the upgrade test; it is additive
  only (one nullable column, one `NOT VALID` check).

## 9. Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | Order after LOCK-1: "account security-locked" (managers) first, then "new sign-in to your account"? | **Yes**: your rule says the security-lock notice comes first; both in the strongest style |
| Q2 | REM-4: the GM's "New transfer" dialog on the Transfers page: drop it, or keep it as an out-of-the-way GM override (password plus reason, audited)? | **Drop it.** One entry point; the GM has no POS by design; an urgent move can be made by the branch manager. Revisit if the owner ever needs it |
| Q3 | Courier's name: a new nullable column `transfers.courier_name` (shown and searchable in the log), or only inside the note and the audit log (no schema change)? | **Column.** It is an operational fact that the log should show; additive migration |
| Q4 | Bank reference: add a database `CHECK` ("bank transfer ⇒ reference"), `NOT VALID` so old sales stay, like Hasad's? | **Yes**, same migration as Q3: defence in depth, matches the Hasad rule |
| Q5 | Bank reference format: 4–40 characters, letters, digits, space, `- / .`? Duplicates in the same branch: warn and allow with confirmation (audited)? | **Yes** to both |
| Q6 | Void re-confirmation default amount: 2,000,000 (about one larger piece), GM-editable in Settings › Business rules? | **2,000,000** |
| Q7 | Also make the reason **required** when a manager edits a piece's selling price on the item page (BACKLOG SEC-2), not only for discounts at sale time? | **Yes** |
| Q8 | Price-change reason: one reason per sale (covering all discounted lines), stored in the audit log only, shown to managers on the sale detail? | **Yes**; one reason keeps the counter fast |
