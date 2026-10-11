# UI-A1 plan: design system and app shell

Status: **DONE** (2026-10-09). Approved with the owner's answers Q1–Q9; built in commits 35c2410 (before-baseline), cfd46a6, bb5dbf4, 977cbe8, 8c8fcbe, 687b6bf and the docs commit. Decisions D-ui-1…9 (`docs/decisions.md` §17); acceptance `docs/acceptance/UI-A1.md`. Differences from this plan: `DataTable.tsx` is kept and restyled (11 screens use it); no GM branch switcher in the shell (Q1); the bell stays and the clock goes (Q4); sidebar items are 32 px as in the mockup.
Branch: `claude/hopeful-sagan-lehxyp`, based on `7fd60c4` (REM-5 done).

**Sources of truth**, by rank where they disagree:

1. the owner-approved mockups `docs/ux/mockups/*.html` and `docs/design-reference/tokens.md`;
2. `docs/ux/ANALYSIS.md`;
3. `docs/ux/BRIEF.md`.

The owner's UI-A1 instruction (2026-10-09) redefines the scope. Section 0 lists every disagreement found.

**Scope.** UI-A1 delivers:

- the tokens;
- the base components: button, input, select, dialog, table, status badge, empty state, toast, skeleton/loading
  and error state;
- the app shell: sidebar and top bar per role, a GM branch switcher, and no cost or profit in the shell for
  non-GM roles;
- the plain login page.

**Not in scope:** screen content (UI-B/UI-C), the login redesign and per-screen empty states (UI-A2), and any
backend change.

---

## 0. Disagreements between the sources

