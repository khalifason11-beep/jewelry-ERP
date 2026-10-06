#!/usr/bin/env node
// UX baseline screenshots (UX-0). Repeatable: run it again after a UI phase to compare.
//
//   node scripts/capture-ui-baseline.mjs                      # demo + empty production database
//   node scripts/capture-ui-baseline.mjs --only=demo          # demo database only
//   node scripts/capture-ui-baseline.mjs --only=empty         # empty production database only (needs REHEARSAL_ADMIN_URL)
//   node scripts/capture-ui-baseline.mjs --skip-build --out=docs/ux/baseline
//
// demo:  a fresh demo database (embedded PGlite, 30 days of seeded activity) served in demo mode; every
//        main screen and the catalog dialogs, as the General Manager, a branch manager and a cashier.
// empty: the REH-1 rehearsal (production mode, real PostgreSQL behind TLS) with UI_BASELINE_DIR set, which
//        photographs each role's home right after its first sign-in (scripts/rehearsal/rehearsal.mjs).
// Each screen: Arabic (RTL) and English (LTR), at 1366x768 and 1920x1080. At 1366 wide, a screen whose
// content scrolls also gets a "-full" image of the whole page. JPEG, quality 72.
//
// Reads only; changes no application code. The demo database lives in a temporary folder and is deleted.

import { createRequire } from 'node:module';
import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ARGS = new Set(argv);
const opt = (name, dflt) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
const OUT = path.resolve(ROOT, opt('out', 'docs/ux/baseline'));
const ONLY = opt('only', 'all');
const LANGS = ['ar', 'en'];
const SIZES = [[1366, 768], [1920, 1080]];

function loadModule(name) {
  for (const base of [ROOT + '/', path.join(ROOT, 'backend') + '/', path.join(execSync('npm root -g').toString().trim(), '/')]) {
    try {
      return createRequire(base)(name);
    } catch {
      /* next */
    }
  }
  throw new Error(`${name} not found`);
}
const { chromium } = loadModule('playwright');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function waitFor(fn, what, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Demo accounts (backend/src/seed/catalog.ts).
const ROLES = {
  gm: { username: 'general.manager', password: 'demo-gm-2026' },
  bm: { username: 'branch.manager.kh', password: 'demo-bm-2026' },
  cashier: { username: 'cashier.kh.01', password: 'demo-cashier-2026' },
};

/**
 * What to photograph. `path` may be a function of the page (to find a real sale or purchase id);
 * `then` performs clicks after the page loaded (dialogs).
 */
const firstId = (url, pick = (b) => (Array.isArray(b) ? b : (b.items ?? b.rows ?? []))[0]?.id) => async (page) =>
  `${url.split('?')[0].replace('/api', '')}/${pick(await page.evaluate(async (u) => (await fetch(u)).json(), url))}`;

const SCREENS = [
  { role: 'gm', name: 'home-company-overview', path: '/overview' },
  { role: 'gm', name: 'branches', path: '/branches' },
  { role: 'gm', name: 'branch-detail', path: async (page) => `/branches/${(await page.evaluate(async () => (await fetch('/api/branches')).json()))[0].id}` },
  { role: 'gm', name: 'sales', path: '/sales' },
  { role: 'gm', name: 'sale-detail', path: firstId('/api/sales?limit=1') },
  { role: 'gm', name: 'inventory', path: '/inventory' },
  { role: 'gm', name: 'types-and-products', path: '/catalog' },
  { role: 'gm', name: 'supplier-purchases', path: '/purchases' },
  { role: 'gm', name: 'supplier-purchase-detail', path: firstId('/api/purchases') },
  { role: 'gm', name: 'cash-and-reconciliation', path: '/cash' },
  { role: 'gm', name: 'reports', path: '/reports' },
  { role: 'gm', name: 'report-sales', path: '/reports/sales' },
  { role: 'gm', name: 'audit', path: '/audit' },
  { role: 'gm', name: 'users', path: '/users' },
  { role: 'gm', name: 'active-users', path: '/sessions' },
  { role: 'gm', name: 'settings', path: '/settings' },
  { role: 'gm', name: 'security', path: '/security' },
  { role: 'bm', name: 'home-branch-dashboard', path: '/dashboard' },
  { role: 'bm', name: 'scrap-purchase', path: '/scrap' },
  { role: 'bm', name: 'transfers', path: '/transfers' },
  { role: 'bm', name: 'cash-and-reconciliation', path: '/cash' },
  { role: 'bm', name: 'dialog-new-product', path: '/catalog', then: (p) => p.click('[data-testid=new-product]') },
  { role: 'bm', name: 'dialog-new-type', path: '/catalog', then: (p) => p.click('[data-testid=new-type]') },
  { role: 'bm', name: 'dialog-new-purchase', path: '/purchases', then: (p) => p.click('[data-testid=new-purchase]') },
  {
    role: 'bm',
    name: 'dialog-new-supplier',
    path: '/purchases',
    then: async (p) => {
      await p.click('[data-testid=new-purchase]');
      await p.click('[data-testid=purchase-new-supplier]');
    },
  },
  { role: 'cashier', name: 'home-pos', path: '/pos' },
  { role: 'cashier', name: 'my-activity', path: '/me' },
];

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600); // charts animate in
}

