#!/usr/bin/env node
// UX-1 e2e (docs/plans/UX-1.md §5, D-ux1-5/6): the one "add piece" flow, in the Arabic UI, on the BUILT app
// (npm run build) against its own empty server filled through the API (scripts/lib/e2e-world.mjs).
//   * supplier order: the reason the receive button is disabled; the product picker's inline create (a new type
//     too), keyboard only; Enter from field to field; "Add another piece" copies the product and focuses the gross
//     weight; the sum of net weights; nothing pre-filled; the order is recorded as typed;
//   * sellable scrap: the inline create with the karat fixed and the last type first; the customer section is closed
//     and optional; the purchase is recorded;
//   * a narrow screen (390 px): no side scroll, 44 px controls.
//
//   node scripts/e2e-add-piece.mjs            checks
//   node scripts/e2e-add-piece.mjs --shots    also the owner's screenshots in docs/acceptance/UX-1/ (1366×768, Arabic)

import fs from 'node:fs';
import path from 'node:path';
import { apiClient, buildSalesWorld, loadModule, ROOT, startEmptyServer } from './lib/e2e-world.mjs';
import { toWebp } from './lib/screens.mjs';

const { chromium } = loadModule('playwright');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs/acceptance/UX-1');

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
  await page.waitForTimeout(250);
  fs.writeFileSync(path.join(OUT, `${name}.webp`), await toWebp(BROWSER, await page.screenshot({ type: 'png' })));
}
/** A condition the screen reaches one render later (an effect, a list that loads): poll it, at most `ms`. */
async function eventually(fn, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const focusedTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid'));

async function signIn(page, who) {
  await page.goto(`${BASE}/login`);
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
  await page.fill('input[autocomplete=username]', who.username);
  await page.fill('input[autocomplete=current-password]', who.password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname !== '/login', { timeout: 15_000 });
  await page.getByTestId('sidebar').waitFor();
}

async function signOut(page) {
  await page.evaluate(async () => {
    const me = await (await fetch('/api/auth/me')).json();
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrfToken ?? '' } });
  });
}

