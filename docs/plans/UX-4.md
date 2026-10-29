# UX-4: the opening balance as a first step on the home screen (plan)

Interface only: no new permission, no money or stock rule, no migration. The owner, on day one, had to remember a long
order (branch, karats, rates, users, seal the opening) and did not find the opening balance; a DRAFT opening is not
stock, so the point of sale looked empty and he took it for a bug.

## 1. Today

- `GET /setup/status` (General Manager, `settings.manage`) gives five steps, each `done` from server data: karats
  (confirmed), rates (every allowed karat has a NEW and, with computed prices, a USED selling rate, and a scrap rate),
  branch (one active), staff (an active branch manager and cashier), fund (every active branch has an advance into its
  drawer). The GM home shows them (`FirstSteps.tsx`) until all are done, then hides them.
- The rates link goes to Settings, but the rates are on the **Prices** page since PRC-1 (a wrong link).
- The opening balance is not a step. A draft opening is not stock; nothing on the home or the point of sale says so.

## 2. Changes

1. **Order** (as asked): branch → karats → rates → users → **opening balance** → fund the branch (CSH-2's step is
   kept, last: the drawer is needed for the first sale, the opening for the first piece).
2. **Opening balance step** (`key: 'opening'`), only for a user who can use the screen (`opening.manage`, the General
   Manager), with a `state`:
   - `NOT_STARTED`: no opening yet → "Enter the opening balance", link to Opening balance.
   - `DRAFT`: a draft exists → "Seal the opening balance", **"Not in stock yet: seal it so the cashier can sell it."**,
     link to that draft (`openingId`).
   - `SEALED`: no draft, at least one sealed → done.
   **Done** = `SEALED`, or `NOT_STARTED` while pieces already came in another way (a supplier order or a bought piece:
   the opening is for stock held before the system, so it is not forced on a shop that started without one; this
   also keeps an existing installation's home as it is). A draft is never done: it always shows until sealed.
   **Question Q1 for the owner.**
3. **Texts** short (UX-2 rules): one line per step, no paragraph; the closing paragraph under the list goes.
4. **Rates link** → the Prices page.
5. **Point of sale**, no stock and no filter, when the branch has a draft opening: one line, "The opening balance of this
   branch is not sealed yet."; the General Manager also gets a link to it. Needs one response field:
   `GET /inventory/items` adds `openingDraft` (true/false) when the page is empty and a branch is given (computed only
   then).
6. Response fields: `steps[].state`, `steps[].openingId` (setup status), `openingDraft` (items list): classified, REH-1
   updated in the same commit.

## 3. Tests

- Backend: the six steps in order; the opening step absent for a role without `opening.manage`; its three states and
  `done` (no opening and no stock → not done; stock from a supplier order → done; a draft → not done, with its id;
  sealed → done); `complete` follows; `openingDraft` true only for an empty page of a branch with a draft.
- REH-1: the six steps on an empty database; the rates link opens Prices; the opening step after a draft (DRAFT, link,
  the line) and after the seal (done); the point of sale of a branch with a draft and no stock shows the line and,
  for the General Manager, the link.
- `docs/acceptance/UX-4.md`: a manual run from a fresh database (bootstrap the General Manager, follow the list to the
  end).

## 4. Commits

c0 plan · c1 server: steps, order, opening state, `openingDraft`, tests, docs · c2 screens: first steps and the point of
sale line, REH-1 · c3 acceptance, BACKLOG, `verify --full`.

## 5. Question

- **Q1.** Should the opening step stay open until an opening is sealed even when the shop already received pieces from
  a supplier order (then a shop with no stock before the system would always see it until it seals an opening)? As
  built: a received supplier order or bought piece counts as "no opening needed"; a draft always stays open.
