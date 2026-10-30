// Branch money ledger (Phase 2b, decisions Q5–Q8, D-2b-*).
//
//   * Each branch has its accounts: CASH (the drawer), BANK, FUNDS_IN_TRANSIT and OWED_TO_GM (created by a trigger).
//   * ledger_entries is append-only: a signed whole-SDG amount per entry, positive = money into the
//     account. A balance is always SUM(amount); nothing is cached.
//   * Every money event posts its entries in the SAME transaction as the business change (callers
//     pass their `tx`). Corrections are reversing entries that point at the entry they reverse; an
//     entry can be reversed only once (unique index), so a double void can never refund twice.

import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { t, type Executor } from '@jerp/database';
import { PAYMENT_ACCOUNT, sumInt, type LedgerAccountKind, type LedgerEventType, type PaymentMethod } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest } from '../../core/errors';
import { rows } from '../../core/sql';
import { addDays, dayKey, dayStart } from '../../core/time';
import { ap } from '@jerp/shared';

export interface LedgerRef {
  refType: string;
  refId: number;
  refNumber?: string | null;
}

export interface LedgerLine {
  branchId: number;
  kind: LedgerAccountKind;
  /** Signed whole SDG; lines with 0 are skipped (nothing moved). */
  amount: number;
  eventType: LedgerEventType;
  paymentMethod?: PaymentMethod | null;
  ref: LedgerRef;
  note?: string | null;
  at?: Date;
}

/** Who posted: the actor (null = system), and the request's idempotency key when there is one. */
export interface PostedBy {
  actor: Pick<Actor, 'userId' | 'sessionId'> | null;
  idempotencyKey?: string | null;
}

/** The account a payment method moves (Q5), or null for HASAD, which moves no branch account (PAY-1, D-pay1-8). */
export const accountKindFor = (method: PaymentMethod): LedgerAccountKind | null => PAYMENT_ACCOUNT[method];

async function accountId(exec: Executor, branchId: number, kind: LedgerAccountKind): Promise<number> {
  const [a] = await exec
    .select({ id: t.ledgerAccounts.id })
    .from(t.ledgerAccounts)
    .where(and(eq(t.ledgerAccounts.branchId, branchId), eq(t.ledgerAccounts.kind, kind)));
  if (!a) throw new Error(`ledger account ${kind} missing for branch ${branchId}`);
  return a.id;
}

/**
 * Lock some of a branch's accounts for the rest of the transaction (SELECT … FOR UPDATE), ALWAYS in ascending
 * `ledger_accounts.id` order, so two transactions that lock overlapping accounts can never deadlock (D-csh-4). Every
 * check-then-write on a balance (the repayment cap, the CASH no-negative rule) goes through
 * here. Returns each locked account's id and its balance read under the lock.
 */
export async function lockAccounts(exec: Executor, branchId: number, kinds: readonly LedgerAccountKind[]): Promise<Record<string, { id: number; balance: number }>> {
  const locked = await exec
    .select({ id: t.ledgerAccounts.id, kind: t.ledgerAccounts.kind })
    .from(t.ledgerAccounts)
    .where(and(eq(t.ledgerAccounts.branchId, branchId), inArray(t.ledgerAccounts.kind, [...kinds])))
    .orderBy(asc(t.ledgerAccounts.id))
    .for('update');
  const out: Record<string, { id: number; balance: number }> = {};
  for (const a of locked) {
    const [{ balance }] = rows<{ balance: string | number }>(await exec.execute(sql`SELECT coalesce(sum(amount), 0)::bigint AS balance FROM ledger_entries WHERE account_id = ${a.id}`));
    out[a.kind] = { id: a.id, balance: Number(balance) };
  }
  for (const k of kinds) if (!out[k]) throw new Error(`ledger account ${k} missing for branch ${branchId}`);
  return out;
}

/**
 * MNY-1: lock accounts of several branches at once (a money transfer touches both sides), ALWAYS in ascending
 * `ledger_accounts.id`, as `lockAccounts` does for one branch (D-csh-4): two transfers A→B and B→A can never deadlock.
 * Returns the balance of each read under the lock.
 */
