import { ap, goldValue, MAX_SALE_PAYMENTS, paymentsSum, roundMoney, salePaymentLabel, sumInt, validBankReference } from '@jerp/shared';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { PaymentMethod, SalePaymentLine } from '@jerp/shared';
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
import { currentSellingRates, lockPricingShared, priceOf, type CurrentRate, type Pricing } from '../pricing/service';

export interface CreateSaleInput {
  branchId?: number;
  /**
   * PRC-1: `listPrice` = the price the cashier saw for the piece. With computed prices the server prices every piece at
   * confirmation; any difference (a rate changed since) answers 409 PRICES_CHANGED with the new prices (D-prc1-4).
   */
  items: { itemId: number; discount?: number; listPrice?: number }[];
  /**
   * PAY-1 (D-pay1-1): one or two payment lines, one per method, summing exactly to the total (422
   * PAYMENT_TOTAL_MISMATCH otherwise). Each line carries its own references (as below).
   */
  payments?: { method: PaymentMethod; amount: number; refInvoice?: string; refTransaction?: string }[];
  /** The single-method shape (kept for now, D-pay1-5): one line of the whole total. Never together with `payments`. */
  paymentMethod?: PaymentMethod;
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

/** A payment line as requested: `amount` null = the whole total (the single-method shape). References normalized. */
type RequestedPayment = { method: PaymentMethod; amount: number | null; refInvoice: string | null; refTransaction: string | null };

/**
 * PAY-1 (D-pay1-1): the payment lines of a sale request, validated before anything is locked: one or two lines of
 * different methods, each accepted at the counter (`sales.posPaymentMethods`, D-4-6), each amount a whole number above
 * 0, each with its method's references (HASAD: the Hasad invoice number, an optional transaction reference;
 * BANK_TRANSFER: the bank reference, normalized and validated, D-fix-2; other methods: none). The single-method shape
 * is one line of the whole total; both shapes at once are refused. The sum is checked against the total in the sale's
 * transaction.
 */
function paymentLines(input: CreateSaleInput, accepted: readonly PaymentMethod[]): RequestedPayment[] {
  const single = input.paymentMethod != null || input.paymentRefInvoice != null || input.paymentRefTransaction != null;
  if (input.payments && single) throw badRequest('Send the payment lines or one payment method, not both');
  const raw = input.payments
    ? input.payments.map((p) => ({ method: p.method, amount: p.amount as number | null, refInvoice: p.refInvoice, refTransaction: p.refTransaction }))
    : input.paymentMethod
      ? [{ method: input.paymentMethod, amount: null, refInvoice: input.paymentRefInvoice, refTransaction: input.paymentRefTransaction }]
      : [];
  if (!raw.length) throw badRequest('Choose how the sale is paid');
  if (raw.length > MAX_SALE_PAYMENTS) throw badRequest('A sale is paid by at most two payment methods');
  if (new Set(raw.map((p) => p.method)).size !== raw.length) throw badRequest('Each payment line must use a different method');
  return raw.map((p) => {
    // Payment methods offered at the counter (D-4-6): the setting decides; CARD and MOBILE_WALLET
    // stay in the data model but are not accepted unless the General Manager turns them back on.
    if (!accepted.includes(p.method)) throw badRequest('{method} is not accepted at the counter', { method: p.method });
    if (p.amount != null && (!Number.isSafeInteger(p.amount) || p.amount <= 0)) throw badRequest('Each payment amount must be a whole amount above 0');
    const refInvoice = p.refInvoice?.trim() || null;
    let refTransaction = p.refTransaction?.trim() || null;
    if (p.method === 'HASAD' && !refInvoice) throw badRequest('Enter the Hasad invoice number');
    if (p.method === 'BANK_TRANSFER') {
      // FIX-2 (D-fix-2): required, normalized (digits, spaces, case), then validated; stored normalized.
      if (refInvoice) throw badRequest('A reference is recorded only for bank transfer and Hasad payments');
      if (!refTransaction) throw badRequest('Enter the bank transfer reference');
      refTransaction = validBankReference(refTransaction);
      if (!refTransaction) throw badRequest('The bank transfer reference must be 4 to 40 letters or digits');
    } else if (p.method !== 'HASAD' && (refInvoice || refTransaction)) {
      throw badRequest('A reference is recorded only for bank transfer and Hasad payments');
    }
    return { method: p.method, amount: p.amount, refInvoice, refTransaction };
  });
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
  const payments = paymentLines(input, settings.sales.posPaymentMethods);
  const sellable = await allowedKarats(ctx);
  const maxPct = settings.sales.maxDiscountPercentByRole[actor.roleCode] ?? 0;
  const hasDiscount = input.items.some((i) => (i.discount ?? 0) > 0);
  if (hasDiscount && !can(actor, 'sales.discount')) throw forbidden('You are not allowed to give discounts');

  const at = opts.at ?? new Date();
  const pricing: Pricing = { mode: settings.pricing.mode, step: settings.pricing.roundingStep };
  return ctx.db.transaction(async (tx) => {
    // Money route (D-2b-6): claim the idempotency key first, in this transaction.
    await opts.idem?.claim(tx);
    // PRC-1 (D-prc1-5): the shared pricing lock, before the rates are read: a rate change waits for this sale, or this
    // sale waits for the rate change and is priced at the new rate.
    await lockPricingShared(tx);
    const rates = pricing.mode === 'RATE_COMPUTED' ? await currentSellingRates(tx) : new Map<string, CurrentRate>();
    const locked = await lockItems(tx, ids);
    const byId = new Map(locked.map((i) => [i.id, i]));
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, branchId));
    // CAT-1 (D-cat0-3): the names as they are at the sale (product optional, the piece's own type, its description), so a
    // later rename never rewrites the invoice. The English product name is optional (CAT-0): fall back to Arabic.
    const names = await tx
      .select({ itemId: t.jewelryItems.id, productName: t.products.name, productNameAr: t.products.nameAr, categoryName: t.categories.name, categoryNameAr: t.categories.nameAr })
      .from(t.jewelryItems)
      .leftJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
      .innerJoin(t.categories, eq(t.categories.id, t.jewelryItems.categoryId))
      .where(inArray(t.jewelryItems.id, ids));
    const nameOf = new Map(names.map((n) => [n.itemId, n]));

    const priced = input.items.map((line) => {
      const item = byId.get(line.itemId)!;
      if (item.branchId !== branchId) throw forbidden('Item {code} does not belong to this branch', { code: item.code });
      if (item.status !== 'AVAILABLE') throw badRequest('Item {code} is {status} and cannot be sold', { code: item.code, status: item.status });
      // Karat restriction (D-4-1).
      if (!sellable.includes(item.karat)) {
        throw badRequest('{karat}K is not sold here: sellable pieces must be {allowed}', { karat: item.karat, allowed: sellable.map((k) => `${k}K`).join(', ') });
      }
      // PRC-1: the price at confirmation (computed from the current rate, or the tag price). Never 0.
      const price = priceOf(pricing, rates, item);
      if (price.sellingPrice == null) {
        throw pricing.mode === 'RATE_COMPUTED'
          ? price.rateKind === 'USED'
            ? new AppError(400, 'NO_PRICE', 'No selling rate for used {karat}K pieces: {code} cannot be sold until the General Manager sets it', { code: item.code, karat: item.karat })
            : new AppError(400, 'NO_PRICE', 'No selling rate for new {karat}K pieces: {code} cannot be sold until the General Manager sets it', { code: item.code, karat: item.karat })
          : new AppError(400, 'NO_PRICE', 'Item {code} has no selling price', { code: item.code });
      }
      return { line, item, listPrice: price.sellingPrice, ratePerGram: price.pricePerGram };
    });
    // PRC-1 (D-prc1-4): never charge a price the cashier has not seen. A difference from the price shown (or no price
    // sent) refuses the whole sale with every line's current price; the POS shows them and the cashier confirms again.
    if (pricing.mode === 'RATE_COMPUTED' && priced.some((p) => p.line.listPrice !== p.listPrice)) {
      throw new AppError(409, 'PRICES_CHANGED', 'Rates changed: the prices were updated. Check the cart and confirm again.', {}, {
        lines: priced.map((p) => ({ itemId: p.item.id, code: p.item.code, listPrice: p.listPrice, pricePerGram: p.ratePerGram })),
      });
    }
    const lines = priced.map(({ line, item, listPrice, ratePerGram }) => {
      const discount = roundMoney(line.discount ?? 0);
      if (discount < 0) throw badRequest('Discount cannot be negative');
      if (discount > (listPrice * maxPct) / 100) {
        throw forbidden('Discount on {code} exceeds your limit of {pct}%', { code: item.code, pct: maxPct });
      }
      return { item, listPrice, ratePerGram, discount, finalPrice: listPrice - discount };
    });

    // SEC-2 (D-sec2-2): one reason per sale for every changed line, required, stored on the sale and audited.
    const changed = lines.filter((l) => l.finalPrice !== l.listPrice);
    const priceChangeReason = changed.length ? (input.priceChangeReason ?? '').trim() : '';
    if (changed.length && priceChangeReason.length < PRICE_CHANGE_REASON_MIN) {
      throw badRequest('Give a reason for the price change ({code})', { code: changed.map((l) => l.item.code).join(', ') });
    }
    if (priceChangeReason.length > PRICE_CHANGE_REASON_MAX) throw badRequest('The reason for the price change is too long');

    const subtotal = sumInt(lines.map((l) => l.listPrice));
    const discountTotal = lines.reduce((s, l) => s + l.discount, 0);
    const total = subtotal - discountTotal;
    // PAY-1: the payment lines sum EXACTLY to the total (the single-method shape is one line of the whole total).
    const paid: SalePaymentLine[] = payments.map((p) => ({ ...p, amount: p.amount ?? total }));
    const sum = paymentsSum(paid);
    if (sum !== total) {
      throw new AppError(422, 'PAYMENT_TOTAL_MISMATCH', 'The payments add up to {sum}, not the sale total {total}', { sum: sum.toLocaleString('en-US'), total: total.toLocaleString('en-US') }, { sum, total });
    }

    // FIX-2: the same bank reference on another unvoided sale of this branch is probably the same transfer twice.
    // Refused until the cashier confirms (two sales can be paid by one transfer); the confirmation is audited. PAY-1:
    // the reference is the bank-transfer line's, on either line of either sale.
    let duplicateOf: string | null = null;
    const bankLine = paid.find((p) => p.method === 'BANK_TRANSFER');
    const refTransaction = bankLine?.refTransaction ?? null;
    if (refTransaction) {
      const [dup] = await tx
        .select({ number: t.sales.number })
        .from(t.salePayments)
        .innerJoin(t.sales, eq(t.sales.id, t.salePayments.saleId))
        .where(and(eq(t.salePayments.method, 'BANK_TRANSFER'), eq(t.salePayments.refTransaction, refTransaction), eq(t.sales.branchId, branchId), eq(t.sales.status, 'COMPLETED')))
        .orderBy(desc(t.sales.id))
        .limit(1);
      if (dup && !input.confirmDuplicateReference) {
        throw new AppError(409, 'DUPLICATE_BANK_REFERENCE', 'This reference is already on sale {number}. Record it anyway?', { number: dup.number }, { number: dup.number, reference: refTransaction });
      }
      duplicateOf = dup?.number ?? null;
    }

    // OPN-1 (§6): a piece of unknown cost (an opening piece) sells with NULL cost and profit; the sale's cost total
    // sums the known lines only and counts the others. Never 0.
    const costTotal = lines.reduce((s, l) => s + (l.item.acquisitionCost ?? 0), 0);
    const unknownCostLines = lines.filter((l) => l.item.acquisitionCost == null).length;
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
        total,
        costTotal,
        unknownCostLines,
        // PAY-1 (D-pay1-1, D-pay1-3): the label; the references live on the payment lines only.
        paymentMethod: salePaymentLabel(paid.map((p) => p.method)),
        priceChangeReason: priceChangeReason || null,
        createdAt: at,
      })
      .returning();

    const ref = { refType: 'sale', refId: sale.id, refNumber: number };
    await tx.insert(t.salePayments).values(
      paid.map((p, i) => ({ saleId: sale.id, lineNo: i + 1, method: p.method, amount: p.amount, refInvoice: p.refInvoice ?? null, refTransaction: p.refTransaction ?? null, createdAt: at })),
    );
    for (const l of lines) {
      await tx.insert(t.saleItems).values({
        saleId: sale.id,
        itemId: l.item.id,
        ...lineNames(l.item, nameOf.get(l.item.id)),
        karat: l.item.karat,
        netWeightMg: l.item.netWeightMg,
        listPrice: l.listPrice,
        discount: l.discount,
        finalPrice: l.finalPrice,
        unitCost: l.item.acquisitionCost,
        // Snapshots: later cost changes never rewrite the profit of a past sale (GM-only fields). Unknown cost: NULL.
        acquisitionCost: l.item.acquisitionCost,
        profit: l.item.acquisitionCost == null ? null : l.finalPrice - l.item.acquisitionCost,
        // PRC-1: a computed line keeps the rate used and the gold value; the making charge stays NULL (Q-1 open).
        pricingMode: pricing.mode === 'RATE_COMPUTED' ? 'COMPUTED' : 'FIXED_TAG',
        priceRatePerGram: pricing.mode === 'RATE_COMPUTED' ? l.ratePerGram : null,
        priceGoldValue: pricing.mode === 'RATE_COMPUTED' && l.ratePerGram != null ? goldValue(l.item.netWeightMg, l.ratePerGram) : null,
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
      params: { number, n: lines.length, total: ap.money(total), payment: paid.length === 1 ? ap.enum(paid[0].method) : ap.list(paid.map((p) => ap.enum(p.method))) },
      metadata: {
        items: lines.map((l) => l.item.code),
        total,
        discountTotal,
        payments: paid.map((p) => ({ method: p.method, amount: p.amount, ...(p.refInvoice ? { refInvoice: p.refInvoice } : {}), ...(p.refTransaction ? { refTransaction: p.refTransaction } : {}) })),
        ...(priceChangeReason ? { priceChangeReason } : {}),
        ...(refTransaction ? { bankReference: refTransaction } : {}),
        ...(duplicateOf ? { duplicateBankReferenceOf: duplicateOf } : {}),
      },
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
          lines: changed.map((l) => ({ code: l.item.code, listPrice: l.listPrice, discount: l.discount, finalPrice: l.finalPrice })),
        },
      });
    }
    // The money, one entry per payment line (PAY-1): into the drawer (CASH), the bank (CARD, MOBILE_WALLET,
    // BANK_TRANSFER) — Q5 — or the branch's Hasad receivable (HASAD, D-4-6), until Hasad's bank transfer is recorded.
    await post(
      tx,
      paid.map((p) => ({ branchId, kind: accountKindFor(p.method), amount: p.amount, eventType: 'SALE' as const, paymentMethod: p.method, ref, at })),
      { actor, idempotencyKey: opts.idem?.key },
    );
    // PAY-1: the sale as written, with its payment lines and the single-method reference fields read from them.
    const created = { ...sale, ...legacyRefs(paid), payments: paid.map((p) => ({ method: p.method, amount: p.amount, refInvoice: p.refInvoice ?? null, refTransaction: p.refTransaction ?? null })) };
    await opts.idem?.complete(tx, created);
    return created;
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

