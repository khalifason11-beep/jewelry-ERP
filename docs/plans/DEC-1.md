# DEC-1: record the owner's decisions, discounts off, gold-rate edit guard

Owner decisions of 2026-10-18. Branch `claude/dec-1-decisions` from main `b4d51ad` (PRC-1 merged). Nothing
client-specific is hardcoded: every behaviour is a setting whose default matches this client.

## Commits

| # | Concern | Code? |
|---|---|---|
| c0 | This plan | no |
| c1 | SPEC §20 answers (Q-2, Q-3, Q-4, Q-6, Q-7, Q-8, Q-9, Q-10, Q-12, RAT-2), BACKLOG statuses and rewrites (SPL-1, MNY-1, HSD-2, OPN-1, CAT-1, §H), D-dec1-1…10 | docs only |
| c2 | Discounts off: default caps 0; the POS hides the discount control when the role's cap is 0 | code |
| c3 | RAT-1 gold-rate edit guard (server, settings, tests) | code |
| c4 | Prices page: % change, reason, password; thresholds editable; allowed-karats proof test (Part 4) | code |
| c5 | REH-1/e2e adjustments, acceptance `docs/acceptance/DEC-1.md`, BACKLOG close-out, gates | docs/scripts |

## Part 2: discounts off

- `sales.maxDiscountPercentByRole` default `{CASHIER: 0, BRANCH_MANAGER: 0, GENERAL_MANAGER: 0}`. Stored values are
  not rewritten: an installation that saved the setting keeps it. **An installation that never saved it now gets 0.**
- The server already refuses a discount above the cap (0 refuses any). The POS reads `maxDiscountPercent` from
  `/auth/me` and renders no discount field, no "max %" hint and no price-change reason when it is 0.
- The fixture world stores the old caps (3/10/20, test values) explicitly so existing discount tests stay as they
  are; new tests run with the defaults. REH-1 and e2e-print set a cap through Settings before the parts that discount.

## Part 3: gold-rate edit guard (RAT-1)

- New settings `rates.warnChangePercent` (10) and `rates.confirmChangePercent` (30): whole percent, General Manager
  only, cross-field rule `0 < warn < confirm ≤ 100`, settings history as usual. The old unused
  `rates.rateChangeMaxPct` stays hidden and write-refused (superseded; not deleted).
- Applies to `POST /gold-rates` (new and used selling rates) and `POST /scrap-rates` (scrap buying rates). For each
  real change, compare with the **previous value of the same rate**, read inside the transaction after a lock that
  serialises rate edits (gold: the existing exclusive pricing lock; scrap: an advisory lock of its own; the rate tables
  are append-only, so `FOR UPDATE` on their rows is not available to the runtime role):
  - no previous value (first rate of a karat/kind): not checked;
  - `|new − old| × 100 ≤ warn × old`: allowed;
  - above that, `≤ confirm × old`: needs `reason` (SEC-2 rule: 3–200 characters) → else **422 `RATE_CHANGE_REASON_REQUIRED`**;
  - above `confirm × old`: needs `reason` **and** `confirmPassword` → else **403 `RATE_CHANGE_CONFIRM_REQUIRED`**.
  Integer/BigInt only; the percentage is reported in basis points (`mulDivRound`).
- **"Fresh" password:** every rate edit already needs the 5-minute re-auth window (route matrix `reauth: true`), so
  the >30 % rule asks for the password **in the request** and checks it with the same function as `POST
  /auth/reauth` (failed attempts count towards the lockout; a wrong password → 403 `REAUTH_FAILED`).
- Audit: `GOLD_RATE_CHANGED` / `SCRAP_RATE_CHANGED` metadata gains `changeBp`, `guard` (`NONE|REASON|CONFIRMED|FIRST`)
  and the reason. No migration.

## Part 4: allowed karats

PRC-1 (D-prc1-7) already made rates follow `inventory.allowedKarats` on main. Add a test: with every karat the
Settings screen offers allowed, both selling rates can be set for each; with a subset, every other karat 1–24 is
refused. Scrap buying rates stay open to any karat 1–24 (broken scrap of any karat, D-4-1).

## Tests

`dec1-discounts.test.ts`, `dec1-rate-guard.test.ts` (both projects: boundaries at exactly 10 % and 30 % and 1 SDG
either side, increase and decrease, first rate, missing reason, missing/wrong password, settings validation, scrap
rates), `pg/rate-guard-race.test.ts` (two concurrent edits cannot both pass against a stale previous value), generated
route-matrix tests unchanged in shape, `dec1-karats.test.ts`.

## Risks

- Existing installs without a stored discount setting lose discounts on upgrade (intended for this client; noted).
- A rate edit that changes several karats is all-or-nothing: one refused change refuses the whole request.
