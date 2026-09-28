# Phase 0 — Analysis report

Scope: read-only analysis of the repository at commit `47e76d6` (branch `claude/jewelry-erp-prototype-fmu5j4`).
No application code was changed in this phase. All `file:line` references are to that commit.

Legend: ✅ exists and fits · 🟡 exists partially / needs change · ❌ missing

---

## (a) What exists versus what is required

### Summary table

| Area | Status | Today | Gap to the requirement |
|---|---|---|---|
| Money/weight units | 🟡 | Integer SDG (`bigint`, JS `number` mode) and integer milligrams (`database/src/schema.ts:3,24`, `shared/src/units.ts`) | Convention is sound but not enforced (no CHECKs, routes accept floats and round silently), there are no property tests, and one float intermediate remains (`shared/src/settlement.ts:58`) |
| Item origin / cost basis | 🟡 | `jewelry_items` has `purchase_cost`, `making_cost`, `other_cost`, `total_cost` and a fixed `selling_price` (`schema.ts:138-168`) | No `origin` (OPENING/SUPPLIER_NEW/SCRAP), no `cost_is_estimated`, no supplier or invoice on the item (only through `purchases`), no scrap link, and no decision on where making charge belongs |
| Profit snapshot | ✅ | `sale_items.unit_cost` is snapshotted server-side and profit = `final_price − unit_cost` (`sales/service.ts`, `schema.ts:270-282`) | Needs `acquisition_cost` naming, a stored profit column and a rate snapshot per line |
| Cost unchanged on transfer | ✅ | Transfers only change `branch_id`/`status` (`transfers/service.ts:40,70`) | — |
| Opening balance | ❌ | Seed fakes it as purchases with note "رصيد افتتاحي" | Whole workflow, sealing, cash and bank openings |
| Supplier purchases | 🟡 | `POST /purchases` creates items + ledger movements, but has no payment method and no money entry (`purchases/service.ts:31-112`) | Payment method, CREDIT payables, making charge as a first-class field, money OUT entry, idempotency |
| Scrap purchases (الكسر) | ❌ | — | Everything: scrap rate, tolerance, GM approval, customer info |
| Branch money ledger | ❌ | There is **no cash or bank ledger at all**. Sales store `payment_method` only; expenses, Hasad settlements, voids and purchases move no money | Entire module: accounts CASH/BANK/IN_TRANSIT, append-only entries, drawer balance, reconciliation |
| Inventory ledger | ✅ | `inventory_movements` + `item_status_history`, written only through `inventory/ledger.ts`, with guarded status transitions (`ledger.ts:80-118`) and row locks (`ledger.ts:60`) | Not append-only at the DB level; statuses are free `text` |
| Item transfers | 🟡 | IN_TRANSIT → RECEIVED only (`transfers/service.ts`) | DRAFT, CANCELLED, courier name, partial receipt/DISPUTED, GM stale flag, idempotency, row lock on the transfer |
| Money transfer claims | ❌ | — | Whole workflow + IN_TRANSIT account |
| Gold rates | 🟡 | `gold_rates(karat, price_per_gram, effective_at, set_by)`, history kept, GM edits (`routes.ts:88-112`) | No scrap buy rate, no GLOBAL/BRANCH scope, no re-auth, no max-change guard, no rate snapshot on sales; history is not DB-immutable |
| Settings | 🟡 | One JSON blob (`settings` row `system`) with defaults in `shared/src/settings.ts`, merged by `deepMerge` (`settings/store.ts:7-38`); PUT is audited | **PUT is not validated** (`routes.ts:122`); none of the 8 required business settings exist; no per-key history |
| Branding | 🟡 | Company name/nameAr already live in settings and are read by the header and invoice | Hardcoded fallbacks remain (see list below); logo is a hardcoded icon; invoice footer and currency label are hardcoded |
| Roles/permissions | 🟡 | Permission catalogue + default grants in `shared/src/permissions.ts`, stored in DB (`roles`, `role_permissions`), checked **inside services** (`authz/index.ts`), branch scope taken from the session actor | No central route guard; matrix is not declarative per route; tests cover only a few cases; several grants differ from spec H (below) |
| Sessions | 🟡 | Opaque random token (32 bytes), SHA-256 at rest, server-side revocation, audit on login/logout/revoke | Idle timeout effectively 12 h, no absolute timeout, no rotation on privilege change, `LIKE`-prefix revoke |
| Audit log | 🟡 | Written in the same transaction as the change (`core/audit.ts`), actor/branch/session/IP/entity/params | Not append-only at the DB level; spoofable IP (`trust proxy`); a few mutations are not audited (Hasad simulator, heartbeat is fine) |
| APP_MODE / production | ❌ | Auto-seeds demo data with known passwords on an empty DB (`server.ts:12-17`); demo reset endpoint always registered (`routes.ts:382`); demo credentials rendered on the login page (`frontend/src/pages/LoginPage.tsx:11-18`) | Everything in security item 2 |
| Web hardening | ❌ | Only `nosniff` + `Referrer-Policy` (`app.ts:17-21`) | helmet/CSP, CSRF, trust proxy, rate limiting |
| Backups | ❌ | — | Script, retention, restore drill, health check |
| Tests | 🟡 | 14 integration tests in one file (`backend/test/flow.test.ts`) on in-memory PGlite | No permission-matrix tests, no concurrency tests, no property tests, no frontend tests |