/**
 * OPN-1 (§6): a sale's gross profit is the profit of its lines of KNOWN cost: total − cost when every cost is known,
 * else the sum of the lines' profit (NULL when no line has a known cost: shown "—", never 0). The correlated
 * sub-query only runs for a sale with unknown lines. Table names are explicit (Drizzle renders a one-table select
 * unqualified).
 */
const saleProfitSql = sql.raw(
  `(case when "sales"."unknown_cost_lines" = 0 then "sales"."total" - "sales"."cost_total" else (select sum(si.profit) from sale_items si where si.sale_id = "sales"."id") end)`,
);
const saleListBase = {
  id: t.sales.id,
  number: t.sales.number,
  createdAt: t.sales.createdAt,
  branchId: t.sales.branchId,
  branchName: t.branches.name,
  cashierId: t.sales.cashierId,
  cashierName: t.users.fullName,
  customerName: t.sales.customerName,
  customerNameAr: t.sales.customerNameAr,
  subtotal: t.sales.subtotal,
  discountTotal: t.sales.discountTotal,
  total: t.sales.total,
  costTotal: t.sales.costTotal,
  unknownCostLines: t.sales.unknownCostLines,
  // PAY-1: the label (a method, or SPLIT); the lines and their references are added per page (`withPayments`).
  paymentMethod: t.sales.paymentMethod,
  status: t.sales.status,
};

