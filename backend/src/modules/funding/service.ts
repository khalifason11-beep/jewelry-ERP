// CSH-2 piece B (docs/plans/CSH-2.md §3, D-csh-1…D-csh-5): the General Manager's money into a branch and back.
//
//   * GM_ADVANCE  X to CASH or BANK:   CASH|BANK +X and OWED_TO_GM +X, in one transaction.
//   * GM_REPAYMENT X from CASH or BANK: CASH|BANK −X and OWED_TO_GM −X; never more than the branch owes him.
//   * A wrong event is corrected by a REVERSAL (at most one per event): both ledger entries are reversed.
//   * "Owed to the General Manager" = the OWED_TO_GM account's balance, SUM(amount): derived, never an edited field.
//
// Every check on a balance runs under `lockAccounts` (ascending account id, D-csh-4), so two repayments, or a
// repayment and the correction of an advance, can never take the amount owed below zero. General Manager only
// (`funding.view`, `funding.manage`); every write needs the password re-confirmation (route matrix) and an
// Idempotency-Key claimed inside this transaction. No backdating (Q12): `at` is the recording time; the reason
// says when the money actually moved.

import { desc, eq, inArray, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { ap, sumInt, validBankReference, type CashOrBank, type LedgerAccountKind } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, conflict, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { rows } from '../../core/sql';
import type { TxIdempotency } from '../../core/idempotency';
import { lockAccounts, post, requireDrawerCovers, reverseRef } from '../ledger/service';

export interface FundingInput {
  branchId: number;
  account: CashOrBank;
  amount: number;
  reason: string;
  bankReference?: string;
  /** Q5, display only: the General Manager paid a seller directly from his own money. */
  paidDirectlyToSeller?: boolean;
  /** Q5, display only: the purchase number this advance paid for. */
  linkedRef?: string;
}

const REF_TYPE = 'gm_funding_event';
const fmt = (n: number) => n.toLocaleString('en-US');

/** What each branch owes the General Manager now (the OWED_TO_GM balances), by branch id. */
export async function owedToGm(exec: Ctx['db'], branchId: number | null): Promise<Map<number, number>> {
  const res = await exec.execute(sql`
    SELECT a.branch_id AS "branchId", coalesce(sum(e.amount), 0)::bigint AS owed
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
    WHERE a.kind = 'OWED_TO_GM' ${branchId != null ? sql`AND a.branch_id = ${branchId}` : sql``}
    GROUP BY a.branch_id`);
  return new Map(rows<{ branchId: number; owed: number | string }>(res).map((r) => [Number(r.branchId), Number(r.owed)]));
}

function checkInput(input: FundingInput): { reason: string; bankReference: string | null; linkedRef: string | null } {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw badRequest('Invalid value for {field}', { field: 'amount' });
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 300) throw badRequest('Write the reason (3 to 300 characters)');
  let bankReference: string | null = null;
  if (input.account === 'BANK') {
    bankReference = validBankReference(input.bankReference);
    if (!bankReference) throw badRequest('Enter the bank transfer reference (4 to 40 letters or digits)');
  }
  const linkedRef = input.linkedRef?.trim().toUpperCase() || null;
  if (linkedRef && (linkedRef.length < 3 || linkedRef.length > 40)) throw badRequest('Invalid value for {field}', { field: 'linkedRef' });
  return { reason, bankReference, linkedRef };
}

