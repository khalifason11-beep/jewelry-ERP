# MNY-1: money transfers between branches and to the General Manager (plan, stop for approval)

BACKLOG MNY-1, owner decision Q-8 / D-dec1-6 (2026-10-18). **This item moves money: no code before the owner's written
approval of this plan.** Everything not in the spec is a question in §11; nothing below invents a business rule
without marking it **[OPEN]**.

## 1. What exists today (read in the code)

- **Ledger** (`backend/src/modules/ledger/service.ts`, Phase 2b, D-2b-*): one append-only `ledger_entries` table;
  every branch has four accounts (`ledger_accounts`, created by a trigger on `branches`): `CASH` (the drawer),
  `BANK`, `FUNDS_IN_TRANSIT` and `OWED_TO_GM`. A balance is `SUM(amount)`, positive = money into the account; nothing
  is cached; corrections are reversing entries (`reverses_entry_id`, unique: an entry is reversed once).
- `FUNDS_IN_TRANSIT` exists on every branch but **no code posts to it**; `GET /cash/drawer` already returns
  `fundsInTransit` per branch; the Cash screen does not show it yet.
- **`OWED_TO_GM`** (CSH-2, D-csh-1) is **not money**: it is what the branch owes the General Manager for his advances
  (a liability, positive = owed). `GM_ADVANCE` posts `CASH|BANK +X` and `OWED_TO_GM +X`; `GM_REPAYMENT` posts
  `CASH|BANK −X` and `OWED_TO_GM −X`, never more than owed. Every reader of the ledger names its account kind, and a
  guardrail test (`test/funding.test.ts`) fails if one counts `OWED_TO_GM` as money.
- **The General Manager has no ledger account.** Money that leaves a branch to him (Hasad, PAY-1; a repayment) leaves
  the branch books; the system never holds a "GM balance".
- **Drawer rule** (CSH-2, D-csh-8): no outflow takes `CASH` below zero (`requireDrawerCovers`, `409 DRAWER_SHORT`,
  checked under `lockAccounts`); the bank only warns (attention A17).
- **Lock order** (D-csh-4): `lockAccounts` locks a branch's accounts `FOR UPDATE` in ascending `ledger_accounts.id`.
- **Daily reconciliation**: the day's `CASH` and `BANK` entries fall into lines (`RECONCILIATION_LINES`); every event
  type must have a line or a reason to be under "Other" (guardrail test in `test/ledger.test.ts`).
- **Names already taken:** `transfers`, `/transfers`, `inventory.transfer`, `TRANSFER_STATUSES` are the **piece**
  transfers between branches. Money transfers get their own names (`money_transfers`, `/money-transfers`,
  `money_transfers.*`) so the two are never confused, in the code or on screen ("تحويل نقدي" vs "تحويل قطع").
- **Cash counts** (`recordCount`): a count stores the counted amount and the expected cash read in its own
  transaction; there is no "drawer closing" that blocks movements.

## 2. Data model (migration 0037, additive)

### `money_transfers` (one row per transfer)

| Column | Type | Rule |
|---|---|---|
| `id` | serial | |
| `number` | text unique | per sending branch, `KRT-MT-000001` (`nextNumber`) |
| `from_branch_id` | int → branches | not null |
| `to_kind` | text | `BRANCH` \| `GM` |
| `to_branch_id` | int → branches | not null when `BRANCH`, null when `GM`; ≠ `from_branch_id` |
| `source_account` | text | `CASH` \| `BANK` |
| `amount` | bigint | whole SDG, > 0 |
| `bank_reference` | text | **[OPEN] Q8**: required when `source_account = BANK` (FIX-2 rules), as for funding |
| `note` | text | optional, ≤ 300 |
| `status` | text | `IN_TRANSIT` \| `RECEIVED` \| `DISPUTED` \| `RESOLVED` \| `CANCELLED` |
| `created_by`, `created_at`, `session_id`, `idempotency_key` | | who sent |

- **Money fields are immutable:** a trigger refuses any `UPDATE` that changes anything but `status`, and any
  `status` change that is not an allowed transition (§3). `DELETE` is refused (the append-only trigger pattern of
  `jerp_lock_append_only`, with `status` as the one updatable column). The row is the lockable "head" of the transfer
  (`SELECT … FOR UPDATE`, §6); its money never changes.

