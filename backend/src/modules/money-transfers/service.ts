// MNY-1 (plan docs/plans/MNY-1.md, D-mny1-*): money moving from a branch to another branch or to the General Manager.
//
//   * Send (branch manager of the sending branch, `money_transfers.send`): the amount, a required reason (3–300) and the
//     account it leaves (CASH or BANK; BANK needs its reference). The source account −X and the sending branch's
//     FUNDS_IN_TRANSIT +X; the drawer never goes below zero (409 DRAWER_SHORT). Status IN_TRANSIT.
//   * Confirm (`money_transfers.receive`): a transfer to a branch by that branch's manager, who chooses where it lands
//     (CASH or BANK, with its reference): FUNDS_IN_TRANSIT −X, the landing account +X. A transfer to the General Manager
//     by the General Manager only, nothing to choose: FUNDS_IN_TRANSIT −X, an exit from the branch books. RECEIVED.
//   * Cancel (the sending branch manager, a reason): the send's entries are reversed (the money back where it left).
//     CANCELLED. Nothing else gets a transfer out of IN_TRANSIT; a wrong amount is cancelled and sent again (owner).
//   * The General Manager never sends or cancels and never confirms a branch's transfer (D-mny1-2): checked here on the
//     actor's branch and role, whatever the permissions. OWED_TO_GM is never touched. No re-auth (owner, decision 7).
//   * One transaction per step; the Idempotency-Key claimed first; locks in a fixed order: the branch rows (send:
//     FOR SHARE, ascending id, against a deactivation), then the transfer row FOR UPDATE, then every ledger account
//     involved, of both branches, in ascending account id (`lockAccountsAcross`, D-csh-4). Every step is an
//     append-only `money_transfer_events` row and an audit row.

import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { t, type Executor } from '@jerp/database';
import { ap, validBankReference, type CashOrBank, type LedgerEventType, type MoneyTransferStatus } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { isGlobal, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { maxIdOf, runPaged, sumOf, type PageRequest, type SortSpec } from '../../core/paging';
import { rows } from '../../core/sql';
import type { TxIdempotency } from '../../core/idempotency';
import { lockAccountsAcross, post, requireDrawerCovers, reverseRef } from '../ledger/service';

export const REF_TYPE = 'money_transfer';
export const MONEY_TRANSFER_REASON_MIN = 3;
export const MONEY_TRANSFER_REASON_MAX = 300;

export interface SendInput {
  to: { branchId: number } | { generalManager: true };
  account: CashOrBank;
  amount: number;
  reason: string;
  bankReference?: string;
}
export interface ConfirmInput {
  /** Where it lands, for a transfer to a branch (the receiving manager chooses, owner Q1); none for the General Manager. */
  account?: CashOrBank;
  bankReference?: string;
}

const isGeneralManager = (actor: Actor) => actor.roleCode === 'GENERAL_MANAGER';
const paymentMethodOf = (account: CashOrBank) => (account === 'CASH' ? ('CASH' as const) : ('BANK_TRANSFER' as const));

function cleanReason(reason: string | undefined) {
  const r = reason?.trim() ?? '';
  if (r.length < MONEY_TRANSFER_REASON_MIN || r.length > MONEY_TRANSFER_REASON_MAX) {
    throw badRequest('Write the reason ({min} to {max} characters)', { min: MONEY_TRANSFER_REASON_MIN, max: MONEY_TRANSFER_REASON_MAX });
  }
  return r;
}
function bankReferenceFor(account: CashOrBank, given: string | undefined) {
  if (account !== 'BANK') {
    if (given?.trim()) throw badRequest('A bank reference is only for money that leaves or lands in the bank');
    return null;
  }
  const ref = validBankReference(given);
  if (!ref) throw badRequest('Enter the bank transfer reference (4 to 40 letters or digits)');
  return ref;
}

/** The branch rows of a step, FOR SHARE in ascending id: a deactivation (FOR UPDATE on the row) waits, or makes us wait. */
async function lockBranches(tx: Executor, ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const out = new Map<number, { id: number; code: string; name: string; nameAr: string; isActive: boolean }>();
  for (const id of sorted) {
    const [b] = await tx.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr, isActive: t.branches.isActive }).from(t.branches).where(eq(t.branches.id, id)).for('share');
    if (b) out.set(id, b);
  }
  return out;
}

