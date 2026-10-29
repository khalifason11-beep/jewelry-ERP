# Manual acceptance: UX-2 (less explanatory text, no technical codes)

For the owner, about 15 minutes, in a desktop browser (Arabic). Engineering ran section A.

What changed (your request of 2026-10-29, plan `docs/plans/UX-2.md`, decision D-ux2-1): the screens say less.
Explanations that repeat the title, and anything describing how the system works inside (status and event codes,
"recorded as … in the audit log", hashing), are gone. Background that is useful once sits behind a small **"?"**
(click or tap it; Escape closes it). Warnings about money, irreversible actions (seal, cancel, void, correct, transfer)
and the security texts you need to continue are unchanged. Permissions show in Arabic; their codes only for you, in
a closed section. Nothing in the business, money or permission rules changed.

## A. What engineering ran (all green on the last commit)

| Gate | Result |
|---|---|
| `npm run verify -- --full` (Node 20) | summary in the report |
| UI kit | 68 checks: the "?" opens with Enter or Space, closes with Escape (only the help, not the dialog around it) or a click outside, a tap toggles it, a field's name is unchanged, axe |
| REH-1 | 327 checks (was 299): permission names in Arabic and no code visible until the General Manager opens "Technical codes"; none for the branch manager; the cashier's four screens and eight General Manager screens show no internal code (both languages) |
| Browser scripts | print, states, passkeys (on/off), add piece, prices, corrections, openings |

## B. Before and after, by screen (short)

| Screen | Before | After |
|---|---|---|
| Point of sale | sale-done "Items are now SOLD and removed from available stock"; long hold, clear-cart and transfer texts; discount-reason note under the field | no sale-done subtitle; "Find it under Held sales"; "The cart will be cleared"; "Nothing is sold: the pieces are in transit…"; the note behind a "?" |
| Buy a piece / Scrap | page and payment subtitles; "now AVAILABLE for sale" | no subtitles; "Piece … is on sale"; pool and tolerance behind a "?" |
| Own sales, My activity, security page | subtitles | none; "never leaves this computer" behind a "?"; the phone how-to is a closed section |
| Users | "Accounts, roles…"; "Roles are data, not code"; English codes `sales.create`, `pos.access`…; "salted hash"; "recorded in the audit log" | "Passwords can be reset, never viewed"; Arabic permission names; codes in a closed "Technical codes" (General Manager only) |
| Inventory, piece page | "Item-level inventory…"; card subtitles; "Recorded as PRICE_CHANGED…"; "Creates a ledger movement and an INVENTORY_ADJUSTMENT…" | no subtitles; "Past sales keep their original price" |
| Supplier orders | "PURCHASED → RECEIVED → AVAILABLE…"; "now AVAILABLE"; long settlement text | gone; "in stock"; "Settled only with broken scrap from this branch's pool"; the computed-price rule behind a "?" |
| Sale page, cancel | "VOIDED… AVAILABLE via a RETURN movement" | "The sale stays on record as cancelled; its pieces go back to stock" (the Hasad note unchanged) |
| Transfers | "Two-step… (TRANSFERRED)"; "AVAILABLE in your branch (TRANSFER_IN)" | no subtitle; "Pieces received in your branch" |
| Opening balance | long page subtitle; typing hint | both behind a "?"; the draft/sealed texts and the seal checklist unchanged |
| Cash | page and card subtitles | none; the two formulas behind a "?"; the Hasad note unchanged |
| Prices | page subtitle; mode example and rule under the fields; hints; "Recorded as …" toasts | none; example and hints behind "?"; plain "saved" toasts |
| Settings | "Business rules the client will confirm…"; long hints; printer steps open; "Recorded as SECURITY_SETTING_CHANGED" | none; hints behind "?"; printer steps a closed section; second-factor texts unchanged |
| Sessions, audit log, branches, reports | page subtitles; "Recorded as SESSION_REVOKED" | none; the monitoring note behind a "?" |
| Sign-in, change password | "Use the account assigned…"; "Argon2id hashes…"; a long temporary-password paragraph | gone; one line with the password rules |
| Locked-account notice | "(operator console: unlock-security-lock)" in the sentence | the sentence without it; the command behind a "?" |

## C. Walk-through

**General Manager** (with your passkey):

1. **Users**: the role cards list permissions in Arabic (e.g. نقطة البيع، البيع). Open **الرموز التقنية** under a card:
   the codes appear; close it.
2. **Settings**: no paragraph under the title; press a **"?"** beside "Scrap price tolerance": the explanation opens;
   press Escape. Open **Setting up the printer on the shop PC**: the four steps.
3. **Prices**: the "?" beside **Selling prices** shows the example. Change nothing.
4. **Cash**: the "?" beside **Expected cash now** explains where the figure comes from.
5. **Opening balance**, **Inventory**, a **piece**, a **supplier order**: no codes such as AVAILABLE, RETURN or
   PRICE_CHANGED anywhere.

**Branch manager**:

6. **Users**: Arabic permission names, no "Technical codes".
7. **Sales** → cancel a sale (or open the dialog and Cancel): the dialog says the sale stays on record as cancelled
   and its pieces go back to stock.

**Cashier**:

8. **Point of sale**: sell a piece; the sale-done dialog shows the invoice without an explanation line. Hold a cart:
   "Find it under Held sales".
9. **Buy a piece from a customer**: no paragraph under the title.

## D. Questions for you

None open. If a text you relied on is gone, say which screen: it can come back as a "?".
