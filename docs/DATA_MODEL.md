# Data model

> Rewritten in DOC-1. The prototype version described tables and columns that no longer exist: expenses, the Hasad
> withdrawal tables, `settlements`, `hasad_mock`, item cost and reservation columns, `RESERVED` and `REDEEMED`. The
> schema of record is [`database/src/schema.ts`](../database/src/schema.ts) (Drizzle), and the SQL migrations are in
> `database/migrations/`. `npm run check:drizzle` fails if the two disagree. `scripts/check-docs.mjs` fails if a
> migration or an append-only table is missing from this file.

## Conventions

- **Weights** are integer milligrams (`*_mg`). Pure-gold equivalents are `*_mg_pure24`. **Money** is an integer
  (`bigint`) in the currency's smallest unit. The karat is 1–24.
- **Document numbers** are allocated in the transaction from `document_sequences`, in the form
  `<branch code>-<type>-NNNNNN`. The types are:
  - `INV` sale; `PO` supplier order; `SCR` scrap purchase;
  - `SST` supplier settlement; `HRS` Hasad settlement;
  - `GMA`, `GMR`, `GMX` for funding (advance, repayment, correction);
  - `CO-TRF-…` for transfers.

  Pieces get `J-n` with a barcode.
- **Time:** timestamps are `timestamptz`. The business day is computed in the `company.timezone` setting.
- **Allowed values:** every status or kind column accepts only the values in `shared/src/enums.ts`, enforced by CHECK
  constraints listed in `shared/src/db-checks.ts`.
- **Visibility:** every column is classified COST or SAFE in `shared/src/field-classification.ts`. COST values reach
  the General Manager only.

## Tables

### People, access and security

| Table | Purpose |
|---|---|
| `branches` | Code (unique, permanent), names, city, active flag |
| `roles`, `permissions`, `role_permissions` | The three fixed roles and their grants (`shared/src/permissions.ts`) |
| `users` | Argon2id `password_hash`, `must_change_password`, status, branch, lockout counters, recovery-code dates, `security_locked_at` |
| `sessions` | Server-side sessions: token hash, device, IP, current module, status, idle and absolute limits, `reauth_at`, `passkey_reauth_at`, CSRF token |
| `login_pending` | The step between the password and the passkey |
| `webauthn_credentials`, `webauthn_challenges` | Passkeys and one-time challenges |
| `recovery_codes` | Hashed single-use codes |
| `sign_in_events` | Sign-ins with method and new-device flag (the "Was this you?" alert) |
| `idempotency_keys` | Stored responses for `Idempotency-Key` |

### Catalogue and stock

| Table | Purpose |
|---|---|
| `categories` | Item types: Arabic name required, unique normalised name (`name_ar_norm`), active flag |
| `products` | Product (name, type, karat), unique per normalised name + karat + type |
| `suppliers` | Arabic name required, unique normalised name |
| `jewelry_items` | One row per piece: code, barcode, product, karat, gross/net weight, `origin` (OPENING, SUPPLIER_NEW, SCRAP), `acquisition_cost` (COST), `cost_is_estimated`, `making_charge` (COST), selling price, branch, status, `purchase_id` |
| `item_status_history` | Append-only: every status transition, with reference, user and note |
| `inventory_movements` | Append-only stock ledger: type (PURCHASE, SALE, TRANSFER_IN, TRANSFER_OUT, RETURN, ADJUSTMENT, DAMAGE), direction ±1, branch, reference, weight, cost value |
| `transfers`, `transfer_items` | Transfers between branches: IN_TRANSIT → RECEIVED, `courier_name` (0019) |

### Sales

| Table | Purpose |
|---|---|
| `sales` | The invoice header. Totals; `payment_method`; `payment_ref_invoice` and `payment_ref_transaction` (Hasad references; for a bank transfer the transfer reference, 0018); status COMPLETED / VOIDED with the void reason; `price_change_reason` (0017); print and reprint counters (0012) |
| `sale_items` | Lines with snapshots: product name, karat, weight, list price, discount, final price, `acquisition_cost` and `profit` (COST), and `pricing_mode` (only FIXED_TAG is used) |

### Supplier orders and scrap

| Table | Purpose |
|---|---|
| `purchases` | The supplier order, recorded by the General Manager (see below) |
| `purchase_items` | One line per piece: `purchase_cost`, `making_cost`, `other_cost` (COST) |
| `supplier_settlements` | Append-only: a settlement visit, in which broken scrap (karat, weight, pure 24K) reduces `gold_owed_mg_pure24` |
| `scrap_rates` | Append-only rate history per karat; the latest row is current |
| `scrap_purchases` | Append-only: scrap bought from a customer (see below) |
| `scrap_weight_entries` | Append-only movements of the broken-scrap pool, per branch and karat (SCRAP_PURCHASE, SUPPLIER_SETTLEMENT, REVERSAL) |

