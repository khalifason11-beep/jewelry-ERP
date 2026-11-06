#!/usr/bin/env node
// WSL-1 e2e (docs/plans/WSL-1.md): grains (حبات) of broken scrap sold at the POS, on the BUILT app (npm run build)
// against its own empty server filled through the API (scripts/lib/e2e-world.mjs), in the Arabic UI.
//   * the branch manager buys 1.250 g of 21K broken scrap (bank transfer); the cashier's POS shows one product for it,
//     "كسر مكسر 21 — متاح 1.250 جم", with the rate per gram;
//   * added to the cart, the grains field takes the focus; 13 grains (more than the 12 held) is said in Arabic and
//     blocks the sale; 3 grains show 0.300 g and the whole line's price (3 × 0.1 g at 190,000/g = 57,000);
//   * the sale: the receipt on screen and the printed document carry the grain line (grains + grams); the 21K pool is
//     300 mg lower; the sale page shows the line;
//   * the branch manager cancels the sale: the 300 mg are back in the pool.
//
//   node scripts/e2e-grains.mjs

import { apiClient, buildSalesWorld, loadModule, startEmptyServer } from './lib/e2e-world.mjs';
import { eventually, signIn } from './lib/e2e-ui.mjs';

const { chromium } = loadModule('playwright');

let BASE = '';
let step = 0;
let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${String(++step).padStart(2, '0')} ${msg}`);
  if (!cond) failures++;
}
const section = (s) => console.log(`\n── ${s}`);
const digits = (s) => Number(String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^0-9]/g, ''));

async function main() {
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv, { pieces: 1 });
  const bm = await apiClient(BASE);
  await bm.login(world.bm.username, world.bm.password);
  const browser = await chromium.launch();
  const pool21 = async () => (await bm.must('GET', `/scrap-pool?branchId=${world.branchId}`)).branches[0].byKarat.find((k) => k.karat === 21)?.weightMg ?? 0;
  try {
    section('The pool and the product (the branch manager buys broken scrap; the cashier sees it)');
    const start = await pool21();
    await bm.must('POST', '/scrap-purchases', { kind: 'BROKEN', karat: 21, grossWeightMg: 1_250, netWeightMg: 1_250, paymentMethod: 'BANK_TRANSFER', bankReference: 'E2E-GRAINS-1' }, { idempotent: true });
    const held = await pool21();
    const whole = Math.floor(held / 100);
    const g = (mg) => (mg / 1000).toFixed(3);
    check(held === start + 1_250, `the 21K pool of the branch is 1.250 g higher (${g(held)} g)`);
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const page = await ctx.newPage();
    globalThis.__page = page;
    await signIn(page, BASE, world.cashier);
    await page.goto(`${BASE}/pos`);
    const card = page.getByTestId('pos-grains-21');
    await card.waitFor({ timeout: 15_000 });
    const cardText = await card.innerText();
    check(/كسر مكسر 21/.test(cardText) && cardText.includes(g(held)) && /متاح/.test(cardText), `one product for 21K broken scrap: "${cardText.replace(/\s+/g, ' ')}"`);
    check(cardText.includes('190,000'), 'it shows the 21K selling rate per gram (190,000)');

    section('The grains: a whole number; more than available is blocked');
    await card.click();
    const qty = page.getByTestId('pos-grains-qty-21');
    await qty.waitFor();
    check(await qty.evaluate((el) => el === document.activeElement), 'adding it puts the focus in the grains field');
    const complete = page.getByTestId('pos-complete');
    check(await complete.isDisabled(), 'no grains typed yet: "Complete sale" is disabled');
    await page.keyboard.type(String(whole + 1));
    const over = page.getByTestId('pos-grains-over-21');
    check(await eventually(async () => (await over.count()) === 1), `more than available (${whole + 1} > ${whole} grains) is said`);
    check(/أكثر من المتاح/.test(await over.innerText()) && (await complete.isDisabled()), `in Arabic ("${(await over.innerText()).trim()}"), and the sale is blocked`);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('3');
    check(await eventually(async () => (await over.count()) === 0 && !(await complete.isDisabled())), '3 grains: no message, the sale can go on');
    const gramsText = await page.getByTestId('pos-grain-grams-21').innerText();
    const price = digits(await page.getByTestId('pos-grain-price-21').innerText());
    check(gramsText.includes('0.300') && /3 حبة/.test(gramsText), `the line says 3 grains = 0.300 g ("${gramsText.trim()}")`);
    check(price === 57_000, `the line's price is the whole weight at the rate: 0.300 g × 190,000 = 57,000 (${price})`);

    section('The sale, the receipt, the pool');
    const resp = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST');
    await complete.click();
    const r = await resp;
    const sale = await r.json();
    check(r.status() === 200 && sale.total === 57_000 && sale.scrapLines?.[0]?.grains === 3 && sale.scrapLines[0].weightMg === 300, `sale ${sale.number}: 3 grains of 21K, total 57,000`);
    await page.locator('[role=dialog]').waitFor({ state: 'visible', timeout: 15_000 });
    const onScreen = page.locator('[role=dialog] [data-testid=invoice-grain-line]');
    check((await onScreen.count()) === 1 && /3 حبة/.test(await onScreen.innerText()), `the receipt on screen has the grain line ("${(await onScreen.innerText()).replace(/\s+/g, ' ')}")`);
    const printed = await page.evaluate(async (id) => (await (await fetch(`/api/sales/${id}/print`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': (await (await fetch('/api/auth/me')).json()).csrfToken } })).json()), sale.id);
    const pl = printed.document?.lines?.find((l) => l.grains != null);
    check(pl && pl.grains === 3 && pl.netWeightMg === 300 && pl.finalPrice === 57_000 && pl.nameAr === 'كسر مكسر', 'the printed document carries the grain line (3 grains, 0.300 g, 57,000)');
    await page.keyboard.press('Escape');
    check((await pool21()) === held - 300, `the 21K pool is 300 mg lower (${g(held - 300)} g)`);
    check(await eventually(async () => (await page.getByTestId('pos-grains-21').innerText()).includes(g(held - 300)), 15_000), `the POS product now shows ${g(held - 300)} g available`);

    section('The branch manager cancels the sale: the grains go back');
    const bmCtx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const bmPage = await bmCtx.newPage();
    await signIn(bmPage, BASE, world.bm);
    await bmPage.goto(`${BASE}/sales/${sale.id}`);
    await bmPage.getByTestId('sale-grain-line').waitFor({ timeout: 15_000 });
    check(/3 حبة/.test(await bmPage.getByTestId('sale-grain-line').innerText()), 'the sale page shows the grain line');
    await bm.reauth(world.bm.password);
    await bm.must('POST', `/sales/${sale.id}/void`, { reason: 'إرجاع الحبات (e2e)' }, { idempotent: true });
    check((await pool21()) === held, `cancelled: the 21K pool is back at ${g(held)} g`);
    await bmCtx.close();
  } catch (e) {
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-grains-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await bm.dispose();
    await srv.stop();
  }
  console.log(failures ? `\nGRAINS FAILED: ${failures} of ${step} checks.` : `\nAll ${step} grain checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
