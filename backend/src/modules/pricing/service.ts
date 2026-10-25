// PRC-1 (docs/plans/PRC-1.md, D-prc1-*): the selling rates and the computed price of a piece.
//
//   * two selling rates per karat in the append-only `gold_rates` history: NEW and USED; the latest row per karat and
//     kind is current; any karat of `inventory.allowedKarats`. OPN-2: the piece's `rate_kind` says which one prices it
//     (a supplier piece NEW, a sellable scrap piece USED, an opening piece its line's condition);
//   * `pricing.mode` RATE_COMPUTED prices a piece live: round(net mg × rate / (1000 × step)) × step (shared/pricing.ts);
//     FIXED_TAG reads the stored tag price. A missing rate, or a tag price ≤ 0, is NO price (never 0);
//   * a rate change takes the pricing lock exclusively; a sale confirmation takes it shared before reading the rates,
//     so a sale is priced either entirely before or entirely after a rate change (D-prc1-5).

import { sql, type SQL } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { ap, computedPrice, GOLD_RATE_KINDS, type GoldRateKind, type PricingSettingMode } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest } from '../../core/errors';
import { rows } from '../../core/sql';
import { checkRateChanges, confirmPasswordIfGiven, guardAudit, type RateGuardInput } from './rate-guard';

/** pg advisory lock key of the pricing lock (an arbitrary constant, unique in this application). */
const PRICING_LOCK = 0x50524331; // "PRC1"

export interface Pricing {
  mode: PricingSettingMode;
  step: number;
  /**
   * The current selling rates read once for this request (RATE_COMPUTED). The SQL price then uses them as constants
   * instead of looking up the latest rate row by row (a list over every available piece, its totals and a deep page:
   * PRC-1 perf). Without it, the SQL reads the rates itself (a correlated sub-query).
   */
  rates?: Map<string, CurrentRate>;
}

/** The pricing settings, and in RATE_COMPUTED the current rates, for one request's lists, totals and reports. */
export async function pricingOf(ctx: Ctx): Promise<Pricing> {
  const { pricing } = await ctx.settings.get();
  const p: Pricing = { mode: pricing.mode, step: pricing.roundingStep };
  if (p.mode === 'RATE_COMPUTED') p.rates = await currentSellingRates(ctx.db);
  return p;
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
export function priceOf(p: Pricing, rates: Map<string, CurrentRate>, item: { karat: number; rateKind: string; netWeightMg: number; sellingPrice: number; code?: string }): PricedPiece {
  if (p.mode === 'FIXED_TAG') return { sellingPrice: item.sellingPrice > 0 ? item.sellingPrice : null, pricePerGram: null, rateKind: null };
  // OPN-2 (D-opn2-1): the piece says which rate prices it (set when it was created); never guessed from anything else.
  if (item.rateKind !== 'NEW' && item.rateKind !== 'USED') throw new Error(`piece ${item.code ?? '?'} has no rate kind`);
  const kind: GoldRateKind = item.rateKind;
  const rate = rates.get(rateKey(item.karat, kind))?.pricePerGram ?? null;
  return { sellingPrice: computedPrice(item.netWeightMg, rate, p.step), pricePerGram: rate, rateKind: kind };
}

// ── SQL mirrors, for lists, sorting, totals and reports (one row of jewelry_items in scope) ──

/**
 * The current rate per gram of the piece's karat and kind (NULL when none): from the request's rate snapshot as a
 * constant CASE on karat and origin, else as a correlated sub-query on `gold_rates`.
 */
export function liveRateSql(p: Pricing): SQL<number | null> {
  if (p.mode === 'FIXED_TAG') return sql<number | null>`NULL::bigint`;
  if (p.rates) return rateCaseSql(p.rates).mapWith(nullableNumber);
  return sql<number | null>`(
    SELECT CASE WHEN gr.price_per_gram > 0 THEN gr.price_per_gram END FROM gold_rates gr
    WHERE gr.karat = ${t.jewelryItems.karat}
      AND gr.kind = ${t.jewelryItems.rateKind}
    ORDER BY gr.effective_at DESC, gr.id DESC LIMIT 1)`.mapWith(nullableNumber);
}

/**
 * The live price of the piece: FIXED_TAG → the stored tag price; RATE_COMPUTED →
 * round(mg × rate / (1000 × step)) × step (numeric round: half away from zero, like money.ts), NULL without a rate.
 */
export function livePriceSql(p: Pricing): SQL<number | null> {
  // FIXED_TAG: the stored tag price, exactly as before PRC-1 (lists, sorting and sums unchanged).
  if (p.mode === 'FIXED_TAG') return sql<number | null>`${t.jewelryItems.sellingPrice}`.mapWith(nullableNumber);
  // Integer constants from a validated setting (1…1,000,000), written into the statement so the division is numeric.
  const step = sql.raw(String(Math.trunc(p.step)));
  const den = sql.raw(String(1000 * Math.trunc(p.step)));
  // The latest row of the karat and kind is the current rate (as currentSellingRates); a rate ≤ 0 is no rate.
  return sql<number | null>`(
    SELECT CASE WHEN cur.rate > 0 THEN (round(${t.jewelryItems.netWeightMg}::numeric * cur.rate / ${den}) * ${step})::bigint END
    FROM (SELECT ${liveRateSql(p)}) AS cur(rate))`.mapWith(nullableNumber);
}

/** An integer read from the database or a validated setting, written into the statement (never user text). */
const intLiteral = (n: number) => {
  if (!Number.isSafeInteger(n)) throw new Error(`not an integer: ${n}`);
  return sql.raw(String(n));
};

/** CASE karat/kind → rate, from a rate snapshot; NULL for a karat and kind without a rate. */
function rateCaseSql(rates: Map<string, CurrentRate>): SQL<number | null> {
  const arms = [...rates.values()].map(
    (r) => sql`WHEN ${t.jewelryItems.karat} = ${intLiteral(r.karat)} AND ${t.jewelryItems.rateKind} = ${sql.raw(r.kind === 'USED' ? "'USED'" : "'NEW'")} THEN ${intLiteral(r.pricePerGram)}::bigint`,
  );
  if (!arms.length) return sql<number | null>`NULL::bigint`;
  return sql<number | null>`(CASE ${sql.join(arms, sql` `)} END)`;
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
  /** DEC-1 (RAT-1): a change above warn % needs a reason, above confirm % the password too. */
  guard: { warnChangePercent: number; confirmChangePercent: number };
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
    guard: { warnChangePercent: settings.rates.warnChangePercent, confirmChangePercent: settings.rates.confirmChangePercent },
  };
}

