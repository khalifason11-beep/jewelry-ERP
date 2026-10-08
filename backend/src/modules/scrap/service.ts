// Scrap gold (Phase 4, decisions D-4-*).
//
//   * Scrap BUYING rates per karat, set by the GM (any karat: not limited by allowed karats).
//   * Counter scrap purchase from a customer, in ONE transaction:
//       SELLABLE → a jewelry item (origin SCRAP, karat must be one this deployment sells)
//       BROKEN   → + weight in the branch's broken-scrap pool (any karat), never an item
//     and in both cases the money paid to the customer leaves CASH or BANK (ledger).
//     The agreed price may deviate from today's scrap rate within `purchases.scrapPriceTolerancePct`;
//     beyond it, `purchases.requireGmApprovalForScrapOverride` makes it a GM-only decision.
//   * The broken-scrap pool: append-only `scrap_weight_entries`; balance per branch and karat =
//     SUM(weight_mg), never cached. Its 24K equivalent uses the ONE pure-gold helper (pureGoldMg).

import { and, asc, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { assertProductsUsable } from '../catalog/service';
import { t, type Executor } from '@jerp/database';
import { ap, divRound, pureGoldMg, sumInt, valueOfWeight, type ScrapKind, type ScrapPaymentMethod, type ScrapWeightEventType } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { assertSellableKarat } from '../../core/karats';
import { nextItemCode, nextNumber } from '../../core/numbering';
import { rows } from '../../core/sql';
import { dayRange } from '../../core/time';
import type { TxIdempotency } from '../../core/idempotency';
import { recordMovement } from '../inventory/ledger';
import { post } from '../ledger/service';

// ───────────────────────── scrap buying rates ─────────────────────────

/** Latest scrap buying rate per karat. */
export async function scrapRates(exec: Executor): Promise<Record<number, { pricePerGram: number; effectiveAt: Date }>> {
  const all = await exec.select().from(t.scrapRates).orderBy(asc(t.scrapRates.karat), desc(t.scrapRates.effectiveAt), desc(t.scrapRates.id));
  const out: Record<number, { pricePerGram: number; effectiveAt: Date }> = {};
  for (const r of all) if (!out[r.karat]) out[r.karat] = { pricePerGram: r.pricePerGram, effectiveAt: r.effectiveAt };
  return out;
}

/** Today's scrap buying rates and the deviation rules, for the scrap purchase screen and Settings. */
export async function scrapRatesView(ctx: Ctx, actor: Actor) {
  requireAny(actor, 'scrap.buy', 'settings.manage');
  const rates = await scrapRates(ctx.db);
  const { purchases: p } = await ctx.settings.get();
  return {
    rates: Object.entries(rates).map(([karat, r]) => ({ karat: Number(karat), pricePerGram: r.pricePerGram, effectiveAt: r.effectiveAt })),
    tolerancePct: p.scrapPriceTolerancePct,
    requireGmApproval: p.requireGmApprovalForScrapOverride,
  };
}

export async function setScrapRates(ctx: Ctx, actor: Actor, rates: Record<number, number>) {
  requirePerm(actor, 'settings.manage');
  return ctx.db.transaction(async (tx) => {
    const before = await scrapRates(tx);
    for (const [k, v] of Object.entries(rates)) {
      const karat = Number(k);
      if (before[karat]?.pricePerGram === v) continue;
      await tx.insert(t.scrapRates).values({ karat, pricePerGram: v, setBy: actor.userId });
      await writeAudit(tx, actor, {
        action: 'SCRAP_RATE_CHANGED',
        entityType: 'scrap_rate',
        entityId: `${karat}K`,
        key: '{karat} scrap buying rate {from} → {to} per gram',
        params: { karat: ap.karat(karat), from: ap.money(before[karat]?.pricePerGram ?? 0), to: ap.money(v) },
      });
    }
    return scrapRates(tx);
  });
}

// ───────────────────────── the broken-scrap weight pool ─────────────────────────

/**
 * Serialise every change of one branch's pool (transaction-scoped advisory lock): a purchase and
 * two settlements running at once can never take the pool below zero.
 */
export async function lockPool(tx: Executor, branchId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(7461, ${branchId})`);
}

export interface WeightLine {
  branchId: number;
  karat: number;
  /** Signed mg, never 0. */
  weightMg: number;
  eventType: ScrapWeightEventType;
  ref: { refType: string; refId: number; refNumber?: string | null };
  note?: string | null;
  at?: Date;
}

/** Append one movement of the pool (inside the business transaction). */
export async function postWeight(tx: Executor, l: WeightLine, by: { actor: Pick<Actor, 'userId' | 'sessionId'> | null; idempotencyKey?: string | null }) {
  if (!Number.isSafeInteger(l.weightMg) || l.weightMg === 0) throw new RangeError(`pool movement must be a non-zero whole number of mg, got ${l.weightMg}`);
  await tx.insert(t.scrapWeightEntries).values({
    branchId: l.branchId,
    karat: l.karat,
    weightMg: l.weightMg,
    eventType: l.eventType,
    refType: l.ref.refType,
    refId: l.ref.refId,
    refNumber: l.ref.refNumber ?? null,
    actorId: by.actor?.userId ?? null,
    sessionId: by.actor?.sessionId ?? null,
    idempotencyKey: by.idempotencyKey ?? null,
    note: l.note ?? null,
    at: l.at ?? new Date(),
  });
}

/** Pool balance per branch and karat = SUM(weight_mg). Optionally one branch / one karat. */
export async function poolBalances(exec: Executor, branchId: number | null, karat?: number) {
  const res = await exec.execute(sql`
    SELECT branch_id AS "branchId", karat, sum(weight_mg)::bigint AS "weightMg"
    FROM scrap_weight_entries
    WHERE true ${branchId != null ? sql`AND branch_id = ${branchId}` : sql``} ${karat != null ? sql`AND karat = ${karat}` : sql``}
    GROUP BY branch_id, karat
    HAVING sum(weight_mg) <> 0
    ORDER BY branch_id, karat`);
  return rows<{ branchId: number; karat: number; weightMg: number | string }>(res).map((r) => ({ branchId: Number(r.branchId), karat: Number(r.karat), weightMg: Number(r.weightMg) }));
}

/** Raw weight by karat and the 24K equivalent (one pureGoldMg rounding per karat balance). */
export function summarisePool(lines: { karat: number; weightMg: number }[]) {
  const byKarat = lines.map((l) => ({ karat: l.karat, weightMg: l.weightMg, pureMg24: pureGoldMg(l.weightMg, l.karat) }));
  return { byKarat, weightMg: sumInt(byKarat.map((x) => x.weightMg)), pureMg24: sumInt(byKarat.map((x) => x.pureMg24)) };
}

export async function poolView(ctx: Ctx, actor: Actor, q: { branchId?: number }) {
  requireAny(actor, 'inventory.view', 'scrap.buy');
  const scope = branchScope(actor, q.branchId);
  const balances = await poolBalances(ctx.db, scope);
  const branchRows = await ctx.db.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches);
  const ids = scope != null ? [scope] : branchRows.map((b) => b.id);
  const branches = ids.map((id) => {
    const b = branchRows.find((x) => x.id === id)!;
    return { branchId: id, branchCode: b.code, branchName: b.name, branchNameAr: b.nameAr, ...summarisePool(balances.filter((x) => x.branchId === id)) };
  });
  return { branches, ...summarisePool(mergeByKarat(balances)) };
}

function mergeByKarat(lines: { karat: number; weightMg: number }[]) {
  const m = new Map<number, number>();
  for (const l of lines) m.set(l.karat, (m.get(l.karat) ?? 0) + l.weightMg);
  return [...m].sort((a, b) => a[0] - b[0]).map(([karat, weightMg]) => ({ karat, weightMg }));
}

// ───────────────────────── counter scrap purchase ─────────────────────────

export interface ScrapPurchaseInput {
  branchId?: number;
  kind: ScrapKind;
  karat: number;
  grossWeightMg: number;
  netWeightMg: number;
  /** Price per gram agreed with the customer (defaults to today's scrap rate). */
  agreedRatePerGram?: number;
  paymentMethod: ScrapPaymentMethod;
  /** SELLABLE only: the model the piece is filed under, and its selling price. */
  productId?: number;
  sellingPrice?: number;
  customerName?: string;
  customerPhone?: string;
  customerIdRef?: string;
  note?: string;
}

export async function buyScrap(ctx: Ctx, actor: Actor, input: ScrapPurchaseInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'scrap.buy');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  if (input.netWeightMg <= 0 || input.grossWeightMg < input.netWeightMg) throw badRequest('Gross weight must be ≥ net weight > 0');
  if (input.karat < 1 || input.karat > 24 || !Number.isInteger(input.karat)) throw badRequest('Invalid value for {field}', { field: 'karat' });
  if (input.kind === 'SELLABLE') {
    // Sellable stock must be a karat this deployment sells (D-4-1); other karats are bought as broken scrap.
    await assertSellableKarat(ctx, input.karat);
    if (!input.productId || !input.sellingPrice || input.sellingPrice <= 0) throw badRequest('A sellable piece needs a product and a selling price');
  }
  const settings = await ctx.settings.get();
  const at = opts.at ?? new Date();

  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const rate = (await scrapRates(tx))[input.karat]?.pricePerGram ?? 0;
    if (rate <= 0) throw badRequest('No scrap buying rate is set for {karat}K', { karat: input.karat });
    const agreed = input.agreedRatePerGram ?? rate;
    if (!Number.isSafeInteger(agreed) || agreed <= 0) throw badRequest('Invalid value for {field}', { field: 'agreedRatePerGram' });
    const deviationBp = divRound(Math.abs(agreed - rate) * 10_000, rate);
    const toleranceBp = Math.round(settings.purchases.scrapPriceTolerancePct * 100);
    const beyond = deviationBp > toleranceBp;
    if (beyond && settings.purchases.requireGmApprovalForScrapOverride && !can(actor, 'scrap.override')) {
      throw forbidden('This price is {pct}% away from today’s scrap rate; beyond {tolerance}% it needs General Manager approval', {
        pct: (deviationBp / 100).toFixed(2),
        tolerance: settings.purchases.scrapPriceTolerancePct,
      });
    }
    const amount = valueOfWeight(input.netWeightMg, agreed);
    if (amount <= 0) throw badRequest('Invalid value for {field}', { field: 'netWeightMg' });
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, branchId));
    const number = await nextNumber(tx, branch.code, 'SCR');

    let itemId: number | null = null;
    let itemCode: string | null = null;
    if (input.kind === 'SELLABLE') {
      const [product] = await tx.select().from(t.products).where(eq(t.products.id, input.productId!));
      if (!product) throw notFound('Product');
      if (product.karat !== input.karat) throw badRequest('The product is {pkarat}K but the piece is {karat}K', { pkarat: product.karat, karat: input.karat });
      // CAT-0: deactivated products and types receive no new stock.
      await assertProductsUsable(tx, [product.id]);
      const { code, barcode } = await nextItemCode(tx);
      const [item] = await tx
        .insert(t.jewelryItems)
        .values({
          code,
          barcode,
          productId: product.id,
          karat: product.karat,
          grossWeightMg: input.grossWeightMg,
          netWeightMg: input.netWeightMg,
          origin: 'SCRAP',
          acquisitionCost: amount,
          makingCharge: 0,
          costIsEstimated: false,
          sellingPrice: input.sellingPrice!,
          branchId,
          status: 'AVAILABLE',
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      itemId = item.id;
      itemCode = item.code;
    }

    const [row] = await tx
      .insert(t.scrapPurchases)
      .values({
        number,
        branchId,
        kind: input.kind,
        karat: input.karat,
        grossWeightMg: input.grossWeightMg,
        netWeightMg: input.netWeightMg,
        scrapRatePerGram: rate,
        agreedRatePerGram: agreed,
        deviationBp,
        overrideApproved: beyond,
        amount,
        paymentMethod: input.paymentMethod,
        itemId,
        customerName: input.customerName?.trim() || null,
        customerPhone: input.customerPhone?.trim() || null,
        customerIdRef: input.customerIdRef?.trim() || null,
        note: input.note?.trim() || null,
        createdBy: actor.userId,
        createdAt: at,
      })
      .returning();
    const ref = { refType: 'scrap_purchase', refId: row.id, refNumber: number };
    const by = { actor, idempotencyKey: opts.idem?.key };

    if (itemId != null) {
      const [item] = await tx.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, itemId));
      await tx.insert(t.itemStatusHistory).values([
        { itemId, fromStatus: null, toStatus: 'PURCHASED', branchId, ...ref, userId: actor.userId, at, note: 'Scrap bought from a customer' },
        { itemId, fromStatus: 'PURCHASED', toStatus: 'RECEIVED', branchId, ...ref, userId: actor.userId, at },
        { itemId, fromStatus: 'RECEIVED', toStatus: 'AVAILABLE', branchId, ...ref, userId: actor.userId, at },
      ]);
      await recordMovement(tx, { item, type: 'PURCHASE', branchId, ref, userId: actor.userId, at });
    } else {
      await lockPool(tx, branchId);
      await postWeight(tx, { branchId, karat: input.karat, weightMg: input.netWeightMg, eventType: 'SCRAP_PURCHASE', ref, at }, by);
    }

    // The money paid to the customer leaves the drawer or the bank.
    await post(
      tx,
      [{ branchId, kind: input.paymentMethod === 'CASH' ? 'CASH' : 'BANK', amount: -amount, eventType: 'SCRAP_PURCHASE', paymentMethod: input.paymentMethod, ref, at }],
      by,
    );
    await writeAudit(tx, actor, {
      action: 'SCRAP_PURCHASED',
      entityType: 'scrap_purchase',
      entityId: number,
      branchId,
      at,
      key:
        input.kind === 'SELLABLE'
          ? 'Scrap {number}: sellable piece {code} bought ({weight}, {karat}) for {amount} ({payment})'
          : 'Scrap {number}: broken scrap bought ({weight}, {karat}) for {amount} ({payment}); added to the scrap pool',
      params: { number, code: itemCode ?? '', weight: ap.mg(input.netWeightMg), karat: ap.karat(input.karat), amount: ap.money(amount), payment: ap.enum(input.paymentMethod) },
      metadata: { kind: input.kind, scrapRatePerGram: rate, agreedRatePerGram: agreed, deviationBp, overrideApproved: beyond },
    });
    const result = { ...row, itemCode };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

export async function listScrapPurchases(ctx: Ctx, actor: Actor, q: { branchId?: number; from?: string; to?: string; kind?: ScrapKind }) {
  requireAny(actor, 'scrap.buy', 'purchases.view');
  const scope = branchScope(actor, q.branchId);
  const where: SQL[] = [];
  if (scope != null) where.push(eq(t.scrapPurchases.branchId, scope));
  if (q.kind) where.push(eq(t.scrapPurchases.kind, q.kind));
  if (q.from && q.to) {
    const { company } = await ctx.settings.get();
    const r = dayRange(q.from, q.to, company.timezone);
    where.push(gte(t.scrapPurchases.createdAt, r.start), lt(t.scrapPurchases.createdAt, r.end));
  }
  return ctx.db
    .select({
      id: t.scrapPurchases.id,
      number: t.scrapPurchases.number,
      branchId: t.scrapPurchases.branchId,
      branchName: t.branches.name,
      kind: t.scrapPurchases.kind,
      karat: t.scrapPurchases.karat,
      netWeightMg: t.scrapPurchases.netWeightMg,
      scrapRatePerGram: t.scrapPurchases.scrapRatePerGram,
      agreedRatePerGram: t.scrapPurchases.agreedRatePerGram,
      deviationBp: t.scrapPurchases.deviationBp,
      overrideApproved: t.scrapPurchases.overrideApproved,
      amount: t.scrapPurchases.amount,
      paymentMethod: t.scrapPurchases.paymentMethod,
      itemId: t.scrapPurchases.itemId,
      customerName: t.scrapPurchases.customerName,
      createdAt: t.scrapPurchases.createdAt,
      createdByName: t.users.fullName,
    })
    .from(t.scrapPurchases)
    .innerJoin(t.branches, eq(t.branches.id, t.scrapPurchases.branchId))
    .innerJoin(t.users, eq(t.users.id, t.scrapPurchases.createdBy))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(t.scrapPurchases.createdAt), desc(t.scrapPurchases.id))
    .limit(500);
}
