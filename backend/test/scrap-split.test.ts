// CSH-2 piece A (docs/plans/CSH-2.md §4, D-csh-7): a counter scrap purchase paid part cash, part bank transfer.
// Both projects. The parts add up to the amount exactly; each posts its own ledger entry (CASH, BANK); a bank part needs
// its reference; the label CASH / BANK_TRANSFER / SPLIT follows the parts; the database refuses an inconsistent row;
// the reconciliation's drawer line counts only the cash part; reverseRef reverses both parts (Q6: the future scrap void
// will rely on it; SCR-VOID is in the BACKLOG).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { valueOfWeight } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { balances, reconciliation, reverseRef } from '../src/modules/ledger/service';
import { buyScrap, listScrapPurchases, scrapRates } from '../src/modules/scrap/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let bm: Actor;
let krt: number;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const bal = async (kind: string) => (await balances(ctx.db, krt)).find((b) => b.kind === kind)?.balance ?? 0;
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; key?: string }) => e);
const amountFor = async (mg: number, karat = 21) => valueOfWeight(mg, (await scrapRates(ctx.db))[karat].pricePerGram);
const broken = (mg: number) => ({ branchId: krt, kind: 'BROKEN' as const, karat: 21, grossWeightMg: mg, netWeightMg: mg });

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  bm = await actorOf('branch.manager.kh');
  krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
});
afterAll(async () => handle?.close());

