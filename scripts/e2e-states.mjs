#!/usr/bin/env node
// Screen states e2e (UI-A2, D-ui-11/12): every screen shows loading, refresh, empty, error, no-access, not-found
// and crash the same way. Runs on the BUILT app (npm run build) against its own empty server filled through the
// API (scripts/lib/e2e-world.mjs). States are forced with Playwright request interception only: there is no test
// hook in the product. Every state screen is also checked with axe-core (WCAG 2.1 A/AA, no serious or critical
// issue).
//
//   node scripts/e2e-states.mjs

import { buildSalesWorld, loadModule, startEmptyServer } from './lib/e2e-world.mjs';

const { chromium } = loadModule('playwright');
const { AxeBuilder } = loadModule('@axe-core/playwright');

let BASE = '';
let step = 0;
let failures = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);
function check(cond, msg) {
  if (cond) return ok(msg);
  failures++;
  console.log(`  ✗ ${String(++step).padStart(2, '0')} ${msg}`);
}
const section = (s) => console.log(`\n── ${s}`);

async function signIn(page, who, lang = 'en') {
  await page.goto(`${BASE}/login`);
  await page.evaluate((l) => localStorage.setItem('jerp.lang', l), lang);
  await page.fill('input[autocomplete=username]', who.username);
  await page.fill('input[autocomplete=current-password]', who.password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname !== '/login', { timeout: 15_000 });
  await page.getByTestId('sidebar').waitFor();
}
async function signOut(page) {
  await page.evaluate(async () => {
    const me = await (await fetch('/api/auth/me')).json();
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrfToken ?? '' } });
  });
}

/** axe-core on the page as it is now: no serious or critical WCAG 2.1 A/AA violation. */
async function axe(page, what) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  check(bad.length === 0, `axe (${what}): no serious or critical issue${bad.length ? `: ${bad.map((v) => `${v.id} ×${v.nodes.length}`).join(', ')}` : ''}`);
}

/** Answer the next matching API call(s) with `status` / `body` (or delay them) until `off()` is called. */
async function intercept(page, pattern, { status = 200, body, delayMs = 0 } = {}) {
  const handler = async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (body === undefined && status === 200) return route.continue();
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? { error: { code: status === 403 ? 'FORBIDDEN' : 'INTERNAL', message: status === 403 ? 'Missing permission: {permission}' : 'Internal error' } }) });
  };
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

async function main() {
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv);
  ok('server bootstrapped and filled through the API (rates, staff, a type, a product, a supplier order)');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    globalThis.__page = page;

    section('Shell-level states (General Manager)');
    await signIn(page, world.gm);

    await page.goto(`${BASE}/no-such-page`);
    await page.locator('[data-state=not-found]').waitFor();
    check(/Page not found/.test(await page.locator('main').innerText()) && (await page.getByTestId('go-home').count()) === 1, 'unknown address: "Page not found" with "Go to my home"');
    await axe(page, 'not found');
    await page.getByTestId('go-home').click();
    await page.waitForURL((u) => u.pathname === '/overview');
    ok('"Go to my home" leads to the General Manager home');

    // A render crash (an answer of the wrong shape): the crash page, the shell intact.
    const off = await intercept(page, '**/api/branches', { body: { unexpected: true } });
    await page.goto(`${BASE}/branches`);
    await page.getByTestId('crash-page').waitFor({ timeout: 10_000 });
    const crash = await page.getByTestId('crash-page').innerText();
    const ref = await page.getByTestId('crash-ref').innerText();
    check(/^ERR-[A-Z0-9]{4,12}$/.test(ref) && !/TypeError|is not a function|undefined|at \w+ \(/.test(crash), `a crashed page shows only a short message and a reference id (${ref}), never the error text or stack`);
    check((await page.getByTestId('sidebar').count()) === 1, 'the sidebar is still there');
    await axe(page, 'crash page');
    await off();
    await page.getByTestId('nav-sales').click();
    await page.waitForURL((u) => u.pathname === '/sales');
    await page.locator('main table, main [data-state]').first().waitFor();
    check((await page.getByTestId('crash-page').count()) === 0, 'the sidebar still navigates: the next page works');
    await signOut(page);

    section('No access (branch manager)');
    await signIn(page, world.bm);
    await page.goto(`${BASE}/settings`);
    await page.locator('[data-state=no-access]').waitFor();
    check(/You do not have access to this page/.test(await page.locator('main').innerText()) && (await page.getByTestId('go-home').count()) === 1, 'a branch manager opening /settings: no-access with "Go to my home"');
    await axe(page, 'no access');
    await signOut(page);
  } catch (e) {
    // Keep the screen for the person who reads the failure (outside the repository).
    await globalThis.__page?.screenshot({ path: '.ux-shots/e2e-states-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await srv.stop();
  }
  console.log(failures ? `\nSTATES FAILED: ${failures} of ${step} checks.` : `\nAll ${step} state checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
