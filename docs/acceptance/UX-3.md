# Manual acceptance: UX-3 (fewer passkey / re-authentication prompts)

For the owner, about 15 minutes, in a desktop browser, signed in as the General Manager with your passkey. Engineering
ran section A.

What changed (your request of 2026-10-29, plan `docs/plans/UX-3.md`, decisions D-ux3-1 and D-ux3-2):

- **One dialog.** When an action is protected, one dialog asks for your password; your passkey prompt follows by itself
  (no "Next", no second button). The action you started then completes by itself: no second click.
- **Never twice.** Sealing the opening balance, correcting an opening piece, voiding a scrap purchase, correcting a
  supplier order and a large rate change already ask for your password in their own form: that password now also
  opens the window, so no second password dialog follows. Two protected requests at the same moment share one dialog.
- **Once per flow.** Confirming the karats, a new branch, a new user, an advance or a repayment ask **at the start**
  (before you type anything) when less than half of the window is left, so the steps that follow do not interrupt you.
- **15 minutes.** One confirmation now covers every protected action for 15 minutes (was 5). You can still change it
  (Settings › Security, 1–30 minutes).
- **Nothing became less protected.** The same 20 actions always ask; five more ask in one case only (a role or branch
  change, a sale cancellation above your amount, a new passkey, new recovery codes); these five are now written in the
  protected list too. The General Manager must still have a passkey.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| New tests | `ux3-reauth` (both projects): every place that can ask maps to a declared route (a new one fails the build); with an expired window none of the 78 other routes asks; each of the five asks in its case only; the window with a fixed clock (exactly 15:00 still open, 15:01 closed, the setting followed); `GET /auth/reauth`; one prompt shared by parallel requests. Every test file now fails if any route asks without being declared |
| REH-1 | 329 checks (was 327): the window is open for 15 minutes after the first confirmation; the seal with an expired window asks the password once; an expired window at "New user" is one dialog, the passkey by itself, then the form, with no second click |
| Browser scripts | passkeys 34 (the new recovery codes appear with no second click), openings, corrections, prices, states, add piece |

## B. Walk-through

1. **Settings › Security**: "Password re-confirmation valid for (minutes)" shows **15**.
2. Sign out and sign in again (password, then your passkey).
3. **Users › New user**: one dialog asks for your password. Type it, press **Confirm**: your passkey prompt opens by
   itself; confirm it. The New user form opens. Close it.
4. **Branches › New branch**: no dialog this time (the window is open). Close it.
5. **Prices**: change a selling rate slightly and save: no dialog.
6. **Opening balance** (a draft, if you have one): **Seal** asks your password and your passkey in its own dialog,
   once. (Or wait 15 minutes and do step 5 again: one dialog, then the rate is saved without pressing Save again.)
7. Open two tabs, wait for the window to pass, then save something in each tab at about the same time: each tab shows
   its own dialog once; in one tab, two quick saves show one dialog.

## C. Questions for you (nothing was changed for them)

- **Q1.** Count a sign-in made with password **and** passkey as the start of the window, so the first protected action
  right after signing in (step 3 above) does not ask again? It changes when the window starts, not which actions are
  protected.
- **Q2.** Could these leave the protected list (they stay protected until you say so): the logo upload and removal
  and the sign-in tagline (branding only), and marking a piece damaged or returned (`POST /inventory/items/:id/adjust`,
  which moves no money)?
