// Invoice printing (D-print-*): the print data builder never carries cost, profit or gold-debt
// fields (type-level and run time), the layouts, the original-vs-reprint rules per role, the
// INVOICE_REPRINTED audit entry and the reprint counter.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { assertPrintable, buildInvoicePrintData, contentWidthMm, pageRule, scanResponse, type PrintableSale } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { resetThrottleMemory } from '../src/auth/lockout';
import { seedDemo } from '../src/seed/demo';
import { DEMO_PASSWORDS } from '../src/seed/catalog';
import { openTestDatabase, withIdempotencyKeys } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  resetThrottleMemory();
  const a = withIdempotencyKeys(request.agent(app));
  const r = await a.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  a.set('x-csrf-token', r.body.csrfToken);
  return a;
}
const taken = new Set<number>();
async function freshItem(code = 'KRT') {
  const [b] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, code));
  const items = await ctx.db.select().from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, b.id), eq(t.jewelryItems.status, 'AVAILABLE'))).orderBy(t.jewelryItems.id);
  const it = items.find((i) => !taken.has(i.id))!;
  taken.add(it.id);
  return it;
}
async function sell(cashier: Agent, body: Record<string, unknown> = {}) {
  const item = await freshItem();
  const r = await cashier.post('/api/sales').send({ items: [{ itemId: item.id }], paymentMethod: 'CASH', customerName: 'عميل اختبار', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { id: number; number: string };
}
const saleRow = async (id: number) => (await ctx.db.select().from(t.sales).where(eq(t.sales.id, id)))[0];
const reprintAudits = async (number: string) => ctx.db.select().from(t.auditLogs).where(and(eq(t.auditLogs.action, 'INVOICE_REPRINTED'), eq(t.auditLogs.entityId, number))).orderBy(desc(t.auditLogs.id));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedDemo(ctx);
  app = createApp(ctx, loadConfig({ VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

const SAMPLE: PrintableSale = {
  number: 'KRT-S-000123',
  createdAt: new Date('2026-10-04T09:30:00Z'),
  status: 'COMPLETED',
  voidReason: null,
  branch: { name: 'Khartoum Branch', nameAr: 'فرع الخرطوم', address: 'Souq Al Arabi', phone: '+249 1' },
  cashier: { name: 'Cashier', nameAr: 'كاشير' },
  customer: { name: 'Customer', nameAr: null, phone: null },
  subtotal: 1_000_000,
  discountTotal: 50_000,
  total: 950_000,
  paymentMethod: 'HASAD',
  hasadInvoiceRef: 'HSD-INV-1',
  hasadTransactionRef: 'HTX-1',
  lines: [{ code: 'R21-0001', name: 'Ring with a very long name that must wrap on a 72 mm receipt', nameAr: 'خاتم', karat: 21, netWeightMg: 5_250, listPrice: 1_000_000, discount: 50_000, finalPrice: 950_000 }],
};

describe('print data builder', () => {
  it('builds the invoice from a whitelist; Hasad references only for Hasad payments; copy mark only for reprints', () => {
    const d = buildInvoicePrintData(SAMPLE);
    expect(d).toMatchObject({ kind: 'INVOICE', number: 'KRT-S-000123', netWeightMg: 5_250, total: 950_000, hasad: { invoiceRef: 'HSD-INV-1', transactionRef: 'HTX-1' }, copy: null });
    expect(d.lines[0]).toEqual({ code: 'R21-0001', name: SAMPLE.lines[0].name, nameAr: 'خاتم', karat: 21, netWeightMg: 5_250, listPrice: 1_000_000, discount: 50_000, finalPrice: 950_000 });
    expect(buildInvoicePrintData({ ...SAMPLE, paymentMethod: 'CASH' }).hasad).toBeNull();
    expect(buildInvoicePrintData(SAMPLE, { n: 2, printedAt: '2026-10-05T10:00:00Z' }).copy).toEqual({ n: 2, printedAt: '2026-10-05T10:00:00.000Z' });
    expect(scanResponse(d).filter((f) => f.kind !== 'UNCLASSIFIED')).toEqual([]);
  });

  it('layouts: A4 and A5 with 10 mm margins; RECEIPT at the printable width, measured height, no margin', () => {
    expect(pageRule({ format: 'A4', receiptWidthMm: 72 })).toBe('@page { size: A4; margin: 10mm; }');
    expect(pageRule({ format: 'A5', receiptWidthMm: 72 })).toBe('@page { size: A5; margin: 10mm; }');
    // `size: 72mm auto` is invalid CSS (Chromium falls back to Letter): the measured height is used.
    expect(pageRule({ format: 'RECEIPT', receiptWidthMm: 72 }, 143.2)).toBe('@page { size: 72mm 144mm; margin: 0; }');
    expect(pageRule({ format: 'RECEIPT', receiptWidthMm: 58 }, 5)).toBe('@page { size: 58mm 20mm; margin: 0; }');
    expect([contentWidthMm({ format: 'A4', receiptWidthMm: 72 }), contentWidthMm({ format: 'A5', receiptWidthMm: 72 }), contentWidthMm({ format: 'RECEIPT', receiptWidthMm: 58 })]).toEqual([190, 128, 58]);
  });

  it('cannot receive cost fields: rejected by the type and at run time, at any depth', () => {
    // @ts-expect-error costTotal is typed `never` on a print input
    const withCost: PrintableSale = { ...SAMPLE, costTotal: 1 };
    expect(() => buildInvoicePrintData(withCost)).toThrow(/forbidden field \.costTotal/);
    // @ts-expect-error acquisitionCost is typed `never` on a print line
    const line: PrintableSale['lines'][number] = { ...SAMPLE.lines[0], acquisitionCost: 1 };
    expect(() => buildInvoicePrintData({ ...SAMPLE, lines: [line] })).toThrow(/forbidden field \.lines\[0\]\.acquisitionCost/);
    for (const k of ['profit', 'grossProfit', 'unitCost', 'purchaseCost', 'makingCost', 'otherCost', 'margin', 'goldOwedMgPure24', 'goldDebtMgPure24']) {
      expect(() => buildInvoicePrintData({ ...SAMPLE, branch: { ...SAMPLE.branch, [k]: 1 } } as PrintableSale)).toThrow(/forbidden field/);
    }
    expect(() => assertPrintable({ a: [{ b: { costValue: 1 } }] })).toThrow(/costValue/);
  });
});

describe('POST /sales/:id/print', () => {
  it('the cashier prints the ORIGINAL once, right after the sale, in the same session; never a reprint', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const sale = await sell(cashier, { paymentMethod: 'HASAD', paymentRefInvoice: 'HSD-INV-777', paymentRefTransaction: 'HTX-777' });
    const p = await cashier.post(`/api/sales/${sale.id}/print`).send({});
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.document).toMatchObject({ number: sale.number, copy: null, hasad: { invoiceRef: 'HSD-INV-777', transactionRef: 'HTX-777' } });
    expect(p.body.layout).toEqual({ format: 'A4', receiptWidthMm: 72 });
    expect(JSON.stringify(p.body)).not.toMatch(/cost|profit|owed|debt/i);
    expect((await saleRow(sale.id)).originalPrintedAt).toBeInstanceOf(Date);
    // Once.
    const again = await cashier.post(`/api/sales/${sale.id}/print`).send({});
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('REPRINT_NOT_ALLOWED');
    expect((await saleRow(sale.id)).reprintCount).toBe(0);
    // Another session of the same cashier: not "immediately after", so no original either.
    const sale2 = await sell(cashier);
    const later = await login('cashier.kh.01', 'CASHIER');
    expect((await later.post(`/api/sales/${sale2.id}/print`).send({})).status).toBe(403);
    // And never someone else's sale.
    const other = await login('cashier.kh.02', 'CASHIER');
    expect((await other.post(`/api/sales/${sale2.id}/print`).send({})).status).toBe(403);
    expect(await reprintAudits(sale.number)).toHaveLength(0);
  });

  it('managers reprint: COPY n with the reprint date, counter +1, INVOICE_REPRINTED audit; the GM sees no cost either', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const sale = await sell(cashier);
    expect((await cashier.post(`/api/sales/${sale.id}/print`).send({})).body.document.copy).toBeNull();
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    const r1 = await bm.post(`/api/sales/${sale.id}/print`).send({});
    expect(r1.status).toBe(200);
    expect(r1.body.document.copy.n).toBe(1);
    expect(Date.now() - new Date(r1.body.document.copy.printedAt).getTime()).toBeLessThan(60_000);
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    const r2 = await gm.post(`/api/sales/${sale.id}/print`).send({});
    expect(r2.body.document.copy.n).toBe(2);
    for (const body of [r1.body, r2.body]) expect(JSON.stringify(body)).not.toMatch(/cost|profit|margin|owed|debt/i);
    expect((await saleRow(sale.id)).reprintCount).toBe(2);
    const audits = await reprintAudits(sale.number);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ username: 'general.manager', metadata: { reprintCount: 2 } });
    expect(audits[1]).toMatchObject({ username: 'branch.manager.kh', metadata: { reprintCount: 1 } });
    // Audit entries are append-only.
    await expect(ctx.db.update(t.auditLogs).set({ action: 'X' }).where(eq(t.auditLogs.id, audits[0].id))).rejects.toThrow();
  });

  it('a sale nobody printed right away is a COPY when a manager prints it; another branch manager cannot', async () => {
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const sale = await sell(cashier);
    const bm = await login('branch.manager.kh', 'BRANCH_MANAGER');
    expect((await bm.post(`/api/sales/${sale.id}/print`).send({})).body.document.copy.n).toBe(1);
    const omd = await login('branch.manager.omd', 'BRANCH_MANAGER');
    expect((await omd.post(`/api/sales/${sale.id}/print`).send({})).status).toBe(403);
    expect((await saleRow(sale.id)).reprintCount).toBe(1);
  });

  it('the print format follows the settings (RECEIPT width 58)', async () => {
    const gm = await login('general.manager', 'GENERAL_MANAGER');
    expect((await gm.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
    const versions = (await gm.get('/api/settings')).body.versions;
    const put = await gm.put('/api/settings').send({ changes: { 'print.invoiceFormat': 'RECEIPT', 'print.receiptWidthMm': 58 }, expectedVersions: { 'print.invoiceFormat': versions['print.invoiceFormat'] ?? 0, 'print.receiptWidthMm': versions['print.receiptWidthMm'] ?? 0 } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const bad = await gm.put('/api/settings').send({ changes: { 'print.receiptWidthMm': 90 }, expectedVersions: { 'print.receiptWidthMm': 1 } });
    expect(bad.status).toBe(400);
    const cashier = await login('cashier.kh.01', 'CASHIER');
    expect((await cashier.get('/api/auth/me')).body.print).toEqual({ invoiceFormat: 'RECEIPT', receiptWidthMm: 58, autoPrintAfterSale: false });
    const sale = await sell(cashier);
    expect((await cashier.post(`/api/sales/${sale.id}/print`).send({})).body.layout).toEqual({ format: 'RECEIPT', receiptWidthMm: 58 });
  });
});
