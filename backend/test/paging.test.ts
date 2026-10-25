// BE-7 (D-ux-15, docs/plans/BE-7.md): server-side pages for sales, inventory, purchases, scrap purchases, transfers
// and the audit log. Walked page by page as every role: no cost field reaches a non-GM on any page, a branch user
// sees only their branch on every page and in the total, the order is stable (equal sort values, the unique id
// tiebreaker), the snapshot keeps a new row off the next pages, and the CSV walk returns the whole filtered result.
// Both projects.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, or, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { COST_RESPONSE_FIELDS, PAGE_SIZE_MAX, fetchAllPages, scanResponse, type Page, type PageParams } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { listSales } from '../src/modules/sales/service';
import { loadActor } from '../src/modules/sessions/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
const ROLES = { GENERAL_MANAGER: 'general.manager', BRANCH_MANAGER: 'branch.manager.kh', CASHIER: 'cashier.kh.01' } as const;
type Role = keyof typeof ROLES;
const agents = {} as Record<Role, Agent>;
let krtId: number;

// Every list, with a filter that keeps the walk long enough to cross several pages of 3.
const LISTS = {
  sales: { path: '/api/sales', query: { from: '2000-01-01', to: '2100-01-01' }, table: t.sales, branch: (id: number) => eq(t.sales.branchId, id) },
  inventory: { path: '/api/inventory/items', query: {}, table: t.jewelryItems, branch: (id: number) => eq(t.jewelryItems.branchId, id) },
  purchases: { path: '/api/purchases', query: {}, table: t.purchases, branch: (id: number) => eq(t.purchases.branchId, id) },
  scrap: { path: '/api/scrap-purchases', query: {}, table: t.scrapPurchases, branch: (id: number) => eq(t.scrapPurchases.branchId, id) },
  transfers: { path: '/api/transfers', query: {}, table: t.transfers, branch: (id: number) => or(eq(t.transfers.fromBranchId, id), eq(t.transfers.toBranchId, id))! },
  audit: { path: '/api/audit', query: { from: '2000-01-01', to: '2100-01-01' }, table: t.auditLogs, branch: (id: number) => eq(t.auditLogs.branchId, id) },
} as const;
type ListKey = keyof typeof LISTS;
type Row = Record<string, unknown> & { id: number; branchId?: number | null; fromBranchId?: number; toBranchId?: number };

const getPage = async (a: Agent, key: ListKey, p: Record<string, unknown> = {}) => {
  const res = await a.get(LISTS[key].path).query({ ...LISTS[key].query, ...p });
  return res;
};
const walk = (a: Agent, key: ListKey, p: Record<string, unknown> = {}, size = 3) =>
  fetchAllPagesAt(async (q) => {
    const res = await getPage(a, key, { ...p, ...q, pageSize: size });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Page<Row>;
  });
/** Like fetchAllPages, but at a chosen page size and keeping each page for inspection. */
async function fetchAllPagesAt(fetchPage: (p: PageParams) => Promise<Page<Row>>) {
  const first = await fetchPage({ page: 1 });
  const pages = [first];
  for (let n = 2; n <= first.page.pages; n++) pages.push(await fetchPage({ page: n, sort: first.page.sort, dir: first.page.dir, asOfId: first.page.asOfId }));
  return pages;
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  for (const [role, username] of Object.entries(ROLES) as [Role, string][]) {
    const a = withIdempotencyKeys(request.agent(app));
    const res = await a.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
    expect(res.status).toBe(200);
    a.set('x-csrf-token', res.body.csrfToken);
    agents[role] = a;
  }
  krtId = (await agents.BRANCH_MANAGER.get('/api/auth/me')).body.user.branch.id;
});
afterAll(async () => handle.close());

