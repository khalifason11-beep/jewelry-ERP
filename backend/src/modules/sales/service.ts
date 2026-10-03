import { ap, roundMoney } from '@jerp/shared';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { PaymentMethod } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { dayRange } from '../../core/time';
import { changeStatus, lockItems, recordMovement } from '../inventory/ledger';
import { accountKindFor, post, reverseRef } from '../ledger/service';
import type { TxIdempotency } from '../../core/idempotency';
import { allowedKarats } from '../../core/karats';

export interface CreateSaleInput {
  branchId?: number;
  items: { itemId: number; discount?: number }[];
  paymentMethod: PaymentMethod;
  /** Hasad (D-4-6): the Hasad invoice number (required) and transaction reference (optional). */
  paymentRefInvoice?: string;
  paymentRefTransaction?: string;
  customerName?: string;
  customerNameAr?: string;
  customerPhone?: string;
}

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
  const refTransaction = input.paymentRefTransaction?.trim() || null;
  if (input.paymentMethod === 'HASAD' && !refInvoice) throw badRequest('Enter the Hasad invoice number');
  if (input.paymentMethod !== 'HASAD' && (refInvoice || refTransaction)) throw badRequest('Payment references are only recorded for Hasad payments');
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
      .select({ id: t.products.id, name: t.products.name })
      .from(t.products)
      .where(inArray(t.products.id, locked.map((i) => i.productId)));
    const productName = new Map(products.map((p) => [p.id, p.name]));

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
      metadata: { items: lines.map((l) => l.item.code), total: subtotal - discountTotal, discountTotal },
    });
    // The money: into the drawer (CASH), the bank (CARD, MOBILE_WALLET, BANK_TRANSFER) — Q5 — or the
    // branch's Hasad receivable (HASAD, D-4-6), held there until a settlement flow is decided.
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

export async function listSales(ctx: Ctx, actor: Actor, q: SaleQuery) {
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
  const showProfit = can(actor, 'profit.view');
  const rowsAll = await ctx.db
    .select({
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
      status: t.sales.status,
    })
    .from(t.sales)
    .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
    .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(t.sales.createdAt))
    .limit(1000);
  return rowsAll.map((r) => {
    const base = { ...r, itemCount: Number(r.itemCount), weightMg: Number(r.weightMg) };
    if (!showProfit) {
      const { costTotal: _c, ...rest } = base;
      return rest;
    }
    return { ...base, grossProfit: r.status === 'COMPLETED' ? r.total - r.costTotal : 0 };
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
      purchaseCost: t.jewelryItems.purchaseCost,
      makingCost: t.jewelryItems.makingCost,
      otherCost: t.jewelryItems.otherCost,
    })
    .from(t.saleItems)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.saleItems.itemId))
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
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

export async function voidSale(ctx: Ctx, actor: Actor, id: number, reason: string, opts: { at?: Date; idem?: TxIdempotency } = {}) {
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
      metadata: { reason, items: items.map((i) => i.code) },
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
