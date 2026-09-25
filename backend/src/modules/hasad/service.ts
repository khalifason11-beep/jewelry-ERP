// Hasad Gold withdrawal redemption at the branch counter.
//
//   Hasad request received ─► (no inventory impact)
//   Customer arrives ─► cashier OPENS the request (identity verified)
//   Customer picks a piece ─► THAT item AVAILABLE → RESERVED
//   Settlement calculated from real weights ─► cashier confirms with customer
//   COMPLETE ─► item RESERVED → REDEEMED, ledger HASAD_REDEMPTION, Hasad notified
//   ABORT/CANCEL ─► item RESERVED → AVAILABLE

import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import { calculateSettlement, formatWeight, type HasadWithdrawalStatus, type PaymentMethod, type SettlementResult } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requireAny, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { dayRange } from '../../core/time';
import { changeStatus, itemQuery, lockItems, recordMovement } from '../inventory/ledger';
import { syncWithdrawals } from './sync';

type WithdrawalRow = typeof t.hasadWithdrawals.$inferSelect;
type RedemptionRow = typeof t.hasadRedemptions.$inferSelect;

// ───────────────────────── queries ─────────────────────────

export interface WithdrawalQuery {
  branchId?: number;
  status?: HasadWithdrawalStatus[];
  q?: string;
  from?: string;
  to?: string;
}

