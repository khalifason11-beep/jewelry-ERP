# Manual acceptance: UI-A1 (design system, app shell, plain sign-in)

For the owner, about 20 minutes. Engineering ran section A. Section B is the owner's own look, in a GitHub
Codespace opened from the Windows laptop's browser. Section C is the one check only the real laptop can do.

What changed: every screen now uses the colours, type sizes and corners of the approved mockups (white page, flat
grey panels, navy sidebar floating at the edge). The buttons, fields, badges, dialogs and messages were rebuilt once
and every screen uses them. The sidebar and top bar follow the mockups per role. The sign-in page is plain and
centred. **Screen content itself (the homes, lists and forms) is unchanged until UI-B and UI-C**: some screens
look half-new, and that is expected. Plan: `docs/plans/UI-A1.md`. Decisions: D-ui-1…9 (`docs/decisions.md` §17).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run typecheck` (lockfile, Hasad footprint, migrations, drizzle, test imports, four packages) | passed |
| Backend tests, both projects | 1,535 passed, 3 skipped: PGlite 749, PostgreSQL 789 (3 skipped); +31 per project from the new design-token test |
| `npm run build`, `npm run i18n:check` | passed; every code has an English label |
| REH-1 rehearsal (production mode, real PostgreSQL) | `REHEARSAL PASSED: 109 checks.` |
| `node scripts/e2e-print.mjs` | 40 checks passed (new: an English invoice says "Bank transfer") |
| `node scripts/e2e-passkeys.mjs` | 29 checks passed (mode on), 3 (mode off) |
| `node scripts/capture-ui-kit.mjs` | 22 checks passed, including axe-core WCAG 2.1 A/AA: no serious or critical issue |

New in REH-1 for UI-A1:

- the sign-in page is white, with the form centred and no marketing panel;
- the sidebar per role lists exactly the mockup's items. The General Manager has no Point of Sale. The branch
  manager also has Active users (your answer 6). The cashier sees icons only, with no expand button;
- the branch manager and the cashier see no cost or profit word or figure in the sidebar, the top bar, the opened
  user menu or the notifications, in Arabic and in English. The rate chip is the only figure;
- in English, the POS shows "Bank transfer", not `BANK_TRANSFER`.

Screenshots of every main screen, before and after, at 1366×768, 1536×864 and 1920×1080 in Arabic and English:
`docs/ux/baseline-ui-a1/before/` and `after/` (at commit `36e4e1e`; UI-A2 removed them from the working copy and keeps the slim WebP set in `docs/ux/screens/`, D-ui-10). The component page: `docs/ux/ui-kit/`.

## B. In a Codespace, from the Windows browser (about 15 minutes)

**Open it.** On GitHub, open the repository, switch to the branch `claude/hopeful-sagan-lehxyp`, then
**Code → Codespaces → Create codespace on claude/hopeful-sagan-lehxyp**. Wait until the terminal says the
dependencies are installed.

**1. The component page (`/ui`).** It exists only in development and is never in the production app.

```bash
npm run dev -w @jerp/frontend
```

In the **Ports** tab, open port **5173** in the browser and add `/ui` to the address.

| # | Check | Expected |
|---|---|---|
| 1 | The page in Arabic, then the **English** pill at the top | Right-to-left in Arabic and left-to-right in English. The fonts are IBM Plex, not Arial or Tahoma |
| 2 | Colours, type sizes | As in the mockups: navy, one gold accent, grey panels on a white page. Red, amber and green appear only on badges and alerts |
| 3 | Buttons | Navy primary. Danger is a **red outline**; the **filled red** button appears only as the last confirm inside a dialog (your answer 7). "Saving…" shows a spinner and cannot be clicked |
| 4 | Press **Tab** a few times | Every focused control shows a gold ring around a thin navy ring |
| 5 | **Open dialog** | The cursor is in the first field. Tab stays inside the dialog. **Delete…** opens a second confirm; **Esc** closes only the top one, then the dialog; focus goes back to the button |
| 6 | The three message buttons | Success, error and information messages appear at the corner |

Stop it with **Ctrl+C**.

**2. The application with sample data.**

```bash
npm run build
PGLITE_DIR=.data/sample npm run dev:sample        # prints the sample accounts and their passwords once
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

Open port **4000**. Sign in with the accounts that `dev:sample` printed. Names marked `[عينة]` / `[Sample]` are
placeholders.

| # | Who | Check | Expected |
|---|---|---|---|
| 7 | — | The sign-in page | White page; logo and company name centred above the form; a language pill at the top. No navy panel or marketing text |
| 8 | General Manager | Home and the sidebar | Groups Home · Sales · Inventory & gold · Suppliers · Money · Analysis · Administration. **No Point of Sale.** The active item has a gold mark on the start side. All 14 links are visible at 1366×768 without scrolling the menu |
| 9 | General Manager | Top bar | Gold 21K rate chip, Demo badge, bell, language pill, avatar with initials. **No clock.** The avatar menu has My activity, Sign-in security and Sign out |
| 10 | General Manager | **Collapse** at the bottom of the sidebar | The sidebar becomes icons only; hovering an icon shows its name; the arrow opens it again |
| 11 | General Manager | Inventory, Sales, Cash, Settings, Users | Same content as before, on the new colours. Nothing cut off, no table wider than the page |
| 12 | Branch manager | Sidebar | Home · Selling (Point of Sale, Sales) · Inventory & gold · Suppliers · Money (Cash) · Analysis (Reports) · Team (Users, **Active users**, Audit log) |
| 13 | Branch manager | Sidebar, top bar, avatar menu, bell | No cost or profit anywhere in them, in Arabic and English |
| 14 | Cashier | Point of sale | The sidebar is two icons (Point of sale, My activity) and cannot be expanded. In **English**, the payment buttons read Cash, Bank transfer, Hasad |
| 15 | Anyone | Sell, open the sale, **Print** in English | The invoice says "Bank transfer" or "Cash", never a code |
| 16 | Branch manager | Home, Month to date line | No "$" after the number of invoices |
| 17 | Anyone | A security warning (for example a new device), if shown | Still above the page, unchanged (your answer 5) |

Stop the server with **Ctrl+C**. Delete the codespace afterwards, or leave it to stop by itself.

## C. On the real Windows laptop (2 minutes, after B)

Chromium on Linux cannot reproduce Windows font rendering. In the codespace's port-4000 page, in Chrome or Edge,
at **100 % and at 125 %** display scaling (Windows Settings → Display → Scale), check that:

- the Arabic text is sharp and nothing overlaps;
- the sidebar's 14 links still fit at 125 % (the screen is then 1536×864, like the `1536x864` screenshots).

## D. Known and accepted for now

- **The screens are half-new.** Their layout changes in UI-B (homes, branches, sales list) and UI-C (all others).
  The old colour names point at the new values (D-ui-1), so nothing is unreadable. The Transfers table is still
  wider than the page at 1366, as before UI-A1 (UI-C2). Some filter drop-downs on Inventory (karat, origin) cut
  their label; they did before UI-A1 too, slightly more now with 15 px text (UI-C2).
- **Not in UI-A1:**
  - the GM branch switcher (your answer 1, decided in UI-B);
  - the login tagline from settings (UI-A2);
  - the attention list that replaces the bell (UI-B).
