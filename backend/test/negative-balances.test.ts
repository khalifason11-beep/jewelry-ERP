// CSH-2 piece C (Q7, D-csh-8): the drawer never pays out money it does not hold (BLOCK), the bank may go below zero
// (WARN: attention A17). Both projects. Every drawer outflow kind is refused with the shortfall and what to do, and a
// refused outflow changes nothing; the bank part of a payment is never refused; A17 is critical for the General
// Manager, the branch manager sees their own branch only, and it clears once the money is recorded.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { valueOfWeight } from '@jerp/shared';
import { dayKey } from '../src/core/time';
import { createContext } from '../src/bootstrap';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { balances, DRAWER_SHORT } from '../src/modules/ledger/service';
import { createBranch } from '../src/modules/branches/service';
import { createUser } from '../src/modules/users/service';
import { createPurchase } from '../src/modules/purchases/service';
import { createSale, voidSale } from '../src/modules/sales/service';
import { buyScrap, scrapRates } from '../src/modules/scrap/service';
import { correctFunding, recordAdvance, recordRepayment } from '../src/modules/funding/service';
import { attentionFor } from '../src/modules/attention/service';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let bm: Actor;
let otherBm: Actor;
let branchId: number;
let productId: number;
let supplierId: number;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const bal = async (kind: string) => (await balances(ctx.db, branchId)).find((b) => b.kind === kind)!.balance;
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string; params?: Record<string, string> }) => e);
const line = (makingCost: number, sellingPrice = 1_500_000) => ({ productId, grossWeightMg: 4_100, netWeightMg: 4_000, purchaseCost: 700_000, makingCost, otherCost: 0, sellingPrice });
const a17 = async (who: Actor) => (await attentionFor(ctx, who)).signals.filter((s) => s.code === 'A17');

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  gm = await actorOf('general.manager');
  otherBm = await actorOf('branch.manager.kh');
  branchId = (await createBranch(ctx, gm, { code: 'TST', name: 'Test branch', nameAr: 'فرع الاختبار', city: 'Test' })).id;
  await createUser(ctx, gm, { username: 'test.bm.tst', fullName: 'Test BM', roleCode: 'BRANCH_MANAGER', branchId });
  bm = await actorOf('test.bm.tst');
  productId = (await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)))[0].id;
  supplierId = (await ctx.db.select().from(t.suppliers))[0].id;
  await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: 1_000_000, reason: 'test drawer float' });
});
afterAll(async () => handle?.close());

