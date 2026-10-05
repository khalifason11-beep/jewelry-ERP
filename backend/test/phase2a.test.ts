// Phase 2a tests (run on PGlite AND real PostgreSQL): idempotency keys, CHECK constraints matching
// the shared spec, append-only ledgers, and row-lock fixes observable without true parallelism.
// True-parallel races live in test/pg/concurrency.test.ts (real PostgreSQL only).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, count, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { DB_ENUM_CHECKS, DB_EXPR_CHECKS, ROUTE_MATRIX, enumCheckExpr, routeId } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { canonicalJson, IDEMPOTENCY_STALE_MS, requestHash } from '../src/core/idempotency';
import { resetThrottleMemory } from '../src/auth/lockout';
import { seedDemo } from '../src/seed/demo';
import { DEMO_PASSWORDS } from '../src/seed/catalog';
import { rows } from '../src/core/sql';
import { unvalidatedConstraints } from '../src/core/startup';
import { openTestDatabase, PG_MODE, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS, withKeys = true): Promise<Agent> {
  const raw = request.agent(app);
  const agent = withKeys ? withIdempotencyKeys(raw) : raw;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}

async function availableItems(branchCode: string, n: number) {
  const [b] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, branchCode));
  const items = await ctx.db
    .select()
    .from(t.jewelryItems)
    .where(and(eq(t.jewelryItems.branchId, b.id), eq(t.jewelryItems.status, 'AVAILABLE')))
    .orderBy(t.jewelryItems.id)
    .limit(n + 20);
  // Skip items other tests in this file already used.
  const fresh = items.filter((i) => !used.has(i.id)).slice(0, n);
  fresh.forEach((i) => used.add(i.id));
  return fresh;
}
const used = new Set<number>();
const key = () => `k-${crypto.randomUUID()}`;
const saleCount = async () => (await ctx.db.select({ n: count() }).from(t.sales))[0].n;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedDemo(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle.close());
beforeEach(() => resetThrottleMemory());