/**
 * PAY-1: a list row gets its payment lines (one query for the rows shown) and, as before PAY-1, the bank-transfer
 * reference (Hasad: its transaction reference) shown in the list (FIX-2), read from the lines.
 */
async function withPayments<R extends { id: number }>(db: Ctx['db'], list: R[]) {
  const byId = await salePaymentsOf(db, list.map((r) => r.id));
  return list.map((r) => {
    const payments = byId.get(r.id) ?? [];
    return { ...r, payments, paymentRefTransaction: legacyRefs(payments).paymentRefTransaction };
  });
}
/**
 * PRC-1: the price per gram a sale was charged at, for the sales list: the rate of its computed lines when they all share
 * one; NULL for tag prices or mixed rates (the sale detail shows each line's rate).
 */
const perGramOfLines = (table: string) =>
  sql.raw(`CASE WHEN count(*) = count(${table}.price_rate_per_gram) AND count(DISTINCT ${table}.price_rate_per_gram) = 1 THEN min(${table}.price_rate_per_gram) END`);
const saleListColumns = {
  ...saleListBase,
  grossProfit: sql<number | null>`${saleProfitSql}`.mapWith((v) => (v == null ? null : Number(v))),
  itemCount: sql<number>`(select count(*) from sale_items si where si.sale_id = ${t.sales.id})`,
  weightMg: sql<number>`(select coalesce(sum(si.net_weight_mg),0) from sale_items si where si.sale_id = ${t.sales.id})`,
  pricePerGram: sql<number | null>`(select ${perGramOfLines('si')} from sale_items si where si.sale_id = ${t.sales.id})`,
};

