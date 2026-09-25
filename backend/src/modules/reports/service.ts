// Report engine: every report returns the same shape (columns + rows + totals) so the UI
// renders, searches, sorts and exports all of them with one component.

import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { ReportKey } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requirePerm } from '../../authz';
import { badRequest } from '../../core/errors';
import { rows, num } from '../../core/sql';
import { periodFor } from '../dashboard/service';
import { listExpenses } from '../expenses/service';
import { searchItems } from '../inventory/service';
import { listPurchases } from '../purchases/service';
import { listSales } from '../sales/service';
import { branchMetrics, movementSummary } from './metrics';

export type ColumnType = 'text' | 'money' | 'weight' | 'number' | 'percent' | 'date' | 'datetime' | 'status' | 'code' | 'audit';

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
  /** Drill-down link pattern, e.g. "/sales/:saleId". */
  link?: string;
}

export interface Report {
  key: ReportKey | 'inventory-ledger';
  title: string;
  description: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
  notes?: string[];
  filters: { dateRange: boolean; branch: boolean; user: boolean; status?: string[] };
}

export interface ReportQuery {
  from?: string;
  to?: string;
  branchId?: number;
  userId?: number;
  status?: string;
  q?: string;
  group?: string;
  action?: string;
}

const c = (key: string, label: string, type: ColumnType = 'text', link?: string): Column => ({ key, label, type, link });

function totalsOf(rowsAll: Record<string, unknown>[], keys: string[]) {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = rowsAll.reduce((s, r) => s + num(r[k]), 0);
  return out;
}

