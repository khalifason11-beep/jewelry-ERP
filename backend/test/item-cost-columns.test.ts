// REM-5 step 1: before the deprecated item cost columns (purchase_cost, making_cost, other_cost, total_cost) are
// dropped, prove that nothing is lost. For every piece, of every origin, the stored columns must equal what the
// code now derives: total = acquisition_cost; the breakdown from the supplier line (purchase_items), or for a piece
// without one (counter scrap) the acquisition cost alone.
// OPENING: no code creates such a piece today (no opening import yet, OPN-1); the static check below fails the day
// one does, and migration 0016 refuses to drop the columns while any piece of any origin differs.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@jerp/database';
import { ITEM_ORIGINS } from '@jerp/shared';
import { createContext } from '../src/bootstrap';
import type { Ctx } from '../src/core/context';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
});
afterAll(async () => handle?.close());

const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

describe('deprecated item cost columns carry nothing that is not kept elsewhere', () => {
  it('for every origin: total_cost = acquisition_cost and the breakdown equals the supplier line (or the acquisition cost)', async () => {
    const rows = rowsOf<{ origin: string; n: number; total_diff: number; breakdown_diff: number }>(
      await ctx.db.execute(sql`
        SELECT i.origin, count(*)::int AS n,
               count(*) FILTER (WHERE i.total_cost <> i.acquisition_cost)::int AS total_diff,
               count(*) FILTER (WHERE i.purchase_cost <> coalesce(pi.purchase_cost, i.acquisition_cost)
                                   OR i.making_cost <> coalesce(pi.making_cost, 0)
                                   OR i.other_cost <> coalesce(pi.other_cost, 0))::int AS breakdown_diff
        FROM jewelry_items i LEFT JOIN purchase_items pi ON pi.item_id = i.id
        GROUP BY i.origin ORDER BY i.origin`),
    );
    const by = Object.fromEntries(rows.map((r) => [r.origin, r]));
    for (const origin of ITEM_ORIGINS) {
      const r = by[origin] ?? { n: 0, total_diff: 0, breakdown_diff: 0 };
      expect({ origin, total_diff: Number(r.total_diff), breakdown_diff: Number(r.breakdown_diff) }).toEqual({ origin, total_diff: 0, breakdown_diff: 0 });
    }
    // Both origins that exist today are really exercised.
    expect(Number(by.SUPPLIER_NEW?.n)).toBeGreaterThan(100);
    expect(Number(by.SCRAP?.n)).toBeGreaterThan(0);
  });

  it('no product code creates an OPENING piece yet (so no OPENING piece can differ)', () => {
    const root = path.resolve(__dirname, '../src');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && /origin:\s*'OPENING'/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(hits, 'a writer of OPENING pieces exists: extend this test and the 0016 guard before dropping the columns').toEqual([]);
  });
});