const saleListFrom = (db: Ctx['db']) =>
  db.select(saleListColumns).from(t.sales).innerJoin(t.branches, eq(t.branches.id, t.sales.branchId)).innerJoin(t.users, eq(t.users.id, t.sales.cashierId));
type SaleListRow = Awaited<ReturnType<typeof saleListFrom>>[number];

function saleListRow(actor: Actor, r: SaleListRow) {
  const base = { ...r, itemCount: Number(r.itemCount), weightMg: Number(r.weightMg), pricePerGram: r.pricePerGram == null ? null : Number(r.pricePerGram) };
  if (!can(actor, 'profit.view')) {
    const { costTotal: _c, unknownCostLines: _u, grossProfit: _g, ...rest } = base;
    return rest;
  }
  return { ...base, grossProfit: r.status === 'COMPLETED' ? r.grossProfit : 0 };
}


/** The sales report's rows on screen: newest first, at most `cap` (RPT-2: the report says when it is cut). */
export async function listSales(ctx: Ctx, actor: Actor, q: SaleQuery, cap: number) {
  const where = await salesWhere(ctx, actor, q);
  const rowsAll = await saleListFrom(ctx.db)
    .where(where.length ? and(...where) : undefined)
    // The id breaks ties exactly as the paged CSV walk does (RPT-2), so the screen and the file list rows in one order.
    .orderBy(desc(t.sales.createdAt), desc(t.sales.id))
    .limit(cap);
  return withPayments(ctx.db, rowsAll.map((r) => saleListRow(actor, r)));
}

