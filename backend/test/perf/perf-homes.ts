// Performance of the homes and the attention list on a large real PostgreSQL database (docs/plans/UI-B.md §2.3,
// D-ui-21). Not part of the test suite: run through `node scripts/perf-homes.mjs` (a phase gate).
//
// 1. Creates a fresh database (admin URL from REHEARSAL_ADMIN_URL), migrates it and seeds the 30-day fixture world.
// 2. Scales it with bulk SQL to 8 branches over 2 years: about 60,000 sales (2 % voided), 90,000 pieces, their
//    inventory movements and ledger entries, open supplier gold debts and daily cash counts.
// 3. Times the service functions behind GET /dashboard/company (today and 30 days), /dashboard/branch and /attention
//    (GM and branch manager): 3 warm-up runs, then 20 timed runs; p50 and p95 in milliseconds.
// 4. Prints the slowest SQL statements with EXPLAIN (ANALYZE, BUFFERS), the machine and the data size.
// Exit code 1 when any p95 is above the budget (300 ms).

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import { t } from '@jerp/database';
import { openDatabase, createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { addDays, dayKey } from '../../src/core/time';
import { loadActor } from '../../src/modules/sessions/service';
import { branchDashboard, companyDashboard } from '../../src/modules/dashboard/service';
import { attentionFor } from '../../src/modules/attention/service';
import { rows } from '../../src/core/sql';
import { seedWorld } from '../fixtures/world';
import { dropTestDatabase } from '../helpers';

const BUDGET_MS = 300;
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
    const cases: [string, () => Promise<unknown>][] = [
      ['GET /dashboard/company (today)', () => companyDashboard(ctx, gm, { from: today, to: today })],
      ['GET /dashboard/company (30 days)', () => companyDashboard(ctx, gm, { from: addDays(today, -29), to: today })],
      ['GET /dashboard/branch (BM, today)', () => branchDashboard(ctx, bm, {})],
      ['GET /attention (GM)', () => attentionFor(ctx, gm)],
      ['GET /attention (BM)', () => attentionFor(ctx, bm)],
    ];
    const statements = new Map<string, { q: SQL; ms: number }>();
    const orig = ctx.db.execute.bind(ctx.db);
    let failed = false;
    console.log(`\n| endpoint | p50 ms | p95 ms | budget |\n|---|---|---|---|`);
    for (const [label, fn] of cases) {
      for (let i = 0; i < 3; i++) await fn();
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        (ctx.db as unknown as { execute: typeof orig }).execute = (async (q: SQL) => {
          const s = performance.now();
          const r = await orig(q);
          const key = JSON.stringify((q as unknown as { queryChunks?: unknown }).queryChunks ?? String(q)).slice(0, 400);
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
      times.sort((a, b) => a - b);
      const p50 = times[Math.floor(RUNS * 0.5)];
      const p95 = times[Math.min(RUNS - 1, Math.ceil(RUNS * 0.95) - 1)];
      if (p95 > BUDGET_MS) failed = true;
      console.log(`| ${label} | ${p50.toFixed(0)} | ${p95.toFixed(0)} | ${p95 > BUDGET_MS ? 'OVER' : 'ok'} |`);
    }
    if (ARGS.has('--explain')) {
      const slow = [...statements.values()].sort((a, b) => b.ms - a.ms).slice(0, 6);
      for (const s of slow) {
        const plan = rows<{ 'QUERY PLAN': string }>(await ctx.db.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${s.q}`)).map((r) => r['QUERY PLAN']);
        console.log(`\n--- ${s.ms.toFixed(1)} ms ---\n${plan.slice(0, 14).join('\n')}`);
      }
    }
    console.log(failed ? `\nPERF FAILED: a p95 is above ${BUDGET_MS} ms.` : `\nPERF PASSED: every p95 within ${BUDGET_MS} ms.`);
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
