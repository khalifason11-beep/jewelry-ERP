# UI-A2 plan: screen states, notices, login tagline, and a slimmer repository

Status: **PLAN, awaiting the owner's approval. No code has been written.**
Branch: `claude/hopeful-sagan-lehxyp`, based on `36e4e1e` (UI-A1 done and approved).

**Sources**, by rank where they disagree:

1. the owner-approved mockups `docs/ux/mockups/*.html` and `docs/design-reference/tokens.md`;
2. `docs/ux/ANALYSIS.md` (rules R1–R16, §8 empty states, §10);
3. `docs/ux/BRIEF.md`.

**Scope** (owner instruction, 2026-10-09):

- the rule for screenshots in the repository, and slimming the folders already committed (section 1);
- the login tagline from a new setting (section 5);
- loading, empty, error and no-access states used the same way on every screen (section 3);
- the security banners: where they finally live; they stay visible (section 4);
- whatever ANALYSIS gave to UI-A2 that UI-A1 did not finish (section 2).

**Not in scope:**

- redesigning any screen: layout, columns, cards, filters and charts are UI-B and UI-C;
- the attention list (BE-1, UI-B);
- the GM branch switcher (D-ui-5, UI-B);
- print documents.

---

## 1. Screenshots in the repository (applies from now on)

### 1.1 What is there now

| Folder | Files | Size | From |
|---|---|---|---|
| `docs/ux/baseline/` | 154 JPEG | 19 MB | UX-0 (`3081ded`), plus the empty set (`00d0f89`) |
| `docs/ux/baseline-ui-a1/before/` | 204 JPEG | 18 MB | UI-A1 step 0 (`35c2410`) |
| `docs/ux/baseline-ui-a1/after/` | 204 JPEG | 17 MB | UI-A1 step 6 (`36e4e1e`) |
| `docs/ux/ui-kit/` | 12 JPEG | 1.4 MB | UI-A1 |
| `docs/print-check/` | 6 PDF | 0.3 MB | printing phase |

`.git` is 51 MB. The screenshots are JPEG at quality 72, not PNG. "-full" images (a whole scrolled page) reach
1.3 MB each.

### 1.2 The rule (D-ui-10)

1. **Only an "after" set per phase.** No "before" set is committed. The previous phase's "after" is the "before",
   and every committed set stays reachable in git history.
2. **WebP, quality 55; no "-full" images.** Measured on the UI-A1 set, WebP saves only about half: screenshots of
   text compress poorly, so the cap comes from **choosing fewer images**.
3. **Fixed selection per phase, at the three sizes (1366×768, 1536×864, 1920×1080):**
   - in Arabic and English at all three sizes: the three role homes, plus up to four screens the phase changed;
   - at 1366×768 in Arabic only: every other main screen;
   - at 1366×768 in Arabic: the empty-production homes.

   Measured on the UI-A1 set: **68 images, 2.6 MB**.
4. **One folder, `docs/ux/screens/`, replaced each phase**, with a `README.md` naming the phase and commit. A
   phase's set stays in history; earlier phases are opened with
   `git show <commit>:docs/ux/screens/...`, or on GitHub at that commit. Each phase still adds about 2.6 MB to
   history, which is far less than today's 35 MB.
5. **A gate, `check:assets`**, added to `npm run typecheck`. It fails when:
   - the tracked images under `docs/` exceed **4 MB** in total;
   - any single image exceeds **150 KB**;
   - a folder named `before/` is tracked.
6. **Generated output never lands in git.** The capture scripts write to a git-ignored `.ux-shots/` by default, and
   `--publish` writes the slim WebP selection to `docs/ux/screens/`. `print-check-output/` (the default output of
   `e2e-print`) is added to `.gitignore`.

### 1.3 Slimming what exists, without rewriting history (commit 0)

