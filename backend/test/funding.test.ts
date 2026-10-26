// CSH-2 piece B (docs/plans/CSH-2.md §3, D-csh-1…D-csh-5): the General Manager's advances and the branch's
// repayments. Both projects (PGlite and PostgreSQL); the races are in test/pg/funding-race.test.ts.
//   * an advance or repayment moves the drawer or the bank AND the OWED_TO_GM account, in one transaction;
//   * owed to the GM = SUM(OWED_TO_GM), derived; a repayment above it is refused; a correction reverses both entries,
//     once; correcting an advance already repaid is refused when it would leave the branch owing less than nothing;
//   * GM only (403 for the branch manager and the cashier), password re-confirmation, Idempotency-Key, audit hidden
//     from the branch manager;
//   * the reconciliation shows "GM advances" / "GM repayments", and a correction under the line it corrects, even on
//     another day; every day still adds up;
//   * GUARDRAIL: no reader of the ledger counts an OWED_TO_GM entry as money (a source scan of every reader, and the
//     same outputs before and after a large OWED_TO_GM-only entry).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { REPORT_KEYS } from '@jerp/shared';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Actor, Ctx } from '../src/core/context';
import { addDays, dayKey, dayStart } from '../src/core/time';
import { loadActor } from '../src/modules/sessions/service';
import { balances, drawer, reconciliation } from '../src/modules/ledger/service';
import { correctFunding, fundingView, owedOf, recordAdvance, recordRepayment } from '../src/modules/funding/service';
import { branchDashboard, companyDashboard } from '../src/modules/dashboard/service';
import { createBranch } from '../src/modules/branches/service';
import { attentionFor } from '../src/modules/attention/service';
import { listAudit, runReport } from '../src/modules/reports/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
let gm: Actor;
let krt: number;
let omd: number;
type Agent = ReturnType<typeof request.agent>;

const actorOf = async (username: string): Promise<Actor> => {
  const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
};
const branchId = async (code: string) => (await ctx.db.select().from(t.branches).where(eq(t.branches.code, code)))[0].id;
const bal = async (branch: number, kind: string) => (await balances(ctx.db, branch)).find((b) => b.kind === kind)?.balance ?? 0;
async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = request.agent(app) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  agent.set('x-csrf-token', res.body.csrfToken);
  return agent;
}
/** FIX-5: a branch of the test's own, created once: it owes nothing and its drawer holds what the test puts in it. */
let ownBranchId: number | null = null;
const ownBranch = async () => (ownBranchId ??= (await createBranch(ctx, gm, { code: 'FXF', name: 'Funding test branch', nameAr: 'فرع اختبار التمويل', city: 'Test' })).id);
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; key?: string; message?: string }) => e);

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
  gm = await actorOf('general.manager');
  krt = await branchId('KRT');
  omd = await branchId('OMD');
});
afterAll(async () => handle?.close());

