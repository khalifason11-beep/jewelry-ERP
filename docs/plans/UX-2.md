# UX-2: less explanatory text, less technical jargon (plan)

Interface only. No business, money or permission rule changes; no route, setting, response field or migration. Every
string stays in the i18n resources (`i18n-ar.ts`; `i18n-en.ts` only for code labels); nothing client-specific is
hard-coded.

## 1. Rules applied (owner, 2026-10-29)

| Decision | When |
|---|---|
| **K** keep | a warning about money; an irreversible action (seal, void, cancel, close/count drawer, transfer, correction); a security or re-authentication explanation the user needs to proceed; an error; an empty state that says what to do |
| **S** shorten | the point is needed but the sentence is long; the new text is given |
| **T** move to a "?" | useful background, not needed on every visit: a small "?" button beside the title or label opens it (keyboard: Tab, Enter/Space, Escape; works on touch) |
| **R** remove | restates the label or the screen; describes how the system works inside (audit event names, ledger movements, status codes, hashing) |

Permission codes (`sales.create`, `pos.access`…) never show in the normal interface: the Users page shows Arabic
names; the General Manager can open a closed "Technical codes" section (closed by default; the branch manager, who
can view the page, does not get it). The cashier's screens (point of sale, own sales, buy a piece, own security
page) get the least text.

**Out of this item:** the first-steps texts (`FirstSteps.tsx`) are rewritten by UX-4 under these rules; the
re-authentication dialog texts (`ReauthDialog.tsx`, the window hint in Settings) are reworked by UX-3. Report
descriptions and every server message (errors, audit descriptions) are left as they are. Printed documents keep
their text (the recovery-code sheet and the test-print ruler are instructions on paper).

## 2. The audit (every page and component)

Inventory: every `t(…)` string of 50 characters or more, every page/card/dialog subtitle, every field hint and every
string naming an internal code (script in the c0 notes: 242 + 79 subtitles, overlapping). Short labels, buttons,
column names and numbers are not listed. Line numbers are at `7868eba`.

### Shell, sign-in, no-access (all roles)

| Screen · where | Text (start) | Decision |
|---|---|---|
| No access (`App.tsx:69`, `States.tsx:98`, report) | Your role does not include this module… | K |
| Not found (`App.tsx:82`) | The address may be mistyped… | K |
| Top bar gold price (`TopBar.tsx:47`, a hover title) | Reference gold price per gram… | K |
| Top bar attention list error (`TopBar.tsx:135`) | The list could not be loaded… | K |
| Sign-in (`LoginPage.tsx:67`) | Use the account assigned to you by the General Manager. | R |
| Sign-in (`LoginPage.tsx:90`) | Passwords are stored as Argon2id hashes… | R (internal) |
| Sign-in locked account, passkey step, recovery hint (`LoginPage.tsx:54,154,167`) | … | K (security) |
| Change password (`ChangePasswordPage.tsx:53`) | Your account uses a temporary password… At least 10 characters… | S → "Choose a personal password to continue: at least 10 characters, with letters and digits, not containing your username." |
| My activity (`MyActivityPage.tsx:56`) | The same information administrators see… | R |
| Notices: security-locked account (`Notices.tsx:52,53`) | …until the system operator unlocks it on the server (operator console: unlock-security-lock). | S → drop the console command from the sentence; the command goes to a "?" (for whoever passes it on to the operator) |
| Notices: sign-in alert, GM second factor off, recovery-code lock (`Notices.tsx:72,100,193–201`) | … | K (security) |
| Attention items (`Attention.tsx`, all) | transit hours, cash count, gold debt, backups, locked accounts, ledger drift, rates, bank below zero, passkey | K (each is a warning about money, stock or security) |

### Cashier screens (least text)

