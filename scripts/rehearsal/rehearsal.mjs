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
import { execFileSync, execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const pathIs = (page, paths) => page.waitForURL((u) => paths.includes(u.pathname), { timeout: 15_000 });

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
    const env = { APP_MODE: 'production', DATABASE_URL: dbUrl.toString(), APP_ORIGIN: origin, TRUST_PROXY: '1', PORT: String(appPort), LOG_LEVEL: 'warn' };
    for (const k of ['MIGRATION_DATABASE_URL', 'PGLITE_DIR', 'COOKIE_SECURE', 'WEBAUTHN_RP_ID', 'STRICT_DB_ROLES']) delete process.env[k];

    // 1. Bootstrap (the operator's one-time command): reference data + the first GM, no branch.
    const out = run('npx', ['tsx', 'src/bootstrap-cli.ts', '--username', GM.username, '--full-name', GM.fullName], env, path.join(ROOT, 'backend'));
    const otp = /One-time password[^:]*:\s*(\S+)/.exec(out)?.[1];
    check(!!otp, 'bootstrap on an empty PostgreSQL database prints a one-time password for the first General Manager');

    // 2. The server in production mode, behind the TLS proxy.
    const server = spawn('npx', ['tsx', 'src/server.ts'], { cwd: path.join(ROOT, 'backend'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
    cleanup.unshift(async () => {
      server.kill('SIGTERM');
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

    section('Empty database: nothing invented');
    const branches0 = await apiGet(page, '/api/branches');
    check(branches0.status === 200 && Array.isArray(branches0.body) && branches0.body.length === 0, 'no branches exist yet');
    const users0 = await apiGet(page, '/api/users');
    check(users0.status === 200 && users0.body.length === 1, 'the only user is the General Manager');
    const drawer0 = await apiGet(page, '/api/cash/drawer');
    check(drawer0.status === 200 && drawer0.body.branches.length === 0, 'no ledger accounts with money (no branches, no opening cash)');

    section('General Manager: branch and staff');
    await page.goto(`${origin}/branches`);
    await page.click('[data-testid=new-branch]');
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
      await page.click('[data-testid=new-user]');
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
    await signOut(page);

    section('Staff: first sign-in');
    await signIn(page, origin, BM.username, temps[BM.username]);
    await changePassword(page, temps[BM.username], BM.password);
    await pathIs(page, ['/dashboard']);
    ok('branch manager sets a personal password and lands on the branch dashboard');
    const bmSelf = await apiGet(page, '/api/auth/me');
    check(bmSelf.body.user.branch?.id === branchId, 'the branch manager is bound to the new branch');
    await signOut(page);

    await signIn(page, origin, CASHIER.username, temps[CASHIER.username]);
    await changePassword(page, temps[CASHIER.username], CASHIER.password);
    await pathIs(page, ['/pos']);
    ok('cashier sets a personal password and lands on the point of sale');
    const cashierUsers = await apiGet(page, '/api/users');
    check(cashierUsers.status === 403, 'the cashier cannot open the user list (403)');
    await signOut(page);

    section('General Manager: audit trail');
    await signIn(page, origin, GM.username, GM.password);
    await page.getByTestId('second-step').waitFor();
    await page.click('[data-testid=use-passkey]');
    await pathIs(page, ['/overview']);
    ok('the General Manager signs in again with password + passkey');
    const audit = await apiGet(page, '/api/audit?limit=200');
    const rows = Array.isArray(audit.body) ? audit.body : (audit.body?.rows ?? audit.body?.items ?? []);
    const actions = new Set(rows.map((r) => r.action));
    check(['BRANCH_CREATED', 'USER_CREATED'].every((a) => actions.has(a)), 'the audit log shows the branch and the users created');
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
  .then(() => console.log(`\nREHEARSAL PASSED: ${step} checks.`))
  .catch((e) => {
    console.error(`\nREHEARSAL FAILED after ${step} checks:`, e.message ?? e);
    process.exit(1);
  });