describe('advances and repayments move the drawer or bank and the amount owed together', () => {
  it('an advance to CASH and one to BANK; owed = their sum; the bank one needs and normalizes a reference', async () => {
    const [cash0, bank0, owed0] = [await bal(krt, 'CASH'), await bal(krt, 'BANK'), await owedOf(ctx, krt)];
    const a = await recordAdvance(ctx, gm, { branchId: krt, account: 'CASH', amount: 500_000, reason: 'Float for the drawer, given this morning' });
    expect(a).toMatchObject({ kind: 'ADVANCE', account: 'CASH', amount: 500_000, owedToGm: owed0 + 500_000 });
    expect(a.number).toMatch(/-GMA-\d+$/);
    expect((await err(recordAdvance(ctx, gm, { branchId: krt, account: 'BANK', amount: 1_000, reason: 'Bank funding' })))?.key).toMatch(/bank transfer reference/);
    const b = await recordAdvance(ctx, gm, { branchId: krt, account: 'BANK', amount: 2_000_000, reason: 'Bank funding for the week', bankReference: 'trf ١٢٣٤' });
    expect(b.bankReference).toBe('TRF 1234');
    expect(await bal(krt, 'CASH')).toBe(cash0 + 500_000);
    expect(await bal(krt, 'BANK')).toBe(bank0 + 2_000_000);
    expect(await owedOf(ctx, krt)).toBe(owed0 + 2_500_000);
    const entries = await ctx.db.select().from(t.ledgerEntries).where(and(eq(t.ledgerEntries.refType, 'gm_funding_event'), eq(t.ledgerEntries.refId, a.id)));
    expect(entries.map((e) => e.amount)).toEqual([500_000, 500_000]);
    expect(new Set(entries.map((e) => e.eventType))).toEqual(new Set(['GM_ADVANCE']));
  });

  it('a repayment lowers both; never more than owed; a reason is required', async () => {
    const owed = await owedOf(ctx, krt);
    const cash = await bal(krt, 'CASH');
    expect((await err(recordRepayment(ctx, gm, { branchId: krt, account: 'CASH', amount: owed + 1, reason: 'too much' })))?.key).toMatch(/more than the branch owes/);
    expect((await err(recordRepayment(ctx, gm, { branchId: krt, account: 'CASH', amount: 1, reason: ' x ' })))?.key).toMatch(/reason/);
    const r = await recordRepayment(ctx, gm, { branchId: krt, account: 'CASH', amount: 100_000, reason: 'Returned at closing' });
    expect(r).toMatchObject({ kind: 'REPAYMENT', owedToGm: owed - 100_000 });
    expect(await bal(krt, 'CASH')).toBe(cash - 100_000);
    expect(await owedOf(ctx, krt)).toBe(owed - 100_000);
    expect((await err(recordRepayment(ctx, gm, { branchId: krt, account: 'CASH', amount: 1, reason: 'not an advance', paidDirectlyToSeller: true })))?.key).toMatch(/Only an advance/);
  });

  it('the "paid directly to a seller" marker and the linked purchase number are kept (display only)', async () => {
    const a = await recordAdvance(ctx, gm, { branchId: omd, account: 'CASH', amount: 285_000, reason: 'Paid the seller from my pocket', paidDirectlyToSeller: true, linkedRef: ' omd-scr-000042 ' });
    expect(a).toMatchObject({ paidDirectlyToSeller: true, linkedRef: 'OMD-SCR-000042' });
    const v = await fundingView(ctx, gm, { branchId: omd });
    expect(v.events[0]).toMatchObject({ number: a.number, paidDirectlyToSeller: true, linkedRef: 'OMD-SCR-000042', corrected: false });
  });
});

