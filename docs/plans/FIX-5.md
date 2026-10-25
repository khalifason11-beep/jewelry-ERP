# FIX-5: the PostgreSQL funding test failure (part 1) and OPN-FIX (part 2)

Branch `claude/fix-5-opn-fix` from main `55a4ea0` (OPN-2 merged; last migration 0031, so OPN-FIX starts at 0032).
Owner addendum 2026-10-25: order (a) PERF-1 note, (b) part 1 and the CLAUDE.md rules, (c) the OPN-FIX plan
(`docs/plans/OPN-FIX.md`), then **stop** for the owner's approval. OPN-FIX is not implemented before it.

## 1. PERF-1 (BACKLOG, known debt)

The sales CSV walk of the perf script (60,137 rows in 301 pages) is over its 30 s budget on this container on main as
on the OPN-2 branch: median 35,132 ms (main, 4 runs) against 35,220 ms (branch, 4 runs). No investigation now and the
budget is unchanged: re-measure on the production server (Hostinger VPS) at the first deployment; open an investigation
only if it still fails there.

## 2. Part 1: "correcting an advance that was already repaid…" (`funding.test.ts`, PostgreSQL)

### Evidence (kept in the session's scratch folder; the failures' full output is quoted in the report)

| Runs | Conditions | Failures |
|---|---|---|
| 100 | the file alone on PostgreSQL, one after another | 4 |
| 15 (stopped for OPN-2) | under CPU stress (4 busy processes) | 0 |
| to finish | under CPU stress, 50 runs | see report |
| to run | in parallel with the other PostgreSQL test files | see report |

Every failure is the same refusal: `DRAWER_SHORT`, "The drawer holds 62,748,300: a repayment of 65,050,000 from it is
2,301,700 more than that" (once 62,963,300). The test repays **everything BHR owes the General Manager plus 50,000, in
cash**, and expects the drawer to hold it.

### Cause: the test, in two layers (the code is right to refuse)

1. **The test depends on the calendar.** BHR's drawer holds what 30 days of fixture trading leave, which depends on the
   weekday and the hour the world is built for (business time, Africa/Khartoum). A sweep of the world showed the drawer
   short all day on Wednesdays and from 00:00 to 00:29 on Sundays.
2. **The fixture world is not deterministic on PostgreSQL.** `available(code)` in `test/fixtures/world.ts` reads the
   branch's pieces with no `ORDER BY`, and the sales pick a piece by a seeded random index into that list. PostgreSQL
   returns heap order, which changes with where updated rows land: 20 builds of the world for the same instant gave 4
   different worlds (BHR's drawer 65,063,300 in 19, 62,698,300 in 1). So the test failed even outside those windows.

Not a race in the code: the funding service locks the accounts (ascending id) before reading any balance, and every
failure is a correct refusal of a drawer that really is short.

### Fix (test and fixture only; no assertion loosened, no code change)

- **Layer 1:** the test funds BHR's drawer itself before the repayment (a recorded GM funding of the needed amount, as
  every cash test that needs cash should), so the drawer can never be short because of the calendar. Its assertions
  stay: the correction is refused with "already been repaid in part" and the branch owes 0.
- **Layer 2:** every fixture query that picks rows gets a deterministic `ORDER BY` (the piece query first; the other
  fixture queries are checked and fixed the same way).
- **The guard stays covered, deterministically:** a new test sets up a drawer that really is short by a known amount
  and checks the repayment is always refused with the same `DRAWER_SHORT` code, numbers and message, and that nothing
  is written (run in the same 100-run loop).
- **A determinism check** (`world-dates`): building the world twice for the same instant gives the same sold pieces
  and the same balances (it fails on PostgreSQL before the ORDER BY fix).

### Proof

The file alone on PostgreSQL ≥ 100 times, under CPU stress, and in parallel with the other PostgreSQL files: failures /
runs reported (target 0; any failure reported, never hidden).

## 3. CLAUDE.md (owner rules)

- Testing rules: never depend on wall-clock time, weekday, locale or unordered query results; every fixture query that
  picks rows has an `ORDER BY`; a test that needs cash funds its own drawer.
- REH-1: any change that adds or changes a route, a menu item, a page, a permission, a setting, a field in a response
  or a user-visible flow updates REH-1 in the same commit; REH-1 runs before every push and no pushed commit leaves it
  red; the final report states the REH-1 count and the previous one.

## 4. Part 2: OPN-FIX

Plan in `docs/plans/OPN-FIX.md` (updated for OPN-2: correcting the condition changes the price and the valuation).
**Stop for the owner's approval** before any code.

## 5. Commits

| Commit | Content |
|---|---|
| c0 | This plan |
| c1 | PERF-1 in the BACKLOG |
| c2 | Part 1: fixture ORDER BYs, the test funds its drawer, the deterministic DRAWER_SHORT test, the determinism check |
| c3 | CLAUDE.md: the testing rules and the REH-1 rule |
| c4 | `docs/plans/OPN-FIX.md` (then stop) |
