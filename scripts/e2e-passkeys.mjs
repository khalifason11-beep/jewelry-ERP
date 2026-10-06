#!/usr/bin/env node
// Browser end-to-end check of the passkey sign-in (Phase 2fa), with Chromium's virtual
// authenticator (Chrome DevTools Protocol, WebAuthn domain): no real fingerprint reader needed.
//
//   run:   node scripts/e2e-passkeys.mjs              (passkey required for the General Manager, the default)
//          node scripts/e2e-passkeys.mjs --mode=off   (TWO_FACTOR_REQUIRED_ROLES_INITIAL='': password alone)
//
// The script starts its OWN server on a fresh, empty database (REM-3: no demo accounts exist any more),
// bootstraps the first General Manager and replaces the one-time password through the API
// (scripts/lib/e2e-world.mjs).
//
// Playwright is not a project dependency: it is resolved from the project, then from the global
// npm modules (npm i -g playwright). Exit code 0 = every step passed.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { PEOPLE, prepareGm, startEmptyServer } from './lib/e2e-world.mjs';

function loadPlaywright() {
  const tries = [process.cwd() + '/', path.join(execSync('npm root -g').toString().trim(), '/')];
  for (const base of tries) {
    try {
      return createRequire(base)('playwright');
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found: npm i -g playwright');
}

const { chromium } = loadPlaywright();
let BASE = '';
const MODE = process.argv.includes('--mode=off') ? 'off' : 'on';
const GM = { username: PEOPLE.gm.username, password: PEOPLE.gm.password };
const NEW_PASSWORD = 'Fresh-Strong-Pass-2026!';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  ok(msg);
}

async function virtualAuthenticator(page, transport = 'internal') {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}

async function signInPassword(page, password = GM.password) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[autocomplete=username]', GM.username);
  await page.fill('input[autocomplete=current-password]', password);
  await page.click('button[type=submit]');
}

async function signOut(page) {
  await page.evaluate(async () => {
    const me = await (await fetch('/api/auth/me')).json();
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrfToken ?? '' } });
  });
}

const atHome = (page) => page.waitForURL((u) => ['/overview', '/dashboard', '/pos'].includes(u.pathname), { timeout: 15_000 });