| Action | Effect on the working tree |
|---|---|
| `git rm -r docs/ux/baseline-ui-a1/before` | −18 MB. Still at `35c2410` |
| `git rm -r docs/ux/baseline` (UX-0 and the empty set) | −19 MB. Still at `3081ded` / `00d0f89`. ANALYSIS and the UX-0 README links point to that commit |
| UI-A1 `after/` → the slim WebP selection in `docs/ux/screens/` (UI-A1), then `git rm` the JPEG folder | −17 MB, +2.6 MB. The full JPEG set stays at `36e4e1e` |
| `docs/ux/ui-kit/` → WebP | 1.4 → about 0.6 MB |

**Result:** the screenshots in the working tree drop from about 55 MB to about 3 MB, and the gate keeps them
there.

**What this cannot do.** It does **not shrink a fresh clone.** Without a history rewrite, every old blob is still
downloaded: about 50 MB today, plus about 2.6 MB per UI phase. Only a one-off history rewrite (`git filter-repo`
plus a force-push, so every clone and Codespace must be re-cloned) would remove them. I do not propose that unless
you ask (question Q1).

---

## 2. What ANALYSIS gave to UI-A2, and where each item is now

ANALYSIS §10.1 and BACKLOG E (before UI-A1) listed these for UI-A2:

| # | Item (source) | Status | In UI-A2? |
|---|---|---|---|
| 1 | Grouped, role-aware sidebar (§4.1) | **Done in UI-A1** (D-ui-6) | — |
| 2 | Distinct icons; the diamond only as the logo (D-ux-6) | **Done in UI-A1** | — |
| 3 | Collapse to icons | **Done in UI-A1**; the cashier always sees icons | — |
| 4 | Only screens that exist; no POS for the GM (D-ux-7, D-ux-16) | **Done in UI-A1** | — |
| 5 | Top bar: 21K rate chip with a "set today's rate" hint, language, user menu with Security | **Done** (hint in REM-3, the rest in UI-A1) | — |
| 6 | **USD chip hidden until Q-10** (D-ux-3) | **Done by absence**: no USD chip exists | No work; REH-1 asserts there is none |
| 7 | **No banners above level 1** (R13) | **Not done**: you kept them in UI-A1 (Q5) | **Yes**, section 4 |
| 8 | Plain login: logo and company name | **Done in UI-A1** (D-ui-7) | — |
| 9 | **Login tagline from a new branding setting** | Not done | **Yes**, section 5 |
| 10 | **Script display font, login page only** (D-ux-8: "Arabic equivalent font needed") | Not done | **Yes, if you approve the font** (Q6) |
| 11 | Login image panel, only if `docs/design-reference/login-background.jpg` is added with a licence | The file does not exist | **No**: no code for an image that does not exist. It stays in BACKLOG |
| 12 | AA contrast, RTL first | Done for the tokens (UI-A1 test, axe) | Re-checked for every new state and notice (axe, contrast test) |
| 13 | **Per-screen empty states** (added to UI-A2 by the UI-A1 docs; ANALYSIS §8; R15) | Partial: REM-3 did the BM home and POS | **Yes**, section 3. **UI-C5 is folded into UI-A2** (Q3) |
| 14 | §10.3: Cash shows "Select a branch" in a blue info box that looks like an error | Not done | **Yes**: becomes the neutral "choose a branch" prompt state (section 3) |
| 15 | §10.3: rate chip "—/g" on a new database | Done (REM-3, UI-A1) | — |
| 16 | GM branch switcher (owner, UI-A1 Q1) | Moved to UI-B (D-ui-5) | No |
| 17 | Bell replaced by the attention list (UI-A1 Q4) | Moved to UI-B (needs BE-1) | No |

**Moved out of UI-A2.** These §8 rows need UI-B or UI-C content, so they stay where that content is built:

- GM home with branches but no sales ("KPIs show 0, not —"): UI-B1, home content;
- Suppliers page: the page does not exist yet (UI-C3);
- Transfers "Send pieces from the POS cart": FIX-1.

