#!/usr/bin/env node
// UI-A1: photograph and check the design system's kitchen-sink page (/ui, development only).
//
//   node scripts/capture-ui-kit.mjs                 # screenshots into docs/ux/ui-kit/ + checks
//   node scripts/capture-ui-kit.mjs --no-shots      # checks only
//
// Starts Vite (frontend only, no backend needed: the page uses static samples), then for Arabic (RTL) and English (LTR):
//   - full-page screenshots at 1366x768, 1536x864 (a 1920x1080 Windows laptop at 125 %) and 1920x1080, plus the
//     open dialog and the toasts at 1366x768;
//   - fonts: IBM Plex Sans Arabic and IBM Plex Sans are loaded (bundled), so Windows shows the same glyphs;
//   - keyboard: a visible focus ring, Tab stays inside an open dialog, Escape closes only the top dialog, focus
//     returns to the opener, a loading button cannot be used;
//   - accessibility: axe-core (WCAG 2.1 A/AA rules, contrast included) reports no serious or critical violation.
// Exit code 1 if any check fails.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadModule, ROOT } from './lib/e2e-world.mjs';
import { toWebp } from './lib/screens.mjs';

const { chromium } = loadModule('playwright');
const { AxeBuilder } = loadModule('@axe-core/playwright');
const OUT = path.join(ROOT, 'docs/ux/ui-kit');
const SHOTS = !process.argv.includes('--no-shots');
const SIZES = [[1366, 768], [1536, 864], [1920, 1080]];
let BROWSER;
/** WebP screenshots (D-ui-10: committed images are WebP and capped by `npm run check:assets`). */
async function shot(page, name, fullPage = false) {
  fs.writeFileSync(path.join(OUT, `${name}.webp`), await toWebp(BROWSER, await page.screenshot({ type: 'png', fullPage })));
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

let failures = 0;
let n = 0;
const check = (ok, what) => {
  n++;
  console.log(`  ${ok ? '✓' : '✗'} ${String(n).padStart(2, '0')} ${what}`);
  if (!ok) failures++;
};

const port = await freePort();
const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(ROOT, 'frontend'), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
BROWSER = browser;
try {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/ui`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (SHOTS) {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
  }

  for (const lang of ['ar', 'en']) {
    console.log(`\n── ${lang === 'ar' ? 'Arabic (RTL)' : 'English (LTR)'}`);
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: lang === 'ar' ? 'ar' : 'en-US' });
      await ctx.addInitScript((l) => localStorage.setItem('jerp.lang', l), lang);
      const page = await ctx.newPage();
      await page.goto(`${base}/ui`);
      await page.getByTestId('ui-kit').waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);

      if (w === 1366) {
        const dir = await page.evaluate(() => document.documentElement.dir);
        check(dir === (lang === 'ar' ? 'rtl' : 'ltr'), `the page is ${lang === 'ar' ? 'right-to-left' : 'left-to-right'}`);
        const fonts = await page.evaluate(() => ({
          arabic: document.fonts.check('15px "IBM Plex Sans Arabic"', 'مرحبا'),
          latin: document.fonts.check('15px "IBM Plex Sans"', 'Hello'),
          loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
        }));
        // The Arabic face also carries Latin glyphs, so an Arabic page never needs the Latin face; an English page does.
        const fontsOk = lang === 'ar' ? fonts.arabic && fonts.loaded.some((f) => /Plex Sans Arabic/.test(f)) : fonts.latin && fonts.loaded.some((f) => /^IBM Plex Sans$/.test(f));
        check(fontsOk, `the bundled fonts are loaded (${[...new Set(fonts.loaded)].join(', ')}), no system fallback`);

        // Focus ring: Tab to the first control; the computed outline is the 2 px gold ring.
        await page.keyboard.press('Tab');
        // Buttons animate their colours for 150 ms (transition-colors includes outline-color): read the settled ring.
        await page.waitForTimeout(400);
        const ring = await page.evaluate(() => {
          const s = getComputedStyle(document.activeElement);
          return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, shadow: s.boxShadow };
        });
        check(ring.style === 'solid' && ring.width === '2px' && /201, 162, 75/.test(ring.color) && /15, 22, 41/.test(ring.shadow), `the keyboard focus ring is visible: 2 px gold outside a navy ring (${ring.color}; ${ring.shadow})`);

        // A loading button is busy and cannot be used.
        const loading = page.getByTestId('kit-btn-primary-loading');
        check((await loading.isDisabled()) && (await loading.getAttribute('aria-busy')) === 'true', 'a loading button is disabled and announced as busy');

        // Dialog: first field focused, Tab trapped, nested Escape, focus returns.
        await page.getByTestId('kit-open-dialog').click();
        const first = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
        check(first === 'kit-dialog-code', 'the dialog opens with its first field focused');
        let inside = true;
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
          inside &&= await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
        }
        check(inside, 'Tab and Shift+Tab stay inside the open dialog (focus trap)');
        const labelled = await page.evaluate(() => {
          const d = document.querySelector('[role=dialog]');
          return !!d && !!document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent;
        });
        check(labelled, 'the dialog is labelled by its title');
        if (SHOTS) await shot(page, `${lang}-${w}x${h}-dialog`);
        await page.getByTestId('kit-dialog-delete').click();
        await page.getByTestId('kit-confirm-delete').waitFor();
        if (SHOTS) await shot(page, `${lang}-${w}x${h}-confirm`);
        await page.keyboard.press('Escape');
        const afterOne = await page.evaluate(() => document.querySelectorAll('[role=dialog]').length);
        await page.keyboard.press('Escape');
        const afterTwo = await page.evaluate(() => document.querySelectorAll('[role=dialog]').length);
        const back = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
        check(afterOne === 1 && afterTwo === 0, 'Escape closes only the topmost dialog, then the next one');
        check(back === 'kit-open-dialog', 'focus returns to the button that opened the dialog');

        // Toasts.
        await page.getByTestId('kit-toast-success').click();
        await page.getByTestId('kit-toast-error').click();
        await page.getByTestId('kit-toast-info').click();
        await page.waitForTimeout(300);
        const roles = await page.evaluate(() => [...document.querySelectorAll('[aria-live] [role]')].map((e) => e.getAttribute('role')));
        check(roles.includes('alert') && roles.includes('status'), `toasts: an error is announced as an alert, the others as status (${roles.join(', ')})`);
        if (SHOTS) await shot(page, `${lang}-${w}x${h}-toasts`);
        await page.reload();
        await page.getByTestId('ui-kit').waitFor();
        await page.evaluate(() => document.fonts.ready);

        // Accessibility scan.
        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const bad = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        for (const v of axe.violations) console.log(`      axe ${v.impact}: ${v.id} (${v.nodes.length}) ${v.help}`);
        check(bad.length === 0, `axe-core (WCAG 2.1 A/AA): no serious or critical violation (${axe.violations.length} minor/moderate, ${axe.passes.length} rules passed)`);
        // Crash page (D-ui-12): a short message and a reference id, never the error text.
        await page.getByTestId('kit-crash').click();
        await page.getByTestId('crash-page').waitFor();
        const crash = await page.getByTestId('crash-page').innerText();
        check(/ERR-[A-Z0-9]{4,12}/.test(crash) && !/Kit crash demo|Error:/.test(crash), 'a crashed block shows only a short message and a reference id');
        await page.reload();
        await page.getByTestId('ui-kit').waitFor();
        await page.evaluate(() => document.fonts.ready);
      }
      if (SHOTS) await shot(page, `${lang}-${w}x${h}`, true);
      await ctx.close();
    }
  }
} catch (e) {
  console.error(viteLog.slice(-2000));
  throw e;
} finally {
  await browser.close();
  try {
    process.kill(-vite.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
}
console.log(failures ? `\nUI KIT FAILED: ${failures} of ${n} checks.` : `\nUI KIT PASSED: ${n} checks.${SHOTS ? ` Screenshots in ${path.relative(ROOT, OUT)}/` : ''}`);
process.exit(failures ? 1 : 0);
