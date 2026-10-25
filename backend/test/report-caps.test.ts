// RPT-2 (docs/plans/RPT-2.md): reports never silently drop rows. A world with more rows than every report cap (1,250
// extra sales with their lines, 1,250 purchases, 1,250 pieces, 1,700 audit entries, copied in bulk from real rows):
// the report says how many rows there are and that the screen holds fewer, its totals equal an independent SQL SUM over
// every row, and the CSV walk returns every row once; for the General Manager and for a branch manager (own branch
// only). The totals do not depend on the cap. Under the cap the report is unchanged. A static guard keeps constant
// limits out of the report paths. Both projects.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { fetchAllPages, PAYMENT_METHODS, type Page } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { rows } from '../src/core/sql';
import { loadActor } from '../src/modules/sessions/service';
import { REPORT_ROW_CAPS, runReport } from '../src/modules/reports/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
const agents = {} as Record<'GM' | 'BM', Agent>;
let krt: number;
const ALL = { from: '2000-01-01', to: '2100-12-31' };
const EXTRA = 1250;

const run = (q: string) => handle.db.execute(sql.raw(q));
const one = async <T,>(q: string) => rows<T>(await run(q))[0];

/** Copy `n` rows of `table`, cycling over the template rows, with some columns replaced by SQL expressions of `g`. */
async function cloneMany(table: string, n: number, templateWhere: string, set: Record<string, string>, exec: (q: string) => Promise<unknown> = run) {
  const cols = rows<{ c: string }>(await exec(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name <> 'id' ORDER BY ordinal_position`)).map((r) => r.c);
  const list = cols.map((c) => `"${c}"`).join(', ');
  const select = cols.map((c) => (c in set ? set[c] : `s."${c}"`)).join(', ');
  await exec(`
    WITH tpl AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS k, count(*) OVER () AS cnt FROM "${table}" WHERE ${templateWhere})
    INSERT INTO "${table}" (${list})
    SELECT ${select} FROM generate_series(1, ${n}) g
    JOIN tpl ON tpl.k = g % tpl.cnt JOIN "${table}" s ON s.id = tpl.id`);
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  for (const [k, username, role] of [['GM', 'general.manager', 'GENERAL_MANAGER'], ['BM', 'branch.manager.kh', 'BRANCH_MANAGER']] as const) {
    const a = withIdempotencyKeys(request.agent(app));
    const res = await a.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
    expect(res.status).toBe(200);
    a.set('x-csrf-token', res.body.csrfToken);
    agents[k] = a;
  }
  krt = (await agents.BM.get('/api/auth/me')).body.user.branch.id;
  // Sales with their lines: the copy's number carries its template, so the lines can follow.
  // PAY-1: a sale and its payment lines are written in one transaction (the lines are checked when it commits).
  await handle.db.transaction(async (tx) => {
    const exec = (q: string) => tx.execute(sql.raw(q));
    await cloneMany('sales', EXTRA, `status = 'COMPLETED'`, { number: `'RPT2-' || g || '-' || s.id` }, exec);
    await exec(`
      INSERT INTO sale_payments (sale_id, line_no, method, amount, ref_invoice, ref_transaction, created_at)
      SELECT n.id, p.line_no, p.method, p.amount, p.ref_invoice, p.ref_transaction, p.created_at
      FROM sales n JOIN sale_payments p ON p.sale_id = split_part(n.number, '-', 3)::int WHERE n.number LIKE 'RPT2-%' ORDER BY n.id, p.line_no`);
  });
  await run(`
    INSERT INTO sale_items (${(await saleItemCols()).join(', ')})
    SELECT ${(await saleItemCols()).map((c) => (c === '"sale_id"' ? 'n.id' : `si.${c}`)).join(', ')}
    FROM sales n JOIN sale_items si ON si.sale_id = split_part(n.number, '-', 3)::int WHERE n.number LIKE 'RPT2-%'`);
  await cloneMany('purchases', EXTRA, 'true', { number: `'RPT2-P-' || g` });
  await cloneMany('jewelry_items', EXTRA, `status = 'AVAILABLE'`, { code: `'RPT2-J-' || g`, barcode: `'RPT2-B-' || g` });
  await cloneMany('audit_logs', 1700, 'true', { entity_id: `'RPT2-A-' || g` });
});
afterAll(async () => handle.close());

async function saleItemCols() {
  return rows<{ c: string }>(await run(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sale_items' AND column_name <> 'id' ORDER BY ordinal_position`)).map((r) => `"${r.c}"`);
}

