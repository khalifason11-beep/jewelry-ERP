import { ap, roundMoney, validBankReference } from '@jerp/shared';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { PaymentMethod } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { dayRange } from '../../core/time';
import { rows } from '../../core/sql';
import { changeStatus, costBreakdown, lockItems, recordMovement } from '../inventory/ledger';
import { accountKindFor, lockDrawerFor, post, reverseRef } from '../ledger/service';
import type { TxIdempotency } from '../../core/idempotency';
import { allowedKarats } from '../../core/karats';
import { maxIdOf, runPaged, sumOf, type PageRequest, type SortSpec } from '../../core/paging';

export interface CreateSaleInput {
  branchId?: number;
  items: { itemId: number; discount?: number }[];
  paymentMethod: PaymentMethod;
  /** Hasad (D-4-6): the Hasad invoice number (required) and transaction reference (optional). */
  paymentRefInvoice?: string;
  /** Hasad: optional transaction reference. BANK_TRANSFER (FIX-2): the bank reference, required. */
  paymentRefTransaction?: string;
  /** FIX-2: record a bank reference already on another unvoided sale of this branch (after the warning). */
  confirmDuplicateReference?: boolean;
  customerName?: string;
  customerNameAr?: string;
  customerPhone?: string;
  /** SEC-2 (D-sec2-2): required when any line's final price differs from its list price. Never printed. */
  priceChangeReason?: string;
}

/** SEC-2: a "price change" is any final line price that differs from the list price, up or down. */
export const PRICE_CHANGE_REASON_MIN = 3;
export const PRICE_CHANGE_REASON_MAX = 200;

