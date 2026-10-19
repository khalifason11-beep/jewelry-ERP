// Browser helpers shared by the e2e scripts (moved from e2e-prices.mjs for MIS-1, unchanged).

/** A condition the screen reaches one render later: poll it, at most `ms`. */
export async function eventually(fn, ms = 8_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const digits = (s) => s.replace(/[^\d]/g, '');

/** Sign in through the login page, in Arabic. */
export async function signIn(page, base, who) {
  await page.goto(`${base}/login`);
  await page.evaluate(() => localStorage.setItem('jerp.lang', 'ar'));
  await page.fill('input[autocomplete=username]', who.username);
  await page.fill('input[autocomplete=current-password]', who.password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname !== '/login', { timeout: 15_000 });
  await page.getByTestId('sidebar').waitFor();
}

/** Fill and confirm the re-authentication dialog if the page asks (money routes need the re-auth window). */
export async function confirmIfAsked(page, password) {
  await page.waitForTimeout(400);
  if (await page.locator('#reauth-form').count()) {
    await page.fill('#reauth-form input[type=password]', password);
    await page.click('button[form=reauth-form]');
    await page.waitForTimeout(400);
  }
}

/** Replace a field's value (select all, then type, as a person would). */
export async function retype(page, testId, value) {
  await page.click(`[data-testid=${testId}]`);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
}
