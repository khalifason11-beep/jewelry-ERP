// Cost, acquisition cost and profit are visible to the General Manager only (decision Q15).
// Services already omit these fields for callers without `profit.view`; this response filter is
// the second, central line of defence: every JSON response to such a caller is stripped of cost
// fields (and of report columns/totals describing them) before it leaves the server.

import type { NextFunction, Request, Response } from 'express';

export const COST_FIELDS = new Set([
  'cost',
  'costs',
  'unitCost',
  'costTotal',
  'costValue',
  'costOfSales',
  'totalCost',
  'purchaseCost',
  'makingCost',
  'otherCost',
  'itemsCost',
  'inventoryCost',
  'purchasesCost',
  'acquisitionCost',
  'grossProfit',
  'profit',
  'margin',
  'contribution',
]);

/** Deep copy without cost fields. Array elements that *describe* a cost column ({ key: 'totalCost' }) are dropped. */
export function stripCostFields(value: unknown, depth = 0): unknown {
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { key?: unknown }).key === 'string' && COST_FIELDS.has((v as { key: string }).key)))
      .map((v) => stripCostFields(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (COST_FIELDS.has(k)) continue;
    out[k] = stripCostFields(v, depth + 1);
  }
  return out;
}

/** Wrap res.json for callers without `profit.view`. */
export function costRedaction(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const actor = req.actor;
    if (!actor || actor.permissions.has('profit.view')) return json(body);
    // Error bodies carry no business data.
    if (body && typeof body === 'object' && 'error' in (body as object)) return json(body);
    return json(stripCostFields(JSON.parse(JSON.stringify(body))));
  };
  next();
}
