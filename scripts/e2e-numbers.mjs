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
//   * The sweep (D-fixnum-3): on the main pages and dialogs with number fields, as the branch manager and the General
//     Manager, every visible number or phone field can be typed in, cleared to empty and typed in again, and stays
//     empty while another field is edited (nothing comes back on its own).
//
//   node scripts/e2e-numbers.mjs

import { apiClient, buildSalesWorld, loadModule, startEmptyServer } from './lib/e2e-world.mjs';
import { confirmIfAsked, eventually, signIn } from './lib/e2e-ui.mjs';

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

const NUMBER_FIELDS = 'input[inputmode=numeric], input[inputmode=decimal], input[inputmode=tel]';
/** Every visible, editable number field inside `scope`, as a locator per field (by test id, else by position). */
async function numberFields(page, scope) {
  const all = page.locator(scope).locator(NUMBER_FIELDS);
  const out = [];
  for (let i = 0; i < (await all.count()); i++) {
    const f = all.nth(i);
    if (!(await f.isVisible()) || !(await f.isEditable())) continue;
    const id = await f.getAttribute('data-testid');
    out.push({ name: id ?? (await f.getAttribute('aria-label')) ?? `#${i + 1}`, at: id ? page.locator(scope).locator(`[data-testid="${id}"]`).first() : f });
  }
  return out;
}
async function replaceText(f, text) {
  await f.click();
  await f.press('Control+A');
  if (text) await f.pressSequentially(text);
  else await f.press('Backspace');
}
/** D-fixnum-3: type, clear, edit another field, type again; nothing comes back on its own. */
async function sweep(page, label, scope = 'main') {
  const fields = await numberFields(page, scope);
  const bad = [];
  for (const [i, f] of fields.entries()) {
    const other = fields[(i + 1) % fields.length];
    await replaceText(f.at, '7');
    const typed = await f.at.inputValue();
    await replaceText(f.at, '');
    const cleared = await f.at.inputValue();
    let after = cleared;
    if (other !== f) {
      await replaceText(other.at, '3');
      await page.waitForTimeout(150);
      after = await f.at.inputValue();
      await replaceText(other.at, '');
    }
    await replaceText(f.at, '5');
    const again = await f.at.inputValue();
    await replaceText(f.at, '');
    if (typed !== '7' || cleared !== '' || after !== '' || again !== '5') bad.push(`${f.name} (typed "${typed}", cleared "${cleared}", after another edit "${after}", again "${again}")`);
  }
  check(fields.length > 0 && bad.length === 0, `${label}: ${fields.length} number field(s) typed in, cleared, left empty while another is edited, typed in again${bad.length ? `; FAILED: ${bad.join('; ')}` : ''}`);
}
async function openDialog(page, trigger, password) {
  await page.click(trigger);
  await page.locator('[role=dialog]').first().waitFor({ timeout: 15_000 });
  if (password && (await page.locator('#reauth-form').count())) {
    await page.fill('[data-testid=reauth-password]', password);
    await page.click('[data-testid=reauth-confirm]');
    await page.waitForTimeout(400);
  }
}

async function sweepBranchManager(page, world) {
  section('The sweep (D-fixnum-3): the branch manager');
  await page.goto(`${BASE}/scrap`);
  await page.getByTestId('scrap-karat-any').waitFor({ timeout: 15_000 });
  await page.fill('[data-testid=scrap-karat-any]', '21');
  await page.fill('[data-testid=scrap-net]', '1');
  await sweep(page, 'Scrap purchase (broken scrap)');
  await page.goto(`${BASE}/pos`);
  await page.getByTestId('pos-product').first().click({ timeout: 15_000 });
  // WSL-1: a grain line of broken scrap (the world holds 21K broken scrap) joins the sweep with its grains field.
  if (await page.getByTestId('pos-grains-21').count()) await page.click('[data-testid=pos-grains-21]');
  await page.click('[data-testid=pos-split-on]', { timeout: 15_000 });
  await page.getByTestId('split-first-amount').waitFor();
  await sweep(page, `Point of sale (split payment${(await page.getByTestId('pos-discount').count()) ? ', discount' : ''}${(await page.getByTestId('pos-grains-qty-21').count()) ? ', grains' : ''})`);
  await page.goto(`${BASE}/cash`);
  await page.getByTestId('cash-count-amount').waitFor({ timeout: 15_000 });
  await sweep(page, 'Cash (the count)');
  await page.goto(`${BASE}/money-transfers`);
  await openDialog(page, '[data-testid=mt-send]', world.bm.password);
  await sweep(page, 'Money transfers: send', '[role=dialog]');
  await page.keyboard.press('Escape');
  const item = (await (await page.request.get(`${BASE}/api/inventory/items?branchId=${world.branchId}`)).json()).rows[0];
  await page.goto(`${BASE}/inventory/${item.id}`);
  const change = page.getByRole('button', { name: 'تغيير السعر' });
  if (await change.count()) {
    await change.click();
    await page.locator('[role=dialog]').first().waitFor({ timeout: 15_000 });
    await sweep(page, 'Piece: change price', '[role=dialog]');
    await page.keyboard.press('Escape');
  }
}