/**
 * RPT-2: the sales report's count, totals and sales by channel, computed by the database over the WHOLE filtered result
 * (the rows on screen may be cut). Totals cover completed sales only, as the report always did; cost and profit only
 * for `profit.view`.
 */
export async function salesReportAggregates(ctx: Ctx, actor: Actor, q: SaleQuery) {
  const where = await salesWhere(ctx, actor, q);
  const w = where.length ? and(...where) : undefined;
  const done = and(w, eq(t.sales.status, 'COMPLETED'));
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(t.sales)
    .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
    .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
    .where(w);
  const channels = await ctx.db
    .select({ method: t.sales.paymentMethod, total: sumOf(t.sales.total), discountTotal: sumOf(t.sales.discountTotal), costTotal: sumOf(t.sales.costTotal) })
    .from(t.sales)
    .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
    .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
    .where(done)
    .groupBy(t.sales.paymentMethod);
  const [lines] = await ctx.db
    .select(saleLineTotals)
    .from(t.saleItems)
    .innerJoin(t.sales, eq(t.sales.id, t.saleItems.saleId))
    .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
    .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
    .where(done);
  const sum = (k: 'total' | 'discountTotal' | 'costTotal') => channels.reduce((s, c) => s + c[k], 0);
  const totals: Record<string, number | null> = { itemCount: lines.itemCount, weightMg: lines.weightMg, discountTotal: sum('discountTotal'), total: sum('total') };
  if (can(actor, 'profit.view')) Object.assign(totals, profitTotals(sum('total'), sum('costTotal'), lines));
  return { rowCount: n, totals, byChannel: new Map(channels.map((c) => [c.method, c.total])) };
}

