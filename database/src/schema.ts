// ERP data model (prototype). See docs/DATA_MODEL.md for the rationale.
// Conventions:
//   * weights are integer milligrams (`*_mg`), money is integer SDG (bigint, number mode)
//   * every business transaction has a human-readable number (e.g. KRT-S-000123)
//   * timestamps are timestamptz; business-day bucketing uses the configured timezone

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
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
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });
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
  /** Consecutive failed sign-ins since the last success (drives the progressive lockout). */
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  /** Sign-in refused until this instant (null = not locked). */
  lockedUntil: ts('locked_until'),
  createdAt: createdAt(),
  createdBy: integer('created_by'),
  // ── Second factor (Phase 2fa)
  /** Random WebAuthn user handle (never the database id or the username). */
  webauthnUserHandle: text('webauthn_user_handle').unique(),
  /** Consecutive failed second-factor attempts (same reserve-then-verify lockout as passwords). */
  mfaFailedCount: integer('mfa_failed_count').notNull().default(0),
  mfaLockedUntil: ts('mfa_locked_until'),
  /** When the current set of recovery codes was generated, and when the user confirmed saving it. */
  recoveryCodesGeneratedAt: ts('recovery_codes_generated_at'),
  recoveryCodesAcknowledgedAt: ts('recovery_codes_acknowledged_at'),
  /** Security lock (D-2fa-13): every sign-in refused until the operator console lifts it. */
  securityLockedAt: ts('security_locked_at'),
  securityLockReason: text('security_lock_reason'),
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
    /** Hard end of the session regardless of activity (fixed at sign-in). */
    absoluteExpiresAt: ts('absolute_expires_at'),
    /** Last successful password re-authentication (sensitive actions need a recent one). */
    reauthAt: ts('reauth_at'),
    /** Synchronizer CSRF token for this session (sent back in the x-csrf-token header). */
    csrfToken: text('csrf_token'),
    /** Demo-only presence rows created by the seed (clearly labelled in the UI). */
    isSimulated: boolean('is_simulated').notNull().default(false),
    /** Phase 2fa: how this session's sign-in was completed (PASSWORD, PASSKEY, RECOVERY_CODE). */
    signInMethod: text('sign_in_method').notNull().default('PASSWORD'),
    /** Last successful passkey step-up on this session, and whether it proved user verification. */
    passkeyReauthAt: ts('passkey_reauth_at'),
    passkeyReauthUv: boolean('passkey_reauth_uv'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_status_idx').on(t.status)],
);

// ───────────────────────────── Second factor: passkeys (Phase 2fa) ─────────────────────────────

/** A registered passkey (WebAuthn credential). Revocation is a soft flag; rows are never deleted. */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    /** base64url credential id (public, chosen by the authenticator). */
    credentialId: text('credential_id').notNull().unique(),
    /** COSE public key, base64url. Never leaves the server. */
    publicKey: text('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports'),
    /** User-chosen label: "Shop PC", "Phone", "USB key 1". */
    nickname: text('nickname').notNull(),
    /** singleDevice / multiDevice (synced passkey). */
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull().default(false),
    /** Did the authenticator prove user verification (fingerprint, face, PIN) when registered? */
    uvAtRegistration: boolean('uv_at_registration').notNull(),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('webauthn_credentials_user_idx').on(t.userId)],
);

/** Single-use ceremony challenges (stored hashed), bound to a session or a pending sign-in; 5 minutes. */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: serial('id').primaryKey(),
    purpose: text('purpose').notNull(),
    userId: integer('user_id').notNull().references(() => users.id),
    sessionId: text('session_id'),
    pendingId: text('pending_id'),
    challengeHash: text('challenge_hash').notNull().unique(),
    rpId: text('rp_id').notNull(),
    origin: text('origin').notNull(),
    nickname: text('nickname'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
  },
  (t) => [index('webauthn_challenges_user_idx').on(t.userId, t.purpose)],
);

/** Password accepted, second factor pending: grants access to NO route; 5 minutes, single use. */
export const loginPending = pgTable('login_pending', {
  /** SHA-256 of the pending token (the raw token only lives in a short-lived cookie). */
  tokenHash: text('token_hash').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
});