/** The transfer row FOR UPDATE; a branch manager who is neither side gets 404 (no existence leak). */
async function lockTransfer(tx: Executor, actor: Actor, id: number) {
  const [tr] = await tx.select().from(t.moneyTransfers).where(eq(t.moneyTransfers.id, id)).for('update');
  if (!tr || !canSee(actor, tr)) throw notFound('Money transfer');
  return tr;
}
const canSee = (actor: Actor, tr: { fromBranchId: number; toBranchId: number | null }) => isGlobal(actor) || (actor.branchId != null && (tr.fromBranchId === actor.branchId || tr.toBranchId === actor.branchId));
const stateError = (status: string) =>
  new AppError(409, 'MONEY_TRANSFER_STATE', status === 'RECEIVED' ? 'This transfer was already confirmed' : 'This transfer was already cancelled', undefined, { status });

/** `POST /money-transfers`: send money from the own branch. */
export async function sendMoneyTransfer(ctx: Ctx, actor: Actor, input: SendInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'money_transfers.send');
  // D-mny1-2: only a branch manager sends, from the own branch (never the General Manager, whatever his grants).
  if (isGeneralManager(actor) || actor.branchId == null) throw forbidden('Only the manager of the sending branch sends money');
  const fromId = actor.branchId;
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw badRequest('The amount must be a whole number above 0');
  const reason = cleanReason(input.reason);
  const bankReference = bankReferenceFor(input.account, input.bankReference);
  const toGm = 'generalManager' in input.to && input.to.generalManager === true;
  const toId = toGm ? null : (input.to as { branchId: number }).branchId;
  if (!toGm && (!Number.isSafeInteger(toId) || toId == null)) throw badRequest('Choose the receiving branch');
  if (toId === fromId) throw badRequest('Choose another branch: money cannot be sent to the same branch');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const branches = await lockBranches(tx, toId == null ? [fromId] : [fromId, toId]);
    const from = branches.get(fromId);
    if (!from || !from.isActive) throw badRequest('Your branch is not active');
    const to = toId == null ? null : branches.get(toId);
    if (toId != null && (!to || !to.isActive)) throw badRequest('Choose an active branch');
    const locked = await lockAccountsAcross(tx, [
      { branchId: fromId, kind: input.account },
      { branchId: fromId, kind: 'FUNDS_IN_TRANSIT' },
    ]);
    // The drawer never goes below zero (D-csh-8); the bank is never blocked (A17 warns).
    if (input.account === 'CASH') requireDrawerCovers(locked.get(fromId, 'CASH').balance, input.amount, 'MONEY_TRANSFER');
    const number = await nextNumber(tx, from.code, 'MT');
    const [row] = await tx
      .insert(t.moneyTransfers)
      .values({ number, fromBranchId: fromId, toKind: toGm ? 'GM' : 'BRANCH', toBranchId: toId, sourceAccount: input.account, amount: input.amount, reason, bankReference, status: 'IN_TRANSIT', createdBy: actor.userId, createdAt: at, sessionId: actor.sessionId ?? null, idempotencyKey: opts.idem?.key ?? null })
      .returning();
    await tx.insert(t.moneyTransferEvents).values({ transferId: row.id, kind: 'SENT', actorId: actor.userId, sessionId: actor.sessionId ?? null, idempotencyKey: opts.idem?.key ?? null, at });
    const eventType: LedgerEventType = toGm ? 'MONEY_TRANSFER_TO_GM' : 'MONEY_TRANSFER_SENT';
    const ref = { refType: REF_TYPE, refId: row.id, refNumber: number };
    await post(
      tx,
      [
        { branchId: fromId, kind: input.account, amount: -input.amount, eventType, paymentMethod: paymentMethodOf(input.account), ref, at },
        { branchId: fromId, kind: 'FUNDS_IN_TRANSIT', amount: input.amount, eventType, paymentMethod: null, ref, at },
      ],
      { actor, idempotencyKey: opts.idem?.key },
    );
    await writeAudit(tx, actor, {
      action: 'MONEY_TRANSFER_SENT',
      entityType: REF_TYPE,
      entityId: number,
      branchId: fromId,
      at,
      key: toGm
        ? input.account === 'CASH'
          ? 'Money transfer {number}: {amount} from the drawer to the General Manager. Reason: {reason}'
          : 'Money transfer {number}: {amount} from the bank to the General Manager. Reason: {reason}'
        : input.account === 'CASH'
          ? 'Money transfer {number}: {amount} from the drawer to {to}. Reason: {reason}'
          : 'Money transfer {number}: {amount} from the bank to {to}. Reason: {reason}',
      params: { number, amount: ap.money(input.amount), reason, to: to ? ap.text(to.name, to.nameAr) : '' },
      metadata: { transferId: row.id, fromBranchId: fromId, toKind: row.toKind, toBranchId: toId, account: input.account, amount: input.amount, bankReference },
    });
    await opts.idem?.complete(tx, row);
    return row;
  });
}

