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

import { asc, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { assertProductsUsable } from '../catalog/service';
import { t, type Executor } from '@jerp/database';
import { ap, divRound, pureGoldMg, sumInt, validBankReference, valueOfWeight, type ScrapKind, type ScrapPaymentMethod, type ScrapWeightEventType } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { checkRateChanges, confirmPasswordIfGiven, guardAudit, type RateGuardInput } from '../pricing/rate-guard';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { maxIdOf, runPaged, type PageRequest, type SortSpec } from '../../core/paging';
import { assertSellableKarat } from '../../core/karats';
import { nextItemCode, nextNumber } from '../../core/numbering';
import { rows } from '../../core/sql';
import { dayRange } from '../../core/time';
import type { TxIdempotency } from '../../core/idempotency';
import { recordMovement } from '../inventory/ledger';
import { lockDrawerFor, post } from '../ledger/service';

// ───────────────────────── scrap buying rates ─────────────────────────

/** Latest scrap buying rate per karat. */
export async function scrapRates(exec: Executor): Promise<Record<number, { pricePerGram: number; effectiveAt: Date }>> {
  const all = await exec.select().from(t.scrapRates).orderBy(asc(t.scrapRates.karat), desc(t.scrapRates.effectiveAt), desc(t.scrapRates.id));
  const out: Record<number, { pricePerGram: number; effectiveAt: Date }> = {};
  for (const r of all) if (!out[r.karat]) out[r.karat] = { pricePerGram: r.pricePerGram, effectiveAt: r.effectiveAt };
  return out;
}

/** Today's scrap buying rates and the deviation rules, for the scrap purchase screen and Settings. */
export async function scrapRatesView(ctx: Ctx, actor: Actor, historyLimit = 60) {
  requireAny(actor, 'scrap.buy', 'scrap.buy_sellable', 'settings.manage');
  const rates = await scrapRates(ctx.db);
  const { purchases: p } = await ctx.settings.get();
  // PRC-1 (D-prc1-9): the Prices page shows every change with who and when (append-only rows; the General Manager only).
  const history = can(actor, 'settings.manage')
    ? await ctx.db
        .select({
          id: t.scrapRates.id,
          karat: t.scrapRates.karat,
          pricePerGram: t.scrapRates.pricePerGram,
          effectiveAt: t.scrapRates.effectiveAt,
          setBy: sql<string | null>`(select full_name from users u where u.id = ${t.scrapRates.setBy})`,
        })
        .from(t.scrapRates)
        .orderBy(desc(t.scrapRates.effectiveAt), desc(t.scrapRates.id))
        .limit(historyLimit)
    : [];
  return {
    rates: Object.entries(rates).map(([karat, r]) => ({ karat: Number(karat), pricePerGram: r.pricePerGram, effectiveAt: r.effectiveAt })),
    history,
    tolerancePct: p.scrapPriceTolerancePct,
    requireGmApproval: p.requireGmApprovalForScrapOverride,
  };
}

/** pg advisory lock key that serialises scrap-rate edits (DEC-1: the guard compares with the current previous rate). */
const SCRAP_RATES_LOCK = 0x53435252; // "SCRR"

export async function setScrapRates(ctx: Ctx, actor: Actor, rates: Record<number, number>, guard: RateGuardInput = {}) {
  requirePerm(actor, 'settings.manage');
  // DEC-1 (RAT-1): a password given with the request is checked first, like a re-confirmation.
  const confirmed = await confirmPasswordIfGiven(ctx, actor, guard);
  return ctx.db.transaction(async (tx) => {
    // scrap_rates is append-only (no FOR UPDATE for the runtime role): an advisory lock serialises the edits instead.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCRAP_RATES_LOCK})`);
    const before = await scrapRates(tx);
    const real = Object.entries(rates)
      .map(([k, v]) => ({ karat: Number(k), kind: 'SCRAP', from: before[Number(k)]?.pricePerGram ?? null, to: v }))
      .filter((c) => c.from !== c.to);
    const checked = checkRateChanges((await ctx.settings.get()).rates, real, guard, confirmed);
    for (const c of checked) {
      const g = guardAudit(c, guard);
      await tx.insert(t.scrapRates).values({ karat: c.karat, pricePerGram: c.to, setBy: actor.userId });
      await writeAudit(tx, actor, {
        action: 'SCRAP_RATE_CHANGED',
        entityType: 'scrap_rate',
        entityId: `${c.karat}K`,
        key: g.guarded ? '{karat} scrap buying rate {from} → {to} per gram ({change}%): {reason}' : '{karat} scrap buying rate {from} → {to} per gram',
        params: { karat: ap.karat(c.karat), from: ap.money(c.from ?? 0), to: ap.money(c.to), ...(g.guarded ? { change: g.change, reason: g.reason } : {}) },
        metadata: { from: c.from ?? 0, to: c.to, ...g.metadata },
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
  /**
   * How the customer is paid (CSH-2 piece A, D-csh-7). Either the two parts, which must add up to the amount exactly
   * (cash from the drawer + bank transfer), or `paymentMethod` CASH / BANK_TRANSFER = the whole amount that way.
   */
  cashAmount?: number;
  bankAmount?: number;
  paymentMethod?: Exclude<ScrapPaymentMethod, 'SPLIT'>;
  /** The bank's reference of the transfer to the customer; required when the bank part is > 0 (FIX-2 rules). */
  bankReference?: string;
  /**
   * SELLABLE only: the model the piece is filed under, and (FIXED_TAG only) its tag price. PRC-1: with computed prices
   * the piece is priced from the used-piece rate and no price is sent (refused if sent).
   */
  productId?: number;
  sellingPrice?: number;
  customerName?: string;
  customerPhone?: string;
  customerIdRef?: string;
  note?: string;
}

export async function buyScrap(ctx: Ctx, actor: Actor, input: ScrapPurchaseInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  // PRC-1 (D-prc1-6): broken scrap needs scrap.buy; a sellable piece scrap.buy or scrap.buy_sellable (the cashier).
  if (input.kind === 'BROKEN') requirePerm(actor, 'scrap.buy');
  else requireAny(actor, 'scrap.buy', 'scrap.buy_sellable');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  if (input.netWeightMg <= 0 || input.grossWeightMg < input.netWeightMg) throw badRequest('Gross weight must be ≥ net weight > 0');
  if (input.karat < 1 || input.karat > 24 || !Number.isInteger(input.karat)) throw badRequest('Invalid value for {field}', { field: 'karat' });
  if (input.kind === 'SELLABLE') {
    // Sellable stock must be a karat this deployment sells (D-4-1); other karats are bought as broken scrap.
    await assertSellableKarat(ctx, input.karat);
  }
  const settings = await ctx.settings.get();
  if (input.kind === 'SELLABLE') {
    if (!input.productId) throw badRequest('A sellable piece needs a product');
    // PRC-1 (D-prc1-8): computed prices: nobody types a price (one sent is refused, never silently dropped).
    if (settings.pricing.mode === 'RATE_COMPUTED') {
      if (input.sellingPrice != null) throw badRequest('Selling prices follow the rates: do not send one');
    } else if (!input.sellingPrice || input.sellingPrice <= 0) throw badRequest('A sellable piece needs a product and a selling price');
  } else if (input.sellingPrice != null || input.productId != null) {
    throw badRequest('Broken scrap has no product and no selling price');
  }
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
    const pay = paymentParts(input, amount);
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
          // PRC-1: 0 = no tag price (computed prices); the live price comes from the used-piece rate.
          sellingPrice: input.sellingPrice ?? 0,
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
        paymentMethod: pay.label,
        cashAmount: pay.cash,
        bankAmount: pay.bank,
        bankReference: pay.reference,
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

    // The money paid to the customer leaves the drawer (cash part) and the bank (bank part); a part of 0 posts nothing.
    // CSH-2 (Q7): the drawer must hold the cash part (BLOCK, under its lock); the bank part is never blocked (A17 warns).
    await lockDrawerFor(tx, branchId, pay.cash, 'SCRAP_PURCHASE');
    await post(
      tx,
      [
        { branchId, kind: 'CASH', amount: -pay.cash, eventType: 'SCRAP_PURCHASE', paymentMethod: 'CASH', ref, at },
        { branchId, kind: 'BANK', amount: -pay.bank, eventType: 'SCRAP_PURCHASE', paymentMethod: 'BANK_TRANSFER', ref, at },
      ],
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
      params: { number, code: itemCode ?? '', weight: ap.mg(input.netWeightMg), karat: ap.karat(input.karat), amount: ap.money(amount), payment: ap.enum(pay.label) },
      metadata: { kind: input.kind, scrapRatePerGram: rate, agreedRatePerGram: agreed, deviationBp, overrideApproved: beyond, cashAmount: pay.cash, bankAmount: pay.bank, bankReference: pay.reference },
    });
    const result = { ...row, itemCode };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/**
 * The two payment parts of a scrap purchase and their label (D-csh-7): both whole SDG and ≥ 0, adding up to the
 * amount exactly; a bank part needs the bank's reference (normalized, 4–40, FIX-2). `paymentMethod` alone means the
 * whole amount that way. The label is CASH, BANK_TRANSFER or SPLIT, from the parts.
 */
export function paymentParts(input: Pick<ScrapPurchaseInput, 'cashAmount' | 'bankAmount' | 'paymentMethod' | 'bankReference'>, amount: number) {
  const explicit = input.cashAmount != null || input.bankAmount != null;
  if (explicit && input.paymentMethod) throw badRequest('Give either the payment method or the cash and bank parts, not both');
  const cash = explicit ? (input.cashAmount ?? 0) : input.paymentMethod === 'CASH' ? amount : 0;
  const bank = explicit ? (input.bankAmount ?? 0) : input.paymentMethod === 'BANK_TRANSFER' ? amount : 0;
  if (!explicit && !input.paymentMethod) throw badRequest('Say how the customer is paid');
  if (!Number.isSafeInteger(cash) || !Number.isSafeInteger(bank) || cash < 0 || bank < 0) throw badRequest('Invalid value for {field}', { field: 'cashAmount' });
  if (cash + bank !== amount) {
    throw badRequest('The cash and bank parts must add up to the amount paid ({amount}); they add up to {sum}', { amount: amount.toLocaleString('en-US'), sum: (cash + bank).toLocaleString('en-US') });
  }
  let reference: string | null = null;
  if (bank > 0) {
    reference = validBankReference(input.bankReference);
    if (!reference) throw badRequest('Enter the bank transfer reference (4 to 40 letters or digits)');
  }
  const label: ScrapPaymentMethod = cash > 0 && bank > 0 ? 'SPLIT' : bank > 0 ? 'BANK_TRANSFER' : 'CASH';
  return { cash, bank, reference, label };
}

export const SCRAP_SORT_KEYS = ['date', 'number', 'branch', 'weight', 'amount'] as const;
export type ScrapSortKey = (typeof SCRAP_SORT_KEYS)[number];
const scrapSorts: Record<ScrapSortKey, SortSpec> = {
  date: { by: t.scrapPurchases.createdAt, field: 'createdAt', dir: 'desc' },
  number: { by: t.scrapPurchases.number, field: 'number', dir: 'desc' },
  branch: { by: t.branches.name, field: 'branchName', dir: 'asc' },
  weight: { by: t.scrapPurchases.netWeightMg, field: 'netWeightMg', dir: 'desc' },
  amount: { by: t.scrapPurchases.amount, field: 'amount', dir: 'desc' },
};

/** BE-7: the scrap purchases list, one page at a time (`GET /scrap-purchases`). */
export async function listScrapPurchases(
  ctx: Ctx,
  actor: Actor,
  q: { branchId?: number; from?: string; to?: string; kind?: ScrapKind; q?: string } & PageRequest<ScrapSortKey>,
) {
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
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(or(ilike(t.scrapPurchases.number, s), ilike(t.scrapPurchases.customerName, s))!);
  }
  return runPaged(actor, q, {
    sorts: scrapSorts,
    defaultSort: 'date',
    id: t.scrapPurchases.id,
    where,
    maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.scrapPurchases.id) }).from(t.scrapPurchases))[0].m),
    count: async (w) => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.scrapPurchases).where(w))[0].n),
    rows: ({ where: w, orderBy, limit, offset }) =>
      ctx.db
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
          cashAmount: t.scrapPurchases.cashAmount,
          bankAmount: t.scrapPurchases.bankAmount,
          bankReference: t.scrapPurchases.bankReference,
          itemId: t.scrapPurchases.itemId,
          customerName: t.scrapPurchases.customerName,
          createdAt: t.scrapPurchases.createdAt,
          createdByName: t.users.fullName,
        })
        .from(t.scrapPurchases)
        .innerJoin(t.branches, eq(t.branches.id, t.scrapPurchases.branchId))
        .innerJoin(t.users, eq(t.users.id, t.scrapPurchases.createdBy))
        .where(w)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
  });
}
