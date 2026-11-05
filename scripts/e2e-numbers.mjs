#!/usr/bin/env node
// FIX-NUM-1 e2e (docs/plans/FIX-NUM-1.md): number fields that the user can always clear and type over, on the BUILT
// app (npm run build) against its own empty server filled through the API (scripts/lib/e2e-world.mjs), in Arabic.
//   * Every number field (D-fixnum-2): typing over a shown grouped number ("100,000") replaces it, by Tab or by a click
//     and select-all; it can be cleared to empty. (Playwright's `fill` selects the text before it focuses the field,
//     which no person does; on a number field shown grouped, a test clicks it first.)
//   * The scrap purchase's payment (D-fixnum-1): "Paid from the drawer" and "Paid by bank transfer" start empty; an
//     empty field means "the rest of the amount" and shows that number as a grey hint, never as typed text; a field the
//     user typed in or cleared is never refilled by the other one; the amounts sent are the ones on the screen; the
//     mismatch message and the Buy rule are unchanged; all in cash = nothing to type, all by transfer = one entry;
//     44 px fields on a narrow screen.
//
//   node scripts/e2e-numbers.mjs

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
const val = (page, id) => page.inputValue(`[data-testid=${id}]`);
const hint = (page, id) => page.getAttribute(`[data-testid=${id}]`, 'placeholder');

/** Replace a field's text as a person would: select all, then type (an empty `text` clears it). */
async function retype(page, id, text) {
  await page.click(`[data-testid=${id}]`);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  if (text) await page.keyboard.type(text);
}

async function scrapPayment(page, bmApi) {
  section('Scrap purchase: the two payment fields (D-fixnum-1)');
  await page.goto(`${BASE}/scrap`);
  await page.fill('[data-testid=scrap-karat-any]', '21');
  await page.fill('[data-testid=scrap-net]', '1');
  const mismatch = () => page.getByTestId('scrap-parts-mismatch').count();
  check(await eventually(async () => (await hint(page, 'scrap-cash-part')) === '150,000'), 'an amount exists (1 g at 150,000): the drawer field hints 150,000');
  check((await val(page, 'scrap-cash-part')) === '' && (await val(page, 'scrap-bank-part')) === '' && (await hint(page, 'scrap-bank-part')) === '0', 'both fields start empty: all in cash, the bank field hints 0 (not a typed 0)');
  check((await page.getByTestId('scrap-bank-ref').count()) === 0 && (await mismatch()) === 0, 'all in cash: nothing to type, no reference asked');

  await retype(page, 'scrap-cash-part', '100000');
  await page.getByTestId('scrap-bank-ref').waitFor();
  check((await val(page, 'scrap-bank-part')) === '' && (await hint(page, 'scrap-bank-part')) === '50,000', 'a cash part: the bank field stays empty and hints the rest (50,000); the reference is asked');

  await retype(page, 'scrap-bank-part', '40000');
  check(await eventually(async () => (await mismatch()) === 1), 'parts that do not add up are said inline');
  await retype(page, 'scrap-cash-part', '120000');
  await page.waitForTimeout(200);
  check((await val(page, 'scrap-bank-part')) === '40,000' && (await mismatch()) === 1, 'editing the cash part keeps the typed bank part (40,000): it is never refilled');
  check((await mismatch()) === 1 && (await page.getByTestId('scrap-parts-mismatch').innerText()).includes('160,000'), 'the mismatch adds what is on the screen (120,000 + 40,000 = 160,000)');

  await retype(page, 'scrap-bank-part', '');
  check((await val(page, 'scrap-bank-part')) === '' && (await hint(page, 'scrap-bank-part')) === '30,000', 'the bank part can be cleared: empty again, hinting the rest (30,000)');
  await retype(page, 'scrap-cash-part', '100000');
  await page.waitForTimeout(200);
  check((await val(page, 'scrap-bank-part')) === '' && (await hint(page, 'scrap-bank-part')) === '50,000' && (await mismatch()) === 0, 'after another cash edit the cleared bank part stays empty (nothing comes back)');

  await retype(page, 'scrap-cash-part', '');
  await page.waitForTimeout(200);
  check((await val(page, 'scrap-cash-part')) === '' && (await val(page, 'scrap-bank-part')) === '' && (await page.getByTestId('scrap-bank-ref').count()) === 0, 'the cash part can be cleared too: both empty, all in cash again');

  // All by transfer: one entry.
  await retype(page, 'scrap-bank-part', '150000');
  await page.getByTestId('scrap-bank-ref').waitFor();
  check((await val(page, 'scrap-cash-part')) === '' && (await hint(page, 'scrap-cash-part')) === '0' && (await mismatch()) === 0, 'all by transfer is one entry: the drawer field stays empty and hints 0');
  await page.fill('[data-testid=scrap-bank-ref]', 'FIXNUM-1');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/scrap-purchases');
  await page.getByTestId('scrap-buy').click();
  const body = (await sent).postDataJSON();
  check(body.cashAmount === 0 && body.bankAmount === 150_000 && body.bankReference === 'FIXNUM-1', `the amounts sent are the ones on the screen (cash ${body.cashAmount}, bank ${body.bankAmount})`);
  check(await eventually(async () => (await val(page, 'scrap-net')) === '', 15_000), 'the purchase is recorded (the form is cleared)');
  const last = (await bmApi.must('GET', '/scrap-purchases')).rows[0];
  check(last.paymentMethod === 'BANK_TRANSFER' || (last.bankAmount === 150_000 && last.cashAmount === 0), `recorded as paid by transfer (${last.paymentMethod})`);

  // A split, typed in both fields, recorded as typed.
  await page.fill('[data-testid=scrap-karat-any]', '21');
  await page.fill('[data-testid=scrap-net]', '1');
  await retype(page, 'scrap-bank-part', '50000');
  check(await eventually(async () => (await hint(page, 'scrap-cash-part')) === '100,000'), 'a bank part alone: the drawer field hints the rest (100,000)');
  await page.fill('[data-testid=scrap-bank-ref]', 'FIXNUM-2');
  const sent2 = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/scrap-purchases');
  await page.getByTestId('scrap-buy').click();
  const body2 = (await sent2).postDataJSON();
  check(body2.cashAmount === 100_000 && body2.bankAmount === 50_000, `the hinted rest is what is sent (cash ${body2.cashAmount}, bank ${body2.bankAmount})`);
  check(await eventually(async () => (await val(page, 'scrap-net')) === '', 15_000), 'the split purchase is recorded');
}

async function narrow(browser, world) {
  section('A narrow screen (360 px): the payment fields are 44 px high');
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, locale: 'ar' });
  const page = await ctx.newPage();
  try {
    await signIn(page, BASE, world.bm);
    await page.goto(`${BASE}/scrap`);
    await page.fill('[data-testid=scrap-karat-any]', '21');
    await page.fill('[data-testid=scrap-net]', '1');
    const heights = [];
    for (const id of ['scrap-cash-part', 'scrap-bank-part']) heights.push((await page.locator(`[data-testid=${id}]`).boundingBox())?.height ?? 0);
    check(heights.every((h) => h >= 44), `both fields at least 44 px (${heights.join(', ')})`);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(scroll <= 0, `no sideways scroll (${scroll} px)`);
  } finally {
    await ctx.close();
  }
}

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
    await scrapPayment(page, bmApi);
    await narrow(browser, world);
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