export async function createSale(ctx: Ctx, actor: Actor, input: CreateSaleInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'sales.create');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select the branch the sale is made in');
  if (!input.items.length) throw badRequest('The cart is empty');
  const ids = input.items.map((i) => i.itemId);
  if (new Set(ids).size !== ids.length) throw badRequest('The same item appears twice in the cart');

  const settings = await ctx.settings.get();
  // Payment methods offered at the counter (D-4-6): the setting decides; CARD and MOBILE_WALLET
  // stay in the data model but are not accepted unless the General Manager turns them back on.
  if (!settings.sales.posPaymentMethods.includes(input.paymentMethod)) {
    throw badRequest('{method} is not accepted at the counter', { method: input.paymentMethod });
  }
  const refInvoice = input.paymentRefInvoice?.trim() || null;
  let refTransaction = input.paymentRefTransaction?.trim() || null;
  if (input.paymentMethod === 'HASAD' && !refInvoice) throw badRequest('Enter the Hasad invoice number');
  if (input.paymentMethod === 'BANK_TRANSFER') {
    // FIX-2 (D-fix-2): required, normalized (digits, spaces, case), then validated; stored normalized.
    if (refInvoice) throw badRequest('A reference is recorded only for bank transfer and Hasad payments');
    if (!refTransaction) throw badRequest('Enter the bank transfer reference');
    refTransaction = validBankReference(refTransaction);
    if (!refTransaction) throw badRequest('The bank transfer reference must be 4 to 40 letters or digits');
  } else if (input.paymentMethod !== 'HASAD' && (refInvoice || refTransaction)) {
    throw badRequest('A reference is recorded only for bank transfer and Hasad payments');
  }
  const sellable = await allowedKarats(ctx);
  const maxPct = settings.sales.maxDiscountPercentByRole[actor.roleCode] ?? 0;
  const hasDiscount = input.items.some((i) => (i.discount ?? 0) > 0);
  if (hasDiscount && !can(actor, 'sales.discount')) throw forbidden('You are not allowed to give discounts');

  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    // Money route (D-2b-6): claim the idempotency key first, in this transaction.
    await opts.idem?.claim(tx);
    const locked = await lockItems(tx, ids);
    const byId = new Map(locked.map((i) => [i.id, i]));
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, branchId));
    const products = await tx
      .select({ id: t.products.id, name: t.products.name, nameAr: t.products.nameAr })
      .from(t.products)
      .where(inArray(t.products.id, locked.map((i) => i.productId)));
    // Snapshot of the name at the time of sale; the English name is optional (CAT-0), so fall back to Arabic.
    const productName = new Map(products.map((p) => [p.id, p.name?.trim() ? p.name : p.nameAr]));

    const lines = input.items.map((line) => {
      const item = byId.get(line.itemId)!;
      if (item.branchId !== branchId) throw forbidden('Item {code} does not belong to this branch', { code: item.code });
      if (item.status !== 'AVAILABLE') throw badRequest('Item {code} is {status} and cannot be sold', { code: item.code, status: item.status });
      // Karat restriction (D-4-1).
      if (!sellable.includes(item.karat)) {
        throw badRequest('{karat}K is not sold here: sellable pieces must be {allowed}', { karat: item.karat, allowed: sellable.map((k) => `${k}K`).join(', ') });
      }
      const discount = roundMoney(line.discount ?? 0);
      if (discount < 0) throw badRequest('Discount cannot be negative');
      if (discount > (item.sellingPrice * maxPct) / 100) {
        throw forbidden('Discount on {code} exceeds your limit of {pct}%', { code: item.code, pct: maxPct });
      }
      return { item, discount, finalPrice: item.sellingPrice - discount };
    });

    // SEC-2 (D-sec2-2): one reason per sale for every changed line, required, stored on the sale and audited.
    const changed = lines.filter((l) => l.finalPrice !== l.item.sellingPrice);
    const priceChangeReason = changed.length ? (input.priceChangeReason ?? '').trim() : '';
    if (changed.length && priceChangeReason.length < PRICE_CHANGE_REASON_MIN) {
      throw badRequest('Give a reason for the price change ({code})', { code: changed.map((l) => l.item.code).join(', ') });
    }
    if (priceChangeReason.length > PRICE_CHANGE_REASON_MAX) throw badRequest('The reason for the price change is too long');

    // FIX-2: the same bank reference on another unvoided sale of this branch is probably the same transfer twice.
    // Refused until the cashier confirms (two sales can be paid by one transfer); the confirmation is audited.
    let duplicateOf: string | null = null;
    if (input.paymentMethod === 'BANK_TRANSFER' && refTransaction) {
      const [dup] = await tx
        .select({ number: t.sales.number })
        .from(t.sales)
        .where(and(eq(t.sales.branchId, branchId), eq(t.sales.paymentMethod, 'BANK_TRANSFER'), eq(t.sales.status, 'COMPLETED'), eq(t.sales.paymentRefTransaction, refTransaction)))
        .orderBy(desc(t.sales.id))
        .limit(1);
      if (dup && !input.confirmDuplicateReference) {
        throw new AppError(409, 'DUPLICATE_BANK_REFERENCE', 'This reference is already on sale {number}. Record it anyway?', { number: dup.number }, { number: dup.number, reference: refTransaction });
      }
      duplicateOf = dup?.number ?? null;
    }

    const subtotal = lines.reduce((s, l) => s + l.item.sellingPrice, 0);
    const discountTotal = lines.reduce((s, l) => s + l.discount, 0);
    const costTotal = lines.reduce((s, l) => s + l.item.acquisitionCost, 0);
    const number = await nextNumber(tx, branch.code, 'INV');

    const [sale] = await tx
      .insert(t.sales)
      .values({
        number,
        branchId,
        cashierId: actor.userId,
        sessionId: actor.sessionId,
        customerName: input.customerName?.trim() || null,
        customerNameAr: input.customerNameAr?.trim() || null,
        customerPhone: input.customerPhone?.trim() || null,
        subtotal,
        discountTotal,
        total: subtotal - discountTotal,
        costTotal,
        paymentMethod: input.paymentMethod,
        paymentRefInvoice: refInvoice,
        paymentRefTransaction: refTransaction,
        priceChangeReason: priceChangeReason || null,
        createdAt: at,
      })
      .returning();

    const ref = { refType: 'sale', refId: sale.id, refNumber: number };
    for (const l of lines) {
      await tx.insert(t.saleItems).values({
        saleId: sale.id,
        itemId: l.item.id,
        productName: productName.get(l.item.productId) ?? l.item.code,
        karat: l.item.karat,
        netWeightMg: l.item.netWeightMg,
        listPrice: l.item.sellingPrice,
        discount: l.discount,
        finalPrice: l.finalPrice,
        unitCost: l.item.acquisitionCost,
        // Snapshots: later cost changes never rewrite the profit of a past sale (GM-only fields).
        acquisitionCost: l.item.acquisitionCost,
        profit: l.finalPrice - l.item.acquisitionCost,
        pricingMode: 'FIXED_TAG',
      });
      await changeStatus(tx, { item: l.item, to: 'SOLD', from: ['AVAILABLE'], userId: actor.userId, ref, at });
      await recordMovement(tx, { item: l.item, type: 'SALE', branchId, ref, userId: actor.userId, at });
    }

    await writeAudit(tx, actor, {
      action: 'SALE_CREATED',
      entityType: 'sale',
      entityId: number,
      branchId,
      at,
      key: 'Sale {number}: {n} item(s), total {total} ({payment})',
      params: { number, n: lines.length, total: ap.money(subtotal - discountTotal), payment: ap.enum(input.paymentMethod) },
      metadata: { items: lines.map((l) => l.item.code), total: subtotal - discountTotal, discountTotal, ...(priceChangeReason ? { priceChangeReason } : {}), ...(input.paymentMethod === 'BANK_TRANSFER' ? { bankReference: refTransaction } : {}), ...(duplicateOf ? { duplicateBankReferenceOf: duplicateOf } : {}) },
    });
    if (changed.length) {
      // Prices only (list, discount, final): no cost figure ever enters this entry (D-sec2-2, cost redaction).
      await writeAudit(tx, actor, {
        action: 'SALE_PRICE_CHANGED',
        entityType: 'sale',
        entityId: number,
        branchId,
        at,
        key: 'Sale {number}: price changed on {codes}. Reason: {reason}',
        params: { number, codes: changed.map((l) => l.item.code).join(', '), reason: priceChangeReason },
        metadata: {
          reason: priceChangeReason,
          lines: changed.map((l) => ({ code: l.item.code, listPrice: l.item.sellingPrice, discount: l.discount, finalPrice: l.finalPrice })),
        },
      });
    }
    // The money: into the drawer (CASH), the bank (CARD, MOBILE_WALLET, BANK_TRANSFER) — Q5 — or the
    // branch's Hasad receivable (HASAD, D-4-6), until Hasad's bank transfer is recorded (D-4-14).
    await post(
      tx,
      [{ branchId, kind: accountKindFor(input.paymentMethod), amount: subtotal - discountTotal, eventType: 'SALE', paymentMethod: input.paymentMethod, ref: { refType: 'sale', refId: sale.id, refNumber: number }, at }],
      { actor, idempotencyKey: opts.idem?.key },
    );
    await opts.idem?.complete(tx, sale);
    return sale;
  });
}