### Verification of your (VERIFY) assumptions

| Assumption | Finding |
|---|---|
| Money/weight convention | **Confirmed**: money is integer SDG in `bigint` columns read as JS `number` (safe to 9·10¹⁵); weights are integer milligrams in `integer` columns (`schema.ts:3,24,146-147`). **Correction:** there is no sub-unit (piastre); every amount is rounded to whole SDG with `Math.round` (half away from zero for positives, **half toward +∞ for negatives**). There is no written rounding rule and no property test. |
| Password hashing "argon2id or bcrypt ≥ 12" | **Not met.** The code uses **scrypt N=2¹⁴, r=8, p=1** (`backend/src/auth/password.ts:12-14`). That is the OWASP *minimum-era* setting; current OWASP guidance for scrypt is N=2¹⁷. Neither argon2id nor bcrypt is used. |
| Cookies HttpOnly + Secure + SameSite | **Partially.** HttpOnly ✅, `SameSite=Lax` ✅, **Secure only when `COOKIE_SECURE=true`** (`routes.ts:44`, `config.ts:14`), so it defaults to insecure. `maxAge` is 24 h (`routes.ts:46`). |
| Roles (spec H) vs existing RBAC | Differences listed in the next table. |

### Roles: existing grants vs spec H (`shared/src/permissions.ts:60-94`)

| Role | Spec H | Today | Difference |
|---|---|---|---|
| GENERAL_MANAGER | All branches, opening balance, users, rates, branding, audit. **No destructive operations** | **Every** permission, including `settings.manage`, which also gates the **demo reset that wipes the database** (`permissions.ts:50`, `routes.ts:382-388`, `database/src/client.ts:52,72`) and the Hasad simulator | Destructive operation available to the GM |
| BRANCH_MANAGER | Own branch: purchases, transfers, expenses, own-branch reports | Own branch. Also has `sales.void`, `inventory.adjust`, `inventory.price_edit`, `users.view`, `sessions.view`, `audit.view`, `profit.view`, and **all cashier permissions incl. POS** | Extra grants need your confirmation (question Q15) |
| CASHIER | POS sales in own branch only. No purchases, transfers, ledger, rates, wider reports | POS + `sales.discount` (3 %) + `inventory.view_available` + **`hasad.process` and `hasad.cancel`** (`permissions.ts:66-67`) | The cashier can process **and cancel** Hasad withdrawals. Keep or remove? (Q14) |
| Enforcement | Deny by default, central guard generated from one matrix | Deny by default inside services (each function calls `requirePerm`/`branchScope`); **no route-level guard**; the matrix is a grant list, not a route map | Needs a declarative route→permission matrix in `shared/` and a guard + generated tests |

Branch scope **is** taken from the session (`authz/index.ts:29-36`). A branch-bound user sending another `branchId` gets 403, never other data. No IDOR was found in the read paths I traced (sales, items, purchases, withdrawals, users, sessions, reports). There is an ordering subtlety in session revoke (finding M-6).

### Branding hardcodes (grep for "Loai Tabeede" / "لؤي تبيدي" and related)

