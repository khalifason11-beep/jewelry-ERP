// Display formatting. Western digits are used in both languages (trade convention in Sudan).

const TZ = 'Africa/Khartoum';

export const money = (n: number | null | undefined, withCurrency = true) =>
  n == null ? '—' : `${Math.round(n).toLocaleString('en-US')}${withCurrency ? ' SDG' : ''}`;

export const compactMoney = (n: number | null | undefined) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
};

export const grams = (mg: number | null | undefined, unit = true) =>
  mg == null ? '—' : `${(mg / 1000).toFixed(3)}${unit ? ' g' : ''}`;

export const signedGrams = (mg: number) => `${mg > 0 ? '+' : mg < 0 ? '−' : ''}${(Math.abs(mg) / 1000).toFixed(3)} g`;

export const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}%`);

function locale(lang: string) {
  return lang === 'ar' ? 'ar-SD-u-nu-latn' : 'en-GB';
}

export const dateTime = (d: string | Date | null | undefined, lang = 'en') =>
  d ? new Date(d).toLocaleString(locale(lang), { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export const date = (d: string | Date | null | undefined, lang = 'en') =>
  d ? new Date(typeof d === 'string' && d.length === 10 ? `${d}T12:00:00Z` : d).toLocaleDateString(locale(lang), { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const time = (d: string | Date | null | undefined, lang = 'en') =>
  d ? new Date(d).toLocaleTimeString(locale(lang), { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—';

export function relative(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Business "today" as YYYY-MM-DD in the company timezone. */
export function todayKey(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p;
}

export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const humanize = (s: string | null | undefined) =>
  s ? s.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—';
