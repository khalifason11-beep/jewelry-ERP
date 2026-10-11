// CLN-2: the browser shows dates, times and "today" in the COMPANY time zone (setting company.timezone, sent with the
// session), not a hardcoded one. frontend/src/lib/zone.ts has no React or i18n, so it runs here. Both projects.

import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@jerp/shared';
import { dayKey } from '../src/core/time';
import { FALLBACK_TIME_ZONE, dayKeyIn, displayTimeZone, formatDayKey, formatInstant, numericDateTime, setDisplayTimeZone } from '../../frontend/src/lib/zone';

const DAY: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' };
// 22:30 UTC on 11 October: already 12 October at UTC+2 and later, still 11 October west of UTC.
const NEAR_MIDNIGHT = '2026-10-11T22:30:00Z';

afterEach(() => setDisplayTimeZone(FALLBACK_TIME_ZONE));

describe('display time zone', () => {
  it('before the session loads, the fallback is the settings default (not a client value hidden in code)', () => {
    expect(FALLBACK_TIME_ZONE).toBe(DEFAULT_SETTINGS.company.timezone);
    expect(displayTimeZone()).toBe(FALLBACK_TIME_ZONE);
  });

  it('a different company zone changes the formatted output', () => {
    setDisplayTimeZone('Africa/Khartoum');
    const khartoum = [numericDateTime(NEAR_MIDNIGHT), formatInstant(NEAR_MIDNIGHT, 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })];
    setDisplayTimeZone('Asia/Dubai');
    const dubai = [numericDateTime(NEAR_MIDNIGHT), formatInstant(NEAR_MIDNIGHT, 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })];
    expect(khartoum).toEqual(['2026/10/12 00:30', '00:30']);
    expect(dubai).toEqual(['2026/10/12 02:30', '02:30']);
  });

  it('a moment near midnight lands on the right day in each zone, the same day the server computes', () => {
    for (const [tz, day] of [['Africa/Khartoum', '12 Oct 2026'], ['America/New_York', '11 Oct 2026'], ['UTC', '11 Oct 2026'], ['Pacific/Kiritimati', '12 Oct 2026']] as const) {
      setDisplayTimeZone(tz);
      expect(formatInstant(NEAR_MIDNIGHT, 'en-GB', DAY), tz).toBe(day);
      // "today" in the browser and the business day on the server agree.
      expect(dayKeyIn(new Date(NEAR_MIDNIGHT)), tz).toBe(dayKey(new Date(NEAR_MIDNIGHT), tz));
    }
  });

  it('a business-day key keeps its day in every zone, including zones more than 12 h from UTC', () => {
    for (const tz of ['Africa/Khartoum', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Tokyo']) {
      setDisplayTimeZone(tz);
      expect(formatDayKey('2026-10-11', 'en-GB', DAY), tz).toBe('11 Oct 2026');
    }
  });

  it('an empty or unknown zone keeps the current one', () => {
    setDisplayTimeZone('Asia/Dubai');
    setDisplayTimeZone('');
    setDisplayTimeZone('Not/AZone');
    expect(displayTimeZone()).toBe('Asia/Dubai');
  });
});