export interface SaleQuery {
  from?: string;
  to?: string;
  branchId?: number;
  cashierId?: number;
  q?: string;
  status?: string;
  mine?: boolean;
}

/** The filters of the sales list (branch scope and "own sales only" included), shared by the list and the report. */
async function salesWhere(ctx: Ctx, actor: Actor, q: SaleQuery): Promise<SQL[]> {
  requireAny(actor, 'sales.view', 'sales.view_own');
  const where: SQL[] = [];
  const scope = branchScope(actor, q.branchId);
  if (scope != null) where.push(eq(t.sales.branchId, scope));
  if (q.mine || !can(actor, 'sales.view')) where.push(eq(t.sales.cashierId, actor.userId));
  else if (q.cashierId) where.push(eq(t.sales.cashierId, q.cashierId));
  if (q.status) where.push(eq(t.sales.status, q.status));
  const { company } = await ctx.settings.get();
  if (q.from && q.to) {
    const r = dayRange(q.from, q.to, company.timezone);
    where.push(gte(t.sales.createdAt, r.start), lt(t.sales.createdAt, r.end));
  }
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(or(ilike(t.sales.number, s), ilike(t.sales.customerName, s), ilike(t.users.fullName, s))!);
  }
  return where;
}

const saleListColumns = {
  id: t.sales.id,
  number: t.sales.number,
  createdAt: t.sales.createdAt,
  branchId: t.sales.branchId,
  branchName: t.branches.name,
  cashierId: t.sales.cashierId,
  cashierName: t.users.fullName,
  customerName: t.sales.customerName,
  customerNameAr: t.sales.customerNameAr,
  itemCount: sql<number>`(select count(*) from sale_items si where si.sale_id = ${t.sales.id})`,
  weightMg: sql<number>`(select coalesce(sum(si.net_weight_mg),0) from sale_items si where si.sale_id = ${t.sales.id})`,
  subtotal: t.sales.subtotal,
  discountTotal: t.sales.discountTotal,
  total: t.sales.total,
  costTotal: t.sales.costTotal,
  paymentMethod: t.sales.paymentMethod,
  // FIX-2: the bank-transfer reference (Hasad: its transaction reference), shown in the list.
  paymentRefTransaction: t.sales.paymentRefTransaction,
  status: t.sales.status,
};

