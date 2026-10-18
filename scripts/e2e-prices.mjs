#!/usr/bin/env node
// PRC-1 e2e (docs/plans/PRC-1.md, D-prc1-4/8/9): computed selling prices in the Arabic UI, on the BUILT app
// (npm run build) against its own empty server filled through the API (scripts/lib/e2e-world.mjs).
//   * the Prices page: three rate tables (new pieces, used pieces, scrap) and the history with who and when;
//   * the owner's example: a 1 g piece priced 100,000 on "Sunday" sells for 110,000 on "Monday" after the rate rises
//     (test values); the inventory list and the POS grid show the live price;
//   * a rate change while a piece is in the cart: "Complete sale" answers 409, the cart shows the new price and says
//     so; confirming again sells at the price shown; the invoice shows the price per gram;
//   * the scrap form (branch manager and cashier) asks for no selling price; the cashier buys a sellable piece only.
//
//   node scripts/e2e-prices.mjs            checks
//   node scripts/e2e-prices.mjs --shots    also the owner's screenshots in docs/acceptance/PRC-1/ (1366×768, Arabic)

import fs from 'node:fs';
import path from 'node:path';
import { apiClient, buildSalesWorld, loadModule, PEOPLE, ROOT, startEmptyServer } from './lib/e2e-world.mjs';
import { toWebp } from './lib/screens.mjs';

const { chromium } = loadModule('playwright');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs/acceptance/PRC-1');

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
/** A condition the screen reaches one render later: poll it, at most `ms`. */
async function eventually(fn, ms = 8_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const digits = (s) => s.replace(/[^\d]/g, '');
const price = (mg, rate) => Math.round((mg * rate) / 1000); // rounding step 1 (the default)

async function signIn(page, who) {
  await page.goto(`${BASE}/login`);
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
  await page.fill('input[autocomplete=username]', who.username);
  await page.fill('input[autocomplete=current-password]', who.password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname !== '/login', { timeout: 15_000 });
  await page.getByTestId('sidebar').waitFor();
}

async function pricesPage(page, gm) {
  section('The Prices page (General Manager): three rate tables and the history');
  await page.goto(`${BASE}/settings#scrap-rates`);
  await page.waitForURL((u) => u.pathname === '/prices', { timeout: 15_000 });
  await page.getByTestId('rates-history').waitFor({ timeout: 15_000 });
  check((await page.getByTestId('rates-new').count()) === 1 && (await page.getByTestId('rates-used').count()) === 1 && (await page.getByTestId('rates-scrap').count()) === 1, 'Settings#scrap-rates opens the Prices page: new pieces, used pieces, scrap');
  const view = await gm.must('GET', '/gold-rates');
  check(digits(await page.inputValue('[data-testid=gold-rate-21]')) === String(view.current['21'].pricePerGram) && digits(await page.inputValue('[data-testid=used-rate-21]')) === String(view.used['21'].pricePerGram), `21K: new ${view.current['21'].pricePerGram}, used ${view.used['21'].pricePerGram} per gram`);
  const hist = await page.getByTestId('rates-history').locator('tbody tr').allInnerTexts();
  check(hist.length >= 3 && hist.every((r) => r.includes(PEOPLE.gm.fullName)), `the history lists every change with who and when (${hist.length} lines, each by ${PEOPLE.gm.fullName})`);
  await shot(page, 'prices');
}

/** Fill and confirm the re-authentication dialog if the page asks (the rate routes need the re-auth window). */
async function confirmIfAsked(page, password) {
  await page.waitForTimeout(400);
  if (await page.locator('#reauth-form').count()) {
    await page.fill('#reauth-form input[type=password]', password);
    await page.click('button[form=reauth-form]');
    await page.waitForTimeout(400);
  }
}

/** Replace a money field's value (select all, then type, as a person would). */
async function retype(page, testId, value) {
  await page.click(`[data-testid=${testId}]`);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
}

async function guardFlow(page, gm, world) {
  section('DEC-1 (RAT-1): the Prices page shows the change and asks for a reason, then the password');
  const start = (await gm.must('GET', '/gold-rates')).current['21'].pricePerGram;
  const plus20 = Math.round((start * 120) / 100);
  await retype(page, 'gold-rate-21', String(plus20));
  const chip = page.getByTestId('gold-rate-21-change');
  check((await chip.getAttribute('data-level')) === 'REASON' && /\+20\.00/.test(await chip.innerText()), `+20 %: the row says "${(await chip.innerText()).trim()}" before saving`);
  await page.click('[data-testid=save-gold-rates]');
  await page.getByTestId('rate-guard').waitFor({ timeout: 15_000 });
  check((await page.getByTestId('rate-guard-password').count()) === 0 && (await page.getByTestId('rate-guard-confirm').isDisabled()), 'the dialog asks for a reason only; Save stays disabled without it');
  await page.fill('[data-testid=rate-guard-reason]', 'اختبار: ارتفاع السوق');
  await page.click('[data-testid=rate-guard-confirm]');
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => (await gm.must('GET', '/gold-rates')).current['21'].pricePerGram === plus20), 'with the reason, the +20 % rate is saved');
  const plus40 = Math.round((plus20 * 140) / 100);
  await retype(page, 'gold-rate-21', String(plus40));
  check((await page.getByTestId('gold-rate-21-change').getAttribute('data-level')) === 'CONFIRM', '+40 %: the row says it needs a reason and the password');
  await page.click('[data-testid=save-gold-rates]');
  await page.getByTestId('rate-guard-password').waitFor({ timeout: 15_000 });
  await page.fill('[data-testid=rate-guard-reason]', 'اختبار: ارتفاع كبير');
  await page.fill('[data-testid=rate-guard-password]', 'not-the-password');
  await page.click('[data-testid=rate-guard-confirm]');
  await page.waitForTimeout(800);
  check((await gm.must('GET', '/gold-rates')).current['21'].pricePerGram === plus20 && (await page.getByTestId('rate-guard').count()) === 1, 'a wrong password saves nothing and the dialog stays open');
  await page.fill('[data-testid=rate-guard-password]', world.gm.password);
  await page.click('[data-testid=rate-guard-confirm]');
  check(await eventually(async () => (await gm.must('GET', '/gold-rates')).current['21'].pricePerGram === plus40), 'with the reason and the password, the +40 % rate is saved');
  await gm.reauth(world.gm.password);
  await gm.must('POST', '/gold-rates', { rates: { 21: start }, reason: 'اختبار: إعادة السعر', confirmPassword: world.gm.password });
  await page.reload();
}

