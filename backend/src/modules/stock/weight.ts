// Branch total stock weight (Phase 4, D-4-3): the gold a branch holds is its sellable pieces
// (AVAILABLE + RESERVED, the same definition as the inventory KPIs) PLUS its broken-scrap pool.
// Reported as raw weight by karat and as the 24K pure-gold equivalent. Both parts use the ONE
// pure-gold helper (pureGoldMg), rounded once per karat balance; nothing is cached.

import { sql } from 'drizzle-orm';
import type { Executor } from '@jerp/database';
import { sumInt } from '@jerp/shared';
import { rows } from '../../core/sql';
import { poolBalances, summarisePool } from '../scrap/service';

export interface StockWeight {
  items: ReturnType<typeof summarisePool>;
  brokenScrap: ReturnType<typeof summarisePool>;
  /** Raw weight of everything held, all karats together. */
  totalWeightMg: number;
  /** 24K equivalent of everything held. */
  totalPureMg24: number;
}

function combine(items: { karat: number; weightMg: number }[], scrap: { karat: number; weightMg: number }[]): StockWeight {
  const i = summarisePool(items);
  const b = summarisePool(scrap);
  return { items: i, brokenScrap: b, totalWeightMg: i.weightMg + b.weightMg, totalPureMg24: i.pureMg24 + b.pureMg24 };
}

async function itemBalances(exec: Executor, branchId: number | null) {
  const res = await exec.execute(sql`
    SELECT branch_id AS "branchId", karat, coalesce(sum(net_weight_mg), 0)::bigint AS "weightMg"
    FROM jewelry_items
    WHERE status IN ('AVAILABLE', 'RESERVED') ${branchId != null ? sql`AND branch_id = ${branchId}` : sql``}
    GROUP BY branch_id, karat
    ORDER BY branch_id, karat`);
  return rows<{ branchId: number; karat: number; weightMg: number | string }>(res).map((r) => ({ branchId: Number(r.branchId), karat: Number(r.karat), weightMg: Number(r.weightMg) }));
}

/** Stock weight per branch (only branches that hold something) and for all of them together. */
export async function stockWeight(exec: Executor, branchId: number | null): Promise<{ byBranch: Map<number, StockWeight>; total: StockWeight }> {
  const [items, scrap] = await Promise.all([itemBalances(exec, branchId), poolBalances(exec, branchId)]);
  const ids = [...new Set([...items, ...scrap].map((x) => x.branchId))].sort((a, b) => a - b);
  const byBranch = new Map(ids.map((id) => [id, combine(items.filter((x) => x.branchId === id), scrap.filter((x) => x.branchId === id))]));
  return { byBranch, total: combine(mergeKarats(items), mergeKarats(scrap)) };
}

export const emptyStockWeight = (): StockWeight => combine([], []);

function mergeKarats(lines: { karat: number; weightMg: number }[]) {
  const m = new Map<number, number>();
  for (const l of lines) m.set(l.karat, (m.get(l.karat) ?? 0) + l.weightMg);
  return [...m].sort((a, b) => a[0] - b[0]).map(([karat, weightMg]) => ({ karat, weightMg }));
}

/** Rows "branch × karat" for the stock weight report. */
export function stockWeightRows(byBranch: Map<number, StockWeight>) {
  const out: { branchId: number; karat: number; itemsWeightMg: number; brokenScrapWeightMg: number; totalWeightMg: number; totalPureMg24: number }[] = [];
  for (const [branchId, s] of byBranch) {
    const karats = [...new Set([...s.items.byKarat, ...s.brokenScrap.byKarat].map((x) => x.karat))].sort((a, b) => a - b);
    for (const karat of karats) {
      const it = s.items.byKarat.find((x) => x.karat === karat);
      const sc = s.brokenScrap.byKarat.find((x) => x.karat === karat);
      out.push({
        branchId,
        karat,
        itemsWeightMg: it?.weightMg ?? 0,
        brokenScrapWeightMg: sc?.weightMg ?? 0,
        totalWeightMg: (it?.weightMg ?? 0) + (sc?.weightMg ?? 0),
        totalPureMg24: sumInt([it?.pureMg24 ?? 0, sc?.pureMg24 ?? 0]),
      });
    }
  }
  return out;
}