/** `POST /money-transfers/:id/confirm`: the receiver confirms it received the amount. */
export async function confirmMoneyTransfer(ctx: Ctx, actor: Actor, id: number, input: ConfirmInput, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'money_transfers.receive');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    // The branch rows first (the order a send takes them), then the transfer row.
    const [peek] = await tx.select({ fromBranchId: t.moneyTransfers.fromBranchId, toBranchId: t.moneyTransfers.toBranchId }).from(t.moneyTransfers).where(eq(t.moneyTransfers.id, id));
    if (!peek || !canSee(actor, peek)) throw notFound('Money transfer');
    const branches = await lockBranches(tx, peek.toBranchId == null ? [peek.fromBranchId] : [peek.fromBranchId, peek.toBranchId]);
    const tr = await lockTransfer(tx, actor, id);
    const toGm = tr.toKind === 'GM';
    // D-mny1-2: the receiver confirms; never the sender, never the General Manager for a branch.
    if (toGm ? !isGeneralManager(actor) : actor.branchId !== tr.toBranchId) {
      throw forbidden(toGm ? 'Only the General Manager confirms a transfer addressed to him' : 'Only the manager of the receiving branch confirms this transfer');
    }
    if (tr.status !== 'IN_TRANSIT') throw stateError(tr.status);
    let landing: CashOrBank | null = null;
    let bankReference: string | null = null;
    if (toGm) {
      if (input.account || input.bankReference) throw badRequest('Nothing to choose: money handed to the General Manager leaves the branch');
    } else {
      if (input.account !== 'CASH' && input.account !== 'BANK') throw badRequest('Choose where the money is: the drawer or the bank');
      landing = input.account;
      bankReference = bankReferenceFor(landing, input.bankReference);
    }
    await lockAccountsAcross(tx, [{ branchId: tr.fromBranchId, kind: 'FUNDS_IN_TRANSIT' }, ...(landing ? [{ branchId: tr.toBranchId!, kind: landing }] : [])]);
    await tx.update(t.moneyTransfers).set({ status: 'RECEIVED' }).where(and(eq(t.moneyTransfers.id, id), eq(t.moneyTransfers.status, 'IN_TRANSIT')));
    await tx.insert(t.moneyTransferEvents).values({ transferId: id, kind: 'RECEIVED', account: landing, bankReference, actorId: actor.userId, sessionId: actor.sessionId ?? null, idempotencyKey: opts.idem?.key ?? null, at });
    const ref = { refType: REF_TYPE, refId: id, refNumber: tr.number };
    const eventType: LedgerEventType = toGm ? 'MONEY_TRANSFER_TO_GM' : 'MONEY_TRANSFER_RECEIVED';
    await post(
      tx,
      [
        { branchId: tr.fromBranchId, kind: 'FUNDS_IN_TRANSIT', amount: -tr.amount, eventType, paymentMethod: null, ref, at },
        ...(landing ? [{ branchId: tr.toBranchId!, kind: landing, amount: tr.amount, eventType, paymentMethod: paymentMethodOf(landing), ref, at }] : []),
      ],
      { actor, idempotencyKey: opts.idem?.key },
    );
    const from = branches.get(tr.fromBranchId)!;
    await writeAudit(tx, actor, {
      action: 'MONEY_TRANSFER_RECEIVED',
      entityType: REF_TYPE,
      entityId: tr.number,
      branchId: tr.toBranchId ?? tr.fromBranchId,
      at,
      key: toGm
        ? 'Money transfer {number}: {amount} from {from} received by the General Manager'
        : landing === 'CASH'
          ? 'Money transfer {number}: {amount} from {from} received into the drawer'
          : 'Money transfer {number}: {amount} from {from} received into the bank',
      params: { number: tr.number, amount: ap.money(tr.amount), from: ap.text(from.name, from.nameAr) },
      metadata: { transferId: id, account: landing, bankReference, amount: tr.amount },
    });
    const result = { ...tr, status: 'RECEIVED' as MoneyTransferStatus };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** `POST /money-transfers/:id/cancel`: the sender takes it back (a reason); the money returns where it left. */