| Location | What |
|---|---|
| `shared/src/settings.ts:50-51` | `DEFAULT_SETTINGS.company.name/nameAr` |
| `frontend/src/components/layout/AppShell.tsx:54` | Fallback name in header |
| `frontend/index.html:8` | `<title>Loai Tabeede ERP</title>` |
| `.devcontainer/devcontainer.json:4` | Codespace name (dev tooling only) |
| `scripts/i18n-check.mjs:59` | Allow-list entry |
| `frontend/src/components/InvoiceDocument.tsx:1,64` and `AppShell.tsx:15,50` | Logo is the hardcoded `Gem` icon |
| `frontend/src/lib/i18n-ar.ts` (`Thank you for your purchase · …`) | Invoice footer is a fixed translation string |
| `frontend/src/lib/format.ts:8` | Currency label `ج.س` / `SDG` is hardcoded; `settings.company.currency` exists but the UI ignores it |

### Other observations relevant to later phases
- **Selling price model:** today every item carries a fixed `selling_price` set at purchase (`routes.ts:311`). The sell gold rate is only used for Hasad settlements and to pre-fill purchase costs. In most Sudanese shops the sale price is **rate × weight + مصنعية** computed at sale time. This decides Phase 2/6 design (Q2).
- **Payment methods** are `CASH | BANK_TRANSFER | CARD | MOBILE_WALLET` (`shared/src/enums.ts:48`), while spec C/D uses `CASH | BANK`. They need a mapping to ledger accounts (Q5).
- **Hasad settlements move real money** (branch pays/collects the weight difference) but write no money entry. Voided sales return stock but record no refund. Both must go through the new ledger.
- **Concurrency:** item mutations lock rows (`ledger.ts:60`) and use guarded `UPDATE … WHERE status IN (…)` (`ledger.ts:93-97`), so double-sell is already prevented. Transfers, expenses and Hasad completion read their header row without a lock.
- **PGlite** runs a single connection, so tests on it serialize transactions and cannot prove row-lock behaviour. Concurrency tests must run on real PostgreSQL (Q13).

---

## (b) Security weaknesses (ranked)

### Critical

| # | Finding | Evidence | Impact |
|---|---|---|---|
| C-1 | **Demo data with known passwords is loaded automatically** on any empty database, in every environment. Seeded accounts do not have to change password. | `backend/src/server.ts:12-17`, `backend/src/seed/catalog.ts:10-14` | First production start creates `general.manager` / `demo-gm-2026`: full takeover |
| C-2 | **Demo credentials are printed on the login page** for everyone | `frontend/src/pages/LoginPage.tsx:10-18` | Same as C-1, and publicly visible |
| C-3 | **`POST /api/demo/reset` drops every schema and reseeds**, available in all environments to any holder of `settings.manage` (the GM). Its only CSRF defence is `SameSite=Lax` (body-less POST). | `backend/src/routes.ts:382-388`, `backend/src/seed/reset.ts:6-14`, `database/src/client.ts:52,72` | One click, a stolen GM session, or a same-site CSRF destroys all financial data |
| C-4 | **No production mode at all**: no `APP_MODE`, no secret checks, no bootstrap for the first real GM | `backend/src/config.ts:6-16` (the `production` flag is never read) | C-1..C-3 cannot be switched off |

### High