### `money_transfer_events` (append-only event log)

| Column | Rule |
|---|---|
| `id`, `transfer_id` → money_transfers | |
| `kind` | `SENT` \| `RECEIVED` \| `DISPUTED` \| `RESOLVED` \| `CANCELLED` |
| `amount` | the amount of that step: sent, counted on arrival, or settled |
| `account` | where it landed (`CASH` \| `BANK`) on `RECEIVED` / `RESOLVED`, else null |
| `resolution` | on `RESOLVED` only: the option chosen (§4) |
| `reason` | required on `CANCELLED` and `RESOLVED` (3–300 characters) |
| `bank_reference` | **[OPEN] Q8** on a landing in `BANK` |
| `actor_id`, `session_id`, `idempotency_key`, `at` | who and when |

- Append-only (`jerp_lock_append_only`, listed in `APPEND_ONLY_TABLES`); one `SENT` per transfer; at most one
  `DISPUTED`; at most one closing event (`RECEIVED` \| `RESOLVED` \| `CANCELLED`): partial unique indexes, so even a
  bug that skipped the row lock could not close a transfer twice.
- The ledger entries of every step point at the transfer (`ref_type = 'money_transfer'`, `ref_id`, `ref_number`).

### Enums, checks, permissions (same migration)

- `LEDGER_EVENT_TYPES` gains `MONEY_TRANSFER_SENT`, `MONEY_TRANSFER_RECEIVED`, `MONEY_TRANSFER_CANCELLED`,
  `MONEY_TRANSFER_RESOLVED` (and `MONEY_TRANSFER_TO_GM` if Q1 = B, `MONEY_TRANSFER_LOSS` if Q3 allows D);
  `ck_ledger_entries_event_type` is replaced by the wider list (`-- allow-destructive: D-mny1-x` on the
  `DROP CONSTRAINT`, as PAY-1 did; the new constraint only adds values).
- Permissions (shared catalogue + Arabic names in `permission-labels.ts`, granted by the migration):

| Code | Arabic | Roles |
|---|---|---|
| `money_transfers.view` | عرض التحويلات النقدية | branch manager, General Manager |
| `money_transfers.send` | إرسال تحويل نقدي | branch manager, General Manager |
| `money_transfers.receive` | استلام تحويل نقدي | branch manager, General Manager |
| `money_transfers.resolve` | حسم خلاف في تحويل نقدي | General Manager only (`GM_ONLY_PERMISSIONS`) |

  Cashiers get none: every route answers them 403. The menu shows nothing new to a cashier.
- Migration is forward-only, runs on a database with data (no backfill: there are no money transfers yet), tested by
  the upgrade test on PGlite and PostgreSQL 16; `check:migrations`, `check:drizzle`, `check:docs` pass.

## 3. State machine

```
             send (sender)                    confirm, same amount (receiver)
   ─────────────────────────► IN_TRANSIT ─────────────────────────────────────► RECEIVED
                                  │  │
            cancel (sender or GM) │  │ confirm, different amount (receiver)
            [OPEN] Q4             ▼  ▼
                          CANCELLED  DISPUTED ──── resolve (GM only, reason, re-auth) ───► RESOLVED
```

| Transition | Who | Condition |
|---|---|---|
| — → `IN_TRANSIT` (send) | branch manager **of the sending branch**, or the General Manager (for any branch) | sender ≠ receiver; amount > 0; `CASH` source: the drawer covers it |
| `IN_TRANSIT` → `RECEIVED` | branch manager **of the receiving branch**, or the General Manager; for a transfer to the General Manager: the General Manager only | confirmed amount = sent amount |
| `IN_TRANSIT` → `DISPUTED` | the same receiver | confirmed amount ≠ sent amount (Q2: also when more) |
| `IN_TRANSIT` → `CANCELLED` | **[OPEN] Q4**, proposed: the branch manager of the sending branch, or the General Manager | before any confirmation |
| `DISPUTED` → `RESOLVED` | General Manager only, written reason | one of the options of §4 |

