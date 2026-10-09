# Manual acceptance: POS-FIXES (LOCK-1, SEC-2, FIX-2, FIX-1, REM-4)

For the owner, about 25 minutes. Engineering ran section A. Section B is a walk-through in a GitHub Codespace from the
Windows laptop's browser.

What changed:

- **Security lock is visible (LOCK-1).** When an account is security-locked, its managers see a notice first in the
  notice area. The person who locked their own account sees why on the sign-in page, in that tab only.
- **Voids and price changes (SEC-2).**
  - Every cancellation asks for the password again. The amount is in Settings › Sales, default 0; only the General
    Manager can raise it.
  - Any price changed at the counter needs one reason per sale. The reason is kept for managers and never printed.
  - Changing a piece's price needs a reason.
- **Bank transfer reference (FIX-2).** A bank-transfer sale needs its reference. The reference is:
  - cleaned up as typed (Arabic digits become ordinary digits);
  - checked for duplicates in the branch;
  - printed on the invoice;
  - shown on the sale and in Cash › "Bank-transfer sales".
- **Transfers (FIX-1, REM-4).**
  - The branch manager sends the POS cart with "Transfer to branch", below "Complete sale". The courier's name is
    required, and it is all or nothing.
  - The General Manager keeps "New transfer" on the Transfers screen, under the same rules.
  - Nothing else starts a transfer: the Inventory "Select & transfer" view is gone.

