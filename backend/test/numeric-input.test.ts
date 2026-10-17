// UX-1 PART 1 (docs/plans/UX-1.md §2, D-ux1-3): the server does not trust the screen. Every money, weight, karat and
// count field of the stock, price, rate, cash, funding and sale endpoints refuses a negative value, zero where zero
// is invalid, NaN (JSON carries it as null; a "NaN" string too), fractional money, fractional milligrams (more than
// 3 decimals of grams), an absurdly large value and a number sent as text, with 400 BAD_REQUEST naming the field.
// Each request is otherwise valid, and the answer must name the tampered field, so a refusal for another reason
// cannot pass for this one. Both projects.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, count, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: ReturnType<typeof request.agent>;
const ids = { branch: 0, supplier: 0, product: 0, item: 0, purchase: 0 };
let before: number[] = [];
const WRITTEN = () => [t.purchases, t.sales, t.scrapPurchases, t.supplierSettlements, t.goldRates, t.scrapRates, t.ledgerEntries, t.cashCounts, t.settingsHistory, t.jewelryItems];
const rowCounts = async () => Promise.all(WRITTEN().map(async (tbl) => (await ctx.db.select({ n: count() }).from(tbl))[0].n));

type Body = Record<string, unknown>;
type Kind = 'positiveMoney' | 'money' | 'weight' | 'karat' | 'percent' | 'count';

/** Values that must be refused, per kind of field (the reason is in the label). */
const BAD: Record<Kind, [string, unknown][]> = {
  positiveMoney: [['negative', -1], ['zero', 0], ['fractional', 1.5], ['NaN (null)', null], ['"NaN"', 'NaN'], ['text', '100'], ['above the cap', 1e13], ['absurd', 1e300]],
  money: [['negative', -1], ['fractional', 0.5], ['NaN (null)', null], ['"NaN"', 'NaN'], ['text', '0'], ['above the cap', 1e13], ['absurd', 1e300]],
  weight: [['negative', -1000], ['zero', 0], ['more than 3 decimals of grams', 1234.5], ['NaN (null)', null], ['"NaN"', 'NaN'], ['text', '1000'], ['above 10 kg', 10_000_001], ['absurd', 1e300]],
  karat: [['negative', -21], ['zero', 0], ['fractional', 21.5], ['above 24', 25], ['NaN (null)', null], ['"NaN"', 'NaN'], ['true', true], ['an array', [21]], ['text', '21']],
  percent: [['negative', -1], ['above 100', 101], ['NaN (null)', null], ['"NaN"', 'NaN'], ['text', '5'], ['absurd', 1e300]],
  count: [['negative', -1], ['zero', 0], ['fractional', 1.5], ['NaN (null)', null], ['"NaN"', 'NaN'], ['text', '24'], ['absurd', 1e300]],
};

interface Case {
  method: 'post' | 'put';
  path: () => string;
  base: () => Body;
  /** Dotted path of the field in the body, and how it is named in the error details. */
  field: string;
  kind: Kind;
  /** Kinds where zero is valid for this field are tested with `money`, not `positiveMoney`. */
}

function setIn(body: Body, dotted: string, value: unknown): Body {
  const copy = structuredClone(body);
  const keys = dotted.split('.');
  let o: Record<string, unknown> = copy;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[keys[keys.length - 1]] = value;
  return copy;
}

const purchase = () => ({
  branchId: ids.branch,
  supplierId: ids.supplier,
  lines: [{ productId: ids.product, grossWeightMg: 5_000, netWeightMg: 4_000, purchaseCost: 100_000, makingCost: 0, otherCost: 0, sellingPrice: 200_000 }],
});
const scrap = () => ({ branchId: ids.branch, kind: 'BROKEN', karat: 21, grossWeightMg: 5_000, netWeightMg: 4_000, agreedRatePerGram: 100_000, cashAmount: 400_000, bankAmount: 0 });
const funding = () => ({ branchId: ids.branch, account: 'CASH', amount: 1_000, reason: 'UX-1 refusal test' });