**`purchases`** columns:

- **Gold:**
  - `gold_debt_mg_pure24` is the gold owed at creation;
  - `gold_owed_mg_pure24` is the gold still owed after settlements;
  - both are NULL for orders from before Phase 4.
- **Making charge (MKC-1, migration 0022):**
  - `making_charge_paid` (COST) is the amount;
  - `making_charge_paid_from` is `OWNER_PERSONAL`, the only allowed value;
  - `making_charge_reference` and `making_charge_transfer_date` are required when the amount is above 0, and only the
    General Manager sees them.
  - No ledger entry is written.
  - The migration stops, changing nothing, on a database holding orders paid from branch money. Such databases are
    recreated, not upgraded (pre-production only).

**`scrap_purchases`** columns:

- the `kind` (SELLABLE becomes a piece through `item_id`; BROKEN adds weight to the pool);
- the rates and the deviation in basis points, with `override_approved`;
- **payment (CSH-2, migration 0021):** `cash_amount + bank_amount = amount`. `payment_method` is CASH, BANK_TRANSFER
  or SPLIT, derived from the two parts. `bank_reference` is required when `bank_amount > 0`.

### Money

| Table | Purpose |
|---|---|
| `ledger_accounts` | One account per branch and kind: `CASH`, `BANK`, `FUNDS_IN_TRANSIT`, `HASAD_RECEIVABLE`, `OWED_TO_GM` (created for every branch, including new ones) |
| `ledger_entries` | Append-only signed entries. `event_type` and `payment_method`, a reference (`ref_type`, `ref_id`, `ref_number`), `reverses_entry_id`, the actor, the session, the idempotency key. A balance is the sum of its entries |
| `gm_funding_events` | Append-only (CSH-2, migration 0020), see below |
| `hasad_receivable_settlements` | Append-only: a Hasad bank transfer recorded, moving money from `HASAD_RECEIVABLE` to `BANK` |
| `cash_counts` | Append-only: a counted drawer amount against the expected amount, per business day |

**`gm_funding_events`** columns:

- `kind`: ADVANCE, REPAYMENT, or REVERSAL (a reversal points at the event it corrects, through `reverses_event_id`,
  and is allowed at most once per event);
- `account`: CASH or BANK;
- `amount` and `reason`;
- `bank_reference` (for BANK);
- `paid_directly_to_seller` and `linked_ref`, both for display only.

**Ledger event types and accounts:**

| Event type | Accounts |
|---|---|
| `SALE` | The payment method's account: CASH → `CASH`; BANK_TRANSFER, CARD, MOBILE_WALLET → `BANK`; HASAD → `HASAD_RECEIVABLE` |
| `SALE_VOID` | The reverse of the sale, on the same account |
| `SCRAP_PURCHASE` | `CASH` for the cash part, `BANK` for the bank part |
| `HASAD_RECEIVABLE_SETTLEMENT` | `HASAD_RECEIVABLE` −, `BANK` + |
| `GM_ADVANCE` | `CASH` or `BANK` +, `OWED_TO_GM` + |
| `GM_REPAYMENT` | `CASH` or `BANK` −, `OWED_TO_GM` − |
| `REVERSAL` | The mirror of the entries it reverses (a funding correction) |
| `SUPPLIER_MAKING_CHARGE` | Historical only; no longer written since MKC-1 |

`OWED_TO_GM` is a liability and never money. Every reader filters by account kind.

### Settings, audit and operations

| Table | Purpose |
|---|---|
| `settings` | One row per setting key, holding a JSON value and a version (`shared/src/settings.ts`) |
| `settings_history` | Append-only: old value, new value, version, who, reason |
| `gold_rates` | Append-only: the selling rate per karat and `kind` (`NEW` for supplier and opening pieces, `USED` for sellable scrap; PRC-1); the latest row per karat and kind is current |
| `branding_assets` | The logo: type, checksum, size |
| `audit_logs` | Append-only: user, role, branch, action, entity, `description_key` + `description_params`, metadata, IP, session |
| `backup_runs` | Append-only: backup and restore-drill runs |
| `document_sequences` | Number counters per scope |

## Append-only tables

These tables are protected by triggers (`jerp_forbid_modification`, against UPDATE, DELETE and TRUNCATE). On
PostgreSQL, the runtime role's privileges are also removed (`jerp_lock_append_only`):

