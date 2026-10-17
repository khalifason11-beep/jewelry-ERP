// PRC-1 (docs/plans/PRC-1.md, D-prc1-*): the selling rates and the computed price of a piece.
//
//   * two selling rates per karat in the append-only `gold_rates` history: NEW (supplier and opening pieces) and USED
//     (sellable scrap); the latest row per karat and kind is current; any karat of `inventory.allowedKarats`;
//   * `pricing.mode` RATE_COMPUTED prices a piece live: round(net mg × rate / (1000 × step)) × step (shared/pricing.ts);
//     FIXED_TAG reads the stored tag price. A missing rate, or a tag price ≤ 0, is NO price (never 0);
//   * a rate change takes the pricing lock exclusively; a sale confirmation takes it shared before reading the rates,
//     so a sale is priced either entirely before or entirely after a rate change (D-prc1-5).

import { sql, type SQL } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { ap, computedPrice, GOLD_RATE_KINDS, rateKindFor, type GoldRateKind, type PricingSettingMode } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest } from '../../core/errors';
import { rows } from '../../core/sql';

/** pg advisory lock key of the pricing lock (an arbitrary constant, unique in this application). */
const PRICING_LOCK = 0x50524331; // "PRC1"

export interface Pricing {
  mode: PricingSettingMode;
  step: number;
}

export async function pricingOf(ctx: Ctx): Promise<Pricing> {
  const { pricing } = await ctx.settings.get();
  return { mode: pricing.mode, step: pricing.roundingStep };
}

export interface CurrentRate {
  karat: number;
  kind: GoldRateKind;
  pricePerGram: number;
  effectiveAt: Date;
}

/** The current selling rate of every karat and kind that has one (rates ≤ 0 are not usable and are left out). */
export async function currentSellingRates(exec: Executor): Promise<Map<string, CurrentRate>> {
  const r = rows<{ karat: number; kind: GoldRateKind; price_per_gram: string | number; effective_at: string | Date }>(
    await exec.execute(sql`
      SELECT DISTINCT ON (karat, kind) karat, kind, price_per_gram, effective_at
      FROM gold_rates ORDER BY karat, kind, effective_at DESC, id DESC`),
  );
  const out = new Map<string, CurrentRate>();
  for (const x of r) {
    const price = Number(x.price_per_gram);
    if (price > 0) out.set(rateKey(Number(x.karat), x.kind), { karat: Number(x.karat), kind: x.kind, pricePerGram: price, effectiveAt: new Date(x.effective_at) });
  }
  return out;
}

export const rateKey = (karat: number, kind: GoldRateKind) => `${karat}:${kind}`;

export interface PricedPiece {
  /** The price the piece sells at now, or null when it has none (missing rate, or no tag price). */
  sellingPrice: number | null;
  /** The rate per gram that priced it (RATE_COMPUTED), else null. */
  pricePerGram: number | null;
  rateKind: GoldRateKind | null;
}

/** The live price of one piece (same result as `livePriceSql`). */
export function priceOf(p: Pricing, rates: Map<string, CurrentRate>, item: { karat: number; origin: string; netWeightMg: number; sellingPrice: number }): PricedPiece {
  if (p.mode === 'FIXED_TAG') return { sellingPrice: item.sellingPrice > 0 ? item.sellingPrice : null, pricePerGram: null, rateKind: null };
  const kind = rateKindFor(item.origin);
  const rate = rates.get(rateKey(item.karat, kind))?.pricePerGram ?? null;
  return { sellingPrice: computedPrice(item.netWeightMg, rate, p.step), pricePerGram: rate, rateKind: kind };
}

// ── SQL mirrors, for lists, sorting, totals and reports (one row of jewelry_items in scope) ──

/** The current rate per gram of the piece's karat and kind (NULL when none), as a correlated sub-query. */
export function liveRateSql(p: Pricing): SQL<number | null> {
  if (p.mode === 'FIXED_TAG') return sql<number | null>`NULL::bigint`;
  return sql<number | null>`(
    SELECT gr.price_per_gram FROM gold_rates gr
    WHERE gr.karat = ${t.jewelryItems.karat}
      AND gr.kind = CASE WHEN ${t.jewelryItems.origin} = 'SCRAP' THEN 'USED' ELSE 'NEW' END
    ORDER BY gr.effective_at DESC, gr.id DESC LIMIT 1)`;
}

/**
 * The live price of the piece: FIXED_TAG → the tag price (NULL when ≤ 0); RATE_COMPUTED →
 * round(mg × rate / (1000 × step)) × step (numeric round: half away from zero, like money.ts), NULL without a rate.
 */
export function livePriceSql(p: Pricing): SQL<number | null> {
  if (p.mode === 'FIXED_TAG') return sql<number | null>`nullif(greatest(${t.jewelryItems.sellingPrice}, 0), 0)`.mapWith(nullableNumber);
  // Integer constants from a validated setting (1…1,000,000), written into the statement so the division is numeric.
  const step = sql.raw(String(Math.trunc(p.step)));
  const den = sql.raw(String(1000 * Math.trunc(p.step)));
  // The latest row of the karat and kind is the current rate (as currentSellingRates); a rate ≤ 0 is no rate.
  return sql<number | null>`(
    SELECT CASE WHEN cur.rate > 0 THEN (round(${t.jewelryItems.netWeightMg}::numeric * cur.rate / ${den}) * ${step})::bigint END
    FROM (${liveRateSql(p)}) AS cur(rate))`.mapWith(nullableNumber);
}