type Report = { rows: Record<string, unknown>[]; totals?: Record<string, number>; summary?: { label: string; value: number }[]; rowCount: number; rowCap: number; truncated: boolean };
const report = async (who: 'GM' | 'BM', key: string, q: Record<string, unknown> = {}) => {
  const res = await agents[who].get(`/api/reports/${key}`).query({ ...ALL, ...q });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body as Report;
};
const csvRows = (who: 'GM' | 'BM', key: string, q: Record<string, unknown> = {}) =>
  fetchAllPages<Record<string, unknown>>(async (p) => {
    const res = await agents[who].get(`/api/reports/${key}`).query({ ...ALL, ...q, ...p });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body as Page<Record<string, unknown>>;
  });
const scopeSql = (who: 'GM' | 'BM', col = 'branch_id') => (who === 'BM' ? ` AND ${col} = ${krt}` : '');

describe('more rows than the cap: true count, true totals, every row in the CSV', () => {
  for (const who of ['GM', 'BM'] as const) {
    it(`${who} · sales: rowCount and totals from every sale, the screen says it is cut, the CSV has every sale`, async () => {
      const r = await report(who, 'sales');
      const expected = await one<{ n: string; done: string; total: string; disc: string; cost: string }>(`
        SELECT count(*) AS n, count(*) FILTER (WHERE status = 'COMPLETED') AS done,
               coalesce(sum(total) FILTER (WHERE status = 'COMPLETED'), 0) AS total,
               coalesce(sum(discount_total) FILTER (WHERE status = 'COMPLETED'), 0) AS disc,
               coalesce(sum(cost_total) FILTER (WHERE status = 'COMPLETED'), 0) AS cost
        FROM sales WHERE true${scopeSql(who)}`);
      const lines = await one<{ n: string; w: string }>(`SELECT count(*) AS n, coalesce(sum(si.net_weight_mg), 0) AS w FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status = 'COMPLETED'${scopeSql(who, 's.branch_id')}`);
      if (who === 'GM') expect(Number(expected.n)).toBeGreaterThan(REPORT_ROW_CAPS.sales);
      expect(r.rowCount).toBe(Number(expected.n));
      expect(r.truncated).toBe(Number(expected.n) > REPORT_ROW_CAPS.sales);
      expect(r.rows.length).toBe(Math.min(Number(expected.n), REPORT_ROW_CAPS.sales));
      expect(r.totals).toMatchObject({ total: Number(expected.total), discountTotal: Number(expected.disc), itemCount: Number(lines.n), weightMg: Number(lines.w) });
      if (who === 'GM') expect(r.totals).toMatchObject({ costTotal: Number(expected.cost), grossProfit: Number(expected.total) - Number(expected.cost) });
      else expect(Object.keys(r.totals!).filter((k) => /cost|profit/i.test(k))).toEqual([]);
      // Sales by channel add up to the total, from every sale.
      // PAY-1: the payment-method tiles add up to the total (the Hasad / direct tiles and the split count are extra).
      expect(r.summary!.filter((x) => PAYMENT_METHODS.includes(x.label as never)).reduce((s, x) => s + x.value, 0)).toBe(Number(expected.total));
      const csv = await csvRows(who, 'sales');
      expect(csv.length).toBe(r.rowCount);
      expect(new Set(csv.map((x) => x.saleId)).size).toBe(csv.length);
      expect(csv.slice(0, 50).map((x) => x.saleId)).toEqual(r.rows.slice(0, 50).map((x) => x.saleId));
      if (who === 'BM') expect(csv.every((x) => x.branchId === krt)).toBe(true);
      if (who === 'BM') expect(csv.some((x) => 'costTotal' in x || 'grossProfit' in x)).toBe(false);
    });

    it(`${who} · purchases: true count and totals, every purchase in the CSV`, async () => {
      const r = await report(who, 'purchases');
      if (who === 'GM') expect(r.truncated).toBe(true);
      const e = await one<{ n: string; items: string; w: string; cost: string }>(`SELECT count(*) AS n, sum(item_count) AS items, sum(total_net_weight_mg) AS w, sum(total_cost) AS cost FROM purchases WHERE true${scopeSql(who)}`);
      expect(r.rowCount).toBe(Number(e.n));
      expect(r.truncated).toBe(Number(e.n) > REPORT_ROW_CAPS.purchases);
      expect(r.totals).toMatchObject({ itemCount: Number(e.items), totalNetWeightMg: Number(e.w) });
      if (who === 'GM') expect(r.totals!.totalCost).toBe(Number(e.cost));
      else expect(r.totals).not.toHaveProperty('totalCost');
      const csv = await csvRows(who, 'purchases');
      expect(csv.length).toBe(r.rowCount);
      expect(new Set(csv.map((x) => x.purchaseId)).size).toBe(csv.length);
    });

    it(`${who} · inventory: true count and totals, every piece in the CSV`, async () => {
      const r = await report(who, 'inventory', { status: 'AVAILABLE' });
      if (who === 'GM') expect(r.truncated).toBe(true);
      const e = await one<{ n: string; w: string; price: string; cost: string; pc: string }>(`
        SELECT count(*) AS n, sum(j.net_weight_mg) AS w, sum(j.selling_price) AS price, sum(j.acquisition_cost) AS cost,
               sum(coalesce(pi.purchase_cost, j.acquisition_cost)) AS pc
        FROM jewelry_items j LEFT JOIN purchase_items pi ON pi.item_id = j.id WHERE j.status = 'AVAILABLE'${scopeSql(who, 'j.branch_id')}`);
      expect(r.rowCount).toBe(Number(e.n));
      expect(r.truncated).toBe(Number(e.n) > REPORT_ROW_CAPS.inventory);
      expect(r.totals).toMatchObject({ netWeightMg: Number(e.w), sellingPrice: Number(e.price) });
      if (who === 'GM') expect(r.totals).toMatchObject({ totalCost: Number(e.cost), purchaseCost: Number(e.pc) });
      else expect(Object.keys(r.totals!).sort()).toEqual(['netWeightMg', 'sellingPrice']);
      const csv = await csvRows(who, 'inventory', { status: 'AVAILABLE' });
      expect(csv.length).toBe(r.rowCount);
      expect(new Set(csv.map((x) => x.itemId)).size).toBe(csv.length);
    });

    it(`${who} · audit: true count past 1,500, every entry in the CSV`, async () => {
      const r = await report(who, 'audit');
      const e = await one<{ n: string }>(`SELECT count(*) AS n FROM audit_logs WHERE true${scopeSql(who)}${who === 'BM' ? ` AND (entity_type IS NULL OR entity_type <> 'gm_funding_event')` : ''}`);
      expect(r.rowCount).toBe(Number(e.n));
      expect(r.truncated).toBe(Number(e.n) > REPORT_ROW_CAPS.audit);
      if (who === 'GM') expect(r.truncated).toBe(true);
      const csv = await csvRows(who, 'audit');
      expect(csv.length).toBe(r.rowCount);
      expect(new Set(csv.map((x) => x.id)).size).toBe(csv.length);
    });
  }

  it('the inventory ledger counts every movement and its CSV has every one', async () => {
    const r = await report('GM', 'inventory-ledger');
    const e = await one<{ n: string }>(`SELECT count(*) AS n FROM inventory_movements`);
    expect(r.rowCount).toBe(Number(e.n));
    expect(r.truncated).toBe(Number(e.n) > REPORT_ROW_CAPS['inventory-ledger']);
    const csv = await csvRows('GM', 'inventory-ledger');
    expect(csv.length).toBe(r.rowCount);
  });
});