/** The lines of the completed sales behind a footer: counts, weight, and the revenue of the lines of unknown cost. */
const saleLineTotals = {
  itemCount: sql<number>`count(*)`.mapWith(Number),
  weightMg: sumOf(t.saleItems.netWeightMg),
  unknownCostLines: sql<number>`count(*) filter (where ${t.saleItems.unitCost} is null)`.mapWith(Number),
  unknownRevenue: sumOf(sql`case when ${t.saleItems.unitCost} is null then ${t.saleItems.finalPrice} else 0 end`),
};

/**
 * OPN-1 (§6): cost and gross profit over the lines of KNOWN cost, with the count of lines left out. Gross profit is
 * NULL when no line has a known cost (an empty result keeps 0).
 */
function profitTotals(total: number, costTotal: number, lines: { itemCount: number; unknownCostLines: number; unknownRevenue: number }) {
  const noneKnown = lines.itemCount > 0 && lines.unknownCostLines === lines.itemCount;
  return { costTotal, grossProfit: noneKnown ? null : total - lines.unknownRevenue - costTotal, unknownCostLines: lines.unknownCostLines };
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
  grossProfit: { by: sql`(case when ${t.sales.status} = 'COMPLETED' then coalesce(${saleProfitSql}, 0) else 0 end)`, field: 'grossProfit', dir: 'desc' },
};

