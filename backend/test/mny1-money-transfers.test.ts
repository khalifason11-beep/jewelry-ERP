// MNY-1 (plan docs/plans/MNY-1.md, D-mny1-*): the money transfer service. Both projects.
//   * send (the sending branch manager: amount, reason, CASH or BANK with its reference): source −X and the sender's
//     FUNDS_IN_TRANSIT +X; the drawer never below zero (409 DRAWER_SHORT); refused values;
//   * confirm: a branch transfer by the receiving branch manager, landing in the drawer or the bank (+X, transit −X); a
//     transfer to the General Manager by him only (transit −X, an exit); refused for anyone else;
//   * cancel: the sending branch manager with a reason; the send's entries reversed; final states refuse every step;
//   * roles: the General Manager never sends or cancels, never confirms a branch transfer; a branch manager never acts
//     for another branch; OWED_TO_GM never moves; every step is an event row and an audit row;
//   * reads: a branch manager sees only the own branch's transfers; the General Manager every one, a cancelled one
//     with who cancelled it, when and why;
//   * the reconciliation lines (Money sent, received, to the General Manager; a cancel under its send's line);
//   * a branch with money in transit cannot be deactivated;
//   * a property (fast-check): random sends, confirms and cancels over three branches and the General Manager keep
//     Σ CASH + BANK + FUNDS_IN_TRANSIT of all branches equal to its start minus the confirmed transfers to the General
//     Manager; each branch's FUNDS_IN_TRANSIT = Σ of its transfers in transit; no drawer below zero; OWED_TO_GM unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { and, asc, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../src/bootstrap';
import type { Actor, Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { recordAdvance } from '../src/modules/funding/service';
import { balances, reconciliation } from '../src/modules/ledger/service';
import { updateBranch } from '../src/modules/branches/service';
import { cancelMoneyTransfer, confirmMoneyTransfer, getMoneyTransfer, inTransitByBranch, listMoneyTransfers, sendMoneyTransfer } from '../src/modules/money-transfers/service';
import { seedWorld } from './fixtures/world';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let gm: Actor;
let bm: Record<'KRT' | 'OMD' | 'BHR', Actor>;
let cashier: Actor;
let br: Record<'KRT' | 'OMD' | 'BHR' | 'PZU', number>;

const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; key?: string }) => e);
const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const bal = async (branchId: number) => Object.fromEntries((await balances(ctx.db, branchId)).map((b) => [b.kind, b.balance])) as Record<'CASH' | 'BANK' | 'FUNDS_IN_TRANSIT' | 'OWED_TO_GM', number>;
const fund = (branchId: number, amount: number, account: 'CASH' | 'BANK' = 'CASH') =>
  recordAdvance(ctx, gm, { branchId, account, amount, reason: 'test: fund the drawer', ...(account === 'BANK' ? { bankReference: `FUND${branchId}${amount}` } : {}) });
const send = (from: Actor, to: number | 'GM', amount: number, account: 'CASH' | 'BANK' = 'CASH', extra: Partial<{ reason: string; bankReference: string }> = {}) =>
  sendMoneyTransfer(ctx, from, { to: to === 'GM' ? { generalManager: true } : { branchId: to }, account, amount, reason: 'advance for the day', ...(account === 'BANK' ? { bankReference: `REF${Math.floor(amount)}A` } : {}), ...extra });
const entriesOf = (id: number) =>
  ctx.db
    .select({ branchId: t.ledgerEntries.branchId, kind: t.ledgerAccounts.kind, amount: t.ledgerEntries.amount, eventType: t.ledgerEntries.eventType, reverses: t.ledgerEntries.reversesEntryId })
    .from(t.ledgerEntries)
    .innerJoin(t.ledgerAccounts, eq(t.ledgerAccounts.id, t.ledgerEntries.accountId))
    .where(and(eq(t.ledgerEntries.refType, 'money_transfer'), eq(t.ledgerEntries.refId, id)))
    .orderBy(asc(t.ledgerEntries.id));

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx, new Date());
  gm = await actorOf('general.manager');
  bm = { KRT: await actorOf('branch.manager.kh'), OMD: await actorOf('branch.manager.omd'), BHR: await actorOf('branch.manager.bhr') };
  cashier = await actorOf('cashier.kh.01');
  const bs = await ctx.db.select().from(t.branches);
  br = Object.fromEntries(bs.map((b) => [b.code, b.id])) as typeof br;
  for (const b of ['KRT', 'OMD', 'BHR'] as const) {
    await fund(br[b], 5_000_000);
    await fund(br[b], 2_000_000, 'BANK');
  }
});
afterAll(async () => handle?.close());

