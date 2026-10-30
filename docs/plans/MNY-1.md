# MNY-1: money transfers between branches and to the General Manager (revised plan; questions answered, waiting for approval)

BACKLOG MNY-1, owner decision Q-8 / D-dec1-6 (2026-10-18). First plan `afd3679` (2026-10-30); **revised after the
owner's decisions of 2026-10-30 (§0)**. This item moves money: **no code before the owner's written approval of this
revised plan.** Branch `claude/mny-1-v2` from `origin/main` `bb07f50` (OPN-3 merged); the first plan's branch
`claude/mny-1` is left as it was (no history rewrite). Migration **0038** (0037 is OPN-3).

## 0. Owner decisions (2026-10-30) and what they changed

1. **Flow.** The sending branch manager enters the amount sent and a **required written reason** (3–300 characters:
   an advance or anything else; company money moving inside the company). The receiving side only **confirms** that it
   received that amount. No counted amount at confirmation, no courier step. Disagreements are settled **outside** the
   system.
2. **Removed:** the DISPUTED and RESOLVED states, the resolve route, `money_transfers.resolve`, the resolution options
   A–D, attention "different amount", the loss event type, everything about a counted amount ≠ the sent amount.
   Statuses: **IN_TRANSIT, RECEIVED, CANCELLED**. Event kinds: **SENT, RECEIVED, CANCELLED**.