export async function listWithdrawals(ctx: Ctx, actor: Actor, q: WithdrawalQuery) {
  requireAny(actor, 'hasad.process', 'hasad.view');
  const scope = branchScope(actor, q.branchId);
  await releaseStaleReservations(ctx);
  const sync = await syncWithdrawals(ctx);

  const where: SQL[] = [];
  if (scope != null) where.push(eq(t.hasadWithdrawals.branchId, scope));
  if (q.status?.length) where.push(inArray(t.hasadWithdrawals.status, q.status));
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(
      or(
        ilike(t.hasadWithdrawals.externalId, s),
        ilike(t.hasadWithdrawals.customerName, s),
        ilike(t.hasadWithdrawals.customerNameAr, s),
        ilike(t.hasadWithdrawals.customerPhone, s),
        ilike(t.hasadWithdrawals.hasadCustomerId, s),
      )!,
    );
  }
  if (q.from && q.to) {
    const { company } = await ctx.settings.get();
    const r = dayRange(q.from, q.to, company.timezone);
    where.push(gte(t.hasadWithdrawals.requestedAt, r.start), lt(t.hasadWithdrawals.requestedAt, r.end));
  }
  const rowsAll = await ctx.db
    .select({
      w: t.hasadWithdrawals,
      branchName: t.branches.name,
      branchNameAr: t.branches.nameAr,
      redemptionNumber: sql<string | null>`(select r.number from hasad_redemptions r where r.withdrawal_id = ${t.hasadWithdrawals.id} and r.status <> 'ABORTED' order by r.id desc limit 1)`,
      deliveredWeightMg: sql<number | null>`(select r.delivered_weight_mg from hasad_redemptions r where r.withdrawal_id = ${t.hasadWithdrawals.id} and r.status = 'COMPLETED' limit 1)`,
      settlementDirection: sql<string | null>`(select r.settlement_direction from hasad_redemptions r where r.withdrawal_id = ${t.hasadWithdrawals.id} and r.status = 'COMPLETED' limit 1)`,
      settlementAmount: sql<number | null>`(select r.settlement_amount from hasad_redemptions r where r.withdrawal_id = ${t.hasadWithdrawals.id} and r.status = 'COMPLETED' limit 1)`,
      reservedCount: sql<number>`(select count(*) from hasad_redemption_items ri join hasad_redemptions r on r.id = ri.redemption_id where r.withdrawal_id = ${t.hasadWithdrawals.id} and r.status = 'DRAFT' and ri.active)`,
      openedByName: sql<string | null>`(select full_name from users where id = ${t.hasadWithdrawals.openedBy})`,
      completedByName: sql<string | null>`(select full_name from users where id = ${t.hasadWithdrawals.completedBy})`,
    })
    .from(t.hasadWithdrawals)
    .innerJoin(t.branches, eq(t.branches.id, t.hasadWithdrawals.branchId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(
      sql`case ${t.hasadWithdrawals.status} when 'IN_PROGRESS' then 0 when 'READY_FOR_PICKUP' then 1 else 2 end`,
      desc(t.hasadWithdrawals.requestedAt),
    )
    .limit(500);

  return {
    syncError: sync.error,
    syncedAt: sync.syncedAt,
    mode: ctx.hasad.mode,
    withdrawals: rowsAll.map((r) => ({
      ...publicWithdrawal(r.w, actor),
      branchName: r.branchName,
      branchNameAr: r.branchNameAr,
      redemptionNumber: r.redemptionNumber,
      deliveredWeightMg: r.deliveredWeightMg != null ? Number(r.deliveredWeightMg) : null,
      settlementDirection: r.settlementDirection,
      settlementAmount: r.settlementAmount != null ? Number(r.settlementAmount) : null,
      reservedCount: Number(r.reservedCount),
      openedByName: r.openedByName,
      completedByName: r.completedByName,
    })),
  };
}

/** The pickup code is a secret the customer presents — never sent to the browser. */
function publicWithdrawal(w: WithdrawalRow, _actor: Actor) {
  const { pickupCode, ...rest } = w;
  return { ...rest, hasPickupCode: !!pickupCode };
}

async function loadWithdrawal(exec: Executor, actor: Actor, id: number) {
  const [w] = await exec.select().from(t.hasadWithdrawals).where(eq(t.hasadWithdrawals.id, id));
  if (!w) throw notFound('Withdrawal request');
  branchScope(actor, w.branchId);
  return w;
}

async function draftRedemption(exec: Executor, withdrawalId: number) {
  const [r] = await exec
    .select()
    .from(t.hasadRedemptions)
    .where(and(eq(t.hasadRedemptions.withdrawalId, withdrawalId), eq(t.hasadRedemptions.status, 'DRAFT')));
  return r ?? null;
}

async function activeItems(exec: Executor, redemptionId: number) {
  return exec
    .select({
      redemptionItemId: t.hasadRedemptionItems.id,
      id: t.jewelryItems.id,
      code: t.jewelryItems.code,
      barcode: t.jewelryItems.barcode,
      productName: t.products.name,
      productNameAr: t.products.nameAr,
      categoryCode: t.categories.code,
      karat: t.jewelryItems.karat,
      grossWeightMg: t.jewelryItems.grossWeightMg,
      netWeightMg: t.jewelryItems.netWeightMg,
      sellingPrice: t.jewelryItems.sellingPrice,
      totalCost: t.jewelryItems.totalCost,
      status: t.jewelryItems.status,
      reservedAt: t.jewelryItems.reservedAt,
    })
    .from(t.hasadRedemptionItems)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.hasadRedemptionItems.itemId))
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .innerJoin(t.categories, eq(t.categories.id, t.products.categoryId))
    .where(and(eq(t.hasadRedemptionItems.redemptionId, redemptionId), eq(t.hasadRedemptionItems.active, true)))
    .orderBy(asc(t.hasadRedemptionItems.addedAt));
}

/** Server-authoritative settlement using current rates and settings. */
export async function computeSettlement(
  ctx: Ctx,
  w: Pick<WithdrawalRow, 'entitledWeightMg' | 'entitlementKarat'>,
  items: { netWeightMg: number; karat: number }[],
): Promise<SettlementResult & { rateKarats: number[] }> {
  const [settings, rates] = await Promise.all([ctx.settings.get(), ctx.settings.goldRates()]);
  let rate: number;
  if (settings.hasad.rateSource === 'ENTITLEMENT_KARAT' || !items.length) {
    rate = rates[w.entitlementKarat]?.pricePerGram ?? 0;
  } else {
    const totalW = items.reduce((s, i) => s + i.netWeightMg, 0);
    rate = Math.round(items.reduce((s, i) => s + (rates[i.karat]?.pricePerGram ?? 0) * i.netWeightMg, 0) / (totalW || 1));
  }
  const result = calculateSettlement({
    entitledWeightMg: w.entitledWeightMg,
    entitlementKarat: w.entitlementKarat,
    items,
    ratePerGram: rate,
    basis: settings.hasad.settlementBasis,
  });
  return { ...result, rateKarats: [...new Set(items.map((i) => i.karat))] };
}

