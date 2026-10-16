import { ap, pureGoldMg, sumInt, validBankReference, type MakingChargePayer } from '@jerp/shared';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import { nameOrAr } from '../../core/sql';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, notFound } from '../../core/errors';
import { nextItemCode, nextNumber } from '../../core/numbering';
import { dayKey, dayRange } from '../../core/time';
import { recordMovement } from '../inventory/ledger';
import { assertSellableKarat } from '../../core/karats';
import type { TxIdempotency } from '../../core/idempotency';
import { settlementsFor } from '../supplier-settlements/service';
import { assertProductsUsable } from '../catalog/service';
import { daysOpen, supplierGoldOwed } from './supplier-debt';
import { maxIdOf, runPaged, sumOf, type PageRequest, type SortSpec } from '../../core/paging';

export interface PurchaseLine {
  productId: number;
  grossWeightMg: number;
  netWeightMg: number;
  purchaseCost: number;
  makingCost: number;
  otherCost: number;
  sellingPrice: number;
}

export interface CreatePurchaseInput {
  branchId?: number;
  supplierId?: number;
  supplierInvoiceNo?: string;
  notes?: string;
  /** MKC-1: the owner's bank transfer reference for the making charge (required when it is above 0). */
  makingChargeReference?: string;
  /** MKC-1: the date of that transfer, YYYY-MM-DD, not in the future (required when the charge is above 0). */
  makingChargeTransferDate?: string;
  /** MKC-1 (Q4): record a transfer reference already on another order, after the warning. Never a block. */
  confirmDuplicateReference?: boolean;
  /** SUP-1: record a new order for a supplier that still has gold owed, after the warning. Never a block. */
  confirmOpenSupplierDebt?: boolean;
  lines: PurchaseLine[];
}

