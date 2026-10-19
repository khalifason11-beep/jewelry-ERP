#!/usr/bin/env node
// MIS-1 e2e (docs/plans/MIS-1.md): the General Manager's two mistake-correction dialogs, in the Arabic UI, on the BUILT app
// (npm run build) against its own empty server filled through the API (scripts/lib/e2e-world.mjs).
//   * Scrap › "Void purchase": Save stays grey without a reason of 3 characters and the password; a wrong password voids
//     nothing and the dialog stays; with both the money comes back, the row shows VOIDED with who, when and why, the
//     totals leave it out and say so, and the status filter shows valid or voided purchases only. A sold piece's
//     purchase is refused in the dialog, naming the piece.
//   * Supplier order › "Correct making": one piece's making cost changes, the order's making charge follows, and the
//     history lists it; "Correct" the transfer reference; a reference already on another order asks "Record anyway".
//
//   node scripts/e2e-corrections.mjs            checks
//   node scripts/e2e-corrections.mjs --shots    also the owner's screenshots in docs/acceptance/MIS-1/ (1366×768, Arabic)

import fs from 'node:fs';
import path from 'node:path';
import { apiClient, buildSalesWorld, loadModule, ROOT, startEmptyServer } from './lib/e2e-world.mjs';
import { toWebp } from './lib/screens.mjs';
import { confirmIfAsked, eventually, retype, signIn } from './lib/e2e-ui.mjs';

const { chromium } = loadModule('playwright');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs/acceptance/MIS-1');

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

async function voidScrap(page, gm, world) {
  section('Scrap › Void purchase (General Manager)');
  const [scrap] = (await gm.must('GET', `/scrap-purchases?branchId=${world.branchId}&kind=BROKEN`)).rows;
  const cash0 = (await gm.must('GET', `/cash/reconciliation?branchId=${world.branchId}`)).cashMovement;
  await page.goto(`${BASE}/scrap`);
  const button = page.getByTestId(`scrap-void-${scrap.number}`);
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  await page.getByTestId('scrap-void-dialog').waitFor();
  const confirm = page.getByTestId('scrap-void-dialog-confirm');
  check(await confirm.isDisabled(), 'Save is grey with no reason and no password');
  await page.fill('[data-testid=scrap-void-dialog-reason]', 'خط');
  await page.fill('[data-testid=scrap-void-dialog-password]', world.gm.password);
  check(await confirm.isDisabled(), 'a reason of 2 characters keeps Save grey');
  await page.fill('[data-testid=scrap-void-dialog-reason]', 'اختبار: سُجّل خطأً');
  await page.fill('[data-testid=scrap-void-dialog-password]', 'not-the-password');
  await shot(page, 'void-dialog');
  await confirm.click();
  // The route's re-authentication window (as every General-Manager money action) may ask first: answer it, then the
  // dialog's own wrong password is refused.
  await confirmIfAsked(page, world.gm.password);
  const dialog = page.getByTestId('scrap-void-dialog');
  check(
    await eventually(async () => (await dialog.count()) === 1 && (await dialog.locator('[class*=crit]').count()) > 0) && (await gm.must('GET', `/scrap-purchases/${scrap.id}`)).status === 'VALID',
    'a wrong password voids nothing and the dialog stays open with the refusal',
  );
  await page.fill('[data-testid=scrap-void-dialog-password]', world.gm.password);
  await confirm.click();
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => (await gm.must('GET', `/scrap-purchases/${scrap.id}`)).status === 'VOIDED'), `with the reason and the password ${scrap.number} is voided`);
  const cash1 = (await gm.must('GET', `/cash/reconciliation?branchId=${world.branchId}`)).cashMovement;
  check(cash1 - cash0 === scrap.cashAmount, `the cash part (${scrap.cashAmount}) is back in the drawer`);
  const badge = page.getByTestId(`scrap-voided-${scrap.number}`);
  check(await eventually(async () => (await badge.count()) === 1 && (await badge.innerText()).includes('اختبار: سُجّل خطأً')), 'the row shows VOIDED with who, when and why');
  const totals = page.getByTestId('scrap-totals');
  check(await eventually(async () => (await totals.count()) === 1 && /1/.test(await totals.innerText()) && (await totals.innerText()).includes('ملغاة')), `the totals leave it out and say so: "${(await totals.innerText().catch(() => '')).trim()}"`);
  await shot(page, 'void-done');
  await page.selectOption('[data-testid=scrap-status-filter]', 'VOIDED');
  check(await eventually(async () => (await page.locator('main tbody tr').count()) === 1 && (await page.locator('main tbody tr', { hasText: scrap.number }).count()) === 1), 'the filter "Voided only" lists just that purchase');
  await page.selectOption('[data-testid=scrap-status-filter]', 'VALID');
  check(await eventually(async () => (await page.locator('main tbody tr', { hasText: scrap.number }).count()) === 0), 'the filter "Valid only" leaves it out');
  await page.selectOption('[data-testid=scrap-status-filter]', '');
}