`RECEIVED`, `CANCELLED`, `RESOLVED` are final. Nothing else is allowed (database trigger + service checks). A branch
manager who belongs to both sides cannot exist (one branch per manager).

## 4. Ledger entries per step

Sign: `+` = money into the account. `S` = sending branch, `R` = receiving branch, `X` = sent amount, `Y` = counted
amount on arrival. **Every step's entries sum to zero over all branch money accounts** (CASH + BANK +
FUNDS_IN_TRANSIT), except the explicit exits marked **exit**. `OWED_TO_GM` is never touched unless Q1 = A.

| Step | S source (CASH/BANK) | S FUNDS_IN_TRANSIT | R landing (CASH/BANK) | S OWED_TO_GM | Event type |
|---|---|---|---|---|---|
| Send | −X | +X | | | `MONEY_TRANSFER_SENT` |
| Confirm (branch → branch) | | −X | +X | | `MONEY_TRANSFER_RECEIVED` |
| Dispute (Y ≠ X) | | **nothing** (stays +X) | | | (no entry; event only) |
| Cancel | +X (same account it left) | −X | | | `MONEY_TRANSFER_CANCELLED` |
| Confirm to GM, option A (repayment) | | −X **exit** | | −X | `GM_REPAYMENT`-like `MONEY_TRANSFER_RECEIVED` |
| Confirm to GM, option B (handover) | | −X **exit** | | | `MONEY_TRANSFER_TO_GM` |

`FUNDS_IN_TRANSIT` sits on the **sending** branch: until it is confirmed the money is still the sender's
responsibility; the Cash screen shows it per branch.

**Dispute resolution options (General Manager, reason, re-auth) — for the owner to confirm (Q3):**

| Option | Meaning | S source | S FIT | R landing | Note |
|---|---|---|---|---|---|
| A. "What was sent arrived" | the receiver's count was wrong | | −X | +X | conserves money |
| B. "What was counted arrived; the rest goes back" (only Y < X) | the difference never left the sender | +(X−Y) | −X | +Y | conserves money |
| C. "Nothing arrived; return it all" | as a cancel | +X | −X | | conserves money |
| D. "What was counted arrived; the rest is lost" (only Y < X) | a real loss | | −X | +Y | **exit** of X−Y as `MONEY_TRANSFER_LOSS`, shown in the reconciliation and the reports; needs Q3 (expenses were removed, REM-1: there is no loss account today) |

Y > X ("more arrived than was sent") cannot be credited without creating money: only A or C are offered then
(Q2).

**Branch → General Manager (Q1).** The General Manager confirms; the money lands **outside the branch books** (he
has no account). Two meanings are possible and must not be mixed:
- **A. Repayment of his advances:** confirmation lowers `OWED_TO_GM` by X (as a repayment), refused when X is more
  than the branch owes him (checked at send and again at confirm, under the lock).
- **B. Handover of takings:** the money leaves the branch, `OWED_TO_GM` is untouched (like Hasad money, PAY-1).
- Proposed: the sender chooses A or B when sending (default B), shown on both screens; or the owner picks one only.

**Reconciliation:** `CASH` and `BANK` get two lines, **Money sent** (send and cancel, so a cancel offsets its send
on the same line) and **Money received** (confirm and resolution landings), and **To the General Manager** for the
exits (if any). `FUNDS_IN_TRANSIT` and `OWED_TO_GM` are not drawer lines. Expected cash stays `SUM(CASH)`: a send
lowers it at once, a confirm into `CASH` raises the receiver's. The guardrail test forces every new event type into a
line.

## 5. API

| Route | Scope / permission | Idempotency | Re-auth (proposal, Q5) |
|---|---|---|---|
| `GET /money-transfers` (`?branchId&status&direction&page…`) | branch, `money_transfers.view` | — | — |
| `GET /money-transfers/:id` | branch, `money_transfers.view` | — | — |
| `POST /money-transfers` (send) `{ fromBranchId?, to: { branchId } \| { generalManager: true }, account, amount, note?, bankReference?, purpose? }` | branch, `money_transfers.send` | required, in the transaction | none (Q5) |
| `POST /money-transfers/:id/confirm` `{ amount, account, bankReference? }` | branch, `money_transfers.receive` | required, in the transaction | none (Q5) |
| `POST /money-transfers/:id/cancel` `{ reason }` | branch, `money_transfers.send` | required, in the transaction | none (Q4/Q5) |
| `POST /money-transfers/:id/resolve` `{ resolution, reason, account? }` | global, `money_transfers.resolve` | required, in the transaction | **`reauth: true`** |

