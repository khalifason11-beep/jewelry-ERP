import { ap } from '@jerp/shared';
// Two-step inter-branch transfers:
//   send:    AVAILABLE → TRANSFERRED (in transit), ledger TRANSFER_OUT at source
//   receive: TRANSFERRED → AVAILABLE at destination, ledger TRANSFER_IN at destination

import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import { nameOrAr } from '../../core/sql';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, isGlobal, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors';
import type { TxIdempotency } from '../../core/idempotency';
import { nextNumber } from '../../core/numbering';
import { changeStatus, lockItems, recordMovement } from '../inventory/ledger';

/** FIX-1 (D-fix-1): the courier's name, required for every new transfer (SPEC §8). */
export const COURIER_NAME_MIN = 2;
export const COURIER_NAME_MAX = 80;

/**
 * Send pieces to another branch. Two entry points, one rule set (D-fix-1, D-rem4-1): the branch manager's POS cart
 * and the General Manager's "New transfer" on the Transfers screen. All or nothing: the piece rows are locked (in id
 * order) and every piece is checked BEFORE anything is written; one piece sold or moved meanwhile refuses the whole
 * transfer with ITEMS_UNAVAILABLE and nothing changes. The idempotency key is claimed inside the same transaction.
 */
export async function createTransfer(
  ctx: Ctx,
  actor: Actor,
  input: { fromBranchId?: number; toBranchId: number; itemIds: number[]; courierName: string; notes?: string },
  opts: { at?: Date; idem?: TxIdempotency } = {},
) {
  requirePerm(actor, 'inventory.transfer');
  const fromBranchId = branchScope(actor, input.fromBranchId);
  if (fromBranchId == null) throw badRequest('Select the sending branch');
  if (fromBranchId === input.toBranchId) throw badRequest('Source and destination must differ');
  if (!input.itemIds.length) throw badRequest('Select at least one item');
  if (new Set(input.itemIds).size !== input.itemIds.length) throw badRequest('The same item appears twice in the transfer');
  const courierName = (input.courierName ?? '').replace(/\s+/g, ' ').trim();
  if (courierName.length < COURIER_NAME_MIN || courierName.length > COURIER_NAME_MAX) throw badRequest('Enter the courier’s name (2 to 80 characters)');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await opts.idem?.claim(tx);
    const [from] = await tx.select().from(t.branches).where(eq(t.branches.id, fromBranchId));
    const [to] = await tx.select().from(t.branches).where(eq(t.branches.id, input.toBranchId));
    if (!to) throw notFound('Destination branch');
    // Lock every piece first, then check them all: a concurrent sale or transfer of one of them waits here, and
    // whoever comes second sees its new status and refuses as a whole.
    const items = await lockItems(tx, input.itemIds);
    for (const item of items) {
      if (item.branchId !== fromBranchId) throw forbidden('Item {code} is not in {branch}', { code: item.code, branch: from.name });
    }
    const unavailable = items.filter((i) => i.status !== 'AVAILABLE');
    if (unavailable.length) {
      throw new AppError(
        409,
        'ITEMS_UNAVAILABLE',
        '{codes} no longer available (sold or moved meanwhile). Nothing was sent: remove it and try again.',
        { codes: unavailable.map((i) => i.code).join(', ') },
        { unavailable: unavailable.map((i) => ({ itemId: i.id, code: i.code, status: i.status })) },
      );
    }
    const number = await nextNumber(tx, 'CO', 'TRF');
    const [tr] = await tx
      .insert(t.transfers)
      .values({ number, fromBranchId, toBranchId: to.id, status: 'IN_TRANSIT', notes: input.notes?.trim() || null, courierName, createdBy: actor.userId, createdAt: at })
      .returning();
    const ref = { refType: 'transfer', refId: tr.id, refNumber: number };
    for (const item of items) {
      await changeStatus(tx, { item, to: 'TRANSFERRED', from: ['AVAILABLE'], userId: actor.userId, ref, note: `In transit to ${to.name}`, at });
      await recordMovement(tx, { item, type: 'TRANSFER_OUT', branchId: fromBranchId, fromBranchId, toBranchId: to.id, ref, userId: actor.userId, at });
      await tx.insert(t.transferItems).values({ transferId: tr.id, itemId: item.id });
    }
    await writeAudit(tx, actor, {
      action: 'INVENTORY_TRANSFER',
      entityType: 'transfer',
      entityId: number,
      branchId: fromBranchId,
      at,
      key: 'Transfer {number}: {n} item(s) sent {from} → {to}, courier {courier}',
      params: { number, n: items.length, from: ap.text(from.name, from.nameAr), to: ap.text(to.name, to.nameAr), courier: courierName },
      metadata: { items: items.map((i) => i.code), toBranchId: to.id, courierName },
    });
    await opts.idem?.complete(tx, tr);
    return tr;
  });
}