| # | Topic | Sources and what they say | Plan |
|---|---|---|---|
| X1 | Which phase builds the shell | ANALYSIS §10.1: the shell and the plain login are **UI-A2**. Owner's instruction: the shell and a plain login are **UI-A1**; the login redesign is UI-A2 | Follow the owner. ANALYSIS §10.1 and BACKLOG E are updated in the last commit |
| X2 | Panel radius | ANALYSIS §10.1 "radii (pill, 12, 24)", Figma ≈ 24 px. tokens.md and the mockups: `--r-panel` **20**, card 16, row 12, control 10, badge 6 | Tokens: 20/16/12/10/6/pill |
| X3 | Top bar height | ANALYSIS fit check uses a 56 px top bar. tokens.md: **44 px**, and the mockup `.top` is 44 px | 44 px |
| X4 | Language switch | ANALYSIS §4.1: language "stays in the user menu". Mockups: an **"English" pill in the top bar** | Top-bar pill (mockups) |
| X5 | Branch manager "Team" group | ANALYSIS §4.1: Users, Active users, Audit log "(if permitted)". Mockup `bm-home`: Users, Audit log (no Active users). The branch manager holds `sessions.view` | Question Q6 |
| X6 | GM branch switcher | Owner: required. Mockups and ANALYSIS: **none**; the GM home only says "· كل الفروع" in its subtitle | Question Q1 (placement and behaviour) |
| X7 | Login | tokens.md and ANALYSIS: the plain login (logo, name, a tagline from a **new branding setting**) is UI-A2. Owner: plain login in UI-A1, "login redesign" in UI-A2, no backend change | Question Q2 |
| X8 | Button set | Owner: primary, secondary, danger, disabled, loading. ANALYSIS also has **ghost** and a **permission-denied** state. Today `ghost` is used 14 times | Keep ghost; permission-denied is a variant of the empty state |
| X9 | Danger button | ANALYSIS R4: "danger actions are **red-outlined**, never primary". Today: filled red (7 uses). Mockups: none shown | Question Q7 (recommend outlined) |
| X10 | Rounded corners | BRIEF §20: "avoid excessive rounded cards". Mockups: 20/16 px radii | Mockups win |
| X11 | Navigation groups | BRIEF §15 example: التشغيل / التحليلات / إدارة النظام, still listing Expenses. Mockups and ANALYSIS §4.1 group by work: المبيعات / المخزون والذهب / الموردون / المال / التحليل / الإدارة | Mockups |
| X12 | Gold accent | ANALYSIS (Figma) ≈ `#DDB874`. tokens: `--gold #C9A24B` (today's gold-500) | Tokens |
| X13 | Active nav marker | The mockup draws it with `box-shadow: inset -3px 0 0 gold`: correct on the start side in RTL, on the wrong (end) side in LTR | A logical start-side marker in both directions |
| X14 | Branch colours | Owner names teal, sand and periwinkle. tokens: four colours `--b1` navy, `--b2` teal, `--b3` sand, `--b4` periwinkle | All four tokens |
| X15 | Clock and notification bell | Today both are in the top bar. Mockups and ANALYSIS §10.1: neither (rate chip, language, user menu only) | Question Q4 |
| X16 | Cashier sidebar | tokens: "the cashier always sees the collapsed form". Mockup: two icons, no toggle. Today the cashier can expand it | Always collapsed, no toggle |
| X17 | Labels | Mockups: GM "الرئيسية" (Home), not "Executive Overview"; GM "النقدية والتسوية", BM "النقدية"; "مشتريات الموردين" under the group "الموردون" | Mockups |
| X18 | GM point of sale | Today the GM sees "Point of Sale". Mockups and ANALYSIS (D-ux-7, decided): no POS entry for the GM; no permission change | Mockups (hidden link only; the route still works for the permission) |
| X19 | Demo marker | Mockups: a dashed `.tag` ("نموذج ثابت — بيانات وهمية") is a label of the mockup itself. The product has the REM-3 "Demo" badge | Style the Demo badge like `.tag`; never shown in production (unchanged) |
| X20 | Page background | Mockups and tokens: **white page, grey flat panels**, a floating rounded navy sidebar. Today: grey canvas, white bordered cards, edge-to-edge sidebar | Tokens; question Q3 covers how far the change reaches into the screens |
| X21 | Sidebar width | tokens: 232 px. Today: 236 px | 232 |

## 1. Inventory of the current frontend

Stack: React 19, Tailwind **v4** (CSS-first `@theme` in `frontend/src/index.css`), lucide icons, IBM Plex Sans /
Sans Arabic / Mono bundled through `@fontsource` (CSP-safe), no frontend unit-test runner.

### Styles and tokens

| File | Today | UI-A1 |
|---|---|---|
| `frontend/src/index.css` (135 lines) | `@theme`: `ink-950…300`, `gold-700…50`, `canvas`, `line`, `line-strong`, `series-1…4` (blue/orange/green/amber); body 14 px on the canvas grey; gold focus outline; print CSS (`#print-root`, `.pd*`) | **Replace the `@theme` block.** Add the semantic tokens of tokens.md: `navy`, `navy-2/3`, `on-navy*`, `gold`, `gold-soft`, `ink`, `ink-2/3`, `surface`, `panel`, `neutral-bg`, `line`, `crit/warn/ok(-bg)`, `b1…b4`. Type scale `--text-meta 13`, `--text-body 15`, `--text-section 17`, `--text-title 20`, `--text-kpi 24` (22 exception), radii, `--shadow-pop`. **Legacy names are remapped to the new values** (e.g. `ink-900` → navy, `gold-500` → gold, `canvas` → panel, `series-n` → `bN`), so the 345 `ink-*`, 88 `gold-*` and chart uses restyle consistently without touching the screens. The legacy names are removed screen by screen in UI-B/C. The print CSS is **not touched** |
| `frontend/index.html` | `theme-color #0d1526` | `#0F1629` |

### Components

| File | Exports and uses | UI-A1 |
|---|---|---|
| `components/ui/index.tsx` (392 lines) | `Button` (variants primary 40 uses, ghost 14, danger 7, gold 2, success 1; sizes sm/md/lg), `Input`, `Textarea`, `Select`, `Field`, `Card`/`CardHeader` (20/10 files), `PageHeader` (6), `Badge`/`StatusBadge` (5/10; tones emerald/amber/rose/violet/sky), `Spinner`, `Loading` (17), `Skeleton` (2), `Empty` (5), `ErrorState` (16), `Alert` (14), `Dialog` (with the 5ffadaa focus fix and the Escape stack), `Tabs`, `Kpi`, `Mono`, `KeyValue`, `ItemThumb` | **Split** into `components/ui/{Button,Field,Badge,States,Dialog,Table,Pill,Panel,Layout}.tsx`; `index.tsx` re-exports, so **no screen import changes**. Restyle to the tokens. `gold` and `success` variants removed (3 call sites → primary, R5). `STATUS_TONE` collapses to the four R6 tones (ok, warn, crit, info). `Kpi`, `ItemThumb` and `Mono` are kept as they are (screen components, UI-B/C) |
| `components/ui/DataTable.tsx` (183 lines) | **Unused** (0 imports); 12 screens draw native `<table>`s | **Delete**; replaced by the small `Table` primitives below (the screens adopt them in UI-B/C) |
| `lib/toast.tsx` (79 lines) | Bottom-end stack, `aria-live="polite"`, emerald/rose/ink icons | Restyle (R6 tones, `--shadow-pop`). An error toast uses `role="alert"`; the API is unchanged |
| `components/layout/AppShell.tsx` (332 lines) | Sidebar (3 groups: Counter / Management / Administration, permission-driven), `Logo`, white top bar with the branch pill, Demo badge, `GoldRate`, `Clock`, `Notifications`, language button, `UserMenu`; `SecurityBanners` above the outlet | **Split** into `layout/{AppShell,Sidebar,TopBar,RateChip,BranchSwitcher,UserMenu,Notifications}.tsx` and **`layout/nav.ts`** (the role groups as data, so a test can compare them with the mockups). Every existing `data-testid` is kept (`rate-chip`, `demo-badge`, …) |
| `components/Filters.tsx` | `DateRange`, `BranchSelect`, `useRangeParams` | Kept; `BranchSelect` styles follow the tokens. The switcher reuses its branch query |
| `components/charts.tsx` | Recharts on `--color-series-*` | Unchanged code; the colours follow the token remap (b1…b4) |
| `pages/LoginPage.tsx` (218 lines) | Two panels: a navy panel with a **gold dot pattern**, a hard-coded English marketing tagline and three feature blurbs; the form | **Plain login** (Q2): one centred column on white with the logo, company name and form; all behaviour unchanged (passkey step, recovery code, errors, `homePath`). The marketing strings and their Arabic entries are deleted |
| `pages/ChangePasswordPage.tsx`, `EnrollPage` (in `SecurityPage.tsx`) | Own layouts | Share a new `layout/AuthFrame.tsx` with the login (same plain frame) |
| `lib/i18n.tsx` | English returns the key, so an **enum code shows raw** in English | English labels for display codes (section 6) |
| Untouched | the print module (`lib/print.tsx`, `print/documents.tsx`, `InvoiceDocument.tsx`) apart from the English labels of codes; every page's content | |

### Numbers that frame the risk

- 234 hard-coded `text-[Npx]` sizes in the screens (121 × 13 px). They stay until UI-B/C.
- The new body size (15 px) applies to text that uses the default size.
- 149 uses of emerald, rose, amber, sky and violet. They stay in the screens; the shared components move to R6.

## 2. Components: props, states and verification

All components live in `frontend/src/components/ui/` and `components/layout/`. Every interactive element gets:

- a visible **focus ring**: 2 px gold, offset 2 px. Gold is 7.5:1 on navy and 2.4:1 on white, so a navy inner
  outline is added on light surfaces to reach 3:1 against both;
- **keyboard** operation;
- text labels: colour is never the only signal.

| Component | Props | States to show and verify |
|---|---|---|
| `Button` | `variant: primary \| secondary \| ghost \| danger`, `size: sm(32) \| md(36) \| lg(44)`, `loading`, `icon`, `iconEnd`, `fullWidth`, native button props | default, hover, focus-visible, active, **disabled** (`disabled`, not-allowed cursor, 50 % opacity), **loading** (spinner replaces the icon, width kept, `aria-busy`, not clickable). Primary = navy fill, white text (17.99:1). Secondary = white with a line border. Danger = red outline (Q7). Exactly one primary per screen is a screen rule (R4), not enforced by the component |
| `Input`, `Select`, `Textarea` | native props, `invalid` | default, focus (gold ring), **invalid** (`aria-invalid`, crit border), disabled, read-only; 40 px high, radius 10 |
| `Field` | `label`, `hint`, `error`, `required`, `children` | label tied to the control (`htmlFor`/`useId`); hint and error tied through `aria-describedby`; the error is in `--crit` text (5.30:1) |
| `Dialog` | `open`, `onClose`, `title`, `subtitle`, `footer`, `size: sm \| md \| lg` | open/close, Escape closes only the top dialog (kept), **focus fix from 5ffadaa kept unchanged**, new **focus trap** (Tab cycles inside), focus returns to the opener, `aria-labelledby`, scrolling body with a fixed footer, `--shadow-pop`, radius 20 |
| `Table` primitives (`Table`, `THead`, `TH`, `TR`, `TD`) | `numeric` (end-aligned, tabular, LTR-isolated), `sticky` header, `density: comfortable \| compact` | header in 13 px `--ink-3`, cells in 15 px, row hover, sticky header (R9), empty and loading rows. Only the primitives; screens adopt them in UI-B/C |
| `StatusBadge` / `Badge` | `status` or `tone: ok \| warn \| crit \| info` | the four R6 tones with their tokens (contrast ≥ 4.5:1 from tokens.md); 13 px, radius 6; the label is always text |
| `Empty` | `title`, `body`, `icon`, `action`, `variant: empty \| no-access` | the empty state and the permission-denied variant (today's `Guard` uses it) |
| `ErrorState` | `error`, `onRetry` | message plus a retry button; `role="alert"` |
| `Loading`, `Spinner`, `Skeleton` (+ `SkeletonRows`) | `label`, `rows` | spinner with a label (`role="status"`); skeleton blocks that respect `prefers-reduced-motion` |
| Toast (`useToast`) | unchanged API: success, error, info, `fromError` | three kinds; error uses `role="alert"`; stacks at the bottom-end; disappears after 4.5 s (errors 7 s) |
| `Pill`, `PillGroup` | `selected`, `tone: light \| dark` | used for the language pill, the branch switcher and (UI-B) period chips; `aria-pressed`/`role="radio"` |
| `Panel`, `PanelHeader` | `title`, `count`, `action` | grey flat surface, radius 20, title 17 px; a "View all" link in meta text |
| `PageHeader` | unchanged API | title 20 px, subtitle 13 px `--ink-3` |

**Verification:**

- **Kitchen sink**: a development-only page `/ui` (registered only when `import.meta.env.DEV`, so never in the
  production build) renders every component in every state above with static data.
- **Screenshots**: a new script `scripts/capture-ui-kit.mjs` starts Vite and photographs `/ui` in Arabic (RTL) and
  English (LTR) at 1366×768, 1920×1080 and 1536×864 (a 1920×1080 Windows laptop at its default 125 % scaling).
  The screenshots are committed under `docs/ux/ui-kit/`.
- **Contrast**: a test (`backend/test/design-tokens.test.ts`, next to the other gates) parses `index.css`,
  computes WCAG ratios for every text/background pair that tokens.md lists, and fails below 4.5:1 (text) or 3:1
  (large text, graphics, the focus ring).
- **Keyboard** (Playwright, in the capture script):
  - Tab reaches every control in the shell and in an open dialog;
  - the focus ring is visible (computed `outline` style);
  - Tab stays inside a dialog; Escape closes only the top dialog;
  - focus returns to the opener;
  - the loading button cannot be activated.
- Optional automated accessibility scan with `@axe-core/playwright` (question Q8: a new dev dependency).

## 3. Mockup element → component

| Mockup element (`gm-home`, `bm-home`, `cashier-home`, `empty-gm-home`) | Component | Built in |
|---|---|---|
| `.side` navy rounded panel, 232 px, sticky | `Sidebar` (floating, radius 20, inset 16 px) | UI-A1 |
| `.logo` (◆ + company name) | `Logo` (logo from branding, else the gold-outlined mark) | UI-A1 |
| `.grp` group title | `NavGroup` (13 px, `--on-navy-muted`) | UI-A1 |
| `.nav a`, `.nav a.on` | `NavItem` (15 px, radius 10; active = `--navy-2` plus a gold start-side marker, X13; distinct lucide icons, D-ux-6) | UI-A1 |
| cashier `.side` with two icons | `Sidebar` collapsed form, no toggle (X16) | UI-A1 |
| `.top` (44 px, no bar background) | `TopBar` | UI-A1 |
| `.pill.dark` + `.dot` "عيار 21 · 190,000 ج.س/جم" | `RateChip` (empty: "Set today's rate", a link for the GM; REM-3 behaviour kept) | UI-A1 |
| `.pill` "English" | `LanguagePill` (`Pill`) | UI-A1 |
| `.tag` | `DemoBadge` (demo mode only, X19) | UI-A1 |
| `.avatar` | `UserMenu` trigger: initials 36 px; menu with session info, My activity, Sign-in security, Sign out | UI-A1 |
| (not in the mockups) GM branch switcher | `BranchSwitcher` (`Pill` + menu; Q1) | UI-A1 |
| `.hd`, `h1`, `.sub` | `PageHeader` | UI-A1 (component); screens in UI-B/C |
| `.seg` period pills | `PillGroup` | UI-A1 (component); used in UI-B |
| `.panel`, `.ph h2`, "عرض الكل" | `Panel`, `PanelHeader` | UI-A1 (component); used in UI-B |
| `.row` (white row inside a panel) | `PanelRow` | UI-B |
| `.sev.c / .w / .i` | `StatusBadge` tones crit / warn / info | UI-A1 |
| `.hero` (Sales dark card), `.group .kpi` | `KpiHero`, `KpiGroup` | **UI-B1/B2** (home content) |
| `.bh` / `.br` branch rows, `.sw` swatch | `Table` primitives + `BranchSwatch` (`--bN`) | primitives UI-A1, usage UI-B |
| `.hbar` labelled bars, `.bar` | charts | UI-B |
| `.kv` key–value rows | `KeyValue` (restyled) | UI-A1 restyle |
| `.fold` level divider | `LevelDivider` | UI-B |
| cashier `.search`, `.chips`, product `.card`, cart | `Input` (search), `PillGroup`, POS card | UI-C1 |
| empty-gm `FirstSteps` checklist | existing `FirstSteps` (REM-3), restyled through the tokens only | UI-A2 (per-screen empty states) |

## 4. Preventing regressions

- **Selectors**: every `data-testid` and accessible name used by REH-1, `e2e-print`, `e2e-passkeys` and the
  capture script is kept. A grep in commit 1 lists them; the scripts must pass unchanged after every commit.
- **i18n**: `npm run i18n:check` after each commit. New strings get Arabic; removed strings lose their Arabic
  entry.
- **REH-1** (production mode, real PostgreSQL) after commits 3–6, extended in commit 5:
  1. **Sidebar items per role** (GM, branch manager, cashier) equal `layout/nav.ts`, which mirrors the mockups;
     the GM has no POS entry.
  2. **No cost or profit in the shell for non-GM roles**: as branch manager and cashier, the text of the sidebar
     and the top bar (user menu and notifications opened) contains no cost/profit words (تكلفة، ربح، cost, profit)
     and no figure other than the rate chip's price. The existing `cost-visibility` test already covers every API
     field, `/notifications` included.
  3. The GM branch switcher lists the branches and reaches the target (Q1).
  4. The cashier's sidebar cannot be expanded.
- **e2e scripts**: `e2e-print` (39 checks) and `e2e-passkeys` (29 on, 3 off) after commits 2, 3 and 6. They cover
  dialogs, reauthentication, printing and the second-factor screens that share the new frame.
- **UI baseline**:
  - `scripts/capture-ui-baseline.mjs` (both sets) before commit 1 and after commit 6, into a new
    `docs/ux/baseline-ui-a1/`. The UX-0 set stays as the "before" reference.
  - The script gains the 1536×864 size.
  - Every main screen in ar/en is compared side by side. The screens are expected to change only through tokens
    and shared components; any layout break (overflow, clipped text, a table wider than the page) is fixed in the
    same phase.
- **Visual check at 1366×768 and 1920×1080 (plus 1536×864) with Windows-like fonts**:
  - the fonts are bundled, so the glyphs are the same on Windows;
  - the script asserts `document.fonts` has IBM Plex Sans Arabic and IBM Plex Sans loaded and that no text falls
    back to a system font;
  - Chromium on Linux cannot reproduce Windows ClearType rendering, so the acceptance doc asks the owner for one
    pass on the real Windows laptop in Chrome/Edge at 100 % and 125 % scaling.
- **R14** (level 1 of every home fits 1366×768) is checked on the new shell. The homes' content changes only in
  UI-B, but the 44 px top bar and the 16 px insets must not push today's level 1 down.

## 5. Commit sequence, gates and docs

Each commit is small, pushed, and leaves everything green. Gates after every commit: `npm run typecheck` (all
gates), both backend test projects, `npm run build`, `npm run i18n:check`. REH-1 and the e2e scripts run where
noted.

| # | Commit | Extra checks |
|---|---|---|
| 0 | Capture the "before" baseline (`capture-ui-baseline.mjs` at three sizes) into `docs/ux/baseline-ui-a1/before/` | — |
| 1 | **Tokens**: new `@theme` (semantic tokens, type scale, radii, shadow) plus the legacy remap; body 15 px on white; `index.html` theme colour; contrast test | REH-1 |
| 2 | **Base components**: split `ui/index.tsx`; restyle Button (variants, loading), Field/Input/Select (invalid, ids), Badge (R6), states, Toast, Dialog (focus trap; 5ffadaa logic untouched); new Table primitives, Pill, Panel; delete `DataTable.tsx`; dev-only `/ui` page and `scripts/capture-ui-kit.mjs` | e2e-print, e2e-passkeys; kit screenshots |
| 3 | **Glitches**: English labels for display codes and an i18n:check rule against raw codes; the "$" after "N invoices" (section 6) | REH-1 English POS check |
| 4 | **App shell**: `layout/nav.ts` (role groups per the mockups), `Sidebar` (floating, collapsed cashier, no GM POS), `TopBar` (rate chip, branch switcher, Demo badge, language pill, user menu), white page with 16 px insets | REH-1 with the new role and shell checks |
| 5 | **Plain login** and the shared `AuthFrame` (login, change password, passkey enrollment) | REH-1, e2e-passkeys |
| 6 | **Docs and evidence**: after-baseline, kit screenshots, decisions D-ui-1…n, `docs/acceptance/UI-A1.md`, ANALYSIS §10.1 / BACKLOG E (X1), tokens.md note on the legacy remap | all gates, REH-1, both e2e |

Decisions to record (`docs/decisions.md` §17):

- D-ui-1: legacy token remap;
- D-ui-2: component split and API stability;
- D-ui-3: focus ring on light and navy surfaces;
- D-ui-4: danger style;
- D-ui-5: branch switcher behaviour;
- D-ui-6: shell per role and the hidden GM POS link;
- D-ui-7: plain login now, redesign later;
- D-ui-8: English labels for codes;
- D-ui-9: dev-only kit page.

The acceptance doc gives the owner a 15-minute walk-through per role at both sizes, plus the Windows check.

## 6. The two known glitches: fix them in UI-A1

1. **Stray "$" after "0 invoices"**: `frontend/src/pages/dashboard/BranchDashboardPage.tsx:117`. The template is
   `` `${t(...)}$` ``, a typo. ANALYSIS planned it for UI-B2, but it is a one-character fix with no design
   decision. **Fix in commit 3.**
2. **Raw `BANK_TRANSFER` in English**: the cause is wider than the POS.
   - `t(code)` in English returns the key. Every enum code shown to a user appears raw in English.
   - Affected: the POS payment buttons, the sales list and detail, scrap purchases, the payment-method setting,
     the on-screen invoice (`InvoiceDocument.tsx`) and the **printed** document (`print/documents.tsx`).
   - `StatusBadge` hides it by replacing `_` with spaces.
   - **Fix in commit 3**:
     - English labels for the display codes (payment methods, statuses, kinds, roles) in one table next to
       `i18n-ar.ts`;
     - `i18n:check` gains a rule that every code reaching `t()` from a shared enum has an English and an Arabic
       label;
     - REH-1 checks the English POS shows "Bank transfer";
     - `e2e-print` checks an English invoice prints "Bank transfer".
   - No backend change.

## 7. Risks and questions

**Risks**

- **Every screen changes at once through the tokens** (white page, new greys, 15 px body, new chart colours, new
  focus ring) while their layout stays old until UI-B/C. Some mixes will look half-new.
  - Mitigation: the legacy remap keeps the hierarchy.
  - The before/after baseline at three sizes is reviewed screen by screen, and layout breaks are fixed in the same
    phase.
  - Q3 lets you limit how far the change goes now.
- **15 px body** grows tables that use the default size: wider columns at 1366 px. The Transfers table already
  overflows today (ANALYSIS); it may get worse until UI-C2. The baseline review catches it.
- **The shell refactor touches every page wrapper.** Mitigations:
  - all test ids are kept;
  - REH-1 walks every role;
  - the heartbeat and `setCurrentModule` logic moves as is.
- **Fonts on Windows**: same glyphs, different rasterisation; only the owner's laptop check confirms.
- **Focus ring contrast**: gold is 2.4:1 on white. The navy inner outline is a design addition not in the mockups;
  it is shown on the kit page for approval.

**Questions for the owner**

| # | Question | Recommendation |
|---|---|---|
| Q1 | **GM branch switcher**: the mockups have none. Where, and what does choosing a branch do in UI-A1? | A light pill after the rate chip: "All branches ▾", listing the branches with their colour dot. In UI-A1 choosing a branch **opens that branch's page** (`/branches/:id`, today's drill-down); "All branches" opens the home. A global branch filter that every screen obeys needs screen changes and belongs to UI-B/C |
| Q2 | **Login**: you asked for a plain login in UI-A1 and put "the login redesign" in UI-A2. tokens.md plans a tagline from a new branding setting, which is a backend change | UI-A1: plain centred login (logo, company name, form; no image, no pattern, the marketing copy removed). UI-A2: the tagline setting and anything else in the redesign |
| Q3 | **How far the new look reaches the screens now**: switch the page to white and `Card` to the grey flat panel everywhere (one look, screens half-new until UI-B/C), or keep `Card` white and bordered on the white page until each screen is reworked? | Switch now (one design system, as BRIEF §21 asks), with the baseline review as the safety net |
| Q4 | **Clock and notification bell**: neither is in the mockups or ANALYSIS. The bell carries transfer and failed-sign-in alerts until the attention list (BE-1, UI-B) exists | Remove the clock now; keep the bell, restyled as an icon button, until UI-B replaces it with the attention list |
| Q5 | **Security banners** ("register a second passkey", R13: none above level 1) | Keep them as they are in UI-A1 (security UX); move them into the user menu in UI-A2 |
| Q6 | **Branch manager "Active users"**: shown in ANALYSIS, missing in the mockup; the role has `sessions.view` | Show it (the sidebar follows permissions; one place to check) |
| Q7 | **Danger button**: red outline (R4) or filled red (today)? | Outline everywhere; a filled red button only for the final confirmation inside a dialog |
| Q8 | **Accessibility scan**: add `@axe-core/playwright` as a dev dependency (lockfile change) for the kit page and the shell? | Yes |
| Q9 | Add **1536×864** (a 1920×1080 Windows laptop at 125 %) to the visual checks? | Yes |