describe('BLOCK: the drawer', () => {
  it('MKC-1: a supplier order never touches the drawer, whatever its making charge (the owner pays it personally)', async () => {
    const today = dayKey(new Date(), (await ctx.settings.get()).company.timezone);
    await createPurchase(ctx, gm, { branchId, supplierId, lines: [line(1_200_000)], makingChargeReference: 'TEST-MKC-0001', makingChargeTransferDate: today });
    expect(await bal('CASH')).toBe(1_000_000);
    expect(await bal('BANK')).toBe(0);
    expect(Object.keys(DRAWER_SHORT)).not.toContain('MAKING_CHARGE');
  });

  it('a scrap cash part larger than the drawer is refused; the bank part never is', async () => {
    const rate = (await scrapRates(ctx.db))[21].pricePerGram;
    const mg = 10_000;
    const amount = valueOfWeight(mg, rate);
    expect(amount).toBeGreaterThan(1_000_000);
    const scrap = (pay: Record<string, unknown>) => buyScrap(ctx, gm, { branchId, kind: 'BROKEN', karat: 21, grossWeightMg: mg, netWeightMg: mg, ...pay });
    const e = await refusal(scrap({ paymentMethod: 'CASH' }));
    expect(e).toMatchObject({ status: 409, code: 'DRAWER_SHORT', params: { balance: '1,000,000', short: (amount - 1_000_000).toLocaleString('en-US') } });
    expect(e?.key).toMatch(/Pay \{short\} more by bank transfer, or ask the General Manager to record an advance/);
    expect(await ctx.db.select().from(t.scrapPurchases).where(eq(t.scrapPurchases.branchId, branchId))).toHaveLength(0);
    // The same purchase with the shortfall moved to the bank goes through, and takes the drawer to exactly 0.
    await scrap({ cashAmount: 1_000_000, bankAmount: amount - 1_000_000, bankReference: 'TEST-SCR-1' });
    expect(await bal('CASH')).toBe(0);
    expect(await bal('BANK')).toBeLessThan(0);
  });

  it('a cash refund (sale void), a repayment from the drawer and the correction of a drawer advance are refused when the drawer is short', async () => {
    await recordAdvance(ctx, gm, { branchId, account: 'BANK', amount: 5_000_000, reason: 'test bank funding', bankReference: 'TEST-0001' });
    await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: 300_000, reason: 'test drawer float' });
    const [item] = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, branchId), eq(t.jewelryItems.status, 'AVAILABLE')));
    const sale = await createSale(ctx, gm, { branchId, items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    expect(await bal('CASH')).toBe(300_000 + sale.total);
    await recordRepayment(ctx, gm, { branchId, account: 'CASH', amount: sale.total, reason: 'test repayment' });
    expect(await bal('CASH')).toBe(300_000);

    const v = await refusal(voidSale(ctx, gm, sale.id, 'test void'));
    expect(v).toMatchObject({ status: 409, code: 'DRAWER_SHORT', params: { balance: '300,000', amount: sale.total.toLocaleString('en-US'), short: (sale.total - 300_000).toLocaleString('en-US') } });
    expect(v?.key).toMatch(/refunding \{amount\} in cash.*then cancel the sale again/);
    expect((await ctx.db.select().from(t.sales).where(eq(t.sales.id, sale.id)))[0].status).toBe('COMPLETED');

    const r = await refusal(recordRepayment(ctx, gm, { branchId, account: 'CASH', amount: 300_001, reason: 'test repayment' }));
    expect(r).toMatchObject({ status: 409, code: 'DRAWER_SHORT', params: { short: '1' } });
    expect(r?.key).toMatch(/Repay at most \{balance\} from the drawer, or repay from the bank/);

    const float = await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: 400_000, reason: 'test: a float recorded twice' });
    await recordRepayment(ctx, gm, { branchId, account: 'CASH', amount: 400_000, reason: 'test repayment' });
    const c = await refusal(correctFunding(ctx, gm, float.id, { reason: 'test: recorded twice' }));
    expect(c).toMatchObject({ status: 409, code: 'DRAWER_SHORT', params: { balance: '300,000', amount: '400,000', short: '100,000' } });
    // Correcting a repayment puts money back into the drawer: never blocked.
    const [rep] = await ctx.db.select().from(t.gmFundingEvents).where(and(eq(t.gmFundingEvents.branchId, branchId), eq(t.gmFundingEvents.kind, 'REPAYMENT'), eq(t.gmFundingEvents.amount, 400_000)));
    await correctFunding(ctx, gm, rep.id, { reason: 'test: not repaid after all' });
    expect(await bal('CASH')).toBe(700_000);
    await correctFunding(ctx, gm, float.id, { reason: 'test: recorded twice' });
    expect(await bal('CASH')).toBe(300_000);

    // After an advance the void goes through (the recovery path the message names).
    await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: sale.total, reason: 'test drawer top-up' });
    await voidSale(ctx, gm, sale.id, 'test void');
    expect(await bal('CASH')).toBe(300_000);
  });

  it('a bank payment is never refused', async () => {
    const bank = await bal('BANK');
    await recordRepayment(ctx, gm, { branchId, account: 'BANK', amount: bank + 250_000, reason: 'test repayment below zero', bankReference: 'TEST-0004' });
    expect(await bal('BANK')).toBe(-250_000);
    await recordRepayment(ctx, gm, { branchId, account: 'BANK', amount: 10_000, reason: 'test repayment from the bank', bankReference: 'TEST-0003' });
    expect(await bal('BANK')).toBe(-260_000);
  });
});

describe('WARN: A17, the bank below zero', () => {
  it('is critical for the General Manager, shows to the branch manager of that branch only, and clears after an advance', async () => {
    expect(await bal('BANK')).toBe(-260_000);
    const forGm = await a17(gm);
    expect(forGm).toEqual([expect.objectContaining({ id: `A17:${branchId}`, severity: 'critical', branchId, link: `/cash?branchId=${branchId}`, params: expect.objectContaining({ amount: -260_000, branchAr: 'فرع الاختبار' }) })]);
    expect(await a17(bm)).toHaveLength(1);
    expect(await a17(otherBm)).toHaveLength(0);
    // The GM's branch view of another branch does not show it either.
    const kh = otherBm.branchId!;
    expect((await attentionFor(ctx, gm, { branchId: kh })).signals.filter((s) => s.code === 'A17')).toHaveLength(0);
    await recordAdvance(ctx, gm, { branchId, account: 'BANK', amount: 260_000, reason: 'test bank funding', bankReference: 'TEST-0002' });
    expect(await a17(gm)).toHaveLength(0);
  });
});

describe('the refusal sentences', () => {
  it('each names the shortfall and what to do, and has its Arabic (money isolated left to right)', () => {
    const ar = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/lib/i18n-ar.ts'), 'utf8');
    for (const key of Object.values(DRAWER_SHORT)) {
      expect(key).toContain('{short}');
      expect(key).toMatch(/General Manager|bank|record the advance/);
      const line = ar.split('\n').find((l) => l.includes(JSON.stringify(key)));
      expect(line, key).toBeTruthy();
      expect(line).toContain('\u2066{short}\u2069');
    }
  });
});
