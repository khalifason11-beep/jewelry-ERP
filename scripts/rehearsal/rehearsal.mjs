#!/usr/bin/env node
// REH-1: empty-database rehearsal (docs/BACKLOG.md §F).
//
// Rehearses the first day of a real installation, in PRODUCTION mode, on REAL PostgreSQL, behind a
// local TLS proxy with a self-signed certificate (started by this script): bootstrap of an empty
// database → the first General Manager signs in, changes the one-time password, registers a passkey
// and saves the recovery codes → creates a branch, a branch manager and a cashier from the screens →
// each new user signs in and sets a personal password. It grows with every backlog phase.
//
// The production start-up checks are NOT relaxed for it: APP_ORIGIN is https://localhost:<port>,
// the passkey relying party is "localhost", and the database is a real PostgreSQL server.
//
//   REHEARSAL_ADMIN_URL=postgresql://<role with CREATEDB>:<password>@localhost:5432/postgres \
//     npm run rehearsal                 # builds the UI first unless --skip-build
//
// Options: --skip-build (reuse frontend/dist), --keep (do not drop the database afterwards),
//          --headed (show the browser). Exit code 0 = every step passed.
// Playwright is resolved from the project, then from the global npm modules (npm i -g playwright).

import { createRequire } from 'node:module';
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareGm, PEOPLE as E2E, startEmptyServer } from '../lib/e2e-world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARGS = new Set(process.argv.slice(2));
const ADMIN_URL = process.env.REHEARSAL_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('REHEARSAL_ADMIN_URL is required: a PostgreSQL role allowed to CREATE DATABASE (it is never a production server).');
  process.exit(2);
}

function loadModule(name) {
  const tries = [ROOT + '/', path.join(ROOT, 'backend') + '/', path.join(execSync('npm root -g').toString().trim(), '/')];
  for (const base of tries) {
    try {
      return createRequire(base)(name);
    } catch {
      /* next */
    }
  }
  throw new Error(`${name} not found (npm i -g ${name})`);
}
const { chromium } = loadModule('playwright');
const pg = loadModule('pg');

// ── reporting ──
let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  ok(msg);
}
const section = (title) => console.log(`\n── ${title}`);

// ── people of the rehearsal (fixture names, clearly not client data; the GM username obeys D-2a-11) ──
const GM = { username: 'rehearsal.alpha', fullName: 'Rehearsal Alpha', password: 'Rehearsal-Alpha-Pass-2026' };
const BRANCH = { code: 'RHA', name: 'Rehearsal Branch A', nameAr: 'فرع التجربة أ', city: 'Rehearsal City' };
const BM = { username: 'rehearsal.bravo', fullName: 'Rehearsal Bravo', role: 'BRANCH_MANAGER', password: 'Rehearsal-Bravo-Pass-2026' };
// CAT-0 fixture names (Arabic only: the English name is optional).
const CAT = { supplier: 'مصنع التجربة', type: 'خواتم التجربة', typeVariant: 'خواتم  التجربـة', product: 'خاتم التجربة', scrapProduct: 'خاتم كسر التجربة', scrapRate21: 95_000 };
const CASHIER = { username: 'rehearsal.charlie', fullName: 'Rehearsal Charlie', role: 'CASHIER', password: 'Rehearsal-Charlie-Pass-2026' };

// ── infrastructure ──
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