export async function lockAccountsAcross(exec: Executor, specs: readonly { branchId: number; kind: LedgerAccountKind }[]) {
  const wanted = new Set(specs.map((s) => `${s.branchId}:${s.kind}`));
  const branchIds = [...new Set(specs.map((s) => s.branchId))];
  const candidates = await exec
    .select({ id: t.ledgerAccounts.id, branchId: t.ledgerAccounts.branchId, kind: t.ledgerAccounts.kind })
    .from(t.ledgerAccounts)
    .where(and(inArray(t.ledgerAccounts.branchId, branchIds), inArray(t.ledgerAccounts.kind, [...new Set(specs.map((s) => s.kind))])))
    .orderBy(asc(t.ledgerAccounts.id));
  const ids = candidates.filter((a) => wanted.has(`${a.branchId}:${a.kind}`)).map((a) => a.id);
  const locked = ids.length ? await exec.select({ id: t.ledgerAccounts.id, branchId: t.ledgerAccounts.branchId, kind: t.ledgerAccounts.kind }).from(t.ledgerAccounts).where(inArray(t.ledgerAccounts.id, ids)).orderBy(asc(t.ledgerAccounts.id)).for('update') : [];
  const out = new Map<string, { id: number; balance: number }>();
  for (const a of locked) {
    const [{ balance }] = rows<{ balance: string | number }>(await exec.execute(sql`SELECT coalesce(sum(amount), 0)::bigint AS balance FROM ledger_entries WHERE account_id = ${a.id}`));
    out.set(`${a.branchId}:${a.kind}`, { id: a.id, balance: Number(balance) });
  }
  for (const k of wanted) if (!out.has(k)) throw new Error(`ledger account ${k} missing`);
  return { get: (branchId: number, kind: LedgerAccountKind) => out.get(`${branchId}:${kind}`)! };
}

/** CSH-2 (Q7): what a payment out of the drawer is for; it picks the refusal sentence (each names the shortfall and what to do). */
// MKC-1: the supplier making charge is no longer one of them (the owner pays it from his personal account).
export type DrawerOutflow = 'SCRAP_PURCHASE' | 'SALE_VOID' | 'GM_REPAYMENT' | 'GM_CORRECTION' | 'MONEY_TRANSFER';
export const DRAWER_SHORT: Record<DrawerOutflow, string> = {
  SCRAP_PURCHASE: 'The drawer holds {balance}: the cash part of {amount} is {short} more than that. Pay {short} more by bank transfer, or ask the General Manager to record an advance into the drawer',
  SALE_VOID: 'The drawer holds {balance}: refunding {amount} in cash needs {short} more. Ask the General Manager to record an advance into the drawer, then cancel the sale again',
  GM_REPAYMENT: 'The drawer holds {balance}: a repayment of {amount} from it is {short} more than that. Repay at most {balance} from the drawer, or repay from the bank',
  GM_CORRECTION: 'The drawer holds {balance}: correcting this advance takes {amount} out of it, {short} more than it holds. That money has already been paid out: record the advance that really came in first, then correct this one',
  // MNY-1: a money transfer from the drawer.
  MONEY_TRANSFER: 'The drawer holds {balance}: sending {amount} from it needs {short} more. Send at most {balance} from the drawer, or send from the bank',
};
const fmtMoney = (n: number) => n.toLocaleString('en-US');

/**
 * CSH-2 (Q7, D-csh-8): BLOCK for the drawer. A payment out of CASH never takes it below zero. `drawer` is the CASH
 * balance read by lockAccounts in the same transaction, before the entry is posted, so two payments racing on one
 * drawer are checked one after the other (tested on PostgreSQL). The bank is never blocked (WARN: attention A17).
 */
export function requireDrawerCovers(drawer: number, amount: number, what: DrawerOutflow): void {
  if (amount <= 0 || drawer >= amount) return;
  throw new AppError(409, 'DRAWER_SHORT', DRAWER_SHORT[what], { balance: fmtMoney(drawer), amount: fmtMoney(amount), short: fmtMoney(amount - drawer) });
}

/** Lock the branch's drawer and refuse a payment it cannot cover (see requireDrawerCovers). No lock for an amount of 0. */
export async function lockDrawerFor(exec: Executor, branchId: number, amount: number, what: DrawerOutflow): Promise<void> {
  if (amount <= 0) return;
  const { CASH } = await lockAccounts(exec, branchId, ['CASH']);
  requireDrawerCovers(CASH.balance, amount, what);
}