| # | Finding | Evidence | Impact |
|---|---|---|---|
| H-1 | **No login rate limiting or lockout**; unlimited online guessing | `backend/src/modules/auth/service.ts:10-50`, `routes.ts:38-49` | Password guessing against all accounts |
| H-2 | **Weak password KDF**: scrypt N=2¹⁴ (below current OWASP), not argon2id/bcrypt | `backend/src/auth/password.ts:12-14` | Faster offline cracking if the DB leaks |
| H-3 | **Session idle timeout is effectively 12 h** (expiry uses `sessionExpiryHours` against last activity; `sessionIdleMinutes` is only a display value). **No absolute timeout**: an active session never expires. | `backend/src/modules/sessions/service.ts:114`, `shared/src/settings.ts:175-176` | Unattended counter terminals stay logged in |
| H-4 | **Cookie `Secure` is off by default** | `backend/src/routes.ts:44`, `backend/src/config.ts:14` | Session theft on any plain-HTTP hop |
| H-5 | **`PUT /settings` stores the raw request body with no schema validation**, then deep-merges it (prototype keys like `__proto__` are not filtered) | `backend/src/routes.ts:122-124`, `backend/src/modules/settings/store.ts:7-15,31` | A bad value (e.g. an invalid timezone, a string threshold, a negative discount %) breaks every dashboard or silently changes business rules |
| H-6 | **`trust proxy` is `true`**: any client can set `X-Forwarded-For` | `backend/src/app.ts:13`, used by `auth/middleware.ts:9-12` | Audit-log IP forgery; defeats any future IP-based rate limit |
| H-7 | **Audit, inventory ledger, status history and gold-rate history are mutable at the DB level** (no triggers, no revoked privileges) | `database/migrations/0000_init.sql` (no `TRIGGER`/`REVOKE`) | An app bug or a compromised DB user can rewrite history undetected |
| H-8 | **No security headers / CSP / CSRF token** (only `nosniff` and `Referrer-Policy`) | `backend/src/app.ts:17-21` | XSS blast radius not limited; CSRF rests on SameSite only |
| H-9 | **Hasad completion calls the external system before the local commit, with no idempotency/outbox**. A local failure after a successful remote call leaves Hasad "completed" and the ERP "in progress". Two parallel requests both pass the local checks, and the second remote call is only refused if Hasad itself refuses. | `backend/src/modules/hasad/service.ts:388-420` | Customer's gold balance debited without the ERP recording delivery (or the reverse) |
| H-10 | **No money ledger**: sales, Hasad settlements, voids, expenses and purchases move money with no cash/bank record | whole codebase (no ledger table in `schema.ts`) | Cash in drawer cannot be reconciled; the core fintech requirement is absent |

### Medium

| # | Finding | Evidence |
|---|---|---|
| M-1 | zod objects are **not `.strict()`**: unknown fields are silently dropped, not rejected. Several numbers are **unbounded or non-integer**: sale `discount` (`routes.ts:214`), expense `amount` (`routes.ts:329`, `z.number().positive()`, later rounded), `limit`/`offset`/`targetWeightMg` (`routes.ts:191-193`), purchase costs have no upper bound (`routes.ts:305-311`), gold rates have no upper bound (`routes.ts:94`). Karat filters accept any integer. |
| M-2 | **Username enumeration by timing**: no password hash is computed when the user does not exist | `auth/service.ts:11-14` |
| M-3 | **Race on expense review**: header read without a row lock, so two concurrent approve/reject calls both succeed. Harmless today, but it becomes a double money posting once expenses hit the ledger | `expenses/service.ts:62` |
| M-4 | **Transfer receive reads the transfer without a lock.** A double receive is currently stopped only by the item status guard; the header can be updated twice | `transfers/service.ts:62` |
| M-5 | **No idempotency keys**: a double-submitted purchase or expense creates duplicates (sales are protected by the item lock) | `routes.ts:303-333` |
| M-6 | Session revoke matches **`LIKE key%` with unescaped user input**. `%` or a short prefix selects an arbitrary session; the rank/branch checks still apply | `sessions/service.ts:216` |
| M-7 | The **Hasad pickup code has no attempt limit**, and the cashier can bypass it by choosing `ID_DOCUMENT` (a business-control gap) | `routes.ts:247-250`, `hasad/service.ts:247-294` |
| M-8 | **The GM can set another user's temporary password**; only length is checked (no complexity) | `users/service.ts:96-97` |
| M-9 | **Unhandled 500 in the simulator** when `branchId` does not exist (`branch.hasadBranchCode!` on `undefined`) | `routes.ts:287-288` |
| M-10 | **Validation error `details` return raw zod issues** to the client (field paths, expected types). No SQL or stack is leaked, but it is more than needed | `core/http.ts:24,37` |
| M-11 | **Unstructured `console.error(err)`** for 500s. It may include SQL text and parameter values from driver errors | `core/http.ts:45` |
| M-12 | **No DB-level integrity** for statuses/enums (all `text`), no `CHECK (x >= 0)` on money or weights, no FK from `jewelry_items.purchase_id` | `database/src/schema.ts` passim |
| M-13 | The **settings cache is per process**: with more than one instance, settings diverge until restart | `settings/store.ts:18-28` |

### Low

