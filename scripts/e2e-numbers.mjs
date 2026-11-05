#!/usr/bin/env node
// FIX-NUM-1 e2e (docs/plans/FIX-NUM-1.md): number fields that the user can always clear and type over, on the BUILT
// app (npm run build) against its own empty server filled through the API (scripts/lib/e2e-world.mjs), in Arabic.
//   * Every number field (D-fixnum-2): typing over a shown grouped number ("100,000") replaces it, by Tab or by a click
//     and select-all; it can be cleared to empty. (Playwright's `fill` selects the text before it focuses the field,
//     which no person does; on a number field shown grouped, a test clicks it first.)
//
//   node scripts/e2e-numbers.mjs

import { apiClient, buildSalesWorld, loadModule, startEmptyServer } from './lib/e2e-world.mjs';
import { signIn } from './lib/e2e-ui.mjs';

const { chromium } = loadModule('playwright');

let BASE = '';
let step = 0;
let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${String(++step).padStart(2, '0')} ${msg}`);
  if (!cond) failures++;
}
const section = (s) => console.log(`\n── ${s}`);
const val = (page, id) => page.inputValue(`[data-testid=${id}]`);

async function typeOver(page) {
  section('Typing over a shown grouped number (D-fixnum-2), on the scrap form’s drawer field');
  await page.goto(`${BASE}/scrap`);
  await page.fill('[data-testid=scrap-karat-any]', '21');
  await page.fill('[data-testid=scrap-net]', '1');
  const cash = '[data-testid=scrap-cash-part]';
  await page.fill(cash, '100000');
  await page.click('[data-testid=scrap-net]');
  check((await val(page, 'scrap-cash-part')) === '100,000', 'not focused, the number is shown grouped (100,000)');
  await page.click(cash);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('120000');
  check((await val(page, 'scrap-cash-part')) === '120000', `a click, select all and a new number replaces it ("${await val(page, 'scrap-cash-part')}")`);
  await page.click('[data-testid=scrap-net]');
  await page.click(cash);
  await page.fill(cash, '');
  check((await val(page, 'scrap-cash-part')) === '', `it can be cleared to empty ("${await val(page, 'scrap-cash-part')}")`);
  // By the keyboard: Tab into the field selects its text; the typed digit replaces it.
  await page.fill(cash, '100000');
  await page.click('[data-testid=scrap-net]');
  await page.focus('[data-testid=scrap-net]');
  for (let i = 0; i < 12 && !(await page.locator(cash).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await page.keyboard.type('7');
  check((await val(page, 'scrap-cash-part')) === '7', `Tab into "100,000" and type 7: the field holds 7 ("${await val(page, 'scrap-cash-part')}")`);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  check((await val(page, 'scrap-cash-part')) === '', 'select all and delete: empty');
}

async function main() {
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv, { pieces: 1 });
  const bmApi = await apiClient(BASE);
  await bmApi.login(world.bm.username, world.bm.password);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const page = await ctx.newPage();
    globalThis.__page = page;
    await signIn(page, BASE, world.bm);
    await typeOver(page);
  } catch (e) {
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-numbers-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await bmApi.dispose();
    await srv.stop();
  }
  console.log(failures ? `\nNUMBERS FAILED: ${failures} of ${step} checks.` : `\nAll ${step} number-field checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