export async function getWithdrawal(ctx: Ctx, actor: Actor, id: number) {
  requireAny(actor, 'hasad.process', 'hasad.view');
  await releaseStaleReservations(ctx);
  const w = await loadWithdrawal(ctx.db, actor, id);
  const [branch] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, w.branchId));
  const draft = await draftRedemption(ctx.db, id);
  const items = draft ? await activeItems(ctx.db, draft.id) : [];
  const settlement = await computeSettlement(ctx, w, items);
  const { hasad: hasadSettings } = await ctx.settings.get();

  const redemptions = await ctx.db
    .select({
      r: t.hasadRedemptions,
      cashierName: t.users.fullName,
    })
    .from(t.hasadRedemptions)
    .innerJoin(t.users, eq(t.users.id, t.hasadRedemptions.cashierId))
    .where(eq(t.hasadRedemptions.withdrawalId, id))
    .orderBy(desc(t.hasadRedemptions.id));
  const completed = redemptions.find((r) => r.r.status === 'COMPLETED');
  const completedItems = completed
    ? await ctx.db
        .select({
          id: t.jewelryItems.id,
          code: t.jewelryItems.code,
          productName: t.products.name,
          productNameAr: t.products.nameAr,
          karat: t.hasadRedemptionItems.karat,
          netWeightMg: t.hasadRedemptionItems.netWeightMg,
          unitCost: t.hasadRedemptionItems.unitCost,
        })
        .from(t.hasadRedemptionItems)
        .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.hasadRedemptionItems.itemId))
        .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
        .where(and(eq(t.hasadRedemptionItems.redemptionId, completed.r.id), eq(t.hasadRedemptionItems.active, true)))
    : [];
  const [settlementRow] = completed
    ? await ctx.db.select().from(t.settlements).where(eq(t.settlements.redemptionId, completed.r.id))
    : [];

  const timeline = await ctx.db
    .select({ at: t.auditLogs.at, action: t.auditLogs.action, description: t.auditLogs.description, userFullName: t.auditLogs.userFullName })
    .from(t.auditLogs)
    .where(or(and(eq(t.auditLogs.entityType, 'hasad_withdrawal'), eq(t.auditLogs.entityId, w.externalId)), sql`${t.auditLogs.metadata}->>'withdrawal' = ${w.externalId}`))
    .orderBy(asc(t.auditLogs.at), asc(t.auditLogs.id));

  const showCost = can(actor, 'profit.view');
  return {
    withdrawal: { ...publicWithdrawal(w, actor), branchName: branch.name, branchNameAr: branch.nameAr, branchCode: branch.code },
    draft: draft ? { id: draft.id, number: draft.number, createdAt: draft.createdAt, customerVerified: draft.customerVerified } : null,
    items: items.map(({ totalCost, ...i }) => (showCost ? { ...i, totalCost } : i)),
    settlement,
    reservationTimeoutMinutes: hasadSettings.reservationTimeoutMinutes,
    completed: completed
      ? {
          ...completed.r,
          cashierName: completed.cashierName,
          items: completedItems.map(({ unitCost, ...i }) => (showCost ? { ...i, unitCost } : i)),
          settlement: settlementRow ?? null,
        }
      : null,
    history: redemptions.map((r) => ({ id: r.r.id, number: r.r.number, status: r.r.status, createdAt: r.r.createdAt, completedAt: r.r.completedAt, abortedAt: r.r.abortedAt, abortReason: r.r.abortReason, cashierName: r.cashierName })),
    timeline,
    mode: ctx.hasad.mode,
  };
}

// ───────────────────────── counter operations ─────────────────────────

export interface OpenInput {
  verification: 'PICKUP_CODE' | 'ID_DOCUMENT';
  pickupCode?: string;
}

