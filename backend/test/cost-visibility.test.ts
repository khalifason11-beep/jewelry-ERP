// COST VISIBILITY GUARANTEE (Q15, docs/decisions.md D-2a-7) — schema-driven, not name-list-driven.
//   1. Every column of every table (walked from the Drizzle schemas) is classified COST or SAFE in
//      shared/src/field-classification.ts; an unclassified or stale entry fails the build.
//   2. Every GET route of the matrix is called as GM, branch manager and cashier; any field the
//      registry does not know fails, and any COST field reaching BM/cashier fails — at any depth,
//      inside arrays, report column descriptors and audit parameters.
//   3. Audit entries never reveal a cost figure to BM/cashier, even inside the rendered text.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq, getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { schema, t, type DatabaseHandle } from '@jerp/database';
import { hasadMockTables } from '@jerp/hasad';
import { COLUMN_CLASSES, COST_RESPONSE_FIELDS, REPORT_KEYS, ROUTE_MATRIX, routeId, scanResponse } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { seedDemo } from '../src/seed/demo';
import { DEMO_PASSWORDS } from '../src/seed/catalog';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
const ROLES = { GENERAL_MANAGER: 'general.manager', BRANCH_MANAGER: 'branch.manager.kh', CASHIER: 'cashier.kh.01' } as const;
type Role = keyof typeof ROLES;
const agents = {} as Record<Role, Agent>;

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedDemo(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
  for (const [role, username] of Object.entries(ROLES) as [Role, string][]) {
    const a = withIdempotencyKeys(request.agent(app));
    const res = await a.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
    expect(res.status).toBe(200);
    a.set('x-csrf-token', res.body.csrfToken);
    agents[role] = a;
  }
});
afterAll(async () => handle.close());

describe('1. every database column is classified COST or SAFE', () => {
  type AnyTable = Parameters<typeof getTableName>[0];
  const tables = [...Object.values(schema), ...Object.values(hasadMockTables)].filter((v) => is(v, PgTable)) as unknown as AnyTable[];

  it('walks the Drizzle schemas: no unclassified, double-classified or stale column', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const table of tables) {
      const name = getTableName(table);
      seen.add(name);
      const cls = COLUMN_CLASSES[name];
      if (!cls) {
        problems.push(`table ${name} is not classified`);
        continue;
      }
      const cost = new Set(cls.cost ?? []);
      const safe = new Set(cls.safe);
      const columns = Object.values(getTableColumns(table as never) as Record<string, { name: string }>).map((c) => c.name);
      for (const c of columns) {
        if (cost.has(c) && safe.has(c)) problems.push(`${name}.${c} is both COST and SAFE`);
        if (!cost.has(c) && !safe.has(c)) problems.push(`${name}.${c} is not classified`);
      }
      for (const c of [...cost, ...safe]) if (!columns.includes(c)) problems.push(`${name}.${c} is classified but does not exist`);
    }
    for (const name of Object.keys(COLUMN_CLASSES)) if (!seen.has(name)) problems.push(`table ${name} is classified but does not exist`);
    expect(problems, 'fix shared/src/field-classification.ts').toEqual([]);
    expect(tables.length).toBeGreaterThan(25);
  });

  it('a COST column can only surface under a COST field name, a SAFE column never under one', () => {
    const problems: string[] = [];
    for (const [table, cls] of Object.entries(COLUMN_CLASSES)) {
      for (const c of cls.cost ?? []) if (!COST_RESPONSE_FIELDS.has(camel(c))) problems.push(`${table}.${c} is COST but "${camel(c)}" is not a COST response field`);
      for (const c of cls.safe) if (COST_RESPONSE_FIELDS.has(camel(c))) problems.push(`${table}.${c} is SAFE but "${camel(c)}" is a COST response field`);
    }
    expect(problems).toEqual([]);
  });
});

