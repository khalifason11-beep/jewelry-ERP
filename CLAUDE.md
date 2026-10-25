# Working rules for this repository

Multi-branch jewelry retail ERP, pre-production. Read `README.md`, `docs/BACKLOG.md` (§0 working agreement) and
`docs/decisions.md` before changing anything. These rules hold for every session and every item.

## Workflow

1. **Plan first:** `docs/plans/<ITEM>.md`, short. Implement only what the item asks; no other BACKLOG item.
2. **Commits:** small commits, one concern per commit. The suite must be green after each, and each is pushed.
3. **Git:**
   - Never open or merge a pull request; the owner does.
   - Never rewrite pushed history; never force-push.
   - Bring the working branch up to date with `main` by a plain fast-forward only.
4. **Before editing code:** read the module's tests and the route-matrix entries it touches
   (`shared/src/route-matrix.ts`).
5. **After editing:** run the narrowest tests first, then the full gates (`npm run verify`, with `--full` before a
   report).
6. **REH-1 moves with the change:** any change that adds or changes a route, a menu item, a page, a permission, a
   setting, a field in a response or a user-visible flow updates the REH-1 rehearsal **in the same commit**. REH-1 and
   the browser scripts that touch the change are run before every push; no pushed commit may leave them red, even
   between commits of the same item (UX-1, PRC-1 and OPN-1 each broke REH-1 for a commit). The final report states the
   REH-1 check count and the previous count.
7. **Surprises:** if something unexpected shows up (a flaky test, surprising behaviour, a doc that disagrees with the
   code), stop and report it. Do not paper over it. "Flaky" is not a root cause.

## Testing rules

- A test never depends on the wall-clock time, the weekday, the locale or the order of an unordered query result. A
  test that needs a date or an hour fixes it; the fixture world is built for a given instant.
- Every fixture or test query that picks rows (to sell, transfer, sample or compare) has an `ORDER BY`. PostgreSQL
  returns unordered rows in heap order, which changes between runs (FIX-5: the same instant built different worlds).
- A test that needs cash funds its own drawer (its own branch, or a recorded advance it makes itself); it never relies
  on what the fixture world left in a drawer.

## Hard rules

- **Never edit an applied migration.**
  - A schema change is a NEW numbered migration.
  - Order: additive first (nullable column, new table, new index); backfill in a separate step; tighten constraints
    in a later migration.
  - Every migration is hand-reviewed and must run against a database that already holds data.
  - `database/migrations/checksums.json` freezes applied files; `npm run check:migrations` enforces it.
- **Never DROP, TRUNCATE or DELETE-all in a migration** without a written `D-*` decision and the owner's approval.
  The statement carries `-- allow-destructive: D-xxx <reason>`.
- **Never loosen anything to make a test pass:** a security rule, trigger, role grant, CSRF or Origin check, the
  COST/SAFE classification (`shared/src/field-classification.ts`), or the route matrix. A failing test means the code
  is wrong or the test is stale: say which, and why, in the report.
- **Never hardcode anything client-specific:** names, karats, rates, branches, time zone, or currency beyond the
  setting.
- **No new dependency** without:
  - a one-line justification;
  - a pinned version;
  - a check that it installs on Linux and Windows (`npm run check:lockfile`);
  - a note in the report.

  Prefer none.
- **Money and weights:** money is whole integers in the smallest unit; weight is integer mg; BigInt-safe math
  (`shared/src/money.ts`). New money or weight code gets property tests.
- **Writes:** anything that writes money, stock or ledgers runs in one transaction, with row locks and an
  Idempotency-Key, and is audited. Never edit or delete history; correct by reversal.
- **Document in the same commit:** every new setting, env var, route, table and error code goes in `DEPLOYMENT.md`,
  the route matrix, or `decisions.md`. `npm run check:docs` stays green.

## Never without the owner's written approval

- Destructive migrations, or edits to an applied migration.
- Changes to business rules, screens, texts, settings, or money logic outside the item asked for.
- Choosing a hosting provider (HOST-1), adding a paid service, or opening a pull request.
- Weakening or skipping a test, gate, security check or production start-up refusal.
- Adding a dependency, or upgrading one beyond a patch.

## Gates (commands)

| Gate | Command |
|---|---|
| Everything, stop at first failure | `npm run verify` (add `-- --full` for the browser gates and perf) |
| Static checks + tsc | `npm run typecheck` (check:lockfile, hasad, migrations, drizzle, test-imports, assets, docs) |
| Tests on PGlite | `npm test` |
| Tests on real PostgreSQL too | `TEST_DATABASE_URL=postgresql://<role with CREATEDB+CREATEROLE, not superuser>@localhost:5432/postgres npm test` |
| Build | `npm run build` |
| Localization | `npm run i18n:check` |
| Empty-database rehearsal (REH-1) | `REHEARSAL_ADMIN_URL=postgresql://… npm run rehearsal` |
| Browser checks | `node scripts/e2e-print.mjs`, `node scripts/e2e-passkeys.mjs` (and `--mode=off`), `node scripts/e2e-states.mjs`, `node scripts/capture-ui-kit.mjs` |
| Performance | `REHEARSAL_ADMIN_URL=postgresql://… node scripts/perf-homes.mjs` |
| Server preflight (read-only) | `node scripts/server/preflight.mjs` |

The capture script re-saves `docs/ux/ui-kit/*.webp`. Restore them with `git restore docs/ux/ui-kit/` unless the kit
really changed.

## CI

`.github/workflows/ci.yml` runs on every push and pull request. The **required status checks** for `main` are:

- `typecheck`
- `test-pglite`
- `test-postgres`
- `build`

`smoke` (REH-1 and the e2e scripts) runs too, but is not required until it has proved stable.

## Every report states

1. Commits and hashes.
2. Test totals.
3. The REH-1 check count.
4. Gates run, and any **not** run, with the reason.
5. The `npm run verify` summary, pasted.
6. Risks.
7. What was **not** done.
8. Questions.