/**
 * Set selling rates (General Manager, re-authenticated by the route). Any karat in `inventory.allowedKarats`; only real
 * changes are written (one append-only row and one audit entry each).
 */
export async function setSellingRates(ctx: Ctx, actor: Actor, input: Partial<Record<GoldRateKind, Record<string, number>>>, guard: RateGuardInput = {}) {
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
  // DEC-1 (RAT-1): a password given with the request is checked first, like a re-confirmation.
  const confirmed = await confirmPasswordIfGiven(ctx, actor, guard);
  await ctx.db.transaction(async (tx) => {
    // The exclusive pricing lock serialises rate edits: the previous value below is the current one, never stale.
    await lockPricingExclusive(tx);
    const before = await currentSellingRates(tx);
    const real = changes
      .map((c) => ({ karat: c.karat, kind: c.kind, from: before.get(rateKey(c.karat, c.kind))?.pricePerGram ?? null, to: c.price }))
      .filter((c) => c.from !== c.to);
    const checked = checkRateChanges((await ctx.settings.get()).rates, real, guard, confirmed);
    for (const c of checked) {
      const kind = c.kind as GoldRateKind;
      const from = c.from ?? 0;
      const g = guardAudit(c, guard);
      await tx.insert(t.goldRates).values({ karat: c.karat, kind, pricePerGram: c.to, setBy: actor.userId });
      await writeAudit(tx, actor, {
        action: 'GOLD_RATE_CHANGED',
        entityType: 'gold_rate',
        entityId: kind === 'NEW' ? `${c.karat}K` : `${c.karat}K-USED`,
        branchId: null,
        key: g.guarded
          ? kind === 'NEW'
            ? '{karat} gold rate {from} → {to} per gram ({change}%): {reason}'
            : '{karat} used-piece selling rate {from} → {to} per gram ({change}%): {reason}'
          : kind === 'NEW'
            ? '{karat} gold rate {from} → {to} per gram'
            : '{karat} used-piece selling rate {from} → {to} per gram',
        params: { karat: ap.karat(c.karat), from: ap.money(from), to: ap.money(c.to), ...(g.guarded ? { change: g.change, reason: g.reason } : {}) },
        metadata: { kind, from, to: c.to, ...g.metadata },
      });
    }
  });
  return sellingRatesView(ctx);
}
