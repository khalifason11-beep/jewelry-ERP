# Jewelry ERP Prototype — Architecture & Plan

> Status: **client-demo prototype, all phases below implemented.** The first milestone
> (login → POS sale → Hasad redemption → dashboards → audit) is covered by automated end-to-end
> tests in `backend/test/flow.test.ts`.
>
> No connection to any real server, database, or the real
> Hasad Gold system. All data is demo data; Hasad Gold is simulated by a mock service that
> sits behind the same interface the real integration will implement.

## 1. Environment findings

| Item | Finding | Decision |
|------|---------|----------|
| Repository | Empty | Greenfield monorepo (npm workspaces) |
| Node.js | v22 | TypeScript everywhere, run with `tsx` (no build step for backend) |
| PostgreSQL | Server binaries available, but a presenter's laptop may not have one | Drizzle ORM with **two drivers**: real PostgreSQL when `DATABASE_URL` is set, otherwise **PGlite** (real Postgres compiled to WASM, embedded, file-backed). Same schema, same SQL, same migrations. |

## 2. Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | React 19 + TypeScript + Vite | Standard, fast, easy to hire for |
| Styling | Tailwind CSS v4 + an in-house component kit | Full control over a premium ERP look; no generic dashboard template feel |
| Data fetching | TanStack Query | Caching, loading/error states, invalidation after mutations |
| Charts | Recharts | Mature React charting |
| Backend | Node.js + Express 5 + TypeScript + Zod | Simple, well-known, validation at the edge |
| Database | PostgreSQL (or embedded PGlite) + Drizzle ORM | Typed schema, SQL-first, generated migrations |
| Auth | Server-side sessions (opaque token in `httpOnly` cookie), passwords hashed with `scrypt` | Server-side sessions are required anyway for *Active Sessions* monitoring and revocation |
| Tests | Vitest | Business-logic and end-to-end API flow tests against an in-memory PGlite |

## 3. Repository layout

```
/shared                 Domain enums, permission catalogue, role defaults, pure business
                        rules (settlement calculation, money/weight helpers), API DTO types.
                        Used by backend AND frontend so rules never drift.
/database               Drizzle schema, DB client factory (Postgres | PGlite), migrations.
/integrations/hasad     HasadService interface + MockHasadService (+ its own isolated tables).
                        The rest of the app only sees the interface.
/backend                Express API.
  src/core              config, errors, request context, audit writer
  src/auth              password hashing, sessions, login/logout, middleware
  src/authz             permission checks + branch scoping (data isolation)
  src/modules/*         one folder per business module: service.ts (business logic,
                        DB access) + routes.ts (HTTP + validation only)
  src/seed              deterministic demo data generator
/frontend               React SPA (pages, components, i18n, API client)
/docs                   Architecture, data model, demo script, assumptions
```

Separation of concerns:

* **UI** (`frontend`) never decides access — it hides what the API would reject anyway.
* **Business logic** lives in `backend/src/modules/*/service.ts`; routes are thin.
* **Authorization** — every service function receives the `Actor` and calls
  `authz.require(...)` and `authz.branchScope(...)`. A cashier asking the API for another
  branch's data gets **403**, not an empty UI.
* **Hasad integration** is only reachable via `HasadService`. Swapping the mock for the real
  API is a one-line change in `backend/src/integrations.ts`.
* **Reporting** is a dedicated module that only reads.

## 4. Core domain rules

### Item-based inventory
Every piece is a row in `jewelry_items` with a unique code (`J-1001`) and barcode.
Status is one of `AVAILABLE, RESERVED, SOLD, REDEEMED, TRANSFERRED, DAMAGED, RETURNED`.
Every status change writes `item_status_history`; every stock change writes
`inventory_movements` (the ledger). Branch stock figures (opening, movements, closing) are
**derived from the ledger**, and the report shows a reconciliation check against the live
item statuses.

Ledger movement types and their effect on a branch's sellable stock:

| Type | Effect |
|------|--------|
| PURCHASE | +1 |
| TRANSFER_IN | +1 |
| RETURN | +1 |
| SALE | −1 |
| HASAD_REDEMPTION | −1 |
| TRANSFER_OUT | −1 |
| DAMAGE | −1 |
| ADJUSTMENT | ±1 (explicit direction) |