| # | Finding | Evidence |
|---|---|---|
| L-1 | The **failed-login audit stores the typed username** verbatim. Users sometimes type a password into that field | `auth/service.ts:19-21` |
| L-2 | The **runtime depends on `tsx`** (a TypeScript compiler) in production, which adds supply-chain surface | `backend/package.json` (`dependencies.tsx`) |
| L-3 | **`npm audit`: 6 moderate, 0 high/critical**, all dev-time: `esbuild@0.18.20` pulled in by `drizzle-kit` (GHSA-67mh-4wv8-2f99, dev-server request forgery) and `vitest@3.2.7`/`@vitest/mocker` (GHSA-82fw-gwwq-j7x9, path traversal, fixed in ≥ 4.1.11). Neither ships in the runtime | `npm audit` output, 2026-09-28 |
| L-4 | **Held POS carts** (customer name/phone) are stored in `localStorage` on shared counter devices | `frontend/src/pages/pos/PosPage.tsx` (`saveHeld`) |
| L-5 | **Demo-only background job** rewrites `sessions.last_activity_at` every minute | `backend/src/server.ts:25-33` |
| L-6 | **The `/health` endpoint is unauthenticated** and discloses the DB driver and Hasad mode | `routes.ts:51-53` |
| L-7 | **The settlement amount uses a float intermediate** `(mg/1000)*rate`; it should be `round(mg*rate/1000)` in integer arithmetic | `shared/src/settlement.ts:58` |

Not found (good): no `dangerouslySetInnerHTML`, `innerHTML` or `eval` in the frontend. The session token is HttpOnly and never reaches JS. The token is stored hashed. The Hasad pickup code is never sent to the browser. No stack traces reach clients. Branch isolation is applied on every read path traced.

---

## (c) Proposed schema changes and migration plan

All migrations are forward-only and additive (drizzle `0002_…` onward). Each phase ships its own migration. Data columns are added, backfilled, and then the old ones deprecated, never dropped. Status/enum constraints are added as `CHECK … NOT VALID` followed by `VALIDATE CONSTRAINT`, so an existing demo DB with odd rows fails loudly instead of being rewritten.

| Phase | Table / change | Notes |
|---|---|---|
| 1 | `settings`: move from one `system` blob to **one row per key** (`key`, `value jsonb`, `version int`, `updated_at`, `updated_by`) + new append-only `settings_history(key, old, new, actor, at, reason)` | Backfill: explode the `system` JSON into per-key rows and keep the old row as deprecated. A typed registry (`shared/settings-registry.ts`, zod per key) is the single source of defaults and validation. |
| 1 | `branding_assets(id, kind 'LOGO', mime, bytes bytea, sha256, size, uploaded_by, at)` | Settings reference the current asset id |
| 1 | `users` + `password_algo`, `failed_login_count`, `locked_until`; new `login_attempts(username_hash, ip, at, success)` | Rehash to argon2id on next successful login |
| 1 | `sessions` + `absolute_expires_at`, `idle_expires_at`, `reauth_at` | Reauth window for sensitive actions |
| 1 | `app_meta(key, value)` storing `app_mode_initialized`, `bootstrap_done` | Refuse demo seed if production was ever initialised |
| 2 | Enums in `shared/` → Postgres `CHECK` constraints on every status column (items, sales, transfers, expenses, withdrawals, redemptions, sessions) | `NOT VALID` → `VALIDATE` |
| 2 | `CHECK (col >= 0)` on money and weight columns; `CHECK (net_weight_mg <= gross_weight_mg)`; karat `CHECK (karat BETWEEN 1 AND 24)` (the allowed set is enforced in the app from settings) | |
| 2 | `jewelry_items` + `origin` (`OPENING|SUPPLIER_NEW|SCRAP`, backfill `SUPPLIER_NEW`), `acquisition_cost` (backfill = `total_cost`), `cost_is_estimated bool default false`, `supplier_id`, `supplier_invoice_ref`, `making_charge` (backfill = `making_cost`), `source_doc_type/id` | `purchase_cost/other_cost/total_cost` kept, deprecated |
| 2 | `sale_items` + `acquisition_cost` (= `unit_cost`), `profit` (= `final_price − unit_cost`), `sell_rate_per_gram`, `gold_rate_id` | Backfill from existing rows |
| 2 | `ledger_accounts(id, branch_id, kind CASH|BANK|FUNDS_IN_TRANSIT)` + **`ledger_entries`** (`id bigserial`, `branch_id`, `account_id`, `amount bigint` signed, `event_type`, `ref_type`, `ref_id`, `reverses_entry_id`, `actor_id`, `session_id`, `idempotency_key`, `at`) | Balance = `SUM(amount)`. No cached balance initially. |
| 2 | **Append-only triggers** (`BEFORE UPDATE OR DELETE … RAISE EXCEPTION`) on `ledger_entries`, `audit_logs`, `inventory_movements`, `item_status_history`, `gold_rates`, `settings_history` | Plus `REVOKE UPDATE, DELETE` for the app role on real PostgreSQL. A test proves both. |
| 2 | `idempotency_keys(user_id, key, route, request_sha256, response jsonb, status, created_at)`, unique `(user_id, key)` | |
| 2 | Backfill ledger for history? **No.** Historical demo sales get no ledger entries; the opening balance (Phase 3) starts the books. | See Q18 |
| 3 | `opening_balances(id, branch_id unique, status DRAFT|SEALED, opening_cash, opening_bank, sealed_by, sealed_at)` + `opening_balance_items(opening_id, item_id)` | Sealing writes ledger entries |
| 4 | `purchases` + `kind SUPPLIER|SCRAP`, `payment_method CASH|BANK|CREDIT`, `customer_name`, `customer_phone`, `rate_per_gram`, `rate_snapshot_id`, `override_reason`, `approval_status`, `approved_by/at`; new `supplier_payables(id, supplier_id, purchase_id, amount, status)` | Backfill `kind='SUPPLIER'`, `payment_method=NULL` (legacy) |
| 5 | `transfers` + `courier_name`, `sent_at`, `cancelled_by/at`; new statuses `DRAFT|IN_TRANSIT|RECEIVED|PARTIALLY_RECEIVED|CANCELLED`; `transfer_items` + `status PENDING|RECEIVED|DISPUTED`, `received_at` | Existing rows: `IN_TRANSIT`/`RECEIVED` stay valid; items get `RECEIVED` or `PENDING` |
| 5 | `money_transfer_claims(id, from_branch, to_branch, amount, bank_ref, transfer_date, status CLAIMED|CONFIRMED|DISPUTED|CANCELLED, …)` | Ledger postings via FUNDS_IN_TRANSIT |
| 6 | `gold_rates` + `scrap_buy_price_per_gram`, `branch_id` (NULL = global), `reason`, `confirmed_large_change bool`; existing `price_per_gram` = sell rate | Rows stay immutable (trigger from Phase 2) |

