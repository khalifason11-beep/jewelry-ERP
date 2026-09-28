# Decisions log

Every decision taken under ambiguity, or confirmed by the client, is recorded here with its
context, the options considered, the choice, and how to change it later. Newest entries are at
the bottom of each section. `CLIENT-PENDING` marks a default that still needs the client's final
word.

---

## 1. Plan (approved after Phase 0, 2026-09-28)

| # | Decision | How to change later |
|---|---|---|
| P-1 | Phase 1 is split into **1a** (production safety: APP_MODE, bootstrap, auth hardening, web hardening) and **1b** (typed settings, branding, permission matrix + central guard). | — |
| P-2 | **Phase 6 (gold rates) runs before Phase 4 (purchases)**, because scrap purchases need the scrap buy rate. | — |
| P-3 | Phase 2 is split into **2a** (DB CHECKs/enums, append-only triggers + REVOKE, idempotency middleware, real-PostgreSQL test infrastructure, fast-check property tests, the `settlement.ts` float fix L-7) and **2b** (item origin/cost model, sale-line profit snapshot, branch ledger wired into sales, voids as reversals, expenses, Hasad settlements, drawer balance, daily reconciliation). | — |
| P-4 | New **Phase 2c: backups** (pg_dump script with retention, a **tested** restore drill, stale-backup health warning). It **must be complete before Phase 3**, the first real data. | — |
| P-5 | **H-9 (Hasad outbox/idempotency) becomes its own phase** before the pilot go-live. It does **not** start until the client confirms the real Hasad integration details. | — |
| P-6 | **TOTP + recovery codes for the GM** before go-live, scheduled after 1b. | — |
| P-7 | **Production mode refuses to start on embedded PGlite**; real PostgreSQL is required. | Implemented in Phase 1a (`backend/src/core/startup.ts`). |

Resulting order: 1a → 1b → TOTP → 2a → 2b → 2c → 3 → 6 → 4 → 5 → Hasad (H-9) → 7.

## 2. Business decisions (Q1–Q21 of the Phase 0 report)

| # | Topic | Decision | How to change later |
|---|---|---|---|
| Q1 | Money precision | **Whole SDG.** Rounding: **half away from zero**, symmetric for negatives (−2.5 → −3), applied **once per line**, never on intermediate sums. | A shared `roundMoney()` helper (Phase 2a) is the only rounding entry point. |
| Q2 | Selling price model | **CLIENT-PENDING.** The sale line must be able to store price **components** (gold value + making charge) so both fixed-tag and computed (rate × weight + مصنعية) pricing can be supported later. Today's fixed tag price stays. | Phase 2b adds the component columns; the pricing mode becomes a setting once the client decides. |
| Q3 | Making charge | For `SUPPLIER_NEW` items the making charge is **part of the acquisition cost**, and is also kept as a **separate stored field** for reporting. | — |
| Q4 | Scrap after purchase | **CLIENT-PENDING.** Default: scrap items become **sellable inventory** (per piece). Revisit before Phase 4. | Item origin `SCRAP` plus status; a "melt / send to refiner" flow can be added without changing history. |
| Q5 | Payment methods → accounts | `CARD` and `MOBILE_WALLET` post to the **BANK** account; each ledger entry keeps its original payment method. | Mapping table in `shared/` (Phase 2b). |
| Q6 | Voided sales | The refund goes through the **original payment method**. Requires a **branch manager** plus a **reason**. | — |
| Q7 | Expenses | Paid from **CASH or BANK**, chosen per expense. The ledger posts **on approval only** (a PENDING expense does not move money). | — |
| Q8 | Hasad settlements | **CASH by default**, BANK selectable at the counter. | — |
| Q9 | Opening items | Category + karat + gross/net weight + cost is enough (no product/model required). | — |
| Q10 | Supplier credit | **Record supplier payables only** (no payment workflow yet). `supplierCreditEnabled = false` by default. | Setting (Phase 1b). |
| Q11 | GM and transfers | The GM may **view and resolve disputes** but does **not** create or receive transfers by default. An **emergency override** requires re-auth + reason + an audit flag. | Phase 5. |
| Q12 | Timeouts and lockout | Idle: **15 min cashiers, 30 min managers**. Absolute: **12 h**. Lockout: **doubles from 5 consecutive failures, capped at 1 hour**. The GM can unlock. | Settings `security.*` (typed in 1b). See D-1a-4 for the exact lockout formula. |
| Q13 | Database | **Real PostgreSQL required in production.** | — |
| Q14 | Cashier and Hasad | The cashier **keeps `hasad.process`**; **`hasad.cancel` becomes manager-only**. | Permission matrix (1b). |
| Q15 | Branch manager grants | The BM keeps `sales.void`, `inventory.adjust` (**with re-auth**), `inventory.price_edit`, `users.view` (own branch) and `audit.view` (own branch). **Cost/profit visibility: GM only by default; cashiers never.** | Permission matrix (1b). |
| Q16 | GM destructive operations | **No delete or reset of business data in production.** Audited adjustments with re-auth remain. | — |
| Q17 | Gold-rate scope | **GLOBAL by default.** | Setting `goldRateScope` (1b/6). |
| Q18 | Go-live data | Production starts from an **empty database**. The demo deployment stays separate with `APP_MODE=demo`. | — |
| Q19 | Backups | Before Phase 3 (see P-4). | — |
| Q20 | Logo | Max **512 KB** and **1024 × 1024 px**; PNG/JPEG/WebP only, verified by magic bytes; SVG rejected. | Phase 1b. |
| Q21 | GM second factor | **Yes, TOTP + recovery codes** (see P-6). | — |

