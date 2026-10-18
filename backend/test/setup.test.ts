// REM-3: a new system has no demo data; the General Manager's first steps are derived from real data,
// ALLOWED_KARATS_INITIAL applies on the first start only, and empty totals are zeros. Runs on PGlite AND
// real PostgreSQL.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { count, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { pureGoldMg } from '@jerp/shared';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { bootstrapProduction } from '../src/modules/bootstrap/service';
import { applyInitialInventorySettings, confirmAllowedKarats, setupStatus } from '../src/modules/setup/service';
import { createBranch } from '../src/modules/branches/service';
import { createUser } from '../src/modules/users/service';
import { setScrapRates } from '../src/modules/scrap/service';
import { companyDashboard } from '../src/modules/dashboard/service';
import { correctFunding, recordAdvance } from '../src/modules/funding/service';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;

beforeEach(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  const res = await bootstrapProduction(ctx, { username: 'golf.placeholder', fullName: 'Owner' });
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, res.username));
  gm = (await loadActor(ctx.db, u.id, null))!;
});
afterEach(async () => handle.close());

const done = async () => Object.fromEntries((await setupStatus(ctx, gm)).steps.map((s) => [s.key, s.done]));

describe('a new system', () => {
  it('holds no business data: no items, sales, purchases, suppliers, products or types (demo and production alike)', async () => {
    for (const table of [t.jewelryItems, t.sales, t.purchases, t.suppliers, t.products, t.categories, t.branches, t.scrapPurchases, t.transfers]) {
      expect((await ctx.db.select({ n: count() }).from(table))[0].n).toBe(0);
    }
    // Only the General Manager exists; the demo seed is gone from the product (REM-3).
    expect((await ctx.db.select({ n: count() }).from(t.users))[0].n).toBe(1);
  });

  it('shows zeros, not blanks, on the company dashboard before any branch exists', async () => {
    const d = await companyDashboard(ctx, gm, {});
    expect(d.branches).toEqual([]);
    for (const v of Object.values(d.totals)) expect(v).toBe(0);
  });
});

describe('first-steps checklist (GM home)', () => {
  it('starts with five open steps and closes each one only when the work is really done', async () => {
    expect(await setupStatus(ctx, gm)).toMatchObject({ complete: false, steps: [{ key: 'karats' }, { key: 'rates' }, { key: 'branch' }, { key: 'staff' }, { key: 'fund' }] });
    expect(await done()).toEqual({ karats: false, rates: false, branch: false, staff: false, fund: false });

    // 1. Allowed karats: an explicit confirmation by the GM, audited.
    await confirmAllowedKarats(ctx, gm, [21]);
    expect((await ctx.settings.get()).inventory).toEqual({ allowedKarats: [21], allowedKaratsConfirmed: true });
    const [audit] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, 'ALLOWED_KARATS_CONFIRMED'));
    expect(audit).toMatchObject({ descriptionKey: 'Allowed karats confirmed: {karats}' });
    expect(await done()).toMatchObject({ karats: true, rates: false });

    // 2. Rates: the gold sell rate alone is not enough; the scrap rate for every allowed karat too.
    await ctx.db.insert(t.goldRates).values({ karat: 21, pricePerGram: 190_000, setBy: gm.userId });
    expect(await done()).toMatchObject({ rates: false });
    await setScrapRates(ctx, gm, { 21: 150_000 });
    // PRC-1 (D-prc1-7): computed prices (the default of a new installation) also need the used-piece selling rate.
    expect(await done()).toMatchObject({ rates: false });
    await ctx.db.insert(t.goldRates).values({ karat: 21, kind: 'USED', pricePerGram: 175_000, setBy: gm.userId });
    expect(await done()).toMatchObject({ rates: true, branch: false });

    // 3. Branch, 4. staff: a branch manager AND a cashier.
    const b = await createBranch(ctx, gm, { code: 'KRT', name: 'Khartoum', nameAr: 'الخرطوم', city: 'Khartoum' });
    expect(await done()).toMatchObject({ branch: true, staff: false });
    await createUser(ctx, gm, { username: 'hotel.placeholder', fullName: 'Hotel', roleCode: 'BRANCH_MANAGER', branchId: b.id });
    expect(await done()).toMatchObject({ staff: false });
    await createUser(ctx, gm, { username: 'india.placeholder', fullName: 'India', roleCode: 'CASHIER', branchId: b.id });
    expect(await setupStatus(ctx, gm)).toMatchObject({ complete: false });

    // 5. CSH-2 (Q8): every active branch funded with an advance into its drawer. A bank advance does not count, nor
    // a corrected one; a second branch opens the step again until it is funded too.
    expect(await done()).toMatchObject({ staff: true, fund: false });
    await recordAdvance(ctx, gm, { branchId: b.id, account: 'BANK', amount: 500_000, reason: 'test bank funding', bankReference: 'TEST-0001' });
    expect(await done()).toMatchObject({ fund: false });
    const wrong = await recordAdvance(ctx, gm, { branchId: b.id, account: 'CASH', amount: 100_000, reason: 'test drawer float' });
    expect(await done()).toMatchObject({ fund: true });
    await correctFunding(ctx, gm, wrong.id, { reason: 'test: recorded by mistake' });
    expect(await done()).toMatchObject({ fund: false });
    await recordAdvance(ctx, gm, { branchId: b.id, account: 'CASH', amount: 100_000, reason: 'test drawer float' });
    expect(await setupStatus(ctx, gm)).toMatchObject({ complete: true });
    const b2 = await createBranch(ctx, gm, { code: 'OMD', name: 'Omdurman', nameAr: 'أم درمان', city: 'Omdurman' });
    expect(await done()).toMatchObject({ fund: false });
    await recordAdvance(ctx, gm, { branchId: b2.id, account: 'CASH', amount: 100_000, reason: 'test drawer float' });
    expect(await setupStatus(ctx, gm)).toMatchObject({ complete: true });
  });

  it('only the General Manager sees or changes it', async () => {
    const b = await createBranch(ctx, gm, { code: 'KRT', name: 'Khartoum', nameAr: 'الخرطوم', city: 'Khartoum' });
    const u = await createUser(ctx, gm, { username: 'hotel.placeholder', fullName: 'Hotel', roleCode: 'BRANCH_MANAGER', branchId: b.id });
    const bm = (await loadActor(ctx.db, u.id, null))!;
    await expect(setupStatus(ctx, bm)).rejects.toMatchObject({ status: 403 });
    await expect(confirmAllowedKarats(ctx, bm, [21])).rejects.toMatchObject({ status: 403 });
  });
});

