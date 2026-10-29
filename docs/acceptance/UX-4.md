# Manual acceptance: UX-4 (the opening balance as a step on the home screen)

For the owner, about 20 minutes, in a desktop browser, from a **fresh database**. Engineering ran section A.

What changed (your request of 2026-10-29, plan `docs/plans/UX-4.md`, decision D-ux4-1):

- The General Manager's home lists **six first steps in this order**: create the first branch, confirm the karats,
  set the gold rates (every karat, new and used, and the scrap rate), add the branch manager and a cashier, **enter
  the opening balance**, fund the branch. Each is ticked from what is really in the system; each links to its screen;
  the list disappears when all are done.
- The opening balance step shows its three states: **not started** (link to Opening balance), **draft** ("Not in
  stock yet: seal it so the cashier can sell it", link to the draft), **sealed** (ticked). Only the General Manager
  sees it. If pieces came in another way first (a supplier order or a piece bought from a customer), the step counts
  as not needed; a draft always stays on the list until it is sealed (question Q1).
- The rates step now opens the **Prices** page (it used to open Settings).
- An empty point of sale of a branch whose opening is still a draft says so in one line; the General Manager also
  gets a link to the opening balance.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| New tests | `setup` (the six steps in order; the opening step's states; a supplier order closes "not started"; a draft does not; the step only with the opening permission), `ux4-first-steps` (the point-of-sale flag only for an empty page of a branch with a draft; never another branch's) |
| REH-1 | 336 checks (was 329): the six steps in order on an empty database; the rates link; the draft step with its link; gone after the seal; the empty point of sale of a branch with a draft (General Manager with the link, cashier without) |

## B. From a fresh database

1. **Bootstrap** the General Manager on the server (`npm run bootstrap` as in `docs/DEPLOYMENT.md` §3), sign in with
   the one-time password, set your password, register your passkey and save the recovery codes.
2. **Home**: "First steps", 0 of 6 done, in this order: branch, karats, rates, users, **opening balance**, fund.
3. **Create the first branch** (link → Branches → New branch; one dialog asks your password and passkey once). Back
   home: step 1 ticked.
4. **Confirm karats** (on the home). Step 2 ticked.
5. **Set rates** → the **Prices** page: the new-piece and the used-piece rate of every karat, and the scrap rate.
   Step 3 ticked.
6. **New user** → a branch manager and a cashier for the branch. Step 4 ticked.
7. **Opening balance** (step 5 says "Enter the opening balance") → start the branch's opening, type or import a few
   pieces. Back home: the step now says **"Seal the opening balance – Not in stock yet: seal it so the cashier can
   sell it"**, with **Open the draft**.
8. Sign in as the **cashier** in another browser: the point of sale is empty and says **the opening balance of this
   branch is not sealed yet** (no link). Sign out.
9. As the General Manager: **Open the draft** → **Seal** (your password and passkey, once). Home: step 5 ticked.
10. **Record an advance** (step 6) → Cash › Funding, an advance into the branch's drawer. The first-steps list
    disappears.
11. The cashier's point of sale now shows the opening pieces for sale.

## C. Questions for you

- **Q1.** Should the opening step stay open until an opening is sealed even when pieces already came from a supplier
  order? As built, a supplier order or a bought piece counts as "no opening needed" (so a shop that started with no
  stock is not asked forever), and a draft always stays open until sealed.
