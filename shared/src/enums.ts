// Domain enumerations shared by backend and frontend.
// Keep values stable: they are persisted in the database and written to the audit log.

export const ITEM_STATUSES = [
  'AVAILABLE',
  'SOLD',
  'TRANSFERRED',
  'DAMAGED',
  'RETURNED',
  /** MIS-1 (SCR-VOID): the piece of a voided scrap purchase. Terminal: never sold, valued or moved again. */
  'VOIDED',
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
export const STOCK_STATUSES: readonly ItemStatus[] = ['AVAILABLE'];

export const MOVEMENT_TYPES = [
  'PURCHASE',
  'SALE',
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
 * HASAD = the customer paid through the Hasad app; the money is paid to the General Manager's own account, never the
 * branch's (PAY-1, D-dec1-5): a HASAD payment line moves no branch account.
 */
export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/**
 * PAY-1 (D-pay1-1): the label stored on a sale, `sales.payment_method`: the method of its one payment line, or SPLIT for
 * two lines (one per method). The lines (`sale_payments`) are the truth; a check ties the label to them.
 */
export const SALE_PAYMENT_LABELS = [...PAYMENT_METHODS, 'SPLIT'] as const;
export type SalePaymentLabel = (typeof SALE_PAYMENT_LABELS)[number];

export const SALE_STATUSES = ['COMPLETED', 'VOIDED'] as const;

/** How a sale line's price was set (Q2 is CLIENT-PENDING: only FIXED_TAG is used today). */
export const PRICING_MODES = ['FIXED_TAG', 'COMPUTED'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
/** PRC-1: the deployment's pricing mode (setting `pricing.mode`); a computed sale line stores pricing_mode COMPUTED. */
export const PRICING_SETTING_MODES = ['RATE_COMPUTED', 'FIXED_TAG'] as const;
export type PricingSettingMode = (typeof PRICING_SETTING_MODES)[number];
/** PRC-1 (D-prc1-2): the two selling rates per karat: NEW for supplier and opening pieces, USED for sellable scrap. */
export const GOLD_RATE_KINDS = ['NEW', 'USED'] as const;
export type GoldRateKind = (typeof GOLD_RATE_KINDS)[number];

// ── Branch money ledger (Phase 2b, decisions Q5–Q8, D-2b-*) ──
/**
 * OWED_TO_GM (CSH-2, D-csh-1): what the branch owes the General Manager for his advances; a liability, positive = owed.
 * It is never money in the drawer or the bank: every reader of the ledger filters by account kind (guardrail test).
 */
export const LEDGER_ACCOUNT_KINDS = ['CASH', 'BANK', 'FUNDS_IN_TRANSIT', 'OWED_TO_GM'] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

export const LEDGER_EVENT_TYPES = [
  'SALE',
  'SALE_VOID',
  'REVERSAL',
  'SCRAP_PURCHASE',
  'SUPPLIER_MAKING_CHARGE',
  'GM_ADVANCE',
  'GM_REPAYMENT',
  // MNY-1 (D-mny1-1): a money transfer's send to a branch, its confirmation, its cancel (the reversal of the send), and
  // everything of a transfer to the General Manager (the send, and the exit at his confirmation).
  'MONEY_TRANSFER_SENT',
  'MONEY_TRANSFER_RECEIVED',
  'MONEY_TRANSFER_CANCELLED',
  'MONEY_TRANSFER_TO_GM',
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

/**
 * Q5: which branch account a payment method moves (every entry keeps its own payment method too). HASAD moves none
 * (PAY-1, D-pay1-8): the money is paid to the General Manager's own account; the payment line itself is the record.
 */
export const PAYMENT_ACCOUNT: Record<PaymentMethod, LedgerAccountKind | null> = {
  CASH: 'CASH',
  BANK_TRANSFER: 'BANK',
  CARD: 'BANK',
  MOBILE_WALLET: 'BANK',
  HASAD: null,
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

/**
 * Payment to the customer for scrap: from the drawer, by bank transfer, or SPLIT (CSH-2 piece A, D-csh-7): part cash
 * and part transfer. The label is derived from the two parts (cash_amount, bank_amount) and tied to them by a check.
 */
export const SCRAP_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'SPLIT'] as const;
export type ScrapPaymentMethod = (typeof SCRAP_PAYMENT_METHODS)[number];

/** Movements of the broken-scrap weight pool. */
export const SCRAP_WEIGHT_EVENT_TYPES = ['SCRAP_PURCHASE', 'SUPPLIER_SETTLEMENT', 'REVERSAL', 'OPENING', 'OPENING_CORRECTION'] as const;
export type ScrapWeightEventType = (typeof SCRAP_WEIGHT_EVENT_TYPES)[number];

/** CSH-2 (D-csh-2): funding events between the General Manager and a branch; a REVERSAL corrects one of the others. */
export const GM_FUNDING_KINDS = ['ADVANCE', 'REPAYMENT', 'REVERSAL'] as const;
export type GmFundingKind = (typeof GM_FUNDING_KINDS)[number];

/** MIS-1 (PUR-FIX): what a supplier-order correction changes: one piece's making cost, or the order's transfer reference. */
export const PURCHASE_CORRECTION_FIELDS = ['MAKING_COST', 'MAKING_CHARGE_REFERENCE'] as const;
/** OPN-FIX: a correction of a sealed opening's piece changes its values, or voids it. */
export const OPENING_CORRECTION_KINDS = ['CORRECT', 'VOID'] as const;
export type OpeningCorrectionKind = (typeof OPENING_CORRECTION_KINDS)[number];
export type PurchaseCorrectionField = (typeof PURCHASE_CORRECTION_FIELDS)[number];

/** OPN-1: an opening per branch is a DRAFT until it is sealed, once. */
export const OPENING_STATUSES = ['DRAFT', 'SEALED'] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];
/** OPN-1: how a draft line was entered. */
export const OPENING_LINE_SOURCES = ['KEYBOARD', 'IMPORT'] as const;
export type OpeningLineSource = (typeof OPENING_LINE_SOURCES)[number];

/** A branch money account: the drawer (CASH) or the bank account (BANK). Used by the General Manager's funding (CSH-2). */
export const CASH_OR_BANK = ['CASH', 'BANK'] as const;
export type CashOrBank = (typeof CASH_OR_BANK)[number];

/** MNY-1: a money transfer goes to another branch or to the General Manager. */
export const MONEY_TRANSFER_TARGETS = ['BRANCH', 'GM'] as const;
export type MoneyTransferTarget = (typeof MONEY_TRANSFER_TARGETS)[number];
/** MNY-1: IN_TRANSIT until the receiver confirms (RECEIVED) or the sender cancels (CANCELLED); both are final. */
export const MONEY_TRANSFER_STATUSES = ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type MoneyTransferStatus = (typeof MONEY_TRANSFER_STATUSES)[number];
/** MNY-1: the steps of a transfer (the append-only event log). */
export const MONEY_TRANSFER_EVENT_KINDS = ['SENT', 'RECEIVED', 'CANCELLED'] as const;
export type MoneyTransferEventKind = (typeof MONEY_TRANSFER_EVENT_KINDS)[number];

/**
 * MKC-1 (D-mkc-1): who paid a supplier order's making charge. Always one bank transfer from the owner's PERSONAL
 * account: no branch money moves and the branch owes nothing. Additive: a future company account would be one more
 * value with its own posting rule (D-mkc-2); the CASH/BANK values of before MKC-1 no longer exist (migration 0022).
 */
export const MAKING_CHARGE_PAYERS = ['OWNER_PERSONAL'] as const;
export type MakingChargePayer = (typeof MAKING_CHARGE_PAYERS)[number];
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PURCHASE_STATUSES = ['RECEIVED'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const TRANSFER_STATUSES = ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

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
  'SALE_PRICE_CHANGED',
  'INVENTORY_TRANSFER',
  'INVENTORY_TRANSFER_RECEIVED',
  'INVENTORY_ADJUSTMENT',
  'PURCHASE_CREATED',
  'SCRAP_PURCHASED',
  'SCRAP_RATE_CHANGED',
  'SUPPLIER_SETTLEMENT_RECORDED',
  // CSH-2: the General Manager's funding of a branch (GM-only in the audit list, D-csh-5)
  'GM_ADVANCE_RECORDED',
  'GM_REPAYMENT_RECORDED',
  'GM_FUNDING_CORRECTED',
  // MIS-1: mistake correction by the General Manager
  'SCRAP_PURCHASE_VOIDED',
  'PURCHASE_CORRECTED',
  // OPN-1: the opening balance and the types (CAT-1)
  'OPENING_CREATED',
  'OPENING_IMPORTED',
  'OPENING_LINE_ADDED',
  'OPENING_LINE_REMOVED',
  'OPENING_SEALED',
  // OPN-FIX: a piece of a sealed opening corrected or voided after the seal
  'OPENING_PIECE_CORRECTED',
  'OPENING_PIECE_VOIDED',
  // OPN-3: the broken scrap of the opening (draft lines; a correction after the seal)
  'OPENING_SCRAP_LINE_ADDED',
  'OPENING_SCRAP_LINE_CHANGED',
  'OPENING_SCRAP_LINE_REMOVED',
  'OPENING_SCRAP_CORRECTED',
  'ITEM_TYPE_RENAMED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DISABLED',
  'USER_ENABLED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
  'PRICE_CHANGED',
  'SETTINGS_CHANGED',
  'ALLOWED_KARATS_CONFIRMED',
  'GOLD_RATE_CHANGED',
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