---

## 3. Loading, empty, error and no-access: one contract for every screen

### 3.1 Inventory of what exists now

**Shared parts that exist:**

- In `components/ui/States.tsx`: `Loading`, `Skeleton`, `SkeletonRows` (never used by a page), `Empty` with the
  variants `empty` and `no-access`, and `ErrorState` ("Try again" only when `onRetry` is passed).
- `DataTable`:
  - `emptyTitle` defaults to **"Nothing to show"**;
  - `emptyBody` is accepted but never passed by any caller;
  - there is no loading, error or action prop;
  - its toolbar (search, filters slot, count, CSV) exists only while the table is mounted.
- The route `Guard`: "You do not have access to this page", with **no way home**. `NotFound`: "Page not found",
  with no text and no link.
- There is **no error boundary**: a render error blanks the whole app.
- There is **no `keepPreviousData`** anywhere: every filter, period or search change drops the data and shows a
  spinner again.

**Per screen** (from a file-by-file audit; abbreviations: L = first load, F = filter change, E = error,
∅ = empty, 403 = an API refusal inside an allowed page):

| Screen | Loading | Error | Empty | Main gap |
|---|---|---|---|---|
| Sales, Supplier purchases (lists) | L/F: `return <Loading/>` **removes the date range and branch filters** (they live in the table toolbar) | ErrorState + retry (filters gone) | "No sales / purchases in this period", no action | Filters vanish on every change |
| Inventory (table) | Rows emptied; `emptyTitle` becomes "Loading…" | **Not handled: an error shows "No items match these filters"** | Same text, no action | Error disguised as empty |
| Inventory (cards), POS | 12 skeleton cards; filters stay; skeleton again on every keystroke | ErrorState + retry | POS: REM-3 texts, good. Cards: no action | POS for a global user: "No pieces in this branch yet" shows until branches load (disabled query) |
| Types & products | Spinner in the card; header stays | ErrorState + retry | "No products yet" / "No types yet", no action | No next action |
| Scrap | Spinners in both cards | ErrorState + retry | "No scrap bought yet", "The pool is empty." | "All branches" silently hides the buy form |
| Transfers | Spinner in the card | ErrorState, **no retry** | "No transfers yet" | Dialog items error not handled |
| Cash | Spinners in the cards | ErrorState + retry; **Hasad transfers: error and loading render nothing** | "No branches" | "Select a branch" is a blue info **Alert** |
| Reports (each) | Spinner; **summary tiles and some filters disappear** while reloading | ErrorState + retry | DataTable default **"Nothing to show"** | 403 on a deep-linked report shows "Something went wrong" with a useless retry |
| Users | Spinner in the card; roles query silent | ErrorState, **no retry** | **"Nothing to show"** | — |
| Active users | KPIs show **0 while loading or on error**; table spinner | ErrorState, no retry | "Nobody is signed in" / "No sessions" | Wrong zeros |
| Audit | Spinner on every filter or search change; filters stay | ErrorState, no retry | "No audit events match these filters", no Clear | — |
| Settings | `if (!draft) return <Loading/>` replaces the whole page | **Never checked: a failure is a permanent spinner** | Rates history: empty table, no text | Worst case in the app |
| GM home | Body becomes a spinner on each period change; header stays | ErrorState + retry; setup and backup queries fail silently | No branches → **blank** (relies on FirstSteps); charts have no empty text | — |
| BM home | Same pattern, on each date change | ErrorState + retry | REM-3 "No stock yet" with actions, good | — |
| Sale, purchase, item and branch detail | **Bare `<Loading/>` replaces the whole page, header included** | ErrorState, **no retry**; 403/404 shown as "Something went wrong" | Item: "Lifecycle is visible to managers." used as an empty text | Not-found and no-access look like crashes |
| Branches | Spinner | ErrorState, no retry | **None: zero branches shows an empty grid** | — |
| My activity | KPI shows 0 while loading; the sales table removes its date filter | Today's-sales error ignored | "No sales in this period" | — |
| Security | Passkeys: spinner; sign-ins: nothing | **Not handled: a passkeys error reads "No passkey registered yet."** | Sign-ins: no text | Error disguised as empty |
| Unknown URL | — | — | "Page not found", no link | — |

