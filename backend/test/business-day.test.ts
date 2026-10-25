// BE-7 safety test: business-day boundaries with the server process in UTC (SAFE-1 pins TZ=UTC). The company zone is
// Africa/Khartoum (UTC+2): a record at 23:30 local time on 11 October is 21:30 UTC, one at 00:30 local on 12 October
// is 22:30 UTC on 11 October. Both must land on their LOCAL business day in every list filter (sales, purchases, scrap
// purchases, transfers, audit) and in the sales report, for the General Manager and the branch manager.
// Rows are copies of existing ones with only the number and the time changed (scrap purchases and the audit log are
// append-only: a new row, never an UPDATE). Both projects.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { config, loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { rows } from '../src/core/sql';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
let gm: Agent;
let bm: Agent;

// 23:30 and 00:30 in Khartoum (UTC+2), around midnight between 11 and 12 October 2026.
const LATE = '2026-10-11T21:30:00Z';
const EARLY = '2026-10-11T22:30:00Z';
const DAY1 = '2026-10-11';
const DAY2 = '2026-10-12';

const LISTS = [
  { table: 'sales', at: 'created_at', key: 'number', path: '/api/sales', field: 'number' },
  { table: 'purchases', at: 'created_at', key: 'number', path: '/api/purchases', field: 'number' },
  { table: 'scrap_purchases', at: 'created_at', key: 'number', path: '/api/scrap-purchases', field: 'number' },
  { table: 'transfers', at: 'created_at', key: 'number', path: '/api/transfers', field: 'number' },
  { table: 'audit_logs', at: 'at', key: 'entity_id', path: '/api/audit', field: 'entityId' },
] as const;

const run = (q: string) => handle.db.execute(sql.raw(q));

