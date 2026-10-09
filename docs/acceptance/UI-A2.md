# Manual acceptance: UI-A2 (screen states, notices, sign-in tagline)

For the owner, about 20 minutes. Engineering ran section A. Section B is a short walk-through in a GitHub Codespace
from the Windows laptop's browser.

What changed:

- Every screen now shows loading, empty, error, no access, "does not exist" and crashes **the same way**. Filters
  and titles stay on screen while data reloads.
- Security and system warnings sit in **one compact area** above every page.
- The sign-in page shows your **tagline** (a new setting, empty until you write one) in the Amiri font.
- Screenshots in the repository are a small WebP set in `docs/ux/screens/`.

Screen layouts themselves are unchanged: that is UI-B and UI-C.

Plan: `docs/plans/UI-A2.md`. Decisions: D-ui-10…16 (`docs/decisions.md` §18).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run typecheck`: lockfile, Hasad footprint, migrations, drizzle, test imports, **assets (new)**, four packages | passed |
| Backend tests, both projects | 1,567 passed, 3 skipped: PGlite 765, PostgreSQL 805 (3 skipped); new: crash reports, the public allow-list, the tagline, the asset gate, two contrast pairs |
| `npm run build`, `npm run i18n:check` | passed |
| REH-1 rehearsal (production mode, real PostgreSQL) | `REHEARSAL PASSED: 130 checks.` |
| `node scripts/e2e-states.mjs` (new, with axe on every state) | 47 checks passed |
| `node scripts/e2e-print.mjs` | 40 checks passed |
| `node scripts/e2e-passkeys.mjs` | 29 checks passed (mode on), 3 (mode off) |
| `node scripts/capture-ui-kit.mjs` | 24 checks passed (incl. the crash page and the bundled-font check) |

**Each bug from the audit has a test** (`e2e-states`):

| Bug | Test |
|---|---|
| Settings spun forever when loading failed | A 500 on `/api/settings` shows an error with Try again; Try again loads the page |
| An Inventory or Security load error looked like "empty" | A 500 shows the error, never "No items match" or "No passkey registered yet" |
| Sales and Purchases filters vanished on every reload | A new period keeps the rows and the date filter, with a thin bar; an error keeps the filters |
| The POS said "no pieces" before branches loaded | With the branches delayed, the POS shows a skeleton, not "No pieces in this branch yet" |
| A report the role cannot open said "Something went wrong" | A branch manager opening the Profit report by its address sees no-access |

`e2e-states` also opens **every screen of each role with every answer delayed**: no crash page anywhere. This sweep
found a real crash on Cash, now fixed.

**The sign-in endpoint is an allow-list.** Backend tests prove four things:

- `/api/meta` contains only the company name, logo and tagline;
- no other setting key or value can appear in it;
- the tagline is limited to one line of 0–120 characters, plain text, enforced on the server;
- a signed-out visitor cannot read the settings.

## B. In a Codespace, from the Windows browser (about 15 minutes)

On GitHub: switch to the branch `claude/hopeful-sagan-lehxyp`, then **Code → Codespaces → Create codespace on
claude/hopeful-sagan-lehxyp**. Wait for the dependencies to install, then in the terminal:

```bash
npm run build
PGLITE_DIR=.data/sample npm run dev:sample        # prints the sample accounts and passwords once
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

Open port **4000**.

| # | Who | Check | Expected |
|---|---|---|---|
| 1 | — | The sign-in page | "أهلاً بعودتك" in the Amiri style, the sample tagline "[عينة] عبارة صفحة الدخول" under the company name, the form below. English: "Welcome back" and "[Sample] Sign-in tagline" |
| 2 | General Manager | **Settings › Company & branding**: change the Arabic tagline, Save (password), sign out | The new tagline is on the sign-in page. Empty it and save: nothing is shown. A line with `<` or over 120 characters is refused |
| 3 | General Manager | **Sales**: click **30d** in the date filter | The rows and the filter stay; a thin bar runs while the new period loads |
| 4 | General Manager | **Inventory**: type "zzz" in the search | "No items match these filters" with **Clear filters**; Clear brings the pieces back |
| 5 | General Manager | **Cash** | "Choose a branch to see its cash", a neutral prompt (not a blue box) |
| 6 | General Manager | **Scrap gold** with "All branches" | "Choose a branch to buy scrap" instead of a missing form |
| 7 | General Manager | Change the address to `/sales/999999` | "This sale does not exist" with "Back to sales" |
| 8 | General Manager | Change the address to `/nothing-here` | "Page not found" with "Go to my home" |
| 9 | Branch manager | Address `/settings`, then `/reports/profit` | "You do not have access …" both times, with a way out; never "Something went wrong" |
| 10 | Anyone | In a second tab, sign out; return to the first tab and click a menu item | The sign-in page says "Your session ended. Sign in again." |

**Notices.** The sample database is in demo mode without a passkey, so it shows no notices. To see them:

- open `docs/ux/screens/empty-production/ar-1366x768/01-general-manager-home.webp`: the backup and one-passkey notices,
  one line each, above the page;
- or read the `e2e-states` output, which forces five notices at once: two lines, the new-sign-in alert first, "+ 3
  more notices".

**Optional `/ui` page** (development only): stop the server, run `npm run dev -w @jerp/frontend`, open port 5173,
add `/ui`. Under **States** you will find the prompt, not-found, no-access, the thin refresh bar and **Simulate a
page crash**, which shows only a reference id.

## C. On the real Windows laptop (2 minutes)

In Chrome or Edge at **100 % and 125 %** scaling, check the sign-in page:

- the Amiri line is sharp;
- the tagline wraps cleanly if it is long.

## D. Known and accepted for now

- **History is not rewritten.** The old screenshot sets left the working copy, but a fresh clone still downloads
  them (about 50 MB).
- **Notices sit above every page.** On the General Manager's home they push level 1 down by about 40–80 px. UI-B
  decides whether the non-critical ones move to the attention list.
- **Left for later:** the GM home with branches but no sales (UI-B1), the Suppliers page (UI-C3), Transfers from
  the POS cart (FIX-1).
