# CLN-1 — small code clean-up found during DOC-1

One commit per item, the suites green after each, then push. No migration. Each item was checked in the code first.

1. **Append-only start-up list.** `APPEND_ONLY_TABLES` (`backend/src/core/startup.ts`) lacks `gm_funding_events`. The
   same list also drives the restore drill's trigger check (`backend/src/backup/checks.ts`), so that check widens too.
   - Add the table to the list.
   - New drift test, run in both projects: on the migrated database, read every table that has a
     `jerp_forbid_modification` trigger (`pg_trigger`). Compare that set with `APPEND_ONLY_TABLES`, and with the tables
     the migration files pass to `jerp_lock_append_only`.
   - Prove the test catches a missing table by checking the comparison helper against the list with one table
     removed.
2. **First-steps text.** `FirstSteps.tsx` says "Then the branch manager records the first supplier order …". It
   becomes "Then the General Manager records the first supplier order …", in English and Arabic. No test asserts the
   old text (checked with grep).
3. **21K in the top bar.** `RateChip` reads `current['21']` and shows the label "Gold 21K". The new rule: the chip
   shows the allowed karats (`me.allowedKarats`) that have a rate, highest karat first.
   - At most two are shown; the rest fold into "+n", and the full list goes in the title.
   - With one allowed karat it shows just that one.
   - "Set today's rate" stays for the case where no allowed karat has a rate.
   - Why: no layout change, the same pill, and it reads the setting that already decides what is sold.
   - Other 21 literals were searched for. The comment in `backend/src/core/karats.ts` ("this client: [21]") gets
     fixed. Test data in scripts and tests, the UI kit sample and the catalogue's example text are listed in the
     report, not changed.
4. **Settings that do nothing.** `rates.rateChangeMaxPct` and `rates.goldRateScope` have no reader.
   - Remove them from the Settings screen.
   - `PUT /settings` refuses them with 400 (a `writable: false` flag in the registry). The stored values, defaults and
     history are not touched.
   - Tests: the refusal; the value is unchanged; the history has no new row.
   - `phase1b.test.ts` used `rates.rateChangeMaxPct` as its sample key for version conflicts. It moves to another
     numeric key with the same assertions.
   - BACKLOG gets two blocked items, each with its client question.
5. **Real-looking names.**
   - **Fixture world (`backend/test/fixtures/world-data.ts`):** the company name, the staff and the walk-in customers
     become marked fictional placeholders (`[Test] …` / `[اختبار] …`). The supplier names become `[Test] Supplier A…`.
   - **Tests:** the example usernames in `security.test.ts`, `setup.test.ts`, `passkeys.test.ts`, `catalog.test.ts`
     and the courier in `fix-1.test.ts` change. Usernames that were rejected for a reason are still rejected for the
     same reason.
   - **Code:** the CLI examples in `bootstrap-cli.ts` and `demo-cli.ts`.
   - **Docs:** the REM-3 acceptance example and the UX mockups' staff names.
   - Every figure and assertion stays the same.
   - Not changed: `docs/decisions.md` (append-only history); branch and city names (places, not people).
6. **Package name.** `jewelry-erp-prototype` becomes `jewelry-erp`, edited by hand in `package.json` and the two
   root entries of `package-lock.json`. `check:lockfile` must still pass.
7. **Deployment docs.** The Render material moves into a final appendix, "Worked example, not a decision (HOST-1)".
   `docs/phase0-report.md` moves to `docs/archive/`, and the documentation map is updated.
8. **BACKLOG.** CLN-1 is marked done, and §G drops what is fixed.

Gates at the end: typecheck (with `check:docs`), both vitest projects, build, `i18n:check`, REH-1, e2e print, passkeys
on and off, states, UI kit, perf.

Questions: none blocks.