/** Append entries. Must run inside the transaction of the business change it records. */
export async function post(exec: Executor, lines: LedgerLine[], by: PostedBy): Promise<void> {
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount)) throw new RangeError(`ledger amount must be a whole number, got ${l.amount}`);
    if (l.amount === 0) continue;
    await exec.insert(t.ledgerEntries).values({
      accountId: await accountId(exec, l.branchId, l.kind),
      branchId: l.branchId,
      amount: l.amount,
      eventType: l.eventType,
      paymentMethod: l.paymentMethod ?? null,
      refType: l.ref.refType,
      refId: l.ref.refId,
      refNumber: l.ref.refNumber ?? null,
      actorId: by.actor?.userId ?? null,
      sessionId: by.actor?.sessionId ?? null,
      idempotencyKey: by.idempotencyKey ?? null,
      note: l.note ?? null,
      at: l.at ?? new Date(),
    });
  }
}

/**
 * Reverse every not-yet-reversed entry of `eventType` recorded for `ref` (e.g. the SALE entries of
 * a sale being voided): same account, same payment method, opposite amount. Returns the number of
 * entries reversed (0 for a record made before the ledger existed).
 */
export async function reverseRef(
  exec: Executor,
  ref: LedgerRef,
  original: LedgerEventType,
  as: Extract<LedgerEventType, 'SALE_VOID' | 'REVERSAL' | 'MONEY_TRANSFER_CANCELLED'>,
  by: PostedBy,
  opts: { note?: string; at?: Date } = {},
): Promise<number> {
  const reversed = exec.select({ id: t.ledgerEntries.reversesEntryId }).from(t.ledgerEntries).where(sql`${t.ledgerEntries.reversesEntryId} IS NOT NULL`);
  const entries = await exec
    .select()
    .from(t.ledgerEntries)
    .where(
      and(
        eq(t.ledgerEntries.refType, ref.refType),
        eq(t.ledgerEntries.refId, ref.refId),
        eq(t.ledgerEntries.eventType, original),
        isNull(t.ledgerEntries.reversesEntryId),
        sql`${t.ledgerEntries.id} NOT IN (${reversed})`,
      ),
    )
    .orderBy(asc(t.ledgerEntries.id));
  for (const e of entries) {
    await exec.insert(t.ledgerEntries).values({
      accountId: e.accountId,
      branchId: e.branchId,
      amount: -e.amount,
      eventType: as,
      paymentMethod: e.paymentMethod,
      refType: e.refType,
      refId: e.refId,
      refNumber: e.refNumber,
      reversesEntryId: e.id,
      actorId: by.actor?.userId ?? null,
      sessionId: by.actor?.sessionId ?? null,
      idempotencyKey: by.idempotencyKey ?? null,
      note: opts.note ?? null,
      at: opts.at ?? new Date(),
    });
  }
  return entries.length;
}

/** Balance of every account of a branch (or all branches) up to `before` (exclusive). */
export async function balances(exec: Executor, branchId: number | null, before?: Date) {
  const res = await exec.execute(sql`
    SELECT a.branch_id AS "branchId", a.kind AS kind, coalesce(sum(e.amount), 0)::bigint AS balance
    FROM ledger_accounts a
    LEFT JOIN ledger_entries e ON e.account_id = a.id ${before ? sql`AND e.at < ${before}` : sql``}
    ${branchId != null ? sql`WHERE a.branch_id = ${branchId}` : sql``}
    GROUP BY a.branch_id, a.kind
    ORDER BY a.branch_id, a.kind`);
  return rows<{ branchId: number; kind: LedgerAccountKind; balance: number | string }>(res).map((r) => ({ ...r, balance: Number(r.balance) }));
}

/** Money that should be in the drawer: the CASH account balance (optionally as at `before`). */
export async function cashBalance(exec: Executor, branchId: number, before?: Date): Promise<number> {
  const b = await balances(exec, branchId, before);
  return b.find((x) => x.kind === 'CASH')?.balance ?? 0;
}

// ───────────────────────── API: expected cash, reconciliation, counts ─────────────────────────