describe('send, confirm, cancel: the ledger entries of each step', () => {
  it('send from the drawer, confirm into the bank: transit on the sender until confirmed; OWED_TO_GM never moves', async () => {
    const [k0, o0] = [await bal(br.KRT), await bal(br.OMD)];
    const tr = await send(bm.KRT, br.OMD, 300_000);
    expect([tr.status, tr.toKind, tr.number.startsWith('KRT-MT-')]).toEqual(['IN_TRANSIT', 'BRANCH', true]);
    const k1 = await bal(br.KRT);
    expect([k1.CASH - k0.CASH, k1.FUNDS_IN_TRANSIT - k0.FUNDS_IN_TRANSIT, k1.OWED_TO_GM - k0.OWED_TO_GM]).toEqual([-300_000, 300_000, 0]);
    expect((await bal(br.OMD)).BANK).toBe(o0.BANK);
    const c = await confirmMoneyTransfer(ctx, bm.OMD, tr.id, { account: 'BANK', bankReference: 'OMD RCV 1' });
    expect(c.status).toBe('RECEIVED');
    const [k2, o2] = [await bal(br.KRT), await bal(br.OMD)];
    expect([k2.CASH - k0.CASH, k2.FUNDS_IN_TRANSIT - k0.FUNDS_IN_TRANSIT, o2.BANK - o0.BANK, o2.CASH - o0.CASH, o2.OWED_TO_GM - o0.OWED_TO_GM]).toEqual([-300_000, 0, 300_000, 0, 0]);
    expect(await entriesOf(tr.id)).toEqual([
      { branchId: br.KRT, kind: 'CASH', amount: -300_000, eventType: 'MONEY_TRANSFER_SENT', reverses: null },
      { branchId: br.KRT, kind: 'FUNDS_IN_TRANSIT', amount: 300_000, eventType: 'MONEY_TRANSFER_SENT', reverses: null },
      { branchId: br.KRT, kind: 'FUNDS_IN_TRANSIT', amount: -300_000, eventType: 'MONEY_TRANSFER_RECEIVED', reverses: null },
      { branchId: br.OMD, kind: 'BANK', amount: 300_000, eventType: 'MONEY_TRANSFER_RECEIVED', reverses: null },
    ]);
    const events = (await getMoneyTransfer(ctx, gm, tr.id)).events;
    expect(events.map((e) => [e.kind, e.account, e.bankReference])).toEqual([['SENT', null, null], ['RECEIVED', 'BANK', 'OMD RCV 1']]);
    const audit = await ctx.db.select({ action: t.auditLogs.action }).from(t.auditLogs).where(sql`${t.auditLogs.entityId} = ${tr.number}`).orderBy(asc(t.auditLogs.id));
    expect(audit.map((a) => a.action)).toEqual(['MONEY_TRANSFER_SENT', 'MONEY_TRANSFER_RECEIVED']);
  });

  it('cancel by the sender: the money back where it left (BANK, with its reference); the reversal points at the send', async () => {
    const k0 = await bal(br.KRT);
    const tr = await send(bm.KRT, br.BHR, 120_000, 'BANK');
    const c = await cancelMoneyTransfer(ctx, bm.KRT, tr.id, { reason: 'wrong amount, agreed by phone' });
    expect(c.status).toBe('CANCELLED');
    expect(await bal(br.KRT)).toEqual(k0);
    const e = await entriesOf(tr.id);
    expect(e.map((x) => [x.kind, x.amount, x.eventType])).toEqual([
      ['BANK', -120_000, 'MONEY_TRANSFER_SENT'],
      ['FUNDS_IN_TRANSIT', 120_000, 'MONEY_TRANSFER_SENT'],
      ['BANK', 120_000, 'MONEY_TRANSFER_CANCELLED'],
      ['FUNDS_IN_TRANSIT', -120_000, 'MONEY_TRANSFER_CANCELLED'],
    ]);
    expect(e.slice(2).every((x) => x.reverses != null)).toBe(true);
    // The General Manager's read-only list shows the cancel: status, who, when, why.
    const page = await listMoneyTransfers(ctx, gm, { status: 'CANCELLED', pageSize: 50 });
    const row = page.rows.find((r) => r.id === tr.id)!;
    expect([row.status, row.closedByName, row.cancelReason, row.closedAt != null]).toEqual(['CANCELLED', '[Test] Branch Manager KRT', 'wrong amount, agreed by phone', true]);
    // Final: nothing more.
    expect((await err(confirmMoneyTransfer(ctx, bm.BHR, tr.id, { account: 'CASH' })))?.code).toBe('MONEY_TRANSFER_STATE');
    expect((await err(cancelMoneyTransfer(ctx, bm.KRT, tr.id, { reason: 'again' })))?.code).toBe('MONEY_TRANSFER_STATE');
  });

  it('to the General Manager: he confirms; the money leaves the branch books (transit −X, no landing); OWED_TO_GM untouched', async () => {
    const k0 = await bal(br.KRT);
    const tr = await send(bm.KRT, 'GM', 250_000);
    expect([tr.toKind, tr.toBranchId]).toEqual(['GM', null]);
    // Nobody else confirms it; he chooses nothing.
    expect((await err(confirmMoneyTransfer(ctx, bm.OMD, tr.id, { account: 'CASH' })))?.status).toBe(404);
    expect((await err(confirmMoneyTransfer(ctx, bm.KRT, tr.id, {})))?.status).toBe(403);
    expect((await err(confirmMoneyTransfer(ctx, gm, tr.id, { account: 'CASH' })))?.status).toBe(400);
    await confirmMoneyTransfer(ctx, gm, tr.id, {});
    const k1 = await bal(br.KRT);
    expect([k1.CASH - k0.CASH, k1.FUNDS_IN_TRANSIT - k0.FUNDS_IN_TRANSIT, k1.OWED_TO_GM - k0.OWED_TO_GM, k1.BANK - k0.BANK]).toEqual([-250_000, 0, 0, 0]);
    expect((await entriesOf(tr.id)).map((x) => [x.kind, x.amount, x.eventType])).toEqual([
      ['CASH', -250_000, 'MONEY_TRANSFER_TO_GM'],
      ['FUNDS_IN_TRANSIT', 250_000, 'MONEY_TRANSFER_TO_GM'],
      ['FUNDS_IN_TRANSIT', -250_000, 'MONEY_TRANSFER_TO_GM'],
    ]);
  });
});