describe('split payment', () => {
  it('part cash, part bank: two entries, the label SPLIT, the normalized reference; the drawer line counts only the cash part', async () => {
    const amount = await amountFor(10_000);
    const cashAmount = Math.floor(amount / 3);
    const [cash0, bank0] = [await bal('CASH'), await bal('BANK')];
    const rec0 = await reconciliation(ctx, bm, { branchId: krt });
    const r = await buyScrap(ctx, bm, { ...broken(10_000), cashAmount, bankAmount: amount - cashAmount, bankReference: 'trf ٥٥٥١' });
    expect(r).toMatchObject({ paymentMethod: 'SPLIT', cashAmount, bankAmount: amount - cashAmount, bankReference: 'TRF 5551', amount });
    expect(await bal('CASH')).toBe(cash0 - cashAmount);
    expect(await bal('BANK')).toBe(bank0 - (amount - cashAmount));
    const entries = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'scrap_purchase'), eq(t.ledgerEntries.refId, r.id)));
    expect(entries.map((e) => e.amount).sort((a, z) => a - z)).toEqual([-cashAmount, -(amount - cashAmount)].sort((a, z) => a - z));
    const rec1 = await reconciliation(ctx, bm, { branchId: krt });
    const line = (rec: typeof rec0, l: string) => rec.cashLines.find((x) => x.line === l)!.amount;
    expect(line(rec1, 'SCRAP_PURCHASES') - line(rec0, 'SCRAP_PURCHASES')).toBe(-cashAmount);
    expect(rec1.scrapPurchasesCash - rec0.scrapPurchasesCash).toBe(-cashAmount);
    expect(rec1.scrapPurchasesBank - rec0.scrapPurchasesBank).toBe(-(amount - cashAmount));
    expect(rec1.cashLines.reduce((s, l) => s + l.amount, 0)).toBe(rec1.cashMovement);
    const listed = (await listScrapPurchases(ctx, bm, {})).rows.find((x) => x.id === r.id);
    expect(listed).toMatchObject({ paymentMethod: 'SPLIT', cashAmount, bankAmount: amount - cashAmount, bankReference: 'TRF 5551' });
  });

  it('the Cash drill-down lists each purchase under each account with its own part, adding up to the line', async () => {
    const rec = await reconciliation(ctx, bm, { branchId: krt });
    for (const [account, lines] of [['CASH', rec.cashLines], ['BANK', rec.bankLines]] as const) {
      const rows = rec.scrapPurchases.filter((x) => x.account === account);
      expect(rows.reduce((s, x) => s + x.amount, 0), account).toBe(lines.find((l) => l.line === 'SCRAP_PURCHASES')!.amount);
    }
    const split = rec.scrapPurchases.filter((x) => x.reference === 'TRF 5551');
    expect(split).toHaveLength(1);
    const both = rec.scrapPurchases.filter((x) => x.number === split[0].number);
    expect(both.map((x) => x.account).sort()).toEqual(['BANK', 'CASH']);
    expect(both.every((x) => x.paymentMethod === 'SPLIT')).toBe(true);
    expect(both.find((x) => x.account === 'CASH')!.reference).toBeNull();
  });

  it('a part of 0 posts nothing; the label follows the parts', async () => {
    const amount = await amountFor(2_000);
    const allCash = await buyScrap(ctx, bm, { ...broken(2_000), cashAmount: amount, bankAmount: 0 });
    expect(allCash).toMatchObject({ paymentMethod: 'CASH', bankAmount: 0, bankReference: null });
    const allBank = await buyScrap(ctx, bm, { ...broken(2_000), cashAmount: 0, bankAmount: amount, bankReference: 'TRF-0002' });
    expect(allBank).toMatchObject({ paymentMethod: 'BANK_TRANSFER', cashAmount: 0 });
    for (const id of [allCash.id, allBank.id]) {
      expect(await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'scrap_purchase'), eq(t.ledgerEntries.refId, id)))).toHaveLength(1);
    }
    // The whole-amount shorthand gives the same rows.
    expect(await buyScrap(ctx, bm, { ...broken(2_000), paymentMethod: 'CASH' })).toMatchObject({ paymentMethod: 'CASH', cashAmount: amount, bankAmount: 0 });
  });

  it('refuses parts that do not add up, negative parts, a bank part without a reference, and both forms at once', async () => {
    const amount = await amountFor(3_000);
    expect((await err(buyScrap(ctx, bm, { ...broken(3_000), cashAmount: amount - 1, bankAmount: 0 })))?.key).toMatch(/must add up to the amount/);
    expect((await err(buyScrap(ctx, bm, { ...broken(3_000), cashAmount: amount + 1, bankAmount: -1, bankReference: 'TRF-1' })))?.status).toBe(400);
    expect((await err(buyScrap(ctx, bm, { ...broken(3_000), cashAmount: 0, bankAmount: amount })))?.key).toMatch(/bank transfer reference/);
    expect((await err(buyScrap(ctx, bm, { ...broken(3_000), paymentMethod: 'BANK_TRANSFER' })))?.key).toMatch(/bank transfer reference/);
    expect((await err(buyScrap(ctx, bm, { ...broken(3_000), paymentMethod: 'CASH', cashAmount: amount, bankAmount: 0 })))?.key).toMatch(/not both/);
  });

  it('the database refuses an inconsistent row (parts that do not add up, a wrong label, a bank part without a reference)', async () => {
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'branch.manager.kh'));
    const row = (over: Record<string, unknown>) => ({
      number: `T-${Math.random().toString(36).slice(2, 10)}`,
      branchId: krt,
      kind: 'BROKEN',
      karat: 21,
      grossWeightMg: 1000,
      netWeightMg: 1000,
      scrapRatePerGram: 100_000,
      agreedRatePerGram: 100_000,
      deviationBp: 0,
      amount: 100_000,
      paymentMethod: 'SPLIT',
      cashAmount: 60_000,
      bankAmount: 40_000,
      bankReference: 'TRF-9999',
      createdBy: u.id,
      ...over,
    });
    const refused = async (over: Record<string, unknown>, constraint: string) => {
      const e = await ctx.db.insert(t.scrapPurchases).values(row(over) as never).then(() => null, (x: Error & { cause?: Error }) => `${x.message} ${x.cause?.message ?? ''}`);
      expect(e, constraint).toContain(constraint);
    };
    await refused({ cashAmount: 50_000 }, 'ck_scrap_purchases_payment_parts');
    await refused({ paymentMethod: 'CASH' }, 'ck_scrap_purchases_payment_label');
    await refused({ bankReference: null }, 'ck_scrap_purchases_bank_reference');
    await expect(ctx.db.execute(sql`UPDATE scrap_purchases SET cash_amount = cash_amount WHERE id = (SELECT min(id) FROM scrap_purchases)`)).rejects.toThrow();
  });

  it('reverseRef reverses BOTH parts of a split purchase (the future scrap void, SCR-VOID, relies on it)', async () => {
    const amount = await amountFor(4_000);
    const r = await buyScrap(ctx, bm, { ...broken(4_000), cashAmount: 1_000, bankAmount: amount - 1_000, bankReference: 'TRF-4000' });
    const [cash0, bank0] = [await bal('CASH'), await bal('BANK')];
    const n = await ctx.db.transaction((tx) => reverseRef(tx, { refType: 'scrap_purchase', refId: r.id, refNumber: r.number }, 'SCRAP_PURCHASE', 'REVERSAL', { actor: null }));
    expect(n).toBe(2);
    expect(await bal('CASH')).toBe(cash0 + 1_000);
    expect(await bal('BANK')).toBe(bank0 + amount - 1_000);
  });

  it('the HTTP route takes the two parts (and still the whole-amount method)', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ username: 'branch.manager.kh', password: DEMO_PASSWORDS.BRANCH_MANAGER });
    agent.set('x-csrf-token', login.body.csrfToken);
    const amount = await amountFor(1_500);
    const res = await agent.post('/api/scrap-purchases').set('Idempotency-Key', crypto.randomUUID()).send({ kind: 'BROKEN', karat: 21, grossWeightMg: 1_500, netWeightMg: 1_500, cashAmount: 500, bankAmount: amount - 500, bankReference: 'TRF-1500' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ paymentMethod: 'SPLIT', cashAmount: 500 });
    const bad = await agent.post('/api/scrap-purchases').set('Idempotency-Key', crypto.randomUUID()).send({ kind: 'BROKEN', karat: 21, grossWeightMg: 1_500, netWeightMg: 1_500, cashAmount: 500, bankAmount: 1 });
    expect(bad.status).toBe(400);
  });
});