async function voidSoldPiece(page, gm, cashierApi, world) {
  section('Scrap › Void purchase of a piece already sold: refused in the dialog, naming the piece');
  const bought = await gm.must('POST', '/scrap-purchases', { branchId: world.branchId, kind: 'SELLABLE', karat: 21, grossWeightMg: 3_100, netWeightMg: 3_000, productId: world.productId, paymentMethod: 'CASH' }, { idempotent: true });
  await cashierApi.must('POST', '/sales', { items: [{ itemId: bought.itemId }], paymentMethod: 'CASH' }, { idempotent: true }).catch(async () => {
    // PRC-1: the POS sends the price it showed; ask the server for it and confirm with it.
    const [row] = (await cashierApi.must('GET', `/inventory/items?q=${bought.itemCode}`)).rows;
    await cashierApi.must('POST', '/sales', { items: [{ itemId: bought.itemId, listPrice: row.sellingPrice }], paymentMethod: 'CASH' }, { idempotent: true });
  });
  await page.reload();
  const button = page.getByTestId(`scrap-void-${bought.number}`);
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  await page.fill('[data-testid=scrap-void-dialog-reason]', 'اختبار: قطعة مباعة');
  await page.fill('[data-testid=scrap-void-dialog-password]', world.gm.password);
  await page.getByTestId('scrap-void-dialog-confirm').click();
  await confirmIfAsked(page, world.gm.password);
  const dialog = page.getByTestId('scrap-void-dialog');
  check(await eventually(async () => (await dialog.innerText()).includes(bought.itemCode)), `the dialog says piece ${bought.itemCode} is sold; nothing is voided`);
  check((await gm.must('GET', `/scrap-purchases/${bought.id}`)).status === 'VALID', 'the purchase stays valid');
  await page.keyboard.press('Escape');
}