async function sweepGeneralManager(page, world) {
  section('The sweep (D-fixnum-3): the General Manager');
  await page.goto(`${BASE}/settings`);
  await page.locator('main').locator(NUMBER_FIELDS).first().waitFor({ timeout: 15_000 });
  // D-fixnum-4: saving one card keeps what is typed, or cleared, in another card.
  const tolerance = page.locator('[data-testid=count-tolerance] input');
  const staleHours = page.locator('[data-testid=supplier-debt-days] input');
  await replaceText(tolerance, '777');
  await replaceText(staleHours, '');
  await replaceText(page.locator('[data-testid=max-discount-BRANCH_MANAGER] input'), '5');
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/settings' && r.ok(), { timeout: 20_000 });
  await page.click('[data-testid=save-sales]');
  await confirmIfAsked(page, world.gm.password);
  const res = await saved;
  await page.waitForTimeout(800);
  check(
    res.ok() && (await tolerance.inputValue()) === '777' && (await staleHours.inputValue()) === '',
    `saving the Sales card (${res.status()}) keeps another card's unsaved number (777) and its cleared field ("${await tolerance.inputValue()}", "${await staleHours.inputValue()}")`,
  );
  await page.reload();
  await page.locator('main').locator(NUMBER_FIELDS).first().waitFor({ timeout: 15_000 });
  await sweep(page, 'Settings');
  await page.goto(`${BASE}/prices`);
  await page.getByTestId('rates-new').waitFor({ timeout: 15_000 });
  await sweep(page, 'Prices (rates, rounding, guard)');
  await page.goto(`${BASE}/purchases`);
  await openDialog(page, '[data-testid=new-purchase]', world.gm.password);
  await sweep(page, 'New supplier purchase (the piece lines)', '[role=dialog]');
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/cash`);
  await page.getByTestId('funding-advance').click({ timeout: 15_000 });
  await page.locator('#reauth-form, [data-testid=funding-amount]').first().waitFor({ timeout: 15_000 });
  if (await page.locator('#reauth-form').count()) {
    await page.fill('[data-testid=reauth-password]', world.gm.password);
    await page.click('[data-testid=reauth-confirm]');
  }
  await page.getByTestId('funding-amount').waitFor({ timeout: 15_000 });
  await sweep(page, 'Funding: advance', '[role=dialog]');
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/openings`);
  await page.getByTestId('opening-start-TST').click({ timeout: 15_000 });
  await page.waitForURL((u) => /\/openings\/\d+$/.test(u.pathname), { timeout: 15_000 });
  await page.getByTestId('opening-gross').waitFor({ timeout: 15_000 });
  await sweep(page, 'Opening balance draft (a piece, broken scrap)');
}

/** Owner Q2 (FIX-NUM-1): the branch manager's cap is 5 % (set in Settings by the General Manager above). */
async function posDiscount(page) {
  section('POS: a discount above the cap is kept as typed, said, and blocks the sale (owner Q2)');
  await page.goto(`${BASE}/pos`);
  await page.getByTestId('pos-product').first().click({ timeout: 15_000 });
  const disc = page.getByTestId('pos-discount').first();
  await disc.waitFor({ timeout: 15_000 });
  const complete = page.getByTestId('pos-complete');
  check(!(await complete.isDisabled()), 'a cart line with no discount can be sold');
  await replaceText(disc, '99999999');
  await page.waitForTimeout(200);
  const said = await page.getByText(/لا يزيد على/).count();
  check((await disc.inputValue()) === '99999999' && said >= 1, `the typed discount stays (${await disc.inputValue()}) and "At most …" is shown under it`);
  check(await complete.isDisabled(), '"Complete sale" is disabled while the discount is above the cap');
  await replaceText(disc, '');
  await page.waitForTimeout(200);
  check((await disc.inputValue()) === '' && (await page.getByText(/لا يزيد على/).count()) === 0 && !(await complete.isDisabled()), 'cleared: no message, the sale can go on');
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
    await sweepBranchManager(page, world);
    const gmCtx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const gmPage = await gmCtx.newPage();
    globalThis.__page = gmPage;
    await signIn(gmPage, BASE, world.gm);
    await sweepGeneralManager(gmPage, world);
    globalThis.__page = page;
    await posDiscount(page);
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
