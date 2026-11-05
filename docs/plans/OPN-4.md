# OPN-4 — The Branch Manager enters the pieces of their branch's opening balance

Status: **approved by the owner on 2026-11-05** (answers Q-a…Q-f in §6 and `docs/decisions.md` D-opn4-1…4); built in
c1–c4. Two deviations, both reported: the draft export keeps its columns (D-opn4-3), and the seal dialog sends the
reviewed numbers from c2 on (the API required them there; plan §4 had it in c3).

**Owner's request.** The opening balance will have a very large number of pieces. Typing them is hard work for the
General Manager alone, so the Branch Manager must be able to help enter them.

## 1. What exists today (survey)

- **One permission covers everything.** `opening.manage` is in `GM_ONLY_PERMISSIONS` (OPN-1 plan §3, "General Manager
  only") and covers: the list, starting an opening, the draft (lines, CSV import, template, export, review), the seal
  (password and a fresh passkey, D-opn1-5) and the OPN-3 broken-scrap lines (D-opn3-2, "General Manager only, Q10").
  `opening.correct` (D-opnfix-2, D-opn3-4) covers the corrections after the seal.
- **Every opening route is scope `global`**, which needs `scope.all_branches`, so a Branch Manager cannot reach any of
  them today (`shared/src/route-matrix.ts` lines 172–189). The services check `opening.manage` only; there is no branch
  check, because only global users could get in.
- **The author of every line is already stored.** `opening_lines.created_by` is `NOT NULL` and references `users`, and
  `created_at` is there too, for keyboard lines and imported lines alike (the importer is the author). It is not
  returned by the API, and the table's "Entered by" column shows the **source** (KEYBOARD / IMPORT): exactly the
  confusion the owner named. **No migration is needed for the author; old rows already have it.**
- **How new permissions reach an existing database.** A migration inserts the permission and grants it to the system
  roles by code, with `ON CONFLICT DO NOTHING` (0026 `opening.manage`, 0032 `opening.correct`, 0038 `money_transfers.*`).
  `seedRolesAndPermissions` runs only at bootstrap. **There are no custom roles:** only the three system roles exist,
  `GET /roles` is the only role route, and no screen or API creates a role or edits grants. So no custom role can gain
  anything silently.
- **When a grant takes effect.** `loadActor` reads `role_permissions` each time it loads the actor, so a Branch Manager
  gets the grant on the next request, with no new sign-in.
- **Concurrency.** Adding, removing and importing lines lock the opening row (`lockDraft` → `FOR UPDATE`), and so does the
  seal. Two people typing into one draft are serialized, and line numbers stay unique (`opening_lines_no_uq`).
- **Other readers of `opening.manage`:**
  - the sidebar item and the routes of the two pages (`nav.ts`, `App.tsx`);
  - the POS "opening still a draft" link (`PosPage.tsx`);
  - the first-steps card (`setup/service.ts`, D-ux4-1);
  - `GET /catalog/descriptions` (its `any` list; the Branch Manager already passes through `catalog.create`);
  - the permission's label (`permission-labels.ts`) and the field-classification comment;
  - REH-1's "GM-only permissions" check.
- **One test will become stale.** `opn1-openings.test.ts` asserts that the Branch Manager gets 403 on `GET /openings`.
  After OPN-4 the Branch Manager gets 200 with their own branch only, while `POST /openings` stays 403. The test is
  updated as part of this change; the report will name it.

## 2. Design (the proposal confirmed, with three additions)

### 2.1 Split the permission

- **New permission `opening.enter`:** "Enter the pieces of the opening balance of the own branch (draft only)". It is
  **not** in `GM_ONLY_PERMISSIONS`. It is granted to `BRANCH_MANAGER` and to `GENERAL_MANAGER` (who holds every
  permission). The cashier gets nothing. Arabic name (UX-2, plain words): **«إدخال قطع الرصيد الافتتاحي»**.
- **It covers:**
  - viewing the openings list and an opening;
  - the CSV template;
  - adding a line, removing a line, importing a CSV;
  - exporting the draft.
- **`opening.manage` stays GM-only and keeps:**
  - starting an opening (`POST /openings`);
  - **the seal** (re-auth unchanged);
  - the OPN-3 broken-scrap draft lines.

  Its description becomes "Start and seal the opening balance of a branch; its broken scrap".
- `opening.correct` is unchanged.

| Route | Today | After OPN-4 |
|---|---|---|
| `GET /openings` | global, `opening.manage` | **branch, `opening.enter`**: a Branch Manager gets only their own branch's row |
| `POST /openings` (start) | global, `opening.manage` | unchanged |
| `GET /openings/template.csv` | global, `opening.manage` | **none, `opening.enter`** (a fixed header row, no branch data) |
| `GET /openings/:id` | global, `opening.manage` | **branch, `opening.enter`** + the service's branch check |
| `GET /openings/:id/export` | global, `opening.manage` | **branch, `opening.enter`** + branch check |
| `POST /openings/:id/lines` | global, `opening.manage` | **branch, `opening.enter`** + branch check, draft only |
| `POST /openings/:id/lines/:lineId/remove` | global, `opening.manage` | **branch, `opening.enter`** + branch check, draft only |
| `POST /openings/:id/import` | global, `opening.manage` | **branch, `opening.enter`** + branch check, draft only |
| `POST /openings/:id/seal` | global, `opening.manage`, reauth | unchanged (plus the review check, 2.4) |
| `POST /openings/:id/scrap-lines…` (3 routes) | global, `opening.manage` | unchanged |
| corrections (3 routes) | global, `opening.correct`, reauth | unchanged |
| `GET /catalog/descriptions` | `any` incl. `opening.manage` | `opening.enter` added to the `any` list (no change in effect for the Branch Manager) |

### 2.2 Branch scope (security-critical)

- The route guard of scope `branch` confines a branch-bound user to their own branch.
- For the `:id` routes, the services add an explicit check, as MNY-1 does (`canSee`): a user without
  `scope.all_branches` sees an opening only if `opening.branch_id = actor.branchId`. Otherwise the answer is **404
  "Opening not found"**, the same as for a missing one, so another branch's opening is not revealed. The check runs
  before the row lock and again under it.
- `GET /openings` lists only the own branch for a branch-bound user.
- **A sealed opening is read-only for everyone (unchanged):** `lockDraft` answers 409 `OPENING_SEALED`. The Branch Manager
  can **read** their sealed opening: summary, pieces now, corrections, broken scrap. Every field is SAFE: opening pieces
  have no known cost.

### 2.3 Who entered what (the review)

- Each line in `GET /openings/:id` gains `enteredByName` (`created_by` → `users.full_name`) and `enteredAt`
  (`created_at`). Old lines already carry both; no NULL case exists, because the column is `NOT NULL`.
- The table:
  - "Entered by" now shows the **person**;
  - a new "Entered at" column;
  - the source column is renamed **"How" (Typed / From the file)**, so the two are no longer confused.
- The summary gains `byUser`: per person, the pieces and the net weight. It is shown as a small "Entered by" table on the
  review panel beside the totals by karat, condition and type, so the General Manager sees who typed what before sealing.
- The draft CSV export gains an "Entered by" column (Arabic and English header, as the others).

### 2.4 Addition: the seal checks what the General Manager reviewed (recommended; question Q-d)

- With several people typing, a line can arrive between the General Manager's review and the seal.
- The seal request therefore carries the count and the net weight the seal dialog showed (`expectedLines`,
  `expectedNetWeightMg`). Under the seal's row lock, the server compares them with the draft. If they differ, the answer
  is **409 `OPENING_CHANGED_SINCE_REVIEW`** with the current numbers; the dialog reloads them and the GM seals again.
- This is a check before the seal, not a change to the seal's ledger, stock or money logic; the re-auth stays as it is.
- **Proposed rule:** both fields are required whenever the draft has pieces. The only client is the app.

### 2.5 Screens

- **Sidebar:** "Opening balance" for `opening.enter`. The Branch Manager's list shows their branch only. "Start" appears
  only with `opening.manage`; if the opening is not started yet, the Branch Manager reads: "The General Manager starts the
  opening balance of your branch."
- **Draft page:**
  - **For the Branch Manager:** keyboard entry, CSV import, template, export, the lines (remove on any line, Q-a), and the
    summary with "Entered by". The broken-scrap card is read-only for them, and there is no seal panel: instead, one line
    says "The General Manager reviews and seals the opening balance."
  - **For the General Manager:** as today, plus "Entered by" and its summary.
- **First steps (UX-4):** unchanged, GM only.
- **POS line** "the opening balance is not sealed yet": the link to the opening is shown to `opening.enter` too, so the
  Branch Manager reaches their own draft from there.
- Arabic for every new text; a Help line on the entry card for the Branch Manager.

### 2.6 Data, migration and existing systems

**Migration 0039 (additive):**

```sql
INSERT INTO permissions (code, description) VALUES ('opening.enter', '…') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
  SELECT id, 'opening.enter' FROM roles WHERE code IN ('BRANCH_MANAGER', 'GENERAL_MANAGER')
  ON CONFLICT DO NOTHING;
UPDATE permissions SET description = '<new text>' WHERE code = 'opening.manage';
```

- It is idempotent, and runs on a database that already holds data.
- It changes no opening, line or stock row. It is not destructive: it only updates one row's description text.
- It is checked by a new upgrade test from 0038, with a live opening and lines.
- **No author migration** is needed (§1).

**After deploy, on the server:** the normal `docs/runbooks/update-deploy.md`:
1. a backup before the update;
2. pull and build;
3. `npm run migrate`, or the start-up migration;
4. the preflight: `migrations 40 of 40 applied`, every line PASS;
5. restart.

Nothing is run by hand for the permission. To check it: sign in as a Branch Manager; "Opening balance" is in the sidebar
and shows only their branch.

### 2.7 Tests

- **The permission matrix for every opening route × role.** The roles are: the General Manager, the Branch Manager of
  the branch, the Branch Manager of another branch, the cashier, and a Branch Manager whose `opening.enter` grant was
  revoked in the test database (the "role without the permission"). Expected:
  - the entry routes: 200 for the own branch; 404 for another branch, reading and writing; 403 without the permission;
  - start, seal, scrap and corrections: 403 for everyone but the General Manager;
  - a sealed opening: 409 for every write, readable by its own Branch Manager.
- **Who entered what:** `enteredByName` on keyboard and imported lines; `byUser` adds up to the totals.
- **The seal's review check:** a line added after the review → 409 and nothing sealed; the right numbers → sealed.
- **PostgreSQL race** (`test/pg/opening-enter-race.test.ts`):
  - two Branch Managers' lines plus an import at once on one draft: line numbers unique, all present;
  - a Branch Manager's line racing the seal: either it is in the reviewed numbers and sealed, or it gets 409 because
    the opening is sealed. Never a sealed piece the General Manager did not review.
- **Guardrails:**
  - the phase1b matrix samples, with CROSS (other branch) for the new branch-scope routes. CROSS accepts 403 or 404,
    or 200 only when nothing of the other branch leaks, so the fixtures gain a draft opening of the other branch (OMD)
    to probe;
  - the cost-visibility GETs;
  - the UX-3 route audit (no new re-auth);
  - `GM_ONLY_PERMISSIONS`, still holding `opening.manage` and `opening.correct` only on the General Manager;
  - the migration upgrade test.
- **REH-1:**
  - the Branch Manager holds `opening.enter`, and the GM-only list stays held only by the General Manager;
  - the Branch Manager's sidebar gains `openings`;
  - the Branch Manager types 3 pieces and imports a small CSV;
  - another branch's opening gives 404, and seal and scrap give 403;
  - the General Manager sees "Entered by" per person, a seal with stale numbers is refused, and the seal with the
    reviewed numbers succeeds.

  The count rises from 373; the report states the new number.
- **e2e:** `scripts/e2e-openings.mjs` gains a Branch Manager session doing the same, then the General Manager seeing
  "Entered by" and sealing.

## 3. Proposed decisions (to be written in `docs/decisions.md`)

| ID | Decision |
|---|---|
| D-opn4-1 | The draft pieces of an opening are entered by `opening.enter` (Branch Manager of the branch, and the General Manager). **This supersedes only the "entering the pieces" part** of the OPN-1 plan's "opening.manage, General Manager only". Starting an opening, the seal (password and passkey, D-opn1-5), the broken-scrap lines (D-opn3-2) and every correction after the seal (D-opnfix-2, D-opn3-4) stay General-Manager-only. |
| D-opn4-2 | Branch scope: a branch-bound user sees and changes only their own branch's opening, only while DRAFT; another branch's opening answers 404. |
| D-opn4-3 | "Entered by" is the line's author (`created_by`, kept since OPN-1); the source column becomes "How". The review shows pieces and net weight per person. |
| D-opn4-4 | (if Q-d is yes) The seal carries the line count and net weight the General Manager reviewed; a different draft is 409 `OPENING_CHANGED_SINCE_REVIEW`. |

## 4. Commits (each green, pushed; REH-1 in the same commit as each route, page or permission change)

| # | Commit |
|---|---|
| c0 | this plan |
| c1 | migration 0039 + `opening.enter` in `shared/permissions` (Branch Manager list) + Arabic label + upgrade test + DATA_MODEL and FEATURES + REH-1 (the Branch Manager holds `opening.enter`) |
| c2 | backend: the entry routes to `opening.enter` and scope `branch`; the services' branch check; `enteredByName` / `enteredAt` / `byUser`; the seal's review check; the matrix and its guardrail tests; the route × role tests; the stale `opn1` test updated; the PostgreSQL race; DEPLOYMENT (routes, error code); REH-1 (API) |
| c3 | screens: sidebar, list and draft for the Branch Manager; "Entered by" / "Entered at" / "How"; the per-person summary; the seal dialog sends the reviewed numbers; the POS link; Arabic and Help; REH-1 (sidebar and screens); e2e-openings |
| c4 | `docs/acceptance/OPN-4.md`, decisions D-opn4-*, BACKLOG, README roles row, `npm run verify -- --full` |

## 5. Risks

- **Security:** a missed branch check would let a Branch Manager read or change another branch's draft. The routes move
  to scope `branch`, the services check every `:id`, and the route × role tests and the PostgreSQL race cover it.
- **The seal includes an unreviewed line** if Q-d is declined: then the General Manager must stop the managers' entry by
  hand before sealing.
- **Large drafts:** several people importing at once are serialized by the row lock; a 5,000-row import holds it for its
  transaction, and the others wait (measured in the race test).
- **A line removed by mistake:** removal is audited with what the line held (the audit log, branch-scoped); a removed
  line is typed again. The draft is not stock.

## 6. Open questions

- **Q-a. May a Branch Manager remove lines typed by the General Manager or another person, while it is a draft?**
  Recommended: **yes**. The draft is not stock, every removal is audited with the line's content and who removed it, and
  the per-person summary shows the change.
- **Q-b. Do the broken-scrap lines (OPN-3) stay GM-only?** Recommended: **yes**. You asked for pieces only, and the
  Branch Manager sees them read-only.
- **Q-c. Can the General Manager lock a draft against further entry by others?** Recommended: **not now**; a later
  option. Q-d covers the risk it would address.
- **Q-d. Should the seal check that the draft is still what the General Manager reviewed** (2.4, 409
  `OPENING_CHANGED_SINCE_REVIEW`)? Recommended: **yes**.
- **Q-e. Starting an opening:** recommended to keep it **GM-only**, as you proposed. The Branch Manager reads that the
  General Manager starts it.
- **Q-f. May the Branch Manager read their branch's opening after it is sealed** (summary, pieces now, corrections,
  broken scrap; read-only)? Recommended: **yes**.
