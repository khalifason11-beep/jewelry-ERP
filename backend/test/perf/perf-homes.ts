// Performance of the homes and the attention list on a large real PostgreSQL database (docs/plans/UI-B.md §2.3,
// D-ui-21). Not part of the test suite: run through `node scripts/perf-homes.mjs` (a phase gate).
//
// 1. Creates a fresh database (admin URL from REHEARSAL_ADMIN_URL), migrates it and seeds the 30-day fixture world.
// 2. Scales it with bulk SQL to 8 branches over 2 years: about 60,000 sales (2 % voided), 90,000 pieces, their
//    inventory movements and ledger entries, open supplier gold debts and daily cash counts.
// 3. Times the service functions behind GET /dashboard/company (today and 30 days), /dashboard/branch and /attention
//    (GM and branch manager), and (BE-7) one page of every server-paged list: the first page, the last page (the
//    deepest offset), another sort, the branch manager's page; 3 warm-up runs, then 20 timed runs; p50 and p95 in ms.
//    PRC-1: the POS grid, the inventory list, the homes' valuation and the stock report again with prices computed from
//    the rates (pricing.mode RATE_COMPUTED; the cases marked "· computed").
// 4. Prints the slowest SQL statements with EXPLAIN (ANALYZE, BUFFERS), the machine and the data size.
// Exit code 1 when any p95 is above the budget (300 ms).

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Column, eq, sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import { t } from '@jerp/database';
import { openDatabase, createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { addDays, dayKey } from '../../src/core/time';
import { loadActor } from '../../src/modules/sessions/service';
import { branchDashboard, companyDashboard } from '../../src/modules/dashboard/service';
import { attentionFor } from '../../src/modules/attention/service';
import { pageSales } from '../../src/modules/sales/service';
import { pageItems } from '../../src/modules/inventory/service';
import { pagePurchases } from '../../src/modules/purchases/service';
import { listScrapPurchases } from '../../src/modules/scrap/service';
import { listTransfers } from '../../src/modules/transfers/service';
import { pageAudit, reportRowsPage, runReport } from '../../src/modules/reports/service';
import { fetchAllPages, type PricingSettingMode } from '@jerp/shared';
import { rows } from '../../src/core/sql';
import { seedWorld } from '../fixtures/world';
import { dropTestDatabase } from '../helpers';

const BUDGET_MS = 300;
const REPORT_BUDGET_MS = 1_000;
const CSV_BUDGET_MS = 30_000;
const RUNS = 20;
const ARGS = new Set(process.argv.slice(2));
const ADMIN = process.env.REHEARSAL_ADMIN_URL ?? '';
if (!ADMIN) throw new Error('REHEARSAL_ADMIN_URL is required (a role allowed to CREATE DATABASE)');

async function main() {
  const name = `jerp_perf_${Date.now()}_${randomBytes(2).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN);
  url.pathname = `/${name}`;
  const handle = await openDatabase({ url: url.toString() });
  const ctx = createContext(handle);
  try {
    const t0 = Date.now();
    await seedWorld(ctx);
    await scale(ctx);
    const size = await dataSize(ctx);
    console.log(`data ready in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(size)}`);
    const machine = `${os.cpus()[0]?.model ?? '?'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${rows<{ v: string }>(await ctx.db.execute(sql`SELECT version() AS v`))[0].v.split(' on ')[0]}`;
    console.log(`machine: ${machine}`);

    const gm = await actor(ctx, 'general.manager');
    const bm = await actor(ctx, 'branch.manager.kh');
    const { company } = await ctx.settings.get();
    const today = dayKey(new Date(), company.timezone);
    // The 4th element runs the case with that pricing mode (the world itself is FIXED_TAG).
    const cases: [string, () => Promise<unknown>, number?, PricingSettingMode?][] = [
      ['GET /dashboard/company (today)', () => companyDashboard(ctx, gm, { from: today, to: today })],
      ['GET /dashboard/company (30 days)', () => companyDashboard(ctx, gm, { from: addDays(today, -29), to: today })],
      ['GET /dashboard/branch (BM, today)', () => branchDashboard(ctx, bm, {})],
      ['GET /attention (GM)', () => attentionFor(ctx, gm)],
      ['GET /attention (BM)', () => attentionFor(ctx, bm)],
    ];
    // BE-7: one page (50 rows) of every server-paged list; "last page" is the deepest offset of the unfiltered list.
    const last = async (f: () => Promise<{ page: { pages: number } }>) => (await f()).page.pages;
    const month = { from: addDays(today, -29), to: today };
    const salesLast = await last(() => pageSales(ctx, gm, {}));
    const itemsLast = await last(() => pageItems(ctx, gm, { status: ['AVAILABLE'] }));
    const purchasesLast = await last(() => pagePurchases(ctx, gm, {}));
    const auditLast = await last(() => pageAudit(ctx, gm, month));
    cases.push(
      ['GET /sales (GM, page 1 of all)', () => pageSales(ctx, gm, {})],
      [`GET /sales (GM, last page ${salesLast})`, () => pageSales(ctx, gm, { page: salesLast })],
      ['GET /sales (GM, 30 days, sort total)', () => pageSales(ctx, gm, { ...month, sort: 'total' })],
      ['GET /sales (GM, search)', () => pageSales(ctx, gm, { q: 'S-0' })],
      ['GET /sales (BM, page 1)', () => pageSales(ctx, bm, {})],
      ['GET /inventory/items (GM, available, page 1)', () => pageItems(ctx, gm, { status: ['AVAILABLE'] })],
      [`GET /inventory/items (GM, last page ${itemsLast})`, () => pageItems(ctx, gm, { status: ['AVAILABLE'], page: itemsLast })],
      ['GET /inventory/items (GM, sort price)', () => pageItems(ctx, gm, { status: ['AVAILABLE'], sort: 'price' })],
      ['GET /inventory/items (BM, page 1)', () => pageItems(ctx, bm, { status: ['AVAILABLE'] })],
      ['GET /inventory/items (POS search, 200)', () => pageItems(ctx, bm, { status: ['AVAILABLE'], q: '21', pageSize: 200, sort: 'recent' })],
      ['GET /purchases (GM, page 1)', () => pagePurchases(ctx, gm, {})],
      [`GET /purchases (GM, last page ${purchasesLast})`, () => pagePurchases(ctx, gm, { page: purchasesLast })],
      ['GET /purchases (BM, page 1)', () => pagePurchases(ctx, bm, {})],
      ['GET /scrap-purchases (GM, page 1)', () => listScrapPurchases(ctx, gm, {})],
      ['GET /scrap-purchases (BM, page 1)', () => listScrapPurchases(ctx, bm, {})],
      ['GET /transfers (GM, page 1)', () => listTransfers(ctx, gm, {})],
      ['GET /transfers (BM, page 1)', () => listTransfers(ctx, bm, {})],
      ['GET /audit (GM, 30 days, page 1)', () => pageAudit(ctx, gm, month)],
      [`GET /audit (GM, 30 days, last page ${auditLast})`, () => pageAudit(ctx, gm, { ...month, page: auditLast })],
      ['GET /audit (BM, 30 days, page 1)', () => pageAudit(ctx, bm, month)],
    );
    // RPT-2: the reports (up to their row cap on screen, totals in SQL over every row). Budget 1,000 ms: one request
    // opened on demand, returning up to 1,000 rows, not a page change like the lists.
    const all = { from: '2024-01-01', to: today };
    cases.push(
      ['GET /reports/sales (GM, 2 years, cut at 1,000)', () => runReport(ctx, gm, 'sales', all), REPORT_BUDGET_MS],
      ['GET /reports/sales (GM, 30 days)', () => runReport(ctx, gm, 'sales', month), REPORT_BUDGET_MS],
      ['GET /reports/sales (BM, 2 years)', () => runReport(ctx, bm, 'sales', all), REPORT_BUDGET_MS],
      ['GET /reports/purchases (GM, 2 years)', () => runReport(ctx, gm, 'purchases', all), REPORT_BUDGET_MS],
      ['GET /reports/inventory (GM, available)', () => runReport(ctx, gm, 'inventory', { status: 'AVAILABLE' }), REPORT_BUDGET_MS],
      ['GET /reports/inventory-ledger (GM, 30 days)', () => runReport(ctx, gm, 'inventory-ledger', month), REPORT_BUDGET_MS],
      ['GET /reports/audit (GM, 30 days)', () => runReport(ctx, gm, 'audit', month), REPORT_BUDGET_MS],
      ['GET /reports/profit (GM, by day, 30 days)', () => runReport(ctx, gm, 'profit', { ...month, group: 'day' }), REPORT_BUDGET_MS],
      ['GET /reports/branch-performance (GM, 30 days)', () => runReport(ctx, gm, 'branch-performance', month), REPORT_BUDGET_MS],
      ['GET /reports/sales rows, page 1 of 200 (CSV walk)', () => reportRowsPage(ctx, gm, 'sales', { ...all, page: 1, pageSize: 200 }), REPORT_BUDGET_MS],
    );
    // PRC-1: the POS grid, the inventory list, the valuation by selling price and the stock report with prices computed
    // from the rates (every price is net weight × the live rate of its karat and kind, in SQL).
    cases.push(
      ['GET /inventory/items (GM, available, page 1) · computed', () => pageItems(ctx, gm, { status: ['AVAILABLE'] }), BUDGET_MS, 'RATE_COMPUTED'],
      [`GET /inventory/items (GM, last page ${itemsLast}) · computed`, () => pageItems(ctx, gm, { status: ['AVAILABLE'], page: itemsLast }), BUDGET_MS, 'RATE_COMPUTED'],
      ['GET /inventory/items (GM, sort price) · computed', () => pageItems(ctx, gm, { status: ['AVAILABLE'], sort: 'price' }), BUDGET_MS, 'RATE_COMPUTED'],
      ['GET /inventory/items (BM, page 1) · computed', () => pageItems(ctx, bm, { status: ['AVAILABLE'] }), BUDGET_MS, 'RATE_COMPUTED'],
      ['GET /inventory/items (POS grid, 200) · computed', () => pageItems(ctx, bm, { status: ['AVAILABLE'], q: '21', pageSize: 200, sort: 'recent' }), BUDGET_MS, 'RATE_COMPUTED'],
      ['GET /dashboard/company (today) · computed', () => companyDashboard(ctx, gm, { from: today, to: today }), BUDGET_MS, 'RATE_COMPUTED'],
      ['GET /dashboard/branch (BM, today) · computed', () => branchDashboard(ctx, bm, {}), BUDGET_MS, 'RATE_COMPUTED'],
      ['GET /reports/inventory (GM, available) · computed', () => runReport(ctx, gm, 'inventory', { status: 'AVAILABLE' }), REPORT_BUDGET_MS, 'RATE_COMPUTED'],
    );
    let mode: PricingSettingMode = (await ctx.settings.get()).pricing.mode;
    const statements = new Map<string, { q: SQL; ms: number }>();
    // --explain-lists (BE-7): the list queries are built by the query builder, so they are caught at the pg pool:
    // the slowest real statement of each list case, with its parameters, is explained after the timings.
    const listStatements = new Map<string, { text: string; values: unknown[]; ms: number }>();
    const clientQuery = pg.Pool.prototype.query;
    let recording: string | null = null;
    const orig = ctx.db.execute.bind(ctx.db);
    let failed = false;
    console.log(`\n| endpoint | p50 ms | p95 ms | budget |\n|---|---|---|---|`);
    for (const [label, fn, budget = BUDGET_MS, want = 'FIXED_TAG'] of cases) {
      if (want !== mode) {
        await ctx.settings.apply(ctx.db, { 'pricing.mode': want }, { actor: { id: null, username: 'perf' } });
        mode = want;
      }
      for (let i = 0; i < 3; i++) await fn();
      const times: number[] = [];
      if (ARGS.has('--explain-lists') && !/^GET \/(dashboard|attention)/.test(label)) {
        recording = label;
        (pg.Pool.prototype as unknown as { query: unknown }).query = function (this: pg.Pool, ...a: unknown[]) {
          const cfg = a[0] as { text?: string; values?: unknown[] } | string;
          const text = typeof cfg === 'string' ? cfg : cfg?.text;
          // drizzle passes ({ text, rowMode, types }, params); plain callers pass (text, params) or ({ text, values }).
          const values = (typeof cfg === 'string' ? a[1] : (cfg?.values ?? a[1])) as unknown[] | undefined;
          const s0 = performance.now();
          const r = (clientQuery as (...x: unknown[]) => unknown).apply(this, a) as Promise<unknown>;
          if (recording && text && /^select/i.test(text) && r && typeof r.then === 'function') {
            const key = recording;
            void r.then(() => {
              const ms = performance.now() - s0;
              const prev = listStatements.get(key);
              if (!prev || prev.ms < ms) listStatements.set(key, { text, values: values ?? [], ms });
            }, () => undefined);
          }
          return r;
        };
      }
      for (let i = 0; i < RUNS; i++) {
        (ctx.db as unknown as { execute: typeof orig }).execute = (async (q: SQL) => {
          const s = performance.now();
          const r = await orig(q);
          const key = statementKey(q);
          const ms = performance.now() - s;
          const prev = statements.get(key);
          if (!prev || prev.ms < ms) statements.set(key, { q, ms });
          return r;
        }) as typeof orig;
        const s = performance.now();
        await fn();
        times.push(performance.now() - s);
        (ctx.db as unknown as { execute: typeof orig }).execute = orig;
      }
      recording = null;
      (pg.Pool.prototype as unknown as { query: unknown }).query = clientQuery;
      times.sort((a, b) => a - b);
      const p50 = times[Math.floor(RUNS * 0.5)];
      const p95 = times[Math.min(RUNS - 1, Math.ceil(RUNS * 0.95) - 1)];
      if (p95 > budget) failed = true;
      console.log(`| ${label} | ${p50.toFixed(0)} | ${p95.toFixed(0)} | ${p95 > budget ? `OVER ${budget}` : `ok (${budget})`} |`);
    }
    // RPT-2: the whole CSV of the sales report over two years, every page of 200 (one run; budget 30 s).
    {
      const s = performance.now();
      const csv = await fetchAllPages((p) => reportRowsPage(ctx, gm, 'sales', { ...all, ...p, page: p.page ?? 1 }) as never);
      const ms = performance.now() - s;
      if (ms > CSV_BUDGET_MS) failed = true;
      console.log(`| CSV walk: /reports/sales, ${csv.length} rows in ${Math.ceil(csv.length / 200)} pages | ${ms.toFixed(0)} | — | ${ms > CSV_BUDGET_MS ? `OVER ${CSV_BUDGET_MS}` : `ok (${CSV_BUDGET_MS})`} |`);
    }
    if (ARGS.has('--explain')) {
      const slow = [...statements.values()].sort((a, b) => b.ms - a.ms).slice(0, 6);
      for (const s of slow) {
        const plan = rows<{ 'QUERY PLAN': string }>(await ctx.db.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${s.q}`)).map((r) => r['QUERY PLAN']);
        console.log(`\n--- ${s.ms.toFixed(1)} ms ---\n${plan.slice(0, 14).join('\n')}`);
      }
    }
    if (ARGS.has('--explain-lists')) {
      const ex = new pg.Client({ connectionString: url.toString() });
      await ex.connect();
      for (const [label, st] of listStatements) {
        const plan = (await ex.query(`EXPLAIN (ANALYZE, BUFFERS) ${st.text}`, st.values)).rows.map((r) => r['QUERY PLAN'] as string);
        console.log(`\n--- ${label}: slowest statement ${st.ms.toFixed(1)} ms ---\n${st.text.slice(0, 300)}${st.text.length > 300 ? '…' : ''}\n${plan.slice(0, 18).join('\n')}`);
      }
      await ex.end();
    }
    console.log(failed ? `\nPERF FAILED: a p95 (or the CSV walk) is above its budget.` : `\nPERF PASSED: every p95 within its budget (lists and homes ${BUDGET_MS} ms, reports ${REPORT_BUDGET_MS} ms, CSV walk ${CSV_BUDGET_MS} ms).`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await handle.close();
    if (!ARGS.has('--keep')) await dropTestDatabase(admin, name);
    else console.log(`(database kept: ${name})`);
    await admin.end();
  }
}