Migration safety: each migration is tested by (1) applying it to a **copy** of the current demo PGlite directory (`.data/pglite` → temp dir) and running the invariant checks, and (2) applying it on a fresh DB. On real PostgreSQL, long backfills run in batches and the migration is idempotent (`IF NOT EXISTS`).

---

## (d) Refined phase breakdown

I recommend two changes to your plan. First, split Phase 1, because it is too large to review safely in one go. Second, move the shared integrity foundation (DB constraints, append-only triggers, idempotency) to the start of Phase 2, since every later phase depends on it.

| Phase | Content | Why |
|---|---|---|
| **1a — Production safety** | `APP_MODE` (`demo`/`production`); no demo seed/reset/simulator/demo credentials in production (route not registered → 404 test); first-GM bootstrap CLI with forced password change; refuse to start with default secrets or with PGlite in production; argon2id + rehash-on-login; login rate limit + progressive lockout + dummy hash; idle and absolute session timeouts; session rotation; re-auth endpoint and middleware; Secure cookies in production; `trust proxy` from env; helmet + CSP; CSRF double-submit token; strict zod on existing routes; structured logger with redaction | Removes C-1..C-4 and H-1..H-6 and H-8 first |
| **1b — Settings, branding, permission matrix** | Typed per-key settings (zod registry, history, GM UI, audit), including the 8 new business settings; branding (names, logo upload with magic-byte check, footer, currency label) read by login, header and invoice; route→permission matrix in `shared/`, central guard, generated allow/deny/cross-branch tests for every route | Depends on 1a's re-auth and CSRF |
| **2 — Integrity + cost model + money ledger** | DB CHECKs and enums, append-only triggers (tested), idempotency middleware, item origin/cost fields, sale-line profit snapshot, branch ledger (CASH/BANK/IN_TRANSIT) wired into **sales, voids (reversal), expenses, Hasad settlements**; expected-cash-in-drawer; daily reconciliation report; property tests for money/weight arithmetic; concurrency tests on real Postgres | Every later phase writes ledger entries |
| **3 — Opening balance** | As specified, sealing with re-auth | |
| **4 — Purchases** | Supplier (CASH/BANK/CREDIT + payables) and scrap (rate, tolerance, GM approval queue) | Needs Phase 6's scrap rate. Either Phase 4 ships with a minimal scrap-rate field or **Phases 4 and 6 swap order**. Recommendation: **do Phase 6 (rates) before Phase 4.** |
| **5 — Transfers** | Item state machine with partial receipt and disputes; money claims | |
| **6 — Gold rates** | Scope, scrap rate, re-auth, max-change guard, mobile screen, polling, snapshots | Move before Phase 4 (see above) |
| **7 — Security audit** | As specified: `docs/SECURITY.md`, backups + tested restore + stale-backup health warning, `npm audit`, residual risks | Backups could move earlier (to Phase 2) if the parallel run starts before Phase 7 (Q19) |

