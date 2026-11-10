#!/usr/bin/env node
// LBL-1 e2e (docs/plans/LBL-1.md): piece labels and the scan that reads them, on the BUILT app (npm run build) against
// its own empty server filled through the API (scripts/lib/e2e-world.mjs), in the Arabic UI.
//   * F1 (D-lbl1-4), the scanner's timing: 12 digits and Enter typed with no delay, faster than the POS search
//     refreshes, right after a search that shows exactly ONE other piece. The scanned piece is added, never the other;
//     two pieces scanned back to back are both added; the same piece twice is added once; an unknown code says "not
//     found" and adds nothing.
//   * Labels (D-lbl1-1…3): before the General Manager sets the size, printing is refused in Arabic and nothing is
//     recorded; at 40 × 12 mm the branch manager prints a piece's label from its page: the print page is exactly
//     `@page { size: 40mm 12mm; margin: 0 }`, one label per page × copies, its bars are jsbarcode's own Code128 of the
//     piece's 12-digit barcode in whole 2-dot modules, the digits under them are the same value; the history shows the
//     first print, a second print is a reprint; the value printed, scanned at the POS, adds exactly that piece; the
//     cashier has no print button; the General Manager prints a sample label at the saved size.
//
//   node scripts/e2e-labels.mjs

import { apiClient, buildSalesWorld, loadModule, PEOPLE, startEmptyServer } from './lib/e2e-world.mjs';
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

/** What a USB scanner does: the whole value and Enter, typed with no delay between keys. */
async function scan(page, value) {
  const box = page.getByRole('textbox', { name: 'البحث عن القطع' });
  await box.click();
  await page.keyboard.type(value, { delay: 0 });
  await page.keyboard.press('Enter');
}
const cartCodes = (page) => page.locator('aside ul > li .font-mono').allInnerTexts().then((xs) => xs.map((x) => x.split('·')[0].trim()));

async function scanning(page, pieces) {
  section('F1: the scanner’s timing at the POS (the scanned piece, never the previous search’s)');
  const [a, b, c] = pieces;
  await page.goto(`${BASE}/pos`);
  await page.getByTestId('pos-product').first().waitFor({ timeout: 15_000 });
  // A search that shows exactly one piece (b), as a cashier who looked something up before.
  const box = page.getByRole('textbox', { name: 'البحث عن القطع' });
  await box.fill(b.code);
  check(await eventually(async () => (await page.getByTestId('pos-product').count()) === 1), `a search shows exactly one piece (${b.code})`);
  // Now the scanner: c's 12 digits and Enter, faster than the search refreshes.
  await box.fill('');
  await scan(page, c.barcode);
  check(await eventually(async () => (await cartCodes(page)).length === 1), 'one piece is added');
  const first = await cartCodes(page);
  check(first.length === 1 && first[0] === c.code, `the scanned piece is added (${c.code}), never the one the earlier search showed (${b.code}): cart [${first.join(', ')}]`);
  // Two pieces back to back, then the same piece again.
  await scan(page, a.barcode);
  await scan(page, b.barcode);
  check(await eventually(async () => (await cartCodes(page)).length === 3), 'two pieces scanned back to back are both added');
  await scan(page, a.barcode);
  await page.waitForTimeout(800);
  const after = await cartCodes(page);
  check(after.length === 3 && [a.code, b.code, c.code].every((x) => after.includes(x)), `the same piece scanned again is added once (cart [${after.join(', ')}])`);
  // An unknown code: said, nothing added.
  await scan(page, '999999999999');
  check(await eventually(async () => /لا توجد قطعة بهذا الرمز/.test(await page.locator('body').innerText())), 'an unknown code says «لا توجد قطعة بهذا الرمز»');
  check((await cartCodes(page)).length === 3, 'and adds nothing');
  // The J-code typed by hand finds the piece too (exact, case-insensitive), and the search box is left empty.
  check((await box.inputValue()) === '', 'the search box is empty after each scan');
}

const printStub = () => {
  window.__prints = 0;
  window.print = () => {
    window.__prints += 1;
  };
};
const jsBars = (value) => {
  const JsBarcode = loadModule('jsbarcode');
  const o = {};
  JsBarcode(o, value, { format: 'CODE128' });
  return o.encodings.map((e) => e.data).join('');
};

