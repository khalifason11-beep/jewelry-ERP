// Company branding from the server (settings): names, logo, invoice footer, currency labels.
// Loaded once from the public /api/meta endpoint (the login page needs it too) and refreshed after
// the GM saves settings. Nothing company-specific is hard-coded in the frontend.

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SETTINGS } from '@jerp/shared';
import { get } from './api';
import { setCurrencyLabels } from './format';
import { useI18n } from './i18n';

export interface Branding {
  company: { nameEn: string; nameAr: string };
  currency: { code: string; labelEn: string; labelAr: string };
  logoUrl: string | null;
  invoiceFooterEn: string;
  invoiceFooterAr: string;
}

export interface Meta {
  appMode: 'demo' | 'production';
  branding: Branding;
}

/** Neutral placeholders shown only until /api/meta answers. */
const FALLBACK: Branding = {
  company: { nameEn: DEFAULT_SETTINGS.company.nameEn, nameAr: DEFAULT_SETTINGS.company.nameAr },
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
  return useMeta().data?.branding ?? FALLBACK;
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
