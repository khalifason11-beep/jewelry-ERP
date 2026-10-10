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
    // Screens that poll (POS, homes) may never be fully idle: wait for quiet, at most 8 s, then look.
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
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

    section('FIX-1: "Transfer to branch" in the POS cart (branch manager only), and its refusal state');
    await signIn(page, world.cashier);
    await page.getByTestId('pos-product').first().click({ timeout: 15_000 });
    check((await page.getByTestId('pos-transfer').count()) === 0, 'cashier: no "Transfer to branch" in the POS cart');
    await signOut(page);
    // A destination (fixture) and a refusal from the server (a piece sold meanwhile): layout states only.
    const isDir = (url) => new URL(url).pathname === '/api/branches/directory';
    const dir = async (route) => route.fulfill({ json: [{ id: 999_999, code: 'OTH', name: 'Other branch', nameAr: 'فرع آخر' }] }).catch(() => {});
    await page.route(isDir, dir);
    await signIn(page, world.bm);
    await page.goto(`${BASE}/pos`);
    await page.getByTestId('pos-product').first().click({ timeout: 15_000 });
    await page.getByTestId('pos-transfer').click();
    const code = (await page.locator('[role=dialog] li .font-mono').first().innerText()).trim();
    const isTr = (url) => new URL(url).pathname === '/api/transfers';
    const refuse = async (route) => {
      const itemId = route.request().postDataJSON().itemIds[0];
      await route.fulfill({ status: 409, json: { error: { code: 'ITEMS_UNAVAILABLE', message: `${code} no longer available`, key: '{codes} no longer available (sold or moved meanwhile). Nothing was sent: remove it and try again.', params: { codes: code }, details: { unavailable: [{ itemId, code, status: 'SOLD' }] } } } }).catch(() => {});
    };
    await page.route(isTr, refuse);
    await page.selectOption('[data-testid=pos-transfer-to]', '999999');
    await page.fill('[data-testid=pos-transfer-courier]', 'Courier');
    await page.click('[data-testid=pos-transfer-send]');
    await page.getByTestId('pos-transfer-unavailable').waitFor();
    check((await page.getByTestId('pos-transfer-unavailable').innerText()).includes(code) && (await page.getByTestId('pos-transfer-send').isDisabled()), `a piece sold meanwhile: the dialog names it (${code}) and nothing can be sent until it is removed`);
    await axe(page, 'POS transfer refused');
    await page.click('[data-testid=pos-transfer-remove]');
    check((await page.locator('[role=dialog] li .font-mono').count()) === 0, '"Remove from the cart" takes the piece out of the cart');
    await page.unroute(isTr, refuse);
    await page.unroute(isDir, dir);
    await page.keyboard.press('Escape');
    await signOut(page);

    section('Notices: only what must interrupt stays above the page; the rest is in the attention list (UI-B)');
    await signIn(page, world.gm);
    // Force every cause at once by rewriting the browser's copies of /api/auth/me and /api/attention (the server is
    // untouched): above the page only the security lock, "Was this you?" and second-factor-off remain (UI-A2 rules);
    // the backup, touch-only and one-passkey causes are lines of the attention list (D-ui-18, owner condition Q2).
    const meRoute = async (route) => {
      const res = await route.fetch();
      const me = await res.json();
      me.appMode = 'production';
      me.lockedAccounts = [{ id: 999998, username: 'cashier.locked', fullName: 'Locked Cashier', fullNameAr: 'كاشير مقفل', lockedAt: new Date().toISOString() }];
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
    const forced = [
      { id: 'A9', code: 'A9', severity: 'critical', branchId: null, count: 1, link: '/settings#backups', params: { reasons: 'BACKUP_NEVER', backupAgeHours: null, verifyAgeHours: null, maxAgeHours: 26, maxVerifyAgeDays: 35 }, since: null },
      { id: 'S2', code: 'S2', severity: 'warning', branchId: null, count: 1, link: '/settings#second-factor', params: {}, since: null },
      { id: 'S1', code: 'S1', severity: 'info', branchId: null, count: 1, link: '/security', params: {}, since: null },
    ];
    const attRoute = async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const signals = [...forced, ...body.signals.filter((x) => !['A9', 'S1', 'S2'].includes(x.code))];
      const counts = { critical: 0, warning: 0, info: 0 };
      for (const x of signals) counts[x.severity]++;
      await route.fulfill({ response: res, json: { ...body, signals, counts } });
    };
    const isMe = (url) => new URL(url).pathname === '/api/auth/me';
    const isAtt = (url) => new URL(url).pathname === '/api/attention';
    await page.route(isMe, meRoute);
    await page.route(isAtt, attRoute);
    await page.goto(`${BASE}/sales`);
    await page.getByTestId('notices').waitFor();
    const levels = await page.locator('[data-testid=notices] > [data-level]').evaluateAll((els) => els.map((e) => `${e.dataset.testid}:${e.dataset.level}`));
    check(levels.length === 2 && levels[0] === 'security-locked-banner:lock' && levels[1] === 'new-device-alert:lock', `1366×768: two notices shown, the security-locked account first, then the new-sign-in alert (${levels.join(', ')})`);
    const more = await page.getByTestId('notices-more').innerText();
    check(/\+ 1 more notices/.test(more), `the third folds into "${more.trim()}"`);
    check(/cashier\.locked/.test(await page.getByTestId('security-locked-banner').innerText()), 'LOCK-1: the managers\' notice names the locked account');
    const alertBox = await page.getByTestId('new-device-alert').evaluate((e) => ({ outline: getComputedStyle(e).boxShadow, bg: getComputedStyle(e).backgroundColor }));
    check(/rgb/.test(alertBox.outline) && (await page.getByTestId('it-was-me').count()) === 1 && (await page.getByTestId('not-me').count()) === 1, 'the new-sign-in alert is the most prominent (ringed, red) with "It was me" / "This wasn’t me"');
    check((await page.locator('[data-testid=notices] [aria-label*=Dismiss], [data-testid=notices] [aria-label*=Close]').count()) === 0, 'no notice has a dismiss button');
    await axe(page, 'notices folded');
    await page.getByTestId('notices-more').click();
    const all = await page.locator('[data-testid=notices] > [data-level]').evaluateAll((els) => els.map((e) => e.dataset.testid));
    check(all.join(',') === 'security-locked-banner,new-device-alert,enforcement-off-banner', `"+ more" expands in place, in order: lock, new sign-in, then critical (${all.join(', ')})`);
    check((await page.locator('[data-testid=backup-banner], [data-testid=uv-preferred-banner], [data-testid=second-passkey-nag]').count()) === 0, 'the backup, touch-only and one-passkey notices are not above the page');
    check((await page.getByTestId('notice-dot').count()) === 1, 'the avatar dot is on');
    await axe(page, 'notices expanded');
    // The attention control: the count of warning and critical lines, in the colour of the highest (critical here).
    const btn = page.getByTestId('attention-button');
    await page.waitForFunction(() => document.querySelector('[data-testid=attention-button]')?.getAttribute('data-severity') === 'critical', null, { timeout: 15_000 });
    const n = Number(await page.getByTestId('attention-count').innerText());
    check(n >= 2 && /\bbg-crit\b/.test((await page.getByTestId('attention-count').getAttribute('class')) ?? ''), `the attention count (${n}) counts the critical backup and the touch-only warning, in the critical colour`);
    await btn.click();
    await page.getByTestId('attention-menu').waitFor();
    const lines = await page.locator('[data-testid=attention-menu] [data-testid=attention-line]').evaluateAll((els) => els.map((e) => `${e.dataset.code}:${e.dataset.severity}`));
    check(lines[0] === 'A9:critical' && lines.includes('S2:warning') && lines.includes('S1:info') && lines.length <= 5, `the attention list: the backup first (critical), then touch-only keys and only one passkey, at most 5 lines (${lines.join(', ')})`);
    const menuText = await page.getByTestId('attention-menu').innerText();
    check(/Backups need attention/.test(menuText) && /only one passkey/.test(menuText) && /Touch-only security keys/.test(menuText), 'each line says what is wrong');
    check((await page.getByTestId('attention-open-home').count()) === 1, '"Open the list on my home" closes the list');
    await axe(page, 'attention list');
    await page.locator('[data-testid=attention-menu] [data-code=A9]').click();
    await page.waitForURL(/\/settings/);
    ok('the backup line opens Settings (the screen that fixes it)');
    await page.unroute(isAtt, attRoute);
    // A failed /attention: the list says so; the rest of the page still works.
    const offAtt = await intercept(page, '/api/attention', { status: 500 });
    await page.goto(`${BASE}/sales`);
    await page.locator('main table tbody tr, main [data-state]').first().waitFor({ timeout: 15_000 });
    await page.getByTestId('attention-button').click();
    await page.getByTestId('attention-error').waitFor({ timeout: 20_000 });
    check((await page.locator('main table tbody tr').count()) > 0, 'a failed attention list shows an error in its panel; the page itself still renders');
    await axe(page, 'attention error');
    await offAtt();
    await page.keyboard.press('Escape');
    await page.unroute(isMe, meRoute);
    await signOut(page);

    section('Cashier: no attention control');
    await signIn(page, world.cashier);
    check((await page.getByTestId('attention-button').count()) === 0, 'the cashier\'s top bar has no attention control (D-ux-14)');
    await signOut(page);

    section('GM home: blocks load and fail on their own; the period is remembered (UI-B)');
    await signIn(page, world.gm);
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('jerp.home.period')).forEach((k) => localStorage.removeItem(k)));
    await page.goto(`${BASE}/overview`);
    await page.getByTestId('home-sales').waitFor({ timeout: 15_000 });
    const checked = async () => page.locator('[role=radiogroup] [aria-checked=true]').innerText();
    check((await checked()) === 'Today', 'the GM home opens on Today');
    await page.locator('[role=radiogroup] [role=radio]', { hasText: '7 days' }).click();
    await page.reload();
    await page.getByTestId('home-sales').waitFor({ timeout: 15_000 });
    check((await checked()) === '7 days', 'the chosen period is remembered across a reload');
    await page.locator('[role=radiogroup] [role=radio]', { hasText: 'Today' }).click();
    let offDash = await intercept(page, '/api/dashboard/company', { delayMs: 2500 });
    await page.reload();
    await page.locator('main [data-state=loading]').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('home-attention').waitFor();
    ok('while the figures load they show their skeleton; the attention list is already there');
    await page.getByTestId('home-sales').waitFor({ timeout: 15_000 });
    await offDash();
    offDash = await intercept(page, '/api/dashboard/company', { status: 500 });
    await page.reload();
    await page.locator('main [data-state=error]').first().waitFor({ timeout: 20_000 });
    check((await page.getByTestId('home-attention').count()) === 1 && (await page.getByTestId('home-sales').count()) === 0, 'figures that fail show an error in their block; the attention list stays');
    await axe(page, 'GM home, figures failed');
    await offDash();
    const offAttention = await intercept(page, '/api/attention', { status: 500 });
    await page.reload();
    await page.locator('[data-testid=home-attention] [data-state=error]').waitFor({ timeout: 20_000 });
    check((await page.getByTestId('home-sales').count()) === 1 && (await page.getByTestId('home-branch-strip').count()) > 0, 'an attention list that fails shows an error in its panel; the figures and the branch strips stay');
    await offAttention();
    await page.reload();
    await page.getByTestId('home-sales-line').waitFor({ timeout: 15_000 });
    check((await page.getByTestId('home-gold-position').count()) === 1, 'level 2: the 14-day sales line and the gold position');
    await axe(page, 'GM home');
    await page.selectOption('[data-testid=home-scope]', String(world.branchId));
    await page.waitForURL(/branchId=/);
    check(/branchId=/.test(page.url()) && (await page.getByTestId('home-subtitle').innerText()).includes('·'), 'the scope pill turns the home into one branch’s view (/overview?branchId=)');
    await signOut(page);

    section('Branch manager home: blocks load and fail on their own; no cost (UI-B)');
    await signIn(page, world.bm);
    await page.goto(`${BASE}/dashboard`);
    await page.getByTestId('home-expected-cash').waitFor({ timeout: 15_000 });
    check((await page.locator('[data-testid=home-profit], [data-testid=home-stock-value]').count()) === 0 && !/cost|profit|margin/i.test(await page.locator('main').innerText()), 'the branch manager home has no cost or profit figure or word');
    check((await page.getByTestId('home-team-row').count()) > 0 && (await page.getByTestId('home-stock-today').count()) === 1, 'Team today and the stock of the day are there');
    await axe(page, 'BM home');
    let offBranch = await intercept(page, '/api/dashboard/branch', { delayMs: 2500 });
    await page.reload();
    await page.locator('main [data-state=loading]').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('home-attention').waitFor();
    ok('BM home: the figures show their skeleton while the attention list is already there');
    await page.getByTestId('home-sales').waitFor({ timeout: 15_000 });
    await offBranch();
    offBranch = await intercept(page, '/api/dashboard/branch', { status: 500 });
    await page.reload();
    await page.locator('main [data-state=error]').first().waitFor({ timeout: 20_000 });
    check((await page.getByTestId('home-attention').count()) === 1, 'BM home: failed figures show an error in their block; the attention list stays');
    await offBranch();
    await page.reload();
    await page.getByTestId('home-sales').waitFor({ timeout: 15_000 });
    await page.click('[data-testid=day-other]');
    await page.getByTestId('day-input').waitFor();
    ok('"Another day…" opens the date choice');
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