describe('idempotency keys', () => {
  it('every create/confirm route of sales, purchases, transfers and confirmations is idempotent', () => {
    const idem = ROUTE_MATRIX.filter((r) => r.idempotent).map((r) => routeId(r.method, r.path)).sort();
    expect(idem).toEqual(
      [
        'POST /hasad/withdrawals/:id/complete',
        'POST /purchases',
        'POST /sales',
        'POST /sales/:id/void',
        'POST /transfers',
        'POST /transfers/:id/receive',
        'POST /cash/counts',
        'POST /scrap-purchases',
        'POST /purchases/:id/settlements',
        'POST /cash/hasad-settlements',
      ].sort(),
    );
    // Only mutating routes can be idempotent.
    expect(ROUTE_MATRIX.filter((r) => r.idempotent && r.method === 'GET')).toEqual([]);
  });

  it('refuses a missing or malformed key without creating anything', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER', false);
    const [item] = await availableItems('KRT', 1);
    const before = await saleCount();
    const missing = await cashier.post('/api/sales').send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    expect(missing.status).toBe(428);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const bad = await cashier.post('/api/sales').set('Idempotency-Key', 'short').send({ items: [{ itemId: item.id }], paymentMethod: 'CASH' });
    expect(bad.status).toBe(400);
    expect(await saleCount()).toBe(before);
  });

  it('same key + same body replays the first response; nothing is created twice', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER', false);
    const [item] = await availableItems('KRT', 1);
    const k = key();
    const before = await saleCount();
    const body = { items: [{ itemId: item.id }], paymentMethod: 'CASH' };
    const first = await cashier.post('/api/sales').set('Idempotency-Key', k).send(body);
    expect(first.status).toBe(200);
    // Same body with keys in a different order: still the same request.
    const again = await cashier.post('/api/sales').set('Idempotency-Key', k).send({ paymentMethod: 'CASH', items: [{ itemId: item.id }] });
    expect(again.status).toBe(first.status);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await saleCount()).toBe(before + 1);
    const movements = await ctx.db.select().from(t.inventoryMovements).where(and(eq(t.inventoryMovements.itemId, item.id), eq(t.inventoryMovements.type, 'SALE')));
    expect(movements).toHaveLength(1);
  });

  it('same key + different body is 422 and changes nothing', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER', false);
    const [a, b] = await availableItems('KRT', 2);
    const k = key();
    expect((await cashier.post('/api/sales').set('Idempotency-Key', k).send({ items: [{ itemId: a.id }], paymentMethod: 'CASH' })).status).toBe(200);
    const before = await saleCount();
    const other = await cashier.post('/api/sales').set('Idempotency-Key', k).send({ items: [{ itemId: b.id }], paymentMethod: 'CASH' });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await saleCount()).toBe(before);
    const [still] = await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, b.id));
    expect(still.status).toBe('AVAILABLE');
    // The same key on a different route is also a different request.
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER', false);
    const k2 = key();
    expect((await bm.post('/api/cash/counts').set('Idempotency-Key', k2).send({ day: '2026-01-01', countedAmount: 1000 })).status).toBe(200);
    const [c] = await availableItems('KRT', 1);
    const cross = await bm.post('/api/sales').set('Idempotency-Key', k2).send({ items: [{ itemId: c.id }], paymentMethod: 'CASH' });
    expect(cross.status).toBe(422);
  });

  it('keys are per user: another user with the same key gets their own request', async () => {
    const c1 = await login('cashier.kh.01', 'CASHIER', false);
    const c2 = await login('cashier.kh.02', 'CASHIER', false);
    const [a, b] = await availableItems('KRT', 2);
    const k = key();
    expect((await c1.post('/api/sales').set('Idempotency-Key', k).send({ items: [{ itemId: a.id }], paymentMethod: 'CASH' })).status).toBe(200);
    expect((await c2.post('/api/sales').set('Idempotency-Key', k).send({ items: [{ itemId: b.id }], paymentMethod: 'CASH' })).status).toBe(200);
  });

  it('a failed request creates nothing and releases the key; a later retry with the same key runs', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER', false);
    const k = key();
    const bad = await bm.post('/api/cash/counts').set('Idempotency-Key', k).send({ day: '2026-01-01', countedAmount: -1 });
    expect(bad.status).toBe(400);
    const [row] = await ctx.db.select().from(t.idempotencyKeys).where(eq(t.idempotencyKeys.key, k));
    expect(row).toBeUndefined();
    const ok = await bm.post('/api/cash/counts').set('Idempotency-Key', k).send({ day: '2026-01-01', countedAmount: 5000 });
    expect(ok.status).toBe(200);
  });

  it('a double click (same key, concurrent) creates exactly one record', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER', false);
    const [item] = await availableItems('KRT', 1);
    const k = key();
    const before = await saleCount();
    const body = { items: [{ itemId: item.id }], paymentMethod: 'CASH' };
    const results = await Promise.all([1, 2, 3].map(() => cashier.post('/api/sales').set('Idempotency-Key', k).send(body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).not.toHaveLength(0);
    for (const r of results) expect([200, 409]).toContain(r.status);
    const created = new Set(results.filter((r) => r.status === 200).map((r) => r.body.id));
    expect(created.size).toBe(1);
    expect(await saleCount()).toBe(before + 1);
  });

  // Reservation mode (non-money routes such as purchases): a key reserved outside the business
  // transaction. Money routes use the in-transaction mode instead (test/ledger.test.ts).
  const purchaseBody = async () => {
    const [product] = await ctx.db.select().from(t.products).limit(1);
    return { lines: [{ productId: product.id, grossWeightMg: 5_100, netWeightMg: 5_000, purchaseCost: 900_000, makingCost: 50_000, otherCost: 0, sellingPrice: 1_200_000 }] };
  };

  // Reservation mode (non-money routes such as transfers; purchases moved to in-transaction mode in Phase 4).
  const transferBody = async () => {
    const [krt] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT'));
    const [omd] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'OMD'));
    const [item] = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, krt.id), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(1);
    return { fromBranchId: krt.id, toBranchId: omd.id, itemIds: [item.id] };
  };

  it('a stale reservation without a result is reported as uncertain, never re-run', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER', false);
    const [user] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'branch.manager.kh'));
    const k = key();
    const body = await transferBody();
    await ctx.db.insert(t.idempotencyKeys).values({
      userId: user.id,
      key: k,
      route: 'POST /transfers',
      requestHash: requestHash('POST', '/api/transfers', body),
      status: 'IN_PROGRESS',
      createdAt: new Date(Date.now() - IDEMPOTENCY_STALE_MS - 1000),
    });
    const res = await bm.post('/api/transfers').set('Idempotency-Key', k).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_UNCERTAIN');
  });

  it('stores the response as the caller saw it (cost fields already removed for a branch manager)', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER', false);
    const k = key();
    const res = await bm.post('/api/purchases').set('Idempotency-Key', k).send(await purchaseBody());
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('totalCost');
    const [row] = await ctx.db.select().from(t.idempotencyKeys).where(eq(t.idempotencyKeys.key, k));
    expect(row.status).toBe('COMPLETED');
    expect(JSON.stringify(row.responseBody)).not.toContain('totalCost');
  });

  it('hashes requests canonically', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(requestHash('post', '/api/sales', { a: 1, b: 2 })).toBe(requestHash('POST', '/api/sales', { b: 2, a: 1 }));
    expect(requestHash('POST', '/api/sales', { a: 1 })).not.toBe(requestHash('POST', '/api/sales', { a: 2 }));
  });
});