describe('who may do what (D-mny1-2)', () => {
  it('the General Manager never sends, never cancels, never confirms a branch transfer; a cashier has nothing', async () => {
    expect((await err(sendMoneyTransfer(ctx, gm, { to: { branchId: br.OMD }, account: 'CASH', amount: 1_000, reason: 'from the GM' })))?.status).toBe(403);
    // Even with the permission given by mistake, the service refuses him (he has no branch).
    const gmWithSend = { ...gm, permissions: new Set([...gm.permissions, 'money_transfers.send']) } as Actor;
    expect((await err(sendMoneyTransfer(ctx, gmWithSend, { to: { branchId: br.OMD }, account: 'CASH', amount: 1_000, reason: 'from the GM' })))?.status).toBe(403);
    const tr = await send(bm.KRT, br.OMD, 10_000);
    expect((await err(confirmMoneyTransfer(ctx, gm, tr.id, { account: 'CASH' })))?.status).toBe(403);
    expect((await err(cancelMoneyTransfer(ctx, gmWithSend, tr.id, { reason: 'the GM cancels' })))?.status).toBe(403);
    for (const p of [send(cashier, br.OMD, 1_000), confirmMoneyTransfer(ctx, cashier, tr.id, { account: 'CASH' }), cancelMoneyTransfer(ctx, cashier, tr.id, { reason: 'cashier' }), listMoneyTransfers(ctx, cashier, {}), getMoneyTransfer(ctx, cashier, tr.id)]) {
      expect((await err(p))?.status).toBe(403);
    }
    // The sender cannot confirm; the receiver cannot cancel; a third branch does not even see it.
    expect((await err(confirmMoneyTransfer(ctx, bm.KRT, tr.id, { account: 'CASH' })))?.status).toBe(403);
    expect((await err(cancelMoneyTransfer(ctx, bm.OMD, tr.id, { reason: 'not mine to cancel' })))?.status).toBe(403);
    expect((await err(confirmMoneyTransfer(ctx, bm.BHR, tr.id, { account: 'CASH' })))?.status).toBe(404);
    expect((await err(getMoneyTransfer(ctx, bm.BHR, tr.id)))?.status).toBe(404);
    await cancelMoneyTransfer(ctx, bm.KRT, tr.id, { reason: 'test over' });
  });

  it('a branch manager sends from the own branch only and sees only the own transfers', async () => {
    const tr = await send(bm.OMD, br.BHR, 5_000);
    expect(tr.fromBranchId).toBe(br.OMD);
    const krt = await listMoneyTransfers(ctx, bm.KRT, { pageSize: 200 });
    expect(krt.rows.every((r) => r.fromBranchId === br.KRT || r.toBranchId === br.KRT)).toBe(true);
    expect(krt.rows.some((r) => r.id === tr.id)).toBe(false);
    expect((await err(listMoneyTransfers(ctx, bm.KRT, { branchId: br.OMD })))?.status).toBe(403);
    const all = await listMoneyTransfers(ctx, gm, { pageSize: 200 });
    expect(all.rows.some((r) => r.id === tr.id)).toBe(true);
    await confirmMoneyTransfer(ctx, bm.BHR, tr.id, { account: 'CASH' });
  });
});