/** BE-7: the sales list, one page at a time (`GET /sales`). */
/** `withTotals: false`: no footer sums (the report's CSV walk reads rows only; RPT-2). */
export async function pageSales(ctx: Ctx, actor: Actor, q: SaleQuery & PageRequest<SaleSortKey>, opts: { withTotals?: boolean } = {}) {
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
    // The page first, then its lines in one grouped query: per-row sub-queries would run for every row an offset
    // skips (seconds on a deep page of 60,000 sales).
    rows: async ({ where: w, orderBy, limit, offset }) => {
      const page = await ctx.db
        .select(saleListBase)
        .from(t.sales)
        .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
        .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
        .where(w)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset);
      if (!page.length) return [];
      const lines = await ctx.db
        .select({
          saleId: t.saleItems.saleId,
          itemCount: sql<number>`count(*)`.mapWith(Number),
          weightMg: sumOf(t.saleItems.netWeightMg),
          pricePerGram: sql<number | null>`${perGramOfLines('"sale_items"')}`.mapWith((v) => (v == null ? null : Number(v))),
          // OPN-1: the profit of the lines of known cost, for the page's rows only (never for the rows an offset skips).
          profit: sql<number | null>`sum(${t.saleItems.profit})`.mapWith((v) => (v == null ? null : Number(v))),
        })
        .from(t.saleItems)
        .where(inArray(t.saleItems.saleId, page.map((r) => r.id)))
        .groupBy(t.saleItems.saleId);
      const bySale = new Map(lines.map((l) => [l.saleId, l]));
      return withPayments(ctx.db, page.map((r) => {
        const l = bySale.get(r.id);
        // A sale with every cost known keeps total − cost (as before OPN-1); otherwise the Σ profit of its known lines.
        const grossProfit = r.unknownCostLines === 0 ? r.total - r.costTotal : (l?.profit ?? null);
        return saleListRow(actor, { ...r, itemCount: l?.itemCount ?? 0, weightMg: l?.weightMg ?? 0, pricePerGram: l?.pricePerGram ?? null, grossProfit });
      }));
    },
    // The footer adds up the completed sales of the whole filtered result (a voided sale counts for nothing).
    totals: opts.withTotals === false ? undefined : async (w) => {
      const done = and(w, eq(t.sales.status, 'COMPLETED'));
      const [s] = await ctx.db
        .select({ count: sql<number>`count(*)`.mapWith(Number), total: sumOf(t.sales.total), costTotal: sumOf(t.sales.costTotal) })
        .from(t.sales)
        .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
        .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
        .where(done);
      const [lines] = await ctx.db
        .select(saleLineTotals)
        .from(t.saleItems)
        .innerJoin(t.sales, eq(t.sales.id, t.saleItems.saleId))
        .innerJoin(t.branches, eq(t.branches.id, t.sales.branchId))
        .innerJoin(t.users, eq(t.users.id, t.sales.cashierId))
        .where(done);
      const out: Record<string, number | null> = { sales: s.count, itemCount: lines.itemCount, weightMg: lines.weightMg, total: s.total };
      return can(actor, 'profit.view') ? { ...out, ...profitTotals(s.total, s.costTotal, lines) } : out;
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
      // CAT-1: the names as they were at the sale (snapshots), never the live product or type.
      productName: t.saleItems.productName,
      productNameAr: sql<string>`coalesce(${t.saleItems.productNameAr}, ${t.saleItems.productName})`,
      categoryName: t.saleItems.categoryName,
      categoryNameAr: t.saleItems.categoryNameAr,
      description: t.saleItems.description,
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
    .leftJoin(t.purchaseItems, eq(t.purchaseItems.itemId, t.jewelryItems.id))
    .where(eq(t.saleItems.saleId, id));

  let voidedByName: string | null = null;
  if (sale.sale.voidedBy) {
    const [u] = await ctx.db.select({ n: t.users.fullName }).from(t.users).where(eq(t.users.id, sale.sale.voidedBy));
    voidedByName = u?.n ?? null;
  }

  const { costTotal, unknownCostLines, paymentRefInvoice: _ri, paymentRefTransaction: _rt, ...saleFields } = sale.sale;
  // PAY-1: one row per payment line; the single-method reference fields are read from the lines.
  const payments = (await salePaymentsOf(ctx.db, [id])).get(id) ?? [];
  // OPN-1 (§6): the profit of the lines of known cost; NULL ("—") when no line has one.
  const known = items.filter((i) => i.profit != null);
  const grossProfit = unknownCostLines === 0 ? sale.sale.total - costTotal : known.length ? known.reduce((s, i) => s + i.profit!, 0) : null;
  return {
    ...saleFields,
    ...legacyRefs(payments),
    payments,
    ...(showProfit ? { costTotal, grossProfit, unknownCostLines } : {}),
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
    // PAY-1: the sale's payment lines (append-only; never changed by a void).
    const payments = await salePaymentsOf(tx, [sale.id]).then((m) => m.get(sale.id) ?? []);
    const items = await lockItems(tx, lines.map((l) => l.itemId));
    const ref = { refType: 'sale', refId: sale.id, refNumber: sale.number };
    // CSH-2 (Q7): a cash refund leaves the drawer, so the drawer must hold it (BLOCK, under its lock). The refund is the
    // sale's own CASH entries (a sale recorded before the ledger: its cash payment line).
    const [{ cashRefund }] = rows<{ cashRefund: string | number }>(
      await tx.execute(sql`SELECT coalesce(sum(e.amount), 0)::bigint AS "cashRefund" FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
                           WHERE e.ref_type = 'sale' AND e.ref_id = ${sale.id} AND e.event_type = 'SALE' AND a.kind = 'CASH'`),
    );
    const [{ entries: saleEntries }] = rows<{ entries: number }>(await tx.execute(sql`SELECT count(*)::int AS entries FROM ledger_entries WHERE ref_type = 'sale' AND ref_id = ${sale.id} AND event_type = 'SALE'`));
    const refund = Number(saleEntries) > 0 ? Number(cashRefund) : payments.filter((p) => accountKindFor(p.method) === 'CASH').reduce((s, p) => s + p.amount, 0);
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
      metadata: {
        reason,
        items: items.map((i) => i.code),
        payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
        ...(bankReferenceOf(payments) ? { bankReference: bankReferenceOf(payments) } : {}),
        ...(opts.reauth ? { reauthenticated: true, reauthAboveAmount: opts.reauth.threshold } : {}),
      },
    });
    // Refund through the original payment method (Q6): reverse the sale's own ledger entries.
    const by = { actor, idempotencyKey: opts.idem?.key };
    const saleRef = { refType: 'sale', refId: sale.id, refNumber: sale.number };
    const reversed = await reverseRef(tx, saleRef, 'SALE', 'SALE_VOID', by, { note: reason, at });
    if (!reversed) {
      // A sale recorded before the ledger existed: the refund still leaves the account, line by line.
      await post(
        tx,
        payments.map((p) => ({ branchId: sale.branchId, kind: accountKindFor(p.method), amount: -p.amount, eventType: 'SALE_VOID' as const, paymentMethod: p.method, ref: saleRef, note: `${reason} (sale recorded before the ledger)`, at })),
        by,
      );
    }
    const result = { ok: true };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** CAT-1: a sale line's name snapshots: the description, else the product, else the type (English falls back to Arabic). */