/** Copy the newest row of the branch manager's branch with a new key and time (a new row: append-only tables allow it). */
async function cloneAt(table: string, at: string, key: string, value: string, when: string, branchId: number) {
  const cols = rows<{ c: string }>(await run(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name <> 'id' ORDER BY ordinal_position`)).map((r) => r.c);
  const select = cols.map((c) => (c === at ? `'${when}'::timestamptz` : c === key ? `'${value}'` : `"${c}"`)).join(', ');
  const branchCol = table === 'transfers' ? 'from_branch_id' : 'branch_id';
  const insert = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) SELECT ${select} FROM "${table}" WHERE ${branchCol} = ${branchId} ORDER BY id DESC LIMIT 1`;
  if (table !== 'sales') return void (await run(insert));
  // PAY-1: a sale and its payment lines are written together (checked when the statement commits): copy the lines.
  await run(`WITH src AS (SELECT id FROM sales WHERE branch_id = ${branchId} ORDER BY id DESC LIMIT 1), s AS (${insert} RETURNING id)
             INSERT INTO sale_payments (sale_id, line_no, method, amount, ref_invoice, ref_transaction, created_at)
             SELECT s.id, p.line_no, p.method, p.amount, p.ref_invoice, p.ref_transaction, '${when}'::timestamptz FROM s, sale_payments p WHERE p.sale_id = (SELECT id FROM src) ORDER BY p.line_no`);
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  const login = async (username: string, password: string) => {
    const a = withIdempotencyKeys(request.agent(app));
    const res = await a.post('/api/auth/login').send({ username, password });
    expect(res.status).toBe(200);
    a.set('x-csrf-token', res.body.csrfToken);
    return a;
  };
  gm = await login('general.manager', DEMO_PASSWORDS.GENERAL_MANAGER);
  bm = await login('branch.manager.kh', DEMO_PASSWORDS.BRANCH_MANAGER);
  const branchId = (await bm.get('/api/auth/me')).body.user.branch.id as number;
  for (const l of LISTS) {
    await cloneAt(l.table, l.at, l.key, `TZ-LATE-${l.table}`, LATE, branchId);
    await cloneAt(l.table, l.at, l.key, `TZ-EARLY-${l.table}`, EARLY, branchId);
  }
});
afterAll(async () => handle.close());

describe('business-day boundaries with the process in UTC', () => {
  it('the process runs in UTC and the company zone is Africa/Khartoum', async () => {
    expect(config).toBeDefined();
    expect(process.env.TZ).toBe('UTC');
    expect(new Date(LATE).getTimezoneOffset()).toBe(0);
    expect((await ctx.settings.get()).company.timezone).toBe('Africa/Khartoum');
  });

  for (const l of LISTS) {
    it(`${l.table}: 23:30 stays on the 11th, 00:30 belongs to the 12th (GM and branch manager)`, async () => {
      for (const [who, agent] of [['GM', gm], ['BM', bm]] as const) {
        const keys = async (day: string) => {
          const res = await agent.get(l.path).query({ from: day, to: day, q: 'TZ-', pageSize: 200 });
          expect(res.status, `${who} ${l.path} ${JSON.stringify(res.body)}`).toBe(200);
          return (res.body.rows as Record<string, string>[]).map((r) => r[l.field]).filter((k) => k?.startsWith('TZ-'));
        };
        const d1 = await keys(DAY1);
        const d2 = await keys(DAY2);
        expect(d1, `${who} ${l.table} on ${DAY1}`).toContain(`TZ-LATE-${l.table}`);
        expect(d1, `${who} ${l.table} on ${DAY1}`).not.toContain(`TZ-EARLY-${l.table}`);
        expect(d2, `${who} ${l.table} on ${DAY2}`).toContain(`TZ-EARLY-${l.table}`);
        expect(d2, `${who} ${l.table} on ${DAY2}`).not.toContain(`TZ-LATE-${l.table}`);
      }
    });
  }

  it('the purchases and audit reports put each row on its local day too (RPT-2: counts and rows)', async () => {
    for (const [key, field, table] of [['purchases', 'number', 'purchases'], ['audit', 'entityId', 'audit_logs']] as const) {
      const keysOn = async (day: string) => {
        const r = (await gm.get(`/api/reports/${key}`).query({ from: day, to: day, q: 'TZ-' })).body as { rows: Record<string, string>[]; rowCount: number; truncated: boolean };
        expect(r.truncated).toBe(false);
        const ks = r.rows.map((x) => x[field]).filter((k) => k?.startsWith('TZ-'));
        return ks;
      };
      expect(await keysOn(DAY1), key).toContain(`TZ-LATE-${table}`);
      expect(await keysOn(DAY1), key).not.toContain(`TZ-EARLY-${table}`);
      expect(await keysOn(DAY2), key).toContain(`TZ-EARLY-${table}`);
      expect(await keysOn(DAY2), key).not.toContain(`TZ-LATE-${table}`);
    }
  });

  it('the sales report puts each sale on its local day too', async () => {
    const numbers = async (day: string) => ((await gm.get('/api/reports/sales').query({ from: day, to: day, q: 'TZ-' })).body.rows as { number: string }[]).map((r) => r.number);
    expect(await numbers(DAY1)).toEqual(['TZ-LATE-sales']);
    expect(await numbers(DAY2)).toEqual(['TZ-EARLY-sales']);
    // RPT-2: the SQL count and totals follow the same day (a voided copy counts as a row but not in the totals).
    for (const [day, num] of [[DAY1, 'TZ-LATE-sales'], [DAY2, 'TZ-EARLY-sales']] as const) {
      const r = (await gm.get('/api/reports/sales').query({ from: day, to: day, q: 'TZ-' })).body as { rows: { number: string; status: string; total: number }[]; rowCount: number; totals: { total: number } };
      expect(r.rowCount).toBe(1);
      const sale = r.rows.find((x) => x.number === num)!;
      expect(r.totals.total).toBe(sale.status === 'COMPLETED' ? sale.total : 0);
    }
  });
});
