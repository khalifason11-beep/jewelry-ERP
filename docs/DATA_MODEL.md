# Prototype Data Model

Source of truth: [`database/src/schema.ts`](../database/src/schema.ts) (Drizzle). SQL migrations are in
`database/migrations/`. This is a **prototype** model designed around the requirements. Items marked ⚙
are expected to evolve once the client confirms accounting rules.

## Conventions
- Weights: integer **milligrams** (`*_mg`). Money: integer **SDG** (`bigint`).
- Every transaction has a human-readable number: `KRT-INV-000123`, `OMD-PO-…`, `BHR-EXP-…`,
  `KRT-HR-…` (Hasad redemption), `KRT-SET-…` (settlement), `CO-TRF-…` (transfer). They are allocated
  atomically from `document_sequences`.
- Timestamps are `timestamptz`. "Today" is computed in the company timezone (Africa/Khartoum).

## Entities

```
branches ─┬─< users >── roles ──< role_permissions >── permissions
          │     └──< sessions
          ├─< jewelry_items >── products >── categories
          │        ├──< item_status_history      (lifecycle)
          │        └──< inventory_movements      (ledger)
          ├─< purchases ──< purchase_items >── jewelry_items
          ├─< sales ──< sale_items >── jewelry_items
          ├─< expenses
          ├─< transfers (from/to) ──< transfer_items >── jewelry_items
          ├─< hasad_withdrawals ──< hasad_redemptions ──< hasad_redemption_items >── jewelry_items
          │                                   └──< settlements
          └─< audit_logs
settings, gold_rates, document_sequences, suppliers
hasad_mock.* (customers, withdrawals, api_calls). Belongs to the mock only.
```

| Table | Purpose |
|---|---|
| `branches` | Unlimited branches; `hasad_branch_code` maps Hasad's branch identifiers |
| `roles`, `permissions`, `role_permissions` | Data-driven RBAC; `rank` prevents managing higher roles |
| `users` | scrypt `password_hash`, `must_change_password`, `status`, branch assignment |
| `sessions` | Server-side sessions (token hash only), device, IP, current module, status |
| `products` / `categories` | Designs/models; physical pieces live in `jewelry_items` |
| `jewelry_items` | One row per piece: code, barcode, karat, gross/net weight, **purchase / making / other cost** ⚙, total cost, selling price, branch, status, reservation |
| `item_status_history` | Every status transition with reference document, user, note |
| `inventory_movements` | Ledger: type, direction (±1), branch, from/to branch, reference, user, weight, cost value |
| `purchases`, `purchase_items` | Stock receipts; each line creates one item |
| `sales`, `sale_items` | Invoice header and lines with **price, discount and cost snapshots** (historical profit never changes) |
| `expenses` | Category, amount, date, status (APPROVED / PENDING / REJECTED), reviewer |
| `transfers`, `transfer_items` | Two-step transfers (IN_TRANSIT → RECEIVED) |
| `hasad_withdrawals` | ERP mirror of Hasad requests; **never linked to an item** |
| `hasad_redemptions` | A counter visit: DRAFT → COMPLETED / ABORTED, weights, difference, settlement |
| `hasad_redemption_items` | Pieces the customer chose (one or more); `active=false` when released |
| `settlements` | Money paid to / collected from the customer for the weight difference |
| `gold_rates` | Rate history per karat; latest row is current |
| `settings` | JSON settings (see ARCHITECTURE §6) |
| `audit_logs` | Append-only: time, user, role, branch, action, entity, description, metadata, IP, session |

## Traceability

Any number on a dashboard can be traced to rows:
- **Sales KPI** → `sales` (status COMPLETED) → `sale_items` → `jewelry_items` → `item_status_history`.
- **Stock figures** → `inventory_movements` (summed with `direction`). The movement report
  reconciles the ledger closing balance with the live count of AVAILABLE + RESERVED items.
- **Hasad** → `hasad_withdrawals` → `hasad_redemptions` → `hasad_redemption_items` → items, and
  `settlements`. The audit log links everything by withdrawal ID.

## Item lifecycle

```
PURCHASED → RECEIVED → AVAILABLE ─┬→ SOLD ──(void)──→ AVAILABLE
                                  ├→ RESERVED ─┬→ REDEEMED        (Hasad completed)
                                  │            └→ AVAILABLE       (released / aborted / timeout)
                                  ├→ TRANSFERRED → AVAILABLE      (at destination)
                                  ├→ DAMAGED ─┬→ AVAILABLE        (restock)
                                  │           └→ RETURNED         (to supplier)
                                  └→ RETURNED                     (to supplier)
```
All transitions go through one guarded function (`changeStatus`), which uses a conditional update
`WHERE status IN (...)` so two cashiers can never sell or reserve the same piece.
