// Owner decision (D-print-9): the invoice footer is only a thank-you message. New defaults, demo seed,
// and the start-up step that replaces an UNEDITED old default (exact match) while never touching a
// footer the General Manager edited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { DEFAULT_SETTINGS, LEGACY_INVOICE_FOOTERS } from '@jerp/shared';
import { createContext } from '../src/bootstrap';
import type { Ctx } from '../src/core/context';
import { replaceLegacyInvoiceFooters } from '../src/modules/settings/legacy-footer';
import { COMPANY } from '../src/seed/catalog';
import { seedDemo } from '../src/seed/demo';
import { openTestDatabase } from './helpers';

const FORBIDDEN = /making|prototype|tax invoice|المصنعية|نموذج أولي|ضريبية/i;
let handle: DatabaseHandle;
let ctx: Ctx;
const system = { actor: { id: null, username: 'test' }, allowGuarded: false };

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
});
afterAll(async () => handle?.close());

describe('invoice footer', () => {
  it('defaults and demo seed are a thank-you message only', () => {
    expect(DEFAULT_SETTINGS.branding).toMatchObject({ invoiceFooterEn: 'Thank you for shopping with us', invoiceFooterAr: 'شكراً لتسوقكم معنا' });
    expect([COMPANY.invoiceFooter, COMPANY.invoiceFooterAr]).toEqual(['Thank you for shopping with us', 'شكراً لتسوقكم معنا']);
    for (const s of [DEFAULT_SETTINGS.branding.invoiceFooterEn, DEFAULT_SETTINGS.branding.invoiceFooterAr, COMPANY.invoiceFooter, COMPANY.invoiceFooterAr]) expect(s).not.toMatch(FORBIDDEN);
  });

  it('start-up replaces an unedited OLD default (exact match) and audits it as System', async () => {
    await ctx.settings.apply(ctx.db, { 'branding.invoiceFooterEn': LEGACY_INVOICE_FOOTERS.en[1], 'branding.invoiceFooterAr': LEGACY_INVOICE_FOOTERS.ar[0] }, system);
    expect(await replaceLegacyInvoiceFooters(ctx)).toEqual(expect.arrayContaining(['branding.invoiceFooterEn', 'branding.invoiceFooterAr']));
    const { branding } = await ctx.settings.get();
    expect(branding).toMatchObject({ invoiceFooterEn: 'Thank you for shopping with us', invoiceFooterAr: 'شكراً لتسوقكم معنا' });
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'SETTINGS_CHANGED')).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(audit).toMatchObject({ username: 'system', userFullName: 'System (system)', entityType: 'settings' });
    // Idempotent: nothing left to replace.
    expect(await replaceLegacyInvoiceFooters(ctx)).toEqual([]);
  });

  it('a footer the General Manager edited is never touched, even if it contains an old phrase', async () => {
    const edited = { en: 'Thank you for your purchase · Prices include making charges · Visit us again', ar: 'شكراً لتسوقكم معنا · الأسعار شاملة المصنعية!' };
    await ctx.settings.apply(ctx.db, { 'branding.invoiceFooterEn': edited.en, 'branding.invoiceFooterAr': edited.ar }, system);
    expect(await replaceLegacyInvoiceFooters(ctx)).toEqual([]);
    expect((await ctx.settings.get()).branding).toMatchObject({ invoiceFooterEn: edited.en, invoiceFooterAr: edited.ar });
  });

  it('a fresh demo seed stores the new footer', async () => {
    const h = await openTestDatabase();
    try {
      const c = createContext(h);
      await seedDemo(c);
      expect((await c.settings.get()).branding).toMatchObject({ invoiceFooterEn: 'Thank you for shopping with us', invoiceFooterAr: 'شكراً لتسوقكم معنا' });
    } finally {
      await h.close();
    }
  });
});