describe('the totals do not depend on the cap', () => {
  it('caps lowered to 7: the same totals and summary, the rows cut and flagged', async () => {
    const gm = (await loadActor(ctx.db, (await agents.GM.get('/api/auth/me')).body.user.id, null))!;
    for (const key of Object.keys(REPORT_ROW_CAPS) as (keyof typeof REPORT_ROW_CAPS)[]) {
      const full = await runReport(ctx, gm, key, ALL);
      const low = await runReport(ctx, gm, key, ALL, { rowCaps: { [key]: 7 } });
      expect(low.rows.length, key).toBe(7);
      expect(low.truncated, key).toBe(true);
      expect(low.rowCount, key).toBe(full.rowCount);
      expect(low.totals, key).toEqual(full.totals);
      expect(low.summary, key).toEqual(full.summary);
    }
  });

  it('paging the rows: an unknown report or an aggregate report is refused, page sizes are clamped', async () => {
    expect((await agents.GM.get('/api/reports/profit').query({ ...ALL, page: 1 })).status).toBe(400);
    expect((await agents.GM.get('/api/reports/stock-weight').query({ page: 1 })).status).toBe(400);
    const big = (await agents.GM.get('/api/reports/sales').query({ ...ALL, page: 1, pageSize: 100_000 })).body as Page<unknown>;
    expect(big.page.size).toBe(200);
  });
});