export async function drawer(ctx: Ctx, actor: Actor, q: { branchId?: number }) {
  requirePerm(actor, 'cash.view');
  const scope = branchScope(actor, q.branchId);
  const accounts = await balances(ctx.db, scope);
  const branchRows = await ctx.db.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches);
  const branchIds = [...new Set(accounts.map((a) => a.branchId))];
  return {
    asOf: new Date(),
    branches: branchIds.map((id) => {
      const b = branchRows.find((x) => x.id === id)!;
      const acc = accounts.filter((a) => a.branchId === id);
      const bal = (k: LedgerAccountKind) => acc.find((a) => a.kind === k)?.balance ?? 0;
      return { branchId: id, branchCode: b.code, branchName: b.name, branchNameAr: b.nameAr, expectedCash: bal('CASH'), bank: bal('BANK'), fundsInTransit: bal('FUNDS_IN_TRANSIT') };
    }),
  };
}

/**
 * Lines of the daily reconciliation, per account (SPEC §18.10, D-rem1-5). Every ledger entry of the
 * day on that account falls into exactly one line; an event type without a line of its own for the
 * account lands in OTHER, so the lines always add up to the account's movement in the ledger.
 * Nothing silently disappears.
 */
export const RECONCILIATION_LINES = {
  CASH: ['SALES', 'VOIDS', 'SCRAP_PURCHASES', 'GM_ADVANCES', 'GM_REPAYMENTS', 'MONEY_SENT', 'MONEY_RECEIVED', 'MONEY_TO_GM', 'OTHER'],
  BANK: ['SALES', 'VOIDS', 'SCRAP_PURCHASES', 'GM_ADVANCES', 'GM_REPAYMENTS', 'MONEY_SENT', 'MONEY_RECEIVED', 'MONEY_TO_GM', 'OTHER'],
} as const;
export type ReconciliationLine = (typeof RECONCILIATION_LINES)['BANK'][number];
export const LINE_OF_EVENT: Partial<Record<LedgerEventType, ReconciliationLine>> = {
  SALE: 'SALES',
  SALE_VOID: 'VOIDS',
  SCRAP_PURCHASE: 'SCRAP_PURCHASES',
  // CSH-2 (D-csh-3): the General Manager's money into and out of the drawer or the bank.
  GM_ADVANCE: 'GM_ADVANCES',
  GM_REPAYMENT: 'GM_REPAYMENTS',
  // MNY-1: money sent to another branch, money received from one, money handed to the General Manager (its confirmation
  // posts on FUNDS_IN_TRANSIT only, never a drawer line). A cancel counts under the line of the send it reverses.
  MONEY_TRANSFER_SENT: 'MONEY_SENT',
  MONEY_TRANSFER_RECEIVED: 'MONEY_RECEIVED',
  MONEY_TRANSFER_TO_GM: 'MONEY_TO_GM',
};

/**
 * Event types that deliberately have NO line of their own and are shown under OTHER, each with its
 * reason. Every member of LEDGER_EVENT_TYPES must be either in LINE_OF_EVENT or here (guardrail test
 * in test/ledger.test.ts): adding an event type fails the build until someone decides where it goes.
 */
export const OTHER_EVENT_TYPES: Readonly<Partial<Record<LedgerEventType, string>>> = {
  // A generic correction of an earlier entry (sale voids use SALE_VOID). CSH-2 Q9 (D-csh-3): it is shown under the
  // line of the entry it reverses (`effectiveEventType`), on whatever day it is recorded; only a reversal whose
  // original has no line of its own stays under "Other". Either way the day still adds up.
  REVERSAL: 'shown under the line of the entry it reverses; no line of its own',
  // MKC-1 (Q7, D-mkc-4): historical only. A making charge is paid by the owner from his personal account and posts no
  // entry any more; the type stays valid in the database check so the ledger's history is never rewritten.
  SUPPLIER_MAKING_CHARGE: 'historical, MKC-1: making charges no longer touch branch money',
  // MNY-1: a cancel reverses the send's entries (reverses_entry_id), so it counts under the send's line, like a REVERSAL.
  MONEY_TRANSFER_CANCELLED: 'shown under the line of the send it cancels (Money sent or To the General Manager)',
};

