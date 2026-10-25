// PAY-1 (docs/plans/PAY-1.md §5; D-dec1-5): Hasad is a sales channel only; its money is paid to the General Manager's
// account, never the branch's.
// - the daily reconciliation: the branch's sales, refunds, expected cash and bank exclude Hasad; the Hasad figures of
//   the day (sales made, sales voided) come from the payment lines and are shown beside them (Hasad versus direct);
// - the sales report: channels from the payment lines (a split sale counts each part under its own method; the channels
//   add up to the total; the sale count counts it once), Hasad versus direct, the split-sale count, the lines per row;
// - owner addition 1: the dashboard and the branch/company homes count Hasad sales in revenue and sale counts, but no
//   figure labelled cash, drawer or bank includes Hasad money.
// The test works in its own branch, on a fixed business day, and funds its own drawer (CLAUDE.md testing rules).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createSale, voidSale } from '../src/modules/sales/service';
import { balances, drawer, reconciliation } from '../src/modules/ledger/service';
import { createBranch } from '../src/modules/branches/service';
import { createUser } from '../src/modules/users/service';
import { createPurchase } from '../src/modules/purchases/service';
import { recordAdvance } from '../src/modules/funding/service';
import { branchDashboard, companyDashboard } from '../src/modules/dashboard/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gm: Actor;
let cashier: Actor;
let branchId: number;

const PRICE = 1_500_000;
const DAY = '2026-10-20';
const FUNDED_AT = new Date('2026-10-19T08:00:00Z');
const SOLD_AT = new Date('2026-10-20T08:00:00Z');
const VOIDED_AT = new Date('2026-10-20T10:00:00Z');
const FUND_CASH = 5_000_000;
const FUND_BANK = 5_000_000;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const pieces: number[] = [];

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await actorOf('general.manager');
  branchId = (await createBranch(ctx, gm, { code: 'PYR', name: 'Payments report test', nameAr: 'فرع اختبار تقارير الدفع', city: 'Test' })).id;
  await createUser(ctx, gm, { username: 'pyr.cashier', fullName: 'PYR cashier', roleCode: 'CASHIER', branchId });
  cashier = await actorOf('pyr.cashier');
  await recordAdvance(ctx, gm, { branchId, account: 'CASH', amount: FUND_CASH, reason: 'test drawer float' }, { at: FUNDED_AT });
  await recordAdvance(ctx, gm, { branchId, account: 'BANK', amount: FUND_BANK, reason: 'test bank funding', bankReference: 'PYR-FUND-1' }, { at: FUNDED_AT });
  const [p] = await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).orderBy(asc(t.products.id)).limit(1);
  const [s] = await ctx.db.select().from(t.suppliers).orderBy(asc(t.suppliers.id)).limit(1);
  const line = { productId: p.id, grossWeightMg: 4_100, netWeightMg: 4_000, purchaseCost: 700_000, makingCost: 0, otherCost: 0, sellingPrice: PRICE };
  await createPurchase(ctx, gm, { branchId, supplierId: s.id, confirmOpenSupplierDebt: true, lines: Array.from({ length: 4 }, () => line) });
  pieces.push(...(await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, branchId), eq(t.jewelryItems.status, 'AVAILABLE'))).orderBy(asc(t.jewelryItems.id))).map((i) => i.id));
});
afterAll(async () => handle?.close());

