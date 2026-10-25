#!/usr/bin/env node
// OPN-1 e2e (docs/plans/OPN-1.md): the opening balance and the type rename, in the Arabic UI, on the BUILT app
// (npm run build) against its own empty server filled through the API (scripts/lib/e2e-world.mjs).
//   * Opening balance (General Manager): start the branch's draft; type a piece (Enter moves on, the last Enter adds);
//     a bad CSV shows every problem with its row and imports nothing; a good CSV adds its rows; the same file again
//     changes nothing; a line is removed; the summary by karat adds up; the draft exports as CSV.
//   * Sealing: the button waits for the password AND a passkey confirmation (Chromium's virtual authenticator); then
//     the draft is SEALED, the lines show their codes, the pieces are in stock as "Opening balance" with an unknown
//     cost, and a sale of one shows that its line is left out of the profit.
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

  // Keyboard: type, karat, description, weights; the last Enter adds the line.
  await page.selectOption('[data-testid=opening-kind-type]', String(world.openingTypeId));
  await page.selectOption('[data-testid=opening-kind-karat]', '21');
  await page.fill('[data-testid=opening-kind-description]', 'رقم قديم 15');
  await page.click('[data-testid=opening-gross]');
  await page.keyboard.type('5.250');
  await page.keyboard.press('Enter');
  await page.keyboard.type('5.000');
  await page.keyboard.press('Enter');
  check(await eventually(async () => (await rowsOf(page).count()) === 1 && (await rowsOf(page).first().innerText()).includes('رقم قديم 15')), 'Enter on the last field adds the typed piece');

  // A bad file: every problem with its row; nothing imported.
  const header = 'النوع / Type,الوصف / Description,العيار / Karat,الوزن القائم (جم) / Gross weight (g),الوزن الصافي (جم) / Net weight (g)';
  const bad = [header, `${world.openingTypeAr},,21,3,3`, 'نوع لا يوجد,,21,3,3', `${world.openingTypeAr},,21,2,3`].join('\r\n');
  await page.setInputFiles('[data-testid=opening-file]', { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
  await page.click('[data-testid=opening-import]');
  const problems = page.getByTestId('opening-import-problem');
  check(await eventually(async () => (await problems.count()) === 2), 'a bad file lists its 2 problems');
  check((await problems.nth(0).innerText()).startsWith('3') && (await problems.nth(1).innerText()).startsWith('4'), 'each problem names its row (3 and 4)');
  check((await rowsOf(page).count()) === 1, 'nothing of the bad file is imported');
  await shot(page, 'import-problems');

  // A good file (semicolons, BOM, Arabic-Indic digits), then the same file again.
  const good = '﻿' + ['النوع;الوصف;العيار;الوزن القائم;الوزن الصافي', `${world.openingTypeAr};دبلة;21;٤٫٥;٤`, `${world.openingTypeAr};;21;6;5.5`, `${world.openingTypeAr};"قديم; رقم 9";21;3.2;3`].join('\r\n');
  for (const attempt of [1, 2]) {
    await page.setInputFiles('[data-testid=opening-file]', { name: 'branch.csv', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(good) });
    await page.click('[data-testid=opening-import]');
    check(await eventually(async () => (await rowsOf(page).count()) === 4), attempt === 1 ? 'a good file adds its 3 rows' : 'the same file again changes nothing (still 4 lines)');
  }
  check(await eventually(async () => (await page.getByTestId('opening-imports').locator('li').count()) === 1), 'one import is recorded');

  // Remove the typed line; the summary by karat adds up.
  await page.click('[data-testid=opening-remove-1]');
  check(await eventually(async () => (await rowsOf(page).count()) === 3), 'a draft line is removed');
  const k21 = page.getByTestId('opening-karat-21');
  check(await eventually(async () => /3/.test(await k21.innerText()) && (await k21.innerText()).includes('12.500')), `the summary by karat: 21K, 3 pieces, 12.500 g net (${(await k21.innerText()).replace(/\s+/g, ' ')})`);
  await shot(page, 'review');

  // The draft's export imports again (the sheet's columns).
  const exported = await page.evaluate(async (u) => (await fetch(u)).text(), `/api/openings/${id}/export`);
  check(exported.includes('النوع / Type') && exported.split(/\r\n/).filter(Boolean).length === 4, 'the draft exports as CSV (header + 3 rows)');
  return id;
}

async function seal(page, gm, cashierApi, world, id) {
  section('Sealing: summary, password and passkey; then the pieces are in stock with an unknown cost');
  await page.click('[data-testid=opening-seal]');
  const confirm = page.getByTestId('opening-seal-confirm');
  check(await confirm.isDisabled(), 'Seal is grey with no password and no passkey');
  check((await page.getByTestId('opening-seal-summary').innerText()).includes('12.500'), 'the dialog shows the count and weight by karat');
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
  await shot(page, 'sealed');

  // In stock, as "Opening balance", with an unknown cost.
  const items = (await gm.must('GET', `/inventory/items?branchId=${world.branchId}&origin=OPENING`)).rows;
  check(items.length === 3 && items.every((i) => i.totalCost === null && i.sellingPrice > 0), 'three pieces in stock: origin OPENING, cost unknown, priced from the new-piece rate');
  await page.goto(`${BASE}/inventory/${items[0].id}`);
  check(await eventually(async () => (await page.getByTestId('item-cost-unknown').count()) === 1), 'the piece says "Cost: unknown (opening balance)"');

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
