// ERP data model (prototype). See docs/DATA_MODEL.md for the rationale.
// Conventions:
//   * weights are integer milligrams (`*_mg`), money is integer SDG (bigint, number mode)
//   * every business transaction has a human-readable number (e.g. KRT-S-000123)
//   * timestamps are timestamptz; business-day bucketing uses the configured timezone

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const money = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

// ───────────────────────────── Organisation & access ─────────────────────────────

export const branches = pgTable('branches', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  nameAr: text('name_ar').notNull(),
  city: text('city').notNull(),
  address: text('address'),
  phone: text('phone'),
  /** Branch identifier used by the Hasad Gold system. */
  hasadBranchCode: text('hasad_branch_code').unique(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const roles = pgTable('roles', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  nameAr: text('name_ar').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  /** Relative privilege level. Users can only manage users with a lower rank. */
  rank: smallint('rank').notNull().default(0),
});

export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: integer('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code').notNull().references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionCode] })],
);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  fullName: text('full_name').notNull(),
  fullNameAr: text('full_name_ar'),
  roleId: integer('role_id').notNull().references(() => roles.id),
  /** Null only for company-wide roles (General Manager). */
  branchId: integer('branch_id').references(() => branches.id),
  /** scrypt hash — plaintext passwords are never stored or returned. */
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  passwordChangedAt: ts('password_changed_at'),
  status: text('status').notNull().default('ACTIVE'),
  phone: text('phone'),
  lastLoginAt: ts('last_login_at'),
  createdAt: createdAt(),
  createdBy: integer('created_by'),
});

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the session token; the raw token only lives in the user's cookie. */
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    branchId: integer('branch_id').references(() => branches.id),
    loginAt: ts('login_at').notNull().defaultNow(),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    userAgent: text('user_agent'),
    device: text('device'),
    ipAddress: text('ip_address'),
    currentModule: text('current_module'),
    status: text('status').notNull().default('ACTIVE'),
    endedAt: ts('ended_at'),
    endedReason: text('ended_reason'),
    /** Demo-only presence rows created by the seed (clearly labelled in the UI). */
    isSimulated: boolean('is_simulated').notNull().default(false),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_status_idx').on(t.status)],
);

// ───────────────────────────── Catalogue & inventory ─────────────────────────────

export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  nameAr: text('name_ar').notNull(),
});

/** A design/model. Physical pieces are `jewelry_items`. */
export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  nameAr: text('name_ar').notNull(),
  categoryId: integer('category_id').notNull().references(() => categories.id),
  karat: smallint('karat').notNull(),
  description: text('description'),
  createdAt: createdAt(),
});

export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  phone: text('phone'),
});

export const jewelryItems = pgTable(
  'jewelry_items',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),
    barcode: text('barcode').notNull().unique(),
    productId: integer('product_id').notNull().references(() => products.id),
    karat: smallint('karat').notNull(),
    grossWeightMg: integer('gross_weight_mg').notNull(),
    netWeightMg: integer('net_weight_mg').notNull(),
    // Cost components are kept separate: the client will define later what "cost" includes.
    purchaseCost: money('purchase_cost').notNull(),
    makingCost: money('making_cost').notNull().default(0),
    otherCost: money('other_cost').notNull().default(0),
    totalCost: money('total_cost').notNull(),
    sellingPrice: money('selling_price').notNull(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    status: text('status').notNull(),
    purchaseId: integer('purchase_id'),
    /** Set while RESERVED: what the reservation is for (e.g. HASAD_REDEMPTION:12). */
    reservationRef: text('reservation_ref'),
    reservedAt: ts('reserved_at'),
    reservedBy: integer('reserved_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('items_branch_status_idx').on(t.branchId, t.status),
    index('items_product_idx').on(t.productId),
  ],
);

