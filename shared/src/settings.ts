// System settings — every business rule the client may change without a code release.
//
// Storage: one row per key in the `settings` table (key, value jsonb, version, updated_at,
// updated_by) plus an append-only `settings_history`. This file is the single typed registry:
// each key has a zod schema and a default. Services read the assembled `SystemSettings` object;
// the API accepts changes keyed by the dotted names below (e.g. "security.idleMinutes").

import { z } from 'zod';
import type { SettlementBasis } from './settlement';
import { PAYMENT_METHODS, type PaymentMethod } from './enums';

export type HasadRateSource =
  /** weight-averaged gold rate of the karats of the selected items */
  | 'ITEM_KARAT'
  /** gold rate of the karat the entitlement is denominated in */
  | 'ENTITLEMENT_KARAT';

export type GoldRateScope = 'GLOBAL' | 'BRANCH';

export interface SystemSettings {
  company: {
    /** Company name shown in the header, login page, browser title and invoices. */
    nameEn: string;
    nameAr: string;
    /** ISO-like code sent to external systems (e.g. Hasad). */
    currencyCode: string;
    /** Label printed after amounts, per UI language. */
    currencyLabelEn: string;
    currencyLabelAr: string;
    timezone: string;
  };
  branding: {
    /** `branding_assets.id` of the current logo (null = generic icon). */
    logoAssetId: number | null;
    invoiceFooterEn: string;
    invoiceFooterAr: string;
  };
  sales: {
    /** Max discount % of the item price, per role code. Missing role = 0. */
    maxDiscountPercentByRole: Record<string, number>;
    /** Payment methods the cashier's checkout offers (D-4-6); the others stay valid but hidden. */
    posPaymentMethods: PaymentMethod[];
  };
  expenses: {
    /** Expenses above this amount created by non-GM users require GM approval. */
    approvalThreshold: number;
  };
  purchases: {
    /** Supplier purchases on CREDIT (creates a supplier payable). */
    supplierCreditEnabled: boolean;
    /** A branch manager may deviate from today's scrap rate by at most this percentage. */
    scrapPriceTolerancePct: number;
    /** Deviations beyond the tolerance need a reason AND General Manager approval. */
    requireGmApprovalForScrapOverride: boolean;
  };
  rates: {
    /** One rate table for the company, or one per branch. */
    goldRateScope: GoldRateScope;
    /** Rate changes larger than this percentage need an explicit confirmation. */
    rateChangeMaxPct: number;
  };
  transfers: {
    /** Pending transfers/claims older than this are flagged on the GM dashboard. */
    pendingClaimStaleHours: number;
  };
  inventory: {
    /** Karats accepted anywhere in the system. */
    allowedKarats: number[];
  };
  hasad: {
    settlementBasis: SettlementBasis;
    rateSource: HasadRateSource;
    /** Karat the Hasad entitlement grams are denominated in. */
    entitlementKarat: number;
    /** Reservations of items for a Hasad customer are released after this many minutes. */
    reservationTimeoutMinutes: number;
    /** Branch code → Hasad Gold counter operations enabled. Missing branch = disabled. */
    enabledPerBranch: Record<string, boolean>;
  };
  security: {
    /** Centralized password control: users cannot change their password except when forced. */
    allowSelfPasswordChange: boolean;
    /** Minutes without activity after which a user is *shown* as idle on the sessions screen. */
    sessionIdleMinutes: number;
    /** Sessions end after this many minutes without real user input (all roles). */
    idleMinutes: number;
    /** Hard limit on a session's lifetime, fixed at sign-in. */
    sessionAbsoluteHours: number;
    /** After re-entering their password, a user may perform sensitive actions for this many minutes. */
    reauthWindowMinutes: number;
    minPasswordLength: number;
    /** Consecutive failures that lock an account. */
    lockoutThreshold: number;
    /** First lock duration; each further failure doubles it … */
    lockoutBaseMinutes: number;
    /** … up to this cap. */
    lockoutMaxMinutes: number;
  };
  mockHasad: {
    latencyMs: number;
    simulateOutage: boolean;
  };
}

export const DEFAULT_SETTINGS: SystemSettings = {
  company: {
    nameEn: 'Jewelry ERP',
    nameAr: 'نظام المجوهرات',
    currencyCode: 'SDG',
    currencyLabelEn: 'SDG',
    currencyLabelAr: 'ج.س',
    timezone: 'Africa/Khartoum',
  },
  branding: {
    logoAssetId: null,
    invoiceFooterEn: 'Thank you for your purchase · Prices include making charges',
    invoiceFooterAr: 'شكراً لتسوقكم معنا · الأسعار شاملة المصنعية',
  },
  sales: {
    maxDiscountPercentByRole: { CASHIER: 3, BRANCH_MANAGER: 10, GENERAL_MANAGER: 20 },
    posPaymentMethods: ['CASH', 'BANK_TRANSFER', 'HASAD'],
  },
  expenses: {
    approvalThreshold: 1_500_000,
  },
  purchases: {
    // Phase 4 (D-4-4): supplier purchases are gold-for-gold debts settled later with broken scrap.
    supplierCreditEnabled: true,
    scrapPriceTolerancePct: 2,
    requireGmApprovalForScrapOverride: true,
  },
  rates: {
    goldRateScope: 'GLOBAL',
    rateChangeMaxPct: 5,
  },
  transfers: {
    pendingClaimStaleHours: 24,
  },
  inventory: {
    allowedKarats: [18, 21, 22, 24],
  },
  hasad: {
    settlementBasis: 'NET_WEIGHT',
    rateSource: 'ITEM_KARAT',
    entitlementKarat: 21,
    reservationTimeoutMinutes: 30,
    enabledPerBranch: {},
  },
  security: {
    allowSelfPasswordChange: false,
    sessionIdleMinutes: 10,
    idleMinutes: 60,
    sessionAbsoluteHours: 12,
    reauthWindowMinutes: 5,
    minPasswordLength: 10,
    lockoutThreshold: 5,
    lockoutBaseMinutes: 15,
    lockoutMaxMinutes: 60,
  },
  mockHasad: {
    latencyMs: 250,
    simulateOutage: false,
  },
};