describe('under the cap nothing changes', () => {
  it('a branch with fewer rows than the caps: every row, not truncated, totals = the sum of the rows (the old way)', async () => {
    const r = await report('BM', 'sales', { from: '2000-01-01', to: '2000-01-02' });
    expect(r).toMatchObject({ rowCount: 0, truncated: false, rows: [] });
    // The fixture world before the copies: a narrow search keeps it small.
    const s = await report('GM', 'purchases', { q: 'RPT2-P-1' });
    expect(s.truncated).toBe(false);
    expect(s.rowCount).toBe(s.rows.length);
    expect(s.totals!.itemCount).toBe(s.rows.reduce((a, x) => a + Number(x.itemCount), 0));
    expect(s.totals!.totalCost).toBe(s.rows.reduce((a, x) => a + Number(x.totalCost), 0));
    const sales = await report('GM', 'sales', { q: 'RPT2-1' });
    const done = sales.rows.filter((x) => x.status === 'COMPLETED');
    expect(sales.truncated).toBe(false);
    for (const k of ['itemCount', 'weightMg', 'discountTotal', 'total', 'costTotal', 'grossProfit']) {
      expect(sales.totals![k], k).toBe(done.reduce((a, x) => a + Number(x[k]), 0));
    }
  });
});

describe('static guard: no constant limit on a report path', () => {
  const SRC = path.resolve(__dirname, '../src');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
  // Every constant limit in the backend, with why it is not a report truncation. A new one fails until it is listed.
  const ALLOWED: Record<string, RegExp[]> = {
    'modules/ledger/service.ts': [/\.limit\(200\)/], // Cash › Hasad transfers list (RPT-2 plan, item 6: a list, flagged)
    'modules/sessions/service.ts': [/\.limit\(300\)/], // Active users (RPT-2 plan, item 7: flagged)
    'auth/second-factor.ts': [/\.limit\(500\)/], // new-device check of one user over 30 days (internal)
    'modules/auth/passkeys.ts': [/\.limit\(10\)/], // "the last 10 sign-ins" (the screen says so)
    'modules/dashboard/service.ts': [/LIMIT 1\b/], // the last cash count
    'modules/catalog/service.ts': [/\.limit\(20\)/], // CAT-1: description suggestions of a free-text field (not a report)
  };
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

  it('constant limits exist only where listed; single-row lookups (limit 1) are fine', () => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel.startsWith('backup/')) continue; // the restore drill's own SQL (LIMIT 1 probes)
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\.limit\(\s*(\d+)\s*\)|\blimit:\s*(\d+)|\bLIMIT\s+(\d+)/g)) {
        const n = Number(m[1] ?? m[2] ?? m[3]);
        if (n === 1) continue;
        if ((ALLOWED[rel] ?? []).some((re) => re.test(m[0]))) continue;
        found.push(`${rel}: ${m[0]}`);
      }
    }
    expect(found, 'a constant limit: name it in REPORT_ROW_CAPS (with rowCount/truncated) or list it here with a reason').toEqual([]);
  });

  it('the report module takes its row caps from REPORT_ROW_CAPS only, and every capped report says rowCount and truncated', async () => {
    const text = read('modules/reports/service.ts');
    expect(text).not.toMatch(/totalsOf\(rowsAll\.filter|limit:\s*\d{2,}|\.limit\(\s*\d{2,}/);
    const gm = (await loadActor(ctx.db, (await agents.GM.get('/api/auth/me')).body.user.id, null))!;
    for (const key of Object.keys(REPORT_ROW_CAPS)) {
      const r = await runReport(ctx, gm, key, ALL);
      expect(typeof r.rowCount, key).toBe('number');
      expect(typeof r.truncated, key).toBe('boolean');
      expect(r.rowCap, key).toBe(REPORT_ROW_CAPS[key as keyof typeof REPORT_ROW_CAPS]);
    }
  });
});