describe('every page of every list, for every role', () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    for (const key of Object.keys(LISTS) as ListKey[]) {
      it(`${role} · ${key}: no cost on any page, own branch only, total = rows walked, no row twice`, async () => {
        const a = agents[role];
        const probe = await getPage(a, key, { pageSize: 3 });
        if (probe.status === 403) {
          // A role without the list is refused on every page, never answered with rows.
          expect((await getPage(a, key, { page: 2, pageSize: 3 })).status).toBe(403);
          return;
        }
        const pages = await walk(a, key);
        const all = pages.flatMap((p) => p.rows);
        expect(all.length, 'the walk returns exactly the total').toBe(pages[0].total);
        expect(new Set(all.map((r) => r.id)).size, 'no row on two pages').toBe(all.length);
        for (const p of pages) {
          expect(p.total, 'the total does not change between pages').toBe(pages[0].total);
          expect(p.rows.length).toBeLessThanOrEqual(3);
          if (role !== 'GENERAL_MANAGER') {
            const leaks = scanResponse(p).filter((f) => f.kind === 'COST');
            expect(leaks, `${key} page ${p.page.number}`).toEqual([]);
            for (const r of p.rows) for (const f of Object.keys(r)) expect(COST_RESPONSE_FIELDS.has(f), f).toBe(false);
          }
        }
        if (role !== 'GENERAL_MANAGER') {
          for (const r of all) {
            const own = r.branchId === krtId || r.fromBranchId === krtId || r.toBranchId === krtId;
            expect(own, `${key} row ${r.id} is not of the user's branch`).toBe(true);
          }
        }
        if (role === 'BRANCH_MANAGER' && key !== 'audit') {
          // The total counts the branch's rows only (audit: its own filters below the branch; checked separately).
          const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(LISTS[key].table).where(LISTS[key].branch(krtId));
          expect(pages[0].total).toBeLessThanOrEqual(Number(n));
        }
        expect(pages[0].total).toBeGreaterThan(0);
      });
    }
  }
});

describe('page mechanics', () => {
  it('boundaries: first, last and beyond the last page', async () => {
    const gm = agents.GENERAL_MANAGER;
    const first = (await getPage(gm, 'sales', { pageSize: 7 })).body as Page<Row>;
    expect(first.page).toMatchObject({ number: 1, size: 7, sort: 'date', dir: 'desc' });
    expect(first.page.pages).toBe(Math.ceil(first.total / 7));
    const last = (await getPage(gm, 'sales', { pageSize: 7, page: first.page.pages, asOfId: first.page.asOfId })).body as Page<Row>;
    expect(last.rows.length).toBe(first.total - (first.page.pages - 1) * 7);
    const beyond = (await getPage(gm, 'sales', { pageSize: 7, page: first.page.pages + 1, asOfId: first.page.asOfId })).body as Page<Row>;
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(first.total);
  });

  it('page size: 50 by default, clamped to 200, never zero', async () => {
    const gm = agents.GENERAL_MANAGER;
    expect(((await getPage(gm, 'inventory')).body as Page<Row>).page.size).toBe(50);
    const big = (await getPage(gm, 'inventory', { pageSize: 999_999 })).body as Page<Row>;
    expect(big.page.size).toBe(PAGE_SIZE_MAX);
    expect(big.rows.length).toBeLessThanOrEqual(PAGE_SIZE_MAX);
    expect((await getPage(gm, 'inventory', { pageSize: 0 })).status).toBe(400);
    expect((await getPage(gm, 'inventory', { page: 0 })).status).toBe(400);
  });

  it('equal sort values keep one order across pages: by the sort key, then the id', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      const pages = await walk(agents.GENERAL_MANAGER, 'inventory', { sort: 'karat', dir }, 4);
      const all = pages.flatMap((p) => p.rows) as (Row & { karat: number })[];
      expect(new Set(all.map((r) => r.karat)).size).toBeLessThan(all.length); // there are ties
      for (let i = 1; i < all.length; i++) {
        const [a, b] = [all[i - 1], all[i]];
        const ok = dir === 'asc' ? a.karat < b.karat || (a.karat === b.karat && a.id < b.id) : a.karat > b.karat || (a.karat === b.karat && a.id > b.id);
        expect(ok, `${dir}: ${a.karat}/${a.id} then ${b.karat}/${b.id}`).toBe(true);
      }
    }
  });

  it('filters, sort and page together', async () => {
    const pages = await walk(agents.GENERAL_MANAGER, 'sales', { status: 'COMPLETED', sort: 'total', dir: 'asc' }, 2);
    const all = pages.flatMap((p) => p.rows) as (Row & { status: string; total: number })[];
    expect(all.length).toBeGreaterThan(4);
    expect(all.every((r) => r.status === 'COMPLETED')).toBe(true);
    for (let i = 1; i < all.length; i++) expect(all[i].total).toBeGreaterThanOrEqual(all[i - 1].total);
  });

  it('a sale made while someone pages does not push a row onto the next page twice (snapshot)', async () => {
    const gm = agents.GENERAL_MANAGER;
    const cashier = agents.CASHIER;
    const p1 = (await getPage(gm, 'sales', { pageSize: 3 })).body as Page<Row>;
    const [item] = ((await cashier.get('/api/inventory/items').query({ status: 'AVAILABLE', sort: 'price', dir: 'desc' })).body as Page<Row>).rows;
    const sale = await cashier.post('/api/sales').send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const p2 = (await getPage(gm, 'sales', { pageSize: 3, page: 2, asOfId: p1.page.asOfId })).body as Page<Row>;
    expect(p2.total).toBe(p1.total);
    expect(p2.rows.some((r) => p1.rows.some((x) => x.id === r.id))).toBe(false);
    // A fresh first page (no snapshot) shows the new sale on top.
    const fresh = (await getPage(gm, 'sales', { pageSize: 3 })).body as Page<Row>;
    expect(fresh.rows[0].id).toBe(sale.body.id);
    expect(fresh.total).toBe(p1.total + 1);
  });
});

