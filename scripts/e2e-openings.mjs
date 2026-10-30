#!/usr/bin/env node
// OPN-1 e2e (docs/plans/OPN-1.md): the opening balance and the type rename, in the Arabic UI, on the BUILT app
// (npm run build) against its own empty server filled through the API (scripts/lib/e2e-world.mjs).
//   * Opening balance (General Manager): start the branch's draft; type a piece (Enter moves on, the last Enter adds;
//     OPN-2: the condition is a required choice with nothing preselected); a bad CSV shows every problem with its row
//     (an unknown condition too) and imports nothing; a good CSV adds its rows; the same file again changes nothing; a
//     line is removed; the summary by karat and condition adds up; the draft exports as CSV.
//   * Sealing: the button waits for the password AND a passkey confirmation (Chromium's virtual authenticator); then
//     the draft is SEALED, the lines show their codes, the pieces are in stock as "Opening balance" with an unknown
//     cost, priced by their condition (OPN-2: a used piece at the used-piece rate), and a sale of one shows that its
//     line is left out of the profit.
//   * Types & products: renaming a type keeps the old name on a past sale.
//
//   node scripts/e2e-openings.mjs            checks
//   node scripts/e2e-openings.mjs --shots    also the owner's screenshots in docs/acceptance/OPN-1/ (1366×768, Arabic)

import fs from 'node:fs';
import path from 'node:path';
import { apiClient, buildSalesWorld, loadModule, ROOT, startEmptyServer } from './lib/e2e-world.mjs';
import { toWebp } from './lib/screens.mjs';
import { eventually, signIn } from './lib/e2e-ui.mjs';

const { chromium } = loadModule('playwright');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs/acceptance/OPN-1');

