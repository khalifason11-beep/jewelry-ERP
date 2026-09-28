// Validation for system settings (H-5). `PUT /settings` accepts a partial patch; every section and
// every key is strict (unknown keys are rejected), numbers are bounded, and the timezone must be
// a real IANA zone. Phase 1b replaces this with the typed per-key settings registry.

import { z } from 'zod';
import type { SystemSettings } from '@jerp/shared';
import { ROLE_CODES } from '@jerp/shared';

const roleKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const timezone = z.string().min(1).max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown timezone');

const sections = {
  company: z.object({
    name: z.string().trim().min(1).max(80),
    nameAr: z.string().trim().min(1).max(80),
    currency: z.string().trim().min(1).max(8),
    timezone,
  }),
  sales: z.object({
    maxDiscountPercentByRole: z.record(roleKey, int(0, 100)),
  }),
  expenses: z.object({
    approvalThreshold: int(0, 1_000_000_000),
  }),
  hasad: z.object({
    settlementBasis: z.enum(['NET_WEIGHT', 'PURE_GOLD_EQUIVALENT']),
    rateSource: z.enum(['ITEM_KARAT', 'ENTITLEMENT_KARAT']),
    entitlementKarat: z.union([z.literal(18), z.literal(21), z.literal(22), z.literal(24)]),
    reservationTimeoutMinutes: int(5, 24 * 60),
  }),
  security: z.object({
    allowSelfPasswordChange: z.boolean(),
    sessionIdleMinutes: int(1, 240),
    idleMinutesByRole: z.record(roleKey, int(1, 240)),
    sessionAbsoluteHours: int(1, 24),
    minPasswordLength: int(10, 128),
    lockoutThreshold: int(3, 20),
    lockoutBaseMinutes: int(1, 24 * 60),
    lockoutMaxMinutes: int(1, 24 * 60),
  }),
  mockHasad: z.object({
    latencyMs: int(0, 10_000),
    simulateOutage: z.boolean(),
  }),
};

/** Complete settings (used to normalise what is stored: unknown/legacy keys are dropped). */
export const settingsSchema = z.object(sections);

/** A patch: any subset of sections, each a strict subset of its keys. */
export const settingsPatchSchema = z
  .object({
    company: sections.company.partial().strict(),
    sales: sections.sales.partial().strict(),
    expenses: sections.expenses.partial().strict(),
    hasad: sections.hasad.partial().strict(),
    security: sections.security.partial().strict(),
    mockHasad: sections.mockHasad.partial().strict(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Empty settings patch')
  .superRefine((p, ctx) => {
    const s = p.security;
    if (s?.lockoutBaseMinutes != null && s.lockoutMaxMinutes != null && s.lockoutMaxMinutes < s.lockoutBaseMinutes) {
      ctx.addIssue({ code: 'custom', path: ['security', 'lockoutMaxMinutes'], message: 'Must be ≥ lockoutBaseMinutes' });
    }
    for (const role of Object.keys(s?.idleMinutesByRole ?? {})) {
      if (!(ROLE_CODES as readonly string[]).includes(role)) {
        ctx.addIssue({ code: 'custom', path: ['security', 'idleMinutesByRole', role], message: 'Unknown role' });
      }
    }
  });

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Normalise a stored/merged settings object; falls back to defaults for invalid sections. */
export function normaliseSettings(merged: SystemSettings, defaults: SystemSettings): SystemSettings {
  const out: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(sections)) {
    const r = schema.safeParse((merged as unknown as Record<string, unknown>)[k]);
    out[k] = r.success ? r.data : (defaults as unknown as Record<string, unknown>)[k];
  }
  return out as unknown as SystemSettings;
}