export async function openWithdrawal(ctx: Ctx, actor: Actor, id: number, input: OpenInput) {
  requirePerm(actor, 'hasad.process');
  const w = await loadWithdrawal(ctx.db, actor, id);
  if (w.status === 'COMPLETED' || w.status === 'CANCELLED') throw badRequest('Withdrawal {id} is {status}', { id: w.externalId, status: w.status });
  if (input.verification === 'PICKUP_CODE') {
    if (!input.pickupCode || input.pickupCode.trim() !== w.pickupCode) throw badRequest('Pickup code does not match the Hasad request');
  }
  const existing = await draftRedemption(ctx.db, id);
  if (existing) return { redemptionId: existing.id, alreadyOpen: true };

  const [branch] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, w.branchId));
  // Confirm with Hasad that the request is still valid, and lock it on their side.
  const remote = await ctx.hasad.getWithdrawal(w.externalId);
  if (remote.status !== 'READY_FOR_PICKUP' && remote.status !== 'IN_PROGRESS') {
    throw conflict('Hasad reports this withdrawal as {status}', { status: remote.status });
  }
  await ctx.hasad.markInProgress(w.externalId, { branchCode: branch.hasadBranchCode!, openedBy: actor.username });

  return ctx.db.transaction(async (tx) => {
    const number = await nextNumber(tx, branch.code, 'HR');
    const [r] = await tx
      .insert(t.hasadRedemptions)
      .values({
        number,
        withdrawalId: w.id,
        branchId: w.branchId,
        cashierId: actor.userId,
        status: 'DRAFT',
        entitledWeightMg: w.entitledWeightMg,
        customerVerified: true,
      })
      .returning();
    await tx
      .update(t.hasadWithdrawals)
      .set({ status: 'IN_PROGRESS', externalStatus: 'IN_PROGRESS', openedAt: new Date(), openedBy: actor.userId, lastSyncedAt: new Date() })
      .where(eq(t.hasadWithdrawals.id, w.id));
    await writeAudit(tx, actor, {
      action: 'HASAD_WITHDRAWAL_OPENED',
      entityType: 'hasad_withdrawal',
      entityId: w.externalId,
      branchId: w.branchId,
      description: `Customer ${w.customerName} at counter for ${w.externalId} (${formatWeight(w.entitledWeightMg)}). Verified by ${input.verification === 'PICKUP_CODE' ? 'pickup code' : 'ID document'}.`,
      metadata: { redemption: number, verification: input.verification },
    });
    return { redemptionId: r.id, alreadyOpen: false };
  });
}

export async function addItem(ctx: Ctx, actor: Actor, id: number, itemId: number) {
  requirePerm(actor, 'hasad.process');
  return ctx.db.transaction(async (tx) => {
    const w = await loadWithdrawal(tx, actor, id);
    if (w.status !== 'IN_PROGRESS') throw badRequest('Open the withdrawal (customer present) before selecting items');
    const draft = await draftRedemption(tx, id);
    if (!draft) throw badRequest('No open counter session for this withdrawal');
    const [item] = await lockItems(tx, [itemId]);
    if (item.branchId !== w.branchId) throw forbidden('Item {code} is not in this branch', { code: item.code });
    // This is the ONLY point where a Hasad withdrawal affects inventory: the customer chose this piece.
    await changeStatus(tx, {
      item,
      to: 'RESERVED',
      from: ['AVAILABLE'],
      userId: actor.userId,
      ref: { refType: 'hasad_redemption', refId: draft.id, refNumber: draft.number },
      note: `Selected by Hasad customer ${w.customerName} (${w.externalId})`,
      reservation: { ref: `HASAD:${draft.number}`, userId: actor.userId },
    });
    await tx.insert(t.hasadRedemptionItems).values({
      redemptionId: draft.id,
      itemId: item.id,
      netWeightMg: item.netWeightMg,
      karat: item.karat,
      unitCost: item.totalCost,
    });
    await writeAudit(tx, actor, {
      action: 'ITEM_RESERVED',
      entityType: 'item',
      entityId: item.code,
      branchId: w.branchId,
      description: `${item.code} (${formatWeight(item.netWeightMg)}, ${item.karat}K) reserved for Hasad withdrawal ${w.externalId}`,
      metadata: { withdrawal: w.externalId, redemption: draft.number },
    });
    return { ok: true };
  });
}