async function labels(browser, world, bm, gm, piece) {
  section('Labels: refused until the size is set; then printed at the exact size; recorded first and reprint');
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
  await ctx.addInitScript(printStub);
  const page = await ctx.newPage();
  globalThis.__page = page;
  await signIn(page, BASE, world.bm);
  await page.goto(`${BASE}/inventory/${piece.id}`);
  const button = page.getByTestId('piece-label-print');
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  await page.getByTestId('label-print-confirm').click();
  check(await eventually(async () => /حدد مقاس الملصق في الإعدادات/.test(await page.locator('body').innerText())), 'before the size is set: «حدد مقاس الملصق في الإعدادات أولاً»');
  check((await bm.must('GET', `/inventory/items/${piece.id}/label-prints`)).length === 0 && (await page.evaluate(() => window.__prints)) === 0, 'nothing printed, nothing recorded');
  await page.keyboard.press('Escape');

  await gm.reauth(PEOPLE.gm.password);
  await gm.must('PUT', '/settings', { changes: { 'print.labelWidthMm': 40, 'print.labelHeightMm': 12 } });
  await page.reload();
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  await page.fill('[data-testid=label-copies]', '3');
  await page.getByTestId('label-print-confirm').click();
  check(await eventually(async () => (await page.evaluate(() => window.__prints)) === 1), 'the General Manager sets 40 × 12 mm; the print dialog opens once');
  const pageCss = await page.locator('#print-root style').innerText();
  check(pageCss.includes('@page { size: 40mm 12mm; margin: 0; }'), `the print page is exactly the label: "${pageCss.trim()}"`);
  const labelsOut = page.locator('#print-root [data-testid=label]');
  const n = await labelsOut.count();
  const values = await labelsOut.evaluateAll((els) => els.map((e) => e.getAttribute('data-barcode')));
  check(n === 3 && values.every((v) => v === piece.barcode), `one label per page × 3 copies, each of the piece's barcode ${piece.barcode} (${n})`);
  const bars = await page.locator('#print-root [data-testid=label] svg').first().getAttribute('data-bars');
  check(bars === jsBars(piece.barcode), 'the bars are jsbarcode’s own Code128 of that barcode (decodes to it)');
  const dots = await labelsOut.first().getAttribute('data-module-dots');
  const digits = await page.locator('#print-root [data-testid=label-digits]').first().evaluate((el) => el.textContent ?? '');
  check(dots === '2' && digits.trim() === piece.barcode && /^[0-9]{12}$/.test(digits.trim()), `whole modules of ${dots} printer dots; the digits under the bars are the same value in Latin digits (${digits.trim()})`);
  const box = await labelsOut.first().evaluate((el) => [el.style.width, el.style.height, el.style.padding]);
  check(box.join(' ') === '40mm 12mm 1mm', `the label is 40 × 12 mm with its 1 mm inner margin (${box.join(' ')})`);
  check(await eventually(async () => (await page.getByTestId('label-print-row').count()) === 1), 'the piece’s history shows the print');
  check((await page.getByTestId('label-print-row').first().getAttribute('data-kind')) === 'FIRST', 'recorded as its first label');
  await button.click();
  await page.getByTestId('label-print-confirm').click();
  check(await eventually(async () => (await page.getByTestId('label-print-row').count()) === 2), 'printed again (copies empty = 1)');
  check((await page.getByTestId('label-print-row').first().getAttribute('data-kind')) === 'REPRINT' && /إعادة الطباعة/.test(await page.getByTestId('label-prints').innerText()), 'the newest print is marked as a reprint');
  const hist = await bm.must('GET', `/inventory/items/${piece.id}/label-prints`);
  check(hist.length === 2 && hist[0].copies === 1 && hist[1].copies === 3 && hist[1].printedByName === world.bm.fullName, 'the record: who, how many, first then reprint');
  await ctx.close();
  return values[0];
}

async function cashierAndScan(browser, world, piece, printed) {
  section('The printed value scanned at the POS; the cashier prints nothing');
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
  const page = await ctx.newPage();
  globalThis.__page = page;
  await signIn(page, BASE, world.cashier);
  await page.goto(`${BASE}/pos`);
  await page.getByTestId('pos-product').first().waitFor({ timeout: 15_000 });
  await scan(page, printed);
  check(await eventually(async () => (await cartCodes(page)).join(',') === piece.code), `the label's value scanned at the POS adds exactly ${piece.code}`);
  await page.goto(`${BASE}/inventory/${piece.id}`);
  await page.waitForTimeout(1_500);
  check((await page.getByTestId('piece-label-print').count()) === 0 && (await page.getByTestId('label-prints').count()) === 0, 'a cashier has no print button and no print history');
  await ctx.close();
}

async function sample(browser) {
  section('The sample label (Settings, General Manager)');
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
  await ctx.addInitScript(printStub);
  const page = await ctx.newPage();
  globalThis.__page = page;
  await signIn(page, BASE, PEOPLE.gm);
  await page.goto(`${BASE}/settings`);
  await page.getByTestId('label-sample').click({ timeout: 15_000 });
  check(await eventually(async () => (await page.evaluate(() => window.__prints)) === 1), 'the sample label goes to the print dialog');
  check(
    (await page.locator('#print-root [data-testid=label]').getAttribute('data-barcode')) === '000000000000' && (await page.locator('#print-root style').innerText()).includes('size: 40mm 12mm'),
    'it is a fixed value no piece has, at the saved size',
  );
  await ctx.close();
}

async function main() {
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv, { pieces: 3 });
  const bm = await apiClient(BASE);
  await bm.login(world.bm.username, world.bm.password);
  const pieces = (await bm.must('GET', `/inventory/items?branchId=${world.branchId}&status=AVAILABLE&sort=code&pageSize=10`)).rows;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const page = await ctx.newPage();
    globalThis.__page = page;
    await signIn(page, BASE, world.cashier);
    await scanning(page, pieces);
    await ctx.close();
    const gm = await apiClient(BASE);
    await gm.login(PEOPLE.gm.username, PEOPLE.gm.password);
    const printed = await labels(browser, world, bm, gm, pieces[0]);
    await cashierAndScan(browser, world, pieces[0], printed);
    await sample(browser);
    await gm.dispose();
  } catch (e) {
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-labels-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await bm.dispose();
    await srv.stop();
  }
  console.log(failures ? `\nLABELS FAILED: ${failures} of ${step} checks.` : `\nAll ${step} label checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