describe('Hasad versus direct sales', () => {
  // A: cash 1,500,000 · B: Hasad 1,500,000 · C: Hasad 1,000,000 + cash 500,000 (voided later) · D: cash 300,000 + bank 1,200,000
  let c: { id: number };
  beforeAll(async () => {
    await createSale(ctx, cashier, { items: [{ itemId: pieces[0] }], paymentMethod: 'CASH' }, { at: SOLD_AT });
    await createSale(ctx, cashier, { items: [{ itemId: pieces[1] }], paymentMethod: 'HASAD', paymentRefInvoice: 'HSD-PYR-B' }, { at: SOLD_AT });
    c = await createSale(ctx, cashier, { items: [{ itemId: pieces[2] }], payments: [{ method: 'HASAD', amount: 1_000_000, refInvoice: 'HSD-PYR-C' }, { method: 'CASH', amount: 500_000 }] }, { at: SOLD_AT });
    await createSale(ctx, cashier, { items: [{ itemId: pieces[3] }], payments: [{ method: 'CASH', amount: 300_000 }, { method: 'BANK_TRANSFER', amount: 1_200_000, refTransaction: 'PYR-D-1' }] }, { at: SOLD_AT });
  });

  it('the reconciliation of the day: the branch money excludes Hasad; the Hasad figures come from the lines', async () => {
    const r = await reconciliation(ctx, gm, { branchId, day: DAY });
    const by = (m: string) => r.salesByMethod.find((x) => x.paymentMethod === m)!.amount;
    expect([by('CASH'), by('BANK_TRANSFER'), by('HASAD')]).toEqual([2_300_000, 1_200_000, 2_500_000]);
    expect(r.salesTotal).toBe(3_500_000);
    expect(r.hasadSales).toBe(2_500_000);
    expect(r.cashMovement).toBe(2_300_000);
    expect(r.bankMovement).toBe(1_200_000);
    expect(r.openingCash).toBe(FUND_CASH);
    expect(r.expectedCash).toBe(FUND_CASH + 2_300_000);
    expect(r.bankTransferSales.map((x) => [x.amount, x.reference])).toEqual([[1_200_000, 'PYR-D-1']]);
  });

  it('a void of the Hasad + cash sale refunds the cash part only; the Hasad part shows as a cancelled Hasad sale', async () => {
    const cash = async () => (await balances(ctx.db, branchId)).find((b) => b.kind === 'CASH')!.balance;
    const before = await cash();
    await voidSale(ctx, gm, c.id, 'test void', { at: VOIDED_AT });
    expect(await cash()).toBe(before - 500_000);
    const r = await reconciliation(ctx, gm, { branchId, day: DAY });
    const voidOf = (m: string) => r.voidsByMethod.find((x) => x.paymentMethod === m)!.amount;
    expect([voidOf('CASH'), voidOf('HASAD')]).toEqual([-500_000, -1_000_000]);
    expect(r.voidsTotal).toBe(-500_000);
    expect(r.hasadVoids).toBe(-1_000_000);
    expect(r.expectedCash).toBe(FUND_CASH + 2_300_000 - 500_000);
  });

  it('the sales report: channels from the lines add up to the total; Hasad versus direct; the split count; the lines per row', async () => {
    const a = withIdempotencyKeys(request.agent(app));
    const login = await a.post('/api/auth/login').send({ username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER });
    a.set('x-csrf-token', login.body.csrfToken);
    const r = (await a.get(`/api/reports/sales?branchId=${branchId}&from=${DAY}&to=${DAY}`)).body;
    const tile = (label: string) => r.summary.find((x: { label: string }) => x.label === label)?.value;
    expect([tile('CASH'), tile('BANK_TRANSFER'), tile('HASAD')]).toEqual([1_800_000, 1_200_000, 1_500_000]);
    expect(tile('Direct sales (cash and bank)')).toBe(3_000_000);
    expect(tile("Hasad (paid to the General Manager's account)")).toBe(1_500_000);
    expect(tile('Sales paid by two methods')).toBe(1);
    expect(r.totals.total).toBe(4_500_000);
    expect(tile('CASH') + tile('BANK_TRANSFER') + tile('HASAD')).toBe(r.totals.total);
    expect(r.rowCount).toBe(4); // the voided sale is listed; the totals leave it out
    const split = r.rows.find((x: { paymentMethod: string; status: string }) => x.paymentMethod === 'SPLIT' && x.status === 'COMPLETED');
    expect(split.payments).toEqual([
      { method: 'CASH', amount: 300_000, refInvoice: null, refTransaction: null },
      { method: 'BANK_TRANSFER', amount: 1_200_000, refInvoice: null, refTransaction: 'PYR-D-1' },
    ]);
    expect(r.columns.map((x: { key: string }) => x.key)).toContain('payments');
  });

  it('owner addition 1: homes count Hasad sales in revenue and counts; no cash, drawer or bank figure includes Hasad money', async () => {
    const ledger = Object.fromEntries((await balances(ctx.db, branchId)).map((b) => [b.kind, b.balance]));
    const cashNow = FUND_CASH + 2_300_000 - 500_000;
    const bankNow = FUND_BANK + 1_200_000;
    expect([ledger.CASH, ledger.BANK]).toEqual([cashNow, bankNow]);
    // Branch home: revenue and count include the Hasad sale (B) and the split sale (D); expected cash is the drawer.
    const home = await branchDashboard(ctx, gm, { branchId, date: DAY });
    expect([home.kpis.salesTotal, home.kpis.salesCount]).toEqual([4_500_000, 3]);
    expect(home.expectedCash).toBe(cashNow);
    // Company home: the branch's revenue and count include Hasad; it shows no cash or bank figure.
    const company = await companyDashboard(ctx, gm, { from: DAY, to: DAY });
    const row = company.branches.find((b) => b.code === 'PYR')!;
    expect([row.revenue, row.salesCount]).toEqual([4_500_000, 3]);
    expect(JSON.stringify(Object.keys(company.totals))).not.toMatch(/cash|bank|drawer/i);
    // Cash screen: the drawer and the bank of the branch.
    const d = (await drawer(ctx, gm, { branchId })).branches.find((b) => b.branchId === branchId)!;
    expect([d.expectedCash, d.bank]).toEqual([cashNow, bankNow]);
  });
});
