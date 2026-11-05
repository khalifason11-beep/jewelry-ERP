# Manual acceptance: OPN-4 (the Branch Manager enters the pieces of the own branch's opening balance)

For the owner, about 15 minutes, on the live server after the update, in a desktop browser, with two windows: you (the
General Manager, with your passkey) and the manager of one branch (a private window, or another browser). Engineering
ran section A.

What changed (your approval of 2026-11-05, plan `docs/plans/OPN-4.md`, decisions D-opn4-1…4):

- A branch manager now has **Opening balance** «الرصيد الافتتاحي» in the sidebar. It shows **the own branch only**; the
  opening of another branch cannot be opened (it answers "not found").
- While the opening is a **draft**, the branch manager types pieces, imports a CSV file, removes pieces (also those
  someone else typed, Q-a), downloads the template and exports the draft. After the seal they can read it, and nothing
  more.
- **You alone** start an opening, enter the broken scrap, seal (password and passkey, as before) and correct after the
  seal.
- Every line shows **who entered it** «أدخلها», when «وقت الإدخال» and how «الطريقة» (typed «كتابة» / from the file
  «من الملف»). The review shows the pieces and net weight **per person** (the card «أدخلها», with the column «الشخص»).
- **The seal checks what you reviewed:** if a piece was added or removed after the seal dialog showed you its numbers,
  the seal is refused with «تغيّر الرصيد الافتتاحي منذ مراجعتك…», nothing is sealed, and the dialog shows the new
  numbers. Review them, then press Seal again.

> **You must press "Start" «ابدأ» for the branch first. The branch manager cannot start an opening.**
> Before you do, the branch manager sees their branch listed as «لم يبدأ» (not started), with no Start button and the
> text «يبدأ المدير العام الرصيد الافتتاحي لفرعك.» ("The General Manager starts the opening balance of your branch.").
> They can enter nothing until you have started it.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| New tests | `opn4-migrations` (upgrade from 0038 with a live draft: nothing moves; the default grants), `opn4-openings` (every opening route × the General Manager, the branch's manager, another branch's manager, the cashier, a manager whose grant was revoked; who entered what; removing a line someone else typed, audited; the seal's review check: missing 400, stale 409, current sealed; a sealed opening read-only), `pg/opening-enter-race` (a manager, you and an import at once on one draft; a manager's piece racing your seal: never a sealed piece you did not review), phase1b (the other branch's opening for the new branch-scope routes) |
| Updated test | `opn1-openings` asserted that a branch manager gets 403 on the list; now 200 with the own branch only (starting stays 403) |
| REH-1 | 392 checks (was 373): the steps below through the API and the screens on an empty production database |
| Browser scripts | `e2e-openings` (the branch manager before Start, typing and importing; "Entered by" per line and per person; a piece added while your seal dialog is open is refused and the numbers reload), `e2e-states` 98 |

## B. Checklist (the live server)

Prepare: a branch whose opening is **not started yet**, its branch manager's sign-in, and a small CSV of 1 or 2 pieces
(the template «نموذج CSV» filled in).

1. [ ] **Before Start.** Sign in as the **branch manager** of that branch. The sidebar shows **Opening balance**
   «الرصيد الافتتاحي». The page lists **their branch only**, «لم يبدأ», no Start button, and the text
   «يبدأ المدير العام الرصيد الافتتاحي لفرعك.»
2. [ ] **You start it.** In your window: Opening balance → that branch → **Start** «ابدأ».
3. [ ] **The branch manager types 2 pieces.** They reload the page and open the draft. They see the entry form and the
   import, **no seal button** (instead «يراجع المدير العام الرصيد الافتتاحي ويختمه.»), and the broken scrap read-only
   («يُدخل المدير العام الكسر.» while there is none). They type 2 pieces (type, karat, description, condition, gross
   and net weight; Enter on the last field adds the piece). Optionally they import the small CSV too.
4. [ ] **You see "Entered by" per person.** In your window, reload the draft. Each of their lines shows their name under
   «أدخلها», the time under «وقت الإدخال» and «كتابة» or «من الملف» under «الطريقة». The card «أدخلها» shows their
   name with the number of pieces and the net weight (and yours, if you typed any).
5. [ ] **Your seal with stale numbers is refused.** Press **Seal** «ختم», type your password and confirm with your
   passkey, but do **not** press the final Seal yet. Now the branch manager types **one more piece**. Press **Seal** in
   your dialog: it is refused with «تغيّر الرصيد الافتتاحي منذ مراجعتك…», the opening is still a draft, and the
   dialog's numbers now include the new piece.
6. [ ] **The branch manager sees no seal button** (step 3), and no Start button for any branch.
7. [ ] **Seal for real.** Review the new numbers in the dialog and press **Seal** (the password and passkey again if
   asked). The opening is sealed with every piece, the branch manager's included.
8. [ ] **After the seal.** The branch manager opens the sealed opening: they can read it (the pieces with their codes)
   and there is nothing to add, remove or import.

Step 7 puts real pieces into stock. To check without sealing, stop after step 6 and remove the test pieces from the
draft (the bin icon on each line); a draft is not stock.

## C. After the update (the server)

The normal `docs/runbooks/update-deploy.md`; nothing is run by hand for the permission:

1. the pre-update backup: `systemctl stop jerp`, `jerp_backup npm run backup`, then `backup:verify` of that file on the
   drill machine (do not continue unless it passed);
2. pull and build: `sudo -u jerp git fetch --tags && sudo -u jerp git checkout <new tag>`, `npm ci --include=dev`,
   `npm run build`;
3. migrate: `jerp npm run migrate` (migration 0039);
4. preflight: `jerp node scripts/server/preflight.mjs` shows `migrations: 40 of 40 applied` and every line PASS;
5. start again: `systemctl start jerp`, and wait for `{"ready":true}` on `/api/ready`.

A branch manager who is already signed in gets the new permission on the next page they open.

## D. Not built

- A lock of the draft against further entry by others (your answer Q-c: not now). The seal's review check (step 5)
  covers the risk.
- An "Entered by" column in the draft's CSV export: the import refuses unknown columns, so the exported draft would no
  longer import again (D-opn4-3). The author is on the screen and in the audit log.
