#!/usr/bin/env node
// Screen states e2e (UI-A2, D-ui-11/12): every screen shows loading, refresh, empty, error, no-access, not-found
// and crash the same way. Runs on the BUILT app (npm run build) against its own empty server filled through the
// API (scripts/lib/e2e-world.mjs). States are forced with Playwright request interception only: there is no test
// hook in the product. Every state screen is also checked with axe-core (WCAG 2.1 A/AA, no serious or critical
// issue).
//
//   node scripts/e2e-states.mjs

import { apiClient, buildSalesWorld, loadModule, startEmptyServer } from './lib/e2e-world.mjs';

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
  check(bad.length === 0, `axe (${what}): no serious or critical issue${bad.length ? `: ${bad.map((v) => `${v.id} ×${v.nodes.length} (${v.nodes.map((n) => `${n.target.join(' ')}: ${(n.any[0]?.message ?? '').slice(0, 140)}`).join(' | ')})`).join(', ')}` : ''}`);
}

/**
 * Answer GET calls to one API path (exact pathname, any query) with `status` / `body`, or delay them, until `off()`.
 * Only the browser's requests are affected; the server is untouched.
 */
async function intercept(page, pathname, { status = 200, body, delayMs = 0, times = Infinity } = {}) {
  let n = 0;
  const match = (url) => new URL(url).pathname === pathname;
  const handler = async (route) => {
    // A request may already be answered by the time a delayed handler resumes (page left, handler removed).
    const ignore = () => {};
    if (route.request().method() !== 'GET' || n++ >= times) return route.continue().catch(ignore);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (body === undefined && status === 200) return route.continue().catch(ignore);
    const error = status === 403 ? { code: 'FORBIDDEN', message: 'Missing permission: {permission}', key: 'Missing permission: {permission}', params: { permission: 'sales.view' } } : { code: 'INTERNAL', message: 'Internal error' };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? { error }) }).catch(ignore);
  };
  await page.route(match, handler);
  return () => page.unroute(match, handler);
}

const visible = async (page, sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible());

/**
 * A dated list keeps its filters and rows while a new period loads, and shows an error in place of the rows
 * (filters still there) with a Try again that recovers (audit bug: the filters used to vanish on every reload).
 */
async function listStates(page, { path, api, name, quick, rows = 'main table tbody tr' }) {
  await page.goto(`${BASE}${path}`);
  await page.locator(rows).first().waitFor({ timeout: 15_000 });
  const before = await page.locator(rows).count();
  const offSlow = await intercept(page, api, { delayMs: 2500, times: 1 });
  await page.getByRole('button', { name: quick, exact: true }).click();
  await page.locator('[data-state=refreshing]').waitFor({ timeout: 5_000 });
  const during = { rows: await page.locator(rows).count(), from: await visible(page, 'input[aria-label=From]'), spinner: await visible(page, 'main [data-state=loading]') };
  check(during.rows === before && during.from && !during.spinner, `${name}: a new period loads with the rows and the date filter kept on screen (thin bar, no full spinner)`);
  await page.locator('[data-state=refreshing]').waitFor({ state: 'detached', timeout: 10_000 });
  await offSlow();

  const offErr = await intercept(page, api, { status: 500 });
  await page.reload();
  await page.locator('main [data-state=error]').waitFor({ timeout: 15_000 });
  check(await visible(page, 'input[aria-label=From]'), `${name}: a failed load shows the error in place of the rows, the filters stay`);
  await axe(page, `${name} error`);
  await offErr();
  await page.getByTestId('state-retry').click();
  await page.locator(rows).first().waitFor({ timeout: 15_000 });
  ok(`${name}: Try again recovers`);
}