describe('ALLOWED_KARATS_INITIAL', () => {
  it('sets the allowed karats on the first start only, and is not a confirmation', async () => {
    await applyInitialInventorySettings(ctx, { allowedKarats: [21] });
    expect((await ctx.settings.get()).inventory).toEqual({ allowedKarats: [21], allowedKaratsConfirmed: false });
    const [row] = await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.entityId, 'inventory.allowedKarats'));
    expect(row).toMatchObject({ action: 'SETTINGS_CHANGED', userId: null });
    // A later start with another value changes nothing (the row exists now).
    expect(await applyInitialInventorySettings(ctx, { allowedKarats: [18, 21] })).toEqual([]);
    expect((await ctx.settings.get()).inventory.allowedKarats).toEqual([21]);
    expect(await done()).toMatchObject({ karats: false });
  });

  it('is read from the environment, and an invalid value stops the start', () => {
    expect(loadConfig({ APP_MODE: 'demo', ALLOWED_KARATS_INITIAL: '21' } as NodeJS.ProcessEnv).allowedKaratsInitial).toEqual([21]);
    expect(loadConfig({ APP_MODE: 'demo', ALLOWED_KARATS_INITIAL: ' 21, 18 ' } as NodeJS.ProcessEnv).allowedKaratsInitial).toEqual([21, 18]);
    expect(loadConfig({ APP_MODE: 'demo' } as NodeJS.ProcessEnv).allowedKaratsInitial).toBeUndefined();
    for (const bad of ['7', '25', '21,21', 'x', '21.5', '21;18']) {
      expect(() => loadConfig({ APP_MODE: 'demo', ALLOWED_KARATS_INITIAL: bad } as NodeJS.ProcessEnv)).toThrow(/ALLOWED_KARATS_INITIAL/);
    }
  });
});

describe('pure-gold debts at milligram precision (Q-14 closed, WGT-1 deferred)', () => {
  it('for every karat 1–24, every integer owed amount is the rounded 24K equivalent of some whole-milligram weight', () => {
    // The conversion step round((n+1)·k/24) − round(n·k/24) is at most 1 mg, so no integer is skipped.
    for (let k = 1; k <= 24; k++) {
      let prev = pureGoldMg(0, k);
      for (let n = 1; n <= 24 * 50; n++) {
        const cur = pureGoldMg(n, k);
        expect(cur - prev).toBeGreaterThanOrEqual(0);
        expect(cur - prev).toBeLessThanOrEqual(1);
        prev = cur;
      }
    }
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 24 }), fc.integer({ min: 0, max: 50_000_000 }), (k, owed) => {
        // The smallest net weight whose equivalent reaches `owed` gives exactly `owed`.
        let lo = 0;
        let hi = Math.ceil((owed * 24) / k) + 24;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (pureGoldMg(mid, k) >= owed) hi = mid;
          else lo = mid + 1;
        }
        return pureGoldMg(lo, k) === owed;
      }),
      { numRuns: 5_000 },
    );
  });
});
