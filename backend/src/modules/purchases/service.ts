import { ap, pureGoldMg, sumInt, type CashOrBank } from '@jerp/shared';
import { and, desc, eq, gte, ilike, inArray, lt, or, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import { nameOrAr } from '../../core/sql';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, notFound } from '../../core/errors';
import { nextItemCode, nextNumber } from '../../core/numbering';
import { dayRange } from '../../core/time';
import { recordMovement } from '../inventory/ledger';
import { assertSellableKarat } from '../../core/karats';
import type { TxIdempotency } from '../../core/idempotency';
import { post } from '../ledger/service';
import { settlementsFor } from '../supplier-settlements/service';
import { assertProductsUsable } from '../catalog/service';

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
  /** Where the making charge is paid from, immediately (D-4-4). Default CASH. */
  makingChargePaidFrom?: CashOrBank;
  lines: PurchaseLine[];
}

/**
 * Receive purchased pieces into a branch: PURCHASED → RECEIVED → AVAILABLE, ledger PURCHASE.
 *
 * Supplier terms (Phase 4, D-4-4): gold for gold. The order owes the supplier the 24K equivalent of
 * the pieces' net weight (gold_owed_mg_pure24, settled later only with broken scrap); the making
 * charge is the only money ever paid to a supplier and is paid now, from the drawer or the bank,
 * in the same transaction. The per-piece money costs stay the General Manager's valuation for
 * profit reporting.
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
  const paidFrom: CashOrBank = input.makingChargePaidFrom ?? 'CASH';
  const at = opts.at ?? new Date();

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
        makingChargePaidFrom: paidFrom,
        notes: input.notes ?? null,
        createdBy: actor.userId,
        createdAt: at,
      })
      .returning();
    const ref = { refType: 'purchase', refId: purchase.id, refNumber: number };
    // The making charge leaves the drawer or the bank now (skipped when it is 0).
    await post(
      tx,
      [{ branchId, kind: paidFrom, amount: -makingChargePaid, eventType: 'SUPPLIER_MAKING_CHARGE', paymentMethod: paidFrom === 'CASH' ? 'CASH' : 'BANK_TRANSFER', ref, at }],
      { actor, idempotencyKey: opts.idem?.key },
    );
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
          purchaseCost: l.purchaseCost,
          makingCost: l.makingCost,
          otherCost: l.otherCost,
          totalCost: l.purchaseCost + l.makingCost + l.otherCost,
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
      metadata: { items: codes },
    });
    const result = { ...purchase, itemCodes: codes };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

export async function listPurchases(ctx: Ctx, actor: Actor, q: { branchId?: number; from?: string; to?: string; q?: string }) {
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
  return ctx.db
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
      createdByName: t.users.fullName,
      status: t.purchases.status,
    })
    .from(t.purchases)
    .innerJoin(t.branches, eq(t.branches.id, t.purchases.branchId))
    .innerJoin(t.users, eq(t.users.id, t.purchases.createdBy))
    .leftJoin(t.suppliers, eq(t.suppliers.id, t.purchases.supplierId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(t.purchases.createdAt))
    .limit(1000);
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

