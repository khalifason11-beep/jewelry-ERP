# Screens after the latest UI phase

**Current set: UI-B** (role homes, the attention list, the shell's attention control), taken in the UI-B docs commit.
At all three sizes in both languages: the three role homes (the GM home `01-gm-home-company-overview`, the branch
manager's home `18-bm-home-branch-dashboard`, the cashier's POS `26-cashier-home-pos`, unchanged until UI-C1), the GM's
view of a branch (`03-gm-branch-detail`) and Settings (Business rules: the two attention thresholds). The
empty-production homes show the first steps beside the attention list (GM) and the branch manager's zeros.
Each UI phase replaces this folder with its own "after" set; earlier sets stay in git history
(`git show <commit>:<path>`, or browse the repository on GitHub at that commit):

| Phase | Commit | Folder at that commit |
|---|---|---|
| UX-0 (before any redesign) | `00d0f89` | `docs/ux/baseline/` (JPEG) |
| UI-A1 before | `35c2410` | `docs/ux/baseline-ui-a1/before/` (JPEG) |
| UI-A1 after (full set) | `36e4e1e` | `docs/ux/baseline-ui-a1/after/` (JPEG) |
| UI-A1 after (slim WebP) | `b3ddbae` | `docs/ux/screens/` |
| UI-A2 after | `2988ff5` | `docs/ux/screens/` |
| POS-FIXES after | `121bb9a` | `docs/ux/screens/` |

Rule (D-ui-10), applied by `scripts/lib/screens.mjs`; `npm run check:assets` enforces at most 4 MB in total,
150 KB per image, WebP only, no "before" set:

- `demo/` (a database filled by `npm run dev:sample`; GM, branch manager, cashier):
  - Arabic and English at 1366×768, 1536×864 and 1920×1080: the three role homes and the screens the phase
    changed;
  - Arabic at 1366×768: every other main screen.
- `empty-production/`: each role's home right after its first sign-in on a new production database (REH-1),
  1366×768, Arabic and English.

```bash
REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>@localhost:5432/postgres \
  node scripts/capture-ui-baseline.mjs --publish --changed='04-gm-sales|06-gm-inventory'
```

The full capture (every screen, every size, JPEG, "-full" scrolled pages) stays in the git-ignored `.ux-shots/`.