/** Single-use recovery codes, argon2id-hashed. A new set invalidates the previous one. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    codeHash: text('code_hash').notNull(),
    generatedAt: ts('generated_at').notNull(),
    usedAt: ts('used_at'),
    invalidatedAt: ts('invalidated_at'),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

/** Every successful sign-in (recent sign-ins card and new-device alert). */
export const signInEvents = pgTable(
  'sign_in_events',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    sessionId: text('session_id'),
    method: text('method').notNull(),
    credentialId: integer('credential_id').references(() => webauthnCredentials.id),
    credentialNickname: text('credential_nickname'),
    /** e.g. "Chrome on Windows" (from the user agent). */
    browser: text('browser'),
    /** Approximate address: IPv4 /24, IPv6 /48. */
    ipApprox: text('ip_approx'),
    /** Was user verification proved (null = password-only sign-in)? */
    uv: boolean('uv'),
    /** Credential or browser not seen for this user in the previous 30 days. */
    newDevice: boolean('new_device').notNull().default(false),
    at: ts('at').notNull().defaultNow(),
    dismissedAt: ts('dismissed_at'),
  },
  (t) => [index('sign_in_events_user_idx').on(t.userId, t.at)],
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
    // DEPRECATED (Phase 2b): kept and still written for compatibility; the cost model is below.
    purchaseCost: money('purchase_cost').notNull(),
    makingCost: money('making_cost').notNull().default(0),
    otherCost: money('other_cost').notNull().default(0),
    totalCost: money('total_cost').notNull(),
    // ── Cost model (Phase 2b, decisions Q3/Q4/Q9) ──
    /** OPENING | SUPPLIER_NEW | SCRAP */
    origin: text('origin').notNull().default('SUPPLIER_NEW'),
    /** What the piece cost the company (for SUPPLIER_NEW it includes the making charge). GM only. */
    acquisitionCost: money('acquisition_cost').notNull(),
    /** True when the acquisition cost is an estimate (e.g. opening stock without invoices). */
    costIsEstimated: boolean('cost_is_estimated').notNull().default(false),
    supplierId: integer('supplier_id').references(() => suppliers.id),
    supplierInvoiceRef: text('supplier_invoice_ref'),
    /** Making charge paid to the supplier; part of acquisition_cost for SUPPLIER_NEW, kept apart for reports. */
    makingCharge: money('making_charge').notNull().default(0),
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
  // ── Phase 4: gold-for-gold supplier debt (D-4-4). NULL for orders recorded before Phase 4. ──
  /** Gold owed when the order was received: Σ pureGoldMg(net, karat) of the delivered pieces (24K mg). */
  goldDebtMgPure24: integer('gold_debt_mg_pure24'),
  /** Gold still owed after settlements (24K mg); reaches exactly 0, never below. */
  goldOwedMgPure24: integer('gold_owed_mg_pure24'),
  /** Making charge paid to the supplier at receipt (the only money ever paid to a supplier). */
  makingChargePaid: money('making_charge_paid'),
  /** CASH | BANK: where that making charge was paid from. */
  makingChargePaidFrom: text('making_charge_paid_from'),
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
    /** HASAD payments: the app's invoice / transaction reference, typed by the cashier (no API call). */
    paymentRefInvoice: text('payment_ref_invoice'),
    paymentRefTransaction: text('payment_ref_transaction'),
    /** Printing (D-print-5): when the original was printed (once, by the cashier, same session) and how many reprints followed. */
    originalPrintedAt: ts('original_printed_at'),
    reprintCount: integer('reprint_count').notNull().default(0),
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
  /** Cost snapshot so later cost edits never rewrite historical profit. DEPRECATED: see acquisition_cost. */
  unitCost: money('unit_cost').notNull(),
  // ── Phase 2b ──
  /** Acquisition cost of the piece at the time of sale (snapshot). GM only. */
  acquisitionCost: money('acquisition_cost').notNull(),
  /** final_price − acquisition_cost, computed and stored by the server. GM only. */
  profit: money('profit').notNull(),
  /** FIXED_TAG today; COMPUTED (rate × weight + making) once the client decides (Q2). */
  pricingMode: text('pricing_mode').notNull().default('FIXED_TAG'),
  /** Price components for a computed price; NULL for a fixed tag price. */
  priceGoldValue: money('price_gold_value'),
  priceMakingCharge: money('price_making_charge'),
  priceRatePerGram: money('price_rate_per_gram'),
});

// ───────────────────────────── Expenses (DEPRECATED) ─────────────────────────────
// REM-1: expenses were removed from the product. The table stays for history; migration 0013 refuses
// new rows (trigger trg_expenses_deprecated). Dropped by REM-5 before the first production deployment.

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
    /** CASH | BANK, chosen per expense (Q7). NULL only for expenses recorded before Phase 2b. */
    paidFrom: text('paid_from'),
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

/**
 * One row per setting key (see shared/src/settings.ts registry). The legacy row `system`
 * (one JSON blob) is kept for history but no longer read.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  /** Incremented on every change (optimistic concurrency). */
  version: integer('version').notNull().default(1),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: integer('updated_by'),
});