const CASES: Case[] = [
  ...(['grossWeightMg', 'netWeightMg'] as const).map((f): Case => ({ method: 'post', path: () => '/api/purchases', base: purchase, field: `lines.0.${f}`, kind: 'weight' })),
  ...(['purchaseCost', 'sellingPrice'] as const).map((f): Case => ({ method: 'post', path: () => '/api/purchases', base: purchase, field: `lines.0.${f}`, kind: 'positiveMoney' })),
  ...(['makingCost', 'otherCost'] as const).map((f): Case => ({ method: 'post', path: () => '/api/purchases', base: purchase, field: `lines.0.${f}`, kind: 'money' })),
  { method: 'post', path: () => `/api/purchases/${ids.purchase}/settlements`, base: () => ({ karat: 21, weightMg: 1_000 }), field: 'weightMg', kind: 'weight' },
  { method: 'post', path: () => `/api/purchases/${ids.purchase}/settlements`, base: () => ({ karat: 21, weightMg: 1_000 }), field: 'karat', kind: 'karat' },
  { method: 'post', path: () => '/api/scrap-purchases', base: scrap, field: 'karat', kind: 'karat' },
  { method: 'post', path: () => '/api/scrap-purchases', base: scrap, field: 'grossWeightMg', kind: 'weight' },
  { method: 'post', path: () => '/api/scrap-purchases', base: scrap, field: 'netWeightMg', kind: 'weight' },
  { method: 'post', path: () => '/api/scrap-purchases', base: scrap, field: 'agreedRatePerGram', kind: 'positiveMoney' },
  { method: 'post', path: () => '/api/scrap-purchases', base: scrap, field: 'cashAmount', kind: 'money' },
  { method: 'post', path: () => '/api/scrap-purchases', base: scrap, field: 'bankAmount', kind: 'money' },
  { method: 'post', path: () => '/api/scrap-purchases', base: () => ({ ...scrap(), kind: 'SELLABLE', productId: ids.product, sellingPrice: 300_000 }), field: 'sellingPrice', kind: 'positiveMoney' },
  { method: 'post', path: () => `/api/inventory/items/${ids.item}/price`, base: () => ({ sellingPrice: 250_000, reason: 'UX-1 refusal test' }), field: 'sellingPrice', kind: 'positiveMoney' },
  { method: 'post', path: () => '/api/gold-rates', base: () => ({ rates: { '21': 190_000 } }), field: 'rates.21', kind: 'positiveMoney' },
  { method: 'post', path: () => '/api/scrap-rates', base: () => ({ rates: [{ karat: 21, pricePerGram: 150_000 }] }), field: 'rates.0.pricePerGram', kind: 'positiveMoney' },
  { method: 'post', path: () => '/api/scrap-rates', base: () => ({ rates: [{ karat: 21, pricePerGram: 150_000 }] }), field: 'rates.0.karat', kind: 'karat' },
  { method: 'post', path: () => '/api/funding/advances', base: funding, field: 'amount', kind: 'positiveMoney' },
  { method: 'post', path: () => '/api/funding/repayments', base: funding, field: 'amount', kind: 'positiveMoney' },
  { method: 'post', path: () => '/api/cash/counts', base: () => ({ branchId: ids.branch, day: '2026-10-11', countedAmount: 0 }), field: 'countedAmount', kind: 'money' },
  { method: 'post', path: () => '/api/cash/hasad-settlements', base: () => ({ branchId: ids.branch, amount: 1_000 }), field: 'amount', kind: 'positiveMoney' },
  { method: 'post', path: () => '/api/sales', base: () => ({ branchId: ids.branch, items: [{ itemId: ids.item, discount: 0 }], paymentMethod: 'CASH' }), field: 'items.0.discount', kind: 'money' },
  // Settings: the field is the setting key (the registry validates each value).
  { method: 'put', path: () => '/api/settings', base: () => ({ changes: { 'sales.voidReauthAboveAmount': 0 } }), field: 'changes.sales.voidReauthAboveAmount', kind: 'money' },
  { method: 'put', path: () => '/api/settings', base: () => ({ changes: { 'cash.countDifferenceTolerance': 0 } }), field: 'changes.cash.countDifferenceTolerance', kind: 'money' },
  { method: 'put', path: () => '/api/settings', base: () => ({ changes: { 'purchases.scrapPriceTolerancePct': 2 } }), field: 'changes.purchases.scrapPriceTolerancePct', kind: 'percent' },
  { method: 'put', path: () => '/api/settings', base: () => ({ changes: { 'sales.maxDiscountPercentByRole': { CASHIER: 3 } } }), field: 'changes.sales.maxDiscountPercentByRole.CASHIER', kind: 'percent' },
  { method: 'put', path: () => '/api/settings', base: () => ({ changes: { 'purchases.supplierDebtMaxAgeDays': 30 } }), field: 'changes.purchases.supplierDebtMaxAgeDays', kind: 'count' },
];

/** The setting key and the path inside its value (the registry reports "key.inner"). */
function settingsBody(c: Case, value: unknown): { body: Body; detail: string } {
  const key = Object.keys(c.base().changes as Body)[0];
  const inner = c.field.slice(`changes.${key}`.length + 1);
  const base = (c.base().changes as Body)[key];
  const v = inner ? setIn(base as Body, inner, value) : value;
  return { body: { changes: { [key]: v } }, detail: inner ? `${key}.${inner}` : key };
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  const app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = withIdempotencyKeys(request.agent(app));
  const res = await gm.post('/api/auth/login').send({ username: 'general.manager', password: DEMO_PASSWORDS.GENERAL_MANAGER });
  expect(res.status).toBe(200);
  gm.set('x-csrf-token', res.body.csrfToken);
  // Rates, funding and settings need a fresh password confirmation; the refusal must come from the value, not from it.
  expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
  ids.branch = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
  ids.supplier = (await ctx.db.select().from(t.suppliers).limit(1))[0].id;
  ids.product = (await ctx.db.select().from(t.products).where(eq(t.products.karat, 21)).limit(1))[0].id;
  ids.item = (await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, ids.branch), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(1))[0].id;
  ids.purchase = (await ctx.db.select().from(t.purchases).limit(1))[0].id;
  before = await rowCounts();
});
afterAll(async () => handle?.close());

describe('the server refuses bad numbers in every money, weight, karat and count field', () => {
  for (const c of CASES) {
    it(`${c.method.toUpperCase()} ${c.path().replace(/\/\d+\//, '/:id/')} ${c.field} (${c.kind})`, async () => {
      for (const [label, value] of BAD[c.kind]) {
        const { body, detail } = c.method === 'put' ? settingsBody(c, value) : { body: setIn(c.base(), c.field, value), detail: c.field };
        const res = await gm[c.method](c.path()).send(body);
        const what = `${c.field} = ${label}: ${res.status} ${JSON.stringify(res.body)}`;
        expect(res.status, what).toBe(400);
        expect(res.body.error.code, what).toBe('BAD_REQUEST');
        const paths = ((res.body.error.details ?? []) as { path: string }[]).map((d) => d.path);
        expect(paths, what).toContain(detail);
      }
    });
  }

  it('nothing was written by the refused requests', async () => {
    expect(await rowCounts()).toEqual(before);
  });
});