describe('refused values and the drawer rule', () => {
  it('amount, reason, references, same branch, inactive branch; the drawer never below zero (the bank may be)', async () => {
    const bad = [
      send(bm.KRT, br.OMD, 0),
      send(bm.KRT, br.OMD, 1.5),
      send(bm.KRT, br.OMD, 1_000, 'CASH', { reason: 'ab' }),
      send(bm.KRT, br.OMD, 1_000, 'CASH', { reason: 'x'.repeat(301) }),
      send(bm.KRT, br.OMD, 1_000, 'CASH', { bankReference: 'REF1234' }),
      send(bm.KRT, br.OMD, 1_000, 'BANK', { bankReference: '' }),
      send(bm.KRT, br.KRT, 1_000),
      send(bm.KRT, 999_999, 1_000),
    ];
    for (const p of bad) expect((await err(p))?.status).toBe(400);
    const cash = (await bal(br.KRT)).CASH;
    const short = await err(send(bm.KRT, br.OMD, cash + 1));
    expect([short?.status, short?.code]).toEqual([409, 'DRAWER_SHORT']);
    expect((await bal(br.KRT)).CASH).toBe(cash);
    const tr = await send(bm.KRT, br.OMD, 1_000);
    expect((await err(confirmMoneyTransfer(ctx, bm.OMD, tr.id, {})))?.status).toBe(400); // drawer or bank: choose
    expect((await err(confirmMoneyTransfer(ctx, bm.OMD, tr.id, { account: 'BANK' })))?.status).toBe(400); // its reference
    await cancelMoneyTransfer(ctx, bm.KRT, tr.id, { reason: 'test over' });
  });

  it('a branch with money in transit, sent or coming, cannot be deactivated', async () => {
    const tr = await send(bm.KRT, br.BHR, 2_000);
    for (const id of [br.KRT, br.BHR]) {
      const e = await err(updateBranch(ctx, gm, id, { isActive: false }));
      expect([e?.status, e?.code]).toEqual([409, 'BRANCH_HAS_MONEY_IN_TRANSIT']);
    }
    await confirmMoneyTransfer(ctx, bm.BHR, tr.id, { account: 'CASH' });
    // Nothing in transit for PZU: it could be (it is not deactivated here, the other tests use it).
    const sendToInactive = await (async () => {
      await ctx.db.update(t.branches).set({ isActive: false }).where(eq(t.branches.id, br.PZU));
      try {
        return await err(send(bm.KRT, br.PZU, 1_000));
      } finally {
        await ctx.db.update(t.branches).set({ isActive: true }).where(eq(t.branches.id, br.PZU));
      }
    })();
    expect(sendToInactive?.status).toBe(400);
  });
});