const nullableNumber = (v: unknown) => (v == null ? null : Number(v));

// ── the pricing lock (D-prc1-5) ──

/** Taken by a rate change: waits for every sale being confirmed, and sales wait for it. */
export async function lockPricingExclusive(tx: Executor) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRICING_LOCK})`);
}
/** Taken by a sale confirmation before it reads the rates. Sales do not wait for each other. */
export async function lockPricingShared(tx: Executor) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${PRICING_LOCK})`);
}

// ── the rates screen and the rate change ──

export interface SellingRatesView {
  /** NEW rate per allowed karat (the top bar's rate, as before PRC-1); 0 = not set. */
  current: Record<number, { pricePerGram: number; effectiveAt: Date }>;
  /** USED rate per allowed karat; 0 = not set. */
  used: Record<number, { pricePerGram: number; effectiveAt: Date }>;
  history: { id: number; karat: number; kind: GoldRateKind; pricePerGram: number; effectiveAt: Date; setBy: string | null }[];
  pricing: { mode: PricingSettingMode; roundingStep: number };
  allowedKarats: number[];
}

export async function sellingRatesView(ctx: Ctx, limit = 60): Promise<SellingRatesView> {
  const settings = await ctx.settings.get();
  const rates = await currentSellingRates(ctx.db);
  const byKind = (kind: GoldRateKind) => {
    const out: Record<number, { pricePerGram: number; effectiveAt: Date }> = {};
    for (const k of settings.inventory.allowedKarats) {
      const r = rates.get(rateKey(k, kind));
      out[k] = r ? { pricePerGram: r.pricePerGram, effectiveAt: r.effectiveAt } : { pricePerGram: 0, effectiveAt: new Date(0) };
    }
    return out;
  };
  const history = await ctx.db
    .select({
      id: t.goldRates.id,
      karat: t.goldRates.karat,
      kind: t.goldRates.kind,
      pricePerGram: t.goldRates.pricePerGram,
      effectiveAt: t.goldRates.effectiveAt,
      setBy: sql<string | null>`(select full_name from users u where u.id = ${t.goldRates.setBy})`,
    })
    .from(t.goldRates)
    .orderBy(sql`${t.goldRates.effectiveAt} DESC, ${t.goldRates.id} DESC`)
    .limit(limit);
  return {
    current: byKind('NEW'),
    used: byKind('USED'),
    history: history.map((h) => ({ ...h, kind: h.kind as GoldRateKind })),
    pricing: { mode: settings.pricing.mode, roundingStep: settings.pricing.roundingStep },
    allowedKarats: settings.inventory.allowedKarats,
  };
}

/**
 * Set selling rates (General Manager, re-authenticated by the route). Any karat in `inventory.allowedKarats`; only real
 * changes are written (one append-only row and one audit entry each).
 */
export async function setSellingRates(ctx: Ctx, actor: Actor, input: Partial<Record<GoldRateKind, Record<string, number>>>) {
  requirePerm(actor, 'settings.manage');
  const { inventory } = await ctx.settings.get();
  const changes: { karat: number; kind: GoldRateKind; price: number }[] = [];
  for (const kind of GOLD_RATE_KINDS) {
    for (const [k, price] of Object.entries(input[kind] ?? {})) {
      const karat = Number(k);
      if (!inventory.allowedKarats.includes(karat)) throw badRequest('Karat {karat} is not in the allowed karats', { karat: k });
      changes.push({ karat, kind, price });
    }
  }
  await ctx.db.transaction(async (tx) => {
    await lockPricingExclusive(tx);
    const before = await currentSellingRates(tx);
    for (const c of changes) {
      const from = before.get(rateKey(c.karat, c.kind))?.pricePerGram ?? 0;
      if (from === c.price) continue;
      await tx.insert(t.goldRates).values({ karat: c.karat, kind: c.kind, pricePerGram: c.price, setBy: actor.userId });
      await writeAudit(tx, actor, {
        action: 'GOLD_RATE_CHANGED',
        entityType: 'gold_rate',
        entityId: c.kind === 'NEW' ? `${c.karat}K` : `${c.karat}K-USED`,
        branchId: null,
        key: c.kind === 'NEW' ? '{karat} gold rate {from} → {to} per gram' : '{karat} used-piece selling rate {from} → {to} per gram',
        params: { karat: ap.karat(c.karat), from: ap.money(from), to: ap.money(c.price) },
        metadata: { kind: c.kind, from, to: c.price },
      });
    }
  });
  return sellingRatesView(ctx);
}

/** The price a piece of this karat and origin would sell at for this weight, or null (for previews and messages). */
export function previewPrice(p: Pricing, rates: Map<string, CurrentRate>, karat: number, origin: string, netWeightMg: number) {
  return priceOf(p, rates, { karat, origin, netWeightMg, sellingPrice: 0 }).sellingPrice;
}