const saleListFrom = (db: Ctx['db']) =>
  db.select(saleListColumns).from(t.sales).innerJoin(t.branches, eq(t.branches.id, t.sales.branchId)).innerJoin(t.users, eq(t.users.id, t.sales.cashierId));
type SaleListRow = Awaited<ReturnType<typeof saleListFrom>>[number];

function saleListRow(actor: Actor, r: SaleListRow) {
  const base = { ...r, itemCount: Number(r.itemCount), weightMg: Number(r.weightMg) };
  if (!can(actor, 'profit.view')) {
    const { costTotal: _c, ...rest } = base;
    return rest;
  }
  return { ...base, grossProfit: r.status === 'COMPLETED' ? r.total - r.costTotal : 0 };
}


/** The sales report's rows (unchanged: newest first, at most 1,000; see BACKLOG §G). */
export async function listSales(ctx: Ctx, actor: Actor, q: SaleQuery) {
  const where = await salesWhere(ctx, actor, q);
  const rowsAll = await saleListFrom(ctx.db)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(t.sales.createdAt))
    .limit(1000);
  return rowsAll.map((r) => saleListRow(actor, r));
}

export const SALE_SORT_KEYS = ['date', 'number', 'branch', 'cashier', 'total', 'grossProfit'] as const;
export type SaleSortKey = (typeof SALE_SORT_KEYS)[number];
const saleSorts: Record<SaleSortKey, SortSpec> = {
  date: { by: t.sales.createdAt, field: 'createdAt', dir: 'desc' },
  number: { by: t.sales.number, field: 'number', dir: 'desc' },
  branch: { by: t.branches.name, field: 'branchName', dir: 'asc' },
  cashier: { by: t.users.fullName, field: 'cashierName', dir: 'asc' },
  total: { by: t.sales.total, field: 'total', dir: 'desc' },
  // GM only: ordering by profit would reveal it (BE-7).
  grossProfit: { by: sql`(case when ${t.sales.status} = 'COMPLETED' then ${t.sales.total} - ${t.sales.costTotal} else 0 end)`, field: 'grossProfit', dir: 'desc' },
};

/** BE-7: the sales list, one page at a time (`GET /sales`). */
export async function pageSales(ctx: Ctx, actor: Actor, q: SaleQuery & PageRequest<SaleSortKey>) {
  const where = await salesWhere(ctx, actor, q);
  const joined = (w: SQL | undefined) =>
    ctx.db.select({ n: sql<number>`count(*)` }).from(t.sales).innerJoin(t.branches, eq(t.branches.id, t.sales.branchId)).innerJoin(t.users, eq(t.users.id, t.sales.cashierId)).where(w);
  return runPaged(actor, q, {
    sorts: saleSorts,
    defaultSort: 'date',
    id: t.sales.id,
    where,
    maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.sales.id) }).from(t.sales))[0].m),
    count: async (w) => Number((await joined(w))[0].n),
    rows: async ({ where: w, orderBy, limit, offset }) =>
      (await saleListFrom(ctx.db).where(w).orderBy(...orderBy).limit(limit).offset(offset)).map((r) => saleListRow(actor, r)),
    // The footer adds up the completed sales of the whole filtered result (a voided sale counts for nothing).
    totals: async (w) => {
      const done = and(w, eq(t.sales.status, 'COMPLETED'));
      const [s] = await ctx.db
        .select({ count: sql<number>`count(*)`.mapWith(Number), total: sumOf(t.sales.total), costTotal: sumOf(t.sales.costTotal) })
        .from(t.sales)
        .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
        .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
        .where(done);
      const [lines] = await ctx.db
        .select({ itemCount: sql<number>`count(*)`.mapWith(Number), weightMg: sumOf(t.saleItems.netWeightMg) })
        .from(t.saleItems)
        .innerJoin(t.sales, eq(t.sales.id, t.saleItems.saleId))
        .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
        .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
        .where(done);
      const out: Record<string, number> = { sales: s.count, itemCount: lines.itemCount, weightMg: lines.weightMg, total: s.total };
      return can(actor, 'profit.view') ? { ...out, costTotal: s.costTotal, grossProfit: s.total - s.costTotal } : out;
    },
  });
}