### Hasad Gold withdrawals
1. Hasad sends a withdrawal (`READY_FOR_PICKUP`) with an **entitled weight** and branch.
   → The ERP stores it. **No item is reserved. Inventory is unchanged.**
2. Customer arrives, cashier opens the request (`HASAD_WITHDRAWAL_OPENED`).
3. Customer picks a real piece → **that** item becomes `RESERVED` (one or more items).
4. System calculates `difference = delivered − entitled`:
   * `< 0` → **Branch pays customer** `|diff| × rate`
   * `> 0` → **Customer pays branch** `diff × rate`
   * `= 0` → no settlement
5. Cashier confirms the settlement (explicit customer-acknowledgement step).
6. Complete → item `REDEEMED`, ledger `HASAD_REDEMPTION`, settlement recorded, Hasad notified.
7. Abort → items `RESERVED → AVAILABLE`; request stays open. Cancel → request cancelled in Hasad.
8. Stale reservations are automatically released after a configurable timeout.

### Profit
`Gross profit = Σ(sale price after discount) − Σ(item total cost)`;
`Branch contribution = Gross profit − approved branch expenses`.
`Total cost = purchase cost + making cost + other cost` — each component is stored
separately so the client can later redefine "cost" without a data migration.
Hasad redemptions are reported **separately** (weight, item cost, settlements) because revenue
recognition for Hasad is not yet defined by the client.

## 5. Roles & data isolation

Roles live in the database (`roles`, `role_permissions`) — new roles need no code change.
Permissions are fine-grained (`sales.create`, `inventory.price_edit`, …). Branch scope is
itself a permission (`scope.all_branches`), only granted to the General Manager by default.

## 6. Configurable (not hard-coded)

Stored in the `settings` table / `gold_rates` table and editable by the General Manager:

* Gold price per gram per karat (used for Hasad weight-difference settlement & display)
* Hasad settlement basis: *net weight* (default, per spec) or *pure-gold equivalent*
* Hasad reservation timeout (minutes)
* Maximum discount % per role
* Expense approval threshold (expenses above it need GM approval)
* Session idle / expiry timeouts
* Self-service password change (disabled by default — centralized password control)
* Business timezone (Africa/Khartoum), currency (SDG)
* Mock Hasad: latency, simulated outage (to demonstrate error handling)

## 7. Assumptions (to validate with the client)

1. Hasad entitlements are expressed in grams comparable to the jewelry **net gold weight**.
   A pure-gold-equivalent mode exists as a setting in case karat conversion is required.
2. The weight difference is valued at the **current gold rate for the selected item's karat**.
3. No making charge is applied to Hasad redemptions (open question for the client).
4. A Hasad customer may take **one or more** pieces to consume their entitlement.
5. Normal sale carts do not reserve items; the sale is validated atomically at completion
   (prevents double-selling across cashiers without locking stock while browsing).
6. Held carts are stored per user on the device (prototype simplification).
7. Transfers are two-step (sent → received); in-transit items show status `TRANSFERRED`.
8. Currency is SDG, integer amounts. Weights are stored as integer milligrams.

## 8. Implementation plan (phases)

1. **Foundation** — monorepo, shared domain, DB schema/migrations, auth & sessions.
2. **Vertical slice** — login → POS sale → Hasad redemption → dashboards → audit (end-to-end test).
3. **Management** — purchases, expenses, transfers, users & password management, sessions.
4. **Reporting** — 10 reports with filters/sort/search, drill-down company → branch → txn → item.
5. **Polish** — Arabic/RTL, empty/loading/error states, print invoice, demo tooling, docs.

## 9. Moving to production (out of scope now)

* Replace `MockHasadService` with `HttpHasadService` (same interface) + webhook endpoint with
  signature verification, idempotency keys and retry queue.
* Managed PostgreSQL, backups, row-level security as defence in depth.
* SSO / MFA, rate limiting on login, CSRF tokens if the API is used cross-site.
* Real barcode scanner & receipt printer integration.