let BASE = '';
let BROWSER;
let step = 0;
let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${String(++step).padStart(2, '0')} ${msg}`);
  if (!cond) failures++;
}
const section = (s) => console.log(`\n── ${s}`);
async function shot(page, name) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  fs.writeFileSync(path.join(OUT, `${name}.webp`), await toWebp(BROWSER, await page.screenshot({ type: 'png' })));
}

async function virtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** A sensitive action may ask for the password and then the passkey (D-1a-8, D-2fa-7). */
async function confirmIfAsked(page, password) {
  await page.waitForTimeout(400);
  if (await page.locator('#reauth-form').count()) {
    await page.fill('#reauth-form input[type=password]', password);
    await page.click('button[form=reauth-form]');
    await page.waitForTimeout(400);
  }
  if (await page.getByTestId('reauth-passkey').count()) {
    await page.click('[data-testid=reauth-passkey]');
    await page.waitForTimeout(400);
  }
}

const rowsOf = (page) => page.getByTestId('opening-lines').locator('tbody tr');

async function registerPasskey(page, world) {
  section('The General Manager registers a passkey (sealing needs one)');
  await page.goto(`${BASE}/security`);
  await page.getByTestId('add-passkey').click();
  await confirmIfAsked(page, world.gm.password);
  if (!(await page.getByTestId('add-passkey-nickname').count())) await page.getByTestId('add-passkey').click();
  await page.fill('[data-testid=add-passkey-nickname]', 'Shop PC');
  await page.click('[data-testid=add-passkey-confirm]');
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => (await page.getByTestId('passkey-list').locator('li').count()) === 1), 'a passkey is registered on the virtual authenticator');
}

async function opening(page, gm, world) {
  section('Opening balance: start, type, import (bad, good, the same file), remove, review, export');
  await page.goto(`${BASE}/openings`);
  await page.getByTestId('opening-start-TST').click();
  await page.waitForURL((u) => /\/openings\/\d+$/.test(u.pathname), { timeout: 15_000 });
  const id = Number(new URL(page.url()).pathname.split('/').pop());
  check(id > 0, 'Start opens the branch’s draft');
  check((await gm.call('POST', '/openings', { branchId: world.branchId }, { idempotent: true })).status === 409, 'a second opening of the branch is refused (409)');

  // Keyboard: type, karat, description, condition, weights; the last Enter adds the line.
  await page.selectOption('[data-testid=opening-kind-type]', String(world.openingTypeId));
  await page.selectOption('[data-testid=opening-kind-karat]', '21');
  await page.fill('[data-testid=opening-kind-description]', 'رقم قديم 15');
  check((await page.inputValue('[data-testid=opening-condition]')) === '' && (await page.getByTestId('opening-add-line').isDisabled()), 'the condition starts unchosen and the piece cannot be added without it');
  await page.selectOption('[data-testid=opening-condition]', 'USED');
  await page.click('[data-testid=opening-gross]');
  await page.keyboard.type('5.250');
  await page.keyboard.press('Enter');
  await page.keyboard.type('5.000');
  await page.keyboard.press('Enter');
  check(await eventually(async () => (await rowsOf(page).count()) === 1 && (await rowsOf(page).first().innerText()).includes('رقم قديم 15')), 'Enter on the last field adds the typed piece');
  check((await rowsOf(page).first().innerText()).includes('مستعمل') && (await page.inputValue('[data-testid=opening-condition]')) === '', 'the line shows its condition (used); the next piece starts unchosen again');

  // A bad file: every problem with its row; nothing imported.
  const header = 'النوع / Type,الوصف / Description,العيار / Karat,الحالة / Condition,الوزن القائم (جم) / Gross weight (g),الوزن الصافي (جم) / Net weight (g)';
  const bad = [header, `${world.openingTypeAr},,21,جديد,3,3`, 'نوع لا يوجد,,21,جديد,3,3', `${world.openingTypeAr},,21,جديد,2,3`, `${world.openingTypeAr},,21,قديم,3,3`].join('\r\n');
  await page.setInputFiles('[data-testid=opening-file]', { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
  await page.click('[data-testid=opening-import]');
  const problems = page.getByTestId('opening-import-problem');
  check(await eventually(async () => (await problems.count()) === 3), 'a bad file lists its 3 problems');
  check((await problems.nth(0).innerText()).startsWith('3') && (await problems.nth(1).innerText()).startsWith('4') && (await problems.nth(2).innerText()).startsWith('5'), 'each problem names its row (3, 4 and 5)');
  check((await problems.nth(2).innerText()).includes('قديم'), `an unknown condition is named (${(await problems.nth(2).innerText()).replace(/\s+/g, ' ')})`);
  check((await rowsOf(page).count()) === 1, 'nothing of the bad file is imported');
  await shot(page, 'import-problems');

  // A good file (semicolons, BOM, Arabic-Indic digits), then the same file again.
  const good = '﻿' + ['النوع;الوصف;العيار;الحالة;الوزن القائم;الوزن الصافي', `${world.openingTypeAr};دبلة;21;جديد;٤٫٥;٤`, `${world.openingTypeAr};;21;مستعمل;6;5.5`, `${world.openingTypeAr};"قديم; رقم 9";21;جديدة;3.2;3`].join('\r\n');
  for (const attempt of [1, 2]) {
    await page.setInputFiles('[data-testid=opening-file]', { name: 'branch.csv', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(good) });
    await page.click('[data-testid=opening-import]');
    check(await eventually(async () => (await rowsOf(page).count()) === 4), attempt === 1 ? 'a good file adds its 3 rows' : 'the same file again changes nothing (still 4 lines)');
  }
  check(await eventually(async () => (await page.getByTestId('opening-imports').locator('li').count()) === 1), 'one import is recorded');

  // Remove the typed line; the summary by karat and condition adds up.
  await page.click('[data-testid=opening-remove-1]');
  check(await eventually(async () => (await rowsOf(page).count()) === 3), 'a draft line is removed');
  const k21n = page.getByTestId('opening-karat-21-NEW');
  const k21u = page.getByTestId('opening-karat-21-USED');
  check(await eventually(async () => /2/.test(await k21n.innerText()) && (await k21n.innerText()).includes('7.000')), `the summary: 21K new, 2 pieces, 7.000 g net (${(await k21n.innerText()).replace(/\s+/g, ' ')})`);
  check(/1/.test(await k21u.innerText()) && (await k21u.innerText()).includes('5.500'), `the summary: 21K used, 1 piece, 5.500 g net (${(await k21u.innerText()).replace(/\s+/g, ' ')})`);
  await shot(page, 'review');

  // OPN-3: broken scrap typed in (karat, net weight, an optional note), edited and removed; the totals per karat and
  // the total gold (pieces + scrap) follow.
  const scrapRows = () => page.getByTestId('opening-scrap-lines').locator('tbody tr');
  const addScrap = async (karat, grams, note) => {
    await page.selectOption('[data-testid=opening-scrap-karat]', String(karat));
    await page.fill('[data-testid=opening-scrap-weight]', grams);
    await page.fill('[data-testid=opening-scrap-note]', note);
    await page.click('[data-testid=opening-scrap-add]');
  };
  check(await page.getByTestId('opening-scrap-add').isDisabled(), 'broken scrap: Add is grey until a karat and a weight are given');
  await addScrap(21, '10.5', 'كيس 1');
  check(await eventually(async () => (await scrapRows().count()) === 1), 'a broken-scrap line of 21K is added');
  await addScrap(18, '2', '');
  await addScrap(22, '1', '');
  check(await eventually(async () => (await scrapRows().count()) === 3), 'two more lines (18K, 22K: any karat)');
  await page.click('[data-testid=opening-scrap-edit-2]');
  await page.fill('[data-testid=opening-scrap-edit-weight]', '3');
  await page.click('[data-testid=opening-scrap-edit-save]');
  check(await eventually(async () => (await page.getByTestId('opening-scrap-line-2').innerText()).includes('3.000')), 'a line is edited (18K: 2 g → 3 g)');
  await page.click('[data-testid=opening-scrap-remove-3]');
  check(await eventually(async () => (await scrapRows().count()) === 2), 'a line is removed');
  check(await eventually(async () => (await page.getByTestId('opening-scrap-total-weight').innerText()).includes('13.500')), `the scrap total: 13.500 g (${await page.getByTestId('opening-scrap-total-weight').innerText()})`);
  check((await page.getByTestId('opening-gold-all').innerText()).includes('26.000'), `the total gold: pieces 12.500 g + scrap 13.500 g = 26.000 g (${(await page.getByTestId('opening-gold-all').innerText()).replace(/\s+/g, ' ')})`);
  await shot(page, 'scrap-draft');

  // The draft's export imports again (the sheet's columns).
  const exported = await page.evaluate(async (u) => (await fetch(u)).text(), `/api/openings/${id}/export`);
  check(exported.includes('النوع / Type') && exported.includes('الحالة / Condition') && exported.split(/\r\n/).filter(Boolean).length === 4, 'the draft exports as CSV (header with the condition + 3 rows)');
  return id;
}

async function seal(page, gm, cashierApi, world, id) {
  section('Sealing: summary, password and passkey; then the pieces are in stock with an unknown cost');
  await page.click('[data-testid=opening-seal]');
  const confirm = page.getByTestId('opening-seal-confirm');
  check(await confirm.isDisabled(), 'Seal is grey with no password and no passkey');
  const sealSummary = await page.getByTestId('opening-seal-summary').innerText();
  check(sealSummary.includes('12.500') && sealSummary.includes('مستعمل') && sealSummary.includes('5.500'), `the dialog shows the count and weight by karat and condition (${sealSummary.replace(/\s+/g, ' ')})`);
  const sealScrap = await page.getByTestId('opening-seal-scrap').innerText();
  check(sealScrap.includes('13.500') && sealScrap.includes('10.500') && sealScrap.includes('3.000'), `OPN-3: the dialog shows the broken scrap by karat (${sealScrap.replace(/\s+/g, ' ')}) and the total gold`);
  const poolBefore = (await gm.must('GET', `/scrap-pool?branchId=${world.branchId}`)).weightMg;
  await page.fill('[data-testid=opening-seal-password]', world.gm.password);
  check(await confirm.isDisabled(), 'the password alone keeps Seal grey');
  await page.click('[data-testid=opening-seal-passkey]');
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => !(await confirm.isDisabled())), 'after the passkey confirmation Seal is enabled');
  await shot(page, 'seal-dialog');
  await confirm.click();
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => (await gm.must('GET', `/openings/${id}`)).status === 'SEALED', 15_000), 'the opening is SEALED');
  await page.reload();
  check(await eventually(async () => /J-\d+/.test(await rowsOf(page).first().innerText())), 'the lines show their system codes');
  check((await page.getByTestId('opening-keyboard').count()) === 0 && (await page.getByTestId('opening-seal').count()) === 0, 'nothing can be added any more (no entry, no seal)');
  // OPN-3: the scrap is in the branch's pool once; the sealed page shows it and has no entry form any more.
  check((await gm.must('GET', `/scrap-pool?branchId=${world.branchId}`)).weightMg - poolBefore === 13_500, 'OPN-3: the seal put the 13.500 g of broken scrap into the branch pool');
  check((await page.getByTestId('opening-scrap-sealed').count()) === 1 && (await page.getByTestId('opening-scrap-add').count()) === 0, 'OPN-3: the sealed page shows the broken scrap, without the entry form');
  await shot(page, 'sealed');
  // OPN-3: a correction of the scrap through its dialog: 0.5 g of 21K less (reason, password, passkey).
  await page.click('[data-testid=opening-scrap-correct]');
  await page.selectOption('[data-testid=opening-scrap-correct-kind]', 'REMOVE');
  await page.selectOption('[data-testid=opening-scrap-correct-karat]', '21');
  await page.fill('[data-testid=opening-scrap-correct-weight]', '0.5');
  await page.fill('[data-testid=opening-scrap-correct-reason]', 'وُزن مرة أخرى');
  await page.fill('[data-testid=opening-scrap-correct-password]', world.gm.password);
  const fixConfirm = page.getByTestId('opening-scrap-correct-confirm');
  check(await fixConfirm.isDisabled(), 'the scrap correction waits for the passkey');
  await page.click('[data-testid=opening-scrap-correct-passkey]');
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => !(await fixConfirm.isDisabled())), 'after the passkey the correction can be saved');
  await fixConfirm.click();
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => (await gm.must('GET', `/scrap-pool?branchId=${world.branchId}`)).weightMg - poolBefore === 13_000, 15_000), 'OPN-3: the correction took 0.5 g of 21K out of the pool');
  check(await eventually(async () => (await page.getByTestId('opening-scrap-corrections').locator('tbody tr').count()) === 1), 'OPN-3: the sealed page lists the correction');
  await shot(page, 'scrap-corrected');

  // In stock, as "Opening balance", with an unknown cost.
  const items = (await gm.must('GET', `/inventory/items?branchId=${world.branchId}&origin=OPENING`)).rows;
  check(items.length === 3 && items.every((i) => i.totalCost === null && i.sellingPrice > 0), 'three pieces in stock: origin OPENING, cost unknown, priced');
  const rates = await gm.must('GET', '/gold-rates');
  const used = items.filter((i) => i.rateKind === 'USED');
  check(used.length === 1 && used[0].netWeightMg === 5_500 && used[0].pricePerGram === rates.used['21'].pricePerGram && items.filter((i) => i.rateKind === 'NEW').every((i) => i.pricePerGram === rates.current['21'].pricePerGram), 'the used piece is priced at the used-piece rate, the new ones at the new-piece rate');
  // OPN-2 in the inventory: the used opening piece carries a "Used" badge, the new/used filter finds it, and its page
  // names the rate that prices it.
  await page.goto(`${BASE}/inventory`);
  const invRows = () => page.locator('table tbody tr');
  await page.selectOption('select[aria-label="المصدر"]', 'OPENING');
  await page.selectOption('[data-testid=filter-rate-kind]', 'USED');
  check(await eventually(async () => (await page.getByTestId(`used-badge-${used[0].id}`).count()) === 1 && (await invRows().count()) === 1), 'the new/used filter shows the used opening piece, with its "Used" badge');
  await page.selectOption('[data-testid=filter-rate-kind]', 'NEW');
  check(await eventually(async () => (await page.getByTestId(`used-badge-${used[0].id}`).count()) === 0 && (await invRows().count()) === 2), 'the "new" filter shows the 2 new opening pieces and leaves it out');
  await shot(page, 'inventory-used-filter');
  await page.goto(`${BASE}/inventory/${used[0].id}`);
  check(await eventually(async () => (await page.getByTestId('item-rate-kind').innerText().catch(() => '')).includes('المستعمل')), 'the used piece’s page says it is priced at the used-piece rate');
  const newOne = items.find((i) => i.rateKind === 'NEW');
  await page.goto(`${BASE}/inventory/${newOne.id}`);
  check(await eventually(async () => (await page.getByTestId('item-rate-kind').innerText().catch(() => '')).includes('الجديد')), 'a new piece’s page says it is priced at the new-piece rate');
  await page.goto(`${BASE}/inventory/${items[0].id}`);
  check(await eventually(async () => (await page.getByTestId('item-cost-unknown').count()) === 1), 'the piece says "Cost: unknown (opening balance)"');

  // OPN-FIX: the used piece was entered by mistake as used. Its page offers the correction (General Manager); the dialog
  // shows the server's preview (price now, price after, the valuation change) before the confirmation, then asks the
  // reason, the password and the passkey.
  await page.goto(`${BASE}/inventory/${used[0].id}`);
  await page.click('[data-testid=opening-correct]');
  await page.selectOption('[data-testid=opening-correct-condition]', 'NEW');
  const pv = await gm.must('GET', `/openings/${id}/pieces/${used[0].id}/correction-preview?action=CORRECT&condition=NEW`);
  check(
    await eventually(async () => (await page.getByTestId('opening-correct-new-price').innerText().catch(() => '')).replace(/[^\d]/g, '') === String(pv.after.sellingPrice)),
    `the preview shows the new price (${pv.after.sellingPrice}, now ${pv.before.sellingPrice}) before the confirmation`,
  );
  const confirmFix = page.getByTestId('opening-correct-confirm');
  check(await confirmFix.isDisabled(), 'Save stays grey without the reason, the password and the passkey');
  await page.fill('[data-testid=opening-correct-reason]', 'سُجّلت مستعملة خطأً');
  await page.fill('[data-testid=opening-correct-password]', world.gm.password);
  await page.click('[data-testid=opening-correct-passkey]');
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => !(await confirmFix.isDisabled())), 'with the reason, the password and the passkey, Save is enabled');
  await shot(page, 'opening-correction');
  await confirmFix.click();
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => (await gm.must('GET', `/inventory/items/${used[0].id}`)).item.rateKind === 'NEW', 15_000), 'the piece is corrected to new');
  check(await eventually(async () => (await page.getByTestId('opening-corrections').count()) === 1 && (await page.getByTestId('item-rate-kind').innerText()).includes('الجديد')), 'its page lists the correction and says it is priced at the new-piece rate');
  await page.goto(`${BASE}/openings/${id}`);
  check(await eventually(async () => (await page.getByTestId('opening-now').count()) === 1 && (await page.getByTestId('opening-corrections').innerText()).includes('سُجّلت مستعملة خطأً')), 'the sealed opening shows the pieces now and the correction with its reason');
  await shot(page, 'opening-corrections');

  // A sale of one: its line is left out of the profit, and the sale says so.
  const sale = await cashierApi.call('POST', '/sales', { items: [{ itemId: items[0].id }], paymentMethod: 'CASH' }, { idempotent: true });
  const price = sale.body?.error?.details?.lines?.[0]?.listPrice;
  const sold = await cashierApi.must('POST', '/sales', { items: [{ itemId: items[0].id, listPrice: price }], paymentMethod: 'CASH' }, { idempotent: true });
  const detail = await gm.must('GET', `/sales/${sold.id}`);
  check(detail.grossProfit === null && detail.unknownCostLines === 1, 'the sale’s profit is "—" (NULL) with 1 line of unknown cost');
  await page.goto(`${BASE}/sales/${sold.id}`);
  check(await eventually(async () => (await page.getByTestId('sale-unknown-cost').count()) === 1), 'the sale page says the line is not counted');
}

async function rename(page, gm, world) {
  section('Types & products: rename a type; a past sale keeps the old name');
  await page.goto(`${BASE}/catalog`);
  await page.getByRole('tab').nth(1).click();
  await page.getByTestId(`rename-type-${world.openingTypeId}`).click();
  await page.fill('[data-testid=rename-name-ar]', '[اختبار] خاتم بعد');
  await page.click('[data-testid=confirm-rename]');
  check(await eventually(async () => (await gm.must('GET', '/categories')).some((c) => c.id === world.openingTypeId && c.nameAr === '[اختبار] خاتم بعد')), 'the type is renamed');
  const sales = (await gm.must('GET', `/sales?branchId=${world.branchId}`)).rows;
  const last = await gm.must('GET', `/sales/${sales[0].id}`);
  check(last.items[0].categoryNameAr === world.openingTypeAr, 'the past sale keeps the old type name');
}

async function main() {
  if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv, { pieces: 1 });
  const gm = await apiClient(BASE);
  await gm.login(world.gm.username, world.gm.password);
  await gm.reauth(world.gm.password);
  const type = await gm.must('POST', '/categories', { nameAr: '[اختبار] خاتم افتتاحي' }, { idempotent: true });
  Object.assign(world, { openingTypeId: type.id, openingTypeAr: type.nameAr });
  const cashierApi = await apiClient(BASE);
  await cashierApi.login(world.cashier.username, world.cashier.password);
  const browser = await chromium.launch();
  BROWSER = browser;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const page = await ctx.newPage();
    globalThis.__page = page;
    await virtualAuthenticator(page);
    await signIn(page, BASE, world.gm);
    await registerPasskey(page, world);
    const id = await opening(page, gm, world);
    await seal(page, gm, cashierApi, world, id);
    await rename(page, gm, world);
  } catch (e) {
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-openings-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await gm.dispose();
    await cashierApi.dispose();
    await srv.stop();
  }
  console.log(failures ? `\nOPENINGS FAILED: ${failures} of ${step} checks.` : `\nAll ${step} opening checks passed.${SHOTS ? ` Screenshots in ${path.relative(ROOT, OUT)}/` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
