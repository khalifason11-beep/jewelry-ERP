// Database integrity rules (Phase 2a) — the single list of CHECK constraints the migrations must
// create. The SQL in database/migrations/0004_integrity_foundation.sql was generated from this list,
// and a test compares the live database with it: adding an enum value here (or in enums.ts) without
// a migration that updates the constraint fails the build.
//
// Status columns are TEXT + CHECK (col IN (…)) rather than PostgreSQL ENUM types: a CHECK can be
// added NOT VALID and validated without rewriting the table, and a value can later be added or
// retired with a plain forward migration (docs/decisions.md D-2a-1).

import {
  BRANDING_ASSET_KINDS,
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_SOURCES,
  EXPENSE_STATUSES,
  HASAD_EXTERNAL_STATUSES,
  HASAD_REDEMPTION_STATUSES,
  HASAD_WITHDRAWAL_STATUSES,
  IDEMPOTENCY_STATUSES,
  ITEM_ORIGINS,
  ITEM_HISTORY_STATUSES,
  ITEM_STATUSES,
  LEDGER_ACCOUNT_KINDS,
  LEDGER_EVENT_TYPES,
  MOVEMENT_TYPES,
  PAYMENT_METHODS,
  PRICING_MODES,
  PURCHASE_STATUSES,
  SALE_STATUSES,
  SESSION_STATUSES,
  SETTLEMENT_DIRECTIONS,
  SETTLEMENT_TYPES,
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
  e('expenses', 'status', EXPENSE_STATUSES),
  e('expenses', 'category', EXPENSE_CATEGORIES),
  e('transfers', 'status', TRANSFER_STATUSES),
  e('hasad_withdrawals', 'status', HASAD_WITHDRAWAL_STATUSES),
  e('hasad_withdrawals', 'external_status', HASAD_EXTERNAL_STATUSES),
  e('hasad_redemptions', 'status', HASAD_REDEMPTION_STATUSES),
  e('hasad_redemptions', 'settlement_direction', SETTLEMENT_DIRECTIONS, true),
  e('settlements', 'type', SETTLEMENT_TYPES),
  // A settlement row exists only when someone pays: NONE is not a valid direction here.
  e('settlements', 'direction', SETTLEMENT_DIRECTIONS.filter((d) => d !== 'NONE')),
  e('settlements', 'payment_method', PAYMENT_METHODS),
  e('branding_assets', 'kind', BRANDING_ASSET_KINDS),
  e('branding_assets', 'mime', ['image/png', 'image/jpeg', 'image/webp']),
  e('idempotency_keys', 'status', IDEMPOTENCY_STATUSES),
  // ── Phase 2b
  e('jewelry_items', 'origin', ITEM_ORIGINS),
  e('sale_items', 'pricing_mode', PRICING_MODES),
  e('expenses', 'paid_from', EXPENSE_PAYMENT_SOURCES, true),
  e('ledger_accounts', 'kind', LEDGER_ACCOUNT_KINDS),
  e('ledger_entries', 'event_type', LEDGER_EVENT_TYPES),
  e('ledger_entries', 'payment_method', PAYMENT_METHODS, true),
];

const nonNeg = (table: string, ...columns: string[]): ExprCheck[] =>
  columns.map((c) => ({ name: `ck_${table}_${c}_nonneg`, table, expr: `${c} >= 0` }));
const karat = (table: string, column = 'karat'): ExprCheck => ({ name: `ck_${table}_${column}_range`, table, expr: `${column} BETWEEN 1 AND 24` });

export const DB_EXPR_CHECKS: readonly ExprCheck[] = [
  // ── karats
  karat('products'),
  karat('jewelry_items'),
  karat('sale_items'),
  karat('hasad_withdrawals', 'entitlement_karat'),
  karat('hasad_redemption_items'),
  karat('gold_rates'),
  // ── weights (integer mg)
  ...nonNeg('jewelry_items', 'gross_weight_mg', 'net_weight_mg'),
  { name: 'ck_jewelry_items_net_le_gross', table: 'jewelry_items', expr: 'net_weight_mg <= gross_weight_mg' },
  ...nonNeg('inventory_movements', 'net_weight_mg'),
  ...nonNeg('purchases', 'total_net_weight_mg', 'item_count'),
  ...nonNeg('sale_items', 'net_weight_mg'),
  ...nonNeg('hasad_withdrawals', 'entitled_weight_mg'),
  ...nonNeg('hasad_redemptions', 'entitled_weight_mg', 'delivered_weight_mg'),
  ...nonNeg('hasad_redemption_items', 'net_weight_mg'),
  ...nonNeg('settlements', 'weight_mg'),
  // ── money (integer SDG)
  ...nonNeg('jewelry_items', 'purchase_cost', 'making_cost', 'other_cost', 'total_cost', 'selling_price'),
  { name: 'ck_jewelry_items_total_cost_sum', table: 'jewelry_items', expr: 'total_cost = purchase_cost + making_cost + other_cost' },
  ...nonNeg('inventory_movements', 'cost_value'),
  { name: 'ck_inventory_movements_direction', table: 'inventory_movements', expr: 'direction IN (-1, 1)' },
  ...nonNeg('purchases', 'total_cost'),
  ...nonNeg('purchase_items', 'purchase_cost', 'making_cost', 'other_cost'),
  ...nonNeg('sales', 'subtotal', 'discount_total', 'total', 'cost_total'),
  { name: 'ck_sales_total_sum', table: 'sales', expr: 'total = subtotal - discount_total' },
  ...nonNeg('sale_items', 'list_price', 'discount', 'final_price', 'unit_cost'),
  { name: 'ck_sale_items_final_price_sum', table: 'sale_items', expr: 'final_price = list_price - discount' },
  { name: 'ck_expenses_amount_positive', table: 'expenses', expr: 'amount > 0' },
  ...nonNeg('hasad_redemptions', 'settlement_amount', 'items_cost'),
  { name: 'ck_hasad_redemptions_rate_per_gram_nonneg', table: 'hasad_redemptions', expr: 'rate_per_gram IS NULL OR rate_per_gram >= 0' },
  ...nonNeg('hasad_redemption_items', 'unit_cost'),
  ...nonNeg('settlements', 'rate_per_gram', 'amount'),
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
];

/** The SQL expression for an enum check. */
export function enumCheckExpr(c: EnumCheck): string {
  const list = c.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  return c.nullable ? `${c.column} IS NULL OR ${c.column} IN (${list})` : `${c.column} IN (${list})`;
}
