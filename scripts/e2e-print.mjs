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
// 72 mm calibration page, A4 calibration page).

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
const FORBIDDEN = /making|prototype|tax invoice|المصنعية|نموذج أولي|ضريبية|cost|profit|تكلفة|ربح/i;
const LONG_40 = 'طقم ذهب عيار 21 مشغول يدوياً بنقشة سودانية'.slice(0, 40);

/** Replace product names in the NEXT print response (layout fixtures; the server data is otherwise untouched). */
async function withNames(page, names) {
  await page.route('**/api/sales/*/print', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    names.forEach((n, i) => {
      if (n && body.document.lines[i]) body.document.lines[i] = { ...body.document.lines[i], name: n, nameAr: n };
    });
    await route.fulfill({ response: res, json: body });
    await page.unroute('**/api/sales/*/print');
  });
}

/**
 * Every negative amount in the print container: the minus sign must be drawn immediately to the LEFT
 * of the digits ("−32,000"), whatever the paper and the surrounding direction. Returns the bad ones.
 */
async function misplacedSigns(page) {
  await page.emulateMedia({ media: 'print' });
  return page.evaluate(() => {
    const bad = [];
    const all = [...document.querySelectorAll('#print-root [data-amount=negative] .pd-amount-digits')];
    for (const el of all) {
      const node = el.firstChild;
      const text = el.textContent;
      if (!text.startsWith('\u2212')) {
        bad.push(`no U+2212: ${text}`);
        continue;
      }
      const range = (a, b) => {
        const r = document.createRange();
        r.setStart(...pos(a));
        r.setEnd(...pos(b));
        return r.getBoundingClientRect();
      };
      // Text may be split across text nodes (React): map offsets over the element's text nodes.
      const nodes = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
      function pos(i) {
        for (const n of nodes) {
          if (i <= n.data.length) return [n, i];
          i -= n.data.length;
        }
        return [nodes[nodes.length - 1], nodes[nodes.length - 1].data.length];
      }
      void node;
      const minus = range(0, 1);
      const digits = range(1, text.length);
      if (!(minus.right <= digits.left + 0.5 && Math.abs(minus.top - digits.top) < 4)) bad.push(text);
    }
    return { count: all.length, bad };
  });
}

/**
 * Orphans in the print container (print media): a line of a multi-line text block that holds only one
 * or two characters (e.g. "م" or "04" alone). Returns the offending tokens.
 */