Test infrastructure needed from Phase 1a: a vitest project that can run against **real PostgreSQL** (Docker service or `DATABASE_URL`) for concurrency and privilege tests, in addition to in-memory PGlite for speed; plus `fast-check` for property tests. Both are dev dependencies.

---

## (e) Questions for you

Where I propose a default, Phase 1+ will use it (and record it in `docs/decisions.md`) unless you say otherwise.

**Money and pricing**
1. **Currency precision:** keep whole SDG (no piastres)? Rounding rule proposal: *round half away from zero*, applied once per line and never on intermediate sums.
2. **How is the selling price set?** (a) a fixed tag price per item (today), or (b) computed at sale time as `sell rate × net weight + مصنعية`, possibly with negotiation? This changes the sale screen, the rate snapshot and profit.
3. **Making charge (المصنعية):** my proposal is that for SUPPLIER_NEW items the making charge paid to the supplier is part of the **acquisition cost**, so profit = price − (gold cost + making charge). Is the مصنعية you charge customers a separate price component (only relevant if 2b)?
4. **Scrap (الكسر) after purchase:** is it resold as-is (a sellable item), melted/sent to a refiner (non-sellable stock), or both? Is it tracked per piece or as a weight pool per karat?
5. **Payment methods:** map `CARD` and `MOBILE_WALLET` (e.g. Bankak) to the BANK account, or keep them as separate accounts?
6. **Voided sales:** always refunded in the original payment method? Same-day only?
7. **Expenses:** paid from CASH or BANK (choose per expense)? Should a PENDING expense touch the ledger only when approved?
8. **Hasad settlements:** cash in/out of the branch drawer (CASH account) by default?

**Workflows**

9. **Opening stock items:** do they need a product/model (current catalogue), or just category + karat + weights + cost?
10. **Supplier credit:** is paying off a supplier payable (partially) needed now, or only recording it?
11. **Transfers:** may the GM create or receive transfers on behalf of branches, or only branch managers? May the GM receive when the receiving BM is absent?
12. **Idle and absolute timeouts:** proposal is 15 min idle for cashiers and 30 min for managers, 12 h absolute. Lockout proposal: 5 failures → 15 min, doubling up to 24 h, GM can unlock.

**Deployment and data**

13. **Hosting:** will production run on a real PostgreSQL server (recommended, and required for DB-level privilege revocation and backups), and where (VPS, cloud, on-prem)? I propose refusing to start in production with embedded PGlite.
14. **Cashier and Hasad:** keep `hasad.process` for cashiers? Remove `hasad.cancel` from cashiers (proposal: yes, manager only)?
15. **Branch manager extras:** keep `sales.void`, `inventory.price_edit`, `inventory.adjust` (with re-auth), `users.view`, `audit.view` (own branch)?
16. **GM "no destructive operations":** confirm that means no delete or reset of business data in production, while the GM keeps adjustments (audited, re-auth).
17. **Rate scope:** start GLOBAL (default) and allow per-branch later?
18. **Go-live data:** production starts from an **empty database** (bootstrap GM, then opening balances), never from demo data. Correct?
19. **Parallel run timing:** when does the two-week paper parallel run start? If it is before Phase 7, backups must move earlier.
20. **Logo limits:** max 512 KB and ≤ 1024×1024 px acceptable?
21. **Second factor for the GM** (TOTP) now or later? Not in the requirements, but recommended for the account that can change rates and seal balances.

---

*End of Phase 0. No code has been changed; next step awaits your go-ahead for Phase 1 (or 1a).*