- **Branch scoping:** a branch manager sees and acts on transfers where their branch is the sender (send, cancel) or
  the receiver (confirm); never a transfer to the General Manager they did not send; another branch's transfer is
  `404` (no existence leak). The General Manager sees all. A branch manager's `fromBranchId` is their own branch,
  whatever the body says.
- A threshold for re-auth on large sends (Q5) would be a `reauthWhen` route, declared in the matrix (UX-3: the tests
  fail otherwise).
- **Errors:** `400` invalid amount, same branch, inactive branch, missing reference; `403` permission / not this
  branch's transfer; `404` unknown or other branch's; `409 DRAWER_SHORT` (new sentence "The drawer holds {balance}:
  sending {amount} needs {short} more"); `409 MONEY_TRANSFER_STATE` ("This transfer is already {status}"); `409
  MONEY_TRANSFER_OWED_EXCEEDED` (Q1 = A); `422` replayed key with another body (existing idempotency rule).
- Every step writes one audit row (`MONEY_TRANSFER_SENT`, `_RECEIVED`, `_DISPUTED`, `_RESOLVED`, `_CANCELLED`) with
  the amounts, accounts, both branches and the reason.
- New response fields classified in `field-classification.ts` (SAFE: none is a cost).

## 6. Concurrency

One transaction per step; **lock order: the transfer row (`FOR UPDATE`), then every ledger account involved, of both
branches, in ascending `ledger_accounts.id`** (a new `lockAccountsAcross(tx, [{branchId, kind}…])`, the D-csh-4 rule
extended across branches). Send has no transfer row yet: accounts only.

| Race | What happens |
|---|---|
| Double confirm (two tabs, two managers, a retry) | same key: replay of the first answer; different keys: the second waits for the row lock, then sees `RECEIVED` → `409 MONEY_TRANSFER_STATE`; the partial unique index is the last line of defence |
| Confirm vs cancel | the row lock orders them; the loser gets `409`; money moves once |
| Confirm vs dispute vs resolve | same row lock; a resolve only from `DISPUTED` |
| Send vs another drawer outflow (scrap purchase, void refund, repayment, a second send) | both lock `CASH` of the sending branch; the drawer check runs under the lock; the drawer never goes below zero |
| Send while the drawer is being counted | a count reads the expected cash in its own transaction (a snapshot, no lock); it shows the drawer before or after the send, never half; the day's reconciliation later shows the send as a line. No "closing" exists to block. |
| Two transfers A→B and B→A confirmed at once | both lock accounts of A and B in ascending id: no deadlock |
| Branch deactivated while a transfer is in transit | **[OPEN] Q7** (proposed: deactivation refused while it has transfers in transit) |

## 7. Screens (Arabic first, short text)

- **Cash › Transfers** (new section): **Send money** (branch, CASH or BANK, amount, note; to a branch or to the
  General Manager), **Waiting for you** (incoming to confirm: amount, from, when; Confirm with the amount counted and
  where it lands), **Sent, not yet received** (with Cancel if Q4 allows), **History**. Disputed transfers show
  "Different amount: waiting for the General Manager" (and Resolve for him).
- **Money in transit** per branch on the Cash screen (the existing `fundsInTransit`).
- **Attention**: A18 "Money transfer waiting for you to confirm" (branch manager: to their branch; General Manager:
  to him); A19 "Money transfer with a different amount" (General Manager). Both link to Cash › Transfers.
- Branch names come from data; nothing client-specific.

## 8. Tests

- **Unit / API (PGlite and PostgreSQL):** every transition and its refusal (wrong role, wrong branch, wrong state,
  same branch, amount ≤ 0 or not whole, drawer short, cashier 403 on every route); ledger entries per step exactly as
  §4; audit rows; idempotent replays; branch scoping (no leak); the trigger refuses an amount change and an illegal
  status change even from SQL; reconciliation lines add up with transfers.
- **Conservation (fast-check):** random sequences of send / confirm / dispute / resolve / cancel over three branches
  and both accounts: after every step the sum of `CASH + BANK + FUNDS_IN_TRANSIT` over all branches is unchanged,
  except by exactly the amounts of the exits (to the General Manager; loss if allowed); each branch's
  `FUNDS_IN_TRANSIT` = Σ of its transfers `IN_TRANSIT` or `DISPUTED`; a dispute leaves the money in transit; no
  `CASH` ever below zero; `OWED_TO_GM` unchanged (unless Q1 = A, then by exactly the repayments).
- **Guardrails:** OWED_TO_GM is never read as money (existing scan extended to the new reads); every new event type
  has a reconciliation line; the route matrix declares the re-auth route (UX-3).
- **PostgreSQL race tests (`test/pg/money-transfer-race.test.ts`):** double confirm, confirm vs cancel, resolve
  twice, send racing a scrap purchase on a small drawer, A→B and B→A at once (no deadlock), the same key five times.
- **Upgrade test** from 0036 with data; append-only list test.

## 9. REH-1 additions

Branch manager of A sends cash to B (drawer drops, A shows money in transit, B's manager sees A18 and the incoming
transfer); B confirms into the drawer (both balances, transit back to 0); a second transfer confirmed with a different
amount → disputed, money still in transit; the General Manager resolves it (re-auth, reason) with the agreed option;
a transfer to the General Manager confirmed by him; a cancel (if allowed); a cashier sees no transfers and gets 403
from every route; the reconciliation of the day shows the new lines and still adds up.

## 10. Docs to update

SPEC (§ money: transfers built), DATA_MODEL (two tables, event types, triggers), DEPLOYMENT (migration 0037, routes,
permissions, error codes), the route matrix (it is the API reference), decisions `D-mny1-*`, FEATURES, README (the
protected actions list), BACKLOG (MNY-1 status), `docs/acceptance/MNY-1.md`.

Commits after approval: c1 migration + schema + permissions + upgrade test · c2 ledger service + tests (property,
guardrails) · c3 routes + matrix + API tests + PostgreSQL races · c4 screens + attention + REH-1 · c5 acceptance,
docs, `verify --full`.

## 11. Questions for the owner

1. **Branch → General Manager:** is the money (A) a **repayment** of his advances (lowers what the branch owes him,
   never more than owed), (B) a **handover** of takings that leaves the branch books (what it owes him unchanged), or
   (C) the sender chooses each time? (Proposed: C, default B.)
2. **A different amount:** a receiver who counts **more** than was sent: also DISPUTED (proposed yes), and then only
   options A and C of §4 (proposed)?
3. **Dispute resolution options:** confirm A, B, C; and is **D (a real loss)** allowed? If so it is a new kind of
   exit shown in the reports (there is no loss or expense account today, REM-1).
4. **[OPEN] Cancel:** who may cancel a transfer still in transit (proposed: the sending branch manager or the General
   Manager), with a reason; may the **receiver** refuse it instead of confirming (proposed: no; they confirm 0 → it
   becomes disputed)?
5. **Re-auth:** none for sending, confirming and cancelling by a manager; re-auth for resolving (proposed). Should a
   send above an amount ask for re-auth (a setting like `sales.voidReauthAboveAmount`)? Should the General Manager's
   own sends ask, as his funding writes do?
6. **Who confirms a transfer to a branch:** the branch manager of that branch **or** the General Manager (spec). May
   the General Manager confirm on the branch's behalf without being there (proposed yes, audited as him)?
7. **Deactivating a branch** with money in transit: refuse (proposed) or allow?
8. **Bank references:** required when money leaves or lands in the bank, as for funding (proposed yes, FIX-2 rules)?
9. **A transfer waiting too long:** an attention item after N hours (as piece transfers have), and N?
10. **Limits:** any maximum per transfer or per day? (Proposed none; the drawer rule is the only limit.)
