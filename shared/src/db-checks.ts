// Database integrity rules (Phase 2a) — the single list of CHECK constraints the migrations must
// create. The SQL in database/migrations/0004_integrity_foundation.sql was generated from this list,
// and a test compares the live database with it: adding an enum value here (or in enums.ts) without
// a migration that updates the constraint fails the build.
//
// Status columns are TEXT + CHECK (col IN (…)) rather than PostgreSQL ENUM types: a CHECK can be
// added NOT VALID and validated without rewriting the table, and a value can later be added or
// retired with a plain forward migration (docs/decisions.md D-2a-1).

import {
  SIGN_IN_METHODS,
  WEBAUTHN_CHALLENGE_PURPOSES,
  BACKUP_RUN_KINDS,
  BACKUP_RUN_STATUSES,
  BRANDING_ASSET_KINDS,
  CASH_OR_BANK,
  MAKING_CHARGE_PAYERS,
  GM_FUNDING_KINDS,
  GOLD_RATE_KINDS,
  IDEMPOTENCY_STATUSES,
  ITEM_ORIGINS,
  ITEM_HISTORY_STATUSES,
  ITEM_STATUSES,
  LEDGER_ACCOUNT_KINDS,
  LEDGER_EVENT_TYPES,
  MOVEMENT_TYPES,
  PAYMENT_METHODS,
  PRICING_MODES,
  SCRAP_KINDS,
  SCRAP_PAYMENT_METHODS,
  SCRAP_WEIGHT_EVENT_TYPES,
  PURCHASE_CORRECTION_FIELDS,
  OPENING_LINE_SOURCES,
  OPENING_STATUSES,
  PURCHASE_STATUSES,
  SALE_STATUSES,
  SESSION_STATUSES,
  TRANSFER_STATUSES,
  USER_STATUSES,
} from './enums';

export interface EnumCheck {
  name: string;
  table: string;
  column: string;
  values: readonly string[];
  /** NULL is allowed (the column is optional). */
  nullable?: boolean;
}

export interface ExprCheck {
  name: string;
  table: string;
  /** SQL boolean expression over the table's columns. */
  expr: string;
}

const e = (table: string, column: string, values: readonly string[], nullable = false): EnumCheck => ({
  name: `ck_${table}_${column}`,
  table,
  column,
  values,
  nullable,
});

export const DB_ENUM_CHECKS: readonly EnumCheck[] = [
  e('users', 'status', USER_STATUSES),
  e('sessions', 'status', SESSION_STATUSES),
  e('jewelry_items', 'status', ITEM_STATUSES),
  e('item_status_history', 'from_status', ITEM_HISTORY_STATUSES, true),
  e('item_status_history', 'to_status', ITEM_HISTORY_STATUSES),
  e('inventory_movements', 'type', MOVEMENT_TYPES),
  e('purchases', 'status', PURCHASE_STATUSES),
  e('sales', 'status', SALE_STATUSES),
  e('sales', 'payment_method', PAYMENT_METHODS),
  e('transfers', 'status', TRANSFER_STATUSES),
  e('branding_assets', 'kind', BRANDING_ASSET_KINDS),
  e('branding_assets', 'mime', ['image/png', 'image/jpeg', 'image/webp']),
  e('idempotency_keys', 'status', IDEMPOTENCY_STATUSES),
  // ── Phase 2b
  e('jewelry_items', 'origin', ITEM_ORIGINS),
  e('sale_items', 'pricing_mode', PRICING_MODES),
  // PRC-1 (D-prc1-2, migration 0024)
  e('gold_rates', 'kind', GOLD_RATE_KINDS),
  e('ledger_accounts', 'kind', LEDGER_ACCOUNT_KINDS),
  e('ledger_entries', 'event_type', LEDGER_EVENT_TYPES),
  e('ledger_entries', 'payment_method', PAYMENT_METHODS, true),
  // ── Phase 4
  e('sessions', 'sign_in_method', SIGN_IN_METHODS),
  e('sign_in_events', 'method', SIGN_IN_METHODS),
  e('webauthn_challenges', 'purpose', WEBAUTHN_CHALLENGE_PURPOSES),
  e('backup_runs', 'kind', BACKUP_RUN_KINDS),
  e('backup_runs', 'status', BACKUP_RUN_STATUSES),
  e('scrap_purchases', 'kind', SCRAP_KINDS),
  e('scrap_purchases', 'payment_method', SCRAP_PAYMENT_METHODS),
  e('scrap_weight_entries', 'event_type', SCRAP_WEIGHT_EVENT_TYPES),
  e('purchases', 'making_charge_paid_from', MAKING_CHARGE_PAYERS, true),
  // ── CSH-2: GM funding (migration 0020)
  e('gm_funding_events', 'kind', GM_FUNDING_KINDS),
  e('gm_funding_events', 'account', CASH_OR_BANK),
  // ── MIS-1: supplier-order corrections (migration 0025; VOIDED reaches the piece status checks through ITEM_STATUSES)
  e('purchase_corrections', 'field', PURCHASE_CORRECTION_FIELDS),
  // ── OPN-1: the opening balance (migration 0026)
  e('openings', 'status', OPENING_STATUSES),
  e('opening_lines', 'source', OPENING_LINE_SOURCES),
];

