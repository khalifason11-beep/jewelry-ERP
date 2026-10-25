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
| `jewelry_items` | One row per piece: code, barcode, type (`category_id`) and free-text `description` (CAT-1, 0026; the product is optional), karat, gross/net weight, `origin` (OPENING, SUPPLIER_NEW, SCRAP), `rate_kind` (NEW, USED: the selling rate that prices the piece; SCRAP → USED, SUPPLIER_NEW → NEW, an opening piece its line's condition, OPN-2), `acquisition_cost` (COST; NULL = unknown, an opening piece, OPN-1), `cost_is_estimated`, `making_charge` (COST), selling price, branch, status, `purchase_id` |
| `item_status_history` | Append-only: every status transition, with reference, user and note |
| `inventory_movements` | Append-only stock ledger: type (PURCHASE, SALE, TRANSFER_IN, TRANSFER_OUT, RETURN, ADJUSTMENT, DAMAGE), direction ±1, branch, reference, weight, cost value (NULL for a piece of unknown cost) |
| `openings` | OPN-1 (0026): one per branch (UNIQUE `branch_id`), DRAFT → SEALED once (`sealed_by`, `sealed_at`); never changed after the seal or deleted (trigger) |
| `opening_lines` | OPN-1: the draft, not stock: type, description, karat, `condition` (NEW, USED; required on every new line by the trigger, OPN-2; NULL only on lines sealed before OPN-2), weights, `source` (KEYBOARD, IMPORT), `import_id`, and `item_id` once sealed; no change to a sealed opening's lines (trigger) |
| `opening_piece_corrections` | OPN-FIX, append-only: a correction (condition, karat, weights) or a void of a piece of a sealed opening: before and after values, reason, who, when, the session and the branch the piece was in; the piece row carries the effective values (trigger: the piece is a line of that sealed opening) |
| `opening_imports` | OPN-1, append-only: each CSV file imported (name, SHA-256, rows, who, when); the same file twice changes nothing (UNIQUE `opening_id, sha256`) |
| `transfers`, `transfer_items` | Transfers between branches: IN_TRANSIT → RECEIVED, `courier_name` (0019) |

### Sales

| Table | Purpose |
|---|---|
| `sales` | The invoice header. Totals (`cost_total` = the lines of known cost, `unknown_cost_lines` = the others, OPN-1); `payment_method`; `payment_ref_invoice` and `payment_ref_transaction` (Hasad references; for a bank transfer the transfer reference, 0018); status COMPLETED / VOIDED with the void reason; `price_change_reason` (0017); print and reprint counters (0012) |
| `sale_payments` | PAY-1, append-only: how a sale was paid, **one or two lines** (one per method: `line_no`, `method`, `amount` > 0, `ref_invoice` = the Hasad invoice number, `ref_transaction` = the bank reference or Hasad's transaction reference) summing exactly to `sales.total`; `sales.payment_method` is the label (the method, or `SPLIT`). A HASAD line posts nothing to a branch account (the money is paid to the General Manager's account) |
| `sale_items` | Lines with snapshots: product name (and from 0026 its Arabic name, the type's names and the description, so a rename never rewrites an invoice), karat, weight, list price, discount, final price, `acquisition_cost` and `profit` (COST; NULL when the piece's cost is unknown), and `pricing_mode` (only FIXED_TAG is used) |

### Supplier orders and scrap

| Table | Purpose |
|---|---|
| `purchases` | The supplier order, recorded by the General Manager (see below) |
| `purchase_items` | One line per piece: `purchase_cost`, `making_cost`, `other_cost` (COST) |
| `supplier_settlements` | Append-only: a settlement visit, in which broken scrap (karat, weight, pure 24K) reduces `gold_owed_mg_pure24` |
| `scrap_rates` | Append-only rate history per karat; the latest row is current |
| `scrap_purchases` | Append-only: scrap bought from a customer (see below) |
| `scrap_weight_entries` | Append-only movements of the broken-scrap pool, per branch and karat (SCRAP_PURCHASE, SUPPLIER_SETTLEMENT, REVERSAL) |
| `scrap_purchase_voids` | Append-only (MIS-1, migration 0025): the void of a scrap purchase, at most one per purchase (`purchase_id` UNIQUE), with `reason`, `voided_by`, `session_id`, `created_at` |
| `purchase_corrections` | Append-only (MIS-1, migration 0025): corrections of a supplier order (see below) |

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

**`purchase_corrections`** columns (MIS-1):

- `field`: `MAKING_COST` (one piece: `purchase_item_id` names its line) or `MAKING_CHARGE_REFERENCE` (the order:
  `purchase_item_id` is NULL);
- `value_before` and `value_after` (text, COST; whole SDG for a making cost), `reason` (3–200), `confirmed_duplicate`,
  `corrected_by`, `session_id`, `created_at`.
- The **effective** value of a field is the latest correction of that (piece or order, field), else the original
  column. `purchases` and `purchase_items` are never updated; the order's making charge is the sum of its pieces'
  effective making costs. The supplier gold debt is never corrected.

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
`inventory_movements`, `item_status_history`, `ledger_entries`, `opening_imports`, `opening_piece_corrections`, `purchase_corrections`, `sale_payments`, `scrap_purchase_voids`,
`scrap_purchases`, `scrap_rates`, `scrap_weight_entries`, `settings_history`, `supplier_settlements`.

The start-up privilege report and the restore drill use the same list (`APPEND_ONLY_TABLES` in
`backend/src/core/startup.ts`); `backend/test/append-only-list.test.ts` fails if it differs from the migrations (CLN-1).

## Item lifecycle

```
(PURCHASED → RECEIVED) → AVAILABLE ─┬→ SOLD ──(void)──→ AVAILABLE
                                    ├→ TRANSFERRED → AVAILABLE   (at the receiving branch)
                                    ├→ DAMAGED ─┬→ AVAILABLE     (restock)
                                    │           └→ RETURNED      (to supplier)
                                    ├→ RETURNED                  (to supplier)
                                    └→ VOIDED                    (its scrap purchase voided, MIS-1; terminal)
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
| `0025_mis1_corrections` | MIS-1: append-only `scrap_purchase_voids` and `purchase_corrections`; piece status `VOIDED` (the three status checks widened, D-mis1-1); permissions `scrap.void` and `purchases.correct` (General Manager only). No row is changed |
| `0027_opn1_backfill` | OPN-1 / CAT-1: every piece gets its product's type; every sale line the Arabic product name and both type names, as they are at the upgrade (a guard stops the upgrade, changing nothing, if a row is left unfilled) |
| `0028_opn1_tighten` | OPN-1 / CAT-1: every piece's type becomes required; CHECK `ck_jewelry_items_cost_known`: only an opening piece (origin OPENING) may have an unknown cost (NULL, never 0). A row breaking either rule stops the upgrade with its count (none can exist after 0027) |
| `0029_opn2_condition` | OPN-2: `jewelry_items.rate_kind` and `opening_lines.condition` (NEW or USED, CHECKs; nullable until 0031); the opening-line trigger refuses a new line without a condition. Additive only |
| `0030_opn2_backfill` | OPN-2: every piece's `rate_kind` as it was priced before (SCRAP → USED, every other origin → NEW, D-opn2-3). A DRAFT opening that already has lines stops the upgrade, changing nothing, with its branch (D-opn2-2) |
| `0032_opnfix_corrections` | OPN-FIX: the append-only table `opening_piece_corrections` (CHECKs on kind, conditions, karats, weights, reason, and that a void changes nothing while a correction changes something; trigger: the piece is a line of that sealed opening) and the permission `opening.correct` (General Manager). Additive only |
| `0033_pay1_sale_payments` | PAY-1: the append-only table `sale_payments` (CHECKs on method, line number 1–2, amount > 0 and each method's references; UNIQUE per sale on line number and on method) and the `SPLIT` label added to `ck_sales_payment_method`. Additive only |
| `0034_pay1_backfill_payments` | PAY-1: one payment line per existing sale (its method, its whole total, its references). Two guards stop the upgrade, changing nothing: a sale that disagrees with its SALE ledger entries, and a sale that cannot make a valid line |
| `0035_pay1_tighten_payments` | PAY-1: at commit, every sale has 1 or 2 payment lines summing to its total and its label follows them (deferred constraint trigger `jerp_sale_payments_check`); `ck_sales_hasad_reference` and `ck_sales_bank_transfer_reference` are replaced by the lines' references check |
| `0031_opn2_tighten` | OPN-2: `rate_kind` becomes required (no default); CHECK `ck_jewelry_items_rate_kind_origin`: sellable scrap is USED, a supplier piece NEW (only an opening piece may be either). A row breaking either rule stops the upgrade with its count (none can exist after 0030) |
| `0026_opn1_catalog_optional` | OPN-1 / CAT-1: `jewelry_items.category_id` and `description`; the product and the cost become optional (DROP NOT NULL; 0028 tightens again); sale-line name snapshots; `sales.unknown_cost_lines`; the tables `openings`, `opening_lines`, `opening_imports`; permission `opening.manage` (General Manager). Additive only |
| `0024_prc1_computed_prices` | PRC-1: `gold_rates.kind` (NEW/USED, validated check, index), permission `scrap.buy_sellable` (every role), and `pricing.mode = FIXED_TAG` written only when pieces already exist (an upgraded installation keeps its tag prices). Additive only |