// ───────────────────────────── registry ─────────────────────────────

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const roleKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
const branchCode = z.string().regex(/^[A-Z]{2,6}$/);
const karat = int(8, 24);
const timezone = z.string().min(1).max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown timezone');

export type SettingGroup = keyof SystemSettings;

export interface SettingDef {
  schema: z.ZodType;
  /** Only meaningful (and only editable) in APP_MODE=demo. */
  demoOnly?: boolean;
}

/** Every setting, keyed by "group.field". The value schema is the only validation path. */
export const SETTINGS_REGISTRY = {
  'company.nameEn': { schema: text(1, 80) },
  'company.nameAr': { schema: text(1, 80) },
  'company.currencyCode': { schema: z.string().regex(/^[A-Z]{3}$/) },
  'company.currencyLabelEn': { schema: text(1, 12) },
  'company.currencyLabelAr': { schema: text(1, 12) },
  'company.timezone': { schema: timezone },
  'branding.logoAssetId': { schema: z.number().int().positive().nullable() },
  'branding.invoiceFooterEn': { schema: text(0, 300) },
  'branding.invoiceFooterAr': { schema: text(0, 300) },
  'sales.maxDiscountPercentByRole': { schema: z.record(roleKey, int(0, 100)) },
  'sales.posPaymentMethods': {
    schema: z
      .array(z.enum(PAYMENT_METHODS))
      .min(1)
      .max(PAYMENT_METHODS.length)
      .refine((a) => new Set(a).size === a.length, 'Duplicate payment method'),
  },
  'expenses.approvalThreshold': { schema: int(0, 1_000_000_000) },
  'purchases.supplierCreditEnabled': { schema: z.boolean() },
  'purchases.scrapPriceTolerancePct': { schema: z.number().min(0).max(50) },
  'purchases.requireGmApprovalForScrapOverride': { schema: z.boolean() },
  'rates.goldRateScope': { schema: z.enum(['GLOBAL', 'BRANCH']) },
  'rates.rateChangeMaxPct': { schema: z.number().min(0.1).max(100) },
  'transfers.pendingClaimStaleHours': { schema: int(1, 24 * 30) },
  'inventory.allowedKarats': {
    schema: z
      .array(karat)
      .min(1)
      .max(10)
      .refine((a) => new Set(a).size === a.length, 'Duplicate karat'),
  },
  'hasad.settlementBasis': { schema: z.enum(['NET_WEIGHT', 'PURE_GOLD_EQUIVALENT']) },
  'hasad.rateSource': { schema: z.enum(['ITEM_KARAT', 'ENTITLEMENT_KARAT']) },
  'hasad.entitlementKarat': { schema: karat },
  'hasad.reservationTimeoutMinutes': { schema: int(5, 24 * 60) },
  'hasad.enabledPerBranch': { schema: z.record(branchCode, z.boolean()) },
  'security.allowSelfPasswordChange': { schema: z.boolean() },
  'security.sessionIdleMinutes': { schema: int(1, 240) },
  'security.idleMinutes': { schema: int(5, 240) },
  'security.sessionAbsoluteHours': { schema: int(1, 24) },
  'security.reauthWindowMinutes': { schema: int(1, 30) },
  'security.minPasswordLength': { schema: int(10, 128) },
  'security.lockoutThreshold': { schema: int(3, 20) },
  'security.lockoutBaseMinutes': { schema: int(1, 24 * 60) },
  'security.lockoutMaxMinutes': { schema: int(1, 24 * 60) },
  'mockHasad.latencyMs': { schema: int(0, 10_000), demoOnly: true },
  'mockHasad.simulateOutage': { schema: z.boolean(), demoOnly: true },
} satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;
export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, k);
}

/** Read a dotted key from a settings object. */
export function settingValue(s: SystemSettings, key: SettingKey): unknown {
  const [group, field] = key.split('.') as [keyof SystemSettings, string];
  return (s[group] as unknown as Record<string, unknown>)[field];
}

/** Return a copy of `s` with a dotted key replaced. */
export function withSetting(s: SystemSettings, key: SettingKey, value: unknown): SystemSettings {
  const [group, field] = key.split('.') as [keyof SystemSettings, string];
  return { ...s, [group]: { ...(s[group] as object), [field]: value } } as SystemSettings;
}

/** Nested (partial) settings → dotted changes, e.g. { security: { idleMinutes: 30 } } → { "security.idleMinutes": 30 }. */
export function flattenSettings(patch: Partial<Record<keyof SystemSettings, Record<string, unknown>>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [group, fields] of Object.entries(patch)) {
    if (!fields || typeof fields !== 'object') continue;
    for (const [field, value] of Object.entries(fields)) out[`${group}.${field}`] = value;
  }
  return out;
}

/** Rules that span several keys (checked on the merged result). Returns the offending key, if any. */
export function crossFieldProblem(s: SystemSettings): { key: SettingKey; message: string } | null {
  if (s.security.lockoutMaxMinutes < s.security.lockoutBaseMinutes) {
    return { key: 'security.lockoutMaxMinutes', message: 'Must be ≥ lockoutBaseMinutes' };
  }
  if (!s.inventory.allowedKarats.includes(s.hasad.entitlementKarat)) {
    return { key: 'hasad.entitlementKarat', message: 'Must be one of the allowed karats' };
  }
  return null;
}