export async function receiveTransfer(ctx: Ctx, actor: Actor, id: number, opts: { at?: Date } = {}) {
  requirePerm(actor, 'inventory.transfer');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    // Row lock (M-4): a second concurrent receive waits here, then sees RECEIVED and stops.
    const [tr] = await tx.select().from(t.transfers).where(eq(t.transfers.id, id)).for('update');
    if (!tr) throw notFound('Transfer');
    if (!isGlobal(actor) && actor.branchId !== tr.toBranchId) throw forbidden('Only the receiving branch can confirm receipt');
    if (tr.status !== 'IN_TRANSIT') throw badRequest('Transfer is {status}', { status: tr.status });
    const links = await tx.select().from(t.transferItems).where(eq(t.transferItems.transferId, id));
    const items = await lockItems(tx, links.map((l) => l.itemId));
    const ref = { refType: 'transfer', refId: tr.id, refNumber: tr.number };
    for (const item of items) {
      await changeStatus(tx, { item, to: 'AVAILABLE', from: ['TRANSFERRED'], userId: actor.userId, ref, note: 'Received', branchId: tr.toBranchId, at });
      await recordMovement(tx, { item, type: 'TRANSFER_IN', branchId: tr.toBranchId, fromBranchId: tr.fromBranchId, toBranchId: tr.toBranchId, ref, userId: actor.userId, at });
    }
    await tx
      .update(t.transfers)
      .set({ status: 'RECEIVED', receivedAt: at, receivedBy: actor.userId })
      .where(and(eq(t.transfers.id, id), eq(t.transfers.status, 'IN_TRANSIT')));
    await writeAudit(tx, actor, {
      action: 'INVENTORY_TRANSFER_RECEIVED',
      entityType: 'transfer',
      entityId: tr.number,
      branchId: tr.toBranchId,
      at,
      key: 'Transfer {number} received: {n} item(s)',
      params: { number: tr.number, n: items.length },
    });
    return { ok: true };
  });
}

export async function listTransfers(ctx: Ctx, actor: Actor, q: { branchId?: number; status?: string }) {
  requirePerm(actor, 'inventory.transfer');
  const scope = branchScope(actor, q.branchId);
  const where: SQL[] = [];
  if (scope != null) where.push(or(eq(t.transfers.fromBranchId, scope), eq(t.transfers.toBranchId, scope))!);
  if (q.status) where.push(eq(t.transfers.status, q.status));
  const rowsAll = await ctx.db
    .select()
    .from(t.transfers)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(t.transfers.createdAt))
    .limit(300);
  if (!rowsAll.length) return [];
  const branchRows = await ctx.db.select({ id: t.branches.id, name: t.branches.name }).from(t.branches);
  const bn = new Map(branchRows.map((b) => [b.id, b.name]));
  const userRows = await ctx.db.select({ id: t.users.id, name: t.users.fullName }).from(t.users);
  const un = new Map(userRows.map((u) => [u.id, u.name]));
  const links = await ctx.db
    .select({ transferId: t.transferItems.transferId, code: t.jewelryItems.code, netWeightMg: t.jewelryItems.netWeightMg, productName: nameOrAr(t.products.name, t.products.nameAr), productNameAr: t.products.nameAr })
    .from(t.transferItems)
    .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.transferItems.itemId))
    .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
    .where(inArray(t.transferItems.transferId, rowsAll.map((r) => r.id)));
  return rowsAll.map((r) => {
    const items = links.filter((l) => l.transferId === r.id);
    return {
      ...r,
      fromBranchName: bn.get(r.fromBranchId),
      toBranchName: bn.get(r.toBranchId),
      createdByName: un.get(r.createdBy),
      receivedByName: r.receivedBy ? un.get(r.receivedBy) : null,
      itemCount: items.length,
      weightMg: items.reduce((s, i) => s + i.netWeightMg, 0),
      items,
    };
  });
}
