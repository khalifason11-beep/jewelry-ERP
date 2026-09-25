// Display formatting. Western digits (0-9) are used in both languages for amounts and weights
// (trade convention in Sudan); dates use Arabic month names when the UI is in Arabic.

import { getLang, translate } from './i18n';

const TZ = 'Africa/Khartoum';

const currency = () => (getLang() === 'ar' ? 'ج.س' : 'SDG');
const gramUnit = () => (getLang() === 'ar' ? 'جم' : 'g');

export const money = (n: number | null | undefined, withCurrency = true) =>
  n == null ? '—' : `${Math.round(n).toLocaleString('en-US')}${withCurrency ? ` ${currency()}` : ''}`;

export const compactMoney = (n: number | null | undefined) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const ar = getLang() === 'ar';
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}${ar ? ' مليار' : 'B'}`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}${ar ? ' مليون' : 'M'}`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}${ar ? ' ألف' : 'K'}`;
  return String(Math.round(n));
};

export const grams = (mg: number | null | undefined, unit = true) =>
  mg == null ? '—' : `${(mg / 1000).toFixed(3)}${unit ? ` ${gramUnit()}` : ''}`;

export const signedGrams = (mg: number) => `${mg > 0 ? '+' : mg < 0 ? '−' : ''}${(Math.abs(mg) / 1000).toFixed(3)} ${gramUnit()}`;

/** "عيار 21" in Arabic, "21K" in English. */
export const karatLabel = (k: number | null | undefined) => (k == null ? '—' : getLang() === 'ar' ? `عيار ${k}` : `${k}K`);

export const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}%`);

/** Arabic month names with Latin digits (nu-latn) in Arabic; en-GB otherwise. */
function locale(lang: string) {
  return lang === 'ar' ? 'ar-SD-u-nu-latn' : 'en-GB';
}

export const dateTime = (d: string | Date | null | undefined, lang: string = getLang()) =>
  d ? new Date(d).toLocaleString(locale(lang), { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export const date = (d: string | Date | null | undefined, lang: string = getLang()) =>
  d ? new Date(typeof d === 'string' && d.length === 10 ? `${d}T12:00:00Z` : d).toLocaleDateString(locale(lang), { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const time = (d: string | Date | null | undefined, lang: string = getLang()) =>
  d ? new Date(d).toLocaleTimeString(locale(lang), { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—';

/** Short day label for chart axes, e.g. "24 سبتمبر" / "24 Sep". */
export const shortDay = (key: string) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(locale(getLang()), { timeZone: TZ, day: 'numeric', month: 'short' });

export function relative(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return translate('just now');
  if (s < 3600) return translate('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return translate('{h} h {m} min ago', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
  return translate('{n} d ago', { n: Math.round(s / 86400) });
}

/** Business "today" as YYYY-MM-DD in the company timezone. */
export function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Localized label for an enum value (e.g. RENT, CASHIER). Falls back to "Rent". */
export const humanize = (s: string | null | undefined) => {
  if (!s) return '—';
  const tr = translate(s);
  if (tr !== s) return tr;
  return s.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
};

/** Device label from the server ("Chrome on Windows") in the current language. */
export function deviceText(d: string | null | undefined): string {
  if (!d) return '—';
  const [browser, os] = d.split(' on ');
  return os ? translate('{browser} on {os}', { browser: translate(browser), os: translate(os) }) : translate(browser);
}
