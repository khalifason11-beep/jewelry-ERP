// The display time zone (CLN-2). Every date, time and "today" the browser shows is computed in the COMPANY time zone
// (setting `company.timezone`, sent by GET /auth/me as `timezone`), never the browser's own zone and never a hardcoded
// one. auth.tsx sets it as soon as the session loads, before any screen renders.
//
// No React and no i18n here, so the backend test suite can exercise it (backend/test/display-zone.test.ts).

import { DEFAULT_SETTINGS } from '@jerp/shared';

/**
 * FALLBACK, visible on purpose: used only before the session has loaded (the sign-in page shows no dates). It is the
 * settings DEFAULT, not a client's zone; once signed in, the company's own setting replaces it.
 */
export const FALLBACK_TIME_ZONE = DEFAULT_SETTINGS.company.timezone;

let zone = FALLBACK_TIME_ZONE;

/** Called with the company time zone from the session; an invalid or empty value keeps the current zone. */
export function setDisplayTimeZone(tz: string | null | undefined): void {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    zone = tz;
  } catch {
    /* unknown zone: keep the previous one (the server validates the setting, so this is not expected) */
  }
}

export const displayTimeZone = () => zone;

/** A moment (timestamp) formatted in the display zone. */
export const formatInstant = (d: string | Date, locale: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(d).toLocaleString(locale, { ...opts, timeZone: zone });

/**
 * A business-day key ("2026-10-11") formatted as that calendar day. A key is already a day in the company zone, so it
 * is read and formatted in UTC: converting it to a moment and back in the display zone would move it by one day in
 * zones more than 12 h from UTC.
 */
export const formatDayKey = (key: string, locale: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString(locale, { ...opts, timeZone: 'UTC' });

/** YYYY-MM-DD of a moment in the display zone (or in `tz`). */
export const dayKeyIn = (d: Date, tz: string = zone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Short numeric date-time for narrow print formats: "2026/10/04 16:42" (Western digits, 24 h, display zone). */
export function numericDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(d))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}
