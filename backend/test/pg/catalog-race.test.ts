// Real PostgreSQL only (CAT-0): two people creating the same item type, product or supplier at the
// same moment, typed with different spellings. The unique indexes on the normalized names decide:
// exactly one row is created, every other request is refused with "already exists" and names it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { normalizeName } from '@jerp/shared';
import { createContext } from '../../src/bootstrap';
import type { Actor, Ctx } from '../../src/core/context';
import { loadActor } from '../../src/modules/sessions/service';
import { createCategory, createProduct, createSupplier } from '../../src/modules/catalog/service';
import { seedDemo } from '../../src/seed/demo';
import { openTestDatabase, PG_MODE } from '../helpers';

const ROUNDS = 4;
const PARALLEL = 6;
let handle: DatabaseHandle;
let ctx: Ctx;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const winners = <T>(rs: PromiseSettledResult<T>[]) => rs.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled');
const reasons = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.key ?? r.reason?.message ?? r.reason));
const tatweel = String.fromCodePoint(0x0640);
const zwnj = String.fromCodePoint(0x200c);
/** The same name typed six different ways. */
const spellings = (base: string) => [base, base.replace('ا', 'أ'), ` ${base} `, base.replace('ل', `ل${tatweel}`), base.replace('س', `س${zwnj}`), base.replace(/1/g, '١')].slice(0, PARALLEL);

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  expect(handle.driver).toBe('postgres');
  ctx = createContext(handle);
  await seedDemo(ctx);
});
afterAll(async () => handle?.close());

describe('parallel creation of the same name (unique normalized indexes)', () => {
  it('item types: one row, every other request refused as a duplicate', async () => {
    const bm = await actorOf('branch.manager.kh');
    const gm = await actorOf('general.manager');
    for (let round = 0; round < ROUNDS; round++) {
      const base = `اسلسل ${round}1`;
      const rs = await Promise.allSettled(spellings(base).map((nameAr, i) => createCategory(ctx, i % 2 ? gm : bm, { nameAr })));
      expect(winners(rs)).toHaveLength(1);
      expect(reasons(rs)).toEqual(Array(PARALLEL - 1).fill('This type already exists: {name}'));
      const rows = (await ctx.db.select().from(t.categories)).filter((c) => normalizeName(c.nameAr) === normalizeName(base));
      expect(rows).toHaveLength(1);
    }
  });

  it('products (same name, karat and type): one row', async () => {
    const bm = await actorOf('branch.manager.kh');
    const [cat] = await ctx.db.select().from(t.categories).where(eq(t.categories.isActive, true)).limit(1);
    for (let round = 0; round < ROUNDS; round++) {
      const base = `اسوار ملكي ${round}1`;
      const rs = await Promise.allSettled(spellings(base).map((nameAr) => createProduct(ctx, bm, { nameAr, karat: 21, categoryId: cat.id })));
      expect(winners(rs)).toHaveLength(1);
      expect(reasons(rs)).toEqual(Array(PARALLEL - 1).fill('This product already exists: {name}'));
      const rows = (await ctx.db.select().from(t.products)).filter((p) => normalizeName(p.nameAr) === normalizeName(base) && p.categoryId === cat.id);
      expect(rows).toHaveLength(1);
    }
  });

  it('suppliers: one row', async () => {
    const bm = await actorOf('branch.manager.kh');
    for (let round = 0; round < ROUNDS; round++) {
      const base = `مصنع السلام ${round}1`;
      const rs = await Promise.allSettled(spellings(base).map((nameAr) => createSupplier(ctx, bm, { nameAr })));
      expect(winners(rs)).toHaveLength(1);
      expect(reasons(rs)).toEqual(Array(PARALLEL - 1).fill('This supplier already exists: {name}'));
      const rows = (await ctx.db.select().from(t.suppliers)).filter((s) => normalizeName(s.nameAr ?? s.name ?? '') === normalizeName(base));
      expect(rows).toHaveLength(1);
    }
  });
});