/** Every status transition of every item — the item's lifecycle. */
export const itemStatusHistory = pgTable(
  'item_status_history',
  {
    id: serial('id').primaryKey(),
    itemId: integer('item_id').notNull().references(() => jewelryItems.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    refType: text('ref_type'),
    refId: integer('ref_id'),
    refNumber: text('ref_number'),
    userId: integer('user_id').references(() => users.id),
    note: text('note'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('ish_item_idx').on(t.itemId)],
);

/** Inventory ledger. Stock figures are derived from this table. */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: serial('id').primaryKey(),
    itemId: integer('item_id').notNull().references(() => jewelryItems.id),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    type: text('type').notNull(),
    /** +1 into branch stock, −1 out of branch stock. */
    direction: smallint('direction').notNull(),
    fromBranchId: integer('from_branch_id').references(() => branches.id),
    toBranchId: integer('to_branch_id').references(() => branches.id),
    refType: text('ref_type'),
    refId: integer('ref_id'),
    refNumber: text('ref_number'),
    netWeightMg: integer('net_weight_mg').notNull(),
    costValue: money('cost_value').notNull(),
    userId: integer('user_id').references(() => users.id),
    note: text('note'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    index('mov_branch_at_idx').on(t.branchId, t.at),
    index('mov_item_idx').on(t.itemId),
  ],
);

// ───────────────────────────── Purchases ─────────────────────────────

export const purchases = pgTable('purchases', {
  id: serial('id').primaryKey(),
  number: text('number').notNull().unique(),
  branchId: integer('branch_id').notNull().references(() => branches.id),
  supplierId: integer('supplier_id').references(() => suppliers.id),
  supplierInvoiceNo: text('supplier_invoice_no'),
  status: text('status').notNull().default('RECEIVED'),
  itemCount: integer('item_count').notNull(),
  totalNetWeightMg: integer('total_net_weight_mg').notNull(),
  totalCost: money('total_cost').notNull(),
  notes: text('notes'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
});

export const purchaseItems = pgTable('purchase_items', {
  id: serial('id').primaryKey(),
  purchaseId: integer('purchase_id').notNull().references(() => purchases.id),
  itemId: integer('item_id').notNull().references(() => jewelryItems.id),
  purchaseCost: money('purchase_cost').notNull(),
  makingCost: money('making_cost').notNull(),
  otherCost: money('other_cost').notNull(),
});

// ───────────────────────────── Sales ─────────────────────────────

export const sales = pgTable(
  'sales',
  {
    id: serial('id').primaryKey(),
    number: text('number').notNull().unique(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    cashierId: integer('cashier_id').notNull().references(() => users.id),
    sessionId: text('session_id'),
    customerName: text('customer_name'),
    customerNameAr: text('customer_name_ar'),
    customerPhone: text('customer_phone'),
    subtotal: money('subtotal').notNull(),
    discountTotal: money('discount_total').notNull().default(0),
    total: money('total').notNull(),
    /** Snapshot of Σ item total cost at the time of sale. */
    costTotal: money('cost_total').notNull(),
    paymentMethod: text('payment_method').notNull(),
    status: text('status').notNull().default('COMPLETED'),
    voidedAt: ts('voided_at'),
    voidedBy: integer('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('sales_branch_at_idx').on(t.branchId, t.createdAt)],
);

export const saleItems = pgTable('sale_items', {
  id: serial('id').primaryKey(),
  saleId: integer('sale_id').notNull().references(() => sales.id),
  itemId: integer('item_id').notNull().references(() => jewelryItems.id),
  productName: text('product_name').notNull(),
  karat: smallint('karat').notNull(),
  netWeightMg: integer('net_weight_mg').notNull(),
  listPrice: money('list_price').notNull(),
  discount: money('discount').notNull().default(0),
  finalPrice: money('final_price').notNull(),
  /** Cost snapshot so later cost edits never rewrite historical profit. */
  unitCost: money('unit_cost').notNull(),
});

// ───────────────────────────── Expenses ─────────────────────────────

export const expenses = pgTable(
  'expenses',
  {
    id: serial('id').primaryKey(),
    number: text('number').notNull().unique(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    category: text('category').notNull(),
    amount: money('amount').notNull(),
    expenseDate: date('expense_date', { mode: 'string' }).notNull(),
    description: text('description').notNull(),
    status: text('status').notNull(),
    createdBy: integer('created_by').notNull().references(() => users.id),
    createdAt: createdAt(),
    reviewedBy: integer('reviewed_by').references(() => users.id),
    reviewedAt: ts('reviewed_at'),
    reviewNote: text('review_note'),
  },
  (t) => [index('exp_branch_date_idx').on(t.branchId, t.expenseDate)],
);

// ───────────────────────────── Transfers ─────────────────────────────

export const transfers = pgTable('transfers', {
  id: serial('id').primaryKey(),
  number: text('number').notNull().unique(),
  fromBranchId: integer('from_branch_id').notNull().references(() => branches.id),
  toBranchId: integer('to_branch_id').notNull().references(() => branches.id),
  status: text('status').notNull(),
  notes: text('notes'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
  receivedBy: integer('received_by').references(() => users.id),
  receivedAt: ts('received_at'),
});

export const transferItems = pgTable(
  'transfer_items',
  {
    transferId: integer('transfer_id').notNull().references(() => transfers.id),
    itemId: integer('item_id').notNull().references(() => jewelryItems.id),
  },
  (t) => [primaryKey({ columns: [t.transferId, t.itemId] })],
);

// ───────────────────────────── Hasad Gold (ERP side) ─────────────────────────────

/** ERP mirror of withdrawal requests received from Hasad Gold. Never touches inventory. */
export const hasadWithdrawals = pgTable(
  'hasad_withdrawals',
  {
    id: serial('id').primaryKey(),
    externalId: text('external_id').notNull().unique(),
    hasadCustomerId: text('hasad_customer_id').notNull(),
    customerName: text('customer_name').notNull(),
    customerNameAr: text('customer_name_ar'),
    customerPhone: text('customer_phone'),
    customerNationalIdMasked: text('customer_national_id_masked'),
    entitledWeightMg: integer('entitled_weight_mg').notNull(),
    entitlementKarat: smallint('entitlement_karat').notNull(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    status: text('status').notNull(),
    externalStatus: text('external_status').notNull(),
    pickupCode: text('pickup_code'),
    requestedAt: ts('requested_at').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    openedAt: ts('opened_at'),
    openedBy: integer('opened_by').references(() => users.id),
    completedAt: ts('completed_at'),
    completedBy: integer('completed_by').references(() => users.id),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: integer('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
    lastSyncedAt: ts('last_synced_at').notNull().defaultNow(),
  },
  (t) => [index('hw_branch_status_idx').on(t.branchId, t.status)],
);

/** A counter visit in which the customer picks pieces against a withdrawal. */
export const hasadRedemptions = pgTable('hasad_redemptions', {
  id: serial('id').primaryKey(),
  number: text('number').notNull().unique(),
  withdrawalId: integer('withdrawal_id').notNull().references(() => hasadWithdrawals.id),
  branchId: integer('branch_id').notNull().references(() => branches.id),
  cashierId: integer('cashier_id').notNull().references(() => users.id),
  status: text('status').notNull(),
  entitledWeightMg: integer('entitled_weight_mg').notNull(),
  deliveredWeightMg: integer('delivered_weight_mg').notNull().default(0),
  differenceMg: integer('difference_mg').notNull().default(0),
  settlementDirection: text('settlement_direction'),
  settlementAmount: money('settlement_amount').notNull().default(0),
  ratePerGram: money('rate_per_gram'),
  itemsCost: money('items_cost').notNull().default(0),
  customerVerified: boolean('customer_verified').notNull().default(false),
  createdAt: createdAt(),
  completedAt: ts('completed_at'),
  abortedAt: ts('aborted_at'),
  abortReason: text('abort_reason'),
});

export const hasadRedemptionItems = pgTable(
  'hasad_redemption_items',
  {
    id: serial('id').primaryKey(),
    redemptionId: integer('redemption_id').notNull().references(() => hasadRedemptions.id),
    itemId: integer('item_id').notNull().references(() => jewelryItems.id),
    netWeightMg: integer('net_weight_mg').notNull(),
    karat: smallint('karat').notNull(),
    unitCost: money('unit_cost').notNull(),
    /** false once the item was released back (customer changed their mind). */
    active: boolean('active').notNull().default(true),
    addedAt: ts('added_at').notNull().defaultNow(),
    releasedAt: ts('released_at'),
  },
  (t) => [index('hri_redemption_idx').on(t.redemptionId)],
);

/** Money settled at the counter (currently only Hasad weight differences). */
export const settlements = pgTable('settlements', {
  id: serial('id').primaryKey(),
  number: text('number').notNull().unique(),
  type: text('type').notNull(),
  redemptionId: integer('redemption_id').references(() => hasadRedemptions.id),
  branchId: integer('branch_id').notNull().references(() => branches.id),
  direction: text('direction').notNull(),
  weightMg: integer('weight_mg').notNull(),
  ratePerGram: money('rate_per_gram').notNull(),
  amount: money('amount').notNull(),
  paymentMethod: text('payment_method').notNull(),
  confirmedBy: integer('confirmed_by').notNull().references(() => users.id),
  confirmedAt: ts('confirmed_at').notNull().defaultNow(),
});

// ───────────────────────────── Configuration & audit ─────────────────────────────

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: integer('updated_by'),
});

/** Gold rate history; the latest row per karat is the current rate. */
export const goldRates = pgTable(
  'gold_rates',
  {
    id: serial('id').primaryKey(),
    karat: smallint('karat').notNull(),
    pricePerGram: money('price_per_gram').notNull(),
    effectiveAt: ts('effective_at').notNull().defaultNow(),
    setBy: integer('set_by'),
  },
  (t) => [index('gold_rates_karat_idx').on(t.karat, t.effectiveAt)],
);

/** Sequential document numbers per branch & document type. */
export const documentSequences = pgTable(
  'document_sequences',
  {
    scope: text('scope').notNull(),
    next: integer('next').notNull(),
  },
  (t) => [uniqueIndex('doc_seq_scope_idx').on(t.scope)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    at: ts('at').notNull().defaultNow(),
    userId: integer('user_id'),
    username: text('username'),
    userFullName: text('user_full_name'),
    role: text('role'),
    branchId: integer('branch_id'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    description: text('description').notNull(),
    /** Translation key (English template) + typed params; `description` is the English rendering. */
    descriptionKey: text('description_key'),
    descriptionParams: jsonb('description_params'),
    metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
    sessionId: text('session_id'),
    ipAddress: text('ip_address'),
  },
  (t) => [index('audit_at_idx').on(t.at), index('audit_branch_idx').on(t.branchId), index('audit_action_idx').on(t.action)],
);
