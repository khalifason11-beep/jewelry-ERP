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

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SALE_STATUSES = ['COMPLETED', 'VOIDED'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

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

export const TRANSFER_STATUSES = ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** ERP-side lifecycle of a Hasad withdrawal request. */
export const HASAD_WITHDRAWAL_STATUSES = ['READY_FOR_PICKUP', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type HasadWithdrawalStatus = (typeof HASAD_WITHDRAWAL_STATUSES)[number];

export const HASAD_REDEMPTION_STATUSES = ['DRAFT', 'COMPLETED', 'ABORTED'] as const;
export type HasadRedemptionStatus = (typeof HASAD_REDEMPTION_STATUSES)[number];

export const SETTLEMENT_DIRECTIONS = ['BRANCH_PAYS_CUSTOMER', 'CUSTOMER_PAYS_BRANCH', 'NONE'] as const;
export type SettlementDirection = (typeof SETTLEMENT_DIRECTIONS)[number];

export const SESSION_STATUSES = ['ACTIVE', 'LOGGED_OUT', 'EXPIRED', 'REVOKED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Derived (display) session state, computed from last activity. */
export type SessionPresence = 'ACTIVE' | 'IDLE' | 'ENDED';

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
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const REPORT_KEYS = [
  'sales',
  'purchases',
  'expenses',
  'inventory',
  'inventory-movement',
  'profit',
  'hasad',
  'branch-performance',
  'user-activity',
  'audit',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