async function actor(ctx: Ctx, username: string): Promise<Actor> {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
}

/**
 * The grouping key of a raw statement: its chunks as JSON. A Drizzle column inside the SQL (PRC-1's live price) points
 * back to its table, so it is written as its name instead of being walked (JSON.stringify refuses the cycle).
 */
function statementKey(q: SQL): string {
  const chunks = (q as unknown as { queryChunks?: unknown }).queryChunks ?? String(q);
  return JSON.stringify(chunks, (_k, v) => (v instanceof Column ? `column:${v.name}` : v)).slice(0, 400);
}

/** Bulk data with plain SQL (seconds, not hours): consistent with the rules the app keeps (movements = statuses). */
async function scale(ctx: Ctx) {
  const x = (q: SQL) => ctx.db.execute(q);
  for (let i = 5; i <= 8; i++) {
    await x(sql`INSERT INTO branches (code, name, name_ar, city) VALUES (${`PF${i}`}, ${`Perf ${i}`}, ${`فرع أداء ${i}`}, 'Perf City')`);
  }
  const [{ uid }] = rows<{ uid: number }>(await x(sql`SELECT id AS uid FROM users WHERE username = 'cashier.kh.01'`));
  // 90,000 pieces: 60,000 sold (one sale each), 1 in 50 of the rest in transit, the others available.
  await x(sql`
    CREATE TEMP TABLE pf AS
    WITH b AS (SELECT array_agg(id ORDER BY id) AS ids FROM branches),
         p AS (SELECT array_agg(id ORDER BY id) AS ids, array_agg(karat ORDER BY id) AS ks FROM products)
    SELECT g,
           b.ids[1 + g % array_length(b.ids, 1)] AS branch_id,
           p.ids[1 + g % array_length(p.ids, 1)] AS product_id,
           p.ks[1 + g % array_length(p.ids, 1)] AS karat,
           3000 + (g * 37) % 25000 AS net,
           now() - make_interval(mins => 1440 + (g * 7919) % (729 * 1440)) AS created_at,
           CASE WHEN g <= 60000 THEN 'SOLD' WHEN g % 50 = 0 THEN 'TRANSFERRED' ELSE 'AVAILABLE' END AS status,
           400000 + (g * 131) % 3000000 AS cost
    FROM generate_series(1, 90000) g, b, p`);
  await x(sql`ALTER TABLE pf ADD COLUMN sale_at timestamptz`);
  await x(sql`UPDATE pf SET sale_at = least(now() - interval '5 minutes', created_at + make_interval(mins => ((g::bigint * 104729) % (30 * 1440))::int)) WHERE status = 'SOLD'`);
  await x(sql`
    INSERT INTO jewelry_items (code, barcode, product_id, karat, gross_weight_mg, net_weight_mg, origin, acquisition_cost, selling_price, branch_id, status, created_at, updated_at)
    SELECT 'PF-' || g, 'PF' || g, product_id, karat, net + 200, net, 'SUPPLIER_NEW', cost, cost + cost / 3, branch_id, status, created_at, created_at FROM pf`);
  await x(sql`ALTER TABLE pf ADD COLUMN item_id int`);
  await x(sql`UPDATE pf SET item_id = i.id FROM jewelry_items i WHERE i.code = 'PF-' || pf.g`);
  await x(sql`
    INSERT INTO inventory_movements (item_id, branch_id, type, direction, net_weight_mg, cost_value, user_id, at)
    SELECT item_id, branch_id, 'PURCHASE', 1, net, cost, ${uid}::int, created_at FROM pf`);
  await x(sql`
    INSERT INTO inventory_movements (item_id, branch_id, type, direction, net_weight_mg, cost_value, user_id, at)
    SELECT item_id, branch_id, 'TRANSFER_OUT', -1, net, cost, ${uid}::int, created_at + interval '1 hour' FROM pf WHERE status = 'TRANSFERRED'`);
  // Sales: one piece each, cash or Hasad; 1 in 50 later voided.
  await x(sql`
    INSERT INTO sales (number, branch_id, cashier_id, subtotal, discount_total, total, cost_total, payment_method, payment_ref_invoice, status, voided_at, voided_by, void_reason, created_at)
    SELECT 'PF-INV-' || g, branch_id, ${uid}::int, cost + cost / 3, 0, cost + cost / 3, cost,
           CASE WHEN g % 10 = 0 THEN 'HASAD' ELSE 'CASH' END, CASE WHEN g % 10 = 0 THEN 'HS-' || g END,
           CASE WHEN g % 50 = 1 THEN 'VOIDED' ELSE 'COMPLETED' END,
           CASE WHEN g % 50 = 1 THEN sale_at + interval '1 hour' END, CASE WHEN g % 50 = 1 THEN ${uid}::int END, CASE WHEN g % 50 = 1 THEN 'perf' END,
           sale_at
    FROM pf WHERE status = 'SOLD'`);
  await x(sql`ALTER TABLE pf ADD COLUMN sale_id int`);
  await x(sql`UPDATE pf SET sale_id = s.id FROM sales s WHERE s.number = 'PF-INV-' || pf.g`);
  // A voided sale gives its piece back: AVAILABLE again, with the movement.
  await x(sql`UPDATE jewelry_items i SET status = 'AVAILABLE' FROM pf WHERE pf.item_id = i.id AND pf.status = 'SOLD' AND pf.g % 50 = 1`);
  await x(sql`
    INSERT INTO sale_items (sale_id, item_id, product_name, karat, net_weight_mg, list_price, discount, final_price, unit_cost, acquisition_cost, profit)
    SELECT sale_id, item_id, 'Perf piece', karat, net, cost + cost / 3, 0, cost + cost / 3, cost, cost, cost / 3 FROM pf WHERE status = 'SOLD'`);
  await x(sql`
    INSERT INTO inventory_movements (item_id, branch_id, type, direction, net_weight_mg, cost_value, user_id, ref_type, ref_id, at)
    SELECT item_id, branch_id, 'SALE', -1, net, cost, ${uid}::int, 'sale', sale_id, sale_at FROM pf WHERE status = 'SOLD'`);
  await x(sql`
    INSERT INTO inventory_movements (item_id, branch_id, type, direction, net_weight_mg, cost_value, user_id, ref_type, ref_id, at)
    SELECT item_id, branch_id, 'RETURN', 1, net, cost, ${uid}::int, 'sale', sale_id, sale_at + interval '1 hour' FROM pf WHERE status = 'SOLD' AND g % 50 = 1`);
  await x(sql`
    INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, payment_method, ref_type, ref_id, ref_number, actor_id, at)
    SELECT a.id, pf.branch_id, pf.cost + pf.cost / 3, 'SALE', CASE WHEN pf.g % 10 = 0 THEN 'HASAD' ELSE 'CASH' END, 'sale', pf.sale_id, 'PF-INV-' || pf.g, ${uid}::int, pf.sale_at
    FROM pf JOIN ledger_accounts a ON a.branch_id = pf.branch_id AND a.kind = CASE WHEN pf.g % 10 = 0 THEN 'HASAD_RECEIVABLE' ELSE 'CASH' END
    WHERE pf.status = 'SOLD'`);
  await x(sql`
    INSERT INTO ledger_entries (account_id, branch_id, amount, event_type, payment_method, ref_type, ref_id, ref_number, actor_id, at)
    SELECT a.id, pf.branch_id, -(pf.cost + pf.cost / 3), 'SALE_VOID', CASE WHEN pf.g % 10 = 0 THEN 'HASAD' ELSE 'CASH' END, 'sale', pf.sale_id, 'PF-INV-' || pf.g, ${uid}::int, pf.sale_at + interval '1 hour'
    FROM pf JOIN ledger_accounts a ON a.branch_id = pf.branch_id AND a.kind = CASE WHEN pf.g % 10 = 0 THEN 'HASAD_RECEIVABLE' ELSE 'CASH' END
    WHERE pf.status = 'SOLD' AND pf.g % 50 = 1`);
  // Open supplier gold debts and a cash count per branch per day for 60 days.
  await x(sql`
    INSERT INTO purchases (number, branch_id, supplier_id, item_count, total_net_weight_mg, total_cost, created_by, created_at, gold_debt_mg_pure24, gold_owed_mg_pure24)
    SELECT 'PF-PO-' || g, (SELECT id FROM branches ORDER BY id OFFSET g % 8 LIMIT 1), (SELECT id FROM suppliers ORDER BY id OFFSET g % (SELECT count(*) FROM suppliers) LIMIT 1),
           5, 20000, 5000000, ${uid}::int, now() - make_interval(days => g % 700), 17500, 17500 - (g % 3) * 5000
    FROM generate_series(1, 2000) g`);
  await x(sql`
    INSERT INTO cash_counts (branch_id, business_day, counted_amount, expected_amount, counted_by, at)
    SELECT b.id, (current_date - d), 0, 0, ${uid}::int, now() - make_interval(days => d)
    FROM branches b, generate_series(1, 60) d`);
  await x(sql`ANALYZE`);
}

async function dataSize(ctx: Ctx) {
  const [r] = rows<Record<string, number>>(
    await ctx.db.execute(sql`SELECT (SELECT count(*) FROM branches)::int AS branches, (SELECT count(*) FROM sales)::int AS sales,
      (SELECT count(*) FROM jewelry_items)::int AS pieces, (SELECT count(*) FROM inventory_movements)::int AS movements,
      (SELECT count(*) FROM ledger_entries)::int AS ledger_entries, (SELECT count(*) FROM purchases)::int AS purchases,
      (SELECT min(created_at)::date::text FROM sales) AS first_sale`),
  );
  return r;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