function selfSignedCert(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/** TLS-terminating reverse proxy, like the hosting provider's: adds X-Forwarded-For / -Proto. */
function startProxy(tls, port, upstreamPort) {
  const server = https.createServer(tls, (req, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1', 'x-forwarded-proto': 'https' };
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function run(cmd, args, env, cwd) {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitFor(fn, what, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── browser helpers ──
async function virtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}

async function signIn(page, base, username, password) {
  await page.goto(`${base}/login`);
  await page.fill('input[autocomplete=username]', username);
  await page.fill('input[autocomplete=current-password]', password);
  await page.click('button[type=submit]');
}

async function signOut(page) {
  await page.evaluate(async () => {
    const me = await (await fetch('/api/auth/me')).json();
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrfToken ?? '' } });
  });
}

async function changePassword(page, current, next) {
  await page.waitForURL((u) => u.pathname === '/change-password', { timeout: 15_000 });
  const pw = page.locator('input[type=password]');
  await pw.nth(0).fill(current);
  await pw.nth(1).fill(next);
  await pw.nth(2).fill(next);
  await page.click('button[type=submit]');
}

/** A sensitive action may ask for the password and then the passkey (D-1a-8, D-2fa-7). */
async function confirmIfAsked(page, password) {
  await page.waitForTimeout(400);
  if (await page.locator('#reauth-form').count()) {
    await page.fill('#reauth-form input[type=password]', password);
    await page.click('button[form=reauth-form]');
    await page.waitForTimeout(400);
  }
  if (await page.getByTestId('reauth-passkey').count()) await page.click('[data-testid=reauth-passkey]');
}

const apiGet = (page, url) => page.evaluate(async (u) => {
  const r = await fetch(u);
  return { status: r.status, body: await r.json().catch(() => null) };
}, url);

/**
 * UX baseline (scripts/capture-ui-baseline.mjs): when UI_BASELINE_DIR is set, photograph the current
 * screen in Arabic and English at 1366x768 and 1920x1080, then put the page back as it was. Not a check.
 */
async function captureBaseline(page, name) {
  const dir = process.env.UI_BASELINE_DIR;
  if (!dir) return;
  const back = new URL(page.url()).pathname;
  for (const lang of ['ar', 'en']) {
    for (const [w, h] of [[1366, 768], [1536, 864], [1920, 1080]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((l) => localStorage.setItem('jerp.lang', l), lang);
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      const out = path.join(dir, `${lang}-${w}x${h}`);
      fs.mkdirSync(out, { recursive: true });
      await page.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 72 });
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
  await page.goto(new URL(back, page.url()).href);
  await page.waitForLoadState('networkidle');
}

/**
 * Deterministic check of a dialog's autofocus (the cause of the "Save stays disabled" flake in REH-1): with the
 * page's timers paused, the person opens the dialog, clicks the SECOND field, then every pending timer runs and
 * they type. The text must stay in the field they chose, and the first field must stay empty. Before the fix, a
 * 30 ms autofocus timer moved focus (and the typing) into the first field on a busy PC.
 */
async function dialogKeepsChosenField(page, { open, first, second, text, what }) {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000); // the page's (fake) clock, not ours
  try {
    await page.click(`[data-testid=${open}]`);
    const autofocus = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    await page.click(`[data-testid=${second}]`);
    await page.clock.runFor(1_000);
    await page.keyboard.type(text);
    const got = { first: await page.inputValue(`[data-testid=${first}]`), second: await page.inputValue(`[data-testid=${second}]`) };
    check(autofocus === first && got.first === '' && got.second === text, `${what}: opens with the first field focused, and a field the person chose keeps the typing (${JSON.stringify(got)})`);
    await page.fill(`[data-testid=${second}]`, '');
  } finally {
    await page.clock.resume();
  }
}

const pathIs = (page, paths) => page.waitForURL((u) => paths.includes(u.pathname), { timeout: 15_000 });

const EXPENSE_WORDS = /expense|مصروف|مصاريف/i;
// Hasad stays only as a payment channel (REM-2): the POS methods, the Cash receivable, the payment-method setting.
const HASAD_WORDS = /hasad|حصاد|withdrawal|سحوبات|طلب سحب/i;
/** Visit each screen in Arabic and in English; the given wording may not be visible (REM-1, REM-2). */
async function noWords(page, base, paths, who, words, what, selector = 'body') {
  for (const lang of ['ar', 'en']) {
    await page.evaluate((l) => localStorage.setItem('jerp.lang', l), lang);
    for (const p of paths) {
      await page.goto(`${base}${p}`);
      await page.waitForLoadState('networkidle');
      const text = await page.locator(selector).first().innerText();
      check(!words.test(text), `${who}: ${p} (${lang}) shows no ${what}`);
    }
  }
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
}
const noExpenseWords = (page, base, paths, who) => noWords(page, base, paths, who, EXPENSE_WORDS, 'expense wording');

// UI-A1: the sidebar per role equals the approved mockups (docs/ux/mockups/*-home.html; the branch manager also
// sees Active users, owner answer Q6). Listed as the nav test ids, in order.
const SHELL_NAV = {
  gm: ['overview', 'sales', 'inventory', 'transfers', 'scrap', 'catalog', 'purchases', 'cash', 'branches', 'reports', 'users', 'sessions', 'audit', 'settings'],
  bm: ['dashboard', 'pos', 'sales', 'inventory', 'transfers', 'scrap', 'catalog', 'purchases', 'cash', 'reports', 'users', 'sessions', 'audit'],
  cashier: ['pos', 'me'],
};
const COST_WORDS = /cost|profit|margin|تكلفة|التكلفة|ربح|أرباح|الربح|هامش/i;
/** A money figure: thousands separators or two or more decimals (the IP address and small counts are not). */
const MONEY_FIGURE = /\d{1,3}(?:[,٬]\d{3})+|\d+[.٫]\d{2,}/;
/**
 * The app shell for one role: the sidebar items in order, and (for the branch manager and the cashier) no cost or
 * profit word or figure anywhere in the sidebar and the top bar — the opened user menu and notifications included —
 * in both languages. The rate chip shows the public selling rate and is the only figure allowed.
 */
async function checkShell(page, base, who, role, home) {
  await page.goto(`${base}${home}`);
  await page.getByTestId('sidebar').waitFor({ timeout: 15_000 });
  const nav = await page.locator('[data-testid=sidebar] a[data-testid^=nav-]').evaluateAll((as) => as.map((a) => a.dataset.testid.slice(4)));
  check(JSON.stringify(nav) === JSON.stringify(SHELL_NAV[role]), `${who}: the sidebar is ${nav.join(', ')} (as in the mockup)`);
  if (role === 'gm') check(!nav.includes('pos'), `${who}: no Point of Sale in the sidebar`);
  if (role === 'cashier') {
    check((await page.getByTestId('sidebar-toggle').count()) === 0 && (await page.getByTestId('sidebar').boundingBox()).width <= 72, `${who}: icons only, no expand button`);
    check((await page.locator('[data-testid=sidebar] nav').innerText()).trim() === '', `${who}: the icon menu shows no text (names on hover)`);
  }
  if (role === 'gm') return;
  for (const lang of ['ar', 'en']) {
    await page.evaluate((l) => localStorage.setItem('jerp.lang', l), lang);
    await page.goto(`${base}${home}`);
    await page.waitForLoadState('networkidle');
    await page.getByTestId('user-menu').click();
    const userMenu = await page.getByTestId('topbar').innerText();
    await page.getByTestId('notifications').click();
    await page.getByTestId('notifications-menu').waitFor();
    const shell = [await page.getByTestId('sidebar').innerText(), userMenu, await page.getByTestId('topbar').innerText()].join('\n');
    const rate = await page.getByTestId('rate-chip').innerText();
    const rest = shell.split(rate).join(' ');
    check(!COST_WORDS.test(shell) && !MONEY_FIGURE.test(rest), `${who} (${lang}): no cost or profit word or figure in the sidebar, top bar, user menu or notifications`);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
}

/** Empty screens on a new database (UI-A2): the exact English text, and in Arabic no English text left in the block. */
async function emptyStates(page, base, who, screens) {
  for (const lang of ['en', 'ar']) {
    await page.evaluate((l) => localStorage.setItem('jerp.lang', l), lang);
    for (const [p, texts] of screens) {
      await page.goto(`${base}${p}`);
      await page.locator('main [data-state=empty], main [data-state=prompt]').first().waitFor({ timeout: 15_000 });
      await page.waitForLoadState('networkidle');
      const blocks = await page.locator('main [data-state=empty], main [data-state=prompt]').allInnerTexts();
      const main = await page.locator('main').innerText();
      const generic = /Nothing to show|Loading…|لا يوجد ما يُعرض/.test(main);
      if (lang === 'en') check(texts.every((x) => blocks.some((b) => b.includes(x))) && !generic, `${who}: ${p} (en) says "${texts.join('" and "')}"`);
      else check(blocks.length >= texts.length && blocks.every((b) => !/[A-Za-z]{4,}/.test(b)) && !generic, `${who}: ${p} (ar) shows its empty text in Arabic`);
    }
  }
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
}

// ── the rehearsal ──
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-rehearsal-'));
  const dbName = `jerp_rehearsal_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  const cleanup = [];
  let failed = false;
  try {
    section('Setup: empty production-mode installation');
    if (!ARGS.has('--skip-build') || !fs.existsSync(path.join(ROOT, 'frontend/dist/index.html'))) {
      execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    }
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    cleanup.push(async () => {
      if (ARGS.has('--keep')) return console.log(`  (database kept: ${dbName})`);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    });
    const dbUrl = new URL(ADMIN_URL);
    dbUrl.pathname = `/${dbName}`;
    const [appPort, proxyPort] = [await freePort(), await freePort()];
    const origin = `https://localhost:${proxyPort}`;
    const env = { APP_MODE: 'production', DATABASE_URL: dbUrl.toString(), APP_ORIGIN: origin, TRUST_PROXY: '1', PORT: String(appPort), LOG_LEVEL: 'warn', ALLOWED_KARATS_INITIAL: '21' };
    for (const k of ['MIGRATION_DATABASE_URL', 'PGLITE_DIR', 'COOKIE_SECURE', 'WEBAUTHN_RP_ID', 'STRICT_DB_ROLES']) delete process.env[k];

    // 1. Bootstrap (the operator's one-time command): reference data + the first GM, no branch.
    const out = run('npx', ['tsx', 'src/bootstrap-cli.ts', '--username', GM.username, '--full-name', GM.fullName], env, path.join(ROOT, 'backend'));
    const otp = /One-time password[^:]*:\s*(\S+)/.exec(out)?.[1];
    check(!!otp, 'bootstrap on an empty PostgreSQL database prints a one-time password for the first General Manager');

    // 2. The server in production mode, behind the TLS proxy.
    // detached: npx starts the real server as a child, so stop the whole process group (else it outlives the script).
    const server = spawn('npx', ['tsx', 'src/server.ts'], { cwd: path.join(ROOT, 'backend'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let serverLog = '';
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
    cleanup.unshift(async () => {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      if (failed && serverLog) console.error(`\n--- server log ---\n${serverLog.slice(-4000)}`);
    });
    const proxy = await startProxy(selfSignedCert(tmp), proxyPort, appPort);
    cleanup.unshift(() => new Promise((r) => proxy.close(() => r())));
    await waitFor(
      () => new Promise((resolve) => https.get(`${origin}/api/health`, { rejectUnauthorized: false }, (r) => resolve(r.statusCode === 200)).on('error', () => resolve(false))),
      'the server',
    );
    check(!/refusing to start/.test(serverLog), `server started in production mode at ${origin} (real PostgreSQL, https, passkey RP "localhost")`);

    const browser = await chromium.launch({ headless: !ARGS.has('--headed') });
    cleanup.unshift(() => browser.close());
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const meta = await (await page.request.get(`${origin}/api/meta`)).json();
    check(!meta.demoAccounts || meta.demoAccounts.length === 0, 'the login page lists no demo accounts');
    const health = await (await page.request.get(`${origin}/api/health`)).json();
    check(health.ok === true && health.appMode === undefined && health.driver === undefined, 'health check answers in production form (no driver or mode details)');

    section('General Manager: first sign-in');
    await virtualAuthenticator(page);
    // UI-A1 (owner answer Q2): a plain centred sign-in on a white page: the logo, the company name and the form;
    // no marketing panel (1366x768, the narrowest supported laptop size).
    await page.goto(`${origin}/login`);
    await page.locator('input[autocomplete=username]').waitFor();
    const login = await page.evaluate(() => {
      const form = document.querySelector('form').getBoundingClientRect();
      return { text: document.body.innerText, bg: getComputedStyle(document.querySelector('[data-testid=auth-frame]')).backgroundColor, offset: Math.abs(form.left + form.width / 2 - innerWidth / 2) };
    });
    check(
      !/every piece accounted|Multi-branch|متعددة الفروع|كل قطعة محسوبة|قابل للتدقيق/.test(login.text) && login.bg === 'rgb(255, 255, 255)' && login.offset < 4,
      `the sign-in page is plain: white, the form centred (${login.offset.toFixed(1)} px off), no marketing panel`,
    );
    await signIn(page, origin, GM.username, otp);
    await changePassword(page, otp, GM.password);
    ok('one-time password accepted, a personal password is set');
    await page.waitForURL((u) => u.pathname === '/security/setup', { timeout: 15_000 });
    await page.fill('[data-testid=passkey-nickname]', 'Rehearsal PC');
    await page.click('[data-testid=register-passkey]');
    await page.locator('#reauth-form, [data-testid=enroll-codes]').first().waitFor();
    if (await page.locator('#reauth-form').count()) {
      await page.fill('#reauth-form input[type=password]', GM.password);
      await page.click('button[form=reauth-form]');
    }
    await page.getByTestId('enroll-codes').waitFor();
    await page.click('[data-testid=generate-codes]');
    const codes = (await page.getByTestId('recovery-codes').innerText()).split(/\s+/).filter((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c));
    check(codes.length === 10, 'passkey registered (virtual authenticator) and 10 recovery codes shown');
    await page.check('[data-testid=codes-saved]');
    await page.click('[data-testid=codes-done]');
    await pathIs(page, ['/overview']);
    ok('enrollment complete: the company overview opens');
    await captureBaseline(page, '01-general-manager-home');

    section('Empty database: nothing invented');
    const branches0 = await apiGet(page, '/api/branches');
    check(branches0.status === 200 && Array.isArray(branches0.body) && branches0.body.length === 0, 'no branches exist yet');
    const users0 = await apiGet(page, '/api/users');
    check(users0.status === 200 && users0.body.length === 1, 'the only user is the General Manager');
    const drawer0 = await apiGet(page, '/api/cash/drawer');
    check(drawer0.status === 200 && drawer0.body.branches.length === 0, 'no ledger accounts with money (no branches, no opening cash)');
    // UI-A2 (D-ui-11): every list says what is empty, in the screen's own words, in both languages; no generic
    // "Nothing to show", no "Loading…" left behind, no table of zeros.
    await emptyStates(page, origin, 'General Manager', [
      ['/sales', ['No sales in this period']],
      ['/purchases', ['No purchases in this period']],
      ['/inventory', ['No pieces in stock']],
      ['/catalog', ['No products yet']],
      ['/transfers', ['No transfers yet']],
      ['/scrap', ['Choose a branch to buy scrap', 'No scrap bought yet']],
    ]);

    section('REM-3: first steps on an empty system');
    const inv0 = (await apiGet(page, '/api/settings')).body.settings.inventory;
    check(JSON.stringify(inv0.allowedKarats) === '[21]' && inv0.allowedKaratsConfirmed === false, 'ALLOWED_KARATS_INITIAL=21 applied on the first start, not yet confirmed by the General Manager');
    await page.goto(`${origin}/overview`);
    await page.getByTestId('first-steps').waitFor({ timeout: 15_000 });
    const stepState = async () => Object.fromEntries(await Promise.all(['karats', 'rates', 'branch', 'staff'].map(async (k) => [k, await page.getAttribute(`[data-testid=step-${k}]`, 'data-done')])));
    check(Object.values(await stepState()).every((v) => v === 'false'), 'the GM home shows the four first steps (karats, rates, branch, staff), none done');
    const chip = await page.getByTestId('rate-chip').innerText();
    check(/حدّد سعر اليوم/.test(chip) && !/—/.test(chip), 'the rate chip says "Set today’s rate" instead of "—/g"');
    check((await page.getByTestId('demo-badge').count()) === 0, 'production mode shows no "Demo" badge');
    await page.click('[data-testid=step-karats-action]');
    check(await page.isChecked('[data-testid=karat-21]'), 'the confirmation dialog proposes 21K (from ALLOWED_KARATS_INITIAL)');
    await page.click('[data-testid=confirm-karats]');
    await confirmIfAsked(page, GM.password);
    await waitFor(async () => (await page.getAttribute('[data-testid=step-karats]', 'data-done')) === 'true', 'step 1 done', 15_000);
    ok('the General Manager confirms the allowed karats (password re-confirmation): step 1 done');
    await noWords(page, origin, ['/overview', '/settings', '/users'], 'General Manager', /prototype|نموذج أولي|demo account|حسابات تجريبية/i, 'prototype or demo-account wording');

    section('General Manager: branch and staff');
    await page.clock.install(); // fake timers that flow normally; paused only inside dialogKeepsChosenField
    await page.goto(`${origin}/branches`);
    await page.getByTestId('new-branch').waitFor();
    await dialogKeepsChosenField(page, { open: 'new-branch', first: 'branch-code', second: 'branch-name', text: BRANCH.name, what: 'New branch dialog' });
    await page.fill('[data-testid=branch-code]', BRANCH.code);
    await page.fill('[data-testid=branch-name]', BRANCH.name);
    await page.fill('[data-testid=branch-name-ar]', BRANCH.nameAr);
    await page.fill('[data-testid=branch-city]', BRANCH.city);
    await page.click('[data-testid=branch-save]');
    await confirmIfAsked(page, GM.password);
    await waitFor(async () => (await apiGet(page, '/api/branches')).body.some((b) => b.code === BRANCH.code), 'the new branch', 15_000);
    ok(`branch ${BRANCH.code} created from the Branches screen (password + passkey confirmation)`);
    const branchId = (await apiGet(page, '/api/branches')).body.find((b) => b.code === BRANCH.code).id;
    const accounts = (await apiGet(page, '/api/cash/drawer')).body.branches.find((b) => b.branchId === branchId);
    check(accounts && accounts.expectedCash === 0 && accounts.bank === 0, 'the new branch starts at zero cash and zero bank');

    const temps = {};
    for (const u of [BM, CASHIER]) {
      await page.goto(`${origin}/users`);
      await page.getByTestId('new-user').waitFor();
      if (u === BM) await dialogKeepsChosenField(page, { open: 'new-user', first: 'user-username', second: 'user-full-name', text: u.fullName, what: 'New user dialog' });
      else await page.click('[data-testid=new-user]');
      await page.fill('[data-testid=user-username]', u.username);
      await page.fill('[data-testid=user-full-name]', u.fullName);
      await page.selectOption('[data-testid=user-role]', u.role);
      await page.selectOption('[data-testid=user-branch]', String(branchId));
      await page.click('[data-testid=user-save]');
      await confirmIfAsked(page, GM.password);
      await page.getByTestId('temporary-password').waitFor({ timeout: 15_000 });
      temps[u.username] = (await page.getByTestId('temporary-password').innerText()).trim();
      await page.click('[data-testid=temporary-password-done]');
      ok(`${u.role === 'CASHIER' ? 'cashier' : 'branch manager'} "${u.username}" created with a generated temporary password`);
    }
    const types0 = await apiGet(page, '/api/categories');
    const products0 = await apiGet(page, '/api/products');
    const suppliers0 = await apiGet(page, '/api/suppliers');
    check(types0.body.length === 0 && products0.body.length === 0 && suppliers0.body.length === 0, 'no item types, products or suppliers were invented (CAT-0: they come from the client)');
    await page.goto(`${origin}/settings`);
    await page.fill('[data-testid=scrap-rate-21]', String(CAT.scrapRate21));
    await page.click('[data-testid=save-scrap-rates]');
    await confirmIfAsked(page, GM.password);
    await waitFor(async () => (await apiGet(page, '/api/scrap-rates')).body.rates.some((r) => r.karat === 21 && r.pricePerGram === CAT.scrapRate21), 'the 21K scrap rate', 15_000);
    ok('the General Manager sets the 21K scrap buying rate in Settings');
    await page.fill('[data-testid=gold-rate-21]', '190000');
    await page.click('[data-testid=save-gold-rates]');
    await confirmIfAsked(page, GM.password);
    await waitFor(async () => (await apiGet(page, '/api/gold-rates')).body.current['21']?.pricePerGram === 190_000, 'the 21K gold rate', 15_000);
    await page.goto(`${origin}/overview`);
    await page.waitForLoadState('networkidle');
    check((await page.getByTestId('first-steps').count()) === 0 && /190,000/.test(await page.getByTestId('rate-chip').innerText()), 'gold rate set: all four first steps done, the checklist disappears and the rate chip shows the rate');
    await signOut(page);

    section('Staff: first sign-in');
    await signIn(page, origin, BM.username, temps[BM.username]);
    await changePassword(page, temps[BM.username], BM.password);
    await pathIs(page, ['/dashboard']);
    ok('branch manager sets a personal password and lands on the branch dashboard');
    await page.getByTestId('no-stock-yet').waitFor({ timeout: 15_000 });
    ok('the branch dashboard says "Your branch has no stock yet" (with New purchase / Buy scrap), not tables of zeros');
    await captureBaseline(page, '02-branch-manager-home');
    const bmSelf = await apiGet(page, '/api/auth/me');
    check(bmSelf.body.user.branch?.id === branchId, 'the branch manager is bound to the new branch');
    await signOut(page);

    await signIn(page, origin, CASHIER.username, temps[CASHIER.username]);
    await changePassword(page, temps[CASHIER.username], CASHIER.password);
    await pathIs(page, ['/pos']);
    ok('cashier sets a personal password and lands on the point of sale');
    await page.getByTestId('pos-no-stock').waitFor({ timeout: 15_000 });
    ok('the POS says "No pieces in this branch yet" (not "no matching pieces")');
    await captureBaseline(page, '03-cashier-home');
    await checkShell(page, origin, 'cashier', 'cashier', '/pos');
    const cashierUsers = await apiGet(page, '/api/users');
    check(cashierUsers.status === 403, 'the cashier cannot open the user list (403)');
    await signOut(page);

    section('REM-1: no expenses anywhere (both languages)');
    // Re-signed in below as the GM; first check the branch manager's view (the role that used to record expenses).
    await signIn(page, origin, BM.username, BM.password);
    await pathIs(page, ['/dashboard']);
    for (const p of ['/api/expenses', '/api/reports/expenses']) {
      const r = await apiGet(page, p);
      check(r.status === 404 || r.status === 400, `branch manager: ${p} answers ${r.status} (no such route or report)`);
    }
    await noExpenseWords(page, origin, ['/dashboard', '/cash', '/reports'], 'branch manager');

    section('REM-2: Hasad only as a payment channel');
    for (const p of ['/api/hasad/withdrawals', '/api/hasad/simulator/customers', '/api/reports/hasad']) {
      const r = await apiGet(page, p);
      check(r.status === 404 || r.status === 400, `branch manager: ${p} answers ${r.status} (no such route or report)`);
    }
    await noWords(page, origin, ['/dashboard', '/reports', '/inventory', '/transfers'], 'branch manager', HASAD_WORDS, 'Hasad withdrawal wording');
    await noWords(page, origin, ['/pos'], 'branch manager (menu)', HASAD_WORDS, 'Hasad entry in the menu', 'nav');
    await page.goto(`${origin}/pos`);
    await page.getByTestId('pos-payment-methods').waitFor();
    const methods = await page.getByTestId('pos-payment-methods').innerText();
    check(/نقد/.test(methods) && /تحويل بنكي/.test(methods) && /حصاد/.test(methods), 'the POS offers Cash, Bank transfer and Hasad as payment methods');
    // UI-A1 (D-ui-8): in English the methods read as words, never as the codes the server sends.
    await page.evaluate(() => localStorage.setItem('jerp.lang', 'en'));
    await page.goto(`${origin}/pos`);
    await page.getByTestId('pos-payment-methods').waitFor();
    const methodsEn = await page.getByTestId('pos-payment-methods').innerText();
    await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
    check(/Bank transfer/.test(methodsEn) && /Cash/.test(methodsEn) && !/BANK_TRANSFER|\bCASH\b|\bHASAD\b/.test(methodsEn), `in English the POS shows "Bank transfer", not the code (${methodsEn.replace(/\s+/g, ' ').trim()})`);
    await checkShell(page, origin, 'branch manager', 'bm', '/dashboard');
    const me = await apiGet(page, '/api/auth/me');
    check(!('hasadMode' in me.body) && me.body.posPaymentMethods.join(',') === 'CASH,BANK_TRANSFER,HASAD', 'no Hasad integration mode; the counter methods are Cash, Bank transfer, Hasad');

    section('CAT-0: supplier, type and product created where they are needed');
    await page.goto(`${origin}/purchases`);
    await page.click('[data-testid=new-purchase]');
    await page.click('[data-testid=purchase-new-supplier]');
    await page.fill('[data-testid=name-ar]', CAT.supplier);
    await page.click('[data-testid=save-supplier]');
    await waitFor(async () => (await page.inputValue('[data-testid=purchase-supplier]')) !== '', 'the new supplier selected', 15_000);
    ok(`branch manager adds supplier "${CAT.supplier}" from the purchase form (Arabic name only); it is selected`);
    await page.click('[data-testid=line-new-product-0]');
    await page.fill('[data-testid=name-ar]', CAT.product);
    await page.selectOption('[data-testid=product-karat]', '21');
    await page.click('[data-testid=product-new-type]');
    await page.locator('[data-testid=name-ar]').last().fill(CAT.type);
    await page.click('[data-testid=save-type]');
    await waitFor(async () => (await page.inputValue('[data-testid=product-type]')) !== '', 'the new type selected', 15_000);
    await page.click('[data-testid=save-product]');
    await waitFor(async () => (await page.inputValue('[data-testid=line-product-0]')) !== '', 'the new product selected', 15_000);
    ok(`type "${CAT.type}" and product "${CAT.product}" (21K) created inline from the purchase line and selected`);
    await page.fill('[data-testid=line-gross-0]', '5.2');
    await page.fill('[data-testid=line-net-0]', '5');
    // With today's gold rate set, leaving the net weight pre-fills the costs from the rate (editable):
    // wait for that suggestion, as a person would see it, then replace it.
    await page.locator('[data-testid=line-net-0]').blur();
    await waitFor(async () => (await page.inputValue('[data-testid=line-cost-0]')) !== '', 'the cost suggested from the gold rate', 10_000);
    ok(`with today's gold rate set, the purchase line suggests the cost from the rate (${await page.inputValue('[data-testid=line-cost-0]')})`);
    await page.fill('[data-testid=line-cost-0]', '1000000');
    await page.fill('[data-testid=line-price-0]', '1500000');
    await page.click('[data-testid=purchase-save]');
    await page.waitForURL((u) => /^\/purchases\/\d+$/.test(u.pathname), { timeout: 15_000 }).catch(async (e) => {
      const vals = await Promise.all(['line-gross-0', 'line-net-0', 'line-cost-0', 'line-price-0'].map((id) => page.inputValue(`[data-testid=${id}]`).catch(() => '?')));
      console.error('purchase form at the time of failure:', JSON.stringify(vals), JSON.stringify(await page.locator('[role=status]').allInnerTexts()));
      throw e;
    });
    const poId = Number(new URL(page.url()).pathname.split('/').pop());
    const supplierShown = (await page.getByTestId('purchase-supplier-name').innerText()).trim();
    const owedShown = await page.getByTestId('gold-owed').count();
    const po = (await apiGet(page, `/api/purchases/${poId}`)).body;
    check(supplierShown === CAT.supplier && owedShown === 1 && po.goldOwedMgPure24 === 4375, `the supplier order shows the supplier "${CAT.supplier}" and the gold owed (4.375 g of 24K for 5 g of 21K)`);

    const typeId = (await apiGet(page, '/api/categories')).body.find((c) => c.nameAr === CAT.type).id;
    await page.goto(`${origin}/catalog`);
    await page.click('[data-testid=new-type]');
    await page.fill('[data-testid=name-ar]', CAT.typeVariant);
    await page.click('[data-testid=save-type]');
    await page.getByTestId('use-existing').waitFor({ timeout: 15_000 });
    const typesAfter = (await apiGet(page, '/api/categories')).body;
    check(typesAfter.length === 1, `a second spelling ("${CAT.typeVariant}") is refused and the existing type is offered instead`);
    await page.keyboard.press('Escape');

    await page.goto(`${origin}/scrap`);
    await page.click('[data-testid=scrap-kind-SELLABLE]');
    await page.selectOption('[data-testid=scrap-karat]', '21');
    await page.click('[data-testid=scrap-new-product]');
    await page.fill('[data-testid=name-ar]', CAT.scrapProduct);
    await page.selectOption('[data-testid=product-type]', String(typeId));
    await page.click('[data-testid=save-product]');
    await waitFor(async () => (await page.inputValue('[data-testid=scrap-product]')) !== '', 'the new scrap product selected', 15_000);
    await page.fill('[data-testid=scrap-gross]', '3');
    await page.fill('[data-testid=scrap-net]', '3');
    await page.fill('[data-testid=scrap-selling-price]', '900000');
    await page.click('[data-testid=scrap-buy]');
    await waitFor(async () => (await apiGet(page, `/api/inventory/items?branchId=${branchId}&categoryId=${typeId}`)).body.items.length === 2, 'two pieces of the new type', 15_000);
    ok(`a sellable scrap piece is bought with product "${CAT.scrapProduct}" created inline (karat fixed to 21K); filtering stock by the new type finds both pieces`);

    await page.evaluate(() => localStorage.setItem('jerp.lang', 'en'));
    await page.goto(`${origin}/catalog`);
    await page.waitForLoadState('networkidle');
    const enText = await page.locator('main').first().innerText().catch(async () => page.locator('body').innerText());
    await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
    check(enText.includes(CAT.product) && enText.includes(CAT.type) && /Types & products/.test(enText), 'in English, names without an English version show in Arabic');
    await signOut(page);

    section('General Manager: audit trail');
    await signIn(page, origin, GM.username, GM.password);
    await page.getByTestId('second-step').waitFor();
    await page.click('[data-testid=use-passkey]');
    await pathIs(page, ['/overview']);
    ok('the General Manager signs in again with password + passkey');
    await checkShell(page, origin, 'General Manager', 'gm', '/overview');
    await noExpenseWords(page, origin, ['/overview', '/branches', '/cash', '/reports', '/settings'], 'General Manager');
    await noWords(page, origin, ['/overview', '/branches', '/reports'], 'General Manager', HASAD_WORDS, 'Hasad withdrawal wording');
    await noWords(page, origin, ['/overview'], 'General Manager (menu)', HASAD_WORDS, 'Hasad entry in the menu', 'nav');
    const settings = (await apiGet(page, '/api/settings')).body.settings;
    check(settings.hasad === undefined && settings.mockHasad === undefined, 'no Hasad workspace or mock settings remain');
    const rec = await apiGet(page, `/api/cash/reconciliation?branchId=${branchId}`);
    const total = (lines) => lines.reduce((sum, l) => sum + l.amount, 0);
    check(
      rec.status === 200 && rec.body.cashLines.some((l) => l.line === 'OTHER') && total(rec.body.cashLines) === rec.body.cashMovement && total(rec.body.bankLines) === rec.body.bankMovement,
      'the daily reconciliation has drawer and bank lines (with "Other") that add up to the ledger',
    );
    const audit = await apiGet(page, '/api/audit?limit=200');
    const rows = Array.isArray(audit.body) ? audit.body : (audit.body?.rows ?? audit.body?.items ?? []);
    const actions = new Set(rows.map((r) => r.action));
    check(['BRANCH_CREATED', 'USER_CREATED'].every((a) => actions.has(a)), 'the audit log shows the branch and the users created');
    check(['SUPPLIER_CREATED', 'ITEM_TYPE_CREATED', 'PRODUCT_CREATED', 'SCRAP_RATE_CHANGED'].every((a) => actions.has(a)), 'the audit log shows the supplier, type and products created and the scrap rate set');
    check(actions.has('ALLOWED_KARATS_CONFIRMED'), 'the audit log shows the confirmation of the allowed karats');

    section('REM-5: no deprecated schema left');
    const rdb = new pg.Client({ connectionString: dbUrl.toString() });
    await rdb.connect();
    try {
      const one = async (q) => (await rdb.query(q)).rows;
      const gone = await one(`SELECT
          (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('expenses', 'hasad_withdrawals', 'hasad_redemptions', 'hasad_redemption_items', 'settlements'))::int AS tables,
          (SELECT count(*) FROM pg_namespace WHERE nspname = 'hasad_mock')::int AS schema,
          (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (
             (table_name = 'jewelry_items' AND column_name IN ('purchase_cost', 'making_cost', 'other_cost', 'total_cost', 'reservation_ref', 'reserved_at', 'reserved_by'))
             OR (table_name = 'sessions' AND column_name = 'is_simulated') OR (table_name = 'branches' AND column_name = 'hasad_branch_code')))::int AS columns,
          (SELECT count(*) FROM pg_proc WHERE proname = 'jerp_refuse_deprecated_insert')::int AS fn,
          (SELECT count(*) FROM settings WHERE key = 'hasad.enabledPerBranch')::int AS setting`);
      check(Object.values(gone[0]).every((n) => n === 0), `the production database has none of the removed tables, schema, columns, function or settings row (${JSON.stringify(gone[0])})`);
      const [m] = await one('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
      const [u] = await one(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'purchase_items_item_id_unique'`);
      check(m.n === 17 && u.n === 1, `all 17 migrations (0000–0016) applied, one supplier line per piece enforced (${m.n} migrations)`);
    } finally {
      await rdb.end();
    }

    section('REM-3: a fresh demo-mode database');
    // `npm run demo` without a terminal: prints the bootstrap command and stops cleanly (no GM is invented).
    const demoDir = path.join(tmp, 'demo-cli');
    const cli = spawnSync('npx', ['tsx', 'src/demo-cli.ts'], { cwd: path.join(ROOT, 'backend'), env: { ...process.env, APP_MODE: 'demo', PGLITE_DIR: demoDir, DATABASE_URL: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check(cli.status === 10 && /npm run bootstrap -w @jerp\/backend -- --username/.test(cli.stdout), '`npm run demo` without a terminal prints the bootstrap command and creates nobody');
    const demo = await startEmptyServer({ withBranch: true, env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
    cleanup.unshift(() => demo.stop());
    const dgm = await prepareGm(demo);
    const counts = {};
    for (const [k, url] of [['items', '/inventory/items'], ['sales', '/sales'], ['purchases', '/purchases'], ['suppliers', '/suppliers'], ['products', '/products'], ['types', '/categories'], ['scrap', '/scrap-purchases']]) {
      const r = await dgm.call('GET', url);
      counts[k] = Array.isArray(r.body) ? r.body.length : (r.body?.items ?? r.body?.rows ?? []).length;
    }
    await dgm.dispose();
    check(Object.values(counts).every((n) => n === 0), `a fresh demo-mode database holds no items, sales (customers exist only on sales), purchases, suppliers, products, types or scrap (${JSON.stringify(counts)})`);
    const dctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const dpage = await dctx.newPage();
    const dmeta = await (await dpage.request.get(`${demo.base}/api/meta`)).json();
    check(dmeta.appMode === 'demo' && dmeta.demoAccounts === undefined, 'the demo login page lists no accounts either');
    await signIn(dpage, demo.base, E2E.gm.username, E2E.gm.password);
    await dpage.waitForURL((u) => u.pathname !== '/login', { timeout: 15_000 });
    await dpage.getByTestId('demo-badge').waitFor({ timeout: 15_000 });
    ok('demo mode shows the small neutral "Demo" badge');
    await dctx.close();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    for (const f of cleanup) await f().catch(() => {});
    await admin.end().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(`\nREHEARSAL PASSED: ${step} checks.`);
    process.exit(0); // nothing may keep the run alive (open sockets of the proxy or the browser)
  })
  .catch((e) => {
    console.error(`\nREHEARSAL FAILED after ${step} checks:`, e.message ?? e);
    process.exit(1);
  });