Plan: `docs/plans/POS-FIXES.md` (with the owner's answers at the top). Decisions: D-lock-1, D-sec2-1, D-sec2-2,
D-fix-1, D-fix-2 and D-rem4-1 (`docs/decisions.md` §19). Three additive migrations: 0017 (price-change reason), 0018
(bank-reference check, after a guard) and 0019 (courier name).

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run typecheck`: lockfile, Hasad footprint, migrations (0017–0019 checked), drizzle, test imports, assets, four packages | passed |
| Backend tests, both projects | 1,647 passed, 3 skipped: PGlite 804, PostgreSQL 846 (3 skipped); new: `lock-1`, `sec-2`, `fix-2`, `fix-1`, and the PostgreSQL races in `pg/concurrency` |
| `npm run build`, `npm run i18n:check` | passed |
| REH-1 rehearsal (production mode, real PostgreSQL) | `REHEARSAL PASSED: 162 checks.` |
| `node scripts/e2e-print.mjs` | 47 checks passed |
| `node scripts/e2e-passkeys.mjs` | 33 checks passed (mode on), 3 (mode off) |
| `node scripts/e2e-states.mjs` | 52 checks passed |
| `node scripts/capture-ui-kit.mjs` | 24 checks passed |

**What the tests prove, for each of the owner's conditions:**

| Condition | Test |
|---|---|
| A lock is revealed only to the person who just reported it, in that tab | e2e-passkeys: the note appears in that tab, but not in another browser or another tab of the same browser |
| A locked account and an unknown username answer identically | `lock-1.test.ts`: same status and body, no cookie, one password-hash computation each (same timing class), one audit row each |
| The lock notice comes first; a branch manager sees only their branch; a cashier sees none | `lock-1.test.ts`, e2e-states (order of six forced notices), REH-1 |
| Void threshold: default 0, GM only, audited; above it needs the password, below not | `sec-2.test.ts`: covers 0, at the amount and above it, an expired window, another branch (ordinary 403 first), a cashier, the same key after the dialog, and a replay |
| The price-change reason is in the audit log and on the sale, never printed | `sec-2.test.ts`: the original print and the reprint payloads; e2e-print: the A4 page and the 72 mm receipt |
| The audit text has no cost | `sec-2.test.ts`: `SALE_PRICE_CHANGED` holds prices only; a branch manager reading the audit log sees no cost |
| Bank reference normalized, then checked for duplicates in the branch among unvoided sales | `fix-2.test.ts`: Arabic-Indic and Persian digits, spaces and case; a duplicate answers 409 until confirmed, with the same key; other branches and cancelled sales do not count |
| The bank database check is safe for old rows | `fix-2.test.ts`: migration 0018 stops on a bank sale without a reference and changes nothing; a clean upgrade keeps Hasad and still lets old bank sales be voided and reprinted |
| The reconciliation still adds up (SPEC §18.10) | `ledger.test.ts`: for every branch and day, "Bank-transfer sales" adds up to the bank-transfer sales line |
| Transfer: rows locked; a piece no longer available means no change; Idempotency-Key required | `fix-1.test.ts`; `pg/concurrency.test.ts` on real PostgreSQL: two transfers, or a sale and a transfer, racing for one piece, and exactly one wins |
| The cashier never sees "Transfer to branch"; no other start point | e2e-states, REH-1 (also the Inventory and Transfers screens) |
| Allow, deny and cross-branch tests of the changed routes | the generated route-matrix tests (`phase1b.test.ts`), with the courier in the sample body |

## B. In a Codespace, from the Windows browser (about 20 minutes)

On GitHub: switch to the branch `claude/hopeful-sagan-lehxyp`, then **Code → Codespaces → Create codespace on
claude/hopeful-sagan-lehxyp**. Wait for the dependencies to install, then in the terminal:

```bash
npm run build
PGLITE_DIR=.data/sample npm run dev:sample        # prints the sample accounts and passwords once
PGLITE_DIR=.data/sample TWO_FACTOR_REQUIRED_ROLES_INITIAL= npm start
```

Open port **4000**. The sample has two branches, A and B.

| # | Who | Check | Expected |
|---|---|---|---|
| 1 | Branch manager A | **POS**: add 2 pieces | "Transfer to branch" sits below "Complete sale" |
| 2 | Branch manager A | Click it, choose Branch B, leave the courier empty | "Send transfer" stays disabled. Type a name, send: "Transfer … sent: 2 pieces in transit", and the cart is empty |
| 3 | Branch manager A | **Transfers** | One transfer with both pieces and the courier's name. No "New transfer" or "Select pieces" button |
| 4 | Branch manager A | **Inventory** | A table only; no "Select & transfer" view |
| 5 | Cashier A | **POS**: add a piece | No "Transfer to branch" button |
| 6 | Cashier A | Choose **Bank transfer** | A reference field appears; "Complete sale" is disabled until it is filled. Type `trf ١٢٣٤`: the sale records `TRF 1234` |
| 7 | Cashier A | Sell another piece by bank transfer with `TRF 1234` | "This reference is already on sale …. Record it anyway?" Confirm: recorded |
| 8 | Cashier A | Give a discount on a line | A "Reason for the price change" field appears and is required. The printed invoice does not show the reason |
| 9 | Branch manager A | **Sales** › the discounted sale | "Price changed at sale · Reason: …" (internal) |
| 10 | Branch manager A | Cancel that sale | The dialog says it will ask for the password; the password prompt appears; then the sale is cancelled |
| 11 | Branch manager A | **Cash** | Under "Bank movements": "Bank-transfer sales (n)". Open it: both sales with `TRF 1234`, adding up to the bank-transfer sales line |
| 12 | General Manager | **Settings › Sales** | "Ask for the password to cancel a sale above" = 0. Raise it, save (password): cancelling a smaller sale no longer asks |
| 13 | General Manager | **Transfers › New transfer** | Courier's name required; it sends like the POS transfer |

**Security lock.** It is set only by "This wasn't me" on a sign-in made with a recovery code, which the sample
database (no passkeys) cannot produce in a few clicks. The proof is in two outputs:

- `e2e-passkeys`: the reporter's note in that tab only;
- REH-1, section LOCK-1: the managers' notice first, the Users badge, the ordinary sign-in refusal, and the operator
  unlock (`npm run ops -w @jerp/backend -- unlock-security-lock --username <user> --confirm`).

## C. Known and accepted

- **A locked General Manager account can only be unlocked by the operator command on the server**
  (`unlock-security-lock`). No screen can lift a security lock, not even another General Manager's.
- **Every cancellation now asks for the password** until the General Manager raises the amount. The window
  (default 5 minutes) covers several cancellations in a row.
- **Two sales paid by one bank transfer** are allowed after the warning; the confirmation is in the audit log.
- **Databases with trial data from before FIX-2** (a bank sale without a reference) do not upgrade: migration 0018
  stops and changes nothing. They are recreated, as for REM-5 (`docs/DEPLOYMENT.md`).
- **A transfer refused because a piece was sold meanwhile** sends nothing. The dialog names the piece and offers
  "Remove from the cart".
- **The Transfers table is wider than a 1366×768 screen** (it already was; the new Courier column adds one more), so
  Status needs a sideways scroll there. UI-C removes the horizontal overflow (BACKLOG UI-C).
- **The sale-detail screenshot was an error page in the UI-A2 set**: the capture script asked `/api/sales?limit=1`,
  which the server refuses. It is fixed here (a bank-transfer sale is shown).
- **Screens are not restyled.** The POS, Cash and Transfers keep their current look; UI-B and UI-C restyle them once.