/** The event type an entry counts as in the reconciliation: a REVERSAL counts as the entry it reverses (Q9). */
export const effectiveEventType = (e: { eventType: string; reversedEventType?: string | null }): string =>
  (e.eventType === 'REVERSAL' || e.eventType === 'MONEY_TRANSFER_CANCELLED') && e.reversedEventType ? e.reversedEventType : e.eventType;

/** Group one account's entries into its reconciliation lines; their sum always equals the account's movement. */
export function reconciliationLines(kind: keyof typeof RECONCILIATION_LINES, entries: { kind: string; eventType: string; reversedEventType?: string | null; amount: number }[]) {
  const lines: readonly ReconciliationLine[] = RECONCILIATION_LINES[kind];
  const totals = new Map<ReconciliationLine, number[]>(lines.map((l) => [l, []]));
  for (const e of entries) {
    if (e.kind !== kind) continue;
    const own = LINE_OF_EVENT[effectiveEventType(e) as LedgerEventType];
    totals.get(own && lines.includes(own) ? own : 'OTHER')!.push(e.amount);
  }
  return lines.map((line) => ({ line, amount: sumInt(totals.get(line)!) }));
}

/**
 * Daily reconciliation of one branch: opening cash, sales by payment method, voids, the day's drawer
 * and bank movements line by line (they add up to the ledger, SPEC §18.10), expected cash at the end
 * of the day, the latest counted cash and the difference.
 */