export async function cancelMoneyTransfer(ctx: Ctx, actor: Actor, id: number, input: { reason?: string }, opts: { at?: Date; idem?: TxIdempotency } = {}) {
  requirePerm(actor, 'money_transfers.send');
  const reason = cleanReason(input.reason);
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [peek] = await tx.select({ fromBranchId: t.moneyTransfers.fromBranchId, toBranchId: t.moneyTransfers.toBranchId }).from(t.moneyTransfers).where(eq(t.moneyTransfers.id, id));
    if (!peek || !canSee(actor, peek)) throw notFound('Money transfer');
    await lockBranches(tx, peek.toBranchId == null ? [peek.fromBranchId] : [peek.fromBranchId, peek.toBranchId]);
    const tr = await lockTransfer(tx, actor, id);
    if (isGeneralManager(actor) || actor.branchId !== tr.fromBranchId) throw forbidden('Only the manager of the sending branch cancels this transfer');
    if (tr.status !== 'IN_TRANSIT') throw stateError(tr.status);
    const source = tr.sourceAccount as CashOrBank;
    await lockAccountsAcross(tx, [
      { branchId: tr.fromBranchId, kind: source },
      { branchId: tr.fromBranchId, kind: 'FUNDS_IN_TRANSIT' },
    ]);
    await tx.update(t.moneyTransfers).set({ status: 'CANCELLED' }).where(and(eq(t.moneyTransfers.id, id), eq(t.moneyTransfers.status, 'IN_TRANSIT')));
    await tx.insert(t.moneyTransferEvents).values({ transferId: id, kind: 'CANCELLED', reason, actorId: actor.userId, sessionId: actor.sessionId ?? null, idempotencyKey: opts.idem?.key ?? null, at });
    const sent: LedgerEventType = tr.toKind === 'GM' ? 'MONEY_TRANSFER_TO_GM' : 'MONEY_TRANSFER_SENT';
    const reversed = await reverseRef(tx, { refType: REF_TYPE, refId: id, refNumber: tr.number }, sent, 'MONEY_TRANSFER_CANCELLED', { actor, idempotencyKey: opts.idem?.key }, { note: reason, at });
    if (reversed !== 2) throw new Error(`money transfer ${tr.number}: expected 2 send entries to reverse, found ${reversed}`);
    await writeAudit(tx, actor, {
      action: 'MONEY_TRANSFER_CANCELLED',
      entityType: REF_TYPE,
      entityId: tr.number,
      branchId: tr.fromBranchId,
      at,
      key: source === 'CASH' ? 'Money transfer {number} cancelled: {amount} back into the drawer. Reason: {reason}' : 'Money transfer {number} cancelled: {amount} back into the bank. Reason: {reason}',
      params: { number: tr.number, amount: ap.money(tr.amount), reason },
      metadata: { transferId: id, account: source, amount: tr.amount, reason },
    });
    const result = { ...tr, status: 'CANCELLED' as MoneyTransferStatus };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

// ───────────────────────── reads ─────────────────────────

const fromB = alias(t.branches, 'from_branch');
const toB = alias(t.branches, 'to_branch');
const sender = alias(t.users, 'sender');
const closeEvent = alias(t.moneyTransferEvents, 'close_event');
const closer = alias(t.users, 'closer');

/** Every column a list row and the detail show: who sent, who closed it (confirmed or cancelled), when and why. */
const columns = {
  id: t.moneyTransfers.id,
  number: t.moneyTransfers.number,
  fromBranchId: t.moneyTransfers.fromBranchId,
  fromBranchName: fromB.name,
  fromBranchNameAr: fromB.nameAr,
  toKind: t.moneyTransfers.toKind,
  toBranchId: t.moneyTransfers.toBranchId,
  toBranchName: toB.name,
  toBranchNameAr: toB.nameAr,
  sourceAccount: t.moneyTransfers.sourceAccount,
  amount: t.moneyTransfers.amount,
  reason: t.moneyTransfers.reason,
  bankReference: t.moneyTransfers.bankReference,
  status: t.moneyTransfers.status,
  createdAt: t.moneyTransfers.createdAt,
  createdByName: sender.fullName,
  closedAt: closeEvent.at,
  closedByName: closer.fullName,
  /** Where it landed (a confirmed transfer to a branch). */
  landedAccount: closeEvent.account,
  landedBankReference: closeEvent.bankReference,
  /** Why it was cancelled. */
  cancelReason: closeEvent.reason,
};

const baseQuery = (exec: Executor) =>
  exec
    .select(columns)
    .from(t.moneyTransfers)
    .innerJoin(fromB, eq(fromB.id, t.moneyTransfers.fromBranchId))
    .leftJoin(toB, eq(toB.id, t.moneyTransfers.toBranchId))
    .innerJoin(sender, eq(sender.id, t.moneyTransfers.createdBy))
    .leftJoin(closeEvent, and(eq(closeEvent.transferId, t.moneyTransfers.id), inArray(closeEvent.kind, ['RECEIVED', 'CANCELLED'])))
    .leftJoin(closer, eq(closer.id, closeEvent.actorId));

export const MONEY_TRANSFER_SORT_KEYS = ['date', 'amount'] as const;
export type MoneyTransferSortKey = (typeof MONEY_TRANSFER_SORT_KEYS)[number];
const sorts: Record<MoneyTransferSortKey, SortSpec> = {
  date: { by: t.moneyTransfers.createdAt, field: 'createdAt', dir: 'desc' },
  amount: { by: t.moneyTransfers.amount, field: 'amount', dir: 'desc' },
};

/**
 * `GET /money-transfers`: a branch manager sees the own branch's transfers (sent or received); the General Manager
 * every transfer (or one branch's, as sender or receiver). `direction`: IN (to the branch, or to the General
 * Manager for him), OUT (from the branch).
 */
export async function listMoneyTransfers(ctx: Ctx, actor: Actor, q: { branchId?: number; status?: MoneyTransferStatus; direction?: 'IN' | 'OUT' } & PageRequest<MoneyTransferSortKey>) {
  requirePerm(actor, 'money_transfers.view');
  const global = isGlobal(actor);
  if (!global && actor.branchId == null) throw forbidden('Your account is not assigned to a branch');
  if (!global && q.branchId != null && q.branchId !== actor.branchId) throw forbidden('You can only access data of your own branch');
  const scope = global ? (q.branchId ?? null) : actor.branchId;
  const where: SQL[] = [];
  if (q.status) where.push(eq(t.moneyTransfers.status, q.status));
  if (scope != null) {
    if (q.direction === 'IN') where.push(eq(t.moneyTransfers.toBranchId, scope));
    else if (q.direction === 'OUT') where.push(eq(t.moneyTransfers.fromBranchId, scope));
    else where.push(or(eq(t.moneyTransfers.fromBranchId, scope), eq(t.moneyTransfers.toBranchId, scope))!);
  } else if (q.direction === 'IN') where.push(eq(t.moneyTransfers.toKind, 'GM'));
  return runPaged(actor, q, {
    sorts,
    defaultSort: 'date',
    id: t.moneyTransfers.id,
    where,
    maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.moneyTransfers.id) }).from(t.moneyTransfers))[0].m),
    count: async (w) => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.moneyTransfers).where(w))[0].n),
    totals: async (w) => {
      const [r] = await ctx.db
        .select({ count: sql<number>`count(*)`.mapWith(Number), amount: sumOf(t.moneyTransfers.amount), inTransit: sumOf(sql`CASE WHEN ${t.moneyTransfers.status} = 'IN_TRANSIT' THEN ${t.moneyTransfers.amount} END`) })
        .from(t.moneyTransfers)
        .where(w);
      return r;
    },
    rows: ({ where: w, orderBy, limit, offset }) =>
      baseQuery(ctx.db)
        .where(w)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
  });
}