describe('corrections', () => {
  it('reverses both entries exactly once; a correction cannot be corrected', async () => {
    const owed0 = await owedOf(ctx, omd);
    const cash0 = await bal(omd, 'CASH');
    const a = await recordAdvance(ctx, gm, { branchId: omd, account: 'CASH', amount: 70_000, reason: 'Typed the wrong branch' });
    const c = await correctFunding(ctx, gm, a.id, { reason: 'Recorded on the wrong branch' });
    expect(c).toMatchObject({ kind: 'REVERSAL', reversesEventId: a.id, amount: 70_000, account: 'CASH', owedToGm: owed0 });
    expect(await owedOf(ctx, omd)).toBe(owed0);
    expect(await bal(omd, 'CASH')).toBe(cash0);
    expect((await err(correctFunding(ctx, gm, a.id, { reason: 'again' })))?.status).toBe(409);
    expect((await err(correctFunding(ctx, gm, c.id, { reason: 'undo the undo' })))?.key).toMatch(/cannot itself be corrected/);
    const v = await fundingView(ctx, gm, { branchId: omd });
    expect(v.events.find((e) => e.id === a.id)?.corrected).toBe(true);
    // The database refuses a correction with another amount, and any edit.
    await expect(ctx.db.execute(sql`UPDATE gm_funding_events SET amount = 1 WHERE id = ${a.id}`)).rejects.toThrow();
  });

  // FIX-5: this test once repaid everything the fixture branch BHR owed, in cash, so it depended on what 30 days of
  // fixture trading left in BHR's drawer: short on some weekdays and hours, and on PostgreSQL also on how the world
  // happened to be built (4 failures in 100 runs). It now runs on its own branch, whose drawer the test funds itself.
  it('correcting an advance that was already repaid is refused when the branch would owe less than nothing', async () => {
    const own = await ownBranch();
    expect([await owedOf(ctx, own), await bal(own, 'CASH')]).toEqual([0, 0]);
    const a = await recordAdvance(ctx, gm, { branchId: own, account: 'CASH', amount: 50_000, reason: 'Small float' });
    await recordRepayment(ctx, gm, { branchId: own, account: 'CASH', amount: 50_000, reason: 'Everything back' });
    const e = await err(correctFunding(ctx, gm, a.id, { reason: 'wrong amount' }));
    expect(e?.key).toMatch(/already been repaid in part/);
    expect([await owedOf(ctx, own), await bal(own, 'CASH')]).toEqual([0, 0]);
  });

  it('a repayment from a drawer that really is short is refused every time with the same error, and writes nothing', async () => {
    const own = await ownBranch();
    await recordAdvance(ctx, gm, { branchId: own, account: 'CASH', amount: 30_000, reason: 'test drawer float' });
    await recordAdvance(ctx, gm, { branchId: own, account: 'BANK', amount: 100_000, reason: 'test bank funding', bankReference: 'TEST-FIX5-1' });
    const before = { owed: await owedOf(ctx, own), cash: await bal(own, 'CASH'), bank: await bal(own, 'BANK'), events: (await fundingView(ctx, gm, { branchId: own })).events.length };
    expect([before.owed, before.cash]).toEqual([130_000, 30_000]);
    for (let i = 0; i < 3; i++) {
      const e = (await err(recordRepayment(ctx, gm, { branchId: own, account: 'CASH', amount: 40_000, reason: 'More than the drawer holds' }))) as { status?: number; code?: string; params?: Record<string, unknown>; message?: string } | null;
      expect(e).toMatchObject({ status: 409, code: 'DRAWER_SHORT', params: { balance: '30,000', amount: '40,000', short: '10,000' } });
      expect(e?.message).toBe('The drawer holds 30,000: a repayment of 40,000 from it is 10,000 more than that. Repay at most 30,000 from the drawer, or repay from the bank');
    }
    expect({ owed: await owedOf(ctx, own), cash: await bal(own, 'CASH'), bank: await bal(own, 'BANK'), events: (await fundingView(ctx, gm, { branchId: own })).events.length }).toEqual(before);
    // Exactly what the drawer holds goes through.
    await recordRepayment(ctx, gm, { branchId: own, account: 'CASH', amount: 30_000, reason: 'The whole drawer' });
    expect([await owedOf(ctx, own), await bal(own, 'CASH')]).toEqual([100_000, 0]);
  });
});

describe('the reconciliation: two new lines; a correction counts under the line it corrects, on any day', () => {
  it('an advance on day D and its correction on D+1: every day adds up, each in "GM advances"', async () => {
    const pzu = await branchId('PZU');
    const tz = (await ctx.settings.get()).company.timezone;
    const today = dayKey(new Date(), tz);
    const d1 = addDays(today, -2);
    const d2 = addDays(today, -1);
    const at1 = new Date(dayStart(d1, tz).getTime() + 3 * 3_600_000);
    const at2 = new Date(dayStart(d2, tz).getTime() + 3 * 3_600_000);
    const a = await recordAdvance(ctx, gm, { branchId: pzu, account: 'CASH', amount: 123_000, reason: 'Float' }, { at: at1 });
    await correctFunding(ctx, gm, a.id, { reason: 'It was not given after all' }, { at: at2 });
    for (const [day, expected] of [[d1, 123_000], [d2, -123_000]] as const) {
      const r = await reconciliation(ctx, gm, { branchId: pzu, day });
      const line = (l: string) => r.cashLines.find((x) => x.line === l)!.amount;
      expect(line('GM_ADVANCES'), `${day}: the correction counts under GM advances`).toBe(expected);
      expect(r.gmAdvancesCash, `${day} gmAdvancesCash`).toBe(expected);
      expect(line('OTHER'), `${day}: a correction is not "Other"`).toBe(0);
      expect(r.cashLines.reduce((s, l) => s + l.amount, 0), `${day} adds up`).toBe(r.cashMovement);
      expect(r.bankLines.reduce((s, l) => s + l.amount, 0)).toBe(r.bankMovement);
      expect(r.openingCash + r.cashMovement).toBe(r.expectedCash);
    }
  });

  it('a repayment from the bank lands in "GM repayments" of the bank', async () => {
    const r0 = await reconciliation(ctx, gm, { branchId: krt });
    await recordRepayment(ctx, gm, { branchId: krt, account: 'BANK', amount: 10_000, reason: 'Part of the bank funding back', bankReference: 'RET-0001' });
    const r1 = await reconciliation(ctx, gm, { branchId: krt });
    expect(r1.bankLines.find((l) => l.line === 'GM_REPAYMENTS')!.amount - r0.bankLines.find((l) => l.line === 'GM_REPAYMENTS')!.amount).toBe(-10_000);
    expect(r1.gmRepaymentsBank - r0.gmRepaymentsBank).toBe(-10_000);
  });
});

