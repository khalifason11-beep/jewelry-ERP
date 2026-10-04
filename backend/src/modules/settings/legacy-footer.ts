// One-time start-up step (D-print-9): replace an invoice footer that still holds an OLD default text
// (exact match) with the current default. A footer the General Manager edited is never touched; a
// footer never stored already falls back to the new code default. Audited as System.

import { inArray } from 'drizzle-orm';
import { t } from '@jerp/database';
import { DEFAULT_SETTINGS, LEGACY_INVOICE_FOOTERS } from '@jerp/shared';
import type { Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';

const KEYS = { en: 'branding.invoiceFooterEn', ar: 'branding.invoiceFooterAr' } as const;

export async function replaceLegacyInvoiceFooters(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db.select({ key: t.settings.key, value: t.settings.value }).from(t.settings).where(inArray(t.settings.key, [KEYS.en, KEYS.ar]));
  const changes: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.key === KEYS.en && LEGACY_INVOICE_FOOTERS.en.includes(r.value as string)) changes[KEYS.en] = DEFAULT_SETTINGS.branding.invoiceFooterEn;
    if (r.key === KEYS.ar && LEGACY_INVOICE_FOOTERS.ar.includes(r.value as string)) changes[KEYS.ar] = DEFAULT_SETTINGS.branding.invoiceFooterAr;
  }
  if (!Object.keys(changes).length) return [];
  return ctx.db.transaction(async (tx) => {
    const reason = 'Old default invoice footer replaced by the new default (thank-you message only)';
    const { changed } = await ctx.settings.apply(tx, changes, { actor: { id: null, username: 'system' }, reason });
    if (changed.length) {
      await writeAudit(tx, null, {
        action: 'SETTINGS_CHANGED',
        entityType: 'settings',
        entityId: changed.map((c) => c.key).join(','),
        branchId: null,
        systemActor: 'system',
        key: 'Unedited default invoice footer updated to the new default',
        params: {},
        metadata: { changes: changed, reason },
      });
    }
    return changed.map((c) => c.key);
  });
}