async function orphans(page) {
  await page.emulateMedia({ media: 'print' });
  const found = await page.evaluate(() => {
    const root = document.getElementById('print-root');
    const out = [];
    const blocks = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement.closest('svg, style, [data-testid=print-ruler]')) continue;
      let block = n.parentElement;
      while (block !== root && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement;
      const lines = blocks.get(block) ?? new Map();
      for (const m of n.data.matchAll(/\S+/g)) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        for (const rect of r.getClientRects()) {
          const top = Math.round(rect.top);
          const key = [...lines.keys()].find((k) => Math.abs(k - top) <= 3) ?? top;
          lines.set(key, (lines.get(key) ?? '') + m[0]);
          break;
        }
      }
      blocks.set(block, lines);
    }
    for (const [, lines] of blocks) {
      if (lines.size < 2) continue;
      for (const [, text] of lines) if (text.length <= 2) out.push(text);
    }
    return out;
  });
  // Stay in print media: switching back fires "afterprint", which empties the print container.
  return found;
}

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
    const footerShown = ((await cashier.locator('#print-root [data-testid=print-footer]').textContent()) ?? '').trim();
    check(/فاتورة/.test(text) && !/نسخة/.test(text), 'original invoice rendered in the print container (Arabic, no COPY mark)');
    check(!/cost|profit|تكلفة|ربح/i.test(text), 'no cost or profit on the printed invoice');
    check(await cashier.locator('#print-root svg[data-barcode] rect').count() > 10, 'Code128 barcode of the invoice number rendered as inline SVG');
    const a4 = await exportPdf(cashier, 'invoice-A4-original.pdf');
    check(a4.visible.length === 1 && a4.visible[0] === 'print-root', 'print media shows ONLY the print container');
    const p1 = pages(a4.pdf);
    check(p1.length >= 1 && Math.abs(p1[0].w - 210) < 1 && Math.abs(p1[0].h - 297) < 1, `A4 page: ${p1[0].w.toFixed(1)} × ${p1[0].h.toFixed(1)} mm`);
    check(await cashier.getByTestId('pos-print').isDisabled(), 'the cashier cannot print it a second time (button disabled)');
    const saleNo = (text.match(/[A-Z]{3}-[A-Z0-9-]+/) ?? [''])[0];
    const footer = (await api(cashier, 'GET', '/meta')).body.branding.invoiceFooterAr;
    check(footer === 'شكراً لتسوقكم معنا', 'configured footer is the thank-you message');
    check(footerShown === footer, 'footer area contains exactly the configured footer, nothing else');
    check(!FORBIDDEN.test(text), 'no "making charges", "prototype" or "tax invoice" text anywhere on the invoice');

    // ── A4: 5 lines, one discounted, one long description → header and cells share their alignment ──
    const me = (await api(cashier, 'GET', '/auth/me')).body;
    const stock = (await api(cashier, 'GET', `/inventory/items?branchId=${me.user.branch.id}&status=AVAILABLE&limit=20`)).body.items;
    const five = stock.slice(0, 5);
    const disc = Math.floor((five[2].sellingPrice * Math.max(1, me.maxDiscountPercent)) / 100 / 1000) * 1000 || 1000;
    const sale5 = await api(cashier, 'POST', '/sales', { items: five.map((it, i) => ({ itemId: it.id, discount: i === 2 ? disc : 0 })), paymentMethod: 'CASH', customerName: 'عميل اختبار الطباعة' });
    check(sale5.status === 200 && sale5.body.items.length === 5 && sale5.body.discountTotal > 0, `5-line sale ${sale5.body.number} with a discounted line`);
    await withNames(cashier, [null, 'سوار ذهب عيار 21 مشغول يدوياً بنقشة سودانية تقليدية مع فصوص زركون وحجر كريم في الوسط — وصف طويل يجب أن يلتف داخل خانته']);
    await cashier.goto(`${BASE}/sales/${sale5.body.id}`);
    await cashier.getByTestId('sale-print').click();
    await cashier.waitForFunction(() => window.__prints === 1, null, { timeout: 10_000 });
    await cashier.emulateMedia({ media: 'print' });
    const align = await cashier.evaluate(() => {
      const table = document.querySelector('#print-root table');
      const edge = (el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const b = r.getBoundingClientRect();
        return { left: b.left, right: b.right };
      };
      const heads = [...table.querySelectorAll('thead th')];
      const rows = [...table.querySelectorAll('tbody tr')];
      return heads.map((th, c) => ({
        header: th.textContent,
        align: getComputedStyle(th).textAlign,
        cellAlign: rows.map((tr) => getComputedStyle(tr.children[c]).textAlign),
        head: edge(th),
        cells: rows.map((tr) => edge(tr.children[c])),
        cellBox: rows.map((tr) => tr.children[c].getBoundingClientRect()),
      }));
    });
    const numeric = align.slice(3); // net weight, price, discount, total (RTL: end = left edge)
    const textual = align.slice(0, 3); // code, description, karat (RTL: start = right edge)
    check(align.every((col) => col.cellAlign.every((a) => a === col.align)), 'every column: header and cells use the same text-align');
    check(numeric.every((col) => col.cells.every((c) => Math.abs(c.left - col.head.left) < 1.5)), 'numeric columns (weight, price, discount, total): header and every value end on the same edge');
    check(textual.every((col) => col.cells.every((c) => Math.abs(c.right - col.head.right) < 1.5)), 'text columns (code, description, karat): header and every value start on the same edge');
    const wrap = await cashier.evaluate(() => {
      const td = document.querySelectorAll('#print-root tbody tr td:nth-child(2)')[1];
      const r = document.createRange();
      r.selectNodeContents(td);
      const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
      const box = td.getBoundingClientRect();
      const text = r.getBoundingClientRect();
      return { lines: tops.size, inside: text.left >= box.left - 1 && text.right <= box.right + 1 };
    });
    check(wrap.lines >= 2 && wrap.inside, `the long description wraps inside its own cell (${wrap.lines} lines)`);
    const s0 = await misplacedSigns(cashier);
    check(s0.count >= 2 && s0.bad.length === 0, `A4: every negative amount reads "−32,000" (${s0.count} checked: table and summary)`);
    const o0 = await orphans(cashier);
    check(o0.length === 0, `A4 invoice: no code, karat, date or digit broken onto its own line${o0.length ? ` (found: ${o0.join(' | ')})` : ''}`);
    const five4 = await exportPdf(cashier, 'invoice-A4-5-lines.pdf');
    check(Math.abs(pages(five4.pdf)[0].w - 210) < 1, 'A4 PDF of the 5-line invoice exported');

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
    check(LONG_40.length === 40, 'fixture: a 40-character product name');
    await withNames(gm, [LONG_40]);
    await gm.getByTestId('sale-print').click();
    await gm.waitForFunction(() => window.__prints === 1, null, { timeout: 10_000 });
    const rtext = await printRootText(gm);
    check(/نسخة \/ COPY 1/.test(rtext) && /أُعيدت طباعتها في \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(rtext), 'reprint shows "نسخة / COPY 1" and the reprint date in the short numeric form');
    check(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(rtext) && !/أكتوبر|يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|نوفمبر|ديسمبر/.test(rtext), 'receipt dates are numeric (no month names)');
    check(rtext.includes(LONG_40), 'the 40-character product name is on the receipt');
    const o1 = await orphans(gm);
    check(o1.length === 0, `72 mm receipt: no orphaned token on its own line${o1.length ? ` (found: ${o1.join(' | ')})` : ''}`);
    check(!/cost|profit|تكلفة|ربح/i.test(rtext), 'no cost or profit on the GM’s reprint either');
    const css = await gm.evaluate(() => document.querySelector('#print-root style')?.textContent ?? '');
    check(/size: 72mm \d+mm; margin: 0;/.test(css), `receipt @page rule: ${css.trim()}`);
    const rootWidth = await gm.evaluate(() => document.getElementById('print-root').getBoundingClientRect().width);
    const scroll = await gm.evaluate(() => document.getElementById('print-root').scrollWidth);
    check(scroll <= Math.ceil(rootWidth) + 1, `nothing wider than 72 mm (content ${scroll}px ≤ page ${Math.round(rootWidth)}px)`);
    const rc = await exportPdf(gm, 'receipt-72mm-reprint.pdf');
    const p2 = pages(rc.pdf);
    check(p2.length === 1 && Math.abs(p2[0].w - 72) < 0.6, `receipt PDF: one page, ${p2[0].w.toFixed(1)} mm wide × ${p2[0].h.toFixed(1)} mm long`);
    // The discounted 5-line sale as a 72 mm receipt (reprint).
    await gm.goto(`${BASE}/sales/${sale5.body.id}`);
    await gm.getByTestId('sale-print').click();
    await gm.waitForFunction(() => window.__prints === 1, null, { timeout: 10_000 });
    const s1 = await misplacedSigns(gm);
    check(s1.count >= 2 && s1.bad.length === 0, `72 mm receipt: every negative amount reads "−32,000" (${s1.count} checked: line and summary)`);
    const o3 = await orphans(gm);
    check(o3.length === 0, `72 mm discounted receipt: no orphaned token${o3.length ? ` (found: ${o3.join(' | ')})` : ''}`);
    const rd = await exportPdf(gm, 'receipt-72mm-discount.pdf');
    check(pages(rd.pdf).length === 1, 'receipt PDF of the discounted 5-line sale exported');
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
    const o2 = await orphans(gm);
    check(o2.length === 0, `72 mm calibration page: no orphaned token${o2.length ? ` (found: ${o2.join(' | ')})` : ''}`);
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