/** Open each screen with every API answer delayed: the first render (no data yet) must never crash. */
async function sweep(page, who, paths) {
  await signIn(page, who);
  const slow = async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue().catch(() => {});
  };
  const isApi = (url) => new URL(url).pathname.startsWith('/api/') && !new URL(url).pathname.startsWith('/api/auth/');
  await page.route(isApi, slow);
  const crashed = [];
  for (const p of paths) {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle');
    if (await page.getByTestId('crash-page').count()) crashed.push(p);
  }
  await page.unroute(isApi, slow);
  check(crashed.length === 0, `${who.username}: ${paths.length} screens render with slow data, no crash page${crashed.length ? ` (crashed: ${crashed.join(', ')})` : ''}`);
  await signOut(page);
}

async function main() {
  const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
  BASE = srv.base;
  const world = await buildSalesWorld(srv);
  {
    const cashier = await apiClient(BASE);
    await cashier.login(world.cashier.username, world.cashier.password);
    const items = (await cashier.must('GET', `/inventory/items?branchId=${world.branchId}&status=AVAILABLE`)).items;
    await cashier.must('POST', '/sales', { items: [{ itemId: items[0].id, discount: 0 }], paymentMethod: 'CASH' }, { idempotent: true });
    await cashier.dispose();
  }
  ok('server bootstrapped and filled through the API (rates, staff, a type, a product, a supplier order, one sale)');
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
    const off = await intercept(page, '/api/branches', { body: { unexpected: true } });
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

    section('Every screen renders while its data is still on the way (no crash page)');
    await sweep(page, world.gm, ['/overview', '/branches', `/branches/${world.branchId}`, '/sales', '/inventory', '/catalog', '/purchases', '/cash', '/scrap', '/transfers', '/reports', '/reports/sales', '/reports/profit', '/users', '/sessions', '/audit', '/settings', '/security', '/me', '/pos']);
    await sweep(page, world.bm, ['/dashboard', '/pos', '/sales', '/inventory', '/transfers', '/scrap', '/catalog', '/purchases', '/cash', '/reports', '/users', '/sessions', '/audit', '/security', '/me']);
    await sweep(page, world.cashier, ['/pos', '/me', '/security']);

    section('Notices: two lines, the security alert first, nothing dismissible');
    await signIn(page, world.gm);
    // Force every notice at once by rewriting the browser's copy of /api/auth/me (the server is untouched). In
    // production mode a database that never had a backup also shows the backup notice.
    const meRoute = async (route) => {
      const res = await route.fetch();
      const me = await res.json();
      me.appMode = 'production';
      me.secondFactor = {
        ...me.secondFactor,
        required: true,
        passkeys: 1,
        userVerification: 'preferred',
        requiredRoles: [],
        newDeviceAlert: { id: 999999, at: new Date().toISOString(), browser: 'Firefox on Windows', ipApprox: '203.0.113.x', method: 'PASSWORD', credentialNickname: null },
      };
      await route.fulfill({ response: res, json: me });
    };
    const isMe = (url) => new URL(url).pathname === '/api/auth/me';
    await page.route(isMe, meRoute);
    await page.goto(`${BASE}/sales`);
    await page.getByTestId('notices').waitFor();
    const levels = await page.locator('[data-testid=notices] > [data-level]').evaluateAll((els) => els.map((e) => `${e.dataset.testid}:${e.dataset.level}`));
    check(levels.length === 2 && levels[0] === 'new-device-alert:lock' && levels[1].endsWith(':critical'), `1366×768: two notices shown, the new-sign-in alert first (${levels.join(', ')})`);
    const more = await page.getByTestId('notices-more').innerText();
    check(/\+ 3 more notices/.test(more), `the others fold into "${more.trim()}"`);
    const alertBox = await page.getByTestId('new-device-alert').evaluate((e) => ({ outline: getComputedStyle(e).boxShadow, bg: getComputedStyle(e).backgroundColor }));
    check(/rgb/.test(alertBox.outline) && (await page.getByTestId('it-was-me').count()) === 1 && (await page.getByTestId('not-me').count()) === 1, 'the new-sign-in alert is the most prominent (ringed, red) with "It was me" / "This wasn’t me"');
    check((await page.locator('[data-testid=notices] [aria-label*=Dismiss], [data-testid=notices] [aria-label*=Close]').count()) === 0, 'no notice has a dismiss button');
    await axe(page, 'notices folded');
    await page.getByTestId('notices-more').click();
    const all = await page.locator('[data-testid=notices] > [data-level]').evaluateAll((els) => els.map((e) => e.dataset.testid));
    check(all.join(',') === 'new-device-alert,enforcement-off-banner,backup-banner,uv-preferred-banner,second-passkey-nag', `"+ more" expands in place, in order: ${all.join(', ')}`);
    check((await page.getByTestId('notice-dot').count()) === 1, 'the avatar dot is on');
    await axe(page, 'notices expanded');
    await page.unroute(isMe, meRoute);
    await signOut(page);

    section('Lists: filters stay, errors are errors (General Manager)');
    await signIn(page, world.gm);
    await listStates(page, { path: '/sales', api: '/api/sales', name: 'Sales', quick: '30d' });
    await listStates(page, { path: '/purchases', api: '/api/purchases', name: 'Supplier purchases', quick: '7d' });

    // Inventory: a failed load is an error, never "No items match these filters" (audit bug).
    let offInv = await intercept(page, '/api/inventory/items', { status: 500 });
    await page.goto(`${BASE}/inventory`);
    await page.locator('main [data-state=error]').waitFor({ timeout: 15_000 });
    check(!/No items match|No pieces in stock/.test(await page.locator('main').innerText()), 'Inventory: a failed load shows the error, not "no items"');
    await offInv();
    await page.getByTestId('state-retry').click();
    await page.locator('main table tbody tr').first().waitFor();
    await page.fill('input[placeholder="Code, barcode or product…"]', 'zz-no-such-piece');
    await page.getByTestId('clear-filters').waitFor({ timeout: 10_000 });
    check(/No items match these filters/.test(await page.locator('main').innerText()), 'Inventory: filters that hide everything say so, with "Clear filters"');
    await page.getByTestId('clear-filters').click();
    await page.locator('main table tbody tr').first().waitFor();
    ok('"Clear filters" brings the pieces back');

    // Slow first load: skeleton in the block, title and filters already there.
    offInv = await intercept(page, '/api/inventory/items', { delayMs: 3000, times: 1 });
    await page.reload();
    await page.locator('main [data-state=loading]').waitFor({ timeout: 5_000 });
    check((await visible(page, 'main h1')) && (await visible(page, 'select[aria-label=Status]')), 'first load: a skeleton in the table, the title and filters already shown');
    await offInv();

    // An API refusal inside an allowed page: no-access in the block, the shell intact.
    const off403 = await intercept(page, '/api/sales', { status: 403 });
    await page.goto(`${BASE}/sales`);
    await page.locator('main [data-state=no-access]').waitFor({ timeout: 15_000 });
    check(!/Something went wrong|Try again/.test(await page.locator('main').innerText()) && (await page.getByTestId('sidebar').count()) === 1, 'Sales answered 403: no-access in the table, no useless "Try again", sidebar intact');
    await axe(page, 'API no-access');
    await off403();
    await signOut(page);

    section('Other screens (General Manager)');
    await signIn(page, world.gm);
    // Settings: a failed load is an error with Try again, never a spinner that turns forever (audit bug).
    const offSet = await intercept(page, '/api/settings', { status: 500 });
    await page.goto(`${BASE}/settings`);
    await page.locator('main [data-state=error]').waitFor({ timeout: 15_000 });
    check((await page.locator('main [data-state=loading], main [role=status]').count()) === 0 && (await visible(page, 'main h1')), 'Settings: a failed load shows an error with Try again (title kept), no endless spinner');
    await offSet();
    await page.getByTestId('state-retry').click();
    await page.getByTestId('save-gold-rates').waitFor({ timeout: 15_000 });
    ok('Settings: Try again loads the page');

    // Security: a failed passkey list is an error, never "No passkey registered yet" (audit bug).
    const offKeys = await intercept(page, '/api/auth/passkeys', { status: 500 });
    await page.goto(`${BASE}/security`);
    await page.locator('main [data-state=error]').first().waitFor({ timeout: 15_000 });
    check(!/No passkey registered yet/.test(await page.locator('main').innerText()), 'Security: a failed passkey list shows an error, not "No passkey registered yet"');
    await axe(page, 'security error');
    await offKeys();

    // POS for a global user: while the branches load, never "No pieces in this branch yet" (audit bug).
    const offBr = await intercept(page, '/api/branches', { delayMs: 3500, times: 1 });
    await page.goto(`${BASE}/pos`);
    await page.locator('main [data-state=loading]').waitFor({ timeout: 5_000 });
    check((await page.getByTestId('pos-no-stock').count()) === 0 && !/No pieces in this branch yet|No matching pieces/.test(await page.locator('main').innerText()), 'POS before the branches load: a skeleton, not "No pieces in this branch yet"');
    await offBr();
    await page.locator('main [data-testid=pos-no-stock], main button:has-text("21")').first().waitFor({ timeout: 15_000 }).catch(() => {});

    // Detail pages: a missing record is "does not exist" with a way back; the back link is there while loading.
    await page.goto(`${BASE}/sales/987654`);
    await page.locator('main [data-state=not-found]').waitFor({ timeout: 15_000 });
    check(/This sale does not exist/.test(await page.locator('main').innerText()) && (await page.getByTestId('back-to-list').count()) === 1, 'a sale that does not exist: "This sale does not exist" with "Back to sales"');
    await axe(page, 'detail not found');

    // Cash: choosing a branch is a neutral prompt, not a blue alert (ANALYSIS §10.3).
    await page.goto(`${BASE}/cash`);
    await page.locator('main [data-state=prompt]').waitFor({ timeout: 15_000 });
    check(/Choose a branch to see its cash/.test(await page.locator('main').innerText()), 'Cash for the General Manager: "Choose a branch to see its cash" as a neutral prompt');

    // A session that ended while signed in: the sign-in page says why.
    await signOut(page); // the server forgets the session; the screen does not know yet
    await page.getByTestId('nav-sales').click();
    await page.waitForURL((u) => u.pathname === '/login', { timeout: 15_000 });
    await page.getByTestId('session-ended').waitFor({ timeout: 10_000 });
    ok('a session that ended while signed in: the sign-in page says "Your session ended. Sign in again."');
    await signIn(page, world.gm);
    await page.goto(`${BASE}/login`);
    check((await page.getByTestId('session-ended').count()) === 0, 'after signing in again the note is gone');
    await page.goto(`${BASE}/overview`);
    await signOut(page);

    section('No access (branch manager)');
    await signIn(page, world.bm);
    await page.goto(`${BASE}/settings`);
    await page.locator('[data-state=no-access]').waitFor();
    check(/You do not have access to this page/.test(await page.locator('main').innerText()) && (await page.getByTestId('go-home').count()) === 1, 'a branch manager opening /settings: no-access with "Go to my home"');
    await axe(page, 'no access');
    // A report the role may not open (deep link): no-access, never "Something went wrong" (audit bug).
    await page.goto(`${BASE}/reports/profit`);
    await page.locator('main [data-state=no-access]').waitFor({ timeout: 15_000 });
    check(/You do not have access to this report/.test(await page.locator('main').innerText()) && !/Something went wrong/.test(await page.locator('main').innerText()), 'a branch manager opening the Profit report by its address: no-access');
    await page.goto(`${BASE}/reports/no-such-report`);
    await page.locator('main [data-state=not-found]').waitFor();
    ok('an unknown report: "This report does not exist" with a way back');
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