| Screen · where | Text | Decision |
|---|---|---|
| POS, print failed (`PosPage.tsx:116`) | Printing failed. The sale is saved… | K |
| POS, no rate (`PosPage.tsx:161`) | No selling rate is set for this karat yet… | K |
| POS, hold toast (`PosPage.tsx:265`) | Find it under "Held sales" to resume. Items are not reserved while held. | S → "Find it under “Held sales”." (the "not reserved" warning stays in the Held sales dialog) |
| POS, no branch / empty stock (`PosPage.tsx:324,338`) | … | K |
| POS, split / reference / reprice errors (`PosPage.tsx:493,514,519`) | … | K |
| POS, discount reason hint (`PosPage.tsx:533`) | Kept in the audit log for managers. Never printed on the invoice. | T |
| POS, duplicate bank reference dialog (`PosPage.tsx:595,596`) | title K; subtitle "One bank transfer can pay two sales. Recording it again is noted in the audit log." | T (subtitle) |
| POS, clear cart dialog (`PosPage.tsx:621`) | The cart will be cleared. Nothing has been recorded yet, so inventory is unaffected. | S → "The cart will be cleared." |
| POS, held sales dialog (`PosPage.tsx:632`) | Held carts are stored on this device and do not reserve stock. | K (stock risk) |
| POS, sale done (`PosPage.tsx:670`) | Items are now SOLD and removed from available stock. | R |
| POS, sale toast (`PosPage.tsx:227`) | {total}: {n} item(s) marked SOLD | S → "{total}: {n} item(s) sold" |
| POS, transfer dialog (`PosPage.tsx:740`) | One transfer for the whole cart. Nothing is sold; the pieces are in transit until… | S → "Nothing is sold: the pieces are in transit until the receiving branch confirms." |
| POS, transfer toast / refusal (`PosPage.tsx:724,753`) | … | K |
| Buy a piece, page subtitle (`ScrapPage.tsx:113`, both roles' versions) | Buy gold from customers… / A piece in good condition… | R |
| Buy a piece, payment card (`ScrapPage.tsx:406`) | The customer is paid now: from the drawer, by bank transfer, or part of each. | R (the form shows the choices) |
| Buy a piece, done toast (`ScrapPage.tsx:393`) | Piece {code} is now AVAILABLE for sale. Paid {amount}. | S → "Piece {code} is on sale. Paid {amount}." |
| Buy a piece, price and split errors (`ScrapPage.tsx:553,565,566`) | … | K (money) |
| Own sales list (`SalesPages.tsx:133`) | Normal jewelry sales. Click an invoice for items, cost and profit. | R |
| Security page, own (`SecurityPage.tsx:314`) | Passkeys, recovery codes and recent sign-ins… | R |

### Stock screens (branch manager, General Manager)

| Screen · where | Text | Decision |
|---|---|---|
| Inventory list (`InventoryPages.tsx:155`) | Item-level inventory. Each piece has its own ID… | R |
| Inventory empty (`InventoryPages.tsx:66`) | Receive a supplier order or buy scrap… | K |
| Piece: unknown cost (`InventoryPages.tsx:280`) | Cost: unknown (opening balance)… | K (money) |
| Piece: lifecycle / ledger cards (`InventoryPages.tsx:315,342`) | Every status change… / Stock movements recorded… | R |
| Piece: price dialog (`InventoryPages.tsx:376`) | Recorded as PRICE_CHANGED in the audit log. Past sales keep their original price. | S → "Past sales keep their original price." |
| Piece: adjust dialog (`InventoryPages.tsx:392`) | Creates a ledger movement and an INVENTORY_ADJUSTMENT audit event. | R |
| Piece: no rate (`InventoryPages.tsx:407`) | No selling rate is set for this karat yet… | K |
| Stock weight card (`StockWeight.tsx:29`) | Sellable pieces (available) plus the broken-scrap pool | T |
| Types and products page (`CatalogPage.tsx:45`) | What you stock. A type groups pieces… | R |
| Types and products empty (`CatalogPage.tsx:70,87`) | … | K |
| Deactivate type / product (`CatalogPage.tsx:142,143`) | …Pieces already in stock still sell. | K |
| Rename (`CatalogPage.tsx:188`) | Past sales and invoices keep the old name… | K |
| New type / product dialogs (`Catalog.tsx:108,147`) | A kind of piece, such as rings… / A design you stock… | T |
| Supplier orders list (`PurchasesPages.tsx:118`) | Stock received from suppliers. Each line creates… | R |
| New order dialog (`PurchasesPages.tsx:298`) | Pieces are created as PURCHASED → RECEIVED → AVAILABLE with a PURCHASE ledger movement. | R |
| New order: gold for gold (`PurchasesPages.tsx:351`) | Gold for gold: the supplier is owed… | K (money) |
| New order: open debt, duplicate reference (`PurchasesPages.tsx:358–360,369,745`) | … | K |
| New order: computed price (`PurchasesPages.tsx:375`) | No selling price to type: each piece sells at… | T |
| New order: total weight (`PurchasesPages.tsx:455`), piece weight error (`:212`) | … | K |
| Order done toast (`PurchasesPages.tsx:274`) | {n} piece(s) now AVAILABLE: {codes} | S → "{n} piece(s) in stock: {codes}" |
| Order page: pieces card (`PurchasesPages.tsx:554`) | Current status shows where each piece is now | R |
| Order page: corrections card (`PurchasesPages.tsx:637`) | The order as recorded is kept… | R |
| Order correction dialog (`PurchasesPages.tsx:717,730,734`) | Now {amount}. … The supplier's gold debt does not change. / hints | K (money) / T (`:730`) / K (`:734`) |
| Order: settlements card (`PurchasesPages.tsx:761`) | Gold owed to the supplier is settled only with broken-scrap weight from this branch's pool. Never with cash or bank. | S → "Settled only with broken scrap from this branch's pool." |
| Settlement errors (`PurchasesPages.tsx:853,857`) | … | K |
| Scrap pool card (`ScrapPage.tsx:126`) | Weight held per karat (never an inventory item)… | T |
| Scrap: branch selector (`ScrapPage.tsx:140`) | Scrap is bought for one branch… | K |
| Scrap void dialog (`ScrapPage.tsx:239,240`) | …This cannot be undone. | K |
| Scrap price hint (`ScrapPage.tsx:456`) | Within {pct}% of the scrap rate the branch manager decides | T |
| Transfers page (`TransfersPage.tsx:62`) | Two-step inter-branch transfers… (TRANSFERRED)… | R |
| Transfers received toast (`TransfersPage.tsx:53`) | Pieces are now AVAILABLE in your branch (TRANSFER_IN). | S → "Pieces received in your branch." |
| Transfers empty, list cap, refusal (`TransfersPage.tsx:79,178,208`) | … | K |
| Opening balance page (`OpeningPages.tsx:115`) | The pieces each branch already holds on the first day… | T |
| Opening: draft / sealed (`OpeningPages.tsx:169`) | A draft is not stock yet… / Sealed on {date}… | K |
| Opening: type a piece (`OpeningPages.tsx:375`) | Enter moves to the next field… | T |
| Opening: CSV columns, import errors, empty (`OpeningPages.tsx:437,444,206`) | … | K (needed to proceed) |
| Opening: seal checklist and dialog (`OpeningPages.tsx:508–515,545,559`) | … This cannot be undone. | K (irreversible) |
| Opening correction dialog (`OpeningCorrection.tsx:127`) | The opening stays as sealed… | K |
| Opening corrections card (`OpeningCorrection.tsx:231`) | The opening stays as sealed; each correction… | R (the card lists them) |
| Sale page: items card (`SalesPages.tsx:253`) | Selling price vs item cost (purchase + making + other) | R |
| Cancel sale toast (`SalesPages.tsx:186`) | Items returned to AVAILABLE with a RETURN movement. | S → "The pieces are back in stock." |
| Cancel sale dialog (`SalesPages.tsx:340`) | The sale stays on record as VOIDED. Items go back to AVAILABLE via a RETURN movement. | S → "The sale stays on record as cancelled; its pieces go back to stock." |
| Cancel sale, Hasad note (`SalesPages.tsx:365`) | {amount} of this sale was paid through Hasad… | K (money) |

### Cash, branches, dashboards, reports

| Screen · where | Text | Decision |
|---|---|---|
| Cash page (`CashPage.tsx:89`) | Expected cash in each drawer, from the branch money ledger… | R |
| Cash: expected cash card (`CashPage.tsx:92`) | Every sale, cancellation… moves these balances. Nothing is typed in by hand. | T |
| Cash: reconciliation card (`CashPage.tsx:113`) | Opening cash + the day's cash movements = expected cash… | T |
| Cash: Hasad note (`CashPage.tsx:174`) | Hasad money is not in this branch… | K (money) |
| Funding card (`FundingPanel.tsx:75`) | What each branch owes the General Manager. An advance puts money… Only you see this. | S → "What each branch owes the General Manager." + T for the rest |
| Funding empty (`FundingPanel.tsx:114`) | Record the money you put into a branch… | K |
| Advance / repayment dialog (`FundingPanel.tsx:229,230`) | … | K (money) |
| Funding hints (`FundingPanel.tsx:276,286`) | For example: float for the drawer… / The scrap purchase… | R / T |
| Funding correction (`FundingPanel.tsx:319`) | A correction reverses the event… | K |
| Branches page (`BranchPages.tsx:36`) | Month-to-date results. Open a branch to drill… | R |
| Branch register card (`BranchPages.tsx:89`) | Branch codes are permanent… | R (said again on the code field, `:158`, which stays: K) |
| Homes (`BranchDashboardPage.tsx:186,296`, `CompanyDashboardPage.tsx:97,200`) | figures and empty states | K |
| Reports page (`ReportPages.tsx:48`) | Every report supports date range… CSV export. | R |
| Report truncated (`ReportPages.tsx:219`) | Showing the first {shown} of {total} rows… | K |

### Administration and security (General Manager; branch manager reads some)

| Screen · where | Text | Decision |
|---|---|---|
| Users page (`UsersPage.tsx:85`) | Accounts, roles and branch assignments. Passwords are managed centrally… | S → "Passwords can be reset, never viewed." |
| Users: roles card (`UsersPage.tsx:165`) | Roles are data, not code… | R |
| Users: roles card permission list | English codes `sales.create`… | **Arabic names** (§3); codes only in the GM's closed "Technical codes" |
| Users: reset / disable dialogs (`UsersPage.tsx:197,199`) | …sessions end immediately | K |
| Users: every confirm dialog | This action is recorded in the audit log. | R |
| Users: temporary password (`UsersPage.tsx:212`) | For {user}. Shown only once… | K |
| Users: temporary password (`UsersPage.tsx:217`) | The system stores only a salted hash… | R (internal; "shown only once" stays) |
| Users: edit / new dialog (`UsersPage.tsx:257`) | Changing the role or branch ends… / must set a personal password… | K |
| Sessions page (`SessionsPage.tsx:150`) | Who is signed in right now… | R |
| Sessions: shared device (`SessionsPage.tsx:99,161`) | … may indicate shared credentials… | K |
| Sessions: monitoring note (`SessionsPage.tsx:169`) | Transparent monitoring: every user can see… | T |
| Sessions: sign-out dialog (`SessionsPage.tsx:128`) | …The user will be signed out on that device. | K |
| Sessions: revoke (`SessionsPage.tsx:131`) | Recorded as SESSION_REVOKED in the audit log. | R |
| Audit log (`AuditPage.tsx:59`) | Append-only record of every important action… | R |
| Prices page (`PricesPage.tsx:58`) | Rates per gram for every karat you sell… | R |
| Prices: mode texts (`PricesPage.tsx:136–138`) | Example… / Price = net weight × rate… / Each piece sells at the price typed… | T (one "?" beside the mode) |
| Prices: rounding, guard hints (`PricesPage.tsx:130,140,143`) | … | T |
| Prices: NEW / USED / scrap card subtitles (`PricesPage.tsx:179,228`) | Pieces from suppliers and opening stock ({currency} per gram)… | K |
| Prices: guard dialog (`PricesPage.tsx:291,292`) | This moves a rate by more than {pct}%… | K (money) |
| Prices: saved (`PricesPage.tsx:111,217`) | Recorded as SETTINGS_CHANGED / SCRAP_RATE_CHANGED in the audit log. | R |
| Prices: history (`PricesPage.tsx:371`) | Kept for good: a change adds a line… | R |
| Settings page (`SettingsPage.tsx:91,113`) | Business rules the client will confirm… | R |
| Settings: reason box (`SettingsPage.tsx:115`) | Reason for the change (optional, recorded in the history) | S → "Reason (optional)" |
| Settings: saved (`SettingsPage.tsx:61`) | Recorded as SETTINGS_CHANGED in the audit log. | R |
| Settings: branding (`SettingsPage.tsx:124,141,144,175`) | Shown on the login page… / tagline hints / logo limits | T / S → "One line, up to 120 characters." / R / K |
| Settings: business hints (`SettingsPage.tsx:191,199,202,232`) | How far a branch manager may deviate… / count difference / supplier debt age / payment methods | T |
| Settings: sale cancel password (`SettingsPage.tsx:251`) | 0 = every cancellation asks for the password again. | K (security) |
| Settings: backups (`SettingsPage.tsx:262`) | The dashboard warns the General Manager… | T |
| Settings: printing (`SettingsPage.tsx:314,343`) | Invoices are printed by the browser… / The PRINTABLE width… | T / T |
| Settings: printer set-up steps (`SettingsPage.tsx:352–355`) | 4 numbered steps | moved into a closed "Setting up the printer on the shop PC" section (opens on click) |
| Settings: security saved (`SettingsPage.tsx:401`) | Recorded as SECURITY_SETTING_CHANGED in the audit log. | R |
| Settings: second factor (`SettingsPage.tsx:425,435,436,448,449`) | … | K (security) |
| Settings: re-authentication window hint (`SettingsPage.tsx:286`) | … | UX-3 |
| Security page: enrolment (`SecurityPage.tsx:71,83–85,155,159,176,228`) | … | K (security, needed to proceed) |
| Security page: "never leaves this computer" (`SecurityPage.tsx:87`) | Your fingerprint or face never leaves this computer… | T |
| Security page: passkeys, recovery, sign-ins (`SecurityPage.tsx:319,349,361,369,380,382,387,438,450,472`) | … | K |
| Security page: phone steps (`SecurityPage.tsx:425–429`) | 5 numbered steps | moved into a closed "Register your phone as a second device" section |

## 3. Components

- **`HelpTip`** (`components/ui/HelpTip.tsx`): a 20 px "?" button (`aria-label` "More information", `aria-expanded`,
  `aria-controls`) that toggles a small popover with the text; Enter/Space toggles, Escape closes and returns focus, a
  click or tap outside closes. No new dependency. `Field`, `PageHeader`, `CardHeader` and `Dialog` get an optional
  `help` prop that places it after the label or title (outside the `<label>`, so the field's accessible name does not
  change). Shown in the UI kit; the kit capture script checks keyboard open/close, tap and axe.
- **Permission names**: `frontend/src/lib/permission-labels.ts` maps every code of `PERMISSIONS` (shared) to a short
  English key (`tk`) translated in `i18n-ar.ts`; a code without a name (a role added later) shows "Other permission".
  The map is typed `Record<Permission, string>`, so a new permission without a name fails `tsc`.
- **Collapsed sections**: the native `<details>` element (already used on the scrap form), closed by default.

## 4. Commits

1. c0 this plan.
2. c1 `HelpTip`, the `help` props, UI kit + kit checks.
3. c2 Users page: Arabic permission names, GM-only closed codes; REH-1: no code visible to the GM until opened, none
   for the branch manager.
4. c3 cashier screens (POS, buy a piece, own sales, own security page).
5. c4 stock screens (inventory, catalog, supplier orders, scrap, transfers, opening balance, sale page).
6. c5 cash, branches, reports, administration, settings, sign-in.
7. c6 acceptance (`docs/acceptance/UX-2.md`), decision D-ux2-1, BACKLOG, `verify --full`.

Every commit updates the Arabic dictionary, removes the keys it no longer uses, and updates in the same commit any test,
e2e script or REH-1 check that asserted a removed text (preferring `data-testid` or role selectors).

## 5. Risks

- A removed sentence was the only place a rule was explained: each R is either internal wording or repeated on the
  same screen; money and irreversible-action texts are all K.
- Tests or REH-1 asserting on a removed text: searched per commit (`rg` on the English key and the Arabic value).