export async function removeItem(ctx: Ctx, actor: Actor | null, id: number, itemId: number, note = 'Customer changed selection') {
  if (actor) requirePerm(actor, 'hasad.process');
  return ctx.db.transaction(async (tx) => {
    const [w] = await tx.select().from(t.hasadWithdrawals).where(eq(t.hasadWithdrawals.id, id));
    if (!w) throw notFound('Withdrawal request');
    if (actor) branchScope(actor, w.branchId);
    const draft = await draftRedemption(tx, id);
    if (!draft) throw badRequest('No open counter session for this withdrawal');
    await releaseOne(tx, actor, w, draft, itemId, note);
    return { ok: true };
  });
}

async function releaseOne(tx: Executor, actor: Actor | null, w: WithdrawalRow, draft: RedemptionRow, itemId: number, note: string) {
  const [ri] = await tx
    .select()
    .from(t.hasadRedemptionItems)
    .where(and(eq(t.hasadRedemptionItems.redemptionId, draft.id), eq(t.hasadRedemptionItems.itemId, itemId), eq(t.hasadRedemptionItems.active, true)));
  if (!ri) throw notFound('Selected item');
  const [item] = await lockItems(tx, [itemId]);
  await changeStatus(tx, {
    item,
    to: 'AVAILABLE',
    from: ['RESERVED'],
    userId: actor?.userId ?? null,
    ref: { refType: 'hasad_redemption', refId: draft.id, refNumber: draft.number },
    note,
    reservation: null,
  });
  await tx.update(t.hasadRedemptionItems).set({ active: false, releasedAt: new Date() }).where(eq(t.hasadRedemptionItems.id, ri.id));
  await writeAudit(tx, actor, {
    action: 'ITEM_RELEASED',
    entityType: 'item',
    entityId: item.code,
    branchId: w.branchId,
    description: `${item.code} released back to AVAILABLE (${note}) — withdrawal ${w.externalId}`,
    metadata: { withdrawal: w.externalId, redemption: draft.number },
  });
}

export interface CompleteInput {
  paymentMethod: PaymentMethod;
  customerAcknowledged: boolean;
  /** What the cashier saw & confirmed; must still match the server calculation. */
  expectedDirection: string;
  expectedAmount: number;
}

