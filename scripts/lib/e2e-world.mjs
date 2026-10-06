// Shared setup for the browser e2e scripts (REM-3): the scripts no longer rely on demo accounts or seeded
// data. They start their OWN server on a fresh, empty embedded database, create the first General Manager
// with the real bootstrap command, and build whatever they need through the public API — exactly what a
// real deployment goes through.
//
//   const srv = await startEmptyServer({ env: { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } });
//   const world = await buildSalesWorld(srv);   // GM, branch manager, cashier, rates, type/product/supplier, stock
//   …
//   await srv.stop();
//
// Names are clearly marked test data ("[اختبار] …"); nothing here is shipped or used by the product.

import { createRequire } from 'node:module';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadModule(name) {
  for (const base of [ROOT + '/', path.join(ROOT, 'backend') + '/', process.cwd() + '/', path.join(execSync('npm root -g').toString().trim(), '/')]) {
    try {
      return createRequire(base)(name);
    } catch {
      /* next */
    }
  }
  throw new Error(`${name} not found (npm i -g ${name})`);
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

async function waitFor(fn, what, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Test people (usernames obey the bootstrap rule: ≥ 8 characters, no role-style words). */
export const PEOPLE = {
  gm: { username: 'e2e.alpha', fullName: 'E2E Alpha', password: 'E2e-Alpha-Pass-2026!' },
  bm: { username: 'e2e.bravo', fullName: 'E2E Bravo', password: 'E2e-Bravo-Pass-2026!' },
  cashier: { username: 'e2e.charlie', fullName: 'E2E Charlie', password: 'E2e-Charlie-Pass-2026!' },
};
export const BRANCH = { code: 'TST', name: 'E2E Branch', nameAr: 'فرع الاختبار', city: 'Test City' };

/**
 * Bootstrap an empty embedded database (demo mode) with the first General Manager, then start the server on it.
 * The bootstrap runs BEFORE the server: an embedded database is never opened by two processes.
 */
export async function startEmptyServer({ env = {}, withBranch = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-e2e-'));
  const port = await freePort();
  const baseEnv = { ...process.env, APP_MODE: 'demo', PGLITE_DIR: path.join(tmp, 'pglite'), DATABASE_URL: '', PORT: String(port), LOG_LEVEL: 'warn', ...env };
  const args = ['tsx', 'src/bootstrap-cli.ts', '--username', PEOPLE.gm.username, '--full-name', PEOPLE.gm.fullName];
  if (withBranch) args.push('--branch', `${BRANCH.code}:${BRANCH.name}:${BRANCH.nameAr}:${BRANCH.city}`);
  const out = execFileSync('npx', args, { cwd: path.join(ROOT, 'backend'), env: baseEnv, encoding: 'utf8' });
  const otp = out.match(/One-time password[^:]*:\s*(\S+)/)?.[1];
  if (!otp) throw new Error(`bootstrap printed no one-time password:\n${out}`);
  // Own process group: `npx` starts the real server as a child, so stopping must signal the whole group.
  const server = spawn('npx', ['tsx', 'src/server.ts'], { cwd: path.join(ROOT, 'backend'), env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const kill = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  // `localhost`, not an IP: WebAuthn refuses an IP address as the relying-party id.
  const base = `http://localhost:${port}`;
  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 'the server');
  } catch (e) {
    kill();
    throw new Error(`${e.message}\n${log.slice(-3000)}`);
  }
  return {
    base,
    otp,
    log: () => log,
    stop: async () => {
      kill();
      await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** A signed-in API client (Playwright APIRequestContext keeps the session cookie). */
export async function apiClient(base) {
  const { request } = loadModule('playwright');
  const req = await request.newContext({ baseURL: base });
  let csrf = '';
  const call = async (method, url, body, { idempotent = false } = {}) => {
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
    if (idempotent) headers['idempotency-key'] = randomUUID();
    const r = await req.fetch(`/api${url}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status(), body: text ? JSON.parse(text) : null };
  };
  const refresh = async () => {
    csrf = (await call('GET', '/auth/me')).body?.csrfToken ?? '';
  };
  return {
    call,
    async login(username, password) {
      const r = await call('POST', '/auth/login', { username, password });
      if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
      await refresh();
      return r.body;
    },
    async changePassword(current, next) {
      const r = await call('POST', '/auth/change-password', { currentPassword: current, newPassword: next });
      if (r.status !== 200) throw new Error(`change password: ${r.status} ${JSON.stringify(r.body)}`);
      await refresh();
    },
    async reauth(password) {
      const r = await call('POST', '/auth/reauth', { password });
      if (r.status !== 200) throw new Error(`reauth: ${r.status} ${JSON.stringify(r.body)}`);
    },
    async must(method, url, body, opts) {
      const r = await call(method, url, body, opts);
      if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    dispose: () => req.dispose(),
  };
}

/** First sign-in of the bootstrapped GM: the one-time password is replaced by PEOPLE.gm.password. */
export async function prepareGm(srv) {
  const gm = await apiClient(srv.base);
  await gm.login(PEOPLE.gm.username, srv.otp);
  await gm.changePassword(srv.otp, PEOPLE.gm.password);
  return gm;
}

/**
 * Everything a sales e2e needs, through the API: rates, a branch manager and a cashier (passwords set),
 * one type, one product, one supplier and `pieces` pieces of stock in the branch. Requires a server
 * started with TWO_FACTOR_REQUIRED_ROLES_INITIAL='' (no passkey for the GM).
 */
export async function buildSalesWorld(srv, { pieces = 8 } = {}) {
  const gm = await prepareGm(srv);
  await gm.reauth(PEOPLE.gm.password);
  const branchId = (await gm.must('GET', '/branches')).find((b) => b.code === BRANCH.code).id;
  await gm.must('POST', '/gold-rates', { rates: { 21: 190_000 } });
  await gm.must('POST', '/scrap-rates', { rates: [{ karat: 21, pricePerGram: 150_000 }] });
  const people = {};
  for (const [key, role] of [['bm', 'BRANCH_MANAGER'], ['cashier', 'CASHIER']]) {
    const p = PEOPLE[key];
    const created = await gm.must('POST', '/users', { username: p.username, fullName: p.fullName, roleCode: role, branchId });
    const c = await apiClient(srv.base);
    await c.login(p.username, created.temporaryPassword);
    await c.changePassword(created.temporaryPassword, p.password);
    await c.dispose();
    people[key] = p;
  }
  const type = await gm.must('POST', '/categories', { nameAr: '[اختبار] نوع أ' }, { idempotent: true });
  const product = await gm.must('POST', '/products', { nameAr: '[اختبار] منتج أ', karat: 21, categoryId: type.id }, { idempotent: true });
  const supplier = await gm.must('POST', '/suppliers', { nameAr: '[اختبار] مورّد أ' }, { idempotent: true });
  const lines = Array.from({ length: pieces }, (_, i) => {
    const net = 4_000 + i * 730;
    return { productId: product.id, grossWeightMg: net + 150, netWeightMg: net, purchaseCost: 700_000 + i * 50_000, makingCost: 40_000, otherCost: 0, sellingPrice: 1_000_000 + i * 75_000 };
  });
  await gm.must('POST', '/purchases', { branchId, supplierId: supplier.id, lines, makingChargePaidFrom: 'CASH' }, { idempotent: true });
  await gm.dispose();
  return { gm: PEOPLE.gm, bm: people.bm, cashier: people.cashier, branchId, typeId: type.id, productId: product.id, supplierId: supplier.id };
}
