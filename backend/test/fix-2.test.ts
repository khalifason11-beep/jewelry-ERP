// FIX-2 (docs/plans/POS-FIXES.md §3, D-fix-2): the bank-transfer reference.
// - required for BANK_TRANSFER, normalized (Arabic-Indic / Persian digits → ASCII, trimmed, spaces collapsed, upper
//   case), 4–40 of A–Z 0–9 space - / .; stored normalized; HASAD references unchanged; CASH refuses any reference;
// - the same normalized reference on another unvoided sale of the same branch: 409 until confirmed (audited);
// - shown in the print payload, the sale detail and list, and the reconciliation drill-down (its rows add up to the
//   bank-transfer sales line, SPEC §18.10);
// - migration 0018: a validated CHECK after a guard that stops (changing nothing) on a bank sale without a reference.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { normalizeBankReference, validBankReference } from '@jerp/shared';
import { createDatabase, MIGRATIONS_DIR, t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { dropTestDatabase, openTestDatabase, PG_MODE, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS, keys = true): Promise<Agent> {
  const raw = request.agent(app);
  const agent = (keys ? withIdempotencyKeys(raw) : raw) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
const lastAudit = async (action: string) => (await ctx.db.select().from(t.auditLogs).where(eq(t.auditLogs.action, action)).orderBy(desc(t.auditLogs.id)).limit(1))[0];
const piece = async (a: Agent) => ((await a.get('/api/inventory/items?status=AVAILABLE&limit=50')).body.items as { id: number }[])[0];

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('normalization (shared by the server and the POS)', () => {
  it('maps Arabic-Indic and Persian digits, trims, collapses spaces, upper-cases', () => {
    expect(normalizeBankReference('  trf ٤٥٦٧   ab ')).toBe('TRF 4567 AB');
    expect(normalizeBankReference('۱۲۳۴-۵/۶.x')).toBe('1234-5/6.X');
    expect(validBankReference('٠٠٠١')).toBe('0001');
  });
  it('accepts 4–40 of A–Z 0–9 space - / . only', () => {
    expect(validBankReference('abc')).toBeNull();
    expect(validBankReference('A'.repeat(41))).toBeNull();
    expect(validBankReference('A'.repeat(40))).toBe('A'.repeat(40));
    for (const bad of ['TRF#1234', 'تحويل 1234', 'TRF_1234', 'TRF<1234>', '']) expect(validBankReference(bad), bad).toBeNull();
  });
});

describe('the reference per payment method', () => {
  it('bank transfer: required and validated; nothing is recorded on a refusal', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const p = await piece(cashier);
    for (const extra of [{}, { paymentRefTransaction: '' }, { paymentRefTransaction: 'ab' }, { paymentRefTransaction: 'TRF#9' }, { paymentRefTransaction: 'TRF-1', paymentRefInvoice: 'X-1' }]) {
      const r = await cashier.post('/api/sales').send({ items: [{ itemId: p.id }], paymentMethod: 'BANK_TRANSFER', ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, p.id)))[0].status).toBe('AVAILABLE');
  });

  it('bank transfer: stored normalized and returned on the sale', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const p = await piece(cashier);
    const r = await cashier.post('/api/sales').send({ items: [{ itemId: p.id }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: '  bok ٧٧٨٨   ٩٩ ' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.paymentRefTransaction).toBe('BOK 7788 99');
    expect((await lastAudit('SALE_CREATED')).metadata).toMatchObject({ bankReference: 'BOK 7788 99' });
  });

  it('cash: any reference is refused; Hasad: unchanged (invoice required, transaction optional, kept as typed)', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const p = await piece(cashier);
    const cash = await cashier.post('/api/sales').send({ items: [{ itemId: p.id }], paymentMethod: 'CASH', paymentRefTransaction: 'TRF-0001' });
    expect(cash.status).toBe(400);
    expect(cash.body.error.message).toBe('A reference is recorded only for bank transfer and Hasad payments');
    expect((await cashier.post('/api/sales').send({ items: [{ itemId: p.id }], paymentMethod: 'HASAD' })).status).toBe(400);
    const h = await cashier.post('/api/sales').send({ items: [{ itemId: p.id }], paymentMethod: 'HASAD', paymentRefInvoice: 'hsd-inv-1', paymentRefTransaction: 'htx-1' });
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ paymentRefInvoice: 'hsd-inv-1', paymentRefTransaction: 'htx-1' });
  });
});