describe('database integrity constraints', () => {
  const liveChecks = async () =>
    rows<{ tbl: string; name: string; def: string; validated: boolean }>(
      await ctx.db.execute(sql`SELECT conrelid::regclass::text AS tbl, conname AS name, pg_get_constraintdef(oid) AS def, convalidated AS validated
                               FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'ck\_%'`),
    );

  it('every constraint in the shared spec exists, is validated, and matches the shared enum values', async () => {
    const live = new Map((await liveChecks()).map((c) => [c.name, c]));
    for (const c of DB_ENUM_CHECKS) {
      const l = live.get(c.name);
      expect(l, c.name).toBeDefined();
      expect(l!.tbl.replace(/"/g, ''), c.name).toBe(c.table);
      expect(l!.validated, `${c.name} is NOT VALID`).toBe(true);
      const values = [...l!.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]).sort();
      expect(values, `${c.name}: DB values differ from shared/src/enums.ts — add a migration`).toEqual([...c.values].sort());
      expect(/IS NULL/.test(l!.def), `${c.name} nullability`).toBe(!!c.nullable);
    }
    for (const c of DB_EXPR_CHECKS) {
      const l = live.get(c.name);
      expect(l, c.name).toBeDefined();
      expect(l!.validated, `${c.name} is NOT VALID`).toBe(true);
    }
    // No stray ck_ constraints outside the spec.
    const known = new Set([...DB_ENUM_CHECKS, ...DB_EXPR_CHECKS].map((c) => c.name));
    expect([...live.keys()].filter((n) => !known.has(n))).toEqual([]);
    expect(enumCheckExpr(DB_ENUM_CHECKS[0])).toContain(' IN (');
  });

  it('the start-up check finds no constraint left NOT VALID on a clean database', async () => {
    expect(await unvalidatedConstraints(ctx.db)).toEqual([]);
  });

  it('rejects impossible values at the database level', async () => {
    const [item] = await ctx.db.select().from(t.jewelryItems).limit(1);
    const reject = async (q: Promise<unknown>, constraint: string) => {
      const e = await q.then(() => null, (err: Error & { cause?: Error }) => err);
      expect(e, `${constraint} should reject`).not.toBeNull();
      expect(`${e!.message} ${e!.cause?.message ?? ''}`).toContain(constraint);
    };
    const base = { ...item, id: undefined, code: `X-${Date.now()}`, barcode: `B-${Date.now()}` };
    await reject(ctx.db.insert(t.jewelryItems).values({ ...base, netWeightMg: 5000, grossWeightMg: 4000 }), 'ck_jewelry_items_net_le_gross');
    await reject(ctx.db.insert(t.jewelryItems).values({ ...base, karat: 25 }), 'ck_jewelry_items_karat_range');
    await reject(ctx.db.insert(t.jewelryItems).values({ ...base, karat: 0 }), 'ck_jewelry_items_karat_range');
    await reject(ctx.db.insert(t.jewelryItems).values({ ...base, sellingPrice: -1 }), 'ck_jewelry_items_selling_price_nonneg');
    await reject(ctx.db.insert(t.jewelryItems).values({ ...base, status: 'LOST' }), 'ck_jewelry_items_status');
    await reject(ctx.db.insert(t.jewelryItems).values({ ...base, totalCost: base.totalCost + 1 }), 'ck_jewelry_items_total_cost_sum');
    await reject(ctx.db.update(t.jewelryItems).set({ status: 'GONE' }).where(eq(t.jewelryItems.id, item.id)), 'ck_jewelry_items_status');
    await reject(ctx.db.insert(t.goldRates).values({ karat: 21, pricePerGram: -5 }), 'ck_gold_rates_price_per_gram_nonneg');
    await reject(ctx.db.update(t.sales).set({ total: sql`total + 1` }).where(sql`true`), 'ck_sales_total_sum');
  });
});

describe('append-only ledgers', () => {
  const tables = ['audit_logs', 'inventory_movements', 'item_status_history', 'gold_rates', 'settings_history'];
  it.each(tables)('%s refuses UPDATE, DELETE and TRUNCATE; rows are unchanged', async (table) => {
    const n = async () => Number(rows<{ n: number }>(await ctx.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0].n);
    const before = await n();
    expect(before).toBeGreaterThan(0);
    for (const stmt of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
      const e = await ctx.db.execute(sql.raw(stmt)).then(() => null, (err: Error & { cause?: Error }) => err);
      expect(e, stmt).not.toBeNull();
      // PGlite runs as superuser: the trigger refuses. The real-PostgreSQL app role is refused by
      // the REVOKE first (both layers: test/pg/integrity.test.ts).
      expect(`${e!.message} ${e!.cause?.message ?? ''}`).toMatch(PG_MODE ? /permission denied|append-only/ : /append-only/);
    }
    expect(await n()).toBe(before);
  });
});