async function record(ctx: Ctx, actor: Actor, kind: 'ADVANCE' | 'REPAYMENT', input: FundingInput, opts: { idem?: TxIdempotency; at?: Date }) {
  requirePerm(actor, 'funding.manage');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  const { reason, bankReference, linkedRef } = checkInput(input);
  if (kind === 'REPAYMENT' && (input.paidDirectlyToSeller || linkedRef)) throw badRequest('Only an advance can be marked as paid directly to a seller');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, branchId));
    if (!branch) throw notFound('Branch');
    const money: LedgerAccountKind = input.account;
    const locked = await lockAccounts(tx, branchId, ['OWED_TO_GM', money]);
    const owedBefore = locked.OWED_TO_GM.balance;
    if (kind === 'REPAYMENT' && input.amount > owedBefore) {
      throw badRequest('This is more than the branch owes the General Manager ({owed}). Record at most {owed}', { owed: fmt(owedBefore) });
    }
    // CSH-2 (Q7): a repayment from the drawer needs the drawer to hold it (BLOCK); from the bank it is never blocked.
    if (kind === 'REPAYMENT' && money === 'CASH') requireDrawerCovers(locked.CASH.balance, input.amount, 'GM_REPAYMENT');
    const number = await nextNumber(tx, branch.code, kind === 'ADVANCE' ? 'GMA' : 'GMR');
    const [row] = await tx
      .insert(t.gmFundingEvents)
      .values({
        number,
        branchId,
        kind,
        account: input.account,
        amount: input.amount,
        reason,
        bankReference,
        paidDirectlyToSeller: kind === 'ADVANCE' && !!input.paidDirectlyToSeller,
        linkedRef: kind === 'ADVANCE' ? linkedRef : null,
        actorId: actor.userId,
        sessionId: actor.sessionId,
        idempotencyKey: opts.idem?.key ?? null,
        at,
      })
      .returning();
    const sign = kind === 'ADVANCE' ? 1 : -1;
    const eventType = kind === 'ADVANCE' ? 'GM_ADVANCE' : 'GM_REPAYMENT';
    const ref = { refType: REF_TYPE, refId: row.id, refNumber: number };
    await post(
      tx,
      [
        { branchId, kind: money, amount: sign * input.amount, eventType, paymentMethod: input.account === 'CASH' ? 'CASH' : 'BANK_TRANSFER', ref, at },
        { branchId, kind: 'OWED_TO_GM', amount: sign * input.amount, eventType, paymentMethod: null, ref, at },
      ],
      { actor, idempotencyKey: opts.idem?.key },
    );
    const owedAfter = owedBefore + sign * input.amount;
    await writeAudit(tx, actor, {
      action: kind === 'ADVANCE' ? 'GM_ADVANCE_RECORDED' : 'GM_REPAYMENT_RECORDED',
      entityType: REF_TYPE,
      entityId: number,
      branchId,
      at,
      key:
        kind === 'ADVANCE'
          ? input.account === 'CASH'
            ? 'Advance {number} from the General Manager: {amount} into the drawer. Reason: {reason}'
            : 'Advance {number} from the General Manager: {amount} into the bank. Reason: {reason}'
          : input.account === 'CASH'
            ? 'Repayment {number} to the General Manager: {amount} from the drawer. Reason: {reason}'
            : 'Repayment {number} to the General Manager: {amount} from the bank. Reason: {reason}',
      params: { number, amount: ap.money(input.amount), reason },
      metadata: { owedBefore, owedAfter, bankReference, paidDirectlyToSeller: row.paidDirectlyToSeller, linkedRef: row.linkedRef },
    });
    const result = { ...row, owedToGm: owedAfter };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/** The General Manager puts money into a branch's drawer or bank, as a loan to the branch. */
export const recordAdvance = (ctx: Ctx, actor: Actor, input: FundingInput, opts: { idem?: TxIdempotency; at?: Date } = {}) => record(ctx, actor, 'ADVANCE', input, opts);

/** The branch returns money to the General Manager from its drawer or bank (never more than it owes him). */
export const recordRepayment = (ctx: Ctx, actor: Actor, input: FundingInput, opts: { idem?: TxIdempotency; at?: Date } = {}) => record(ctx, actor, 'REPAYMENT', input, opts);

/**
 * Correct a wrong advance or repayment: a REVERSAL event and the reversal of both its ledger entries. An event is
 * corrected at most once (unique index + check under the lock). Correcting an advance lowers the amount owed, so it
 * is refused when the advance has already been repaid so far that the branch would owe less than nothing.
 */
