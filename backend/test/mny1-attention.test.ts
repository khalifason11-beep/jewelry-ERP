// MNY-1 attention (both projects), with a fixed clock: the transfers are sent at T and the list is read at a given
// instant (never the wall clock).
//   * A18 "waiting for you to confirm": the receiving branch manager (one line per branch, with the count); the
//     General Manager for a transfer addressed to him, on his company view only; never the sender;
//   * A19 "waiting more than the setting's hours" (`transfers.pendingClaimStaleHours`, reused, D-mny1-3): 23:59 later
//     no, 24:01 later yes; to the receiving branch manager and the General Manager, never the sender; it replaces A18;
//   * a confirmed or cancelled transfer leaves the list; no line carries the amount.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../src/bootstrap';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { recordAdvance } from '../src/modules/funding/service';
import { attentionFor, type Signal } from '../src/modules/attention/service';
import { cancelMoneyTransfer, confirmMoneyTransfer, sendMoneyTransfer } from '../src/modules/money-transfers/service';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

const T = new Date('2026-10-12T09:00:00Z');
const later = (h: number, m = 0) => new Date(T.getTime() + h * 3_600_000 + m * 60_000);

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let krt: Actor;
let omd: Actor;
let bhr: Actor;
let br: Record<string, number>;
const actorOf = async (username: string) => (await loadActor(ctx.db, (await ctx.db.select().from(t.users).where(eq(t.users.username, username)))[0].id, null))!;
const mny = async (who: Actor, now: Date, q: { branchId?: number } = {}) =>
  (await attentionFor(ctx, who, q, { now })).signals.filter((s) => s.code === 'A18' || s.code === 'A19');
const ids = (s: Signal[]) => s.map((x) => x.id).sort();

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, T);
  [gm, krt, omd, bhr] = [await actorOf('general.manager'), await actorOf('branch.manager.kh'), await actorOf('branch.manager.omd'), await actorOf('branch.manager.bhr')];
  br = Object.fromEntries((await ctx.db.select().from(t.branches)).map((b) => [b.code, b.id]));
  await recordAdvance(ctx, gm, { branchId: br.KRT, account: 'CASH', amount: 1_000_000, reason: 'test: fund the drawer' }, { at: T });
});
afterAll(async () => handle?.close());

describe('A18 and A19 (money transfers waiting)', () => {
  it('who sees what, before and after the setting’s hours; a confirm or a cancel clears it', async () => {
    const send = (to: { branchId: number } | { generalManager: true }, amount: number) =>
      sendMoneyTransfer(ctx, krt, { to, account: 'CASH', amount, reason: 'attention test' }, { at: T });
    const a = await send({ branchId: br.OMD }, 10_000);
    const b = await send({ branchId: br.OMD }, 20_000);
    const g = await send({ generalManager: true }, 30_000);

    // 23:59 later: A18 only.
    const early = later(23, 59);
    expect(ids(await mny(omd, early))).toEqual([`A18:${br.OMD}`]);
    expect((await mny(omd, early))[0]).toMatchObject({ severity: 'info', count: 2, link: '/money-transfers', branchId: br.OMD });
    expect(ids(await mny(gm, early))).toEqual(['A18:GM']);
    expect(ids(await mny(gm, early, { branchId: br.KRT }))).toEqual([]); // his own line is on the company view only
    expect(ids(await mny(krt, early))).toEqual([]); // the sender: nothing to confirm
    expect(ids(await mny(bhr, early))).toEqual([]);

    // 24:01 later: A19 per transfer, to the receiving branch manager and the General Manager; no more A18.
    const late = later(24, 1);
    expect(ids(await mny(omd, late))).toEqual([`A19:${a.id}`, `A19:${b.id}`]);
    expect(ids(await mny(gm, late))).toEqual([`A19:${a.id}`, `A19:${b.id}`, `A19:${g.id}`]);
    expect(ids(await mny(gm, late, { branchId: br.OMD }))).toEqual([`A19:${a.id}`, `A19:${b.id}`]);
    expect(ids(await mny(krt, late))).toEqual([]);
    const a19 = (await mny(gm, late)).find((s) => s.id === `A19:${a.id}`)!;
    expect(a19).toMatchObject({ severity: 'warning', link: '/money-transfers', params: { number: a.number, hours: 24, toGm: 0 } });
    expect((await mny(gm, late)).find((s) => s.id === `A19:${g.id}`)!.params).toMatchObject({ toGm: 1, toBranch: null });
    // Never the amount (it is on Money transfers).
    for (const s of [...(await mny(gm, early)), ...(await mny(gm, late)), ...(await mny(omd, early))]) {
      expect(Object.keys(s.params).some((k) => /amount|money|cost|price/i.test(k)), JSON.stringify(s.params)).toBe(false);
    }

    // The setting moves the line (the same setting as the late piece transfers, A2).
    await ctx.settings.update(ctx.db, { transfers: { pendingClaimStaleHours: 48 } }, null);
    expect(ids(await mny(omd, late))).toEqual([`A18:${br.OMD}`]);
    await ctx.settings.update(ctx.db, { transfers: { pendingClaimStaleHours: 24 } }, null);

    // Confirmed, cancelled: gone.
    await confirmMoneyTransfer(ctx, omd, a.id, { account: 'CASH' }, { at: later(25) });
    await cancelMoneyTransfer(ctx, krt, b.id, { reason: 'attention test over' }, { at: later(25) });
    await confirmMoneyTransfer(ctx, gm, g.id, {}, { at: later(25) });
    expect(ids(await mny(gm, later(26)))).toEqual([]);
    expect(ids(await mny(omd, later(26)))).toEqual([]);
  });
});
