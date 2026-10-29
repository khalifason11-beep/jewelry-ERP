# UX-3: fewer passkey / re-authentication prompts (plan)

The owner: the system asks for the passkey "on every add operation and at every step". Interface and window only:
**no route leaves the protected list, no new way to skip a passkey, the rule that the General Manager must have a
passkey is unchanged.** No migration.

## 1. Audit

### (a) Every route with `reauth: true` and the action that triggers it (20)

| Route | Screen action |
|---|---|
| `DELETE /auth/passkeys/:id` | Security page: remove a passkey |
| `PUT /security/second-factor` | Settings › Second factor: save |
| `POST /setup/allowed-karats` | Home, first steps: confirm the karats |
| `POST /gold-rates` | Prices: save the selling rates (new / used) |
| `POST /scrap-rates` | Prices: save the scrap rates |
| `PUT /settings` | Settings: Save on any card; Prices: save how prices are worked out |
| `POST /branding/logo`, `DELETE /branding/logo` | Settings › Branding: upload / remove the logo |
| `POST /branches`, `PATCH /branches/:id` | Branches: New branch, Edit |
| `POST /users`, `POST /users/:id/reset-password` | Users: New user, Reset password |
| `POST /inventory/items/:id/adjust` | Piece page: Adjust (damaged, returned, back in stock) |
| `POST /scrap-purchases/:id/void` | Scrap: Void a purchase (MIS-1) |
| `POST /purchases/:id/corrections` | Supplier order: Correct a piece (MIS-1) |
| `POST /openings/:id/seal` | Opening balance: Seal |
| `POST /openings/:id/pieces/:itemId/correction` | Piece page: Correct this opening piece |
| `POST /funding/advances`, `POST /funding/repayments`, `POST /funding/:id/correct` | Cash › Funding: advance, repayment, correction |

### (b) Routes **without** `reauth: true` that can open the dialog

Found by reading every call of the step-up check (`requireRecentReauth`, `reauthRequired`):

| Route | When | Where |
|---|---|---|
| `PATCH /users/:id` | the role or the branch changes (a name or phone does not) | `routes.ts` |
| `POST /sales/:id/void` | the sale's total is above `sales.voidReauthAboveAmount` (default 0 = every void, D-sec2-1) | `routes.ts` |
| `POST /auth/passkeys/register/options`, `…/verify` | adding a passkey (password); replacing needs the passkey too | `passkeys.ts` |
| `POST /auth/recovery-codes` | new recovery codes (password; replacing a set needs the passkey too) | `passkeys.ts` |

Each is a deliberate protection (D-1a-8, D-sec2-1, D-2fa-7), but the route matrix does not say so: the protected list
the owner reads is incomplete. **Fix (nothing weakened):** the matrix gets `reauthWhen: '<condition>'` on these five
routes, so the list is complete; the step-up check refuses to run for a route that declares neither (an internal error
in tests and a logged error in production); a test lists every call site of the check and its route, and a second test
calls every route without `reauth`/`reauthWhen` with a session whose window is stale and asserts none answers
`REAUTH_REQUIRED`. On the screen side the dialog opens only from a `REAUTH_REQUIRED` answer (or the new flow start, §2);
the passkey prompt is also called directly by the seal and opening-correction dialogs (both protected routes) and by
sign-in and the security page.

### (c) One action, more than one prompt

| Case | Today | Fix |
|---|---|---|
| Seal the opening; correct an opening piece | the dialog asks the password and the passkey; the route also needs the window, so a stale window opens the re-auth dialog for the password **again** | the typed password opens the window first (`POST /auth/reauth`), then the action: one password, one passkey |
| MIS-1 corrections (void a scrap purchase, correct an order); rate change above the guard | the form asks the password; the route needs the window: password twice | same |
| The re-auth dialog itself | password → Next → "Use my passkey": two steps | **one step**: password, Confirm, the passkey prompt follows at once (a "Use my passkey" button only if the browser refuses to open it without a click) |
| Two protected requests at the same moment | the second dialog cancels the first: the first action fails and must be redone | one dialog for both; both retried after it |
| After success | the request is retried once, automatically (kept) | kept; tested |
| Re-render, query retry | GET requests never need the window; mutations are not retried by the query library | none needed (checked) |
| A setup flow (karats, rates, branch, users) | each protected step asks if the 5-minute window lapsed meanwhile | the flow asks **once at its start** when less than half the window is left, so its steps run inside one window; default window 15 minutes |
| Right after a sign-in with password and passkey | the first protected action asks both again | **question Q1** (not changed) |

## 2. Changes

1. **Combined dialog** (`ReauthDialog.tsx`): one step; one pending promise shared by every request that needs it; the
   retry after success stays automatic (`api.ts`).
2. **Forms that already ask the password** (seal, opening correction, MIS-1 corrections, rate guard) open the window
   with it before the action.
3. **Flow start**: `GET /auth/reauth` (new, `self`) answers whether the password and passkey are still fresh and until
   when; `ensureFresh()` opens the dialog at the start of a flow when less than half the window is left. Used by: the
   first steps (karats, rates), New branch, New user, the Prices page save, Cash › Funding, the opening seal.
4. **Window logic** in one pure function with the clock passed in (`freshness(at, windowMinutes, now)`), tested
   without the wall clock.
5. **Default window 15 minutes** (range 1–30 unchanged, editable by the General Manager): `shared/src/settings.ts`,
   D-ux3-1. An installation that never saved the security card gets 15 on upgrade; one that saved it keeps its value.
6. Settings text (the window hint) and `docs/DEPLOYMENT.md`.

## 3. Questions for the owner (nothing changed for them)

- **Q1.** Count a sign-in made with password **and** passkey as the start of the window, so the first protected action
  right after signing in does not ask again? (The factors were just checked; it changes when the window starts, not
  which routes are protected.)
- **Q2.** Routes that could leave the protected list (they stay protected until you say so): the logo upload/removal
  and the sign-in tagline (branding only), and `POST /inventory/items/:id/adjust` (a branch manager marking a piece
  damaged, which moves no money).

## 4. Commits

c0 plan · c1 matrix `reauthWhen` + guard + audit tests · c2 window logic with an injected clock + `GET /auth/reauth` +
default 15 + docs · c3 combined dialog, shared pending, forms open the window with their password, flow start; REH-1 and
the browser scripts · c4 acceptance, decisions, `verify --full`.
