// Branch money ledger (Phase 2b, decisions Q5–Q8, D-2b-*).
//
//   * Each branch has four accounts: CASH (the drawer), BANK, FUNDS_IN_TRANSIT and HASAD_RECEIVABLE (created by a trigger).
//   * ledger_entries is append-only: a signed whole-SDG amount per entry, positive = money into the
//     account. A balance is always SUM(amount); nothing is cached.
//   * Every money event posts its entries in the SAME transaction as the business change (callers
//     pass their `tx`). Corrections are reversing entries that point at the entry they reverse; an
//     entry can be reversed only once (unique index), so a double void can never refund twice.

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { PAYMENT_ACCOUNT, sumInt, type LedgerAccountKind, type LedgerEventType, type PaymentMethod } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest } from '../../core/errors';
import { rows } from '../../core/sql';
import { addDays, dayKey, dayStart } from '../../core/time';
import { nextNumber } from '../../core/numbering';
import type { TxIdempotency } from '../../core/idempotency';
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

/** The account a payment method moves (Q5). */
export const accountKindFor = (method: PaymentMethod): LedgerAccountKind => PAYMENT_ACCOUNT[method];

async function accountId(exec: Executor, branchId: number, kind: LedgerAccountKind): Promise<number> {
  const [a] = await exec
    .select({ id: t.ledgerAccounts.id })
    .from(t.ledgerAccounts)
    .where(and(eq(t.ledgerAccounts.branchId, branchId), eq(t.ledgerAccounts.kind, kind)));
  if (!a) throw new Error(`ledger account ${kind} missing for branch ${branchId}`);
  return a.id;
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
  as: Extract<LedgerEventType, 'SALE_VOID' | 'REVERSAL'>,
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
      return { branchId: id, branchCode: b.code, branchName: b.name, branchNameAr: b.nameAr, expectedCash: bal('CASH'), bank: bal('BANK'), fundsInTransit: bal('FUNDS_IN_TRANSIT'), hasadReceivable: bal('HASAD_RECEIVABLE') };
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
  CASH: ['SALES', 'VOIDS', 'SCRAP_PURCHASES', 'MAKING_CHARGES', 'OTHER'],
  BANK: ['SALES', 'VOIDS', 'SCRAP_PURCHASES', 'MAKING_CHARGES', 'HASAD_RECEIVABLE_SETTLEMENTS', 'OTHER'],
} as const;
export type ReconciliationLine = (typeof RECONCILIATION_LINES)['BANK'][number];
export const LINE_OF_EVENT: Partial<Record<LedgerEventType, ReconciliationLine>> = {
  SALE: 'SALES',
  SALE_VOID: 'VOIDS',
  SCRAP_PURCHASE: 'SCRAP_PURCHASES',
  SUPPLIER_MAKING_CHARGE: 'MAKING_CHARGES',
  HASAD_RECEIVABLE_SETTLEMENT: 'HASAD_RECEIVABLE_SETTLEMENTS',
};

/**
 * Event types that deliberately have NO line of their own and are shown under OTHER, each with its
 * reason. Every member of LEDGER_EVENT_TYPES must be either in LINE_OF_EVENT or here (guardrail test
 * in test/ledger.test.ts): adding an event type fails the build until someone decides where it goes.
 */
export const OTHER_EVENT_TYPES: Readonly<Partial<Record<LedgerEventType, string>>> = {
  // A generic correction that reverses an earlier entry of any kind; it has no business line of its
  // own (sale voids use SALE_VOID). Shown as "Other" so the day still adds up.
  REVERSAL: 'generic correction of an earlier entry; no business line of its own',
};

