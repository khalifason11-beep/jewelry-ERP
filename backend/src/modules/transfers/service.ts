// Two-step inter-branch transfers:
//   send:    AVAILABLE → TRANSFERRED (in transit), ledger TRANSFER_OUT at source
//   receive: TRANSFERRED → AVAILABLE at destination, ledger TRANSFER_IN at destination

import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, isGlobal, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { changeStatus, lockItems, recordMovement } from '../inventory/ledger';

export async function createTransfer(
  ctx: Ctx,
  actor: Actor,
  input: { fromBranchId?: number; toBranchId: number; itemIds: number[]; notes?: string },
  opts: { at?: Date } = {},
) {
  requirePerm(actor, 'inventory.transfer');
  const fromBranchId = branchScope(actor, input.fromBranchId);
  if (fromBranchId == null) throw badRequest('Select the sending branch');
  if (fromBranchId === input.toBranchId) throw badRequest('Source and destination must differ');
  if (!input.itemIds.length) throw badRequest('Select at least one item');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    const [from] = await tx.select().from(t.branches).where(eq(t.branches.id, fromBranchId));
    const [to] = await tx.select().from(t.branches).where(eq(t.branches.id, input.toBranchId));
    if (!to) throw notFound('Destination branch');
    const number = await nextNumber(tx, 'CO', 'TRF');
    const [tr] = await tx
      .insert(t.transfers)
      .values({ number, fromBranchId, toBranchId: to.id, status: 'IN_TRANSIT', notes: input.notes ?? null, createdBy: actor.userId, createdAt: at })
      .returning();
    const items = await lockItems(tx, input.itemIds);
    const ref = { refType: 'transfer', refId: tr.id, refNumber: number };
    for (const item of items) {
      if (item.branchId !== fromBranchId) throw forbidden('Item {code} is not in {branch}', { code: item.code, branch: from.name });
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
      description: `Transfer ${number}: ${items.length} item(s) sent ${from.name} → ${to.name}`,
      metadata: { items: items.map((i) => i.code), toBranchId: to.id },
    });
    return tr;
  });
}

export async function receiveTransfer(ctx: Ctx, actor: Actor, id: number, opts: { at?: Date } = {}) {
  requirePerm(actor, 'inventory.transfer');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    const [tr] = await tx.select().from(t.transfers).where(eq(t.transfers.id, id));
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
    await tx.update(t.transfers).set({ status: 'RECEIVED', receivedAt: at, receivedBy: actor.userId }).where(eq(t.transfers.id, id));
    await writeAudit(tx, actor, {
      action: 'INVENTORY_TRANSFER_RECEIVED',
      entityType: 'transfer',
      entityId: tr.number,
      branchId: tr.toBranchId,
      at,
      description: `Transfer ${tr.number} received: ${items.length} item(s)`,
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
    .select({ transferId: t.transferItems.transferId, code: t.jewelryItems.code, netWeightMg: t.jewelryItems.netWeightMg, productName: t.products.name })
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
