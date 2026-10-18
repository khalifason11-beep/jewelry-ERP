// DEC-1 Part 4: the UX-1 finding "Settings offers 9, 12 and 14 K but POST /gold-rates takes only 18, 21, 22, 24" was
// fixed by PRC-1 (D-prc1-7: rates follow inventory.allowedKarats). This test closes it. Both projects.
//   * with every karat the Settings screen offers allowed, both selling rates can be set for each of them;
//   * with fewer karats allowed, every other karat from 1 to 24 is refused for both selling rates, and a karat outside
//     1–24 is refused by the request schema. No karat is invented: the list is the screen's own.
// Scrap buying rates stay open to any karat 1–24 (broken scrap of any karat is bought, D-4-1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

/** The karats the Settings screen offers as "allowed karats" (frontend/src/pages/admin/SettingsPage.tsx KARAT_CHOICES). */
const SCREEN_KARATS = [9, 12, 14, 18, 21, 22, 24];

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: ReturnType<typeof request.agent>;
const allow = (karats: number[]) => ctx.settings.apply(ctx.db, { 'inventory.allowedKarats': karats }, { actor: { id: null, username: 'test' } });

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = withIdempotencyKeys(request.agent(app));
  const res = await gm.post('/api/auth/login').send({ username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER });
  gm.set('x-csrf-token', res.body.csrfToken);
  expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
});
afterAll(async () => handle?.close());

describe('selling rates follow the allowed karats (UX-1 finding, closed)', () => {
  it('the Settings screen offers exactly the karats this test covers', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../frontend/src/pages/admin/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain(`const KARAT_CHOICES = [${SCREEN_KARATS.join(', ')}];`);
  });

  it('every karat the screen offers can get both selling rates', async () => {
    await allow(SCREEN_KARATS);
    // Karats with no rate yet (first rates are not checked by the edit guard); 21K already has rates in the world.
    const fresh = SCREEN_KARATS.filter((k) => k !== 21);
    const r = await gm.post('/api/gold-rates').send({
      rates: Object.fromEntries(fresh.map((k) => [k, 100_000 + k * 1_000])),
      usedRates: Object.fromEntries(fresh.map((k) => [k, 90_000 + k * 1_000])),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const k of fresh) {
      expect(r.body.current[k].pricePerGram, `${k}K new`).toBe(100_000 + k * 1_000);
      expect(r.body.used[k].pricePerGram, `${k}K used`).toBe(90_000 + k * 1_000);
    }
  });

  it('with fewer karats allowed, every other karat 1–24 is refused for both selling rates', async () => {
    await allow([21]);
    for (let k = 1; k <= 24; k++) {
      if (k === 21) continue;
      for (const field of ['rates', 'usedRates']) {
        const r = await gm.post('/api/gold-rates').send({ [field]: { [k]: 150_000 } });
        expect(r.status, `${k}K ${field}`).toBe(400);
        expect(r.body.error.params).toEqual({ karat: String(k) });
      }
    }
    for (const bad of ['0', '25', '99']) expect((await gm.post('/api/gold-rates').send({ rates: { [bad]: 150_000 } })).status, bad).toBe(400);
    // The allowed karat itself still takes a rate (a small change: no reason needed).
    const now = (await gm.get('/api/gold-rates')).body.current['21'].pricePerGram as number;
    expect((await gm.post('/api/gold-rates').send({ rates: { 21: now + 1 } })).status).toBe(200);
  });
});