async function supplierOrder(page, world, gm) {
  section('Supplier order: one line at a time, keyboard first');
  await page.goto(`${BASE}/purchases`);
  await page.click('[data-testid=new-purchase]', { timeout: 15_000 });
  await page.getByTestId('purchase-line-hints').waitFor();
  const hints = await page.getByTestId('purchase-line-hints').innerText();
  // PRC-1 (D-prc1-8): computed prices: no selling-price column.
  check(['الوزن القائم', 'الأحجار', 'الذهب وحده', 'المستحق للمورد', 'حسابه الشخصي'].every((w) => hints.includes(w)) && !hints.includes('سعر البيع'), 'every line field has its label and a one-line hint in Arabic (no selling price: it follows the rates)');
  check((await page.getByTestId('purchase-save').isDisabled()) && (await page.getByTestId('purchase-missing').innerText()).includes('اختر الفرع المستلم'), `the receive button is disabled and says why: "${await page.getByTestId('purchase-missing').innerText()}"`);
  await shot(page, 'supplier-order-empty');
  await page.selectOption('[data-testid=purchase-branch]', String(world.branchId));
  await page.selectOption('[data-testid=purchase-supplier]', String(world.supplierId));
  check((await page.getByTestId('purchase-missing').innerText()).includes('القطعة 1: اختر المنتج'), 'then it names the first piece and what it lacks');

  // Inline create, keyboard only: type a new name, Enter on "Create …", fill the panel, confirm.
  await page.click('[data-testid=line-product-0]');
  await page.keyboard.type('قلادة UX1');
  await page.getByTestId('line-product-0-create').waitFor();
  check((await page.getByTestId('line-product-0-create').innerText()).includes('قلادة UX1'), 'a name that matches no product offers: Create "<name>"');
  await page.keyboard.press('Enter');
  await page.getByTestId('line-new-product-0').waitFor();
  check((await page.inputValue('[data-testid=line-new-product-0-name-ar]')) === 'قلادة UX1', 'the inline panel opens in the form (no dialog) with the typed name');
  if ((await page.locator('[data-testid=line-new-product-0-karat] option').count()) > 2) await page.selectOption('[data-testid=line-new-product-0-karat]', '21');
  await page.selectOption('[data-testid=line-new-product-0-type]', 'new');
  await page.fill('[data-testid=line-new-product-0-type-name]', 'سلاسل UX1');
  await page.getByTestId('line-new-product-0-save').scrollIntoViewIfNeeded();
  await shot(page, 'inline-create-product');
  await page.click('[data-testid=line-new-product-0-save]');
  await page.getByTestId('line-new-product-0').waitFor({ state: 'detached', timeout: 15_000 });
  const productId = Number(await page.getAttribute('[data-testid=line-product-0]', 'data-value'));
  const products = await gm.must('GET', '/products');
  const created = products.find((p) => p.id === productId);
  check(created?.nameAr === 'قلادة UX1' && created?.categoryNameAr === 'سلاسل UX1' && created?.karat === 21, 'one confirm created the type and the product (21K) and selected it on the line');
  check(await eventually(async () => (await focusedTestId(page)) === 'line-gross-0'), 'and the cursor is back on the line, in the gross weight');

  // Enter moves from field to field; nothing is pre-filled.
  await page.keyboard.type('5.2');
  await page.keyboard.press('Enter');
  check((await focusedTestId(page)) === 'line-net-0', 'Enter moves to the next field (net weight)');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check((await page.inputValue('[data-testid=line-cost-0]')) === '' && (await focusedTestId(page)) === 'line-cost-0', 'leaving the net weight fills in nothing (no invented cost)');
  // PRC-1 (D-prc1-8): no selling price on the line (computed prices): cost, making charge, other costs.
  check((await page.locator('[data-testid=line-price-0]').count()) === 0, 'the line asks for no selling price (it follows the new-piece rate)');
  for (const v of ['1000000', '50000', '']) {
    if (v) await page.keyboard.type(v);
    await page.keyboard.press('Enter');
  }
  await page.evaluate(() => document.activeElement?.blur());
  const typed = await Promise.all(['line-gross-0', 'line-net-0', 'line-cost-0', 'line-making-0', 'line-other-0'].map((id) => page.inputValue(`[data-testid=${id}]`)));
  check(JSON.stringify(typed) === JSON.stringify(['5.2', '5', '1,000,000', '50,000', '']), `the first line holds what was typed (${typed.join(' | ')})`);

  await page.click('[data-testid=purchase-add-piece]');
  check((await page.getAttribute('[data-testid=line-product-1]', 'data-value')) === String(productId), '"Add another piece" copies the product of the line above');
  check((await eventually(async () => (await focusedTestId(page)) === 'line-gross-1')) && (await page.inputValue('[data-testid=line-net-1]')) === '' && (await page.inputValue('[data-testid=line-cost-1]')) === '', 'and focuses its gross weight; weights and costs are not copied');
  for (const [id, v] of [['line-gross-1', '3.5'], ['line-net-1', '3.25'], ['line-cost-1', '600000']]) await page.fill(`[data-testid=${id}]`, v);
  check((await page.getByTestId('purchase-net-sum').innerText()).includes('8.250'), `the sum of net weights is shown for the supplier's invoice: "${await page.getByTestId('purchase-net-sum').innerText()}"`);
  check((await page.getByTestId('purchase-missing').innerText()).includes('مرجع تحويل'), 'with a making charge, the button waits for the transfer reference');
  await page.fill('[data-testid=purchase-mkc-reference]', 'mkc-ux1-١');
  check((await page.inputValue('[data-testid=purchase-mkc-reference]')) === 'MKC-UX1-1', 'the reference is normalized as typed, with no second copy under the field');
  check((await page.getByTestId('purchase-missing').count()) === 0 && !(await page.getByTestId('purchase-save').isDisabled()), 'complete: no reason left, the button is enabled');
  await shot(page, 'supplier-order-filled');
  await page.click('[data-testid=purchase-save]');
  // SUP-1: the world's supplier still has gold owed: confirm once.
  const confirm = page.getByTestId('purchase-supplier-debt-confirm');
  await Promise.race([confirm.waitFor({ timeout: 15_000 }).then(() => confirm.click()), page.waitForURL((u) => /^\/purchases\/\d+$/.test(u.pathname), { timeout: 15_000 })]);
  await page.waitForURL((u) => /^\/purchases\/\d+$/.test(u.pathname), { timeout: 15_000 });
  const po = await gm.must('GET', `/purchases/${new URL(page.url()).pathname.split('/').pop()}`);
  // PRC-1: each piece is priced live: net weight × the 21K new-piece rate (rounding step 1).
  const rate = (await gm.must('GET', '/gold-rates')).current['21'].pricePerGram;
  const live = po.items.map((i) => i.sellingPrice === Math.round((i.netWeightMg * rate) / 1000));
  check(po.items.length === 2 && po.items.every((i) => i.productName === created.name || i.productNameAr === 'قلادة UX1') && po.items.map((i) => i.netWeightMg).sort().join() === '3250,5000' && live.every(Boolean), 'the order is recorded with both pieces exactly as typed, each priced from the new-piece rate');
}