async function main() {
  const srv = await startEmptyServer({ withBranch: false, env: MODE === 'off' ? { TWO_FACTOR_REQUIRED_ROLES_INITIAL: '' } : {} });
  BASE = srv.base;
  await (await prepareGm(srv)).dispose();
  ok('empty server bootstrapped; the General Manager replaced the one-time password');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    if (MODE === 'off') {
      await signInPassword(page);
      await atHome(page);
      check(!(await page.getByTestId('second-step').count()), 'second factor not required: password alone opens the General Manager account');
      check(!(await page.getByTestId('enforcement-off-banner').count()), 'demo: no "second factor off" banner');
      return;
    }

    let auth = await virtualAuthenticator(page);

    // ── enrollment ──
    await signInPassword(page);
    await page.waitForURL((u) => u.pathname === '/security/setup', { timeout: 15_000 });
    ok('first sign-in of the General Manager goes to the passkey setup');
    const blocked = await page.evaluate(async () => (await fetch('/api/settings')).status);
    check(blocked === 403, 'any other API is refused until enrollment is complete (403)');
    await page.fill('[data-testid=passkey-nickname]', 'Shop PC');
    await page.click('[data-testid=register-passkey]');
    await page.getByTestId('enroll-codes').waitFor();
    ok('passkey registered on the virtual authenticator (Windows Hello stand-in)');
    await page.click('[data-testid=generate-codes]');
    const codes = (await page.getByTestId('recovery-codes').innerText()).split(/\s+/).filter((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c));
    check(codes.length === 10, '10 recovery codes shown once');
    check(await page.getByTestId('codes-done').isDisabled(), '"Continue" stays disabled until "I saved them" is ticked');
    await page.check('[data-testid=codes-saved]');
    await page.click('[data-testid=codes-done]');
    await atHome(page);
    ok('enrollment complete: the dashboard opens');
    await page.getByTestId('second-passkey-nag').waitFor({ timeout: 10_000 });
    ok('non-blocking banner asks for a second passkey');

    // ── two-step sign-in ──
    await signOut(page);
    await signInPassword(page);
    await page.getByTestId('second-step').waitFor();
    ok('password accepted → second step (passkey or recovery code)');
    const pendingProbe = await page.evaluate(async () => (await fetch('/api/auth/me')).status);
    check(pendingProbe === 401, 'the pending sign-in opens no route (/auth/me → 401)');
    await page.click('[data-testid=use-passkey]');
    await atHome(page);
    ok('passkey assertion → signed in');

    // ── recovery-code sign-in ──
    await signOut(page);
    await signInPassword(page);
    await page.getByTestId('second-step').waitFor();
    await page.getByText(/recovery code|رمز استرداد/i).first().click();
    await page.fill('[data-testid=recovery-code]', codes[0].toLowerCase().replace('-', ' '));
    await page.click('button[type=submit]');
    await atHome(page);
    ok('recovery code accepted (case and separators ignored)');
    await signOut(page);
    await signInPassword(page);
    await page.getByTestId('second-step').waitFor();
    await page.getByText(/recovery code|رمز استرداد/i).first().click();
    await page.fill('[data-testid=recovery-code]', codes[0]);
    await page.click('button[type=submit]');
    await page.getByText(/Sign-in could not be completed|تعذّر إكمال الدخول/).waitFor({ timeout: 10_000 });
    check(new URL(page.url()).pathname === '/login', 'the same recovery code never works twice (generic failure)');
    await page.getByText(/Use my passkey instead|استخدام مفتاح المرور بدلاً من ذلك/).click();
    await page.click('[data-testid=use-passkey]');
    await atHome(page);

    // ── second credential (the "phone") ──
    await page.goto(`${BASE}/security`);
    await page.getByTestId('passkey-list').waitFor();
    // Step-up first (password + passkey) by replacing the recovery codes; this also tests regeneration.
    await page.click('[data-testid=regenerate-codes]');
    await page.fill('#reauth-form input[type=password]', GM.password);
    await page.click('button[form=reauth-form]');
    await page.click('[data-testid=reauth-passkey]');
    const newCodesBox = page.getByTestId('recovery-codes');
    await newCodesBox.waitFor();
    const codes2 = (await newCodesBox.innerText()).split(/\s+/).filter((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c));
    check(codes2.length === 10 && !codes2.includes(codes[1]), 'new recovery codes after password + passkey; the old set is replaced');
    await page.check('[data-testid=codes-saved]');
    await page.click('[data-testid=codes-done]');
    // Swap in a second authenticator (a phone over the hybrid transport is not available headless).
    const saved = (await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.id })).credentials;
    await auth.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth.id });
    const phone = await virtualAuthenticator(page, 'usb');
    await page.click('[data-testid=add-passkey]');
    await page.fill('[data-testid=add-passkey-nickname]', 'My phone');
    await page.click('[data-testid=add-passkey-confirm]');
    // Wait for the list itself (the name also appears in the success message before the list reloads).
    await page.getByTestId('passkey-list').locator('li', { hasText: 'My phone' }).first().waitFor().catch(() => {});
    const rows = await page.getByTestId('passkey-list').locator('li').count();
    check(rows === 2, 'second device registered (within the step-up window): 2 passkeys listed');
    await page.waitForTimeout(300);
    check(!(await page.getByTestId('second-passkey-nag').count()), 'second-passkey banner gone');
    const phoneCreds = (await phone.cdp.send('WebAuthn.getCredentials', { authenticatorId: phone.id })).credentials;
    await phone.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: phone.id });
    auth = await virtualAuthenticator(page);
    for (const c of saved) await auth.cdp.send('WebAuthn.addCredential', { authenticatorId: auth.id, credential: c });

    // ── removal rules ──
    const removeButtons = page.locator('[data-testid^=remove-passkey-]:not([data-testid=remove-passkey-confirm])');
    await removeButtons.nth(1).click();
    await page.click('[data-testid=remove-passkey-confirm]');
    if (await page.locator('#reauth-form').count()) {
      await page.fill('#reauth-form input[type=password]', GM.password);
      await page.click('button[form=reauth-form]');
    }
    if (await page.getByTestId('reauth-passkey').count()) await page.click('[data-testid=reauth-passkey]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=passkey-list] li').length === 1, null, { timeout: 10_000 });
    ok('a passkey can be removed while another remains');
    check(await removeButtons.first().isDisabled(), 'the LAST passkey of the General Manager cannot be removed from the screen');
    void phoneCreds;

    // ── new device + "This wasn't me" (reported sign-in used a PASSKEY: no lock) ──
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: FIREFOX_UA });
    const otherPage = await other.newPage();
    const copy = await virtualAuthenticator(otherPage);
    for (const c of (await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.id })).credentials) {
      await copy.cdp.send('WebAuthn.addCredential', { authenticatorId: copy.id, credential: c });
    }
    await signInPassword(otherPage);
    await otherPage.getByTestId('second-step').waitFor();
    await otherPage.click('[data-testid=use-passkey]');
    await atHome(otherPage);
    ok('sign-in from another browser (Firefox) with the passkey');
    await page.goto(`${BASE}/overview`);
    await page.getByTestId('new-device-alert').waitFor({ timeout: 10_000 });
    ok('the General Manager sees the new-device alert');
    await page.click('[data-testid=not-me]');
    check(!(await page.getByTestId('not-me-lock-warning').count()), 'passkey sign-in reported: no account-lock warning in the confirmation');
    await page.click('[data-testid=not-me-confirm]');
    await page.waitForURL((u) => u.pathname === '/login', { timeout: 10_000 });
    ok('"This wasn’t me" signs this browser out');
    const otherStatus = await otherPage.evaluate(async () => (await fetch('/api/auth/me')).status);
    check(otherStatus === 401, 'the other browser’s session is ended too');
    await other.close();
    await signInPassword(page);
    await page.getByTestId('second-step').waitFor();
    check(!(await page.getByTestId('use-passkey').count()), 'passkeys are revoked: only the recovery code is offered');
    await page.fill('[data-testid=recovery-code]', codes2[1]);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => u.pathname === '/change-password', { timeout: 10_000 });
    ok('the confirmed recovery codes still work → a new password is required');
    const pw = page.locator('input[type=password]');
    await pw.nth(0).fill(GM.password);
    await pw.nth(1).fill(NEW_PASSWORD);
    await pw.nth(2).fill(NEW_PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => u.pathname === '/security/setup', { timeout: 10_000 });
    ok('after the new password, the passkey setup starts again');

    // ── "This wasn't me" on a RECOVERY-CODE sign-in: the account is security-locked (D-2fa-13) ──
    await page.fill('[data-testid=passkey-nickname]', 'Shop PC (new)');
    await page.click('[data-testid=register-passkey]');
    // The session opened by the password change has no fresh password confirmation yet: confirm it.
    await page.locator('#reauth-form, [data-testid=enroll-codes]').first().waitFor();
    if (await page.locator('#reauth-form').count()) {
      await page.fill('#reauth-form input[type=password]', NEW_PASSWORD);
      await page.click('button[form=reauth-form]');
    }
    // The confirmed recovery codes survived the passkey-path report, so one passkey completes the setup.
    await atHome(page);
    ok('passkey registered again; the kept recovery codes complete the setup');
    const thief = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: SAFARI_UA });
    const thiefPage = await thief.newPage();
    await signInPassword(thiefPage, NEW_PASSWORD);
    await thiefPage.getByTestId('second-step').waitFor();
    await thiefPage.getByText(/recovery code|رمز استرداد/i).first().click();
    await thiefPage.fill('[data-testid=recovery-code]', codes2[2]);
    await thiefPage.click('button[type=submit]');
    await atHome(thiefPage);
    await page.goto(`${BASE}/overview`);
    await page.getByTestId('new-device-alert').waitFor({ timeout: 10_000 });
    await page.click('[data-testid=not-me]');
    await page.getByTestId('not-me-lock-warning').waitFor();
    ok('recovery-code sign-in reported: the confirmation warns that the account will be locked');
    await page.click('[data-testid=not-me-confirm]');
    await page.waitForURL((u) => u.pathname === '/login', { timeout: 10_000 });
    await thief.close();
    await signInPassword(page, NEW_PASSWORD);
    await page.getByText(/Sign-in failed\. Check your username|تعذّر تسجيل الدخول\. تحقّق/).first().waitFor({ timeout: 10_000 });
    check(new URL(page.url()).pathname === '/login' && !(await page.getByTestId('second-step').count()), 'security-locked: the right password gets the ordinary sign-in failure, no second step');
  } finally {
    await browser.close();
    await srv.stop();
  }
}

main()
  .then(() => console.log(`\nAll ${step} browser checks passed (mode: ${MODE}).`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
