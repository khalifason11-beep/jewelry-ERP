#!/usr/bin/env node
// Browser check of invoice printing (D-print-*). Drives the real UI in Chromium, replaces
// window.print() by a counter (headless has no print dialog), then exports the print container to
// PDF with print media emulation and the page's own @page size, exactly as Chrome would send it to
// the Windows driver.
//
//   1. start a FRESH demo server (no 2FA):   PGLITE_DIR=/tmp/jerp-print PORT=4100 npm start
//   2. run:   BASE_URL=http://localhost:4100 OUT_DIR=docs/print-check node scripts/e2e-print.mjs
//
// The PDFs written to OUT_DIR are the artifacts of the check (A4 original, 72 mm receipt reprint,
// 72 mm calibration page, A4 calibration page; the Hasad delivery receipt is not exported here).

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function loadPlaywright() {
  for (const base of [process.cwd() + '/', path.join(execSync('npm root -g').toString().trim(), '/')]) {
    try {
      return createRequire(base)('playwright');
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found: npm i -g playwright');
}
const { chromium } = loadPlaywright();
const BASE = process.env.BASE_URL ?? 'http://localhost:4100';
const OUT = process.env.OUT_DIR ?? 'print-check-output';
fs.mkdirSync(OUT, { recursive: true });

let step = 0;
const ok = (m) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${m}`);
const check = (c, m) => {
  if (!c) throw new Error(`FAILED: ${m}`);
  ok(m);
};
const mm = (pt) => (pt * 25.4) / 72;

/** PDF page boxes in mm (Chromium writes one MediaBox per page). */
function pages(pdf) {
  return [...pdf.toString('latin1').matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => ({ w: mm(+m[1]), h: mm(+m[2]) }));
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    window.__prints = 0;
    window.print = () => {
      window.__prints += 1;
    };
  });
  return ctx.newPage();
}
async function signIn(page, username, password) {
  await page.goto(`${BASE}/login`);
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
  await page.fill('input[autocomplete=username]', username);
  await page.fill('input[autocomplete=current-password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
}
async function api(page, method, url, body) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const me = await (await fetch('/api/auth/me')).json();
      const r = await fetch(`/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken, 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    },
    { method, url, body },
  );
}
const prints = (page) => page.evaluate(() => window.__prints);