describe('sort keys are a fixed list; cost sorts are the General Manager\'s', () => {
  it('an unknown sort key is refused (400) and never reaches SQL', async () => {
    for (const key of Object.keys(LISTS) as ListKey[]) {
      for (const sort of ['created_at', 'id; drop table sales', 'nonsense']) {
        const res = await getPage(agents.GENERAL_MANAGER, key, { sort });
        expect(res.status, `${key} sort=${sort}`).toBe(400);
      }
    }
    expect((await getPage(agents.GENERAL_MANAGER, 'sales', { dir: 'sideways' })).status).toBe(400);
  });

  it('ordering by cost or profit is refused (403) without profit.view, allowed for the General Manager', async () => {
    const cases: [ListKey, string][] = [
      ['sales', 'grossProfit'],
      ['inventory', 'cost'],
      ['purchases', 'totalCost'],
    ];
    for (const [key, sort] of cases) {
      expect((await getPage(agents.GENERAL_MANAGER, key, { sort })).status, `GM ${key} ${sort}`).toBe(200);
      for (const role of ['BRANCH_MANAGER', 'CASHIER'] as const) {
        const res = await getPage(agents[role], key, { sort });
        expect([403].includes(res.status), `${role} ${key} ${sort}: ${res.status}`).toBe(true);
        expect(JSON.stringify(res.body)).not.toMatch(/"rows"/);
      }
    }
  });
});

describe('branch scope', () => {
  it('a branch manager asking for another branch is refused on every page; the total counts their branch only', async () => {
    const [other] = await ctx.db.select({ id: t.branches.id }).from(t.branches).where(sql`${t.branches.id} <> ${krtId}`).limit(1);
    for (const key of Object.keys(LISTS) as ListKey[]) {
      for (const page of [1, 2]) expect((await getPage(agents.BRANCH_MANAGER, key, { branchId: other.id, page })).status, key).toBe(403);
    }
    const bm = (await getPage(agents.BRANCH_MANAGER, 'sales', { pageSize: 3 })).body as Page<Row>;
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(t.sales).where(eq(t.sales.branchId, krtId));
    expect(bm.total).toBe(Number(n));
    const gmAll = (await getPage(agents.GENERAL_MANAGER, 'sales', { pageSize: 3 })).body as Page<Row>;
    expect(gmAll.total).toBeGreaterThan(bm.total);
  });

  it('counter staff never list pieces that are not for sale, whatever status they ask for', async () => {
    for (const status of ['SOLD', 'DAMAGED', 'IN_TRANSIT', 'SOLD,DAMAGED']) {
      const res = await getPage(agents.CASHIER, 'inventory', { status });
      expect(res.status).toBe(200);
      expect(res.body.rows, status).toEqual([]);
      expect(res.body.total, status).toBe(0);
    }
    const sellable = (await getPage(agents.CASHIER, 'inventory', { status: 'AVAILABLE,SOLD', pageSize: 200 })).body as Page<Row & { status: string }>;
    expect(sellable.rows.length).toBeGreaterThan(0);
    expect(sellable.rows.every((r) => r.status === 'AVAILABLE')).toBe(true);
  });
});

