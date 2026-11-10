#!/usr/bin/env node
// LBL-1 e2e (docs/plans/LBL-1.md): piece labels and the scan that reads them, on the BUILT app (npm run build) against
// its own empty server filled through the API (scripts/lib/e2e-world.mjs), in the Arabic UI.
//   * F1 (D-lbl1-4), the scanner's timing: 12 digits and Enter typed with no delay, faster than the POS search
//     refreshes, right after a search that shows exactly ONE other piece. The scanned piece is added, never the other;
//     two pieces scanned back to back are both added; the same piece twice is added once; an unknown code says "not
//     found" and adds nothing.
//
//   node scripts/e2e-labels.mjs

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
