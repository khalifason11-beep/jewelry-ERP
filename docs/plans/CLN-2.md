# CLN-2 — display time zone from the company setting; unused fixture translations

Small commits, each with the suites green, each pushed. No migration.

1. **Display time zone.** `frontend/src/lib/format.ts` fixes `TZ = 'Africa/Khartoum'`. The server already sends the
   company zone (`company.timezone`, in `GET /auth/me` as `timezone`).
   - A new dependency-free module, `frontend/src/lib/zone.ts`, holds the current display zone. The fallback, used only
     before the session has loaded, is the settings default (`DEFAULT_SETTINGS.company.timezone`), named in a comment.
   - Every helper in `format.ts` reads the zone from that module.
   - `auth.tsx` sets the zone from `me.timezone` when the session loads, before anything renders.
   - **Second bug, found while reading:** the helpers that format a business-day key (`date('2026-10-11')`, `shortDay`)
     turn the key into 12:00 UTC and then format it in the display zone. That moves the day in any zone more than 12 h
     from UTC (for example `Pacific/Kiritimati`, UTC+14). A key is already a calendar day, so it is formatted in UTC.
   - **Test** (backend vitest, both projects; the frontend has no test runner, and `zone.ts` has no imports):
     - a different company zone changes the formatted output;
     - a moment near midnight lands on the right day in each zone;
     - a day key keeps its day in every zone;
     - `todayKey()` follows the zone.
   - **Backend checked:** `core/time.ts` and every service and SQL query take `company.timezone`. No other place assumes
     Khartoum; the remaining assumptions are listed in the report.
2. **Translations.** Remove the Arabic entries for the old fixture branch and city names that no shipped code uses.
   `i18n:check` stays green.
3. **BACKLOG.** Mark CLN-2 done, and remove the time-zone line from §G.

Questions: none.