`audit_logs`, `backup_runs`, `cash_counts`, `gm_funding_events`, `gold_rates`, `hasad_receivable_settlements`,
`inventory_movements`, `item_status_history`, `ledger_entries`, `scrap_purchases`, `scrap_rates`,
`scrap_weight_entries`, `settings_history`, `supplier_settlements`.

The start-up privilege report and the restore drill use the same list (`APPEND_ONLY_TABLES` in
`backend/src/core/startup.ts`); `backend/test/append-only-list.test.ts` fails if it differs from the migrations (CLN-1).

## Item lifecycle

```
(PURCHASED → RECEIVED) → AVAILABLE ─┬→ SOLD ──(void)──→ AVAILABLE
                                    ├→ TRANSFERRED → AVAILABLE   (at the receiving branch)
                                    ├→ DAMAGED ─┬→ AVAILABLE     (restock)
                                    │           └→ RETURNED      (to supplier)
                                    └→ RETURNED                  (to supplier)
```

`PURCHASED` and `RECEIVED` appear in the history only. Every transition goes through one guarded function, which runs
a conditional update on the current status.

## Traceability

- **Sales figure** → `sales` (COMPLETED) → `sale_items` → `jewelry_items` → `item_status_history`.
- **Stock figures** → `inventory_movements` summed with `direction`. Attention A15 flags a branch where this differs
  from its AVAILABLE pieces.
- **Stock weight** → the AVAILABLE pieces plus `scrap_weight_entries` (the pool).
- **Gold owed to a supplier** → `purchases.gold_owed_mg_pure24` → `supplier_settlements`.
- **Cash and bank** → `ledger_entries` per account → `ref_type` / `ref_id` → the business row and its audit entry.
- **Owed to the General Manager** → `OWED_TO_GM` entries → `gm_funding_events`.
- **Hasad** → sales with `payment_method = HASAD` → `HASAD_RECEIVABLE` → `hasad_receivable_settlements`.

## Migrations

| File | What it does |
|---|---|
| `0000_init` | Initial prototype schema |
| `0001_i18n_audit_customer` | Audit description key and params; Arabic customer name |
| `0002_auth_hardening` | Absolute session limit, re-confirmation time, CSRF token, lockout |
| `0003_settings_registry_branding` | Settings with versions and history; branding assets |
| `0004_integrity_foundation` | CHECK constraints, append-only triggers, idempotency keys |
| `0005_least_privilege_roles` | `jerp_lock_append_only`: privileges removed from the runtime role |
| `0006_cost_model_ledger` | Item origin and acquisition cost, sale-line profit, ledger accounts and entries, cash counts |
| `0007_scrap_supplier_settlement` | Scrap rates, scrap purchases, scrap pool, supplier settlements, gold owed, `HASAD_RECEIVABLE` |
| `0008_hasad_receivable_settlement` | Hasad receivable settlements |
| `0009_backups` | Backup runs |
| `0010_passkeys` | Passkeys, challenges, recovery codes, sign-in events, pending sign-ins |
| `0011_security_lock` | The account security lock |
| `0012_invoice_printing` | Original print time, reprint counter |
| `0013_remove_expenses` | REM-1: expenses permissions removed, new rows refused |
| `0014_hasad_sales_channel` | REM-2: Hasad is a payment method only; withdrawal workspace frozen |
| `0015_catalog_entry` | CAT-0: normalised unique names for types, products and suppliers (`jerp_normalize_name`) |
| `0016_rem5_drop_deprecated` | REM-5: drops expenses, Hasad withdrawal tables, `hasad_mock`, reservation and old cost columns |
| `0017_sale_price_change_reason` | SEC-2: the reason for a price change on a sale |
| `0018_bank_transfer_reference` | FIX-2: a bank-transfer sale requires its reference |
| `0019_transfer_courier` | FIX-1: the courier's name on a transfer |
| `0020_csh2_gm_funding` | CSH-2: `gm_funding_events`, the `OWED_TO_GM` account, `GM_ADVANCE` and `GM_REPAYMENT` |
| `0021_csh2_scrap_split_payment` | CSH-2: cash and bank parts and the bank reference on scrap purchases |
| `0022_mkc1_owner_making_charge` | MKC-1: making charge paid by the owner (`OWNER_PERSONAL`), reference and date; `purchases.create` for the General Manager only |
| `0023_be7_sale_items_sale_idx` | BE-7: index `sale_items(sale_id)` (the lines of a sale are read by sale: list pages, sale detail, void). Additive only |
| `0024_prc1_computed_prices` | PRC-1: `gold_rates.kind` (NEW/USED, validated check, index), permission `scrap.buy_sellable` (every role), and `pricing.mode = FIXED_TAG` written only when pieces already exist (an upgraded installation keeps its tag prices). Additive only |