**Also found:**

- Mutations already follow one rule: errors inline in the dialog, or as a toast; success as a toast. Unchanged.
- An expired session sends the person to sign-in **without a word**. UI-A2 adds one line on the sign-in page:
  "Your session ended. Sign in again."
- `/me` and `/security` have no Guard. That is correct: every signed-in role may open them.

**Empty texts today:** 14 different `emptyTitle`s, 9 `Empty` titles and about 10 inline texts. Only three places
offer a next action: the BM "no stock yet", the first-steps checklist and the catalog duplicate's "Use {name}".

### 3.2 The contract (D-ui-11)

Each screen's data area is in exactly one of these states. Whatever is around it stays in place: page title,
filters, period pills and primary action.

| State | What the person sees | Built with |
|---|---|---|
| **First load** | Skeleton rows or blocks shaped like the content, in the data area only. The header and filters stay. After 10 s: "Still loading…" with a Try again link | `Skeleton`, `SkeletonRows`, `DataTable state="loading"` |
| **Refetch** (filter, period, search, background refresh) | The previous rows stay. A thin 2 px bar under the table header. The search field keeps focus | `placeholderData: keepPreviousData` on list queries |
| **Empty (nothing exists yet)** | §8 text: *what* is empty and *the next action*, as a button. The button shows only if the person has the permission | `Empty` |
| **Empty (filters hide everything)** | "No … match these filters." with a **Clear filters** button | `Empty` |
| **Prompt** (a choice is needed first) | Neutral, not blue, not an alert: "Choose a branch to see its cash." with the selector right there | `Empty variant="prompt"` (new) |
| **Error** | Inline in the data area: "Could not load …", the server message in plain words, **Try again**. `role="alert"` | `ErrorState` |
| **No access** | (a) route Guard: "You do not have access to this page", **Go to my home**; (b) an API 403 inside a page: the same component in that block only | `Empty variant="no-access"` |
| **Not found** | Unknown URL, or a detail id that does not exist: "Page not found" / "This sale does not exist", **Back to the list** | `Empty` |
| **Crash** (a render error) | An error boundary around the page: "This page stopped working", **Reload page**, **Go to my home**. The shell and sidebar keep working, and the error is logged to the console. Today there is no boundary, and a crash blanks the whole app | `PageErrorBoundary` (new), reset on navigation |
| **Session expired** | Unchanged: the existing redirect to sign-in | — |

**One helper so every screen does it the same way:**

- `useListState(query, { filtered })` returns `loading | error | empty | filtered-empty | ready`.
- `DataTable` gains `state`, `onRetry`, `onClearFilters` and `emptyAction`. Today `emptyTitle` doubles as the
  loading text ("Loading…"); that goes.

**Mutations keep the existing rule:** errors inline in the dialog or form (`Alert`), success as a toast. This is
written down, not changed.

**No screen's layout changes.** Only what the data area shows in each state changes.

### 3.3 Screens covered

Every routed screen, by role:

- **GM:** Home, Branches, Branch detail, Sales, Sale detail, Inventory, Item detail, Types & products, Supplier
  purchases and their detail, Cash, Scrap, Transfers, Reports hub and each report, Users, Active users, Audit,
  Settings, Security, My activity.
- **Branch manager:** the same screens within their permissions.
- **Cashier:** POS and My activity.

§8 texts, as approved in ANALYSIS, with the next action shown only to roles that may do it:

| Screen | Empty text | Action |
|---|---|---|
| Sales | "No sales in this period." | Change period |
| Inventory | "No pieces in stock." | New purchase · Buy scrap |
| Types & products | "No types or products yet. Create the first type (for example rings), then a product." | New type · New product |
| Supplier purchases | "No supplier orders yet." | New purchase |
| Scrap | "The broken-scrap pool is empty." / "No scrap bought yet." | (the form is on the page) |
| Transfers | "No transfers yet." *(the "from the POS cart" half waits for FIX-1)* | — |
| Cash | "No movements today. Expected cash is the opening amount." | Record cash count |
| Reports | "No data for this period." | Change period |
| Audit | "No events match these filters." | Clear filters |
| POS (filters) | "No pieces match these filters." | Clear filters |

The BM home and the POS with no stock keep their REM-3 texts.

**Gaps from §3.1 fixed under the same contract.** No layout change in any of them:

- **Settings:** an error shows `ErrorState` with retry, not a permanent spinner.
- **Inventory table and Security passkeys:** an error is shown as an error, never as "empty".
- **Sales, purchases, my activity, reports:** filters and summary tiles stay during a reload (keepPreviousData).
- **Detail pages** (sale, purchase, item, branch):
  - the header and back link stay while loading;
  - a 404 reads "This … does not exist" with Back to the list;
  - a 403 shows the no-access block.
- **Reports:** a report the role may not open shows no-access, not "Something went wrong".
- **Every `ErrorState` has Try again.**
- **POS for a global user:** "Choose a branch" until the branches load, not "No pieces in this branch".
- **Scrap with "All branches":** a prompt, "Choose a branch to buy scrap", instead of a silently hidden form.
- **Cash:** the blue "Select a branch" Alert becomes the neutral prompt state.
- **Active users and My activity:** figures show a skeleton while loading and "—" on error, never a false 0.
- **Branches:** "No branches yet" with New branch (for the GM).
- **Silent queries** (Hasad transfers, roles, the session summary, sign-ins, gold and scrap rate history): each
  shows loading and error.
- **Expired session:** one line on the sign-in page.

---

## 4. Security and system notices: final placement (D-ui-13)

### 4.1 Now

