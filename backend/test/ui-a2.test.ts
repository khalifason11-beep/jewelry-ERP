// UI-A2 server side: the crash page's reports (D-ui-12, POST /api/client-errors) and the public sign-in branding
// with the tagline setting (D-ui-14): /api/meta returns ONLY an allow-list.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { SETTINGS_REGISTRY } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { log } from '../src/core/logger';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = withIdempotencyKeys(request.agent(app));
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('crash reports from the browser (D-ui-12)', () => {
  const report = { ref: 'ERR-AB12CD34', path: '/sales', message: 'TypeError: x is undefined', stack: 'at SalesPage (index.js:1:2)' };

  it('needs a signed-in session', async () => {
    expect((await request(app).post('/api/client-errors').send(report)).status).toBe(401);
  });

  it('writes the reference id and details to the server log only, for any role', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const res = await cashier.post('/api/client-errors').send(report);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith('client render error', expect.objectContaining({ ref: 'ERR-AB12CD34', path: '/sales', message: report.message, username: 'cashier.kh.01' }));
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a malformed reference, unknown fields and oversized details', async () => {
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.post('/api/client-errors').send({ ...report, ref: 'nope' })).status).toBe(400);
    expect((await gm.post('/api/client-errors').send({ ...report, extra: 1 })).status).toBe(400);
    expect((await gm.post('/api/client-errors').send({ ...report, message: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('public sign-in branding: an allow-list (D-ui-14)', () => {
  /** Every key the public answer may contain, at any depth. */
  const ALLOWED = new Set(['branding', 'company', 'nameEn', 'nameAr', 'logoUrl', 'tagline', 'en', 'ar']);
  const keysOf = (v: unknown, out: string[] = []): string[] => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.push(k), keysOf(x, out));
    return out;
  };
  const gmAgent = async () => {
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
    return gm;
  };

  it('answers exactly the company name, the logo and the tagline, in both languages', async () => {
    const res = await request(app).get('/api/meta');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['branding']);
    expect(Object.keys(res.body.branding).sort()).toEqual(['company', 'logoUrl', 'tagline']);
    expect(Object.keys(res.body.branding.company).sort()).toEqual(['nameAr', 'nameEn']);
    expect(Object.keys(res.body.branding.tagline).sort()).toEqual(['ar', 'en']);
    expect(res.body.branding.tagline).toEqual({ en: '', ar: '' }); // empty by default: nothing invented
  });

  it('fails if any other setting key or value can appear: every registry key is checked, text settings carry markers', async () => {
    const gm = await gmAgent();
    // A distinctive marker in every free-text setting that is NOT on the allow-list.
    const markers: Record<string, string> = {
      'company.currencyLabelEn': 'MRKcurEN',
      'company.currencyLabelAr': 'MRKcurAR',
      'branding.invoiceFooterEn': 'MARKER footer en',
      'branding.invoiceFooterAr': 'MARKER footer ar',
    };
    const put = await gm.put('/api/settings').send({ changes: { ...markers, 'company.currencyCode': 'MRK', 'branding.loginTaglineAr': 'ذهب منذ ١٩٨٠', 'branding.loginTaglineEn': 'Gold since 1980' } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const res = await request(app).get('/api/meta');
    const text = JSON.stringify(res.body);
    for (const v of [...Object.values(markers), 'MRK']) expect(text, `public sign-in answer leaks "${v}"`).not.toContain(v);
    const keys = keysOf(res.body);
    for (const k of keys) expect(ALLOWED.has(k), `unexpected key "${k}" in /api/meta`).toBe(true);
    // No registry key (full "group.field" or its field name) may appear unless it is on the allow-list.
    const allowedSettings = new Set(['company.nameEn', 'company.nameAr', 'branding.logoAssetId', 'branding.loginTaglineEn', 'branding.loginTaglineAr']);
    for (const key of Object.keys(SETTINGS_REGISTRY)) {
      if (allowedSettings.has(key)) continue;
      const field = key.split('.')[1];
      expect(text.includes(`"${key}"`) || keys.includes(field), `setting ${key} appears in /api/meta`).toBe(false);
    }
    expect(res.body.branding.tagline).toEqual({ en: 'Gold since 1980', ar: 'ذهب منذ ١٩٨٠' });
    // Signed in, the screens still get what they need (currency labels, invoice footer) from /auth/me.
    const me = (await gm.get('/api/auth/me')).body.branding;
    expect(me).toMatchObject({ currency: { labelEn: 'MRKcurEN' }, invoiceFooterEn: 'MARKER footer en', tagline: { en: 'Gold since 1980' } });
  });

  it('an unauthenticated request cannot read the settings (or anything but the allow-list)', async () => {
    for (const path of ['/api/settings', '/api/auth/me', '/api/backups/status', '/api/gold-rates', '/api/branches']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
  });

  it('the tagline is plain text on one line, at most 120 characters, enforced on the server', async () => {
    const gm = await gmAgent();
    for (const bad of ['x'.repeat(121), '<b>Gold</b>', 'line one\nline two', 'tab\there']) {
      const res = await gm.put('/api/settings').send({ changes: { 'branding.loginTaglineEn': bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await gm.put('/api/settings').send({ changes: { 'branding.loginTaglineEn': '  Fine gold, every piece accounted for  ' } });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/meta')).body.branding.tagline.en).toBe('Fine gold, every piece accounted for');
    expect((await gm.put('/api/settings').send({ changes: { 'branding.loginTaglineEn': 'x'.repeat(120) } })).status).toBe(200);
  });

  it('only the General Manager changes it, and every change is audited like other settings', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    expect((await bm.put('/api/settings').send({ changes: { 'branding.loginTaglineAr': 'لا' } })).status).toBe(403);
    const gm = await gmAgent();
    expect((await gm.put('/api/settings').send({ changes: { 'branding.loginTaglineAr': 'عبارة جديدة' } })).status).toBe(200);
    const [audit] = await ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'SETTINGS_CHANGED'))).orderBy(desc(t.auditLogs.id)).limit(1);
    expect(JSON.stringify(audit)).toContain('branding.loginTaglineAr');
    const [hist] = await ctx.db.select().from(t.settingsHistory).where(eq(t.settingsHistory.key, 'branding.loginTaglineAr')).orderBy(desc(t.settingsHistory.id)).limit(1);
    expect(hist).toBeDefined();
  });
});