/** Export what the printer would get: print media, the document's own @page size. */
async function exportPdf(page, file) {
  await page.emulateMedia({ media: 'print' });
  const visible = await page.evaluate(() => [...document.body.children].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || e.tagName));
  const pdf = await page.pdf({ path: path.join(OUT, file), preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  return { pdf, visible };
}
const printRootText = (page) => page.evaluate(() => document.getElementById('print-root')?.textContent ?? '');

async function main() {
  const browser = await chromium.launch();
  try {
    // ── cashier: sale at the POS, original printed once (A4 default) ──
    const cashier = await newPage(browser);
    await signIn(cashier, 'cashier.kh.01', 'demo-cashier-2026');
    await cashier.goto(`${BASE}/pos`);
    await cashier.locator('[data-testid=pos-product]:not([disabled])').first().click();
    await cashier.getByRole('button', { name: /إتمام البيع|Complete Sale/ }).click();
    await cashier.getByTestId('pos-print').waitFor();
    ok('sale completed at the POS; the invoice dialog offers Print');
    await cashier.click('[data-testid=pos-print]');
    await cashier.waitForFunction(() => window.__prints === 1, null, { timeout: 10_000 });
    const text = await printRootText(cashier);
    check(/فاتورة/.test(text) && !/نسخة/.test(text), 'original invoice rendered in the print container (Arabic, no COPY mark)');
    check(!/cost|profit|تكلفة|ربح/i.test(text), 'no cost or profit on the printed invoice');
    check(await cashier.locator('#print-root svg[data-barcode] rect').count() > 10, 'Code128 barcode of the invoice number rendered as inline SVG');
    const a4 = await exportPdf(cashier, 'invoice-A4-original.pdf');
    check(a4.visible.length === 1 && a4.visible[0] === 'print-root', 'print media shows ONLY the print container');
    const p1 = pages(a4.pdf);
    check(p1.length >= 1 && Math.abs(p1[0].w - 210) < 1 && Math.abs(p1[0].h - 297) < 1, `A4 page: ${p1[0].w.toFixed(1)} × ${p1[0].h.toFixed(1)} mm`);
    check(await cashier.getByTestId('pos-print').isDisabled(), 'the cashier cannot print it a second time (button disabled)');
    const saleNo = (text.match(/[A-Z]{3}-[A-Z0-9-]+/) ?? [''])[0];

    // ── GM: switch to a 72 mm receipt, reprint the same sale → COPY 1 ──
    const gm = await newPage(browser);
    await signIn(gm, 'general.manager', 'demo-gm-2026');
    check((await api(gm, 'POST', '/auth/reauth', { password: 'demo-gm-2026' })).status === 200, 'GM re-confirms the password for the settings change');
    const v = (await api(gm, 'GET', '/settings')).body.versions;
    const put = await api(gm, 'PUT', '/settings', {
      changes: { 'print.invoiceFormat': 'RECEIPT', 'print.receiptWidthMm': 72 },
      expectedVersions: { 'print.invoiceFormat': v['print.invoiceFormat'] ?? 0, 'print.receiptWidthMm': v['print.receiptWidthMm'] ?? 0 },
    });
    check(put.status === 200, 'print.invoiceFormat = RECEIPT, print.receiptWidthMm = 72 saved (audited setting change)');
    const sales = (await api(gm, 'GET', `/sales?q=${encodeURIComponent(saleNo)}`)).body;
    const list = Array.isArray(sales) ? sales : sales.rows ?? sales.sales ?? [];
    const sale = list.find((s) => s.number === saleNo) ?? list[0];
    await gm.goto(`${BASE}/sales/${sale.id}`);
    await gm.getByTestId('sale-print').click();
    await gm.waitForFunction(() => window.__prints === 1, null, { timeout: 10_000 });
    const rtext = await printRootText(gm);
    check(/نسخة \/ COPY 1/.test(rtext) && /أُعيدت طباعتها/.test(rtext), 'reprint shows "نسخة / COPY 1" and the reprint date');
    check(!/cost|profit|تكلفة|ربح/i.test(rtext), 'no cost or profit on the GM’s reprint either');
    const css = await gm.evaluate(() => document.querySelector('#print-root style')?.textContent ?? '');
    check(/size: 72mm \d+mm; margin: 0;/.test(css), `receipt @page rule: ${css.trim()}`);
    const rootWidth = await gm.evaluate(() => document.getElementById('print-root').getBoundingClientRect().width);
    const scroll = await gm.evaluate(() => document.getElementById('print-root').scrollWidth);
    check(scroll <= Math.ceil(rootWidth) + 1, `nothing wider than 72 mm (content ${scroll}px ≤ page ${Math.round(rootWidth)}px)`);
    const rc = await exportPdf(gm, 'receipt-72mm-reprint.pdf');
    const p2 = pages(rc.pdf);
    check(p2.length === 1 && Math.abs(p2[0].w - 72) < 0.6, `receipt PDF: one page, ${p2[0].w.toFixed(1)} mm wide × ${p2[0].h.toFixed(1)} mm long`);
    const audit = (await api(gm, 'GET', '/audit?entityType=sale&limit=50')).body;
    check(audit.some((a) => a.action === 'INVOICE_REPRINTED' && a.entityId === sale.number), 'INVOICE_REPRINTED audit entry for the sale');

    // ── GM: calibration page at 72 mm ──
    await gm.goto(`${BASE}/settings`);
    await gm.getByTestId('test-print').click();
    await gm.waitForFunction(() => window.__prints === 1, null, { timeout: 10_000 });
    check((await gm.locator('#print-root [data-testid=print-ruler] > div').count()) >= 72, 'calibration page: a ruler with a tick per mm up to 72');
    const ruler = await gm.evaluate(() => {
      const r = document.querySelector('#print-root [data-testid=print-ruler]').getBoundingClientRect();
      const p = document.getElementById('print-root').getBoundingClientRect();
      return { left: r.left - p.left, right: p.right - r.right };
    });
    check(Math.abs(ruler.left) < 1 && Math.abs(ruler.right) < 1, 'the ruler spans exactly the printable width (edge to edge)');
    const cal = await exportPdf(gm, 'calibration-72mm.pdf');
    const p3 = pages(cal.pdf);
    check(p3.length === 1 && Math.abs(p3[0].w - 72) < 0.6, `calibration PDF: ${p3[0].w.toFixed(1)} × ${p3[0].h.toFixed(1)} mm`);

    // ── settings back to A4; calibration at A4 ──
    const v2 = (await api(gm, 'GET', '/settings')).body.versions;
    await api(gm, 'PUT', '/settings', { changes: { 'print.invoiceFormat': 'A4' }, expectedVersions: { 'print.invoiceFormat': v2['print.invoiceFormat'] } });
    await gm.goto(`${BASE}/settings`);
    await gm.getByTestId('test-print').click();
    await gm.waitForFunction(() => window.__prints === 1, null, { timeout: 10_000 });
    const calA4 = await exportPdf(gm, 'calibration-A4.pdf');
    const p4 = pages(calA4.pdf);
    check(Math.abs(p4[0].w - 210) < 1 && Math.abs(p4[0].h - 297) < 1, 'calibration at A4: 210 × 297 mm');
    await cashier.context().close();
    await gm.context().close();
  } finally {
    await browser.close();
  }
}

main()
  .then(() => console.log(`\nAll ${step} print checks passed. PDFs in ${OUT}/`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