/** Group one account's entries into its reconciliation lines; their sum always equals the account's movement. */
export function reconciliationLines(kind: keyof typeof RECONCILIATION_LINES, entries: { kind: string; eventType: string; amount: number }[]) {
  const lines: readonly ReconciliationLine[] = RECONCILIATION_LINES[kind];
  const totals = new Map<ReconciliationLine, number[]>(lines.map((l) => [l, []]));
  for (const e of entries) {
    if (e.kind !== kind) continue;
    const own = LINE_OF_EVENT[e.eventType as LedgerEventType];
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
  const entries = await ctx.db
    .select({ amount: t.ledgerEntries.amount, eventType: t.ledgerEntries.eventType, paymentMethod: t.ledgerEntries.paymentMethod, kind: t.ledgerAccounts.kind })
    .from(t.ledgerEntries)
    .innerJoin(t.ledgerAccounts, eq(t.ledgerAccounts.id, t.ledgerEntries.accountId))
    .where(and(eq(t.ledgerEntries.branchId, branchId), gte(t.ledgerEntries.at, start), lt(t.ledgerEntries.at, end)));
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
  const countedBy = count ? (await ctx.db.select({ name: t.users.fullName }).from(t.users).where(eq(t.users.id, count.countedBy)))[0]?.name ?? null : null;
  return {
    branchId,
    day,
    openingCash,
    salesByMethod: methods.map((m) => ({ paymentMethod: m, amount: sum((e) => e.eventType === 'SALE' && e.paymentMethod === m) })),
    salesTotal: sum((e) => e.eventType === 'SALE'),
    voidsByMethod: methods.map((m) => ({ paymentMethod: m, amount: sum((e) => e.eventType === 'SALE_VOID' && e.paymentMethod === m) })),
    voidsTotal: sum((e) => e.eventType === 'SALE_VOID'),
    // Hasad's bank transfers received this day (receivable → bank; never the drawer).
    hasadReceivableToBank: sum((e) => e.eventType === 'HASAD_RECEIVABLE_SETTLEMENT' && e.kind === 'BANK'),
    // Phase 4: scrap bought from customers and supplier making charges, both paid out at once.
    scrapPurchasesCash: sum((e) => e.eventType === 'SCRAP_PURCHASE' && e.kind === 'CASH'),
    scrapPurchasesBank: sum((e) => e.eventType === 'SCRAP_PURCHASE' && e.kind === 'BANK'),
    makingChargesCash: sum((e) => e.eventType === 'SUPPLIER_MAKING_CHARGE' && e.kind === 'CASH'),
    makingChargesBank: sum((e) => e.eventType === 'SUPPLIER_MAKING_CHARGE' && e.kind === 'BANK'),
    cashLines: reconciliationLines('CASH', entries),
    bankLines: reconciliationLines('BANK', entries),
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

// ───────────────────────── Hasad receivable settled by bank transfer ─────────────────────────

/**
 * Hasad pays the shop by an ordinary bank transfer into the branch's bank account (client decision,
 * D-4-14). The branch manager (or the GM) records each transfer received: ONE transaction that
 *   (1) locks the branch's HASAD_RECEIVABLE account row (FOR UPDATE), so concurrent settlements are
 *       applied one after the other and can never take the receivable below zero,
 *   (2) refuses an amount above the current receivable balance (partial amounts are fine: Hasad pays
 *       in batches that need not match individual sales),
 *   (3) writes the settlement record and two entries that net to zero: −amount on HASAD_RECEIVABLE,
 *       +amount on BANK (same event type, same reference).
 */
export async function settleHasadReceivable(
  ctx: Ctx,
  actor: Actor,
  input: { branchId?: number; amount: number; bankReference?: string; note?: string },
  opts: { idem?: TxIdempotency; at?: Date } = {},
) {
  requirePerm(actor, 'cash.settle_hasad');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw badRequest('Invalid value for {field}', { field: 'amount' });
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [account] = await tx
      .select()
      .from(t.ledgerAccounts)
      .where(and(eq(t.ledgerAccounts.branchId, branchId), eq(t.ledgerAccounts.kind, 'HASAD_RECEIVABLE')))
      .for('update');
    if (!account) throw new Error(`ledger account HASAD_RECEIVABLE missing for branch ${branchId}`);
    const [{ balance }] = rows<{ balance: string | number }>(
      await tx.execute(sql`SELECT coalesce(sum(amount), 0)::bigint AS balance FROM ledger_entries WHERE account_id = ${account.id}`),
    );
    const receivable = Number(balance);
    if (input.amount > receivable) {
      throw badRequest('This is more than the Hasad receivable of this branch ({balance})', { balance: receivable.toLocaleString('en-US') });
    }
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, branchId));
    const number = await nextNumber(tx, branch.code, 'HRS');
    const [row] = await tx
      .insert(t.hasadReceivableSettlements)
      .values({
        number,
        branchId,
        amount: input.amount,
        bankReference: input.bankReference?.trim() || null,
        note: input.note?.trim() || null,
        actorId: actor.userId,
        sessionId: actor.sessionId,
        idempotencyKey: opts.idem?.key ?? null,
        at,
      })
      .returning();
    const ref = { refType: 'hasad_receivable_settlement', refId: row.id, refNumber: number };
    await post(
      tx,
      [
        { branchId, kind: 'HASAD_RECEIVABLE', amount: -input.amount, eventType: 'HASAD_RECEIVABLE_SETTLEMENT', paymentMethod: 'BANK_TRANSFER', ref, at },
        { branchId, kind: 'BANK', amount: input.amount, eventType: 'HASAD_RECEIVABLE_SETTLEMENT', paymentMethod: 'BANK_TRANSFER', ref, at },
      ],
      { actor, idempotencyKey: opts.idem?.key },
    );
    await writeAudit(tx, actor, {
      action: 'HASAD_RECEIVABLE_SETTLED',
      entityType: 'hasad_receivable_settlement',
      entityId: number,
      branchId,
      at,
      key: 'Hasad bank transfer {number} received: {amount} moved from the Hasad receivable to the bank',
      params: { number, amount: ap.money(input.amount) },
      metadata: { bankReference: input.bankReference ?? null, receivableBefore: receivable },
    });
    const result = { ...row, hasadReceivableBalance: receivable - input.amount };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** Hasad transfers recorded for one branch (own branch for a manager), newest first. */
export async function listHasadSettlements(ctx: Ctx, actor: Actor, q: { branchId?: number }) {
  requirePerm(actor, 'cash.view');
  const scope = branchScope(actor, q.branchId);
  return ctx.db
    .select({
      id: t.hasadReceivableSettlements.id,
      number: t.hasadReceivableSettlements.number,
      branchId: t.hasadReceivableSettlements.branchId,
      amount: t.hasadReceivableSettlements.amount,
      bankReference: t.hasadReceivableSettlements.bankReference,
      note: t.hasadReceivableSettlements.note,
      at: t.hasadReceivableSettlements.at,
      createdByName: t.users.fullName,
    })
    .from(t.hasadReceivableSettlements)
    .innerJoin(t.users, eq(t.users.id, t.hasadReceivableSettlements.actorId))
    .where(scope != null ? eq(t.hasadReceivableSettlements.branchId, scope) : undefined)
    .orderBy(desc(t.hasadReceivableSettlements.at), desc(t.hasadReceivableSettlements.id))
    .limit(200);
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
