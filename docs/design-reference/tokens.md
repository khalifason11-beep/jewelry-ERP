# Design tokens

**Source of truth:** the CSS variables in `docs/ux/mockups/gm-home.html` (the other mockups copy the same block).
The owner approved the look of those static mockups; no Figma export files will be provided (decision D-ux-0 in
`docs/decisions.md`). When a token changes, change it in the mockup **and** here in the same commit; UI-A1 then
copies these values into `frontend/src/index.css` (one place, CSS variables, so another client's brand is a token
change).

Contrast ratios are WCAG 2.x, computed against the background named. Text needs ≥ 4.5:1 (AA), large text and
graphics ≥ 3:1.

## Colour

### Brand and neutrals
| Token | Value | Use | Contrast |
|---|---|---|---|
| `--navy` | `#0F1629` | sidebar, the Sales card, primary button, active pill outline, chart series 1 | text `--ink` = same value; 17.99:1 on white |
| `--navy-2` | `#232D45` | active sidebar item | — |
| `--navy-3` | `#3A4562` | hover on navy | — |
| `--on-navy` | `#C8CEDB` | sidebar text | 11.40:1 on navy |
| `--on-navy-soft` | `#AEB6C8` | labels and sub-lines on the Sales card | 8.85:1 on navy |
| `--on-navy-muted` | `#7F8AA5` | sidebar group titles | 5.21:1 on navy |
| `--gold` | `#C9A24B` | **the one accent**: logo, active-item marker, rate-chip dot, focus ring, the "now" point on a line chart. Never a fill for a KPI, a link colour or a chart series (R5) | 7.50:1 with navy either way; **white on gold 2.40:1 — never use white text on gold** |
| `--gold-soft` | `#F5ECD6` | selected row background (rare) | — |
| `--ink` | `#0F1629` | primary text | 17.99:1 on white |
| `--ink-2` | `#4B5570` | secondary text, labels | 6.80:1 on panel |
| `--ink-3` | `#646D82` | meta text, table headers, hints | 5.18:1 on white, 4.75:1 on panel |
| `--surface` | `#FFFFFF` | page background, rows inside panels | — |
| `--panel` | `#F4F5F8` | panels, the three-figure KPI surface, light pills | — |
| `--neutral-bg` | `#EEF0F4` | "info" badge, bar tracks | — |
| `--line` | `#E4E7EE` | thin dividers (between KPI figures, key-value rows) | — |

### Meaning (R6) — used only when the state applies, never as decoration
| State | Text | Background | Contrast | Label (ar / en) |
|---|---|---|---|---|
| critical | `--crit` `#B91C1C` | `--crit-bg` `#FEE2E2` | 5.30:1 | عاجل / Urgent |
| warning | `--warn` `#B45309` | `--warn-bg` `#FEF3C7` | 4.51:1 | تنبيه / Warning |
| success | `--ok` `#047857` | `--ok-bg` `#D1FAE5` | 4.84:1 | (completed states only) |
| info / normal | `--ink-2` | `--neutral-bg` | 6.50:1 | للعلم / For information |

### Branch palette (D-5) — chart bars and branch dots, always with the branch name next to them
| Token | Value | Name | Contrast vs white / panel |
|---|---|---|---|
| `--b1` | `#0F1629` | navy | 17.99 / 16.6 |
| `--b2` | `#1E6B66` | dark teal (replaces the mockup's gold) | 6.27 / 5.8 |
| `--b3` | `#A2824D` | sand (the mockup's cream, darkened to reach 3:1) | 3.60 / 3.30 |
| `--b4` | `#7487CB` | periwinkle (darkened to reach 3:1) | 3.46 / 3.17 |

A fifth branch reuses the palette with a pattern or takes a GM-chosen colour (branch field, UI-B).

## Typography (R16)
Font: **IBM Plex Sans Arabic** (with IBM Plex Sans for Latin), bundled locally (the CSP forbids external fonts;
the mockups load it from Google Fonts only because they are standalone files). Numbers: tabular figures, isolated
LTR inside RTL text (`.num`). A script display font is allowed **on the login page only** (D-8); IBM Plex Sans
Arabic until the owner supplies an Arabic equivalent.

| Token | Size | Weight | Use |
|---|---|---|---|
| `--fs-meta` | 13 px | 400 | meta lines, table headers, badges, hints, sidebar group titles |
| `--fs-body` | 15 px | 400 / 500 | body text, table cells, sidebar items, buttons |
| `--fs-section` | 17 px | 600 | section (panel) titles |
| `--fs-title` | 20 px | 600 | page title |
| `--fs-kpi` | 24 px | 600 | the four KPI figures |
| (exception) | 22 px | 600 | one emphasised figure inside a level-2 panel (gold position) |

Weights: `--fw-regular` 400, `--fw-medium` 500, `--fw-semibold` 600. Line height 1.45 (KPI figures 1.25).

## Spacing
4-px grid: `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 24 · `--s6` 32. Page padding 16; gap between
panels 16; rows inside a panel 6 apart; row padding 7 × 12; panel padding 12 × 14.

## Radii
| Token | Value | Use |
|---|---|---|
| `--r-panel` | 20 px | panels, sidebar |
| `--r-card` | 16 px | the Sales card and the three-figure KPI surface, product cards |
| `--r-row` | 12 px | rows inside panels, cart lines |
| `--r-control` | 10 px | buttons, inputs, sidebar items |
| `--r-badge` | 6 px | severity badges |
| `--r-pill` | 999 px | chips, period pills, the rate chip, language pill |

## Shadows
Panels and cards are **flat** (`--shadow-none`); hierarchy comes from the panel grey and spacing. Only dialogs,
menus and popovers float: `--shadow-pop` = `0 8px 28px rgba(15,22,41,.16)`.

## Layout constants
Sidebar 232 px (64 px collapsed, icon only; the cashier always sees the collapsed form); top bar 44 px; level 1 of
every home must fit 1366 × 768 without scrolling (R14).

## In the code (UI-A1)
These values live in `frontend/src/index.css` (`@theme`) as `--color-*`, `--text-*`, `--radius-*` and
`--shadow-pop`; `backend/test/design-tokens.test.ts` keeps them equal to this file and checks the contrast pairs.
The colour names used before UI-A1 (`ink-950…300`, `gold-*`, `canvas`, `line-strong`, `series-1..4`) are
**remapped** to these values (D-ui-1) so every screen took the new look at once; UI-B and UI-C move each screen to
the semantic names, then the old names are deleted. Focus ring: 2 px gold outside a 2 px navy ring (D-ui-3).

## Login page
`docs/design-reference/login-background.jpg` does **not** exist. UI-A1 built a **plain, centred login page**
(logo, company name, the form; D-ui-7); UI-A2 adds the login tagline from settings (new branding setting); no image panel. If
the owner later adds the image (with its commercial licence confirmed), it is optimised to WebP under 200 KB, served
locally, and shown in the image panel.