export async function completeWithdrawal(ctx: Ctx, actor: Actor, id: number, input: CompleteInput) {
  requirePerm(actor, 'hasad.process');
  if (!input.customerAcknowledged) throw badRequest('The customer must acknowledge the settlement before completion');

  // 1. Validate everything locally before telling Hasad.
  const w = await loadWithdrawal(ctx.db, actor, id);
  if (w.status !== 'IN_PROGRESS') throw badRequest('Withdrawal is {status}', { status: w.status });
  const draft = await draftRedemption(ctx.db, id);
  if (!draft) throw badRequest('No open counter session for this withdrawal');
  const items = await activeItems(ctx.db, draft.id);
  if (!items.length) throw badRequest('The customer has not selected any item');
  if (items.some((i) => i.status !== 'RESERVED')) throw conflict('A selected item is no longer reserved — please review the selection');
  const s = await computeSettlement(ctx, w, items);
  if (s.direction !== input.expectedDirection || s.amount !== input.expectedAmount) {
    throw conflict('The settlement changed (gold rate or selection). Please review and confirm again.', undefined, s);
  }
  const [branch] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, w.branchId));
  const { company } = await ctx.settings.get();

  // 2. Notify Hasad (external system of record for the customer's gold balance).
  await ctx.hasad.completeWithdrawal(w.externalId, {
    erpReference: draft.number,
    branchCode: branch.hasadBranchCode!,
    deliveredWeightGrams: (s.deliveredWeightMg / 1000).toFixed(3),
    items: items.map((i) => ({ code: i.code, description: i.productName, karat: i.karat, netWeightGrams: (i.netWeightMg / 1000).toFixed(3) })),
    settlement: {
      direction: s.direction,
      weightGrams: (s.absDifferenceMg / 1000).toFixed(3),
      amount: s.amount,
      currency: company.currency,
    },
    completedBy: actor.username,
  });

  // 3. Commit the ERP side atomically.
  return ctx.db.transaction(async (tx) => {
    const now = new Date();
    const locked = await lockItems(tx, items.map((i) => i.id));
    const ref = { refType: 'hasad_redemption', refId: draft.id, refNumber: draft.number };
    for (const item of locked) {
      await changeStatus(tx, { item, to: 'REDEEMED', from: ['RESERVED'], userId: actor.userId, ref, note: `Delivered to ${w.customerName} (${w.externalId})`, at: now });
      await recordMovement(tx, { item, type: 'HASAD_REDEMPTION', branchId: w.branchId, ref, userId: actor.userId, at: now });
    }
    const itemsCost = locked.reduce((sum, i) => sum + i.totalCost, 0);
    await tx
      .update(t.hasadRedemptions)
      .set({
        status: 'COMPLETED',
        deliveredWeightMg: s.deliveredWeightMg,
        differenceMg: s.differenceMg,
        settlementDirection: s.direction,
        settlementAmount: s.amount,
        ratePerGram: s.ratePerGram,
        itemsCost,
        completedAt: now,
      })
      .where(eq(t.hasadRedemptions.id, draft.id));
    let settlementNumber: string | null = null;
    if (s.direction !== 'NONE') {
      settlementNumber = await nextNumber(tx, branch.code, 'SET');
      await tx.insert(t.settlements).values({
        number: settlementNumber,
        type: 'HASAD_WEIGHT_DIFFERENCE',
        redemptionId: draft.id,
        branchId: w.branchId,
        direction: s.direction,
        weightMg: s.absDifferenceMg,
        ratePerGram: s.ratePerGram,
        amount: s.amount,
        paymentMethod: input.paymentMethod,
        confirmedBy: actor.userId,
        confirmedAt: now,
      });
      await writeAudit(tx, actor, {
        action: 'HASAD_SETTLEMENT_CONFIRMED',
        entityType: 'settlement',
        entityId: settlementNumber,
        branchId: w.branchId,
        at: now,
        description: `${s.direction === 'BRANCH_PAYS_CUSTOMER' ? 'Branch paid customer' : 'Customer paid branch'} ${s.amount.toLocaleString()} ${company.currency} for ${formatWeight(s.absDifferenceMg)} difference @ ${s.ratePerGram.toLocaleString()}/g (${input.paymentMethod})`,
        metadata: { withdrawal: w.externalId, redemption: draft.number, ...s },
      });
    }
    await tx
      .update(t.hasadWithdrawals)
      .set({ status: 'COMPLETED', externalStatus: 'COMPLETED', completedAt: now, completedBy: actor.userId, lastSyncedAt: now })
      .where(eq(t.hasadWithdrawals.id, w.id));
    await writeAudit(tx, actor, {
      action: 'HASAD_WITHDRAWAL_COMPLETED',
      entityType: 'hasad_withdrawal',
      entityId: w.externalId,
      branchId: w.branchId,
      at: now,
      description: `${w.externalId} completed: entitled ${formatWeight(s.entitledWeightMg)}, delivered ${formatWeight(s.deliveredWeightMg)} (${locked.map((i) => i.code).join(', ')})`,
      metadata: { redemption: draft.number, settlement: settlementNumber },
    });
    return { redemptionNumber: draft.number, settlementNumber, settlement: s };
  });
}

export async function abortRedemption(ctx: Ctx, actor: Actor | null, id: number, reason: string) {
  if (actor) requirePerm(actor, 'hasad.process');
  const [w] = await ctx.db.select().from(t.hasadWithdrawals).where(eq(t.hasadWithdrawals.id, id));
  if (!w) throw notFound('Withdrawal request');
  if (actor) branchScope(actor, w.branchId);
  const draft = await draftRedemption(ctx.db, id);
  if (!draft) throw badRequest('No open counter session for this withdrawal');
  try {
    await ctx.hasad.markReady(w.externalId);
  } catch {
    // Releasing stock must never be blocked by the external system; status re-syncs later.
  }
  await ctx.db.transaction(async (tx) => {
    const items = await activeItems(tx, draft.id);
    for (const i of items) await releaseOne(tx, actor, w, draft, i.id, reason);
    await tx.update(t.hasadRedemptions).set({ status: 'ABORTED', abortedAt: new Date(), abortReason: reason }).where(eq(t.hasadRedemptions.id, draft.id));
    await tx.update(t.hasadWithdrawals).set({ status: 'READY_FOR_PICKUP', externalStatus: 'READY_FOR_PICKUP' }).where(eq(t.hasadWithdrawals.id, w.id));
    await writeAudit(tx, actor, {
      action: 'HASAD_REDEMPTION_ABORTED',
      entityType: 'hasad_withdrawal',
      entityId: w.externalId,
      branchId: w.branchId,
      description: `Counter session ${draft.number} ended without delivery (${reason}); ${items.length} item(s) released. Request remains open.`,
      metadata: { redemption: draft.number },
    });
  });
  return { ok: true };
}