async function shoot(page, file, full) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, type: 'jpeg', quality: 72 });
  if (!full) return;
  // The app scrolls inside <main>, so a "full page" screenshot needs a taller viewport.
  const vp = page.viewportSize();
  const extra = await page.evaluate(() => {
    const m = document.querySelector('main');
    return m ? m.scrollHeight - m.clientHeight : 0;
  });
  if (extra > 8) {
    await page.setViewportSize({ width: vp.width, height: Math.min(vp.height + extra, 9000) });
    await page.waitForTimeout(300);
    await page.screenshot({ path: file.replace(/\.jpg$/, '-full.jpg'), type: 'jpeg', quality: 72 });
    await page.setViewportSize(vp);
  }
}

async function captureDemo(browser) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-ux-'));
  const port = await freePort();
  const server = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env, APP_MODE: 'demo', PORT: String(port), PGLITE_DIR: path.join(tmp, 'pglite'), DATABASE_URL: '', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 'the demo server (seeding takes a minute)');
    let n = 0;
    const counter = new Map();
    for (const lang of LANGS) {
      for (const [w, h] of SIZES) {
        for (const role of Object.keys(ROLES)) {
          const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: lang === 'ar' ? 'ar' : 'en-US' });
          await ctx.addInitScript((l) => localStorage.setItem('jerp.lang', l), lang);
          const page = await ctx.newPage();
          await page.goto(`${base}/login`);
          await page.fill('input[autocomplete=username]', ROLES[role].username);
          await page.fill('input[autocomplete=current-password]', ROLES[role].password);
          await page.click('button[type=submit]');
          await page.waitForURL((u) => u.pathname !== '/login', { timeout: 30_000 });
          for (const s of SCREENS.filter((x) => x.role === role)) {
            const idx = counter.get(`${s.role}-${s.name}`) ?? counter.set(`${s.role}-${s.name}`, counter.size + 1).get(`${s.role}-${s.name}`);
            const target = typeof s.path === 'function' ? await s.path(page) : s.path;
            await page.goto(`${base}${target}`);
            await settle(page);
            if (s.then) {
              await s.then(page);
              await page.waitForTimeout(500);
            }
            const file = path.join(OUT, 'demo', `${lang}-${w}x${h}`, `${String(idx).padStart(2, '0')}-${role}-${s.name}.jpg`);
            await shoot(page, file, w === 1366 && !s.then);
            n++;
          }
          await ctx.close();
        }
      }
    }
    console.log(`demo: ${n} screens captured`);
  } catch (e) {
    console.error(log.slice(-3000));
    throw e;
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function captureEmpty() {
  if (!process.env.REHEARSAL_ADMIN_URL) throw new Error('REHEARSAL_ADMIN_URL is required for --only=empty (see scripts/rehearsal/rehearsal.mjs)');
  const r = spawnSync('node', ['scripts/rehearsal/rehearsal.mjs', '--skip-build'], {
    cwd: ROOT,
    env: { ...process.env, UI_BASELINE_DIR: path.join(OUT, 'empty-production') },
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('the rehearsal failed: no empty-database screenshots');
}

if (!ARGS.has('--skip-build') || !fs.existsSync(path.join(ROOT, 'frontend/dist/index.html'))) {
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}
if (ONLY !== 'empty') {
  fs.rmSync(path.join(OUT, 'demo'), { recursive: true, force: true });
  const browser = await chromium.launch();
  try {
    await captureDemo(browser);
  } finally {
    await browser.close();
  }
}
if (ONLY !== 'demo') {
  fs.rmSync(path.join(OUT, 'empty-production'), { recursive: true, force: true });
  captureEmpty();
}
console.log(`screenshots in ${path.relative(ROOT, OUT)}/`);