export async function getSale(ctx: Ctx, actor: Actor, id: number) {
  requireAny(actor, 'sales.view', 'sales.view_own');
  const [sale] = await ctx.db
    .select({
      sale: t.sales,
      branchName: t.branches.name,
      branchNameAr: t.branches.nameAr,
      branchCode: t.branches.code,
      branchAddress: t.branches.address,
      branchPhone: t.branches.phone,
      cashierName: t.users.fullName,
      cashierNameAr: t.users.fullNameAr,
      cashierUsername: t.users.username,
    })
    .from(t.sales)
    .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
    .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
    .where(eq(t.sales.id, id));
  if (!sale) throw notFound('Sale');
  branchScope(actor, sale.sale.branchId);
  if (!can(actor, 'sales.view') && sale.sale.cashierId !== actor.userId) throw forbidden('You can only view your own sales');

  const showProfit = can(actor, 'profit.view');
  const items = await ctx.db
    .select({
      id: t.saleItems.id,
      itemId: t.saleItems.itemId,
      itemCode: t.jewelryItems.code,
      barcode: t.jewelryItems.barcode,
      productName: t.saleItems.productName,
      productNameAr: t.products.nameAr,
      karat: t.saleItems.karat,
      netWeightMg: t.saleItems.netWeightMg,
      grossWeightMg: t.jewelryItems.grossWeightMg,
      listPrice: t.saleItems.listPrice,
      discount: t.saleItems.discount,
      finalPrice: t.saleItems.finalPrice,
      unitCost: t.saleItems.unitCost,
      acquisitionCost: t.saleItems.acquisitionCost,
      profit: t.saleItems.profit,
      pricingMode: t.saleItems.pricingMode,
      priceGoldValue: t.saleItems.priceGoldValue,
      priceMakingCharge: t.saleItems.priceMakingCharge,
      priceRatePerGram: t.saleItems.priceRatePerGram,
      purchaseCost: costBreakdown.purchaseCost,
      makingCost: costBreakdown.makingCost,
      otherCost: costBreakdown.otherCost,
    })
    .from(t.saleItems)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.saleItems.itemId))
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .leftJoin(t.purchaseItems, eq(t.purchaseItems.itemId, t.jewelryItems.id))
    .where(eq(t.saleItems.saleId, id));

  let voidedByName: string | null = null;
  if (sale.sale.voidedBy) {
    const [u] = await ctx.db.select({ n: t.users.fullName }).from(t.users).where(eq(t.users.id, sale.sale.voidedBy));
    voidedByName = u?.n ?? null;
  }

  const { costTotal, ...saleFields } = sale.sale;
  return {
    ...saleFields,
    ...(showProfit ? { costTotal, grossProfit: sale.sale.total - costTotal } : {}),
    branchName: sale.branchName,
    branchNameAr: sale.branchNameAr,
    branchCode: sale.branchCode,
    branchAddress: sale.branchAddress,
    branchPhone: sale.branchPhone,
    cashierName: sale.cashierName,
    cashierNameAr: sale.cashierNameAr,
    cashierUsername: sale.cashierUsername,
    voidedByName,
    items: items.map((i) => {
      if (showProfit) return i;
      const { unitCost: _u, acquisitionCost: _a, profit: _pr, purchaseCost: _p, makingCost: _m, otherCost: _o, ...rest } = i;
      return rest;
    }),
  };
}

/**
 * SEC-2 (D-sec2-1): does cancelling this sale need a fresh password confirmation? Above the General Manager's
 * amount (setting sales.voidReauthAboveAmount; 0 = every void). Answers false when the caller may not void it at
 * all (another branch, unknown, already cancelled), so the ordinary refusal comes first, before any re-confirmation.
 */
export async function voidNeedsReauth(ctx: Ctx, actor: Actor, id: number): Promise<{ needed: boolean; threshold: number }> {
  const { sales: rules } = await ctx.settings.get();
  const threshold = rules.voidReauthAboveAmount;
  if (!can(actor, 'sales.void')) return { needed: false, threshold };
  const [sale] = await ctx.db.select({ branchId: t.sales.branchId, total: t.sales.total, status: t.sales.status }).from(t.sales).where(eq(t.sales.id, id));
  if (!sale || sale.status !== 'COMPLETED') return { needed: false, threshold };
  try {
    branchScope(actor, sale.branchId);
  } catch {
    return { needed: false, threshold };
  }
  return { needed: threshold === 0 || sale.total > threshold, threshold };
}