async function correctOrder(page, gm, world) {
  section('Supplier order › Correct making (one piece) and the transfer reference');
  const [order] = (await gm.must('GET', `/purchases?branchId=${world.branchId}`)).rows;
  const before = await gm.must('GET', `/purchases/${order.id}`);
  const piece = before.items[0];
  await page.goto(`${BASE}/purchases/${order.id}`);
  const fix = page.getByTestId(`purchase-fix-making-${piece.code}`);
  await fix.waitFor({ timeout: 15_000 });
  await fix.click();
  await page.getByTestId('purchase-fix-dialog').waitFor();
  check(await page.getByTestId('purchase-fix-dialog-confirm').isDisabled(), 'Save is grey until the new cost, a reason and the password are given');
  await retype(page, 'purchase-fix-cost', '25000');
  await page.fill('[data-testid=purchase-fix-dialog-reason]', 'اختبار: كُتبت المصنعية خطأً');
  await page.fill('[data-testid=purchase-fix-dialog-password]', world.gm.password);
  await shot(page, 'fix-making-dialog');
  await page.getByTestId('purchase-fix-dialog-confirm').click();
  await confirmIfAsked(page, world.gm.password);
  check(
    await eventually(async () => (await gm.must('GET', `/purchases/${order.id}`)).items[0].makingCost === 25_000),
    `${piece.code}: making cost ${piece.makingCost} → 25,000`,
  );
  const after = await gm.must('GET', `/purchases/${order.id}`);
  check(after.makingChargePaid === before.makingChargePaid - piece.makingCost + 25_000, `the order's making charge follows: ${before.makingChargePaid} → ${after.makingChargePaid}`);
  check(after.goldDebtMgPure24 === before.goldDebtMgPure24, 'the supplier gold debt is unchanged');
  const history = page.getByTestId('purchase-corrections');
  check(await eventually(async () => (await history.count()) === 1 && (await history.innerText()).includes(piece.code)), 'the history lists the correction with the piece');
  await shot(page, 'fix-making-done');

  // The transfer reference: a reference already on another order asks "Record anyway".
  const tz = (await gm.must('GET', '/settings')).settings.company.timezone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await gm.must('POST', '/purchases', { branchId: world.branchId, supplierId: world.supplierId, confirmOpenSupplierDebt: true, lines: [{ productId: world.productId, grossWeightMg: 2_100, netWeightMg: 2_000, purchaseCost: 300_000, makingCost: 10_000, otherCost: 0 }], makingChargeReference: 'E2E-TAKEN-1', makingChargeTransferDate: today }, { idempotent: true });
  await page.getByTestId('purchase-fix-reference').click();
  await page.getByTestId('purchase-fix-dialog').waitFor();
  await page.fill('[data-testid=purchase-fix-reference-input]', 'E2E-TAKEN-1');
  await page.fill('[data-testid=purchase-fix-dialog-reason]', 'اختبار: رقم التحويل خطأ');
  await page.fill('[data-testid=purchase-fix-dialog-password]', world.gm.password);
  await page.getByTestId('purchase-fix-dialog-confirm').click();
  await confirmIfAsked(page, world.gm.password);
  const dialog = page.getByTestId('purchase-fix-dialog');
  check(await eventually(async () => (await dialog.count()) === 1 && /E2E|PO/.test(await dialog.innerText())), 'a reference already on another order asks before saving');
  await page.fill('[data-testid=purchase-fix-dialog-password]', world.gm.password);
  await page.getByTestId('purchase-fix-dialog-confirm').click();
  await confirmIfAsked(page, world.gm.password);
  check(await eventually(async () => (await gm.must('GET', `/purchases/${order.id}`)).makingChargeReference === 'E2E-TAKEN-1'), 'confirmed ("Record anyway"): the reference is corrected');
  check(await eventually(async () => (await page.getByTestId('purchase-corrections').locator('tbody tr').count()) === 2), 'the history has both corrections');
}

async function main() {
  if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv, { pieces: 3 });
  const gm = await apiClient(BASE);
  await gm.login(world.gm.username, world.gm.password);
  await gm.reauth(world.gm.password);
  const cashierApi = await apiClient(BASE);
  await cashierApi.login(world.cashier.username, world.cashier.password);
  const browser = await chromium.launch();
  BROWSER = browser;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
    const page = await ctx.newPage();
    globalThis.__page = page;
    await signIn(page, BASE, world.gm);
    await voidScrap(page, gm, world);
    await voidSoldPiece(page, gm, cashierApi, world);
    await correctOrder(page, gm, world);
  } catch (e) {
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-corrections-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await gm.dispose();
    await cashierApi.dispose();
    await srv.stop();
  }
  console.log(failures ? `\nCORRECTIONS FAILED: ${failures} of ${step} checks.` : `\nAll ${step} corrections checks passed.${SHOTS ? ` Screenshots in ${path.relative(ROOT, OUT)}/` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
