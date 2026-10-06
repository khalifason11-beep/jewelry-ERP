// Domain enumerations shared by backend and frontend.
// Keep values stable: they are persisted in the database and written to the audit log.

export const ITEM_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'SOLD',
  'REDEEMED',
  'TRANSFERRED',
  'DAMAGED',
  'RETURNED',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * Values allowed in `item_status_history`: every item status plus the two lifecycle steps a new
 * piece passes through on a purchase receipt before it becomes AVAILABLE.
 */
export const ITEM_HISTORY_STATUSES = [...ITEM_STATUSES, 'PURCHASED', 'RECEIVED'] as const;

/** Where a piece came from (Phase 2b cost model, decisions Q3/Q4/Q9). */
export const ITEM_ORIGINS = ['OPENING', 'SUPPLIER_NEW', 'SCRAP'] as const;
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

/** Statuses that count as the branch's sellable stock on hand. */
export const STOCK_STATUSES: readonly ItemStatus[] = ['AVAILABLE', 'RESERVED'];

export const MOVEMENT_TYPES = [
  'PURCHASE',
  'SALE',
  'HASAD_REDEMPTION',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'RETURN',
  'ADJUSTMENT',
  'DAMAGE',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Default stock effect of each movement type (ADJUSTMENT carries its own direction). */
export const MOVEMENT_DIRECTION: Record<MovementType, 1 | -1 | 0> = {
  PURCHASE: 1,
  TRANSFER_IN: 1,
  RETURN: 1,
  SALE: -1,
  HASAD_REDEMPTION: -1,
  TRANSFER_OUT: -1,
  DAMAGE: -1,
  ADJUSTMENT: 0,
};

export const KARATS = [18, 21, 22, 24] as const;
export type Karat = (typeof KARATS)[number];

export const CATEGORY_CODES = ['RING', 'BRACELET', 'NECKLACE', 'EARRING', 'CHAIN', 'PENDANT', 'SET'] as const;
export type CategoryCode = (typeof CATEGORY_CODES)[number];

/**
 * Every payment method the system knows. Which ones the POS offers is a setting
 * (`sales.posPaymentMethods`, D-4-6): CARD and MOBILE_WALLET stay valid but this deployment hides them.
 * HASAD = the customer paid through the Hasad app; the money is held by Hasad (HASAD_RECEIVABLE).
 */
export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SALE_STATUSES = ['COMPLETED', 'VOIDED'] as const;

/** How a sale line's price was set (Q2 is CLIENT-PENDING: only FIXED_TAG is used today). */
export const PRICING_MODES = ['FIXED_TAG', 'COMPUTED'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

// ── Branch money ledger (Phase 2b, decisions Q5–Q8, D-2b-*) ──
/** HASAD_RECEIVABLE (Phase 4): sales paid through the Hasad app, held by Hasad until Hasad's bank transfer is recorded (D-4-14). */
export const LEDGER_ACCOUNT_KINDS = ['CASH', 'BANK', 'FUNDS_IN_TRANSIT', 'HASAD_RECEIVABLE'] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

export const LEDGER_EVENT_TYPES = ['SALE', 'SALE_VOID', 'EXPENSE', 'HASAD_SETTLEMENT', 'REVERSAL', 'SCRAP_PURCHASE', 'SUPPLIER_MAKING_CHARGE', 'HASAD_RECEIVABLE_SETTLEMENT'] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

/** Q5: which branch account a payment method moves. Every entry keeps its own payment method too. */
export const PAYMENT_ACCOUNT: Record<PaymentMethod, LedgerAccountKind> = {
  CASH: 'CASH',
  BANK_TRANSFER: 'BANK',
  CARD: 'BANK',
  MOBILE_WALLET: 'BANK',
  HASAD: 'HASAD_RECEIVABLE',
};

// ── Counter scrap purchases and the broken-scrap weight pool (Phase 4, D-4-*) ──
/** SELLABLE becomes a jewelry item (origin SCRAP); BROKEN only adds weight to the branch pool. */
export const SCRAP_KINDS = ['SELLABLE', 'BROKEN'] as const;
/** Phase 2c: backup and restore-drill runs. */
export const BACKUP_RUN_KINDS = ['BACKUP', 'VERIFY'] as const;
export type BackupRunKind = (typeof BACKUP_RUN_KINDS)[number];
export const BACKUP_RUN_STATUSES = ['SUCCESS', 'FAILURE'] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

export type ScrapKind = (typeof SCRAP_KINDS)[number];

/** Payment to the customer for scrap: from the drawer or the bank. */
export const SCRAP_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER'] as const;
export type ScrapPaymentMethod = (typeof SCRAP_PAYMENT_METHODS)[number];

/** Movements of the broken-scrap weight pool. */
export const SCRAP_WEIGHT_EVENT_TYPES = ['SCRAP_PURCHASE', 'SUPPLIER_SETTLEMENT', 'REVERSAL'] as const;
export type ScrapWeightEventType = (typeof SCRAP_WEIGHT_EVENT_TYPES)[number];

/** Money paid out from the drawer (CASH) or the bank account (BANK): the supplier making charge, and (historically) expenses. */
export const CASH_OR_BANK = ['CASH', 'BANK'] as const;
export type CashOrBank = (typeof CASH_OR_BANK)[number];
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** DEPRECATED (REM-1): expenses were removed; kept for the CHECKs of the historical `expenses` table until REM-5. */
export const EXPENSE_CATEGORIES = [
  'RENT',
  'ELECTRICITY',
  'TRANSPORTATION',
  'SALARIES',
  'MAINTENANCE',
  'SECURITY',
  'OTHER',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_STATUSES = ['APPROVED', 'PENDING', 'REJECTED'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const PURCHASE_STATUSES = ['RECEIVED'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const TRANSFER_STATUSES = ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/**
 * DEPRECATED (REM-2): the Hasad withdrawal workspace was removed; Hasad is only a payment method now.
 * These lists stay for the CHECKs of the historical tables until REM-5.
 */
/** ERP-side lifecycle of a Hasad withdrawal request. */
export const HASAD_WITHDRAWAL_STATUSES = ['READY_FOR_PICKUP', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type HasadWithdrawalStatus = (typeof HASAD_WITHDRAWAL_STATUSES)[number];

/** Statuses as the Hasad Gold system reports them (mirrored in `hasad_withdrawals.external_status`). */
export const HASAD_EXTERNAL_STATUSES = ['PENDING', 'READY_FOR_PICKUP', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type HasadExternalStatusValue = (typeof HASAD_EXTERNAL_STATUSES)[number];

export const HASAD_REDEMPTION_STATUSES = ['DRAFT', 'COMPLETED', 'ABORTED'] as const;
export type HasadRedemptionStatus = (typeof HASAD_REDEMPTION_STATUSES)[number];

export const SETTLEMENT_DIRECTIONS = ['BRANCH_PAYS_CUSTOMER', 'CUSTOMER_PAYS_BRANCH', 'NONE'] as const;
export type SettlementDirection = (typeof SETTLEMENT_DIRECTIONS)[number];

export const SETTLEMENT_TYPES = ['HASAD_WEIGHT_DIFFERENCE'] as const;
export type SettlementType = (typeof SETTLEMENT_TYPES)[number];

export const BRANDING_ASSET_KINDS = ['LOGO'] as const;
export const IDEMPOTENCY_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;

export const SESSION_STATUSES = ['ACTIVE', 'LOGGED_OUT', 'EXPIRED', 'REVOKED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Derived (display) session state, computed from last activity. */
export type SessionPresence = 'ACTIVE' | 'IDLE' | 'ENDED';

/** Second factor (Phase 2fa): how a sign-in was completed; which roles may be forced to use it. */
export const SIGN_IN_METHODS = ['PASSWORD', 'PASSKEY', 'RECOVERY_CODE'] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
export const TWO_FACTOR_ROLES = ['GENERAL_MANAGER', 'BRANCH_MANAGER'] as const;
export type TwoFactorRole = (typeof TWO_FACTOR_ROLES)[number];
export const WEBAUTHN_UV_VALUES = ['required', 'preferred'] as const;
export type WebauthnUv = (typeof WEBAUTHN_UV_VALUES)[number];
export const WEBAUTHN_CHALLENGE_PURPOSES = ['REGISTER', 'LOGIN', 'STEPUP'] as const;
export type WebauthnChallengePurpose = (typeof WEBAUTHN_CHALLENGE_PURPOSES)[number];

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'SESSION_REVOKED',
  'SALE_CREATED',
  'SALE_CANCELLED',
  'INVENTORY_TRANSFER',
  'INVENTORY_TRANSFER_RECEIVED',
  'INVENTORY_ADJUSTMENT',
  'ITEM_RESERVED',
  'ITEM_RELEASED',
  'PURCHASE_CREATED',
  'SCRAP_PURCHASED',
  'SCRAP_RATE_CHANGED',
  'SUPPLIER_SETTLEMENT_RECORDED',
  'HASAD_RECEIVABLE_SETTLED',
  'HASAD_WITHDRAWAL_RECEIVED',
  'HASAD_WITHDRAWAL_OPENED',
  'HASAD_WITHDRAWAL_COMPLETED',
  'HASAD_WITHDRAWAL_CANCELLED',
  'HASAD_REDEMPTION_ABORTED',
  'HASAD_SETTLEMENT_CONFIRMED',
  'EXPENSE_CREATED',
  'EXPENSE_APPROVED',
  'EXPENSE_REJECTED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DISABLED',
  'USER_ENABLED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
  'PRICE_CHANGED',
  'SETTINGS_CHANGED',
  'GOLD_RATE_CHANGED',
  'DEMO_DATA_RESET',
  'ACCOUNT_LOCKED',
  'USER_UNLOCKED',
  'REAUTHENTICATED',
  // Passkeys / second factor (Phase 2fa)
  'PASSKEY_REGISTERED',
  'PASSKEY_REMOVED',
  'SECOND_FACTOR_FAILED',
  'SECOND_FACTOR_LOCKED',
  'SIGN_COUNT_REGRESSION',
  'RECOVERY_CODES_GENERATED',
  'RECOVERY_CODES_ACKNOWLEDGED',
  'RECOVERY_CODE_USED',
  'SECOND_FACTOR_RESET',
  'SIGN_IN_ALERT_DISMISSED',
  'ACCOUNT_SECURED',
  'SECURITY_LOCK_LIFTED',
  'INVOICE_REPRINTED',
  'SECURITY_SETTING_CHANGED',
  'REAUTH_FAILED',
  'BOOTSTRAP_COMPLETED',
  'BRANDING_CHANGED',
  'BRANCH_CREATED',
  'BRANCH_UPDATED',
  'CASH_COUNTED',
  // CAT-0
  'ITEM_TYPE_CREATED',
  'ITEM_TYPE_DEACTIVATED',
  'ITEM_TYPE_REACTIVATED',
  'PRODUCT_CREATED',
  'PRODUCT_DEACTIVATED',
  'PRODUCT_REACTIVATED',
  'SUPPLIER_CREATED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const REPORT_KEYS = [
  'sales',
  'purchases',
  'inventory',
  'inventory-movement',
  'stock-weight',
  'profit',
  'branch-performance',
  'user-activity',
  'audit',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** Paper of printed invoices and receipts (setting print.invoiceFormat, D-print-2). */
export const INVOICE_FORMATS = ['A4', 'A5', 'RECEIPT'] as const;
export type InvoiceFormat = (typeof INVOICE_FORMATS)[number];