describe('access: General Manager only, password, Idempotency-Key, audit hidden from the branch manager', () => {
  it('the branch manager and the cashier are refused every funding route', async () => {
    for (const [user, role] of [['branch.manager.kh', 'BRANCH_MANAGER'], ['cashier.kh.01', 'CASHIER']] as const) {
      const a = await login(user, role);
      expect((await a.get('/api/funding')).status, `${user} GET`).toBe(403);
      for (const p of ['/api/funding/advances', '/api/funding/repayments', '/api/funding/1/correct']) {
        expect((await a.post(p).set('Idempotency-Key', crypto.randomUUID()).send({ branchId: krt, account: 'CASH', amount: 1, reason: 'probe' })).status, `${user} ${p}`).toBe(403);
      }
    }
  });

  it('the General Manager needs the password re-confirmation; a replay with the same key returns the same event', async () => {
    const a = await login('general.manager', 'GENERAL_MANAGER');
    const body = { branchId: krt, account: 'CASH', amount: 9_000, reason: 'Change for the drawer' };
    const key = crypto.randomUUID();
    const first = await a.post('/api/funding/advances').set('Idempotency-Key', key).send(body);
    expect(first.body.error?.code).toBe('REAUTH_REQUIRED');
    expect((await a.post('/api/auth/reauth').send({ password: DEMO_PASSWORDS.GENERAL_MANAGER })).status).toBe(200);
    const owed = await owedOf(ctx, krt);
    const ok = await a.post('/api/funding/advances').set('Idempotency-Key', key).send(body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const again = await a.post('/api/funding/advances').set('Idempotency-Key', key).send(body);
    expect(again.body.id).toBe(ok.body.id);
    expect(await owedOf(ctx, krt)).toBe(owed + 9_000);
    const view = await a.get(`/api/funding?branchId=${krt}`);
    expect(view.status).toBe(200);
    expect(view.body.branches[0].owedToGm).toBe(owed + 9_000);
  });

  it('the audit log shows funding to the General Manager only', async () => {
    const all = await listAudit(ctx, gm, { action: 'GM_ADVANCE_RECORDED', limit: 1500 });
    expect(all.length).toBeGreaterThan(0);
    const bm = await actorOf('branch.manager.kh');
    const mine = await listAudit(ctx, bm, { limit: 1500 });
    expect(mine.filter((r) => r.entityType === 'gm_funding_event')).toHaveLength(0);
  });
});

describe('GUARDRAIL: no reader of the ledger counts OWED_TO_GM as money (D-csh-1)', () => {
  // Every function of backend/src that touches ledger_entries or ledger_accounts, with why it is safe. A new reader
  // (or a reader moved elsewhere) fails this test until it is reviewed and listed here, and in
  // docs/acceptance/CSH-2.md. "kind" = filters by account kind; "type" = filters by event types that never post to
  // OWED_TO_GM except GM_ADVANCE/GM_REPAYMENT, which are summed per kind; "write" = writes only.
  const READERS: Record<string, string> = {
    'modules/ledger/service.ts#accountId': 'kind: looks up one account by branch and kind',
    'modules/ledger/service.ts#lockAccounts': 'kind: locks named kinds only (callers: funding, lockDrawerFor for the scrap, purchase and void drawer checks)',
    'modules/ledger/service.ts#post': 'write: appends entries',
    'modules/ledger/service.ts#reverseRef': 'write: reverses the entries of one record and event type',
    'modules/ledger/service.ts#balances': 'kind: returns one balance per (branch, kind); every caller picks a kind: cashBalance (CASH), drawer (named kinds), the homes and attention through cashBalance',
    'modules/ledger/service.ts#reconciliation': 'kind/type: every sum names a kind, or an event type only CASH/BANK carry (PAY-1: the Hasad figures come from the payment lines)',
    'modules/ledger/service.ts#entriesFor': 'type: the entries of one record (detail screens and tests)',
    'modules/attention/service.ts#attentionFor': "kind: A4 and A5 read a.kind = 'CASH' only, A17 a.kind = 'BANK' only",
    'modules/sales/service.ts#voidSale': "kind: the cash refund sums the sale's own SALE entries with a.kind = 'CASH' only (the drawer BLOCK, Q7)",
    'modules/funding/service.ts#owedToGm': "kind: OWED_TO_GM only, on purpose",
    'modules/scrap/service.ts#getScrapPurchase': 'type: the entries of one scrap purchase (SCRAP_PURCHASE on CASH/BANK and their reversals), listed with their account kind; no sum (MIS-1)',
    'backup/stats.ts#*': 'integrity: one balance per account in the backup summary (every kind, labelled)',
    'backup/checks.ts#*': 'integrity: entries on the wrong branch, reversals of a missing entry (no sums of money)',
    'core/startup.ts#*': 'not a reader: the list of append-only tables',
  };
  const PATTERN = /ledger_entries|ledger_accounts|ledgerEntries|ledgerAccounts/;

  it('every function that reads the ledger is reviewed and listed', () => {
    const root = path.resolve(__dirname, '../src');
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const rel = path.relative(root, p).split(path.sep).join('/');
          const lines = fs.readFileSync(p, 'utf8').split('\n');
          let fn = '*';
          for (const line of lines) {
            const m = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
            if (m) fn = m[1] ?? m[2];
            if (PATTERN.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) found.add(READERS[`${rel}#*`] ? `${rel}#*` : `${rel}#${fn}`);
          }
        }
      }
    };
    walk(root);
    const unlisted = [...found].filter((k) => !READERS[k]);
    expect(unlisted, 'a new reader of the ledger: review that it filters by account kind, then list it').toEqual([]);
    const stale = Object.keys(READERS).filter((k) => !found.has(k));
    expect(stale, 'a listed reader no longer reads the ledger: remove it from the list').toEqual([]);
  });

  it('cash totals, the reconciliation, the drawer, the homes, attention and every report are unchanged by an OWED_TO_GM-only entry', async () => {
    const tz = (await ctx.settings.get()).company.timezone;
    const today = dayKey(new Date(), tz);
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      out.drawer = (await drawer(ctx, gm, {})).branches;
      for (const b of [krt, omd]) {
        out[`rec${b}`] = await reconciliation(ctx, gm, { branchId: b, day: today });
        const d = await branchDashboard(ctx, gm, { branchId: b });
        out[`home${b}`] = { expectedCash: d.expectedCash, lastCount: d.lastCount, kpis: d.kpis };
      }
      out.company = await companyDashboard(ctx, gm, { from: addDays(today, -30), to: today });
      out.attention = (await attentionFor(ctx, gm)).signals.map((s) => ({ id: s.id, params: s.params }));
      for (const key of REPORT_KEYS) out[`report-${key}`] = await runReport(ctx, gm, key, { from: addDays(today, -30), to: today });
      return JSON.parse(JSON.stringify(out, (k, v) => (k === 'generatedAt' || k === 'asOf' ? undefined : v)));
    };
    const before = await snapshot();
    // A large entry on OWED_TO_GM alone (no drawer or bank side), as if a reader mixed the kinds up.
    const [acc] = await ctx.db.select().from(t.ledgerAccounts).where(and(eq(t.ledgerAccounts.branchId, krt), eq(t.ledgerAccounts.kind, 'OWED_TO_GM')));
    await ctx.db.insert(t.ledgerEntries).values({ accountId: acc.id, branchId: krt, amount: 987_654_321, eventType: 'GM_ADVANCE', refType: 'guardrail', refId: 1 });
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});