export async function cancelWithdrawal(ctx: Ctx, actor: Actor, id: number, reason: string) {
  requirePerm(actor, 'hasad.cancel');
  if (!reason?.trim()) throw badRequest('A cancellation reason is required');
  const w = await loadWithdrawal(ctx.db, actor, id);
  if (w.status === 'COMPLETED' || w.status === 'CANCELLED') throw badRequest('Withdrawal is already {status}', { status: w.status });
  await ctx.hasad.cancelWithdrawal(w.externalId, reason);
  await ctx.db.transaction(async (tx) => {
    const draft = await draftRedemption(tx, id);
    if (draft) {
      const items = await activeItems(tx, draft.id);
      for (const i of items) await releaseOne(tx, actor, w, draft, i.id, 'Withdrawal cancelled');
      await tx.update(t.hasadRedemptions).set({ status: 'ABORTED', abortedAt: new Date(), abortReason: reason }).where(eq(t.hasadRedemptions.id, draft.id));
    }
    await tx
      .update(t.hasadWithdrawals)
      .set({ status: 'CANCELLED', externalStatus: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actor.userId, cancelReason: reason })
      .where(eq(t.hasadWithdrawals.id, w.id));
    await writeAudit(tx, actor, {
      action: 'HASAD_WITHDRAWAL_CANCELLED',
      entityType: 'hasad_withdrawal',
      entityId: w.externalId,
      branchId: w.branchId,
      description: `Withdrawal ${w.externalId} (${w.customerName}, ${formatWeight(w.entitledWeightMg)}) cancelled: ${reason}`,
    });
  });
  return { ok: true };
}

/** Release reservations older than the configured timeout (customer walked away). */
export async function releaseStaleReservations(ctx: Ctx) {
  const { hasad } = await ctx.settings.get();
  const cutoff = new Date(Date.now() - hasad.reservationTimeoutMinutes * 60_000);
  const stale = await ctx.db
    .selectDistinct({ withdrawalId: t.hasadRedemptions.withdrawalId })
    .from(t.hasadRedemptions)
    .innerJoin(t.hasadRedemptionItems, eq(t.hasadRedemptionItems.redemptionId, t.hasadRedemptions.id))
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.hasadRedemptionItems.itemId))
    .where(
      and(
        eq(t.hasadRedemptions.status, 'DRAFT'),
        eq(t.hasadRedemptionItems.active, true),
        lte(t.jewelryItems.reservedAt, cutoff),
      ),
    );
  for (const s of stale) {
    await abortRedemption(ctx, null, s.withdrawalId, `Reservation timeout (${hasad.reservationTimeoutMinutes} min)`).catch(() => undefined);
  }
  return stale.length;
}

/** Items a Hasad customer can choose from — browsing does NOT reserve anything. */
export async function candidateItems(ctx: Ctx, actor: Actor, id: number, q: { q?: string; karat?: number; category?: string }) {
  requirePerm(actor, 'hasad.process');
  const w = await loadWithdrawal(ctx.db, actor, id);
  const where: SQL[] = [eq(t.jewelryItems.branchId, w.branchId), eq(t.jewelryItems.status, 'AVAILABLE')];
  if (q.karat) where.push(eq(t.jewelryItems.karat, q.karat));
  if (q.category) where.push(eq(t.categories.code, q.category));
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(or(ilike(t.jewelryItems.code, s), ilike(t.jewelryItems.barcode, s), ilike(t.products.name, s), ilike(t.products.nameAr, s))!);
  }
  const rowsAll = await itemQuery(ctx.db)
    .where(and(...where))
    .orderBy(sql`abs(${t.jewelryItems.netWeightMg} - ${w.entitledWeightMg})`)
    .limit(200);
  return rowsAll.map(({ purchaseCost: _p, makingCost: _m, otherCost: _o, totalCost: _t, ...r }) => r);
}