/** MKC-1 (D-mkc-1, D-mkc-3): the payment fact of a making charge. Above 0: the reference (FIX-2 rules) and the date. */
function makingChargeTransfer(input: CreatePurchaseInput, makingCharge: number, today: string) {
  if (makingCharge === 0) {
    if (input.makingChargeReference || input.makingChargeTransferDate) throw badRequest('A making charge of 0 has no transfer to record');
    return { reference: null, transferDate: null };
  }
  const reference = validBankReference(input.makingChargeReference);
  if (!reference) throw badRequest('Enter the bank transfer reference (4 to 40 letters or digits)');
  const d = input.makingChargeTransferDate;
  if (!d) throw badRequest('Enter the date of the transfer');
  const parsed = new Date(`${d}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) throw badRequest('Invalid value for {field}', { field: 'makingChargeTransferDate' });
  if (d > today) throw badRequest('The transfer date cannot be in the future');
  return { reference, transferDate: d };
}

/**
 * Receive purchased pieces into a branch: PURCHASED → RECEIVED → AVAILABLE, ledger PURCHASE.
 *
 * Supplier terms (Phase 4, D-4-4): gold for gold. The order owes the supplier the 24K equivalent of
 * the pieces' net weight (gold_owed_mg_pure24, settled later only with broken scrap); the making
 * charge is the only money ever paid to a supplier.
 *
 * MKC-1 (D-mkc-1): the General Manager records an order only after the pieces have arrived at the branch, and the
 * owner pays the making charge by one bank transfer from his PERSONAL account. The order records that payment fact
 * (who, the reference, the date) and posts NO ledger entry: no branch drawer, bank or OWED_TO_GM moves, and the branch
 * owes nothing. The making charge stays in each piece's cost (acquisition_cost), so cost and profit are unchanged.
 */
export async function createPurchase(ctx: Ctx, actor: Actor, input: CreatePurchaseInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'purchases.create');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select the receiving branch');
  if (!input.lines.length) throw badRequest('Add at least one item');
  for (const l of input.lines) {
    if (l.netWeightMg <= 0 || l.grossWeightMg < l.netWeightMg) throw badRequest('Gross weight must be ≥ net weight > 0');
    if (l.purchaseCost <= 0 || l.sellingPrice <= 0) throw badRequest('Costs and prices must be positive');
    if (l.makingCost < 0 || l.otherCost < 0) throw badRequest('Costs and prices must be positive');
  }
  // SPEC §7.1, owner decision (CAT-0): a supplier order always names its supplier (the gold debt is owed to them).
  if (!input.supplierId) throw badRequest('Select the supplier');
  const settings = await ctx.settings.get();
  if (!settings.purchases.supplierCreditEnabled) throw badRequest('Supplier purchases on gold credit are turned off in the settings');
  const at = opts.at ?? new Date();
  const payer: MakingChargePayer = 'OWNER_PERSONAL';
  const transfer = makingChargeTransfer(input, sumInt(input.lines.map((l) => l.makingCost)), dayKey(at, settings.company.timezone));

  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, branchId));
    const products = await tx.select().from(t.products).where(inArray(t.products.id, input.lines.map((l) => l.productId)));
    const byId = new Map(products.map((p) => [p.id, p]));
    // Karat restriction (D-4-1): a supplier piece is sellable stock.
    for (const l of input.lines) {
      const product = byId.get(l.productId);
      if (!product) throw notFound('Product');
      await assertSellableKarat(ctx, product.karat);
    }
    // CAT-0: deactivated products and types receive no new stock.
    await assertProductsUsable(tx, [...byId.keys()]);
    const [supplier] = await tx.select({ id: t.suppliers.id }).from(t.suppliers).where(eq(t.suppliers.id, input.supplierId!));
    if (!supplier) throw notFound('Supplier');
    // SUP-1 (D-sup-1, D-sup-2): a supplier allows one open order at a time, so a new order while gold is still owed to
    // the same supplier (in any branch: a supplier belongs to the company) asks the General Manager first. Refused until
    // confirmed ("record anyway"), never blocked; the confirmation is audited. Weights, the order number and days only.
    let openDebt: { pureMg24: number; orders: number; oldestNumber: string; days: number } | null = null;
    const [debt] = await supplierGoldOwed(tx, { branchId: null, supplierId: input.supplierId! });
    if (debt) {
      openDebt = { pureMg24: debt.pureMg24, orders: debt.orders, oldestNumber: debt.oldestNumber, days: daysOpen(debt.oldestAt, at) };
      if (!input.confirmOpenSupplierDebt) {
        throw new AppError(
          409,
          'SUPPLIER_GOLD_OWED',
          'We still owe this supplier {weight} g of 24K from order {number}, open for {days} days. Record the new order anyway?',
          { weight: (debt.pureMg24 / 1000).toFixed(3), number: debt.oldestNumber, days: openDebt.days },
          { ...openDebt, oldestPurchaseId: debt.oldestPurchaseId },
        );
      }
    }
    // MKC-1 (Q4, as FIX-2 for sales): one transfer pays one order of one supplier, so the same reference on another order
    // (any branch: the transfers all come from the owner's one personal account) is probably a typing mistake. It is
    // refused until the General Manager confirms ("record anyway"); never blocked, and the confirmation is audited.
    let duplicateOf: string | null = null;
    if (transfer.reference) {
      const [dup] = await tx
        .select({ number: t.purchases.number })
        .from(t.purchases)
        .where(eq(t.purchases.makingChargeReference, transfer.reference))
        .orderBy(desc(t.purchases.id))
        .limit(1);
      if (dup && !input.confirmDuplicateReference) {
        throw new AppError(409, 'DUPLICATE_BANK_REFERENCE', 'This transfer reference is already on supplier order {number}. Record it anyway?', { number: dup.number }, { number: dup.number, reference: transfer.reference });
      }
      duplicateOf = dup?.number ?? null;
    }
    const number = await nextNumber(tx, branch.code, 'PO');
    const totalCost = input.lines.reduce((s, l) => s + l.purchaseCost + l.makingCost + l.otherCost, 0);
    // The gold debt: one pureGoldMg rounding per piece (the system's single conversion, D-2a-6).
    const goldDebt = sumInt(input.lines.map((l) => pureGoldMg(l.netWeightMg, byId.get(l.productId)!.karat)));
    const makingChargePaid = sumInt(input.lines.map((l) => l.makingCost));
    const [purchase] = await tx
      .insert(t.purchases)
      .values({
        number,
        branchId,
        supplierId: input.supplierId ?? null,
        supplierInvoiceNo: input.supplierInvoiceNo ?? null,
        itemCount: input.lines.length,
        totalNetWeightMg: input.lines.reduce((s, l) => s + l.netWeightMg, 0),
        totalCost,
        goldDebtMgPure24: goldDebt,
        goldOwedMgPure24: goldDebt,
        makingChargePaid,
        makingChargePaidFrom: payer,
        makingChargeReference: transfer.reference,
        makingChargeTransferDate: transfer.transferDate,
        notes: input.notes ?? null,
        createdBy: actor.userId,
        createdAt: at,
      })
      .returning();
    const ref = { refType: 'purchase', refId: purchase.id, refNumber: number };
    // MKC-1: no ledger entry. The owner's personal transfer moves no branch money (D-mkc-1).
    const codes: string[] = [];
    for (const l of input.lines) {
      const product = byId.get(l.productId);
      if (!product) throw notFound('Product');
      const { code, barcode } = await nextItemCode(tx);
      codes.push(code);
      const [item] = await tx
        .insert(t.jewelryItems)
        .values({
          code,
          barcode,
          productId: product.id,
          karat: product.karat,
          grossWeightMg: l.grossWeightMg,
          netWeightMg: l.netWeightMg,
          // Cost model (Q3): a supplier piece's acquisition cost includes the making charge,
          // which is also kept on its own for reporting.
          origin: 'SUPPLIER_NEW',
          acquisitionCost: l.purchaseCost + l.makingCost + l.otherCost,
          makingCharge: l.makingCost,
          costIsEstimated: false,
          supplierId: input.supplierId ?? null,
          supplierInvoiceRef: input.supplierInvoiceNo ?? null,
          sellingPrice: l.sellingPrice,
          branchId,
          status: 'AVAILABLE',
          purchaseId: purchase.id,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      await tx.insert(t.purchaseItems).values({ purchaseId: purchase.id, itemId: item.id, purchaseCost: l.purchaseCost, makingCost: l.makingCost, otherCost: l.otherCost });
      // Lifecycle: PURCHASED → RECEIVED → AVAILABLE
      await tx.insert(t.itemStatusHistory).values([
        { itemId: item.id, fromStatus: null, toStatus: 'PURCHASED', branchId, ...ref, userId: actor.userId, at, note: branch.name },
        { itemId: item.id, fromStatus: 'PURCHASED', toStatus: 'RECEIVED', branchId, ...ref, userId: actor.userId, at },
        { itemId: item.id, fromStatus: 'RECEIVED', toStatus: 'AVAILABLE', branchId, ...ref, userId: actor.userId, at },
      ]);
      await recordMovement(tx, { item, type: 'PURCHASE', branchId, ref, userId: actor.userId, at });
    }
    await writeAudit(tx, actor, {
      action: 'PURCHASE_CREATED',
      entityType: 'purchase',
      entityId: number,
      branchId,
      at,
      key: 'Purchase {number}: {n} item(s) received, cost {cost}',
      params: { number, n: input.lines.length, cost: ap.money(totalCost) },
      metadata: { items: codes, makingChargePaidBy: payer, makingChargeReference: transfer.reference, makingChargeTransferDate: transfer.transferDate, ...(duplicateOf ? { duplicateReferenceOf: duplicateOf } : {}), ...(openDebt ? { openSupplierDebtConfirmed: openDebt } : {}) },
    });
    const result = { ...purchase, itemCodes: codes };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

interface PurchaseQuery {
  branchId?: number;
  from?: string;
  to?: string;
  q?: string;
}

async function purchasesWhere(ctx: Ctx, actor: Actor, q: PurchaseQuery): Promise<SQL[]> {
  requirePerm(actor, 'purchases.view');
  const scope = branchScope(actor, q.branchId);
  const where: SQL[] = [];
  if (scope != null) where.push(eq(t.purchases.branchId, scope));
  if (q.from && q.to) {
    const { company } = await ctx.settings.get();
    const r = dayRange(q.from, q.to, company.timezone);
    where.push(gte(t.purchases.createdAt, r.start), lt(t.purchases.createdAt, r.end));
  }
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(or(ilike(t.purchases.number, s), ilike(t.suppliers.name, s), ilike(t.suppliers.nameAr, s), ilike(t.purchases.supplierInvoiceNo, s))!);
  }
  return where;
}

const purchaseListFrom = (db: Ctx['db']) =>
  db
    .select({
      id: t.purchases.id,
      number: t.purchases.number,
      createdAt: t.purchases.createdAt,
      branchId: t.purchases.branchId,
      branchName: t.branches.name,
      supplierName: nameOrAr(t.suppliers.name, t.suppliers.nameAr),
      supplierNameAr: t.suppliers.nameAr,
      supplierInvoiceNo: t.purchases.supplierInvoiceNo,
      itemCount: t.purchases.itemCount,
      totalNetWeightMg: t.purchases.totalNetWeightMg,
      totalCost: t.purchases.totalCost,
      // MKC-1: the owner's transfer reference (COST: the General Manager only, the response filter strips it otherwise).
      makingChargeReference: t.purchases.makingChargeReference,
      createdByName: t.users.fullName,
      status: t.purchases.status,
    })
    .from(t.purchases)
    .innerJoin(t.branches, eq(t.branches.id, t.purchases.branchId))
    .innerJoin(t.users, eq(t.users.id, t.purchases.createdBy))
    .leftJoin(t.suppliers, eq(t.suppliers.id, t.purchases.supplierId));

/** The purchases report's rows on screen: newest first, at most `cap` (RPT-2: the report says when it is cut). */
export async function listPurchases(ctx: Ctx, actor: Actor, q: PurchaseQuery, cap: number) {
  const where = await purchasesWhere(ctx, actor, q);
  return purchaseListFrom(ctx.db)
    .where(where.length ? and(...where) : undefined)
    // The id breaks ties exactly as the paged CSV walk does (RPT-2).
    .orderBy(desc(t.purchases.createdAt), desc(t.purchases.id))
    .limit(cap);
}

/** RPT-2: the purchases report's count and totals over the WHOLE filtered result (cost for `profit.view` only). */
export async function purchasesReportAggregates(ctx: Ctx, actor: Actor, q: PurchaseQuery) {
  const where = await purchasesWhere(ctx, actor, q);
  const [s] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number), itemCount: sumOf(t.purchases.itemCount), totalNetWeightMg: sumOf(t.purchases.totalNetWeightMg), totalCost: sumOf(t.purchases.totalCost) })
    .from(t.purchases)
    .leftJoin(t.suppliers, eq(t.suppliers.id, t.purchases.supplierId))
    .where(where.length ? and(...where) : undefined);
  const totals: Record<string, number> = { itemCount: s.itemCount, totalNetWeightMg: s.totalNetWeightMg };
  if (can(actor, 'profit.view')) totals.totalCost = s.totalCost;
  return { rowCount: s.n, totals };
}

export const PURCHASE_SORT_KEYS = ['date', 'number', 'branch', 'supplier', 'weight', 'totalCost'] as const;
export type PurchaseSortKey = (typeof PURCHASE_SORT_KEYS)[number];
const purchaseSorts: Record<PurchaseSortKey, SortSpec> = {
  date: { by: t.purchases.createdAt, field: 'createdAt', dir: 'desc' },
  number: { by: t.purchases.number, field: 'number', dir: 'desc' },
  branch: { by: t.branches.name, field: 'branchName', dir: 'asc' },
  supplier: { by: nameOrAr(t.suppliers.name, t.suppliers.nameAr), field: 'supplierName', dir: 'asc' },
  weight: { by: t.purchases.totalNetWeightMg, field: 'totalNetWeightMg', dir: 'desc' },
  // GM only (BE-7).
  totalCost: { by: t.purchases.totalCost, field: 'totalCost', dir: 'desc' },
};

/** BE-7: the purchases list, one page at a time (`GET /purchases`). */
/** `withTotals: false`: no footer sums (the report's CSV walk reads rows only; RPT-2). */
export async function pagePurchases(ctx: Ctx, actor: Actor, q: PurchaseQuery & PageRequest<PurchaseSortKey>, opts: { withTotals?: boolean } = {}) {
  const where = await purchasesWhere(ctx, actor, q);
  return runPaged(actor, q, {
    sorts: purchaseSorts,
    defaultSort: 'date',
    id: t.purchases.id,
    where,
    maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.purchases.id) }).from(t.purchases))[0].m),
    count: async (w) =>
      Number(
        (await ctx.db.select({ n: sql<number>`count(*)` }).from(t.purchases).leftJoin(t.suppliers, eq(t.suppliers.id, t.purchases.supplierId)).where(w))[0].n,
      ),
    rows: ({ where: w, orderBy, limit, offset }) => purchaseListFrom(ctx.db).where(w).orderBy(...orderBy).limit(limit).offset(offset),
    totals: opts.withTotals === false ? undefined : async (w) => {
      const [s] = await ctx.db
        .select({ itemCount: sumOf(t.purchases.itemCount), totalNetWeightMg: sumOf(t.purchases.totalNetWeightMg), totalCost: sumOf(t.purchases.totalCost) })
        .from(t.purchases)
        .leftJoin(t.suppliers, eq(t.suppliers.id, t.purchases.supplierId))
        .where(w);
      return can(actor, 'profit.view') ? s : { itemCount: s.itemCount, totalNetWeightMg: s.totalNetWeightMg };
    },
  });
}

export async function getPurchase(ctx: Ctx, actor: Actor, id: number) {
  requirePerm(actor, 'purchases.view');
  const [p] = await ctx.db
    .select({ p: t.purchases, branchName: t.branches.name, supplierName: nameOrAr(t.suppliers.name, t.suppliers.nameAr), supplierNameAr: t.suppliers.nameAr, createdByName: t.users.fullName })
    .from(t.purchases)
    .innerJoin(t.branches, eq(t.branches.id, t.purchases.branchId))
    .innerJoin(t.users, eq(t.users.id, t.purchases.createdBy))
    .leftJoin(t.suppliers, eq(t.suppliers.id, t.purchases.supplierId))
    .where(eq(t.purchases.id, id));
  if (!p) throw notFound('Purchase');
  branchScope(actor, p.p.branchId);
  const items = await ctx.db
    .select({
      itemId: t.jewelryItems.id,
      code: t.jewelryItems.code,
      productName: nameOrAr(t.products.name, t.products.nameAr),
      productNameAr: t.products.nameAr,
      karat: t.jewelryItems.karat,
      netWeightMg: t.jewelryItems.netWeightMg,
      purchaseCost: t.purchaseItems.purchaseCost,
      makingCost: t.purchaseItems.makingCost,
      otherCost: t.purchaseItems.otherCost,
      sellingPrice: t.jewelryItems.sellingPrice,
      status: t.jewelryItems.status,
    })
    .from(t.purchaseItems)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.purchaseItems.itemId))
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .where(eq(t.purchaseItems.purchaseId, id));
  const settlements = await settlementsFor(ctx, id);
  return { ...p.p, branchName: p.branchName, supplierName: p.supplierName, supplierNameAr: p.supplierNameAr, createdByName: p.createdByName, items, settlements };
}


/**
 * SUP-1 (D-sup-1): the gold still owed to one supplier, across every branch, for the warning on the purchase form
 * (General Manager only: the only role that records orders). Weights, the oldest order and its age only, never money.
 */
export async function supplierOpenDebt(ctx: Ctx, actor: Actor, supplierId: number) {
  requirePerm(actor, 'purchases.create');
  const [s] = await ctx.db.select({ id: t.suppliers.id }).from(t.suppliers).where(eq(t.suppliers.id, supplierId));
  if (!s) throw notFound('Supplier');
  const [debt] = await supplierGoldOwed(ctx.db, { branchId: null, supplierId });
  if (!debt) return { supplierId, pureMg24: 0, orders: 0, oldestNumber: null, oldestPurchaseId: null, days: null };
  return { supplierId, pureMg24: debt.pureMg24, orders: debt.orders, oldestNumber: debt.oldestNumber, oldestPurchaseId: debt.oldestPurchaseId, days: daysOpen(debt.oldestAt) };
}