describe('table totals cover the whole filtered result, not one page', () => {
  it('sales: completed sales of every page; cost and profit for the General Manager only', async () => {
    for (const role of ['GENERAL_MANAGER', 'BRANCH_MANAGER'] as const) {
      const pages = await walk(agents[role], 'sales', {}, 5);
      const done = pages.flatMap((p) => p.rows).filter((r) => r.status === 'COMPLETED') as (Row & { total: number; itemCount: number; weightMg: number; costTotal?: number })[];
      const totals = pages[0].totals!;
      for (const p of pages) expect(p.totals).toEqual(totals);
      expect(totals).toMatchObject({ sales: done.length, itemCount: done.reduce((s, r) => s + r.itemCount, 0), weightMg: done.reduce((s, r) => s + r.weightMg, 0), total: done.reduce((s, r) => s + r.total, 0) });
      if (role === 'GENERAL_MANAGER') {
        expect(totals.costTotal).toBe(done.reduce((s, r) => s + (r.costTotal ?? 0), 0));
        expect(totals.grossProfit).toBe(totals.total! - totals.costTotal!);
        expect(totals.unknownCostLines).toBe(0);
      } else {
        expect(Object.keys(totals).some((k) => COST_RESPONSE_FIELDS.has(k))).toBe(false);
      }
    }
  });

  it('inventory and purchases: the same sums as the rows of every page', async () => {
    const inv = await walk(agents.GENERAL_MANAGER, 'inventory', { status: 'AVAILABLE' }, 25);
    const items = inv.flatMap((p) => p.rows) as (Row & { netWeightMg: number; sellingPrice: number; totalCost: number | null })[];
    expect(inv[0].totals).toEqual({ netWeightMg: items.reduce((s, r) => s + r.netWeightMg, 0), sellingPrice: items.reduce((s, r) => s + r.sellingPrice, 0), totalCost: items.reduce((s, r) => s + (r.totalCost ?? 0), 0), unknownCostPieces: items.filter((r) => r.totalCost == null).length });
    const pur = await walk(agents.BRANCH_MANAGER, 'purchases', {}, 2);
    const ps = pur.flatMap((p) => p.rows) as (Row & { itemCount: number; totalNetWeightMg: number })[];
    expect(pur[0].totals).toEqual({ itemCount: ps.reduce((s, r) => s + r.itemCount, 0), totalNetWeightMg: ps.reduce((s, r) => s + r.totalNetWeightMg, 0) });
  });
});

describe('CSV export: the whole filtered result, not one page', () => {
  it('walking every page gives the same rows as the full list, in the same order, each once', async () => {
    const gm = agents.GENERAL_MANAGER;
    const filters = { from: '2000-01-01', to: '2100-01-01', status: 'COMPLETED' };
    const walked = await fetchAllPages<Row>(async (p) => (await gm.get('/api/sales').query({ ...filters, ...p })).body as Page<Row>);
    const actor = await loadActor(ctx.db, (await gm.get('/api/auth/me')).body.user.id, null);
    const full = (await listSales(ctx, actor!, filters, 1000)) as Row[];
    expect(full.length).toBeLessThan(1000); // the old cap does not cut this comparison
    expect(walked.map((r) => r.id)).toEqual(full.map((r) => r.id));
    expect(walked.length).toBe(new Set(walked.map((r) => r.id)).size);
    // The columns a CSV writes are the same fields, with the same values.
    expect(walked).toEqual(full.map((r) => JSON.parse(JSON.stringify(r))));
  });

  it('the walk applies the branch scope and the cost redaction of the caller', async () => {
    const bmRows = await fetchAllPages<Row>(async (p) => (await agents.BRANCH_MANAGER.get('/api/purchases').query(p)).body as Page<Row>);
    expect(bmRows.length).toBeGreaterThan(0);
    expect(bmRows.every((r) => r.branchId === krtId && !('totalCost' in r))).toBe(true);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(t.purchases).where(and(eq(t.purchases.branchId, krtId)));
    expect(bmRows.length).toBe(Number(n));
  });
});
