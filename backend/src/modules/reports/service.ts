// Report engine: every report returns the same shape (columns + rows + totals) so the UI
// renders, searches, sorts and exports all of them with one component.

import { pricingOf } from '../pricing/service';
import { and, desc, eq, gte, ilike, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import { ITEM_STATUSES, PAYMENT_METHODS, type ReportKey } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requirePerm } from '../../authz';
import { badRequest } from '../../core/errors';
import { nameOrAr, rows, num } from '../../core/sql';
import { periodFor } from '../dashboard/service';
import { maxIdOf, runPaged, type PageRequest, type SortSpec } from '../../core/paging';
import { itemsReportAggregates, pageItems, searchItems } from '../inventory/service';
import { listPurchases, pagePurchases, purchasesReportAggregates } from '../purchases/service';
import { listSales, pageSales, salesReportAggregates } from '../sales/service';
import { branchMetrics, movementSummary } from './metrics';
import { stockWeight, stockWeightRows, type StockWeight } from '../stock/weight';

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
  /** Headline figures shown above the table (Phase 4: stock weight incl. the broken-scrap pool). */
  summary?: { label: string; type: ColumnType; value: number }[];
  filters: { dateRange: boolean; branch: boolean; user: boolean; status?: string[] };
  /**
   * RPT-2: the reports that list rows show at most `rowCap` of them on screen. `rowCount` is the true number of rows,
   * `truncated` says the screen holds fewer; the totals and summary always cover every row, and the CSV export reads
   * every row page by page (`reportRowsPage`).
   */
  rowCount?: number;
  rowCap?: number;
  truncated?: boolean;
}

/**
 * RPT-2: the only row caps of the reports, in one place. The screen shows at most this many rows and says so
 * (`truncated`); totals are SQL aggregates over the whole result. A report path may not use another constant limit
 * (`test/report-caps.test.ts` reads the source).
 */
export const REPORT_ROW_CAPS = { sales: 1000, purchases: 1000, inventory: 1000, 'inventory-ledger': 2000, audit: 1500 } as const;
export type CappedReport = keyof typeof REPORT_ROW_CAPS;
export const isCappedReport = (key: string): key is CappedReport => key in REPORT_ROW_CAPS;

/** The row-count part of a capped report. */
const capInfo = (rowCount: number, cap: number, shown: number) => ({ rowCount, rowCap: cap, truncated: rowCount > shown });

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

function stockSummary(s: StockWeight): NonNullable<Report['summary']> {
  return [
    { label: 'Pieces weight', type: 'weight', value: s.items.weightMg },
    { label: 'Broken scrap weight', type: 'weight', value: s.brokenScrap.weightMg },
    { label: 'Total stock weight', type: 'weight', value: s.totalWeightMg },
    { label: 'Total as 24K pure gold', type: 'weight', value: s.totalPureMg24 },
  ];
}

const c = (key: string, label: string, type: ColumnType = 'text', link?: string): Column => ({ key, label, type, link });

/**
 * Completed sales grouped by payment channel; labels are the payment-method codes (translated by the UI). RPT-2: the
 * channel totals come from the database over the whole filtered result, never from the rows on screen.
 */
async function salesByChannel(ctx: Ctx, byChannel: Map<string, number>): Promise<NonNullable<Report['summary']>> {
  const { sales } = await ctx.settings.get();
  return PAYMENT_METHODS.filter((m) => sales.posPaymentMethods.includes(m) || byChannel.has(m)).map((m) => ({
    label: m,
    type: 'money' as const,
    value: byChannel.get(m) ?? 0,
  }));
}

function totalsOf(rowsAll: Record<string, unknown>[], keys: string[]) {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = rowsAll.reduce((s, r) => s + num(r[k]), 0);
  return out;
}

/** Test-only: lower caps prove that the totals do not depend on them. */
export interface ReportOptions {
  rowCaps?: Partial<Record<CappedReport, number>>;
}