describe('2. every GET route, every role: no unclassified field, no COST field for BM/cashier', () => {
  /** Concrete requests for every GET rule (the test fails if a rule has none). */
  const requestsFor = async (): Promise<Record<string, string[]>> => {
    const one = async <T>(q: Promise<T[]>) => (await q)[0];
    const [krt] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT'));
    const soldItem = await one(ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, krt.id), eq(t.jewelryItems.status, 'SOLD'))));
    const availItem = await one(ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, krt.id), eq(t.jewelryItems.status, 'AVAILABLE'))));
    const cashier = await one(ctx.db.select().from(t.users).where(eq(t.users.username, ROLES.CASHIER)));
    const ownSale = await one(ctx.db.select().from(t.sales).where(eq(t.sales.cashierId, cashier.id)).orderBy(desc(t.sales.id)));
    const voided = await one(ctx.db.select().from(t.sales).where(and(eq(t.sales.branchId, krt.id), eq(t.sales.status, 'VOIDED'))));
    const purchase = await one(ctx.db.select().from(t.purchases).where(eq(t.purchases.branchId, krt.id)));
    const done = await one(ctx.db.select().from(t.hasadWithdrawals).where(and(eq(t.hasadWithdrawals.branchId, krt.id), eq(t.hasadWithdrawals.status, 'COMPLETED'))));
    const ready = await one(ctx.db.select().from(t.hasadWithdrawals).where(and(eq(t.hasadWithdrawals.branchId, krt.id), eq(t.hasadWithdrawals.status, 'READY_FOR_PICKUP'))));
    const reportPaths = [
      ...REPORT_KEYS.map((k) => `/reports/${k}`),
      '/reports/inventory-ledger',
      ...['category', 'karat', 'cashier', 'day'].map((g) => `/reports/profit?group=${g}`),
      ...['category', 'karat', 'cashier', 'day'].map((g) => `/reports/sales?group=${g}`),
    ];
    return {
      'GET /meta': ['/meta'],
      'GET /health': ['/health'],
      'GET /branding/logo': [], // binary image, not JSON
      'GET /auth/me': ['/auth/me'],
      'GET /notifications': ['/notifications'],
      'GET /branches': ['/branches'],
      'GET /branches/directory': ['/branches/directory'],
      'GET /categories': ['/categories'],
      'GET /gold-rates': ['/gold-rates'],
      'GET /products': ['/products'],
      'GET /suppliers': ['/suppliers'],
      'GET /roles': ['/roles'],
      'GET /branches/:id': [`/branches/${krt.id}`],
      'GET /settings': ['/settings'],
      'GET /settings/history/:key': ['/settings/history/security.idleMinutes'],
      'GET /sessions': ['/sessions'],
      'GET /users': ['/users'],
      'GET /inventory/items': ['/inventory/items', `/inventory/items?branchId=${krt.id}&status=SOLD`],
      'GET /inventory/items/:id': [`/inventory/items/${soldItem.id}`, `/inventory/items/${availItem.id}`],
      'GET /sales': ['/sales', '/sales?mine=true'],
      'GET /sales/:id': [`/sales/${ownSale.id}`, ...(voided ? [`/sales/${voided.id}`] : [])],
      'GET /hasad/withdrawals': ['/hasad/withdrawals'],
      'GET /hasad/withdrawals/:id': [`/hasad/withdrawals/${done.id}`, `/hasad/withdrawals/${ready.id}`],
      'GET /hasad/withdrawals/:id/candidates': [`/hasad/withdrawals/${ready.id}/candidates`],
      'GET /purchases': ['/purchases'],
      'GET /purchases/:id': [`/purchases/${purchase.id}`],
      'GET /expenses': ['/expenses'],
      'GET /transfers': ['/transfers'],
      'GET /dashboard/branch': [`/dashboard/branch?branchId=${krt.id}`],
      'GET /dashboard/company': ['/dashboard/company'],
      'GET /reports/:key': reportPaths,
      'GET /audit': ['/audit', '/audit?limit=5000'],
      'GET /cash/drawer': [`/cash/drawer?branchId=${krt.id}`],
      'GET /cash/reconciliation': [`/cash/reconciliation?branchId=${krt.id}`],
      'GET /hasad/simulator/customers': ['/hasad/simulator/customers'],
      'GET /hasad/integration-log': ['/hasad/integration-log'],
    };
  };

  it('has concrete requests for every GET rule in the matrix', async () => {
    const reqs = await requestsFor();
    const missing = ROUTE_MATRIX.filter((r) => r.method === 'GET').map((r) => routeId(r.method, r.path)).filter((id) => !(id in reqs));
    expect(missing, 'add a request for these GET routes').toEqual([]);
  });

  it.each(Object.keys(ROLES) as Role[])('%s: all GET responses are classified; COST fields only for the GM', async (role) => {
    const reqs = await requestsFor();
    const leaks: string[] = [];
    const unknown: string[] = [];
    let ok = 0;
    for (const [rule, paths] of Object.entries(reqs)) {
      for (const path of paths) {
        const res = await agents[role].get(`/api${path}`);
        if (role === 'GENERAL_MANAGER') expect(res.status, `${role} ${path}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
        if (res.status !== 200) continue; // not permitted for this role (the matrix tests cover denials)
        ok++;
        for (const f of scanResponse(res.body)) {
          if (f.kind === 'UNCLASSIFIED') unknown.push(`${rule} ${path} ${f.path}`);
          else if (role !== 'GENERAL_MANAGER') leaks.push(`${rule} ${path} ${f.path}`);
        }
      }
    }
    expect(unknown, 'classify in shared/src/field-classification.ts').toEqual([]);
    expect(leaks, 'COST field sent to a caller without profit.view').toEqual([]);
    expect(ok).toBeGreaterThan(role === 'CASHIER' ? 10 : 30);
  });

  it('the GM does receive cost fields (the redaction is role-based, not a blanket removal)', async () => {
    const res = await agents.GENERAL_MANAGER.get('/api/reports/profit');
    expect(scanResponse(res.body).some((f) => f.kind === 'COST')).toBe(true);
  });
});

describe('3. audit entries never reveal a cost figure to BM or cashier', () => {
  it('a purchase audit shows the cost to the GM only; BM sees "—" in params and text', async () => {
    const [krt] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT'));
    const [p] = await ctx.db.select().from(t.purchases).where(eq(t.purchases.branchId, krt.id)).orderBy(desc(t.purchases.id)).limit(1);
    const figure = p.totalCost.toLocaleString('en-US');
    const find = async (role: Role) => {
      const res = await agents[role].get(`/api/audit?limit=5000&q=${encodeURIComponent(p.number)}`);
      expect(res.status).toBe(200);
      return (res.body as { action: string; description: string; descriptionParams: Record<string, unknown> }[]).find((a) => a.action === 'PURCHASE_CREATED');
    };
    const gm = await find('GENERAL_MANAGER');
    expect(gm!.description).toContain(figure);
    expect(gm!.descriptionParams.cost).toEqual({ money: p.totalCost });
    const bm = await find('BRANCH_MANAGER');
    expect(bm, 'BM must still see the audit entry itself').toBeDefined();
    expect(bm!.descriptionParams.cost).toEqual({ hidden: true });
    expect(bm!.description).not.toContain(figure);
    expect(bm!.description).toContain('cost —');
    expect(JSON.stringify(bm)).not.toContain(String(p.totalCost));
    // The same rule applies inside every report that returns audit rows.
    const report = await agents.BRANCH_MANAGER.get('/api/reports/audit');
    expect(JSON.stringify(report.body)).not.toContain(figure);
  });
});
