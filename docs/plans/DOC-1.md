# DOC-1 — the README as a description of the system; docs brought up to date

Documentation only: no code, no migration, no behaviour change. Every statement is checked against the code or the
migrations; where a document and the code disagree, the code wins and the report lists the wrong statement.

## New README outline (English, factual, short, nothing client-specific)

1. What it is: a multi-branch jewelry retail ERP, Arabic-first (RTL), gold sold in the karats chosen in Settings, scrap
   bought in any karat 1–24. No external integrations.
2. Status: pre-production. Not for real client data until BACKLOG §F (production readiness) is done.
3. Quick start: `npm run demo` (empty database, first General Manager, passkey note), Codespaces, `dev:sample`, `npm run
   dev`, real PostgreSQL, Windows notes. The phone-oriented remark goes.
4. Roles and what each one sees (cashier, branch manager, General Manager; GM-only permissions).
5. Money model: ledger accounts, event types, drawer BLOCK / bank WARN, GM funding, Hasad receivable, making charge
   paid by the owner outside the ledger, cost visibility.
6. Gold model: allowed karats, items vs broken-scrap pool, 24K equivalent, gold-for-gold supplier orders, settlement
   with scrap, SUP-1 warning.
7. Security summary: auth, passkeys, reauth, CSRF, route matrix, field classification, append-only, idempotency.
8. Testing and gates: `npm test` (PGlite / PostgreSQL), `typecheck` chain, `i18n:check`, browser scripts, REH-1, perf.
9. Production mode: required variables, roles, bootstrap, migrations. Hosting is undecided: requirements, not a vendor.
10. Operator commands: all four.
11. Documentation map. 12. Repository layout.

## Files touched

- `README.md` rewritten; `docs/FEATURES.md` new (feature by feature, by capability).
- `docs/ARCHITECTURE.md` replaced (the old one is prototype-era throughout); `docs/DATA_MODEL.md` rewritten
  (migrations 0000–0022, ledger accounts and event types, append-only tables, funding and purchase payment columns).
- `docs/DEMO_SCRIPT.md` fixed (five first steps, GM records supplier orders, funding, split scrap, owner-paid making
  charge, SUP-1 warning).
- `docs/DEPLOYMENT.md`: hosting undecided (the Render tables stay as one worked example); stale making-charge lines.
- `docs/acceptance/*.md`: open the codespace on `main`; how to move an old codespace (`git fetch`, `git checkout main`,
  `git pull`).
- Drift guard: `scripts/check-docs.mjs` (`npm run check:docs`, in the `typecheck` chain): every migration file is named
  in DATA_MODEL, every permission code in FEATURES, every append-only table (migrations) in DATA_MODEL.
- `docs/BACKLOG.md`: DOC-1 done, §G updated, "docs updated" in the definition of done.

## Questions (none blocks; defaults applied)

1. Code gap found: `APPEND_ONLY_TABLES` (`backend/src/core/startup.ts`) lacks `gm_funding_events`, so the start-up
   runtime-role privilege check does not cover it (the migration's triggers and revoked privileges do). Default: a
   BACKLOG item, not fixed here (docs only).
2. Code text found stale: the first-steps panel says "Then the branch manager records the first supplier order"; since
   MKC-1 only the General Manager can. Default: a BACKLOG item (a UI string is code).
3. The root package is still named `jewelry-erp-prototype`. Default: leave it; listed in §G.
4. `docs/phase0-report.md` and `docs/SPEC.md`: kept, labelled historical / original specification in the map.