function lineNames(
  item: { code: string; description: string | null },
  n: { productName: string | null; productNameAr: string | null; categoryName: string | null; categoryNameAr: string } | undefined,
) {
  const en = (v: string | null | undefined) => (v?.trim() ? v : null);
  return {
    productName: item.description ?? en(n?.productName) ?? n?.productNameAr ?? en(n?.categoryName) ?? n?.categoryNameAr ?? item.code,
    productNameAr: item.description ?? n?.productNameAr ?? n?.categoryNameAr ?? null,
    categoryName: n?.categoryName ?? null,
    categoryNameAr: n?.categoryNameAr ?? null,
    description: item.description,
  };
}

/** PAY-1: the payment lines of some sales, by sale, in line order. */
export async function salePaymentsOf(exec: Pick<Ctx['db'], 'select'>, saleIds: number[]): Promise<Map<number, SalePaymentLine[]>> {
  const out = new Map<number, SalePaymentLine[]>();
  if (!saleIds.length) return out;
  const found = await exec
    .select({ saleId: t.salePayments.saleId, method: t.salePayments.method, amount: t.salePayments.amount, refInvoice: t.salePayments.refInvoice, refTransaction: t.salePayments.refTransaction })
    .from(t.salePayments)
    .where(inArray(t.salePayments.saleId, saleIds))
    .orderBy(t.salePayments.saleId, t.salePayments.lineNo);
  for (const { saleId, ...p } of found) {
    const list = out.get(saleId) ?? [];
    list.push({ ...p, method: p.method as PaymentMethod });
    out.set(saleId, list);
  }
  return out;
}

/** The bank reference of a sale's payment lines (its BANK_TRANSFER line), if any. */
export const bankReferenceOf = (payments: readonly SalePaymentLine[]) => payments.find((p) => p.method === 'BANK_TRANSFER')?.refTransaction ?? null;

/**
 * The references the single-method fields of a response carry (kept for the readers of before PAY-1): a one-line
 * sale's references, as read from its line; a split sale's bank reference (else its Hasad transaction reference).
 */
export function legacyRefs(payments: readonly SalePaymentLine[]) {
  const hasad = payments.find((p) => p.method === 'HASAD');
  return { paymentRefInvoice: hasad?.refInvoice ?? null, paymentRefTransaction: bankReferenceOf(payments) ?? hasad?.refTransaction ?? null };
}
