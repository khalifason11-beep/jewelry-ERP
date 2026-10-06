// Karat restriction for SELLABLE stock (D-4-1). Which karats a deployment sells is the setting
// `inventory.allowedKarats` (this client: [21]); nothing here hardcodes a karat. Applied wherever a
// sellable item is created or priced and wherever one is sold or delivered: supplier purchases,
// sellable counter scrap, price changes, POS sales and the sell-rate entry.
// It does NOT apply to buying broken scrap from customers (weight pool, any karat).

import type { Ctx } from './context';
import { badRequest } from './errors';

export async function allowedKarats(ctx: Ctx): Promise<number[]> {
  return (await ctx.settings.get()).inventory.allowedKarats;
}

/** Throws a clear 400 when `karat` is not one this deployment sells. */
export async function assertSellableKarat(ctx: Ctx, karat: number): Promise<void> {
  const allowed = await allowedKarats(ctx);
  if (!allowed.includes(karat)) {
    throw badRequest('{karat}K is not sold here: sellable pieces must be {allowed}', { karat, allowed: allowed.map((k) => `${k}K`).join(', ') });
  }
}