async function sundayMonday(page, gm, world) {
  section('The owner’s example: 1 g priced 100,000 on Sunday sells for 110,000 on Monday (test values)');
  const before = (await gm.must('GET', '/gold-rates')).current['21'].pricePerGram;
  // A 1 g piece (test values), received without any selling price.
  const po = await gm.must('POST', '/purchases', { branchId: world.branchId, supplierId: world.supplierId, confirmOpenSupplierDebt: true, lines: [{ productId: world.productId, grossWeightMg: 1_000, netWeightMg: 1_000, purchaseCost: 60_000, makingCost: 0, otherCost: 0 }] }, { idempotent: true });
  const code = po.itemCodes[0];
  await gm.reauth(world.gm.password);
  // DEC-1 (RAT-1): 190,000 → 100,000 is a move of more than 30 %: it carries a reason and the password (test values).
  const bigMove = { reason: 'اختبار: مثال الأحد والإثنين', confirmPassword: world.gm.password };
  const guarded = await gm.call('POST', '/gold-rates', { rates: { 21: 100_000 } });
  check(guarded.status === 403 && guarded.body.error.code === 'RATE_CHANGE_CONFIRM_REQUIRED', 'DEC-1: a move of more than 30 % without the reason and the password is refused (403)');
  await gm.must('POST', '/gold-rates', { rates: { 21: 100_000 }, ...bigMove });
  const row = async () => (await gm.must('GET', `/inventory/items?q=${code}`)).rows[0];
  check((await row()).sellingPrice === 100_000, `Sunday: ${code} (1 g) sells for 100,000 at 100,000 per gram`);
  await gm.must('POST', '/gold-rates', { rates: { 21: 110_000 } });
  check((await row()).sellingPrice === 110_000, 'Monday: the rate rises to 110,000 (exactly +10 %: no reason needed); the same piece now sells for 110,000');
  await page.goto(`${BASE}/inventory`);
  const line = page.locator('main tbody tr', { hasText: code });
  check(await eventually(async () => (await line.count()) === 1 && digits(await line.innerText()).includes('110000')), `the inventory list shows 110,000 for ${code}`);
  await gm.must('POST', '/gold-rates', { rates: { 21: before }, ...bigMove });
}

async function inventoryList(page, gm) {
  section('Inventory list: live prices');
  const rate = (await gm.must('GET', '/gold-rates')).current['21'].pricePerGram;
  const rows = (await gm.must('GET', '/inventory/items?status=AVAILABLE&pageSize=50')).rows;
  check(rows.length > 0 && rows.every((r) => r.sellingPrice === price(r.netWeightMg, rate) && r.pricePerGram === rate), `every available piece is priced net weight × ${rate.toLocaleString('en-US')} per gram`);
  await page.goto(`${BASE}/inventory`);
  await page.locator('main table tbody tr').first().waitFor({ timeout: 15_000 });
  const text = digits(await page.locator('main').innerText());
  check(rows.slice(0, 5).every((r) => text.includes(String(r.sellingPrice))), 'the list shows those prices');
  await shot(page, 'inventory');
}

