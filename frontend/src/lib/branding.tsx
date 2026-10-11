// Company branding from the server (settings). Two sources (UI-A2, D-ui-14):
//   - before sign-in, the public /api/meta: ONLY the company name, the logo and the sign-in tagline;
//   - once signed in, /auth/me: the same plus the currency labels and the invoice footer.
// Refreshed after the GM saves settings. Nothing company-specific is hard-coded in the frontend.

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SETTINGS } from '@jerp/shared';
import { get } from './api';
import { setCurrencyLabels } from './format';
import { useI18n } from './i18n';
import { useAuth } from './auth';

/** What the public sign-in page receives (/api/meta): an allow-list. */
export interface PublicBranding {
  company: { nameEn: string; nameAr: string };
  logoUrl: string | null;
  tagline: { en: string; ar: string };
}

/** What signed-in screens and documents use (/auth/me). */
export interface Branding extends PublicBranding {
  currency: { code: string; labelEn: string; labelAr: string };
  invoiceFooterEn: string;
  invoiceFooterAr: string;
}

export interface Meta {
  branding: PublicBranding;
}

/** Neutral placeholders shown only until /api/meta answers. */
const FALLBACK: Branding = {
  company: { nameEn: DEFAULT_SETTINGS.company.nameEn, nameAr: DEFAULT_SETTINGS.company.nameAr },
  tagline: { en: '', ar: '' },
  currency: { code: DEFAULT_SETTINGS.company.currencyCode, labelEn: DEFAULT_SETTINGS.company.currencyLabelEn, labelAr: DEFAULT_SETTINGS.company.currencyLabelAr },
  logoUrl: null,
  invoiceFooterEn: DEFAULT_SETTINGS.branding.invoiceFooterEn,
  invoiceFooterAr: DEFAULT_SETTINGS.branding.invoiceFooterAr,
};

export const META_QUERY_KEY = ['meta'] as const;

export function useMeta() {
  return useQuery({ queryKey: META_QUERY_KEY, queryFn: () => get<Meta>('/meta'), staleTime: 5 * 60_000, retry: 1 });
}

export function useBranding(): Branding {
  const { me } = useAuth();
  const pub = useMeta().data?.branding;
  if (me?.branding) return me.branding;
  return { ...FALLBACK, ...(pub ?? {}) };
}

/** Keeps the browser title and the currency labels in sync with branding + language. */
export function BrandingSync() {
  const b = useBranding();
  const { L } = useI18n();
  useEffect(() => {
    setCurrencyLabels({ en: b.currency.labelEn, ar: b.currency.labelAr });
  }, [b.currency.labelEn, b.currency.labelAr]);
  const name = L(b.company.nameEn, b.company.nameAr);
  useEffect(() => {
    document.title = `${name} · ERP`;
  }, [name]);
  return null;
}