## 3. Phase 1a decisions

| # | Context | Options | Choice | How to change later |
|---|---|---|---|---|
| D-1a-1 | Password hashing (the spec allows argon2id or bcrypt ≥ 12) | `argon2` (node-gyp), `@node-rs/argon2` (prebuilt native, runs off the event loop), pure-WASM `hash-wasm` (blocks the event loop), bcrypt | **argon2id via `@node-rs/argon2`**, OWASP parameters **m = 19 MiB, t = 2, p = 1**. Legacy scrypt hashes still verify and are **re-hashed on the next successful login**. | Parameters live in `backend/src/auth/password.ts`. Hashes carry their parameters, so raising them triggers re-hash-on-login automatically (`needsRehash`). |
| D-1a-2 | App mode | env flag vs setting | **Env `APP_MODE` = `demo` \| `production`**, default `demo` (keeps the Codespace/local demo working). Not a DB setting: a GM must not be able to flip it. | Env var. |
| D-1a-3 | First GM in production | env bootstrap at startup vs one-time CLI | **One-time CLI** `npm run bootstrap -w @jerp/backend` (logic in `backend/src/modules/bootstrap/service.ts`) (roles, permissions, categories, the first GM with a generated one-time password and `must_change_password = true`). It refuses to run if any GM already exists. Branches are created with `--branch CODE:NameEn:NameAr:City` (repeatable). | Branch management UI is not part of 1a. |
| D-1a-4 | Lockout formula for Q12 | — | After the **5th consecutive failure** the account locks for **15 min**; every further failure after a lock doubles it (**30, then 60 min cap**). A success resets the counter. Unknown usernames get the **same responses and timing** (in-memory counter plus a dummy argon2 verification), so lockout does not reveal which accounts exist. A **per-IP limit** (30 attempts / 15 min, in memory) stops password spraying across accounts. | `security.lockout*` defaults in `shared/src/settings.ts` (typed settings UI in 1b). Per-IP limits are per process: with several app instances, move them to the DB or Redis. |
| D-1a-5 | What counts as "activity" for the idle timeout | Every request (then background polling keeps sessions alive forever) vs user input | The browser reports **milliseconds since the last real user input** (`x-client-idle-ms`) on every request. The server moves `last_activity_at` only to *now − idleMs*. Non-browser clients without the header count as active. | `frontend/src/lib/api.ts` and `sessions/service.ts`. |
| D-1a-6 | Idle limits by role | — | `security.idleMinutesByRole = { CASHIER: 15, BRANCH_MANAGER: 30, GENERAL_MANAGER: 30 }`, unknown roles use the strictest value (15). Absolute limit `security.sessionAbsoluteHours = 12`, fixed at login in `sessions.absolute_expires_at`. | Settings. |
| D-1a-7 | CSRF defence | double-submit cookie, signed token (needs a server secret), synchronizer token | **Synchronizer token stored on the session row**, returned by `/auth/login` and `/auth/me`, sent by the SPA as `x-csrf-token` on every POST/PUT/PATCH/DELETE. Plus an **Origin/Referer check** against `APP_ORIGIN` for unsafe methods (covers the login form). No server secret is needed, so there is no secret to leak or rotate. | `backend/src/core/csrf.ts`. |
| D-1a-8 | Re-authentication | — | `POST /auth/reauth {password}` sets `sessions.reauth_at`. Sensitive actions require a re-auth **within the last 5 minutes**, otherwise the API answers `403 REAUTH_REQUIRED` and the SPA asks for the password and retries once. 1a applies it to **gold-rate changes, role/branch changes of a user, inventory adjustments** and, as conservative additions, **settings changes, creating a user (assigns a role) and resetting a password** (an account-takeover vector). A failed re-auth counts toward the lockout. | `REAUTH_WINDOW_MINUTES` in `backend/src/auth/reauth.ts`. |
| D-1a-9 | Proxy trust | — | `TRUST_PROXY` env, **default off**. In production behind one reverse proxy set `TRUST_PROXY=1`. Without it, `X-Forwarded-For` is ignored, so audit IPs cannot be forged. | Env var. |
| D-1a-10 | Production start-up refusals | — | Production refuses to start when: `DATABASE_URL` is missing (PGlite), `APP_ORIGIN` is missing or not `https://`, `COOKIE_SECURE=false`, the DB password is empty or a well-known default (`postgres`, `password`, `admin`, `root`, `changeme`, `secret`, `123456`), or **any demo account still accepts its demo password**. | `backend/src/core/startup.ts`. |
| D-1a-11 | Hasad in production | — | Until the Hasad phase (P-5), production keeps the mock implementation **inert**: its schema is empty, and the simulator and integration log routes are **not registered**. | Replaced in the Hasad phase. |
| D-1a-12 | Password policy | — | Minimum **10** characters, must contain letters and digits, must not contain the username, and must not be a well-known common password. It applies to self-chosen passwords **and** to temporary passwords typed by the GM (M-8). Generated temporary passwords (`Temp-XXXX-XXXX`) satisfy it. | `security.minPasswordLength`; the rules are in `backend/src/auth/policy.ts`. |
| D-1a-13 | Request-body limit | — | JSON bodies are limited to **100 KB** (was 1 MB). The logo upload (1b) gets its own route with its own limit. | `backend/src/app.ts`. |
| D-1a-14 | `PUT /settings` validation (H-5) | wait for 1b vs validate the current shape now | **Validate now** with a strict zod schema of the current `SystemSettings` (unknown keys rejected, numbers bounded, timezone checked with `Intl`, `__proto__`-style keys ignored). Stored settings are normalised on read, so legacy keys disappear. 1b replaces it with the typed per-key registry. | `backend/src/modules/settings/schema.ts`. |
| D-1a-15 | Demo accounts on the login page (C-2) | — | The list moves to the backend: `GET /api/meta` returns it **only in demo mode**, so production bundles and responses never contain demo passwords. | — |
| D-1a-16 | CSP for styles | strict `style-src 'self'` breaks React/Recharts inline `style` attributes | `style-src 'self' 'unsafe-inline'`; **scripts stay strict** (`script-src 'self'`, `script-src-attr 'none'`, no inline scripts in the built SPA). Style injection cannot execute code. | `backend/src/app.ts` (helmet). Tighten with nonces if the UI stops using inline styles. |
| D-1a-17 | Wrong password typed by a signed-in user | ignore vs count | Failures of **re-auth and change-password count toward the lockout**; when they lock the account, **all its sessions end**. | `backend/src/modules/auth/service.ts` (`wrongPasswordWhileSignedIn`). |
| D-1a-18 | Session rotation | rotate id in place vs new row | A **new session row** is created on every sign-in and on a password change; old rows are ended, never renamed, so audit rows keep pointing at the session they happened in. | — |
| D-1a-19 | Access log | none vs morgan vs own | A small structured JSON logger (`backend/src/core/logger.ts`, no dependency): one line per API request (method, path, status, ms, user id); **no bodies, query strings or cookies**; keys that look secret are redacted; SQL parameters are stripped from error messages. `LOG_LEVEL` controls verbosity (tests: silent). | — |
| D-1a-20 | Demo reset in production | route only vs route + CLI + function | Blocked at **three layers**: route not registered, `npm run db:reset` refuses, and `resetDemoData()` throws unless `APP_MODE=demo`. | — |
