// DEC-1 (Q-2, D-dec1-1, D-dec1-12): no discounts in this trade. Both projects.
//   * the default discount cap is 0 for every role (a database that never stored the setting);
//   * with caps 0 the server refuses any discount, for the cashier, the branch manager and the General Manager, and
//     /auth/me tells the POS the cap is 0 (it then shows no discount field);
//   * the setting stays editable: once the General Manager sets a cap, a discount within it is accepted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { DEFAULT_SETTINGS } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createSale } from '../src/modules/sales/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let krt: number;

const actor = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
async function login(username: string, password: string) {
  const a = withIdempotencyKeys(request.agent(app));
  const res = await a.post('/api/auth/login').send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  a.set('x-csrf-token', res.body.csrfToken);
  return a;
}
const pieces = async (n: number) =>
  ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, krt), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(n);

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  // The world stores caps of its own (test values); go back to the product default for this file.
  await ctx.settings.apply(ctx.db, { 'sales.maxDiscountPercentByRole': DEFAULT_SETTINGS.sales.maxDiscountPercentByRole }, { actor: { id: null, username: 'test' } });
});
afterAll(async () => handle?.close());

describe('discounts are off by default', () => {
  it('the default cap is 0 for every role', () => {
    expect(DEFAULT_SETTINGS.sales.maxDiscountPercentByRole).toEqual({ CASHIER: 0, BRANCH_MANAGER: 0, GENERAL_MANAGER: 0 });
  });

  it('with caps 0 a discount is refused for the cashier, the branch manager and the General Manager', async () => {
    const people = [await actor('cashier.kh.01'), await actor('branch.manager.kh'), await actor('general.manager')];
    const stock = await pieces(people.length);
    for (const [i, a] of people.entries()) {
      const err = await createSale(ctx, a, { branchId: krt, items: [{ itemId: stock[i].id, discount: 1_000 }], paymentMethod: 'CASH', priceChangeReason: 'test reason' }).then(
        () => null,
        (e: unknown) => e as { status: number; key: string; params: Record<string, unknown> },
      );
      expect(err, a.roleCode).not.toBeNull();
      expect(err!.status, a.roleCode).toBe(403);
      expect(err!.key).toBe('Discount on {code} exceeds your limit of {pct}%');
      expect(err!.params.pct).toBe(0);
    }
    // Without a discount the same pieces sell (the sale itself is untouched).
    const sold = await createSale(ctx, people[0], { branchId: krt, items: [{ itemId: stock[0].id }], paymentMethod: 'CASH' });
    expect(sold.discountTotal).toBe(0);
  });

  it('/auth/me tells the POS the cap is 0; once the General Manager sets a cap, a discount within it is accepted', async () => {
    const cashier = await login('cashier.kh.01', DEMO_PASSWORDS.CASHIER);
    expect((await cashier.get('/api/auth/me')).body.maxDiscountPercent).toBe(0);
    const gm = await login('general.manager', DEMO_PASSWORDS.GENERAL_MANAGER);
    expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
    const versions = (await gm.get('/api/settings')).body.versions;
    const put = await gm.put('/api/settings').send({ changes: { 'sales.maxDiscountPercentByRole': { CASHIER: 5, BRANCH_MANAGER: 0, GENERAL_MANAGER: 0 } }, expectedVersions: { 'sales.maxDiscountPercentByRole': versions['sales.maxDiscountPercentByRole'] } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await cashier.get('/api/auth/me')).body.maxDiscountPercent).toBe(5);
    const [piece] = await pieces(1);
    const discount = Math.floor((piece.sellingPrice * 5) / 100);
    const sale = await createSale(ctx, await actor('cashier.kh.01'), { branchId: krt, items: [{ itemId: piece.id, discount }], paymentMethod: 'CASH', priceChangeReason: 'test reason' });
    expect(sale.discountTotal).toBe(discount);
    const [p2] = await pieces(1);
    const over = await createSale(ctx, await actor('cashier.kh.01'), { branchId: krt, items: [{ itemId: p2.id, discount: Math.floor((p2.sellingPrice * 5) / 100) + 1 }], paymentMethod: 'CASH', priceChangeReason: 'test reason' }).catch((e: { status: number }) => e);
    expect((over as { status: number }).status).toBe(403);
  });
});
