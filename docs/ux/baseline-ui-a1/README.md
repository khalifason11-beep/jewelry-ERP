# UI-A1 baseline: before and after

Screenshots of every main screen, taken with `scripts/capture-ui-baseline.mjs` (same screens as the UX-0 set in
`docs/ux/baseline/`) at **1366×768, 1536×864** (a 1920×1080 Windows laptop at its default 125 % scaling) **and
1920×1080**, in Arabic and English:

- `before/`: the application at `a6e6828` (after REM-5), before any UI-A1 change.
- `after/`: the same screens after UI-A1 (design tokens, base components, app shell, plain login), taken in the
  last UI-A1 commit.

`demo/`: a database filled by `npm run dev:sample` (two branches, marked placeholder names), seen by the General
Manager, a branch manager and a cashier. `empty-production/`: each role's home right after the first sign-in on a
new production-mode database (taken by REH-1).

```bash
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>@localhost:5432/postgres \
  node scripts/capture-ui-baseline.mjs --out=docs/ux/baseline-ui-a1/after
```