describe('the daily reconciliation', () => {
  it('Money sent, Money received and To the General Manager lines; a cancel under its send; the day still adds up', async () => {
    const day = (await reconciliation(ctx, gm, { branchId: br.KRT })).day;
    const line = (r: Awaited<ReturnType<typeof reconciliation>>, l: string) => r.cashLines.find((x: { line: string }) => x.line === l)!.amount;
    const r0 = await reconciliation(ctx, gm, { branchId: br.KRT, day });
    const a = await send(bm.KRT, br.OMD, 7_000);
    const b = await send(bm.KRT, 'GM', 3_000);
    const c = await send(bm.KRT, 'GM', 1_000);
    await cancelMoneyTransfer(ctx, bm.KRT, c.id, { reason: 'sent twice' });
    await confirmMoneyTransfer(ctx, gm, b.id, {});
    const back = await send(bm.OMD, br.KRT, 4_000);
    await confirmMoneyTransfer(ctx, bm.KRT, back.id, { account: 'CASH' });
    const r1 = await reconciliation(ctx, gm, { branchId: br.KRT, day });
    expect(line(r1, 'MONEY_SENT') - line(r0, 'MONEY_SENT')).toBe(-7_000);
    expect(line(r1, 'MONEY_TO_GM') - line(r0, 'MONEY_TO_GM')).toBe(-3_000);
    expect(line(r1, 'MONEY_RECEIVED') - line(r0, 'MONEY_RECEIVED')).toBe(4_000);
    expect(line(r1, 'OTHER')).toBe(line(r0, 'OTHER'));
    await cancelMoneyTransfer(ctx, bm.KRT, a.id, { reason: 'test over' });
  });
});

describe('property: money is conserved by every step', () => {
  it('random sends, confirms and cancels over three branches and the General Manager', async () => {
    const codes = ['KRT', 'OMD', 'BHR'] as const;
    type Op = { kind: 'send'; from: number; to: number; amount: number; bank: boolean } | { kind: 'confirm'; i: number; bank: boolean } | { kind: 'cancel'; i: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant('send' as const), from: fc.nat(2), to: fc.nat(3), amount: fc.integer({ min: 1, max: 900_000 }), bank: fc.boolean() }),
      fc.record({ kind: fc.constant('confirm' as const), i: fc.nat(20), bank: fc.boolean() }),
      fc.record({ kind: fc.constant('cancel' as const), i: fc.nat(20) }),
    );
    let ref = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 14 }), async (ops) => {
        const money = async () => {
          let s = 0;
          for (const c of codes) {
            const b = await bal(br[c]);
            s += b.CASH + b.BANK + b.FUNDS_IN_TRANSIT;
          }
          return s;
        };
        const owed0 = await Promise.all(codes.map(async (c) => (await bal(br[c])).OWED_TO_GM));
        const start = await money();
        let exits = 0;
        const open: { id: number; from: number; to: number | 'GM'; amount: number }[] = [];
        for (const x of ops) {
          if (x.kind === 'send') {
            const from = codes[x.from];
            const to = x.to === 3 ? 'GM' : codes[x.to];
            if (to === from) continue;
            ref += 1;
            const r = await err(send(bm[from], to === 'GM' ? 'GM' : br[to], x.amount, x.bank ? 'BANK' : 'CASH', x.bank ? { bankReference: `PROP${ref}X` } : {}));
            if (r && r.code !== 'DRAWER_SHORT') throw r;
            if (!r) {
              const [last] = await ctx.db.select().from(t.moneyTransfers).orderBy(sql`${t.moneyTransfers.id} DESC`).limit(1);
              open.push({ id: last.id, from: br[from], to: to === 'GM' ? 'GM' : br[to], amount: x.amount });
            }
          } else if (open.length) {
            const tr = open.splice(x.i % open.length, 1)[0];
            if (x.kind === 'confirm') {
              if (tr.to === 'GM') {
                await confirmMoneyTransfer(ctx, gm, tr.id, {});
                exits += tr.amount;
              } else {
                const receiver = codes.find((c) => br[c] === tr.to)!;
                await confirmMoneyTransfer(ctx, bm[receiver], tr.id, x.bank ? { account: 'BANK', bankReference: `PRCV${tr.id}X` } : { account: 'CASH' });
              }
            } else {
              const sender = codes.find((c) => br[c] === tr.from)!;
              await cancelMoneyTransfer(ctx, bm[sender], tr.id, { reason: 'property test' });
            }
          }
          expect(await money()).toBe(start - exits);
          for (const c of codes) expect((await bal(br[c])).CASH).toBeGreaterThanOrEqual(0);
        }
        const transit = await inTransitByBranch(ctx.db);
        for (const c of codes) expect((await bal(br[c])).FUNDS_IN_TRANSIT).toBe(transit.get(br[c]) ?? 0);
        expect(await Promise.all(codes.map(async (c) => (await bal(br[c])).OWED_TO_GM))).toEqual(owed0);
        // Leave nothing in transit for the next run.
        for (const tr of open) await cancelMoneyTransfer(ctx, bm[codes.find((c) => br[c] === tr.from)!], tr.id, { reason: 'property test cleanup' });
      }),
      { numRuns: 25, seed: 4038, endOnFailure: true },
    );
  }, 300_000);
});