const nonNeg = (table: string, ...columns: string[]): ExprCheck[] =>
  columns.map((c) => ({ name: `ck_${table}_${c}_nonneg`, table, expr: `${c} >= 0` }));
const karat = (table: string, column = 'karat'): ExprCheck => ({ name: `ck_${table}_${column}_range`, table, expr: `${column} BETWEEN 1 AND 24` });

export const DB_EXPR_CHECKS: readonly ExprCheck[] = [
  // ── karats
  karat('products'),
  karat('jewelry_items'),
  karat('sale_items'),
  karat('gold_rates'),
  // ── weights (integer mg)
  ...nonNeg('jewelry_items', 'gross_weight_mg', 'net_weight_mg'),
  { name: 'ck_jewelry_items_net_le_gross', table: 'jewelry_items', expr: 'net_weight_mg <= gross_weight_mg' },
  ...nonNeg('inventory_movements', 'net_weight_mg'),
  ...nonNeg('purchases', 'total_net_weight_mg', 'item_count'),
  ...nonNeg('sale_items', 'net_weight_mg'),
  // ── money (integer SDG)
  ...nonNeg('jewelry_items', 'selling_price'),
  ...nonNeg('inventory_movements', 'cost_value'),
  { name: 'ck_inventory_movements_direction', table: 'inventory_movements', expr: 'direction IN (-1, 1)' },
  ...nonNeg('purchases', 'total_cost'),
  ...nonNeg('purchase_items', 'purchase_cost', 'making_cost', 'other_cost'),
  ...nonNeg('sales', 'subtotal', 'discount_total', 'total', 'cost_total'),
  { name: 'ck_sales_total_sum', table: 'sales', expr: 'total = subtotal - discount_total' },
  ...nonNeg('sale_items', 'list_price', 'discount', 'final_price', 'unit_cost'),
  { name: 'ck_sale_items_final_price_sum', table: 'sale_items', expr: 'final_price = list_price - discount' },
  ...nonNeg('gold_rates', 'price_per_gram'),
  // ── other invariants
  { name: 'ck_transfers_distinct_branches', table: 'transfers', expr: 'from_branch_id <> to_branch_id' },
  ...nonNeg('users', 'failed_login_count'),
  ...nonNeg('branding_assets', 'size', 'width', 'height'),
  // ── Phase 2b: cost model, sale-line profit, ledger
  ...nonNeg('jewelry_items', 'acquisition_cost', 'making_charge'),
  {
    name: 'ck_jewelry_items_making_in_acquisition',
    table: 'jewelry_items',
    // Q3: for supplier pieces the making charge is part of the acquisition cost.
    expr: "origin <> 'SUPPLIER_NEW' OR making_charge <= acquisition_cost",
  },
  ...nonNeg('sale_items', 'acquisition_cost'),
  { name: 'ck_sale_items_profit_sum', table: 'sale_items', expr: 'profit = final_price - acquisition_cost' },
  { name: 'ck_sale_items_price_components_nonneg', table: 'sale_items', expr: 'coalesce(price_gold_value, 0) >= 0 AND coalesce(price_making_charge, 0) >= 0 AND coalesce(price_rate_per_gram, 0) >= 0' },
  { name: 'ck_ledger_entries_amount_nonzero', table: 'ledger_entries', expr: 'amount <> 0' },
  {
    name: 'ck_ledger_entries_reversal_type',
    table: 'ledger_entries',
    // Only a void or an explicit reversal may reverse an entry; a REVERSAL must say which one. A void
    // of a sale recorded before the ledger existed has nothing to reverse but still refunds money.
    expr: "(reverses_entry_id IS NULL OR event_type IN ('SALE_VOID', 'REVERSAL')) AND (event_type <> 'REVERSAL' OR reverses_entry_id IS NOT NULL)",
  },
  ...nonNeg('cash_counts', 'counted_amount'),
  // ── Phase 4: scrap gold, the broken-scrap pool, supplier gold debt, Hasad payments
  karat('scrap_rates'),
  ...nonNeg('scrap_rates', 'price_per_gram'),
  karat('scrap_purchases'),
  ...nonNeg('scrap_purchases', 'gross_weight_mg', 'scrap_rate_per_gram', 'agreed_rate_per_gram', 'deviation_bp', 'amount'),
  { name: 'ck_scrap_purchases_net_positive', table: 'scrap_purchases', expr: 'net_weight_mg > 0 AND net_weight_mg <= gross_weight_mg' },
  { name: 'ck_scrap_purchases_item_iff_sellable', table: 'scrap_purchases', expr: "(kind = 'SELLABLE') = (item_id IS NOT NULL)" },
  karat('scrap_weight_entries'),
  { name: 'ck_scrap_weight_entries_weight_nonzero', table: 'scrap_weight_entries', expr: 'weight_mg <> 0' },
  karat('supplier_settlements', 'settled_karat'),
  { name: 'ck_supplier_settlements_positive', table: 'supplier_settlements', expr: 'settled_weight_mg > 0 AND settled_pure_mg24 > 0' },
  { name: 'ck_purchases_gold_debt_pair', table: 'purchases', expr: '(gold_debt_mg_pure24 IS NULL) = (gold_owed_mg_pure24 IS NULL)' },
  { name: 'ck_purchases_gold_owed_range', table: 'purchases', expr: 'gold_owed_mg_pure24 IS NULL OR (gold_owed_mg_pure24 >= 0 AND gold_owed_mg_pure24 <= gold_debt_mg_pure24)' },
  { name: 'ck_purchases_making_charge_paid', table: 'purchases', expr: '(making_charge_paid IS NULL) = (making_charge_paid_from IS NULL) AND coalesce(making_charge_paid, 0) >= 0' },
  // MKC-1 (D-mkc-3): a making charge above 0 carries the owner's transfer reference (FIX-2 rules) and its date; 0 carries neither.
  {
    name: 'ck_purchases_making_charge_transfer',
    table: 'purchases',
    expr: '(coalesce(making_charge_paid, 0) = 0 AND making_charge_reference IS NULL AND making_charge_transfer_date IS NULL) OR (making_charge_paid > 0 AND making_charge_reference IS NOT NULL AND length(btrim(making_charge_reference)) BETWEEN 4 AND 40 AND making_charge_transfer_date IS NOT NULL)',
  },
  // ── Phase 4 follow-up: Hasad receivable settled by bank transfer
  { name: 'ck_hasad_receivable_settlements_amount_positive', table: 'hasad_receivable_settlements', expr: 'amount > 0' },
  // ── Phase 2fa: passkeys
  { name: 'ck_webauthn_challenges_binding', table: 'webauthn_challenges', expr: '(session_id IS NOT NULL) <> (pending_id IS NOT NULL)' },
  { name: 'ck_webauthn_credentials_nickname', table: 'webauthn_credentials', expr: 'length(btrim(nickname)) BETWEEN 1 AND 60' },
  { name: 'ck_webauthn_credentials_sign_count_nonneg', table: 'webauthn_credentials', expr: 'sign_count >= 0' },
  { name: 'ck_users_mfa_failed_count_nonneg', table: 'users', expr: 'mfa_failed_count >= 0' },
  { name: 'ck_sales_reprint_count_nonneg', table: 'sales', expr: 'reprint_count >= 0' },
  { name: 'ck_users_security_lock_reason', table: 'users', expr: '(security_locked_at IS NULL) = (security_lock_reason IS NULL)' },
  // ── Phase 2c: backups
  { name: 'ck_backup_runs_size_nonneg', table: 'backup_runs', expr: 'size_bytes IS NULL OR size_bytes >= 0' },
  { name: 'ck_backup_runs_finished_after_start', table: 'backup_runs', expr: 'finished_at >= started_at' },
  { name: 'ck_sales_hasad_reference', table: 'sales', expr: "payment_method <> 'HASAD' OR payment_ref_invoice IS NOT NULL" },
  // ── CAT-0: names entered by people (migration 0015)
  { name: 'ck_suppliers_has_name', table: 'suppliers', expr: "coalesce(nullif(btrim(name_ar), ''), nullif(btrim(name), '')) IS NOT NULL" },
  { name: 'ck_categories_name_ar_not_blank', table: 'categories', expr: "btrim(name_ar) <> ''" },
  { name: 'ck_products_name_ar_not_blank', table: 'products', expr: "btrim(name_ar) <> ''" },
  // ── FIX-1: the courier's name on a transfer (migration 0019)
  { name: 'ck_transfers_courier_name', table: 'transfers', expr: 'courier_name IS NULL OR length(btrim(courier_name)) BETWEEN 2 AND 80' },
  // ── SEC-2: the price-change reason (migration 0017)
  // ── FIX-2: a bank-transfer sale carries its bank reference (migration 0018, validated after a guard)
  { name: 'ck_sales_bank_transfer_reference', table: 'sales', expr: "payment_method <> 'BANK_TRANSFER' OR (payment_ref_transaction IS NOT NULL AND length(btrim(payment_ref_transaction)) BETWEEN 4 AND 40)" },
  { name: 'ck_sales_price_change_reason', table: 'sales', expr: 'price_change_reason IS NULL OR length(btrim(price_change_reason)) BETWEEN 3 AND 200' },
  // ── CSH-2 piece A: split payment on counter scrap purchases (migration 0021, validated after two guards)
  { name: 'ck_scrap_purchases_payment_parts', table: 'scrap_purchases', expr: 'cash_amount >= 0 AND bank_amount >= 0 AND cash_amount + bank_amount = amount' },
  {
    name: 'ck_scrap_purchases_payment_label',
    table: 'scrap_purchases',
    expr: "(payment_method = 'CASH' AND bank_amount = 0) OR (payment_method = 'BANK_TRANSFER' AND cash_amount = 0) OR (payment_method = 'SPLIT' AND cash_amount > 0 AND bank_amount > 0)",
  },
  { name: 'ck_scrap_purchases_bank_reference', table: 'scrap_purchases', expr: 'bank_amount = 0 OR (bank_reference IS NOT NULL AND length(btrim(bank_reference)) BETWEEN 4 AND 40)' },
  // ── CSH-2: GM funding events (migration 0020)
  { name: 'ck_gm_funding_events_amount_positive', table: 'gm_funding_events', expr: 'amount > 0' },
  { name: 'ck_gm_funding_events_reason', table: 'gm_funding_events', expr: 'length(btrim(reason)) BETWEEN 3 AND 300' },
  {
    name: 'ck_gm_funding_events_reversal',
    table: 'gm_funding_events',
    // A correction says which event it corrects; an advance or a repayment never does.
    expr: "(kind = 'REVERSAL') = (reverses_event_id IS NOT NULL)",
  },
  {
    name: 'ck_gm_funding_events_bank_reference',
    table: 'gm_funding_events',
    // A movement on the bank account carries the bank's reference (FIX-2 rules); a correction repeats none.
    expr: "kind = 'REVERSAL' OR account <> 'BANK' OR (bank_reference IS NOT NULL AND length(btrim(bank_reference)) BETWEEN 4 AND 40)",
  },
  { name: 'ck_gm_funding_events_linked_ref', table: 'gm_funding_events', expr: 'linked_ref IS NULL OR length(btrim(linked_ref)) BETWEEN 3 AND 40' },
  // ── MIS-1: scrap-purchase voids and supplier-order corrections (migration 0025)
  { name: 'ck_scrap_purchase_voids_reason', table: 'scrap_purchase_voids', expr: 'length(btrim(reason)) BETWEEN 3 AND 200' },
  { name: 'ck_purchase_corrections_reason', table: 'purchase_corrections', expr: 'length(btrim(reason)) BETWEEN 3 AND 200' },
  // A piece's making cost names its line; the order's transfer reference names none.
  { name: 'ck_purchase_corrections_item', table: 'purchase_corrections', expr: "(field = 'MAKING_COST') = (purchase_item_id IS NOT NULL)" },
  { name: 'ck_purchase_corrections_making_cost', table: 'purchase_corrections', expr: "field <> 'MAKING_COST' OR value_after ~ '^(0|[1-9][0-9]{0,14})$'" },
  { name: 'ck_purchase_corrections_reference', table: 'purchase_corrections', expr: "field <> 'MAKING_CHARGE_REFERENCE' OR length(btrim(value_after)) BETWEEN 4 AND 40" },
  // ── OPN-1 / CAT-1: optional product, unknown cost, the opening balance (migration 0026)
  { name: 'ck_jewelry_items_description', table: 'jewelry_items', expr: 'description IS NULL OR length(btrim(description)) BETWEEN 1 AND 120' },
  { name: 'ck_sales_unknown_cost_lines_nonneg', table: 'sales', expr: 'unknown_cost_lines >= 0' },
  { name: 'ck_openings_sealed', table: 'openings', expr: "(status = 'SEALED') = (sealed_at IS NOT NULL AND sealed_by IS NOT NULL)" },
  karat('opening_lines'),
  { name: 'ck_opening_lines_weights', table: 'opening_lines', expr: 'net_weight_mg > 0 AND net_weight_mg <= gross_weight_mg' },
  { name: 'ck_opening_lines_description', table: 'opening_lines', expr: 'description IS NULL OR length(btrim(description)) BETWEEN 1 AND 120' },
  { name: 'ck_opening_lines_import', table: 'opening_lines', expr: "(source = 'IMPORT') = (import_id IS NOT NULL)" },
  // ── OPN-1 (migration 0028): only an opening piece may have an unknown cost (D-dec1-3: NULL, never 0).
  { name: 'ck_jewelry_items_cost_known', table: 'jewelry_items', expr: "acquisition_cost IS NOT NULL OR origin = 'OPENING'" },
  { name: 'ck_opening_imports_row_count', table: 'opening_imports', expr: 'row_count > 0' },
  { name: 'ck_opening_imports_sha256', table: 'opening_imports', expr: "sha256 ~ '^[0-9a-f]{64}$'" },
];

/** The SQL expression for an enum check. */
export function enumCheckExpr(c: EnumCheck): string {
  const list = c.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  return c.nullable ? `${c.column} IS NULL OR ${c.column} IN (${list})` : `${c.column} IN (${list})`;
}