/** `GET /money-transfers/:id`: the transfer and its steps (who, when, where it landed, why it was cancelled). */
export async function getMoneyTransfer(ctx: Ctx, actor: Actor, id: number) {
  requirePerm(actor, 'money_transfers.view');
  const [row] = await baseQuery(ctx.db).where(eq(t.moneyTransfers.id, id));
  if (!row || !canSee(actor, row)) throw notFound('Money transfer');
  const actorU = alias(t.users, 'step_actor');
  const events = await ctx.db
    .select({ id: t.moneyTransferEvents.id, kind: t.moneyTransferEvents.kind, account: t.moneyTransferEvents.account, bankReference: t.moneyTransferEvents.bankReference, reason: t.moneyTransferEvents.reason, at: t.moneyTransferEvents.at, actorName: actorU.fullName })
    .from(t.moneyTransferEvents)
    .innerJoin(actorU, eq(actorU.id, t.moneyTransferEvents.actorId))
    .where(eq(t.moneyTransferEvents.transferId, id))
    .orderBy(asc(t.moneyTransferEvents.id));
  return Object.assign({}, row, { events });
}

/** Money in transit per sending branch (IN_TRANSIT transfers); equals each branch's FUNDS_IN_TRANSIT balance. */
export async function inTransitByBranch(exec: Executor): Promise<Map<number, number>> {
  const res = await exec.execute(sql`SELECT from_branch_id AS b, coalesce(sum(amount), 0)::bigint AS s FROM money_transfers WHERE status = 'IN_TRANSIT' GROUP BY from_branch_id`);
  return new Map(rows<{ b: number; s: number | string }>(res).map((r) => [Number(r.b), Number(r.s)]));
}

/** The transfers in transit from or to a branch (a branch with any cannot be deactivated). */
export async function transfersInTransitOf(exec: Executor, branchId: number): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(t.moneyTransfers)
    .where(and(eq(t.moneyTransfers.status, 'IN_TRANSIT'), or(eq(t.moneyTransfers.fromBranchId, branchId), eq(t.moneyTransfers.toBranchId, branchId))));
  return r.n;
}