| Notice | Who | Where | Test id |
|---|---|---|---|
| New sign-in to your account ("Was this you?", It was me / This wasn't me) | anyone | Shell, above every page | `new-device-alert` |
| Only one passkey: add a second device | anyone with the second factor required | Shell, every page | `second-passkey-nag` |
| Touch-only security keys accepted | GM | Shell, every page | `uv-preferred-banner` |
| Second factor OFF for the GM (production only) | GM | Shell, every page | `enforcement-off-banner` |
| Backups need attention | GM | **GM home only**, as a large card | `backup-banner` |

Each is a full-width `Alert` with a title and a paragraph. On a new production database the GM sees two or three of
them before any figure (R13, R14).

### 4.2 Proposal: one compact notice area in the shell

The notice area sits between the top bar and the page, on every screen:

- Each notice is **one line**, about 36 px: icon, sentence, action link. Meaning colours as in R6: red critical,
  amber warning, neutral information.
- Critical notices come first. At most **two lines** show; the rest fold into "+ N more notices", which expands in
  place.
- On a phone-width or 1366 screen, the line wraps. It is never hidden.

| Notice | Level | Placement | Dismiss |
|---|---|---|---|
| New sign-in ("Was this you?") | critical | every page, until answered | only by answering |
| Second factor off for the GM | critical | every page (GM) | no; fixed in Settings |
| Backups need attention | warning | every page (GM). **Moves off the home card**, so it is seen wherever the GM is | no; disappears when a backup or drill succeeds |
| Touch-only keys accepted | warning | every page (GM) | no; changed in Settings |
| Only one passkey | information | every page, one line | no |

- **Nothing is removed and nothing can be hidden** while its cause remains (you said: must stay visible).
- The avatar shows a small dot while any notice is open, and **Security** in the user menu lists them.
- **UI-B (attention list, as in the mockups):** the backup and one-passkey notices **also** appear in the home's
  "Needs attention", as `empty-gm-home.html` and `gm-home.html` show. Whether they then leave the shell is decided
  in UI-B (Q4).
- **Kept as they are:** all test ids and actions (It was me / This wasn't me and its confirm dialog, Add a device).
  `e2e-passkeys` runs unchanged.

---

## 5. Login tagline setting (D-ui-14)

### 5.1 The setting

- **Keys:** two new entries in `SETTINGS_REGISTRY` (`shared/src/settings.ts`):
  - `branding.loginTaglineAr`
  - `branding.loginTaglineEn`
- **Value:** plain text, 0–120 characters, one line. **Default: empty**, so no invented slogan and nothing is
  shown until the GM types one (REM-3: no invented data).
- **Display:** shown under the company name on the sign-in page. In English an empty `En` falls back to `Ar`, as
  names do.

### 5.2 What it touches

- **Storage:** none new. Settings are one row per key with a fallback to the registry default
  (`backend/src/modules/settings/store.ts`), so there is **no migration and no schema change**, and `check:drizzle`
  and `check:migrations` are unaffected.
- **Who edits it:** the GM only (`settings.manage`), in **Settings › Company**, next to the invoice footer. The
  change goes through the existing settings save:
  - optimistic version;
  - `settings_history` row;
  - `SETTINGS_CHANGED` audit entry.
- **Who reads it:** anyone, through the **public** `/api/meta` (`publicBranding`), because the sign-in page has no
  session. This is the same path as the company name and logo. The Settings field says: "Shown to anyone who opens
  the sign-in page".
- **Cost:** **no.** It is not a cost field. It is classified SAFE in `shared/src/field-classification.ts`, and
  the existing cost-visibility test covers `/api/meta`.
- **Security:** low.
  - It is admin-written text shown before sign-in. It is rendered as text (React escapes it), not HTML or a link,
    and its length is capped.
  - It is **not guarded** (no passkey re-confirmation), like the company name. It reveals nothing about accounts.
  - **No permission change.** No new route: the existing generic settings route already lists registry keys.
- **Print documents:** not touched.

### 5.3 The sign-in page (inside `AuthFrame`, UI-A1)

From top to bottom: logo, company name, the tagline (if set), then the existing form.

- If D-ux-8's display font is approved (Q6), the tagline and a short **"أهلاً بعودتك / Welcome back"** line use it.
- Everything else stays IBM Plex.
- No image panel (§2 item 11).

---

## 6. Mapping to the mockups

| Mockup element | UI-A2 |
|---|---|
| `empty-gm-home.html`: "Needs attention" holds "No backup recorded yet" and "You have only one passkey" | The notices live in the shell now (§4) and join the attention list in UI-B. The texts are taken from the mockup |
| `empty-gm-home.html`: "Welcome, let's start", first steps 0/3 | Exists (REM-3 `FirstSteps`); no change |
| Rate chip "حدّد سعر اليوم" | Exists; no change |
| Empty and first-run screens | §8 texts (section 3) |
| Login | No mockup exists. tokens.md "Login page" and D-ux-8 apply (section 5) |
| `.tag` "static mockup" label | Not product UI (UI-A1 rule); nothing to build |

---

## 7. Tests and gates

All UI-A1 gates run after every commit:

- `npm run typecheck` (now with `check:assets`);
- both backend test projects;
- `npm run build`;
- `npm run i18n:check`.

### 7.1 Backend tests (commit 4)

- The two keys: validation, default empty, the 120-character cap;
- a branch manager or cashier changing them gets 403;
- a change is audited;
- `/api/meta` returns them;
- the cost-visibility classification passes.

### 7.2 i18n:check

- All new strings have Arabic.
- **New rule:** a `DataTable` must not pass "Loading…" as `emptyTitle`, and must pass its own empty text. The
  generic "Nothing to show" default is removed.

### 7.3 New `scripts/e2e-states.mjs`

It runs on the built app with fixture data created through the API, like the other e2e scripts. For each list
screen (sales, inventory, purchases, scrap, transfers, audit, users, sessions, types & products, reports) and the
two homes, it uses Playwright request interception only, with **no test hooks in the product**:

- **Slow first response:** a skeleton is visible; the page title and filters are present.
- **Changing a filter:** the rows stay (no full-page spinner); the search field keeps focus.
- **500:** `role=alert` with Try again; Try again recovers.
- **403 on the data call:** the no-access block, the shell intact.
- **Malformed response** (forces a render error): the error boundary shows, the sidebar still navigates, and the
  next page works.
- Unknown URL → "Page not found" with a way home.
- **Regression cases from §3.1:**
  - `/settings` returning 500 shows an error, not a spinner;
  - an inventory error is never shown as "No items match";
  - a deep-linked report a branch manager may not open shows no-access;
  - a global user's POS before the branches load shows "Choose a branch".
- Every state passes axe (no serious or critical issue).

### 7.4 REH-1 additions (production mode, new database)

- **Empty states:** on the new database, each list screen shows its exact §8 text and its action button for the
  roles allowed, in Arabic and English. No "Nothing to show", no "Loading…" left.
- **Notices:**
  - GM on `/settings` (not only the home): the backup notice and the one-passkey notice are in the shell notice
    area, one line each, above the page;
  - the branch manager sees neither the backup nor the GM-only notices;
  - no USD chip anywhere.
- **No access:** a branch manager opening `/settings` sees "You do not have access to this page" with "Go to my
  home".
- **Tagline:**
  - the GM sets it in Settings, and the signed-out sign-in page shows it in Arabic;
  - English falls back to Arabic;
  - cleared, nothing renders.

### 7.5 Unchanged

- `e2e-print` and `e2e-passkeys` keep all their checks and test ids (the banners keep theirs).
- `capture-ui-kit` gains the new states (prompt, crash, filtered-empty, notices) and stays under axe.
- R14 check: the GM home's level 1 at 1366×768 with two notice lines open is in the screenshots; the layout fix
  itself is UI-B.

---

## 8. Commit sequence

Each commit is pushed, and the suite is green after each.

| # | Commit | Extra checks |
|---|---|---|
| 0 | **Repository slimming** (section 1): remove `before/` and `docs/ux/baseline/` from the tree; the UI-A1 after set becomes the slim WebP selection in `docs/ux/screens/`; kit screenshots to WebP; capture scripts default to `.ux-shots/` with `--publish`; `.gitignore`; `check:assets` gate; README and ANALYSIS links to the old commits | typecheck (new gate) |
| 1 | **State primitives**: `useListState`, `DataTable` states, `Empty variant="prompt"`, `PageErrorBoundary` in the shell, Guard and NotFound with their actions, kit page sections, `e2e-states.mjs` (first screens) | kit, e2e-states |
| 2 | **States on every list screen**: sales, inventory, purchases, scrap, transfers, audit, users, sessions, types & products, reports; §8 texts and actions; i18n rule | e2e-states, REH-1 |
| 3 | **States on the other screens**: homes, detail pages, cash (prompt state), settings, security, my activity, POS, branches | e2e-states, REH-1, e2e-print |
| 4 | **Notice area** (section 4): banners moved, backup notice off the GM home; avatar dot | REH-1, e2e-passkeys |
| 5 | **Tagline setting**: registry keys, `publicBranding`, Settings field, backend tests | suite |
| 6 | **Sign-in page**: tagline, and the display line and font if approved (lockfile check: the `@node-rs/argon2` entries unchanged, diff in the report) | REH-1, e2e-passkeys |
| 7 | **Docs and evidence**: the slim after set (`docs/ux/screens/`), kit screenshots, decisions D-ui-10…16, `docs/acceptance/UI-A2.md`, ANALYSIS §8/§10.1, BACKLOG E (UI-C5 folded in) | all gates, REH-1, all e2e |

## 9. Docs

- **`docs/decisions.md` §18:**
  - D-ui-10: screenshot policy and the `check:assets` gate;
  - D-ui-11: the state contract;
  - D-ui-12: the error boundary;
  - D-ui-13: notice placement;
  - D-ui-14: the tagline setting;
  - D-ui-15: the display font (or none);
  - D-ui-16: UI-C5 folded into UI-A2.
- **`docs/acceptance/UI-A2.md`:** what engineering ran, and a Codespace-from-Windows walk-through:
  - each role's empty screens on a new database;
  - a screen in each state via the `/ui` page;
  - the notices;
  - setting and clearing the tagline;
  - the 100 % / 125 % check.
- **ANALYSIS §10.1 and BACKLOG E:** UI-A2 done; UI-C5 removed (folded in); the items moved to UI-B and FIX-1
  listed.

## 10. Risks

- **Every screen changes in commits 2–3.** The selectors could break. Mitigation: every `data-testid` is kept;
  REH-1, `e2e-print` and `e2e-passkeys` run after each commit.
- **keepPreviousData on lists** could show old rows under a new filter for a moment. Mitigation: the thin progress
  bar, and the row count updates only with the new data.
- **The notice area adds height above level 1** on the GM home (R14). Mitigation: one line per notice, at most two
  lines open. The home layout itself is fixed in UI-B.
- **The error boundary hides a crash behind a friendly page.** Mitigation: the console log, and `e2e-states` proves
  it recovers.
- **Removing old screenshots from the tree** breaks relative links in older docs. Mitigation: commit 0 rewrites
  those links to the commit that holds them.
- **History keeps growing** by about 2.6 MB per phase; only a rewrite shrinks clones (Q1).
- **A display font adds** about 100–200 KB, loaded only on the sign-in page, and a dependency. Mitigation: the same
  lockfile check as axe.

## 11. Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | Slimming: only remove the old sets from the working tree (clones stay about 50 MB), or also rewrite history once (`git filter-repo` plus a force-push; every clone and Codespace re-cloned)? | **Tree only.** No force-push on a branch others may have; clones are 50 MB, not a real cost yet |
| Q2 | Screenshot cap: 4 MB in total under `docs/`, 150 KB per image, the 68-image selection (§1.2) | **Yes** |
| Q3 | Fold UI-C5 (the §8 empty texts) into UI-A2, as your "every screen" instruction implies? | **Yes.** Same files touched once; UI-C keeps only layout work |
| Q4 | Notices: one compact shell area on every page, nothing dismissible while its cause remains, backup moved off the GM home (§4.2)? | **Yes.** UI-B decides whether non-critical notices then live only in the attention list |
| Q5 | Tagline: two settings, 0–120 characters, **empty by default**, public on the sign-in page, edited by the GM in Settings › Company | **Yes**, empty by default |
| Q6 | Display font for the sign-in page only (D-ux-8 asked for an Arabic equivalent): **Amiri** (naskh with Latin, OFL), **Aref Ruqaa** (ruqʿah calligraphic, OFL), or none (IBM Plex only)? | **Amiri**, tagline and "Welcome back" only. Calligraphic Ruqaa is hard to read at small sizes |
| Q7 | A "Welcome back / أهلاً بعودتك" line above the form (Figma's "Welcome Back")? | **Yes**, in the display font; the form title stays "Sign in" |
| Q8 | First load: skeletons in the data area (header and filters stay) instead of today's full-page spinner on most screens? | **Yes** |
| Q9 | Error boundary: "This page stopped working" with Reload and Go to my home, the shell still usable? | **Yes** |