async function scrapPurchase(page, gm, world) {
  section('Sellable scrap (branch manager): the same picker, karat fixed, customer details optional');
  await signOut(page);
  await signIn(page, world.bm);
  await page.goto(`${BASE}/scrap`);
  await page.click('[data-testid=scrap-kind-SELLABLE]', { timeout: 15_000 });
  await page.selectOption('[data-testid=scrap-karat]', '21');
  const closed = await page.evaluate(() => !document.querySelector('[data-testid=scrap-customer]').open);
  check(closed && !(await page.getByTestId('scrap-customer-name').isVisible()), 'the customer section is closed, labelled optional');
  check((await page.getByTestId('scrap-customer-toggle').innerText()).includes('بيانات العميل (اختياري)'), '"بيانات العميل (اختياري)"');
  await page.click('[data-testid=scrap-product]');
  await page.keyboard.type('خاتم UX1');
  await page.click('[data-testid=scrap-product-create]');
  await page.getByTestId('scrap-new-product').waitFor();
  check((await page.getByTestId('scrap-new-product-karat-fixed').count()) === 1, 'the panel fixes the karat to the scrap karat');
  const types = await gm.must('GET', '/categories');
  const lastTypeId = String(types.find((c) => c.nameAr === 'سلاسل UX1')?.id);
  check(await eventually(async () => (await page.inputValue('[data-testid=scrap-new-product-type]')) === lastTypeId), 'the type defaults to the last one used (once the types have loaded)');
  await page.click('[data-testid=scrap-new-product-save]');
  await page.getByTestId('scrap-new-product').waitFor({ state: 'detached', timeout: 15_000 });
  check(!!(await page.getAttribute('[data-testid=scrap-product]', 'data-value')), 'the new product is selected');
  await page.fill('[data-testid=scrap-gross]', '2.1');
  await page.fill('[data-testid=scrap-net]', '2');
  check((await page.locator('[data-testid=scrap-selling-price]').count()) === 0, 'PRC-1: no selling-price field (the piece follows the used-piece rate)');
  await shot(page, 'scrap-customer-closed');
  await page.click('[data-testid=scrap-customer-toggle]');
  check(await page.getByTestId('scrap-customer-name').isVisible(), 'one click opens the customer details (name, phone, ID document, note)');
  await page.click('[data-testid=scrap-customer-phone]');
  await page.keyboard.type('+249 9a12');
  check((await page.inputValue('[data-testid=scrap-customer-phone]')) === '+249 912', 'the phone takes digits, spaces and a leading + only');
  await shot(page, 'scrap-customer-open');
  await page.fill('[data-testid=scrap-customer-phone]', '');
  check(!(await page.getByTestId('scrap-buy').isDisabled()), 'nothing in the customer section is needed to buy');
  await page.click('[data-testid=scrap-buy]');
  await page.waitForFunction(() => document.querySelector('[data-testid=scrap-net]')?.value === '', null, { timeout: 15_000 });
  const list = await gm.must('GET', '/scrap-purchases?kind=SELLABLE');
  check(list.rows.some((r) => r.netWeightMg === 2000 && !r.customerName), 'the sellable piece is bought without any customer detail');
}

async function narrow(page, world) {
  section('A narrow screen (390 px): no side scroll, 44 px controls');
  await page.setViewportSize({ width: 390, height: 844 });
  // The branch manager is signed in: the scrap form first, then the General Manager's supplier order.
  await page.goto(`${BASE}/scrap`);
  await page.getByTestId('scrap-net').waitFor({ timeout: 15_000 });
  const s = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
  const net = (await page.getByTestId('scrap-net').boundingBox()).height;
  check(s <= 0 && net >= 44, `the scrap form: no horizontal scroll (${s}px), 44 px fields (${net})`);
  await signOut(page);
  await signIn(page, world.gm);
  await page.goto(`${BASE}/purchases`);
  await page.click('[data-testid=new-purchase]', { timeout: 15_000 });
  await page.getByTestId('line-gross-0').waitFor();
  const m = await page.evaluate(() => {
    const h = (id) => document.querySelector(`[data-testid=${id}]`).getBoundingClientRect().height;
    return { scroll: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth, dialog: Math.max(...[...document.querySelectorAll('[role=dialog] *')].map((e) => e.getBoundingClientRect().right)) - window.innerWidth, gross: h('line-gross-0'), product: h('line-product-0'), add: h('purchase-add-piece') };
  });
  check(m.scroll <= 0 && m.dialog <= 1, `the supplier order: no horizontal scroll (page ${m.scroll}px, dialog ${Math.round(m.dialog)}px beyond)`);
  check(m.gross >= 44 && m.product >= 44 && m.add >= 44, `touch targets are at least 44 px (weight ${m.gross}, product ${m.product}, add ${m.add})`);
  if (SHOTS) await shot(page, 'supplier-order-narrow');
  void world;
}

async function main() {
  if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv);
  const gm = await apiClient(BASE);
  await gm.login(world.gm.username, world.gm.password);
  check(true, 'server bootstrapped and filled through the API');
  const browser = await chromium.launch();
  BROWSER = browser;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const page = await ctx.newPage();
    globalThis.__page = page;
    await signIn(page, world.gm);
    await supplierOrder(page, world, gm);
    await scrapPurchase(page, gm, world);
    await narrow(page, world);
  } catch (e) {
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-add-piece-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await gm.dispose();
    await srv.stop();
  }
  console.log(failures ? `\nADD PIECE FAILED: ${failures} of ${step} checks.` : `\nAll ${step} add-piece checks passed.${SHOTS ? ` Screenshots in ${path.relative(ROOT, OUT)}/` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