describe('a reference already on another sale of the branch', () => {
  it('409 until confirmed (same key), compared normalized; the confirmation is audited', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER', false);
    const firstItem = (await piece(cashier)).id;
    const first = await cashier.post('/api/sales').set('Idempotency-Key', randomUUID()).send({ items: [{ itemId: firstItem }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'DUP-٤٤٤٤' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const p = await piece(cashier);
    const key = randomUUID();
    const body = { items: [{ itemId: p.id }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: ' dup-4444 ' };
    const dup = await cashier.post('/api/sales').set('Idempotency-Key', key).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_BANK_REFERENCE');
    expect(dup.body.error.details).toEqual({ number: first.body.number, reference: 'DUP-4444' });
    expect((await ctx.db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, p.id)))[0].status).toBe('AVAILABLE');
    // The refusal consumed no key: the confirmation is sent with the same one.
    const ok = await cashier.post('/api/sales').set('Idempotency-Key', key).send({ ...body, confirmDuplicateReference: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await lastAudit('SALE_CREATED')).metadata).toMatchObject({ bankReference: 'DUP-4444', duplicateBankReferenceOf: first.body.number });
  });

  it('another branch, or a cancelled sale, is not a duplicate', async () => {
    const kh = await login('cashier.kh.01', 'CASHIER');
    const omd = await login('cashier.omd.01', 'CASHIER');
    const khItem = (await piece(kh)).id;
    const a = await kh.post('/api/sales').send({ items: [{ itemId: khItem }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'ONE-BRANCH-1' });
    expect(a.status).toBe(200);
    const omdItem = (await piece(omd)).id;
    expect((await omd.post('/api/sales').send({ items: [{ itemId: omdItem }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'one-branch-1' })).status).toBe(200);
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    expect((await bm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.BRANCH_MANAGER })).status).toBe(200);
    const v = await bm.post(`/api/sales/${a.body.id}/void`).send({ reason: 'Wrong piece' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    // The void keeps the reference on the sale and repeats it in its audit row.
    expect((await ctx.db.select().from(t.sales).where(eq(t.sales.id, a.body.id)))[0].paymentRefTransaction).toBe('ONE-BRANCH-1');
    expect((await lastAudit('SALE_CANCELLED')).metadata).toMatchObject({ bankReference: 'ONE-BRANCH-1' });
    const khItem2 = (await piece(kh)).id;
    expect((await kh.post('/api/sales').send({ items: [{ itemId: khItem2 }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'ONE-BRANCH-1' })).status).toBe(200);
  });
});

describe('where the reference is shown', () => {
  it('the print payload (bank transfer only), the sale list', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const bankItem = (await piece(cashier)).id;
    const bank = await cashier.post('/api/sales').send({ items: [{ itemId: bankItem }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'PRT-1234' });
    const pr = await cashier.post(`/api/sales/${bank.body.id}/print`).send({});
    expect(pr.status).toBe(200);
    expect(pr.body.document.bankTransfer).toEqual({ reference: 'PRT-1234' });
    const cashItem = (await piece(cashier)).id;
    const cash = await cashier.post('/api/sales').send({ items: [{ itemId: cashItem }], paymentMethod: 'CASH' });
    expect((await cashier.post(`/api/sales/${cash.body.id}/print`).send({})).body.document.bankTransfer).toBeNull();
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const list = (await bm.get('/api/sales')).body as { id: number; paymentRefTransaction: string | null }[];
    expect(list.find((s) => s.id === bank.body.id)?.paymentRefTransaction).toBe('PRT-1234');
  });

  it('the reconciliation drill-down: one row per bank-transfer sale of the day, adding up to the sales line', async () => {
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const r = (await bm.get('/api/cash/reconciliation')).body;
    const line = r.salesByMethod.find((m: { paymentMethod: string }) => m.paymentMethod === 'BANK_TRANSFER').amount;
    expect(r.bankTransferSales.length).toBeGreaterThan(0);
    expect(r.bankTransferSales.reduce((s: number, x: { amount: number }) => s + x.amount, 0)).toBe(line);
    expect(r.bankTransferSales.map((x: { reference: string }) => x.reference)).toEqual(expect.arrayContaining(['PRT-1234', 'BOK 7788 99']));
    // The cancelled one is still listed (its SALE entry is the day's money in; the void is a separate VOIDS line).
    expect(r.bankTransferSales.find((x: { reference: string; status: string }) => x.reference === 'ONE-BRANCH-1' && x.status === 'VOIDED')).toBeTruthy();
  });

  it('the database itself refuses a bank-transfer sale without a valid reference', async () => {
    const [s] = await ctx.db.select().from(t.sales).where(and(eq(t.sales.paymentMethod, 'BANK_TRANSFER'))).limit(1);
    const e = await ctx.db.update(t.sales).set({ paymentRefTransaction: null }).where(eq(t.sales.id, s.id)).then(() => null, (err: unknown) => err);
    expect(e).not.toBeNull();
    expect(String((e as Error & { cause?: Error }).cause?.message ?? (e as Error).message)).toMatch(/ck_sales_bank_transfer_reference/);
  });
});

// ── migration 0018 on a database migrated up to 0017 ──
const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));
const run = async (h: DatabaseHandle, q: string) => {
  let last: Record<string, unknown>[] = [];
  for (const stmt of q.split(';').map((x) => x.trim()).filter(Boolean)) last = rowsOf<Record<string, unknown>>(await h.db.execute(sql.raw(stmt)));
  return last;
};
let upTo17Dir: string;
const dropAfter: (() => Promise<void>)[] = [];
beforeAll(() => {
  upTo17Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerp-mig17-'));
  fs.cpSync(MIGRATIONS_DIR, upTo17Dir, { recursive: true });
  const journalPath = path.join(upTo17Dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 17);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  for (const f of fs.readdirSync(upTo17Dir)) if (/^(\d{4})_/.test(f) && Number(f.slice(0, 4)) > 17) fs.rmSync(path.join(upTo17Dir, f));
});
afterAll(async () => {
  for (const f of dropAfter) await f();
  fs.rmSync(upTo17Dir, { recursive: true, force: true });
});
async function openAt17(): Promise<DatabaseHandle> {
  let h: DatabaseHandle;
  if (!PG_MODE) h = await createDatabase({ dataDir: 'memory://' });
  else {
    const { default: pg } = await import('pg');
    const base = process.env.TEST_DATABASE_URL!;
    const name = `jerp_f2_${process.pid}_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(base);
    url.pathname = `/${name}`;
    h = await createDatabase({ url: url.toString() });
    dropAfter.push(async () => {
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await dropTestDatabase(a, name);
      await a.end();
    });
  }
  const { migrate } = PG_MODE ? await import('drizzle-orm/node-postgres/migrator') : await import('drizzle-orm/pglite/migrator');
  await migrate(h.db as never, { migrationsFolder: upTo17Dir });
  return h;
}
const BASE = `
  INSERT INTO roles (code, name, name_ar) VALUES ('GENERAL_MANAGER', 'General Manager', 'المدير العام') ON CONFLICT DO NOTHING;
  INSERT INTO users (username, full_name, role_id, password_hash) SELECT 'trial.person', 'Trial', id, 'x' FROM roles WHERE code = 'GENERAL_MANAGER';
  INSERT INTO branches (code, name, name_ar, city) VALUES ('TRL', 'Trial', 'تجربة', 'City')
`;
const sale = (number: string, method: string, ref: string | null) =>
  `INSERT INTO sales (number, branch_id, cashier_id, subtotal, total, cost_total, payment_method, payment_ref_invoice, payment_ref_transaction)
     VALUES ('${number}', (SELECT id FROM branches WHERE code = 'TRL'), (SELECT id FROM users WHERE username = 'trial.person'), 2000, 2000, 1000, '${method}',
             ${method === 'HASAD' ? "'HS-INV-1'" : 'NULL'}, ${ref == null ? 'NULL' : `'${ref}'`})`;
const applied = async (h: DatabaseHandle) => Number((await run(h, 'SELECT count(*) AS n FROM drizzle.__drizzle_migrations'))[0].n);
const hasCheck = async (h: DatabaseHandle) => Number((await run(h, `SELECT count(*) AS n FROM pg_constraint WHERE conname = 'ck_sales_bank_transfer_reference'`))[0].n);

describe('migration 0018 (FIX-2)', () => {
  it('stops on a bank-transfer sale without a reference and changes nothing', async () => {
    const h = await openAt17();
    try {
      await run(h, BASE);
      await run(h, sale('S-OLD', 'BANK_TRANSFER', null));
      const before = await applied(h);
      expect(before).toBe(18);
      const e = await h.migrate().then(() => null, (err: unknown) => err);
      expect(e, 'migration 0018 must stop').not.toBeNull();
      const message = String((e as { cause?: Error }).cause?.message ?? (e as Error).message);
      expect(message).toContain('Migration 0018 (FIX-2) stopped: 1 bank-transfer sale(s) have no valid bank reference');
      expect(message).toContain('Nothing was changed.');
      expect(await applied(h)).toBe(before);
      expect(await hasCheck(h)).toBe(0);
      expect((await run(h, `SELECT payment_ref_transaction FROM sales WHERE number = 'S-OLD'`))[0].payment_ref_transaction).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('upgrades a clean database: Hasad untouched; existing bank sales can still be voided and reprinted (UPDATE)', async () => {
    const h = await openAt17();
    try {
      await run(h, BASE);
      await run(h, sale('S-BANK', 'BANK_TRANSFER', 'TRF-0001'));
      await run(h, sale('S-HSD', 'HASAD', null));
      await h.migrate();
      expect(await hasCheck(h)).toBe(1);
      expect((await run(h, `SELECT convalidated AS v FROM pg_constraint WHERE conname = 'ck_sales_bank_transfer_reference'`))[0].v).toBe(true);
      expect((await run(h, `SELECT payment_ref_invoice AS i, payment_ref_transaction AS t FROM sales WHERE number = 'S-HSD'`))[0]).toEqual({ i: 'HS-INV-1', t: null });
      await run(h, `UPDATE sales SET reprint_count = reprint_count + 1 WHERE number = 'S-BANK'`);
      await run(h, `UPDATE sales SET status = 'VOIDED', voided_at = now(), void_reason = 'test' WHERE number = 'S-BANK'`);
      expect((await run(h, `SELECT status, reprint_count FROM sales WHERE number = 'S-BANK'`))[0]).toMatchObject({ status: 'VOIDED' });
      const e = await run(h, sale('S-NEW', 'BANK_TRANSFER', null)).then(() => null, (err: unknown) => err);
      expect(e, 'a new bank sale without a reference is refused').not.toBeNull();
    } finally {
      await h.close();
    }
  });
});