export async function correctFunding(ctx: Ctx, actor: Actor, eventId: number, input: { reason: string }, opts: { idem?: TxIdempotency; at?: Date } = {}) {
  requirePerm(actor, 'funding.manage');
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 300) throw badRequest('Write the reason (3 to 300 characters)');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [orig] = await tx.select().from(t.gmFundingEvents).where(eq(t.gmFundingEvents.id, eventId));
    if (!orig) throw notFound('Funding event');
    branchScope(actor, orig.branchId);
    if (orig.kind === 'REVERSAL') throw badRequest('A correction cannot itself be corrected');
    const locked = await lockAccounts(tx, orig.branchId, ['OWED_TO_GM', orig.account as LedgerAccountKind]);
    const [done] = await tx.select({ id: t.gmFundingEvents.id }).from(t.gmFundingEvents).where(eq(t.gmFundingEvents.reversesEventId, orig.id));
    if (done) throw conflict('This event has already been corrected');
    const owedBefore = locked.OWED_TO_GM.balance;
    const owedAfter = owedBefore + (orig.kind === 'ADVANCE' ? -orig.amount : orig.amount);
    if (owedAfter < 0) {
      throw badRequest('This advance has already been repaid in part: correcting it would leave the branch owing less than nothing ({owed} owed now). Correct the repayment first', {
        owed: fmt(owedBefore),
      });
    }
    // CSH-2 (Q7): correcting an advance into the drawer takes that money back out of it (BLOCK when it is not there).
    if (orig.kind === 'ADVANCE' && orig.account === 'CASH') requireDrawerCovers(locked.CASH.balance, orig.amount, 'GM_CORRECTION');
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, orig.branchId));
    const number = await nextNumber(tx, branch.code, 'GMX');
    const [row] = await tx
      .insert(t.gmFundingEvents)
      .values({
        number,
        branchId: orig.branchId,
        kind: 'REVERSAL',
        account: orig.account,
        amount: orig.amount,
        reason,
        reversesEventId: orig.id,
        actorId: actor.userId,
        sessionId: actor.sessionId,
        idempotencyKey: opts.idem?.key ?? null,
        at,
      })
      .returning();
    const n = await reverseRef(
      tx,
      { refType: REF_TYPE, refId: orig.id, refNumber: orig.number },
      orig.kind === 'ADVANCE' ? 'GM_ADVANCE' : 'GM_REPAYMENT',
      'REVERSAL',
      { actor, idempotencyKey: opts.idem?.key },
      { note: number, at },
    );
    if (n !== 2) throw new Error(`funding event ${orig.number}: expected 2 ledger entries to reverse, found ${n}`);
    await writeAudit(tx, actor, {
      action: 'GM_FUNDING_CORRECTED',
      entityType: REF_TYPE,
      entityId: number,
      branchId: orig.branchId,
      at,
      key: 'Correction {number} of {original} ({amount}). Reason: {reason}',
      params: { number, original: orig.number, amount: ap.money(orig.amount), reason },
      metadata: { owedBefore, owedAfter, correctedKind: orig.kind },
    });
    const result = { ...row, owedToGm: owedAfter };
    await opts.idem?.complete(tx, result);
    return result;
  });
}

/**
 * The funding view of the Cash page (General Manager only): what each branch owes him, the company total, and the
 * history of one branch or all (newest first, 50 per page). Each event says whether it has been corrected.
 */
export async function fundingView(ctx: Ctx, actor: Actor, q: { branchId?: number; offset?: number }) {
  requirePerm(actor, 'funding.view');
  const scope = branchScope(actor, q.branchId);
  const branches = await ctx.db.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).orderBy(t.branches.id);
  const owed = await owedToGm(ctx.db, null);
  const limit = 50;
  const offset = Math.max(0, q.offset ?? 0);
  const where = scope != null ? eq(t.gmFundingEvents.branchId, scope) : undefined;
  const events = await ctx.db
    .select({
      id: t.gmFundingEvents.id,
      number: t.gmFundingEvents.number,
      branchId: t.gmFundingEvents.branchId,
      kind: t.gmFundingEvents.kind,
      account: t.gmFundingEvents.account,
      amount: t.gmFundingEvents.amount,
      reason: t.gmFundingEvents.reason,
      bankReference: t.gmFundingEvents.bankReference,
      paidDirectlyToSeller: t.gmFundingEvents.paidDirectlyToSeller,
      linkedRef: t.gmFundingEvents.linkedRef,
      reversesEventId: t.gmFundingEvents.reversesEventId,
      at: t.gmFundingEvents.at,
      createdByName: t.users.fullName,
    })
    .from(t.gmFundingEvents)
    .innerJoin(t.users, eq(t.users.id, t.gmFundingEvents.actorId))
    .where(where)
    .orderBy(desc(t.gmFundingEvents.at), desc(t.gmFundingEvents.id))
    .limit(limit + 1)
    .offset(offset);
  const ids = events.map((e) => e.id);
  const corrected = ids.length
    ? new Set((await ctx.db.select({ id: t.gmFundingEvents.reversesEventId }).from(t.gmFundingEvents).where(inArray(t.gmFundingEvents.reversesEventId, ids))).map((r) => r.id))
    : new Set<number | null>();
  const list = scope != null ? branches.filter((b) => b.id === scope) : branches;
  return {
    branches: list.map((b) => ({ branchId: b.id, branchCode: b.code, branchName: b.name, branchNameAr: b.nameAr, owedToGm: owed.get(b.id) ?? 0 })),
    totalOwedToGm: sumInt(list.map((b) => owed.get(b.id) ?? 0)),
    events: events.slice(0, limit).map((e) => ({ ...e, corrected: corrected.has(e.id) })),
    hasMore: events.length > limit,
    offset,
  };
}

/** For tests and the guardrail: the OWED_TO_GM balance of one branch read straight from the ledger. */
export async function owedOf(ctx: Ctx, branchId: number): Promise<number> {
  return (await owedToGm(ctx.db, branchId)).get(branchId) ?? 0;
}