export async function voidSale(ctx: Ctx, actor: Actor, id: number, reason: string, opts: { at?: Date; idem?: TxIdempotency; reauth?: { threshold: number } } = {}) {
  const at = opts.at ?? new Date();
  requirePerm(actor, 'sales.void');
  if (!reason?.trim()) throw badRequest('A reason is required to cancel a sale');
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [sale] = await tx.select().from(t.sales).where(eq(t.sales.id, id)).for('update');
    if (!sale) throw notFound('Sale');
    branchScope(actor, sale.branchId);
    if (sale.status !== 'COMPLETED') throw badRequest('Sale is already {status}', { status: sale.status });
    const lines = await tx.select().from(t.saleItems).where(eq(t.saleItems.saleId, id));
    const items = await lockItems(tx, lines.map((l) => l.itemId));
    const ref = { refType: 'sale', refId: sale.id, refNumber: sale.number };
    // CSH-2 (Q7): a cash refund leaves the drawer, so the drawer must hold it (BLOCK, under its lock). The refund is the
    // sale's own CASH entries (a sale recorded before the ledger: its total, when it was paid in cash).
    const [{ cashRefund }] = rows<{ cashRefund: string | number }>(
      await tx.execute(sql`SELECT coalesce(sum(e.amount), 0)::bigint AS "cashRefund" FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
                           WHERE e.ref_type = 'sale' AND e.ref_id = ${sale.id} AND e.event_type = 'SALE' AND a.kind = 'CASH'`),
    );
    const [{ entries: saleEntries }] = rows<{ entries: number }>(await tx.execute(sql`SELECT count(*)::int AS entries FROM ledger_entries WHERE ref_type = 'sale' AND ref_id = ${sale.id} AND event_type = 'SALE'`));
    const refund = Number(saleEntries) > 0 ? Number(cashRefund) : accountKindFor(sale.paymentMethod as PaymentMethod) === 'CASH' ? sale.total : 0;
    await lockDrawerFor(tx, sale.branchId, refund, 'SALE_VOID');
    for (const item of items) {
      await changeStatus(tx, { item, to: 'AVAILABLE', from: ['SOLD'], userId: actor.userId, ref, note: `Sale cancelled: ${reason}`, at });
      await recordMovement(tx, { item, type: 'RETURN', branchId: sale.branchId, ref, userId: actor.userId, note: reason, at });
    }
    await tx
      .update(t.sales)
      .set({ status: 'VOIDED', voidedAt: at, voidedBy: actor.userId, voidReason: reason })
      .where(eq(t.sales.id, id));
    await writeAudit(tx, actor, {
      action: 'SALE_CANCELLED',
      at,
      entityType: 'sale',
      entityId: sale.number,
      branchId: sale.branchId,
      key: 'Sale {number} cancelled ({total}): {reason}',
      params: { number: sale.number, total: ap.money(sale.total), reason },
      metadata: { reason, items: items.map((i) => i.code), ...(sale.paymentMethod === 'BANK_TRANSFER' ? { bankReference: sale.paymentRefTransaction } : {}), ...(opts.reauth ? { reauthenticated: true, reauthAboveAmount: opts.reauth.threshold } : {}) },
    });
    // Refund through the original payment method (Q6): reverse the sale's own ledger entries.
    const by = { actor, idempotencyKey: opts.idem?.key };
    const saleRef = { refType: 'sale', refId: sale.id, refNumber: sale.number };
    const reversed = await reverseRef(tx, saleRef, 'SALE', 'SALE_VOID', by, { note: reason, at });
    if (!reversed) {
      // A sale recorded before the ledger existed: the refund still leaves the account.
      const method = sale.paymentMethod as PaymentMethod;
      await post(tx, [{ branchId: sale.branchId, kind: accountKindFor(method), amount: -sale.total, eventType: 'SALE_VOID', paymentMethod: method, ref: saleRef, note: `${reason} (sale recorded before the ledger)`, at }], by);
    }
    const result = { ok: true };
    await opts.idem?.complete(tx, result);
    return result;
  });
}