export async function reconciliation(ctx: Ctx, actor: Actor, q: { branchId?: number; day?: string }) {
  requirePerm(actor, 'cash.view');
  const branchId = branchScope(actor, q.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  const { company } = await ctx.settings.get();
  const day = q.day ?? dayKey(new Date(), company.timezone);
  const start = dayStart(day, company.timezone);
  const end = dayStart(addDays(day, 1), company.timezone);
  // Every sum below names its account kind or an event type that only CASH or BANK carry, so an
  // OWED_TO_GM entry (D-csh-1) never counts as money here (guardrail test in test/funding.test.ts).
  // A REVERSAL carries the event type of the entry it reverses, so it counts in that entry's line (Q9).
  const original = alias(t.ledgerEntries, 'reversed');
  const raw = await ctx.db
    .select({
      amount: t.ledgerEntries.amount,
      eventType: t.ledgerEntries.eventType,
      reversedEventType: original.eventType,
      paymentMethod: t.ledgerEntries.paymentMethod,
      kind: t.ledgerAccounts.kind,
      refType: t.ledgerEntries.refType,
      refId: t.ledgerEntries.refId,
    })
    .from(t.ledgerEntries)
    .innerJoin(t.ledgerAccounts, eq(t.ledgerAccounts.id, t.ledgerEntries.accountId))
    .leftJoin(original, eq(original.id, t.ledgerEntries.reversesEntryId))
    .where(and(eq(t.ledgerEntries.branchId, branchId), gte(t.ledgerEntries.at, start), lt(t.ledgerEntries.at, end)));
  // `type` = the business event an entry counts as (a reversal counts as its original).
  const entries = raw.map((e) => ({ ...e, type: effectiveEventType(e) }));
  const sum = (f: (e: (typeof entries)[number]) => boolean) => sumInt(entries.filter(f).map((e) => e.amount));
  const openingCash = await cashBalance(ctx.db, branchId, start);
  const cashIn = sum((e) => e.kind === 'CASH');
  const expectedCash = openingCash + cashIn;
  const methods = ['CASH', 'CARD', 'MOBILE_WALLET', 'BANK_TRANSFER', 'HASAD'] as const;
  const [count] = await ctx.db
    .select()
    .from(t.cashCounts)
    .where(and(eq(t.cashCounts.branchId, branchId), eq(t.cashCounts.businessDay, day)))
    .orderBy(sql`${t.cashCounts.at} DESC`, sql`${t.cashCounts.id} DESC`)
    .limit(1);
  // FIX-2: the drill-down of the day's bank-transfer sales, one row per SALE entry (same entries as the
  // BANK_TRANSFER line of salesByMethod, so they add up to it), with each sale's reference.
  const bankSaleIds = entries.filter((e) => e.eventType === 'SALE' && e.paymentMethod === 'BANK_TRANSFER' && e.refType === 'sale' && e.refId != null).map((e) => e.refId!);
  const bankSales = bankSaleIds.length
    ? await ctx.db
        // PAY-1: the reference is the sale's bank-transfer payment line's (a sale has at most one).
        .select({ id: t.sales.id, number: t.sales.number, at: t.sales.createdAt, reference: t.salePayments.refTransaction, status: t.sales.status })
        .from(t.sales)
        .leftJoin(t.salePayments, and(eq(t.salePayments.saleId, t.sales.id), eq(t.salePayments.method, 'BANK_TRANSFER')))
        .where(inArray(t.sales.id, bankSaleIds))
    : [];
  const bankSaleById = new Map(bankSales.map((s) => [s.id, s]));
  const bankTransferSales = entries
    .filter((e) => e.eventType === 'SALE' && e.paymentMethod === 'BANK_TRANSFER')
    .map((e) => {
      const s = e.refId != null ? bankSaleById.get(e.refId) : undefined;
      return { saleId: s?.id ?? null, number: s?.number ?? null, at: s?.at ?? null, amount: e.amount, reference: s?.reference ?? null, status: s?.status ?? null };
    })
    .sort((a, z) => (a.at?.getTime() ?? 0) - (z.at?.getTime() ?? 0));
  // CSH-2 piece A: the drill-down of the day's scrap purchases per account, one row per SCRAP_PURCHASE entry (the same
  // entries as the SCRAP_PURCHASES line of the drawer and of the bank, so each account's rows add up to its line); a split
  // purchase shows once under each account with its own part, the bank row with the transfer reference.
  const scrapEntries = entries.filter((e) => e.type === 'SCRAP_PURCHASE' && (e.kind === 'CASH' || e.kind === 'BANK'));
  const scrapIds = [...new Set(scrapEntries.filter((e) => e.refType === 'scrap_purchase' && e.refId != null).map((e) => e.refId!))];
  const scrapRows = scrapIds.length
    ? await ctx.db
        .select({ id: t.scrapPurchases.id, number: t.scrapPurchases.number, at: t.scrapPurchases.createdAt, paymentMethod: t.scrapPurchases.paymentMethod, bankReference: t.scrapPurchases.bankReference })
        .from(t.scrapPurchases)
        .where(inArray(t.scrapPurchases.id, scrapIds))
    : [];
  const scrapById = new Map(scrapRows.map((s) => [s.id, s]));
  const scrapPurchases = scrapEntries
    .map((e) => {
      const s = e.refType === 'scrap_purchase' && e.refId != null ? scrapById.get(e.refId) : undefined;
      return {
        scrapPurchaseId: s?.id ?? null,
        number: s?.number ?? null,
        at: s?.at ?? null,
        account: e.kind as 'CASH' | 'BANK',
        amount: e.amount,
        paymentMethod: s?.paymentMethod ?? null,
        reference: e.kind === 'BANK' ? s?.bankReference ?? null : null,
      };
    })
    .sort((a, z) => (a.at?.getTime() ?? 0) - (z.at?.getTime() ?? 0));
  const countedBy = count ? (await ctx.db.select({ name: t.users.fullName }).from(t.users).where(eq(t.users.id, count.countedBy)))[0]?.name ?? null : null;
  // PAY-1 (D-dec1-5): Hasad money is paid to the General Manager's account, never the branch's. The day's Hasad figures
  // come from the sales' HASAD payment lines (sales made that day; sales voided that day), never from a branch account,
  // so the expected cash, the bank and the branch's sales total never include them.
  const hasadLines = async (on: 'created' | 'voided') => {
    const at = on === 'created' ? t.sales.createdAt : t.sales.voidedAt;
    const [r] = await ctx.db
      .select({ amount: sql<string | number>`coalesce(sum(${t.salePayments.amount}), 0)::bigint` })
      .from(t.salePayments)
      .innerJoin(t.sales, eq(t.sales.id, t.salePayments.saleId))
      .where(and(eq(t.sales.branchId, branchId), eq(t.salePayments.method, 'HASAD'), gte(at, start), lt(at, end), ...(on === 'voided' ? [eq(t.sales.status, 'VOIDED')] : [])));
    return Number(r.amount);
  };
  const hasadSales = await hasadLines('created');
  const hasadVoids = -(await hasadLines('voided'));
  const branchMoney = (e: (typeof entries)[number]) => e.kind === 'CASH' || e.kind === 'BANK';
  return {
    branchId,
    day,
    openingCash,
    // The branch's money per method from its own accounts; the HASAD row from the payment lines (informational).
    salesByMethod: methods.map((m) => ({ paymentMethod: m, amount: m === 'HASAD' ? hasadSales : sum((e) => e.type === 'SALE' && e.paymentMethod === m && branchMoney(e)) })),
    // PAY-1: the branch's sales and refunds only (cash and bank); Hasad is reported beside them.
    salesTotal: sum((e) => e.type === 'SALE' && branchMoney(e)),
    voidsByMethod: methods.map((m) => ({ paymentMethod: m, amount: m === 'HASAD' ? hasadVoids : sum((e) => e.type === 'SALE_VOID' && e.paymentMethod === m && branchMoney(e)) })),
    voidsTotal: sum((e) => e.type === 'SALE_VOID' && branchMoney(e)),
    hasadSales,
    hasadVoids,
    // Phase 4: scrap bought from customers, paid out at once (MKC-1: supplier making charges no longer touch branch money).
    scrapPurchasesCash: sum((e) => e.type === 'SCRAP_PURCHASE' && e.kind === 'CASH'),
    scrapPurchasesBank: sum((e) => e.type === 'SCRAP_PURCHASE' && e.kind === 'BANK'),
    // CSH-2: the General Manager's advances and repayments of the day, per account (corrections included).
    gmAdvancesCash: sum((e) => e.type === 'GM_ADVANCE' && e.kind === 'CASH'),
    gmAdvancesBank: sum((e) => e.type === 'GM_ADVANCE' && e.kind === 'BANK'),
    gmRepaymentsCash: sum((e) => e.type === 'GM_REPAYMENT' && e.kind === 'CASH'),
    gmRepaymentsBank: sum((e) => e.type === 'GM_REPAYMENT' && e.kind === 'BANK'),
    cashLines: reconciliationLines('CASH', entries),
    bankLines: reconciliationLines('BANK', entries),
    bankTransferSales,
    scrapPurchases,
    cashMovement: cashIn,
    bankMovement: sum((e) => e.kind === 'BANK'),
    expectedCash,
    counted: count ? { amount: count.countedAmount, at: count.at, countedByName: countedBy, note: count.note } : null,
    difference: count ? count.countedAmount - expectedCash : null,
  };
}

/** Record the cash counted in the drawer for a business day (append-only; a recount is a new row). */
export async function recordCount(ctx: Ctx, actor: Actor, input: { branchId?: number; day: string; countedAmount: number; note?: string }) {
  requirePerm(actor, 'cash.count');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  if (!Number.isSafeInteger(input.countedAmount) || input.countedAmount < 0) throw badRequest('Invalid value for {field}', { field: 'countedAmount' });
  const { company } = await ctx.settings.get();
  const today = dayKey(new Date(), company.timezone);
  if (input.day > today) throw badRequest('A count cannot be recorded for a future day');
  return ctx.db.transaction(async (tx) => {
    const expected = await cashBalance(tx, branchId, dayStart(addDays(input.day, 1), company.timezone));
    const [row] = await tx
      .insert(t.cashCounts)
      .values({ branchId, businessDay: input.day, countedAmount: input.countedAmount, expectedAmount: expected, countedBy: actor.userId, note: input.note?.trim() || null })
      .returning();
    await writeAudit(tx, actor, {
      action: 'CASH_COUNTED',
      entityType: 'cash_count',
      entityId: `${input.day}`,
      branchId,
      key: 'Cash counted for {day}: {counted} (expected {expected}, difference {difference})',
      params: { day: input.day, counted: ap.money(input.countedAmount), expected: ap.money(expected), difference: ap.money(input.countedAmount - expected) },
    });
    return row;
  });
}


/** Ledger entries of one record (e.g. a sale), for detail screens and tests. */
export async function entriesFor(exec: Executor, refType: string, refIds: number[]) {
  if (!refIds.length) return [];
  return exec
    .select()
    .from(t.ledgerEntries)
    .where(and(eq(t.ledgerEntries.refType, refType), inArray(t.ledgerEntries.refId, refIds)))
    .orderBy(asc(t.ledgerEntries.id));
}