async function cart(page, gm, world) {
  section('POS: the grid, the cart, a rate change before "Complete sale" (409), the invoice per gram');
  await page.goto(`${BASE}/pos`);
  await page.getByTestId('pos-product').first().waitFor({ timeout: 15_000 });
  const rate = (await gm.must('GET', '/gold-rates')).current['21'].pricePerGram;
  const stock = (await gm.must('GET', `/inventory/items?branchId=${world.branchId}&status=AVAILABLE&sort=recent&pageSize=50`)).rows;
  const grid = digits(await page.locator('main').innerText());
  check(stock.slice(0, 3).every((r) => grid.includes(String(r.sellingPrice))), 'the POS grid shows the live prices');
  await shot(page, 'pos');
  await page.getByTestId('pos-product').first().click();
  await page.getByTestId('pos-line-per-gram').first().waitFor();
  check(digits(await page.getByTestId('pos-line-per-gram').first().innerText()) === String(rate), `the cart line shows ${rate.toLocaleString('en-US')} per gram`);
  // The General Manager raises the rate while the piece sits in the cart (test value).
  await gm.reauth(world.gm.password);
  await gm.must('POST', '/gold-rates', { rates: { 21: rate + 10_000 } });
  const first = page.waitForResponse((r) => r.url().endsWith('/api/sales') && r.request().method() === 'POST');
  await page.click('[data-testid=pos-complete]');
  const r1 = await first;
  check(r1.status() === 409 && (await r1.json()).error.code === 'PRICES_CHANGED', 'Complete sale: 409 PRICES_CHANGED (the price shown is no longer the price)');
  await page.getByTestId('pos-prices-changed').waitFor({ timeout: 15_000 });
  check(await eventually(async () => digits(await page.getByTestId('pos-line-per-gram').first().innerText()) === String(rate + 10_000)), 'the cart says the rates changed and shows the new rate and price; nothing was sold');
  await shot(page, 'cart-rates-changed');
  const second = page.waitForResponse((r) => r.url().endsWith('/api/sales') && r.request().method() === 'POST');
  await page.click('[data-testid=pos-complete]');
  const r2 = await second;
  const sale = await r2.json();
  check(r2.status() === 200 && sale.items[0].priceRatePerGram === rate + 10_000 && sale.items[0].listPrice === price(sale.items[0].netWeightMg, rate + 10_000), `confirmed again: sold at the price shown (${sale.items[0].listPrice.toLocaleString('en-US')} at ${(rate + 10_000).toLocaleString('en-US')} per gram)`);
  await page.getByTestId('invoice-per-gram').first().waitFor({ timeout: 15_000 });
  check(digits(await page.getByTestId('invoice-per-gram').first().innerText()) === String(rate + 10_000), 'the invoice shows the price per gram used');
  await shot(page, 'invoice');
  // A later rate change does not touch the sale.
  await gm.must('POST', '/gold-rates', { rates: { 21: rate } });
  const kept = await gm.must('GET', `/sales/${sale.id}`);
  check(kept.items[0].listPrice === sale.items[0].listPrice && kept.items[0].priceRatePerGram === rate + 10_000, 'after the rate goes back down, the sale keeps its price and its rate');
  await page.keyboard.press('Escape');
}

async function scrapForms(page, world) {
  section('Scrap: no selling-price field; the cashier buys a sellable piece only');
  await page.goto(`${BASE}/scrap`);
  await page.getByTestId('scrap-karat').waitFor({ timeout: 15_000 });
  check((await page.getByTestId('scrap-kind-BROKEN').count()) === 0 && (await page.getByTestId('scrap-pool').count()) === 0, 'cashier: a sellable piece only (no broken scrap, no pool, no list)');
  await page.selectOption('[data-testid=scrap-karat]', '21');
  check((await page.locator('[data-testid=scrap-selling-price]').count()) === 0 && (await page.getByTestId('scrap-price-follows-rate').count()) === 1, 'cashier: no selling-price field; the piece follows the used-piece rate');
  await page.click('[data-testid=scrap-product]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.fill('[data-testid=scrap-gross]', '2.1');
  await page.fill('[data-testid=scrap-net]', '2');
  await shot(page, 'scrap-form');
  void world;
}

async function main() {
  if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv);
  const gm = await apiClient(BASE);
  await gm.login(world.gm.username, world.gm.password);
  check((await gm.must('GET', '/gold-rates')).pricing.mode === 'RATE_COMPUTED', 'a new installation prices from the rates (RATE_COMPUTED)');
  const browser = await chromium.launch();
  BROWSER = browser;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const page = await ctx.newPage();
    globalThis.__page = page;
    await signIn(page, world.gm);
    await pricesPage(page, gm);
    await guardFlow(page, gm, world);
    await sundayMonday(page, gm, world);
    await inventoryList(page, gm);
    const cashierCtx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const cashier = await cashierCtx.newPage();
    globalThis.__page = cashier;
    await signIn(cashier, world.cashier);
    await cart(cashier, gm, world);
    await scrapForms(cashier, world);
  } catch (e) {
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-prices-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await gm.dispose();
    await srv.stop();
  }
  console.log(failures ? `\nPRICES FAILED: ${failures} of ${step} checks.` : `\nAll ${step} prices checks passed.${SHOTS ? ` Screenshots in ${path.relative(ROOT, OUT)}/` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
