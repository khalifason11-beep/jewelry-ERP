// Lightweight localization: English source strings are the keys; Arabic is a dictionary
// (./i18n-ar.ts). Arabic is the default language; English stays available via the switcher.
// Switching language flips the document direction (RTL). Missing keys fall back to English.
//
// Interpolation: t('Item {code} not found', { code: 'J-1001' }). Placeholder names are kept
// verbatim in both languages.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AR } from './i18n-ar';

export type Lang = 'en' | 'ar';
export type Params = Record<string, string | number | null | undefined>;

const DEFAULT_LANG: Lang = 'ar';

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem('jerp.lang');
    return v === 'en' || v === 'ar' ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

// Module-level language so non-React code (formatters, API errors, toasts) can translate too.
let currentLang: Lang = readStoredLang();
export const getLang = (): Lang => currentLang;

export function interpolate(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
}

/**
 * Marks an English string as a translation key without translating it yet (for module-level
 * constants). Translate at render time with t(value).
 */
export const tk = (s: string) => s;

/** Translate outside React components (uses the current language). */
export function translate(key: string, params?: Params): string {
  const s = currentLang === 'ar' ? (AR[key] ?? key) : key;
  return interpolate(s, params);
}

interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (l: Lang) => void;
  t: (s: string, params?: Params) => string;
  /** Pick the localized field of a record (e.g. name / nameAr). */
  L: (en?: string | null, ar?: string | null) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang);
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);
  const setLang = useCallback((l: Lang) => {
    currentLang = l;
    setLangState(l);
    try {
      localStorage.setItem('jerp.lang', l);
    } catch {
      /* storage unavailable — language applies to this visit only */
    }
  }, []);
  const value = useMemo<I18n>(
    () => ({
      lang,
      dir,
      setLang,
      t: (s, params) => interpolate(lang === 'ar' ? (AR[s] ?? s) : s, params),
      L: (en, ar) => (lang === 'ar' ? ar || en || '' : en || ar || ''),
    }),
    [lang, dir, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}