3. **Not confirmed → stays IN_TRANSIT** (the money stays in the sending branch's FUNDS_IN_TRANSIT). The only other way
   out is a **cancel by the sending branch manager** (reason required), which returns the money to the account it left.
   **Wrong amount (owner's procedure):** both sides agree outside the system; the sender cancels and sends a new
   transfer with the right amount. Written in the acceptance script and in DEPLOYMENT.
4. **Roles.** Branch managers send, confirm and cancel, own branch only (send and cancel as the sender, confirm as the
   receiver). The **General Manager only views** every transfer: he does not send, does not confirm on a branch's
   behalf, does not cancel. Cashiers: nothing, 403 everywhere. Permissions: `money_transfers.view`,
   `money_transfers.send`, `money_transfers.receive`. `GM_ONLY_PERMISSIONS` unchanged.
5. **Branch → General Manager** stays: the sender chooses "to the General Manager", the amount and the reason; the
   **General Manager confirms** it himself (he is the receiver). The money leaves the branch's books on confirmation.
   **`OWED_TO_GM` is never touched** by money transfers (the funding advance/repayment screens stay as they are). The
   General Manager may confirm **only** transfers addressed to him, never one addressed to a branch.
6. **No limits** per transfer or per day; the only limit is the drawer rule (409 DRAWER_SHORT, never below zero).
7. **No re-auth** on any step. Nothing new with `reauth` in the route matrix (UX-3 rule kept: anything that could ask
   is declared; nothing here asks).
8. Deactivating a branch with money in transit is **refused**. A **bank reference** (FIX-2 rules) is required when
   money leaves or lands in BANK. Attention: **A18** "waiting for you to confirm" (to the receiver) and **A19** "waiting
   more than 24 hours" (to the receiving branch manager and the General Manager).
9. **Screens:** Cash › Transfers for branch managers (Send money, Waiting for you → Confirm, Sent not yet received →
   Cancel, History); the General Manager sees the list of all transfers read only, and the money in transit per branch
   on the Cash screen. Short Arabic text, UX-2 rules, no technical codes.
10. **Kept:** the ledger entries of send, confirm and cancel (§4), the conservation property test, the lock order, the
    append-only event log, the race tests, the reconciliation lines.

## 1. What exists today (read in the code)

- **Ledger** (`backend/src/modules/ledger/service.ts`): one append-only `ledger_entries` table; every branch has
  `CASH`, `BANK`, `FUNDS_IN_TRANSIT` and `OWED_TO_GM` accounts (created by a trigger on `branches`). A balance is
  `SUM(amount)`, nothing cached; corrections are reversing entries.
- `FUNDS_IN_TRANSIT` exists on every branch but **no code posts to it**; `GET /cash/drawer` already returns
  `fundsInTransit` per branch; the Cash screen does not show it yet.
- **`OWED_TO_GM`** (CSH-2, D-csh-1) is **not money**; a guardrail test (`test/funding.test.ts`) fails if a reader counts
  it as money. This item never posts to it (decision 5).
- **The General Manager has no ledger account**: money handed to him leaves the branch books (as Hasad money, PAY-1).
- **Drawer rule** (D-csh-8): no outflow takes `CASH` below zero (`requireDrawerCovers`, `409 DRAWER_SHORT`, under the
  account lock); the bank only warns (A17).
- **Lock order** (D-csh-4): `lockAccounts` locks a branch's accounts `FOR UPDATE` in ascending `ledger_accounts.id`.
- **Reconciliation:** every ledger event type must have a reconciliation line or a reason to be under "Other"
  (guardrail in `test/ledger.test.ts`).
- **Names taken:** `transfers`, `/transfers`, `inventory.transfer` are the **piece** transfers. Money transfers are
  `money_transfers`, `/money-transfers`, `money_transfers.*`; on screen «تحويل نقدي» (never «تحويل قطع»).
- **The General Manager's role** is defined as every permission in the catalogue (`GENERAL_MANAGER = all`); see §2.

## 2. Data model (migration 0038, additive)

### `money_transfers` (one row per transfer, the lockable head)

| Column | Type | Rule |
|---|---|---|
| `id` | serial | |
| `number` | text unique | per sending branch, e.g. `<code>-MT-000001` (`nextNumber`) |
| `from_branch_id` | int → branches | not null |
| `to_kind` | text | `BRANCH` \| `GM` |
| `to_branch_id` | int → branches | not null when `BRANCH`, null when `GM`; ≠ `from_branch_id` |
| `source_account` | text | `CASH` \| `BANK` |
| `amount` | bigint | whole SDG, > 0 |
| `reason` | text | required, 3–300 characters after trimming (decision 1) |
| `bank_reference` | text | required (FIX-2 rules) when `source_account = BANK`, else null |
| `status` | text | `IN_TRANSIT` \| `RECEIVED` \| `CANCELLED` |
| `created_by`, `created_at`, `session_id`, `idempotency_key` | | the sender |

Trigger: an `UPDATE` may change `status` only, and only `IN_TRANSIT → RECEIVED` or `IN_TRANSIT → CANCELLED`; every
other column is immutable; `DELETE`/`TRUNCATE` refused. CHECKs on `to_kind`/`to_branch_id`, amount > 0, reason length,
the bank reference iff BANK.

### `money_transfer_events` (append-only event log)

| Column | Rule |
|---|---|
| `id`, `transfer_id` → money_transfers | |
| `kind` | `SENT` \| `RECEIVED` \| `CANCELLED` |
| `account` | on `RECEIVED` to a branch: where it landed (`CASH` \| `BANK`); null otherwise |
| `bank_reference` | required when it landed in `BANK` (FIX-2 rules) |
| `reason` | required on `CANCELLED` (3–300) |
| `actor_id`, `session_id`, `idempotency_key`, `at` | who and when |

Append-only (`jerp_forbid_modification`, `jerp_lock_append_only`, `APPEND_ONLY_TABLES`); partial unique indexes: one
`SENT` per transfer, at most one closing event (`RECEIVED` \| `CANCELLED`), so even a bug that skipped the row lock
could not close a transfer twice. Ledger entries of every step point at the transfer (`ref_type = 'money_transfer'`).

### Enums, checks, permissions (same migration)

- `LEDGER_EVENT_TYPES` gains `MONEY_TRANSFER_SENT`, `MONEY_TRANSFER_RECEIVED`, `MONEY_TRANSFER_CANCELLED`,
  `MONEY_TRANSFER_TO_GM`. `ck_ledger_entries_event_type` is replaced by the wider list (DROP then ADD, marked
  `-- allow-destructive: D-mny1-1 widen the event-type CHECK`; no row changes; as PAY-1 and OPN-3 did).
- Permissions (catalogue + Arabic labels in `permission-labels.ts`, granted by the migration):

| Code | Arabic | Branch manager | General Manager | Cashier |
|---|---|---|---|---|
| `money_transfers.view` | عرض التحويلات النقدية | own branch's transfers | all, read only | — |
| `money_transfers.send` | إرسال تحويل نقدي | yes (as the sender) | **no** | — |
| `money_transfers.receive` | تأكيد استلام تحويل نقدي | yes (to own branch) | yes, **only transfers addressed to him** | — |

  **D-mny1-2 (engineering, follows decision 4):** today the General Manager's role is "every permission"; it becomes
  "every permission except `money_transfers.send`" (a short `NOT_FOR_GENERAL_MANAGER` list in
  `shared/src/permissions.ts`, with a test that the seed, the migrations and the defaults never give it to him). The
  services enforce the rest regardless of permissions: send and cancel need the actor's own branch to be the sender;
  confirming a branch transfer needs the actor's own branch to be the receiver; confirming a transfer to the General
  Manager needs the General Manager. `GM_ONLY_PERMISSIONS` is unchanged.
- **Upgrade:** forward-only, additive except the CHECK replacement; no backfill (no transfers exist); upgrade test on
  PGlite and PostgreSQL 16 from 0037 with data; `check:migrations`, `check:drizzle`, `check:docs` pass.

## 3. State machine

```
            send (BM of the sending branch: amount, reason)          confirm (receiver)
   ────────────────────────────────────────────────► IN_TRANSIT ──────────────────────────► RECEIVED
                                                          │
                                                          │ cancel (BM of the sending branch, reason)
                                                          ▼
                                                      CANCELLED
```

| Transition | Who | Condition |
|---|---|---|
| — → `IN_TRANSIT` | branch manager of the sending branch | an active receiving branch ≠ own, or the General Manager; amount whole > 0; reason 3–300; `CASH`: the drawer covers it; `BANK`: a bank reference |
| `IN_TRANSIT` → `RECEIVED` (to a branch) | branch manager of the receiving branch | chooses where it lands (`CASH` \| `BANK`, Q1); `BANK`: a bank reference |
| `IN_TRANSIT` → `RECEIVED` (to the General Manager) | the General Manager | nothing to choose: the money leaves the branch books |
| `IN_TRANSIT` → `CANCELLED` | branch manager of the sending branch | a reason 3–300; any time while in transit |

`RECEIVED` and `CANCELLED` are final. No transition from them (trigger + service). Not confirmed: stays `IN_TRANSIT`
indefinitely (A18, then A19 after 24 hours). Wrong amount: the owner's procedure of §0.3 (cancel, send again).

## 4. Ledger entries per step

`+` = money into the account. `S` = sending branch, `R` = receiving branch, `X` = the amount. Every step sums to zero
over all branches' `CASH + BANK + FUNDS_IN_TRANSIT`, except the one **exit** (a confirmed transfer to the General
Manager). `OWED_TO_GM` is never touched.

| Step | S source (CASH/BANK) | S FUNDS_IN_TRANSIT | R landing (CASH/BANK) | Event type |
|---|---|---|---|---|
| Send (to a branch or to the GM) | −X | +X | | `MONEY_TRANSFER_SENT` |
| Confirm, to a branch | | −X | +X | `MONEY_TRANSFER_RECEIVED` |
| Confirm, to the General Manager | | −X **exit** | | `MONEY_TRANSFER_TO_GM` |
| Cancel | +X (the account it left) | −X | | `MONEY_TRANSFER_CANCELLED` |

The money stays on the **sending** branch until confirmed (its responsibility); each branch's `FUNDS_IN_TRANSIT` = Σ
of its transfers `IN_TRANSIT`, shown on the Cash screen.

**Reconciliation (CASH and BANK lines):** **Money sent** (sends to branches and their cancels, so a cancel offsets its
send on the same line), **To the General Manager** (sends to him and their cancels), **Money received** (confirmed
landings). `FUNDS_IN_TRANSIT` is not a drawer line. The confirmation of a transfer to the General Manager posts on
`FUNDS_IN_TRANSIT` only (the drawer already went down at the send). The guardrail test forces every new event type
into a line (or "not a drawer movement" for `MONEY_TRANSFER_TO_GM`).

## 5. API

| Route | Scope / permission | Idempotency-Key | Re-auth |
|---|---|---|---|
| `GET /money-transfers` (`?branchId&status&direction&page…`) | branch, `money_transfers.view` | — | none |
| `GET /money-transfers/:id` | branch, `money_transfers.view` | — | none |
| `POST /money-transfers` `{ to: { branchId } \| { generalManager: true }, account, amount, reason, bankReference? }` | branch, `money_transfers.send` | required, in the transaction | none |
| `POST /money-transfers/:id/confirm` `{ account?, bankReference? }` (account only for a branch receiver) | branch, `money_transfers.receive` | required, in the transaction | none |
| `POST /money-transfers/:id/cancel` `{ reason }` | branch, `money_transfers.send` | required, in the transaction | none |

- **Scoping:** a branch manager sees transfers where their branch is the sender or the receiver; another branch's
  transfer is `404` (no existence leak); the sending branch is always their own, whatever the body says. The General
  Manager sees all (read only), and confirms only those addressed to him.
- **Errors:** `400` invalid amount / reason / reference, same branch, inactive branch; `403` permission or not this
  branch's role in the transfer (e.g. the General Manager confirming a branch transfer, a receiver cancelling);
  `404` unknown or another branch's; `409 DRAWER_SHORT` (existing, with the amount); `409 MONEY_TRANSFER_STATE` ("This
  transfer is already {status}"); `409 BRANCH_HAS_MONEY_IN_TRANSIT` on deactivating a branch (incoming or outgoing);
  `422` a replayed key with another body (existing).
- Audit: `MONEY_TRANSFER_SENT`, `MONEY_TRANSFER_RECEIVED`, `MONEY_TRANSFER_CANCELLED`, with amount, accounts, both
  sides, the reason and the reference.
- New response fields classified SAFE in `field-classification.ts` (no cost).

## 6. Concurrency

One transaction per step; **lock order: the transfer row `FOR UPDATE`, then every ledger account involved, of both
branches, in ascending `ledger_accounts.id`** (a new `lockAccountsAcross`, the D-csh-4 rule across branches). Send
has no row yet: accounts only.

| Race | What happens |
|---|---|
| Double confirm (two tabs, a retry) | same key: the first answer replayed; another key: waits for the row, sees `RECEIVED` → `409 MONEY_TRANSFER_STATE`; the partial unique index is the last line of defence |
| Confirm vs cancel | the row lock orders them; the loser gets `409`; money moves once |
| Send vs another drawer outflow (scrap purchase, repayment, a second send) | both lock `CASH` of the sending branch; the drawer check runs under the lock; never below zero |
| Send while the drawer is counted | a count reads expected cash in its own transaction (a snapshot); before or after the send, never half |
| A→B and B→A confirmed at once | both lock A's and B's accounts in ascending id: no deadlock |
| Deactivation vs a new send to that branch | deactivation locks the branch row and checks for transfers in transit; a send locks the receiving branch row `FOR SHARE` and checks it is active: one waits for the other |

## 7. Screens (Arabic first, short text)

- **Cash › Transfers** (branch manager): **Send money** (to a branch or to the General Manager; from the drawer or the
  bank; amount; reason; bank reference when from the bank), **Waiting for you** (incoming: amount, from, reason,
  when; **Confirm**, choosing drawer or bank), **Sent, not yet received** (**Cancel** with a reason), **History**.
- **General Manager:** the same list for every branch, read only, plus **Confirm** on transfers addressed to him; the
  Cash screen shows **money in transit** per branch.
- **Attention:** A18 "Money transfer waiting for you to confirm" (the receiving branch manager; the General Manager for
  transfers to him); A19 "Money transfer waiting more than 24 hours" (the receiving branch manager and the General
  Manager). Both link to Cash › Transfers.
- Cashiers: no menu entry, no section.

## 8. Tests

- **Unit / API (PGlite and PostgreSQL):** every transition and every refusal (cashier 403 on every route; the General
  Manager cannot send, cancel or confirm a branch transfer; a receiver cannot cancel; a sender cannot confirm; wrong
  state; same branch; inactive branch; amount ≤ 0 or not whole; reason too short/long; missing bank reference; drawer
  short); ledger entries per step exactly as §4; `OWED_TO_GM` unchanged by every step; audit rows; idempotent replays;
  scoping (no leak); the trigger refuses an amount change and an illegal status change from SQL; branch deactivation
  refused with money in transit; reconciliation lines add up; A18/A19 with a fixed clock (23:59 no, 24:01 yes).
- **Conservation (fast-check):** random sequences of send / confirm / cancel over three branches, both accounts and
  the General Manager: after every step Σ over all branches of `CASH + BANK + FUNDS_IN_TRANSIT` is unchanged except by
  exactly the confirmed transfers to the General Manager; each branch's `FUNDS_IN_TRANSIT` = Σ of its transfers
  `IN_TRANSIT`; no `CASH` ever below zero; `OWED_TO_GM` never changes.
- **Guardrails:** `OWED_TO_GM` never read as money (existing scan extended); every new event type has a reconciliation
  line; the UX-3 audit test passes with nothing new asking; the General Manager never holds `money_transfers.send`.
- **PostgreSQL races (`test/pg/money-transfer-race.test.ts`):** double confirm, confirm vs cancel, send racing a scrap
  purchase on a small drawer, A→B and B→A at once, the same key five times, deactivation vs send.
- **Upgrade test** from 0037 with data; append-only list test.

## 9. REH-1 additions

Branch manager A sends cash to B with a reason (A's drawer drops, A shows money in transit, B's manager sees A18);
B confirms into the drawer (B's drawer rises, transit back to 0); a send from the bank needs its reference; a second
transfer is cancelled by A (money back in A's drawer); the owner's wrong-amount procedure (cancel, send the right
amount, confirm); a transfer to the General Manager confirmed by him (A's transit to 0, `OWED_TO_GM` unchanged); the
General Manager sees every transfer, read only, and cannot confirm a branch transfer (403); a cashier sees no menu and
gets 403 from every route; deactivating a branch with money in transit is refused; the day's reconciliation shows the
new lines and still adds up.

## 10. Docs to update

SPEC (money transfers built), DATA_MODEL (two tables, event types, triggers), DEPLOYMENT (migration 0038, routes,
permissions, error codes, **the owner's wrong-amount procedure**), route matrix, decisions `D-mny1-*`, FEATURES,
README, BACKLOG (MNY-1), `docs/acceptance/MNY-1.md` (with the wrong-amount procedure).

Commits after approval, suite green and pushed after each, REH-1 run before every push: c1 migration + schema +
permissions + upgrade test · c2 ledger service + property and guardrail tests · c3 routes + matrix + API tests +
PostgreSQL races + REH-1 (by API) · c4 screens + attention + REH-1 (screens) · c5 acceptance, docs, `verify --full`.

## 11. Questions for the owner (answered 2026-10-30)

1. **Where a branch receiver's money lands:** the receiving branch manager **chooses the drawer or the bank** when
   confirming (a bank reference when the bank). Owner: agreed.
2. **24 hours:** a **fixed rule** (no setting). Owner: agreed.
3. **Transfers to the General Manager:** he records **nothing** when he confirms; the sender's reason is enough.
   Owner: agreed.

No question is open.
