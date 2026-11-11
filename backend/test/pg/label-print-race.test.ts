// Real PostgreSQL only (LBL-1, D-lbl1-3): two prints of a never-printed piece at the same moment record exactly one
// FIRST and one REPRINT (the piece rows are locked FOR UPDATE; the unique index and the trigger would refuse a second
// FIRST anyway); a batch and a single print overlapping on one piece both land, each recorded once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { printLabels } from '../../src/modules/labels/service';
import { seedWorld } from '../fixtures/world';
import { openTestDatabase, PG_MODE } from '../helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let bm: Actor;
let pieces: { id: number }[];
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : ((r.reason as { code?: string }).code ?? String(r.reason)));

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedWorld(ctx, new Date('2026-11-10T09:00:00Z'));
  const actor = async (username: string) => {
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
    return (await loadActor(ctx.db, u.id, null))!;
  };
  gm = await actor('general.manager');
  bm = await actor('branch.manager.kh');
  const [krt] = await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT'));
  pieces = await ctx.db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, krt.id), eq(t.jewelryItems.status, 'AVAILABLE'))).orderBy(asc(t.jewelryItems.id)).limit(20);
  await ctx.db.transaction((tx) => ctx.settings.apply(tx, { 'print.labelWidthMm': 40, 'print.labelHeightMm': 12 }, { actor: { id: gm.userId, username: 'general.manager' } }));
}, 120_000);
afterAll(async () => handle?.close());

describe('label prints at the same time', () => {
  it('two prints of a never-printed piece: one FIRST, one REPRINT, both recorded', async () => {
    for (let round = 0; round < 6; round++) {
      const p = pieces[round];
      const rs = await Promise.allSettled([
        printLabels(ctx, bm, { pieces: [{ itemId: p.id, copies: 1 }], source: 'PIECE' }),
        printLabels(ctx, gm, { pieces: [{ itemId: p.id, copies: 2 }], source: 'STOCK_LIST' }),
      ]);
      expect(rs.map(codeOf), `round ${round}`).toEqual(['OK', 'OK']);
      const rows = await ctx.db.select().from(t.labelPrints).where(eq(t.labelPrints.itemId, p.id)).orderBy(asc(t.labelPrints.id));
      expect(rows.map((r) => r.kind)).toEqual(['FIRST', 'REPRINT']);
    }
  }, 120_000);

  it('a batch and a single print overlapping on one piece: each piece recorded once per print, one FIRST each', async () => {
    for (let round = 0; round < 4; round++) {
      const [a, b, c] = pieces.slice(8 + round * 3, 11 + round * 3);
      const rs = await Promise.allSettled([
        printLabels(ctx, bm, { pieces: [{ itemId: a.id, copies: 1 }, { itemId: b.id, copies: 1 }], source: 'STOCK_LIST' }),
        printLabels(ctx, gm, { pieces: [{ itemId: b.id, copies: 1 }, { itemId: c.id, copies: 1 }], source: 'STOCK_LIST' }),
      ]);
      expect(rs.map(codeOf), `round ${round}`).toEqual(['OK', 'OK']);
      for (const [p, n] of [[a, 1], [b, 2], [c, 1]] as const) {
        const rows = await ctx.db.select().from(t.labelPrints).where(eq(t.labelPrints.itemId, p.id));
        expect(rows).toHaveLength(n);
        expect(rows.filter((r) => r.kind === 'FIRST')).toHaveLength(1);
      }
    }
  }, 120_000);
});