export async function runReport(ctx: Ctx, actor: Actor, key: string, q: ReportQuery, opts: ReportOptions = {}): Promise<Report> {
  requirePerm(actor, 'reports.view');
  const cap = (k: CappedReport) => opts.rowCaps?.[k] ?? REPORT_ROW_CAPS[k];
  const scope = branchScope(actor, q.branchId);
  const period = await periodFor(ctx, q.from, q.to);
  const branchFilter = scope ?? undefined;
  const iso = (d: Date) => d.toISOString();
  const { company } = await ctx.settings.get();

  switch (key as ReportKey | 'inventory-ledger') {
    case 'sales': {
      const filter = { from: period.fromKey, to: period.toKey, branchId: branchFilter, cashierId: q.userId, q: q.q, status: q.status as 'COMPLETED' | 'VOIDED' | undefined };
      const [data, agg] = await Promise.all([listSales(ctx, actor, filter, cap('sales')), salesReportAggregates(ctx, actor, filter)]);
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
        ...capInfo(agg.rowCount, cap('sales'), rowsAll.length),
        totals: agg.totals,
        // Sales by payment channel (SPEC §10, §11): the counter's methods, plus any other method that has sales.
        summary: await salesByChannel(ctx, agg.byChannel),
        notes: ['Totals exclude cancelled (voided) sales.'],
        filters: { dateRange: true, branch: true, user: true, status: ['COMPLETED', 'VOIDED'] },
      };
    }
    case 'purchases': {
      requirePerm(actor, 'purchases.view');
      const filter = { branchId: branchFilter, from: period.fromKey, to: period.toKey, q: q.q };
      const [data, agg] = await Promise.all([listPurchases(ctx, actor, filter, cap('purchases')), purchasesReportAggregates(ctx, actor, filter)]);
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
        ...capInfo(agg.rowCount, cap('purchases'), rowsAll.length),
        totals: agg.totals,
        filters: { dateRange: true, branch: true, user: false },
      };
    }
    case 'inventory': {
      requirePerm(actor, 'inventory.view');
      const filter = { branchId: branchFilter, q: q.q, status: q.status ? [q.status as never] : undefined };
      const [{ items }, agg] = await Promise.all([searchItems(ctx, actor, { ...filter, limit: cap('inventory') }), itemsReportAggregates(ctx, actor, filter)]);
      // CAT-0: English names are optional; a report column (and its CSV) falls back to the Arabic name.
      const rowsAll = items.map((i) => ({ ...i, itemId: i.id, productName: i.productName?.trim() ? i.productName : i.productNameAr, categoryName: i.categoryName?.trim() ? i.categoryName : i.categoryNameAr }));
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
        ...capInfo(agg.rowCount, cap('inventory'), rowsAll.length),
        totals: agg.totals,
        summary: stockSummary((await stockWeight(ctx.db, scope)).total),
        filters: { dateRange: false, branch: true, user: false, status: [...ITEM_STATUSES] },
      };
    }
    case 'stock-weight': {
      requirePerm(actor, 'inventory.view');
      const sw = await stockWeight(ctx.db, scope);
      const branches = await ctx.db.select().from(t.branches);
      const bn = new Map(branches.map((b) => [b.id, b.name]));
      const rowsAll = stockWeightRows(sw.byBranch).map((r) => ({ ...r, branchName: bn.get(r.branchId) }));
      return {
        key: 'stock-weight',
        title: 'Stock Weight',
        description: 'Gold held by each branch as of now: sellable pieces plus the broken-scrap pool, by karat and as 24K pure gold.',
        columns: [
          c('branchName', 'Branch', 'text', '/branches/:branchId'),
          c('karat', 'Karat', 'number'),
          c('itemsWeightMg', 'Pieces (available)', 'weight'),
          c('brokenScrapWeightMg', 'Broken scrap', 'weight'),
          c('totalWeightMg', 'Total weight', 'weight'),
          c('totalPureMg24', '24K equivalent', 'weight'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll, ['itemsWeightMg', 'brokenScrapWeightMg', 'totalWeightMg', 'totalPureMg24']),
        summary: stockSummary(sw.total),
        notes: ['24K equivalent = weight × karat ÷ 24, rounded to the milligram once per karat.'],
        filters: { dateRange: false, branch: true, user: false },
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
        transfersOut: L(m, 'TRANSFER_OUT').items,
        damaged: L(m, 'DAMAGE').items + L(m, 'ADJUSTMENT_OUT').items,
        closingItems: m.closing.items,
        closingWeightMg: m.closing.weightMg,
        weightIn: L(m, 'PURCHASE').weightMg + L(m, 'TRANSFER_IN').weightMg + L(m, 'RETURN').weightMg + L(m, 'ADJUSTMENT_IN').weightMg,
        weightOut: L(m, 'SALE').weightMg + L(m, 'TRANSFER_OUT').weightMg + L(m, 'DAMAGE').weightMg + L(m, 'ADJUSTMENT_OUT').weightMg,
      }));
      return {
        key: 'inventory-movement',
        title: 'Inventory Movement',
        description: 'Opening stock + purchases + transfers in − sales − transfers out − damaged = closing stock. Derived from the ledger.',
        columns: [
          c('branchName', 'Branch'),
          c('openingItems', 'Opening', 'number'),
          c('openingWeightMg', 'Opening wt', 'weight'),
          c('purchases', '+ Purchases', 'number'),
          c('transfersIn', '+ Transfers in', 'number'),
          c('returns', '+ Returns/adj.', 'number'),
          c('sales', '− Sales', 'number'),
          c('transfersOut', '− Transfers out', 'number'),
          c('damaged', '− Damaged/adj.', 'number'),
          c('closingItems', '= Closing', 'number'),
          c('closingWeightMg', 'Closing wt', 'weight'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll, ['openingItems', 'openingWeightMg', 'purchases', 'transfersIn', 'returns', 'sales', 'transfersOut', 'damaged', 'closingItems', 'closingWeightMg']),
        filters: { dateRange: true, branch: true, user: false },
      };
    }
    case 'inventory-ledger': {
      const where = ledgerWhere(actor, scope, period, q);
      const [data, rowCount] = await Promise.all([
        ledgerFrom(ctx.db).where(and(...where)).orderBy(desc(t.inventoryMovements.at), desc(t.inventoryMovements.id)).limit(cap('inventory-ledger')),
        countLedger(ctx.db, and(...where)),
      ]);
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
        ...capInfo(rowCount, cap('inventory-ledger'), data.length),
        filters: { dateRange: true, branch: true, user: true, status: ['PURCHASE', 'SALE', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN', 'ADJUSTMENT', 'DAMAGE'] },
      };
    }
    case 'profit': {
      requirePerm(actor, 'profit.view');
      const group = q.group ?? 'branch';
      let rowsAll: Record<string, unknown>[];
      if (group === 'branch') {
        const metrics = await branchMetrics(ctx.db, period, scope, await pricingOf(ctx));
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
        }));
      } else {
        const dim =
          group === 'category' ? sql`coalesce(nullif(btrim(c.name), ''), c.name_ar)` : group === 'karat' ? sql`(si.karat || 'K')` : group === 'cashier' ? sql`u.full_name` : sql`to_char(s.created_at AT TIME ZONE ${company.timezone},'YYYY-MM-DD')`;
        const r = await ctx.db.execute(sql`
          SELECT ${dim} AS label, ${group === 'category' ? sql`c.name_ar` : sql`NULL`} AS label_ar, count(DISTINCT s.id) AS sales_count, coalesce(sum(si.final_price),0) AS revenue,
                 coalesce(sum(si.discount),0) AS discounts, coalesce(sum(si.unit_cost),0) AS cost
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          JOIN jewelry_items i ON i.id = si.item_id JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
          JOIN users u ON u.id = s.cashier_id
          WHERE s.status = 'COMPLETED' AND s.created_at >= ${iso(period.start)} AND s.created_at < ${iso(period.end)}
          ${scope != null ? sql`AND s.branch_id = ${scope}` : sql``}
          GROUP BY ${group === 'category' ? sql`c.id, c.name, c.name_ar` : sql`1`} ORDER BY 1`);
        rowsAll = rows<Record<string, unknown>>(r).map((x) => {
          const revenue = num(x.revenue);
          const cost = num(x.cost);
          // Types group by id (two types may share an English name); labelAr is the Arabic companion.
          return { label: String(x.label), ...(group === 'category' ? { labelAr: String(x.label_ar) } : {}), salesCount: num(x.sales_count), revenue, discounts: num(x.discounts), costOfSales: cost, grossProfit: revenue - cost, margin: revenue ? ((revenue - cost) / revenue) * 100 : 0 };
        });
      }
      const totals = totalsOf(rowsAll, ['salesCount', 'revenue', 'discounts', 'costOfSales', 'grossProfit']);
      totals.margin = totals.revenue ? (totals.grossProfit / totals.revenue) * 100 : 0;
      return {
        key: 'profit',
        title: 'Profit Report',
        description: 'Gross profit = selling price (after discount) − item total cost.',
        columns: [
          c('label', group === 'branch' ? 'Branch' : group[0].toUpperCase() + group.slice(1), 'text', group === 'branch' ? '/branches/:branchId' : undefined),
          c('salesCount', 'Sales', 'number'),
          c('revenue', 'Revenue', 'money'),
          c('discounts', 'Discounts', 'money'),
          c('costOfSales', 'Cost of sales', 'money'),
          c('grossProfit', 'Gross profit', 'money'),
          c('margin', 'Margin', 'percent'),
        ],
        rows: rowsAll,
        totals,
        notes: [
          'Item cost = purchase cost + making cost + other cost (components kept separately; definition configurable with the client).',
        ],
        filters: { dateRange: true, branch: true, user: false },
      };
    }
    case 'branch-performance': {
      const metrics = await branchMetrics(ctx.db, period, scope, await pricingOf(ctx));
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
          ...(profit ? [c('grossProfit', 'Gross profit', 'money'), c('inventoryCost', 'Inventory value', 'money')] : []),
          c('availableItems', 'Available items', 'number'),
        ],
        rows: rowsAll,
        totals: totalsOf(rowsAll, ['salesCount', 'revenue', 'purchasesCost', 'grossProfit', 'inventoryCost', 'availableItems']),
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
            (SELECT count(*) FROM audit_logs a WHERE a.user_id = u.id AND a.at >= ${iso(period.start)} AND a.at < ${iso(period.end)}) AS actions,
          (SELECT count(*) FROM sessions se WHERE se.user_id = u.id AND se.status = 'ACTIVE') AS live_sessions
        FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN branches b ON b.id = u.branch_id
        WHERE true ${scope != null ? sql`AND u.branch_id = ${scope}` : sql``} ${q.userId ? sql`AND u.id = ${q.userId}` : sql``}
        ORDER BY r.rank DESC, b.id, u.username`);
      const data = rows<Record<string, unknown>>(r).map((x) => ({
        userId: num(x.user_id), fullName: x.full_name, username: x.username, role: x.role, branchName: x.branch_name ?? 'All branches',
        status: x.status, lastLoginAt: x.last_login_at, logins: num(x.logins), failedLogins: num(x.failed_logins),
        salesCount: num(x.sales_count), salesTotal: num(x.sales_total), actions: num(x.actions), liveSessions: num(x.live_sessions),
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
          c('actions', 'Audited actions', 'number'),
          c('liveSessions', 'Live sessions', 'number'),
          c('lastLoginAt', 'Last sign-in', 'datetime'),
          c('status', 'Status', 'status'),
        ],
        rows: data,
        totals: totalsOf(data, ['logins', 'failedLogins', 'salesCount', 'salesTotal', 'actions']),
        filters: { dateRange: true, branch: true, user: true },
      };
    }
    case 'audit': {
      const filter = { ...q, from: period.fromKey, to: period.toKey, branchId: branchFilter };
      const [data, rowCount] = await Promise.all([listAudit(ctx, actor, { ...filter, limit: cap('audit') }), countAudit(ctx, actor, filter)]);
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
        ...capInfo(rowCount, cap('audit'), data.length),
        filters: { dateRange: true, branch: true, user: true },
      };
    }
    default:
      throw badRequest('Unknown report: {key}', { key });
  }
}

interface AuditQuery {
  from?: string;
  to?: string;
  branchId?: number;
  userId?: number;
  action?: string;
  q?: string;
  entityType?: string;
}

async function auditWhere(ctx: Ctx, actor: Actor, q: AuditQuery): Promise<SQL[]> {
  requirePerm(actor, 'audit.view');
  const scope = branchScope(actor, q.branchId);
  const period = await periodFor(ctx, q.from, q.to);
  const where: SQL[] = [gte(t.auditLogs.at, period.start), lt(t.auditLogs.at, period.end)];
  if (scope != null) where.push(eq(t.auditLogs.branchId, scope));
  if (q.userId) where.push(eq(t.auditLogs.userId, q.userId));
  if (q.action) where.push(inArray(t.auditLogs.action, q.action.split(',')));
  if (q.entityType) where.push(eq(t.auditLogs.entityType, q.entityType));
  // CSH-2 (D-csh-5): the General Manager's funding of a branch is his own business; without `funding.view` (the
  // branch manager reading their branch's log) those rows are left out, so nothing reveals what is owed to him.
  if (!actor.permissions.has('funding.view')) where.push(ne(t.auditLogs.entityType, 'gm_funding_event'));
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(or(ilike(t.auditLogs.description, s), ilike(t.auditLogs.entityId, s), ilike(t.auditLogs.username, s))!);
  }
  return where;
}

const auditListFrom = (db: Ctx['db']) =>
  db
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
    .leftJoin(t.branches, eq(t.branches.id, t.auditLogs.branchId));

/** The audit report's rows on screen: newest first, at most `q.limit` (RPT-2: the report says when it is cut). */
export async function listAudit(ctx: Ctx, actor: Actor, q: AuditQuery & { limit: number }) {
  const where = await auditWhere(ctx, actor, q);
  return auditListFrom(ctx.db)
    .where(and(...where))
    .orderBy(desc(t.auditLogs.at), desc(t.auditLogs.id))
    .limit(q.limit);
}

/** RPT-2: the audit report's true row count (same filters and scope). */
async function countAudit(ctx: Ctx, actor: Actor, q: AuditQuery) {
  const where = await auditWhere(ctx, actor, q);
  return Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.auditLogs).where(and(...where)))[0].n);
}

export const AUDIT_SORT_KEYS = ['date', 'action', 'user'] as const;
export type AuditSortKey = (typeof AUDIT_SORT_KEYS)[number];
const auditSorts: Record<AuditSortKey, SortSpec> = {
  date: { by: t.auditLogs.at, field: 'at', dir: 'desc' },
  action: { by: t.auditLogs.action, field: 'action', dir: 'asc' },
  user: { by: t.auditLogs.username, field: 'username', dir: 'asc' },
};

/** BE-7: the audit log, one page at a time (`GET /audit`). */
export async function pageAudit(ctx: Ctx, actor: Actor, q: AuditQuery & PageRequest<AuditSortKey>) {
  const where = await auditWhere(ctx, actor, q);
  return runPaged(actor, q, {
    sorts: auditSorts,
    defaultSort: 'date',
    id: t.auditLogs.id,
    where,
    maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.auditLogs.id) }).from(t.auditLogs))[0].m),
    count: async (w) => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t.auditLogs).where(w))[0].n),
    rows: ({ where: w, orderBy, limit, offset }) => auditListFrom(ctx.db).where(w).orderBy(...orderBy).limit(limit).offset(offset),
  });
}

// ── RPT-2: the inventory ledger's filters, rows and count, and every capped report one page at a time ──

type Period = Awaited<ReturnType<typeof periodFor>>;

function ledgerWhere(actor: Actor, scope: number | null, period: Period, q: ReportQuery): SQL[] {
  requirePerm(actor, 'inventory.view');
  const where: SQL[] = [gte(t.inventoryMovements.at, period.start), lt(t.inventoryMovements.at, period.end)];
  if (scope != null) where.push(eq(t.inventoryMovements.branchId, scope));
  if (q.status) where.push(eq(t.inventoryMovements.type, q.status));
  if (q.userId) where.push(eq(t.inventoryMovements.userId, q.userId));
  if (q.q?.trim()) where.push(or(ilike(t.jewelryItems.code, `%${q.q}%`), ilike(t.inventoryMovements.refNumber, `%${q.q}%`))!);
  return where;
}

const ledgerFrom = (db: Ctx['db']) =>
  db
    .select({
      at: t.inventoryMovements.at,
      itemId: t.jewelryItems.id,
      itemCode: t.jewelryItems.code,
      productName: nameOrAr(t.products.name, t.products.nameAr),
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
    .leftJoin(t.users, eq(t.users.id, t.inventoryMovements.userId));

const countLedger = async (db: Ctx['db'], where: SQL | undefined) =>
  Number(
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(t.inventoryMovements)
        .innerJoin(t.jewelryItems, eq(t.jewelryItems.id, t.inventoryMovements.itemId))
        .where(where)
    )[0].n,
  );

/**
 * RPT-2: one page of a capped report's rows (the CSV export walks every page), with the report's filters, scope,
 * cost rules and order, through the BE-7 helper and its snapshot id. The rows have the report's fields.
 */
export async function reportRowsPage(ctx: Ctx, actor: Actor, key: string, q: ReportQuery & { page: number; pageSize?: number; asOfId?: number }) {
  requirePerm(actor, 'reports.view');
  if (!isCappedReport(key)) throw badRequest('This report is not paged: it has no row limit');
  const scope = branchScope(actor, q.branchId);
  const period = await periodFor(ctx, q.from, q.to);
  const branchFilter = scope ?? undefined;
  const pageReq = { page: q.page, pageSize: q.pageSize, asOfId: q.asOfId };
  switch (key) {
    case 'sales': {
      const p = await pageSales(ctx, actor, { from: period.fromKey, to: period.toKey, branchId: branchFilter, cashierId: q.userId, q: q.q, status: q.status as 'COMPLETED' | 'VOIDED' | undefined, ...pageReq }, { withTotals: false });
      return { rows: p.rows.map((s) => ({ ...s, saleId: s.id })), total: p.total, page: p.page };
    }
    case 'purchases': {
      requirePerm(actor, 'purchases.view');
      const p = await pagePurchases(ctx, actor, { branchId: branchFilter, from: period.fromKey, to: period.toKey, q: q.q, ...pageReq }, { withTotals: false });
      return { rows: p.rows.map((r) => ({ ...r, purchaseId: r.id })), total: p.total, page: p.page };
    }
    case 'inventory': {
      requirePerm(actor, 'inventory.view');
      const p = await pageItems(ctx, actor, { branchId: branchFilter, q: q.q, status: q.status ? [q.status as never] : undefined, ...pageReq }, { withTotals: false });
      const rowsAll = p.rows.map((i) => ({ ...i, itemId: i.id, productName: i.productName?.trim() ? i.productName : i.productNameAr, categoryName: i.categoryName?.trim() ? i.categoryName : i.categoryNameAr }));
      return { rows: rowsAll, total: p.total, page: p.page };
    }
    case 'inventory-ledger': {
      const where = ledgerWhere(actor, scope, period, q);
      return runPaged(actor, pageReq, {
        sorts: { date: { by: t.inventoryMovements.at, field: 'at', dir: 'desc' } },
        defaultSort: 'date',
        id: t.inventoryMovements.id,
        where,
        maxId: async () => Number((await ctx.db.select({ m: maxIdOf(t.inventoryMovements.id) }).from(t.inventoryMovements))[0].m),
        count: (w) => countLedger(ctx.db, w),
        rows: ({ where: w, orderBy, limit, offset }) => ledgerFrom(ctx.db).where(w).orderBy(...orderBy).limit(limit).offset(offset),
      });
    }
    case 'audit': {
      const p = await pageAudit(ctx, actor, { ...q, from: period.fromKey, to: period.toKey, branchId: branchFilter, ...pageReq });
      return { rows: p.rows, total: p.total, page: p.page };
    }
  }
}
