// System settings — everything the client may want to change without a code release.
// Persisted as JSON in the `settings` table; these are the defaults.

import type { SettlementBasis } from './settlement';

export type HasadRateSource =
  /** weight-averaged gold rate of the karats of the selected items */
  | 'ITEM_KARAT'
  /** gold rate of the karat the entitlement is denominated in */
  | 'ENTITLEMENT_KARAT';

export interface SystemSettings {
  company: {
    name: string;
    nameAr: string;
    currency: string;
    timezone: string;
  };
  sales: {
    /** Max discount % of the item price, per role code. Missing role = 0. */
    maxDiscountPercentByRole: Record<string, number>;
  };
  expenses: {
    /** Expenses above this amount (SDG) created by non-GM users require GM approval. */
    approvalThreshold: number;
  };
  hasad: {
    settlementBasis: SettlementBasis;
    rateSource: HasadRateSource;
    /** Karat the Hasad entitlement grams are denominated in. */
    entitlementKarat: number;
    /** Reservations of items for a Hasad customer are released after this many minutes. */
    reservationTimeoutMinutes: number;
  };
  security: {
    /** Centralized password control: users cannot change their password except when forced. */
    allowSelfPasswordChange: boolean;
    sessionIdleMinutes: number;
    sessionExpiryHours: number;
    minPasswordLength: number;
  };
  mockHasad: {
    latencyMs: number;
    simulateOutage: boolean;
  };
}

export const DEFAULT_SETTINGS: SystemSettings = {
  company: {
    name: 'Loai Tabeede',
    nameAr: 'Loai Tabeede',
    currency: 'SDG',
    timezone: 'Africa/Khartoum',
  },
  sales: {
    maxDiscountPercentByRole: { CASHIER: 3, BRANCH_MANAGER: 10, GENERAL_MANAGER: 20 },
  },
  expenses: {
    approvalThreshold: 1_500_000,
  },
  hasad: {
    settlementBasis: 'NET_WEIGHT',
    rateSource: 'ITEM_KARAT',
    entitlementKarat: 21,
    reservationTimeoutMinutes: 30,
  },
  security: {
    allowSelfPasswordChange: false,
    sessionIdleMinutes: 10,
    sessionExpiryHours: 12,
    minPasswordLength: 8,
  },
  mockHasad: {
    latencyMs: 250,
    simulateOutage: false,
  },
};