export async function runReport(ctx: Ctx, actor: Actor, key: string, q: ReportQuery): Promise<Report> {
  requirePerm(actor, 'reports.view');
  const scope = branchScope(actor, q.branchId);
  const period = await periodFor(ctx, q.from, q.to);
  const branchFilter = scope ?? undefined;
  const iso = (d: Date) => d.toISOString();
  const { company } = await ctx.settings.get();

  switch (key as ReportKey | 'inventory-ledger') {
    case 'sales': {
      const data = await listSales(ctx, actor, { from: period.fromKey, to: period.toKey, branchId: branchFilter, cashierId: q.userId, q: q.q, status: q.status });
      const profit = can(actor, 'profit.view');
      const rowsAll = data.map((s) => ({ ...s, saleId: s.id }));
      return {
        key: 'sales',
        title: 'Sales Report',
        description: 'Every normal jewelry sale, with cost and gross profit per invoice.',
        columns: [
          c('number', 'Invoice', 'code', '/sales/:saleId'),
          c('createdAt', 'Date', 'datetime'),
          c('branchName', 'Branch'),
          c('cashierName', 'Cashier'),
          c('customerName', 'Customer'),
          c('itemCount', 'Items', 'number'),
          c('weightMg', 'Net weight', 'weight'),
          c('discountTotal', 'Discount', 'money'),
          c('total', 'Total', 'money'),
          ...(profit ? [c('costTotal', 'Cost', 'money'), c('grossProfit', 'Gross profit', 'money')] : []),
          c('paymentMethod', 'Payment', 'status'),
          c('status', 'Status', 'status'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll.filter((r) => r.status === 'COMPLETED'), ['itemCount', 'weightMg', 'discountTotal', 'total', 'costTotal', 'grossProfit']),
        notes: ['Totals exclude cancelled (voided) sales.'],
        filters: { dateRange: true, branch: true, user: true, status: ['COMPLETED', 'VOIDED'] },
      };
    }
    case 'purchases': {
      requirePerm(actor, 'purchases.view');
      const data = await listPurchases(ctx, actor, { branchId: branchFilter, from: period.fromKey, to: period.toKey, q: q.q });
      const rowsAll = data.map((p) => ({ ...p, purchaseId: p.id }));
      return {
        key: 'purchases',
        title: 'Purchases Report',
        description: 'Stock received into branches, with cost components.',
        columns: [
          c('number', 'Purchase', 'code', '/purchases/:purchaseId'),
          c('createdAt', 'Date', 'datetime'),
          c('branchName', 'Branch'),
          c('supplierName', 'Supplier'),
          c('supplierInvoiceNo', 'Supplier invoice', 'code'),
          c('itemCount', 'Items', 'number'),
          c('totalNetWeightMg', 'Net weight', 'weight'),
          c('totalCost', 'Total cost', 'money'),
          c('createdByName', 'Received by'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll, ['itemCount', 'totalNetWeightMg', 'totalCost']),
        filters: { dateRange: true, branch: true, user: false },
      };
    }
    case 'expenses': {
      requirePerm(actor, 'expenses.view');
      const data = await listExpenses(ctx, actor, { branchId: branchFilter, from: period.fromKey, to: period.toKey, q: q.q, status: q.status });
      return {
        key: 'expenses',
        title: 'Expenses Report',
        description: 'Branch operating expenses. Only approved expenses reduce branch contribution.',
        columns: [
          c('number', 'Expense', 'code'),
          c('expenseDate', 'Date', 'date'),
          c('branchName', 'Branch'),
          c('category', 'Category', 'status'),
          c('description', 'Description'),
          c('amount', 'Amount', 'money'),
          c('createdByName', 'Created by'),
          c('status', 'Status', 'status'),
        ],
        rows: data,
        totals: totalsOf(data.filter((e) => e.status === 'APPROVED'), ['amount']),
        notes: ['Total includes approved expenses only.'],
        filters: { dateRange: true, branch: true, user: false, status: ['APPROVED', 'PENDING', 'REJECTED'] },
      };
    }
    case 'inventory': {
      requirePerm(actor, 'inventory.view');
      const { items } = await searchItems(ctx, actor, {
        branchId: branchFilter,
        q: q.q,
        status: q.status ? [q.status as never] : undefined,
        limit: 1000,
      });
      const rowsAll = items.map((i) => ({ ...i, itemId: i.id }));
      return {
        key: 'inventory',
        title: 'Inventory Report',
        description: 'Item-level inventory as of now. Every piece has its own ID, barcode and cost.',
        columns: [
          c('code', 'Item ID', 'code', '/inventory/:itemId'),
          c('barcode', 'Barcode', 'code'),
          c('productName', 'Product'),
          c('categoryName', 'Category'),
          c('karat', 'Karat', 'number'),
          c('netWeightMg', 'Net weight', 'weight'),
          c('purchaseCost', 'Purchase cost', 'money'),
          c('totalCost', 'Total cost', 'money'),
          c('sellingPrice', 'Selling price', 'money'),
          c('branchName', 'Branch'),
          c('status', 'Status', 'status'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll, ['netWeightMg', 'purchaseCost', 'totalCost', 'sellingPrice']),
        filters: { dateRange: false, branch: true, user: false, status: ['AVAILABLE', 'RESERVED', 'SOLD', 'REDEEMED', 'TRANSFERRED', 'DAMAGED', 'RETURNED'] },
      };
    }
    case 'inventory-movement': {
      requirePerm(actor, 'inventory.view');
      const summary = await movementSummary(ctx.db, period, scope);
      const branches = await ctx.db.select({ id: t.branches.id, name: t.branches.name }).from(t.branches);
      const bn = new Map(branches.map((b) => [b.id, b.name]));
      const L = (m: (typeof summary)[number], k: string) => m.lines[k] ?? { items: 0, weightMg: 0 };
      const rowsAll = summary.map((m) => ({
        branchName: bn.get(m.branchId),
        openingItems: m.opening.items,
        openingWeightMg: m.opening.weightMg,
        purchases: L(m, 'PURCHASE').items,
        transfersIn: L(m, 'TRANSFER_IN').items,
        returns: L(m, 'RETURN').items + L(m, 'ADJUSTMENT_IN').items,
        sales: L(m, 'SALE').items,
        hasad: L(m, 'HASAD_REDEMPTION').items,
        transfersOut: L(m, 'TRANSFER_OUT').items,
        damaged: L(m, 'DAMAGE').items + L(m, 'ADJUSTMENT_OUT').items,
        closingItems: m.closing.items,
        closingWeightMg: m.closing.weightMg,
        weightIn: L(m, 'PURCHASE').weightMg + L(m, 'TRANSFER_IN').weightMg + L(m, 'RETURN').weightMg + L(m, 'ADJUSTMENT_IN').weightMg,
        weightOut: L(m, 'SALE').weightMg + L(m, 'HASAD_REDEMPTION').weightMg + L(m, 'TRANSFER_OUT').weightMg + L(m, 'DAMAGE').weightMg + L(m, 'ADJUSTMENT_OUT').weightMg,
      }));
      return {
        key: 'inventory-movement',
        title: 'Inventory Movement',
        description: 'Opening stock + purchases + transfers in − sales − Hasad redemptions − transfers out = closing stock. Derived from the ledger.',
        columns: [
          c('branchName', 'Branch'),
          c('openingItems', 'Opening', 'number'),
          c('openingWeightMg', 'Opening wt', 'weight'),
          c('purchases', '+ Purchases', 'number'),
          c('transfersIn', '+ Transfers in', 'number'),
          c('returns', '+ Returns/adj.', 'number'),
          c('sales', '− Sales', 'number'),
          c('hasad', '− Hasad', 'number'),
          c('transfersOut', '− Transfers out', 'number'),
          c('damaged', '− Damaged/adj.', 'number'),
          c('closingItems', '= Closing', 'number'),
          c('closingWeightMg', 'Closing wt', 'weight'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll, ['openingItems', 'openingWeightMg', 'purchases', 'transfersIn', 'returns', 'sales', 'hasad', 'transfersOut', 'damaged', 'closingItems', 'closingWeightMg']),
        filters: { dateRange: true, branch: true, user: false },
      };
    }
    case 'inventory-ledger': {
      requirePerm(actor, 'inventory.view');
      const where: SQL[] = [gte(t.inventoryMovements.at, period.start), lt(t.inventoryMovements.at, period.end)];
      if (scope != null) where.push(eq(t.inventoryMovements.branchId, scope));
      if (q.status) where.push(eq(t.inventoryMovements.type, q.status));
      if (q.userId) where.push(eq(t.inventoryMovements.userId, q.userId));
      if (q.q?.trim()) where.push(or(ilike(t.jewelryItems.code, `%${q.q}%`), ilike(t.inventoryMovements.refNumber, `%${q.q}%`))!);
      const data = await ctx.db
        .select({
          at: t.inventoryMovements.at,
          itemId: t.jewelryItems.id,
          itemCode: t.jewelryItems.code,
          productName: t.products.name,
          branchName: t.branches.name,
          type: t.inventoryMovements.type,
          direction: t.inventoryMovements.direction,
          netWeightMg: t.inventoryMovements.netWeightMg,
          refNumber: t.inventoryMovements.refNumber,
          userName: t.users.fullName,
        })
        .from(t.inventoryMovements)
        .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.inventoryMovements.itemId))
        .innerJoin(t.products, eq(t.products.id, t.jewelryItems.productId))
        .innerJoin(t.branches, eq(t.branches.id, t.inventoryMovements.branchId))
        .leftJoin(t.users, eq(t.users.id, t.inventoryMovements.userId))
        .where(and(...where))
        .orderBy(desc(t.inventoryMovements.at), desc(t.inventoryMovements.id))
        .limit(2000);
      return {
        key: 'inventory-ledger',
        title: 'Inventory Ledger',
        description: 'Every stock movement with its reference document and user.',
        columns: [
          c('at', 'Time', 'datetime'),
          c('itemCode', 'Item', 'code', '/inventory/:itemId'),
          c('productName', 'Product'),
          c('branchName', 'Branch'),
          c('type', 'Movement', 'status'),
          c('direction', 'Qty', 'number'),
          c('netWeightMg', 'Net weight', 'weight'),
          c('refNumber', 'Reference', 'code'),
          c('userName', 'User'),
        ],
        rows: data,
        filters: { dateRange: true, branch: true, user: true, status: ['PURCHASE', 'SALE', 'HASAD_REDEMPTION', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN', 'ADJUSTMENT', 'DAMAGE'] },
      };
    }
    case 'profit': {
      requirePerm(actor, 'profit.view');
      const group = q.group ?? 'branch';
      let rowsAll: Record<string, unknown>[];
      if (group === 'branch') {
        const metrics = await branchMetrics(ctx.db, period, scope);
        const branches = await ctx.db.select({ id: t.branches.id, name: t.branches.name }).from(t.branches);
        const bn = new Map(branches.map((b) => [b.id, b.name]));
        rowsAll = [...metrics.values()].map((m) => ({
          label: bn.get(m.branchId),
          branchId: m.branchId,
          salesCount: m.salesCount,
          revenue: m.revenue,
          discounts: m.discounts,
          costOfSales: m.costOfSales,
          grossProfit: m.grossProfit,
          margin: m.revenue ? (m.grossProfit / m.revenue) * 100 : 0,
          expenses: m.expenses,
          contribution: m.contribution,
        }));
      } else {
        const dim =
          group === 'category' ? sql`c.name` : group === 'karat' ? sql`(si.karat || 'K')` : group === 'cashier' ? sql`u.full_name` : sql`to_char(s.created_at AT TIME ZONE ${company.timezone},'YYYY-MM-DD')`;
        const r = await ctx.db.execute(sql`
          SELECT ${dim} AS label, count(DISTINCT s.id) AS sales_count, coalesce(sum(si.final_price),0) AS revenue,
                 coalesce(sum(si.discount),0) AS discounts, coalesce(sum(si.unit_cost),0) AS cost
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          JOIN jewelry_items i ON i.id = si.item_id JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
          JOIN users u ON u.id = s.cashier_id
          WHERE s.status = 'COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}
          ${scope != null ? sql`AND s.branch_id = ${scope}` : sql``}
          GROUP BY 1 ORDER BY 1`);
        rowsAll = rows<Record<string, unknown>>(r).map((x) => {
          const revenue = num(x.revenue);
          const cost = num(x.cost);
          return { label: String(x.label), salesCount: num(x.sales_count), revenue, discounts: num(x.discounts), costOfSales: cost, grossProfit: revenue - cost, margin: revenue ? ((revenue - cost) / revenue) * 100 : 0 };
        });
      }
      const totals = totalsOf(rowsAll, ['salesCount', 'revenue', 'discounts', 'costOfSales', 'grossProfit', 'expenses', 'contribution']);
      totals.margin = totals.revenue ? (totals.grossProfit / totals.revenue) * 100 : 0;
      return {
        key: 'profit',
        title: 'Profit Report',
        description: 'Gross profit = selling price (after discount) − item total cost. Contribution = gross profit − approved branch expenses.',
        columns: [
          c('label', group === 'branch' ? 'Branch' : group[0].toUpperCase() + group.slice(1), 'text', group === 'branch' ? '/branches/:branchId' : undefined),
          c('salesCount', 'Sales', 'number'),
          c('revenue', 'Revenue', 'money'),
          c('discounts', 'Discounts', 'money'),
          c('costOfSales', 'Cost of sales', 'money'),
          c('grossProfit', 'Gross profit', 'money'),
          c('margin', 'Margin', 'percent'),
          ...(group === 'branch' ? [c('expenses', 'Expenses', 'money'), c('contribution', 'Contribution', 'money')] : []),
        ],
        rows: rowsAll,
        totals,
        notes: [
          'Item cost = purchase cost + making cost + other cost (components kept separately; definition configurable with the client).',
          'Hasad redemptions are reported separately and are not included in revenue until the client defines their accounting treatment.',
        ],
        filters: { dateRange: true, branch: true, user: false },
      };
    }
    case 'hasad': {
      requirePerm(actor, 'hasad.view');
      const where: SQL[] = [gte(t.hasadWithdrawals.requestedAt, period.start), lt(t.hasadWithdrawals.requestedAt, period.end)];
      if (scope != null) where.push(eq(t.hasadWithdrawals.branchId, scope));
      if (q.status) where.push(eq(t.hasadWithdrawals.status, q.status));
      if (q.userId) where.push(eq(t.hasadWithdrawals.completedBy, q.userId));
      if (q.q?.trim()) where.push(or(ilike(t.hasadWithdrawals.externalId, `%${q.q}%`), ilike(t.hasadWithdrawals.customerName, `%${q.q}%`))!);
      const data = await ctx.db
        .select({
          withdrawalId: t.hasadWithdrawals.id,
          externalId: t.hasadWithdrawals.externalId,
          requestedAt: t.hasadWithdrawals.requestedAt,
          customerName: t.hasadWithdrawals.customerName,
          customerNameAr: t.hasadWithdrawals.customerNameAr,
          branchName: t.branches.name,
          entitledWeightMg: t.hasadWithdrawals.entitledWeightMg,
          status: t.hasadWithdrawals.status,
          redemptionNumber: t.hasadRedemptions.number,
          deliveredWeightMg: t.hasadRedemptions.deliveredWeightMg,
          differenceMg: t.hasadRedemptions.differenceMg,
          settlementDirection: t.hasadRedemptions.settlementDirection,
          settlementAmount: t.hasadRedemptions.settlementAmount,
          itemsCost: t.hasadRedemptions.itemsCost,
          completedAt: t.hasadWithdrawals.completedAt,
          cashierName: t.users.fullName,
          cancelReason: t.hasadWithdrawals.cancelReason,
        })
        .from(t.hasadWithdrawals)
        .innerJoin(t.branches, eq(t.branches.id, t.hasadWithdrawals.branchId))
        .leftJoin(t.hasadRedemptions, and(eq(t.hasadRedemptions.withdrawalId, t.hasadWithdrawals.id), eq(t.hasadRedemptions.status, 'COMPLETED')))
        .leftJoin(t.users, eq(t.users.id, t.hasadWithdrawals.completedBy))
        .where(and(...where))
        .orderBy(desc(t.hasadWithdrawals.requestedAt));
      const profit = can(actor, 'profit.view');
      const completed = data.filter((d) => d.status === 'COMPLETED');
      return {
        key: 'hasad',
        title: 'Hasad Withdrawal Report',
        description: 'Withdrawal requests from Hasad Gold and how each was fulfilled at the counter.',
        columns: [
          c('externalId', 'Withdrawal', 'code', '/hasad/:withdrawalId'),
          c('requestedAt', 'Requested', 'datetime'),
          c('customerName', 'Customer'),
          c('branchName', 'Branch'),
          c('entitledWeightMg', 'Entitled', 'weight'),
          c('deliveredWeightMg', 'Delivered', 'weight'),
          c('differenceMg', 'Difference', 'weight'),
          c('settlementDirection', 'Settlement', 'status'),
          c('settlementAmount', 'Amount', 'money'),
          ...(profit ? [c('itemsCost', 'Items cost', 'money')] : []),
          c('cashierName', 'Cashier'),
          c('status', 'Status', 'status'),
        ],
        rows: data,
        totals: {
          ...totalsOf(completed, ['entitledWeightMg', 'deliveredWeightMg', 'differenceMg', 'itemsCost']),
          paidToCustomers: completed.filter((d) => d.settlementDirection === 'BRANCH_PAYS_CUSTOMER').reduce((s, d) => s + num(d.settlementAmount), 0),
          collectedFromCustomers: completed.filter((d) => d.settlementDirection === 'CUSTOMER_PAYS_BRANCH').reduce((s, d) => s + num(d.settlementAmount), 0),
        },
        notes: ['Weight totals include completed withdrawals only. Difference = delivered − entitled (negative: branch paid the customer).'],
        filters: { dateRange: true, branch: true, user: true, status: ['READY_FOR_PICKUP', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] },
      };
    }
    case 'branch-performance': {
      const metrics = await branchMetrics(ctx.db, period, scope);
      const branches = await ctx.db.select().from(t.branches);
      const bn = new Map(branches.map((b) => [b.id, b.name]));
      const profit = can(actor, 'profit.view');
      const rowsAll = [...metrics.values()].map((m) => ({ ...m, branchName: bn.get(m.branchId) }));
      return {
        key: 'branch-performance',
        title: 'Branch Performance',
        description: 'Side-by-side operating results per branch for the selected period.',
        columns: [
          c('branchName', 'Branch', 'text', '/branches/:branchId'),
          c('salesCount', 'Sales #', 'number'),
          c('revenue', 'Sales', 'money'),
          c('purchasesCost', 'Purchases', 'money'),
          c('expenses', 'Expenses', 'money'),
          ...(profit ? [c('grossProfit', 'Gross profit', 'money'), c('contribution', 'Contribution', 'money'), c('inventoryCost', 'Inventory value', 'money')] : []),
          c('availableItems', 'Available items', 'number'),
          c('hasadCompleted', 'Hasad redemptions', 'number'),
          c('hasadWeightMg', 'Hasad weight', 'weight'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll, ['salesCount', 'revenue', 'purchasesCost', 'expenses', 'grossProfit', 'contribution', 'inventoryCost', 'availableItems', 'hasadCompleted', 'hasadWeightMg']),
        filters: { dateRange: true, branch: true, user: false },
      };
    }
    case 'user-activity': {
      requirePerm(actor, 'users.view');
      const r = await ctx.db.execute(sql`
        SELECT u.id AS user_id, u.full_name, u.username, r.name AS role, b.name AS branch_name, u.status, u.last_login_at,
          (SELECT count(*) FROM audit_logs a WHERE a.user_id = u.id AND a.action = 'LOGIN' AND a.at >= ${iso(period.start)} AND a.at < ${iso(period.end)}) AS logins,
          (SELECT count(*) FROM audit_logs a WHERE a.entity_id = u.username AND a.action = 'LOGIN_FAILED' AND a.at >= ${iso(period.start)} AND a.at < ${iso(period.end)}) AS failed_logins,
          (SELECT count(*) FROM sales s WHERE s.cashier_id = u.id AND s.status='COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}) AS sales_count,
          (SELECT coalesce(sum(total),0) FROM sales s WHERE s.cashier_id = u.id AND s.status='COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}) AS sales_total,
          (SELECT count(*) FROM hasad_redemptions h WHERE h.cashier_id = u.id AND h.status='COMPLETED' AND h.completed_at >= ${iso(period.start)} AND h.completed_at < ${iso(period.end)}) AS hasad_count,
          (SELECT count(*) FROM audit_logs a WHERE a.user_id = u.id AND a.at >= ${iso(period.start)} AND a.at < ${iso(period.end)}) AS actions,
          (SELECT count(*) FROM sessions se WHERE se.user_id = u.id AND se.status = 'ACTIVE') AS live_sessions
        FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN branches b ON b.id = u.branch_id
        WHERE true ${scope != null ? sql`AND u.branch_id = ${scope}` : sql``} ${q.userId ? sql`AND u.id = ${q.userId}` : sql``}
        ORDER BY r.rank DESC, b.id, u.username`);
      const data = rows<Record<string, unknown>>(r).map((x) => ({
        userId: num(x.user_id), fullName: x.full_name, username: x.username, role: x.role, branchName: x.branch_name ?? 'All branches',
        status: x.status, lastLoginAt: x.last_login_at, logins: num(x.logins), failedLogins: num(x.failed_logins),
        salesCount: num(x.sales_count), salesTotal: num(x.sales_total), hasadCount: num(x.hasad_count), actions: num(x.actions), liveSessions: num(x.live_sessions),
      }));
      return {
        key: 'user-activity',
        title: 'User Activity',
        description: 'What each account did in the period: sign-ins, transactions and audited actions.',
        columns: [
          c('fullName', 'User', 'text', '/audit?userId=:userId'),
          c('username', 'Username', 'code'),
          c('role', 'Role'),
          c('branchName', 'Branch'),
          c('logins', 'Sign-ins', 'number'),
          c('failedLogins', 'Failed sign-ins', 'number'),
          c('salesCount', 'Sales', 'number'),
          c('salesTotal', 'Sales value', 'money'),
          c('hasadCount', 'Hasad', 'number'),
          c('actions', 'Audited actions', 'number'),
          c('liveSessions', 'Live sessions', 'number'),
          c('lastLoginAt', 'Last sign-in', 'datetime'),
          c('status', 'Status', 'status'),
        ],
        rows: data,
        totals: totalsOf(data, ['logins', 'failedLogins', 'salesCount', 'salesTotal', 'hasadCount', 'actions']),
        filters: { dateRange: true, branch: true, user: true },
      };
    }
    case 'audit': {
      const data = await listAudit(ctx, actor, { ...q, from: period.fromKey, to: period.toKey, branchId: branchFilter });
      return {
        key: 'audit',
        title: 'Audit Log',
        description: 'Immutable trail of every important action.',
        columns: [
          c('at', 'Time', 'datetime'),
          c('userFullName', 'User'),
          c('role', 'Role', 'status'),
          c('branchName', 'Branch'),
          c('action', 'Action', 'status'),
          c('entityType', 'Entity'),
          c('entityId', 'Entity ID', 'code'),
          c('description', 'Description', 'audit'),
        ],
        rows: data,
        filters: { dateRange: true, branch: true, user: true },
      };
    }
    default:
      throw badRequest('Unknown report: {key}', { key });
  }
}

export async function listAudit(
  ctx: Ctx,
  actor: Actor,
  q: { from?: string; to?: string; branchId?: number; userId?: number; action?: string; q?: string; entityType?: string; limit?: number },
) {
  requirePerm(actor, 'audit.view');
  const scope = branchScope(actor, q.branchId);
  const period = await periodFor(ctx, q.from, q.to);
  const where: SQL[] = [gte(t.auditLogs.at, period.start), lt(t.auditLogs.at, period.end)];
  if (scope != null) where.push(eq(t.auditLogs.branchId, scope));
  if (q.userId) where.push(eq(t.auditLogs.userId, q.userId));
  if (q.action) where.push(inArray(t.auditLogs.action, q.action.split(',')));
  if (q.entityType) where.push(eq(t.auditLogs.entityType, q.entityType));
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(or(ilike(t.auditLogs.description, s), ilike(t.auditLogs.entityId, s), ilike(t.auditLogs.username, s))!);
  }
  return ctx.db
    .select({
      id: t.auditLogs.id,
      at: t.auditLogs.at,
      userId: t.auditLogs.userId,
      username: t.auditLogs.username,
      userFullName: t.auditLogs.userFullName,
      role: t.auditLogs.role,
      branchId: t.auditLogs.branchId,
      branchName: t.branches.name,
      action: t.auditLogs.action,
      entityType: t.auditLogs.entityType,
      entityId: t.auditLogs.entityId,
      description: t.auditLogs.description,
      descriptionKey: t.auditLogs.descriptionKey,
      descriptionParams: t.auditLogs.descriptionParams,
      ipAddress: t.auditLogs.ipAddress,
      sessionId: t.auditLogs.sessionId,
    })
    .from(t.auditLogs)
    .leftJoin(t.branches, eq(t.branches.id, t.auditLogs.branchId))
    .where(and(...where))
    .orderBy(desc(t.auditLogs.at), desc(t.auditLogs.id))
    .limit(Math.min(q.limit ?? 1500, 5000));
}