/** Append-only history of every setting change (UPDATE/DELETE blocked by a DB trigger). */
export const settingsHistory = pgTable(
  'settings_history',
  {
    id: serial('id').primaryKey(),
    key: text('key').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value').notNull(),
    version: integer('version').notNull(),
    actorId: integer('actor_id'),
    actorUsername: text('actor_username').notNull(),
    reason: text('reason'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('settings_history_key_idx').on(t.key, t.at)],
);

/** Uploaded branding files (logo). Rows are never updated; a new upload is a new row. */
export const brandingAssets = pgTable('branding_assets', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(),
  mime: text('mime').notNull(),
  bytes: bytea('bytes').notNull(),
  sha256: text('sha256').notNull(),
  size: integer('size').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  uploadedBy: integer('uploaded_by').references(() => users.id),
  uploadedAt: ts('uploaded_at').notNull().defaultNow(),
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

// ───────────────────────────── Scrap gold and supplier settlement (Phase 4) ─────────────────────────────

/** Scrap BUYING rate per karat (any karat: not limited by allowed karats). Append-only history. */
export const scrapRates = pgTable(
  'scrap_rates',
  {
    id: serial('id').primaryKey(),
    karat: smallint('karat').notNull(),
    pricePerGram: money('price_per_gram').notNull(),
    effectiveAt: ts('effective_at').notNull().defaultNow(),
    setBy: integer('set_by'),
  },
  (t) => [index('scrap_rates_karat_idx').on(t.karat, t.effectiveAt)],
);

/** A counter purchase of scrap gold from a customer: a sellable piece, or broken scrap for the pool. */
export const scrapPurchases = pgTable(
  'scrap_purchases',
  {
    id: serial('id').primaryKey(),
    number: text('number').notNull().unique(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    /** SELLABLE (becomes a jewelry item, origin SCRAP) | BROKEN (weight pool only). */
    kind: text('kind').notNull(),
    karat: smallint('karat').notNull(),
    grossWeightMg: integer('gross_weight_mg').notNull(),
    netWeightMg: integer('net_weight_mg').notNull(),
    /** Today's scrap buying rate for the karat, and the rate actually agreed with the customer. */
    scrapRatePerGram: money('scrap_rate_per_gram').notNull(),
    agreedRatePerGram: money('agreed_rate_per_gram').notNull(),
    /** |agreed − rate| / rate in basis points (1% = 100). */
    deviationBp: integer('deviation_bp').notNull(),
    /** True when the deviation exceeded the tolerance and was approved (GM). */
    overrideApproved: boolean('override_approved').notNull().default(false),
    /** Paid to the customer: round(net mg × agreed rate / 1000). */
    amount: money('amount').notNull(),
    paymentMethod: text('payment_method').notNull(),
    /** The jewelry item created for a SELLABLE purchase. */
    itemId: integer('item_id').references(() => jewelryItems.id),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    customerIdRef: text('customer_id_ref'),
    note: text('note'),
    createdBy: integer('created_by').notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('scrap_purchases_branch_at_idx').on(t.branchId, t.createdAt)],
);

/**
 * Broken-scrap WEIGHT pool per branch (append-only, like ledger_entries). Never a jewelry item.
 * Balance per branch and karat = SUM(weight_mg); the 24K equivalent is derived from the balances.
 */
export const scrapWeightEntries = pgTable(
  'scrap_weight_entries',
  {
    id: serial('id').primaryKey(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    karat: smallint('karat').notNull(),
    /** Signed mg, never 0: + bought from a customer, − given to a supplier. */
    weightMg: integer('weight_mg').notNull(),
    eventType: text('event_type').notNull(),
    refType: text('ref_type').notNull(),
    refId: integer('ref_id').notNull(),
    refNumber: text('ref_number'),
    actorId: integer('actor_id').references(() => users.id),
    sessionId: text('session_id'),
    idempotencyKey: text('idempotency_key'),
    note: text('note'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('scrap_weight_branch_karat_idx').on(t.branchId, t.karat), index('scrap_weight_ref_idx').on(t.refType, t.refId)],
);

/** Gold paid to a supplier against a purchase order, ONLY with broken-scrap weight (append-only). */
export const supplierSettlements = pgTable(
  'supplier_settlements',
  {
    id: serial('id').primaryKey(),
    number: text('number').notNull().unique(),
    purchaseId: integer('purchase_id').notNull().references(() => purchases.id),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    settledKarat: smallint('settled_karat').notNull(),
    settledWeightMg: integer('settled_weight_mg').notNull(),
    /** pureGoldMg(settled_weight_mg, settled_karat): what the order's debt goes down by. */
    settledPureMg24: integer('settled_pure_mg24').notNull(),
    actorId: integer('actor_id').notNull().references(() => users.id),
    sessionId: text('session_id'),
    idempotencyKey: text('idempotency_key'),
    note: text('note'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('supplier_settlements_purchase_idx').on(t.purchaseId)],
);

/**
 * Hasad pays the shop by an ordinary bank transfer into the branch's bank account. Each transfer
 * received is recorded here (append-only) and moves the amount from HASAD_RECEIVABLE to BANK in the
 * same transaction (two ledger entries that net to zero).
 */
export const hasadReceivableSettlements = pgTable(
  'hasad_receivable_settlements',
  {
    id: serial('id').primaryKey(),
    number: text('number').notNull().unique(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    amount: money('amount').notNull(),
    /** The bank's reference of the incoming transfer (optional). */
    bankReference: text('bank_reference'),
    note: text('note'),
    actorId: integer('actor_id').notNull().references(() => users.id),
    sessionId: text('session_id'),
    idempotencyKey: text('idempotency_key'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('hasad_receivable_settlements_branch_idx').on(t.branchId, t.at)],
);

// ───────────────────────────── Branch money ledger (Phase 2b) ─────────────────────────────

/** One account per branch and kind (CASH, BANK, FUNDS_IN_TRANSIT); created by a trigger on branches. */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: serial('id').primaryKey(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    kind: text('kind').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ledger_accounts_branch_kind_idx').on(t.branchId, t.kind)],
);

/**
 * Append-only money ledger. Balance of an account = SUM(amount) (no cached balance). Positive =
 * money into the account. Corrections are new reversing entries (`reverses_entry_id`), never edits.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull().references(() => ledgerAccounts.id),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    /** Signed whole SDG, never 0. */
    amount: money('amount').notNull(),
    eventType: text('event_type').notNull(),
    paymentMethod: text('payment_method'),
    refType: text('ref_type').notNull(),
    refId: integer('ref_id').notNull(),
    refNumber: text('ref_number'),
    reversesEntryId: integer('reverses_entry_id'),
    actorId: integer('actor_id').references(() => users.id),
    sessionId: text('session_id'),
    idempotencyKey: text('idempotency_key'),
    note: text('note'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_account_at_idx').on(t.accountId, t.at),
    index('ledger_entries_branch_at_idx').on(t.branchId, t.at),
    index('ledger_entries_ref_idx').on(t.refType, t.refId),
    // An entry can be reversed at most once (a double void cannot refund twice).
    uniqueIndex('ledger_entries_reverses_idx').on(t.reversesEntryId),
  ],
);

/**
 * Backups and restore drills (Phase 2c, append-only). One row per run of `npm run backup` or
 * `npm run backup:verify`; the health check reads the latest SUCCESS of each kind.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: serial('id').primaryKey(),
    /** BACKUP or VERIFY. */
    kind: text('kind').notNull(),
    /** SUCCESS or FAILURE. */
    status: text('status').notNull(),
    fileName: text('file_name'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    encrypted: boolean('encrypted').notNull().default(false),
    uploaded: boolean('uploaded').notNull().default(false),
    /** Summary (row counts, checks passed, failure messages). Never secrets. */
    detail: jsonb('detail'),
    host: text('host'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull().defaultNow(),
  },
  (t) => [index('backup_runs_kind_idx').on(t.kind, t.status, t.finishedAt)],
);

/** Cash counted in the drawer (append-only: a recount is a new row; the latest one counts). */
export const cashCounts = pgTable(
  'cash_counts',
  {
    id: serial('id').primaryKey(),
    branchId: integer('branch_id').notNull().references(() => branches.id),
    businessDay: date('business_day', { mode: 'string' }).notNull(),
    countedAmount: money('counted_amount').notNull(),
    /** Expected cash at the moment of the count (snapshot, for the record). */
    expectedAmount: money('expected_amount').notNull(),
    countedBy: integer('counted_by').notNull().references(() => users.id),
    note: text('note'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('cash_counts_branch_day_idx').on(t.branchId, t.businessDay, t.at)],
);

/**
 * Idempotency keys for requests that create or confirm business records (see
 * backend/src/core/idempotency.ts). One row per (user, key): the first request reserves it
 * (IN_PROGRESS); a successful response is stored and replayed for retries with the same body.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    key: text('key').notNull(),
    /** Route template, e.g. "POST /sales/:id/void". */
    route: text('route').notNull(),
    /** SHA-256 of method, concrete path and canonical JSON body. */
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [uniqueIndex('idem_user_key_idx').on(t.userId, t.key), index('idem_created_idx').on(t.createdAt)],
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
