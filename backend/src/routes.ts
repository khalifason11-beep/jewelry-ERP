// HTTP surface. Routes only parse/validate input and delegate to services with the Actor;
// all authorization and branch isolation happen inside the services.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { EXPENSE_CATEGORIES, KARATS, PAYMENT_METHODS, type SystemSettings } from '@jerp/shared';
import { config } from './config';
import type { Ctx } from './core/context';
import { actorOf, parse, zDay, zId, zOptId } from './core/http';
import { forbidden } from './core/errors';
import { writeAudit } from './core/audit';
import { branchScope, isGlobal, requirePerm } from './authz';
import { clientIp, requireAuth } from './auth/middleware';
import * as auth from './modules/auth/service';
import * as sessions from './modules/sessions/service';
import * as users from './modules/users/service';
import * as inventory from './modules/inventory/service';
import * as sales from './modules/sales/service';
import * as hasad from './modules/hasad/service';
import * as purchases from './modules/purchases/service';
import * as expenses from './modules/expenses/service';
import * as transfers from './modules/transfers/service';
import * as dashboard from './modules/dashboard/service';
import * as reports from './modules/reports/service';
import { notificationsFor } from './modules/notifications/service';
import { syncWithdrawals } from './modules/hasad/sync';
import { resetDemoData } from './seed/reset';

const zStatusList = z.preprocess((v) => (typeof v === 'string' && v ? v.split(',') : undefined), z.array(z.string()).optional());
const zBool = z.preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean());

export function apiRouter(ctx: Ctx): Router {
  const r = Router();

  // ─────────── auth (public) ───────────
  r.post('/auth/login', async (req, res) => {
    const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
    const s = await auth.login(ctx, { ...body, userAgent: req.header('user-agent'), ip: clientIp(req) });
    res.cookie(config.cookieName, s.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: 1000 * 60 * 60 * 24,
    });
    res.json(await auth.me(ctx, s.actor));
  });

  r.get('/health', async (_req, res) => {
    res.json({ ok: true, driver: ctx.handle.driver, hasad: ctx.hasad.mode });
  });

  r.use(requireAuth);

  r.get('/auth/me', async (req, res) => res.json(await auth.me(ctx, actorOf(req))));
  r.post('/auth/logout', async (req, res) => {
    await auth.logout(ctx, actorOf(req));
    res.clearCookie(config.cookieName, { path: '/' });
    res.json({ ok: true });
  });
  r.post('/auth/change-password', async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
    res.json(await auth.changePassword(ctx, actorOf(req), body));
  });

  // ─────────── reference data ───────────
  r.get('/branches', async (req, res) => {
    const actor = actorOf(req);
    const all = await ctx.db.select().from(t.branches).orderBy(t.branches.id);
    res.json(isGlobal(actor) ? all : all.filter((b) => b.id === actor.branchId));
  });
  /** All branch names — needed as transfer destinations. Contains no business data. */
  r.get('/branches/directory', async (_req, res) => {
    res.json(await ctx.db.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).orderBy(t.branches.id));
  });
  r.get('/categories', async (_req, res) => res.json(await inventory.listCategories(ctx)));
  r.get('/products', async (req, res) => res.json(await inventory.listProducts(ctx, actorOf(req))));
  r.get('/suppliers', async (req, res) => {
    requirePerm(actorOf(req), 'purchases.view');
    res.json(await purchases.listSuppliers(ctx));
  });
  r.get('/roles', async (req, res) => {
    requirePerm(actorOf(req), 'users.view');
    res.json(await users.listRoles(ctx));
  });
  r.get('/gold-rates', async (_req, res) => {
    res.json({ current: await ctx.settings.goldRates(), history: await ctx.settings.goldRateHistory() });
  });
  r.post('/gold-rates', async (req, res) => {
    const actor = actorOf(req);
    requirePerm(actor, 'settings.manage');
    const body = parse(z.object({ rates: z.record(z.string(), z.number().int().positive()) }), req.body);
    const before = await ctx.settings.goldRates();
    await ctx.db.transaction(async (tx) => {
      for (const [k, v] of Object.entries(body.rates)) {
        const karat = Number(k);
        if (!(KARATS as readonly number[]).includes(karat) || before[karat]?.pricePerGram === v) continue;
        await tx.insert(t.goldRates).values({ karat, pricePerGram: v, setBy: actor.userId });
        await writeAudit(tx, actor, {
          action: 'GOLD_RATE_CHANGED',
          entityType: 'gold_rate',
          entityId: `${karat}K`,
          branchId: null,
          description: `${karat}K gold rate ${before[karat]?.pricePerGram.toLocaleString()} → ${v.toLocaleString()} SDG/g`,
        });
      }
    });
    res.json({ current: await ctx.settings.goldRates() });
  });

  // ─────────── settings ───────────
  r.get('/settings', async (req, res) => {
    requirePerm(actorOf(req), 'settings.manage');
    res.json(await ctx.settings.get());
  });
  r.put('/settings', async (req, res) => {
    const actor = actorOf(req);
    requirePerm(actor, 'settings.manage');
    const patch = req.body as Partial<SystemSettings>;
    const next = await ctx.db.transaction(async (tx) => {
      const s = await ctx.settings.update(tx, patch, actor.userId);
      await writeAudit(tx, actor, {
        action: 'SETTINGS_CHANGED',
        entityType: 'settings',
        entityId: Object.keys(patch).join(','),
        branchId: null,
        description: `System settings changed: ${Object.keys(patch).join(', ')}`,
        metadata: { patch },
      });
      return s;
    });
    res.json(next);
  });

  // ─────────── sessions ───────────
  r.post('/sessions/heartbeat', async (_req, res) => res.json({ ok: true }));
  r.get('/sessions', async (req, res) => {
    const q = parse(z.object({ scope: z.enum(['active', 'recent']).default('active'), branchId: zOptId, mine: zBool.optional() }), req.query);
    res.json(await sessions.listSessions(ctx, actorOf(req), q));
  });
  r.post('/sessions/:key/revoke', async (req, res) => {
    await sessions.revokeSession(ctx, actorOf(req), String(req.params.key));
    res.json({ ok: true });
  });

  // ─────────── users ───────────
  r.get('/users', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }), req.query);
    res.json(await users.listUsers(ctx, actorOf(req), q));
  });
  r.post('/users', async (req, res) => {
    const body = parse(
      z.object({
        username: z.string().min(3),
        fullName: z.string().min(2),
        fullNameAr: z.string().optional(),
        phone: z.string().optional(),
        roleCode: z.string(),
        branchId: z.number().int().nullable().optional(),
        temporaryPassword: z.string().optional(),
      }),
      req.body,
    );
    res.json(await users.createUser(ctx, actorOf(req), body));
  });
  r.patch('/users/:id', async (req, res) => {
    const body = parse(
      z.object({ fullName: z.string().optional(), fullNameAr: z.string().optional(), phone: z.string().optional(), roleCode: z.string().optional(), branchId: z.number().int().nullable().optional() }),
      req.body,
    );
    res.json(await users.updateUser(ctx, actorOf(req), parse(zId, req.params.id), body));
  });
  r.post('/users/:id/reset-password', async (req, res) => res.json(await users.resetPassword(ctx, actorOf(req), parse(zId, req.params.id))));
  r.post('/users/:id/disable', async (req, res) => res.json(await users.setUserStatus(ctx, actorOf(req), parse(zId, req.params.id), 'DISABLED')));
  r.post('/users/:id/enable', async (req, res) => res.json(await users.setUserStatus(ctx, actorOf(req), parse(zId, req.params.id), 'ACTIVE')));

  // ─────────── inventory ───────────
  r.get('/inventory/items', async (req, res) => {
    const q = parse(
      z.object({
        branchId: zOptId,
        q: z.string().optional(),
        karat: z.coerce.number().int().optional(),
        category: z.string().optional(),
        status: zStatusList,
        sort: z.enum(['code', 'weight', 'price', 'recent', 'closest']).optional(),
        targetWeightMg: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().optional(),
        offset: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    res.json(await inventory.searchItems(ctx, actorOf(req), { ...q, status: q.status as never }));
  });
  r.get('/inventory/items/:id', async (req, res) => res.json(await inventory.getItemDetail(ctx, actorOf(req), parse(zId, req.params.id))));
  r.post('/inventory/items/:id/price', async (req, res) => {
    const body = parse(z.object({ sellingPrice: z.number().int().positive(), reason: z.string().default('') }), req.body);
    res.json(await inventory.changePrice(ctx, actorOf(req), parse(zId, req.params.id), body.sellingPrice, body.reason));
  });
  r.post('/inventory/items/:id/adjust', async (req, res) => {
    const body = parse(z.object({ action: z.enum(['MARK_DAMAGED', 'RESTOCK', 'RETURN_TO_SUPPLIER']), reason: z.string() }), req.body);
    res.json(await inventory.adjustItem(ctx, actorOf(req), parse(zId, req.params.id), body.action, body.reason));
  });

  // ─────────── sales ───────────
  r.post('/sales', async (req, res) => {
    const body = parse(
      z.object({
        branchId: z.number().int().optional(),
        items: z.array(z.object({ itemId: z.number().int(), discount: z.number().min(0).optional() })).min(1),
        paymentMethod: z.enum(PAYMENT_METHODS),
        customerName: z.string().optional(),
        customerPhone: z.string().optional(),
      }),
      req.body,
    );
    const sale = await sales.createSale(ctx, actorOf(req), body);
    res.json(await sales.getSale(ctx, actorOf(req), sale.id));
  });
  r.get('/sales', async (req, res) => {
    const q = parse(
      z.object({ from: zDay.optional(), to: zDay.optional(), branchId: zOptId, cashierId: zOptId, q: z.string().optional(), status: z.string().optional(), mine: zBool.optional() }),
      req.query,
    );
    res.json(await sales.listSales(ctx, actorOf(req), q));
  });
  r.get('/sales/:id', async (req, res) => res.json(await sales.getSale(ctx, actorOf(req), parse(zId, req.params.id))));
  r.post('/sales/:id/void', async (req, res) => {
    const body = parse(z.object({ reason: z.string().min(3) }), req.body);
    res.json(await sales.voidSale(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });

  // ─────────── Hasad ───────────
  r.get('/hasad/withdrawals', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, status: zStatusList, q: z.string().optional(), from: zDay.optional(), to: zDay.optional() }), req.query);
    res.json(await hasad.listWithdrawals(ctx, actorOf(req), { ...q, status: q.status as never }));
  });
  r.get('/hasad/withdrawals/:id', async (req, res) => res.json(await hasad.getWithdrawal(ctx, actorOf(req), parse(zId, req.params.id))));
  r.get('/hasad/withdrawals/:id/candidates', async (req, res) => {
    const q = parse(z.object({ q: z.string().optional(), karat: z.coerce.number().int().optional(), category: z.string().optional() }), req.query);
    res.json(await hasad.candidateItems(ctx, actorOf(req), parse(zId, req.params.id), q));
  });
  r.post('/hasad/withdrawals/:id/open', async (req, res) => {
    const body = parse(z.object({ verification: z.enum(['PICKUP_CODE', 'ID_DOCUMENT']), pickupCode: z.string().optional() }), req.body);
    res.json(await hasad.openWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body));
  });
  r.post('/hasad/withdrawals/:id/items', async (req, res) => {
    const body = parse(z.object({ itemId: z.number().int() }), req.body);
    res.json(await hasad.addItem(ctx, actorOf(req), parse(zId, req.params.id), body.itemId));
  });
  r.delete('/hasad/withdrawals/:id/items/:itemId', async (req, res) => {
    res.json(await hasad.removeItem(ctx, actorOf(req), parse(zId, req.params.id), parse(zId, req.params.itemId)));
  });
  r.post('/hasad/withdrawals/:id/complete', async (req, res) => {
    const body = parse(
      z.object({ paymentMethod: z.enum(PAYMENT_METHODS), customerAcknowledged: z.boolean(), expectedDirection: z.string(), expectedAmount: z.number().int() }),
      req.body,
    );
    res.json(await hasad.completeWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body));
  });
  r.post('/hasad/withdrawals/:id/abort', async (req, res) => {
    const body = parse(z.object({ reason: z.string().default('Customer left without completing') }), req.body);
    res.json(await hasad.abortRedemption(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });
  r.post('/hasad/withdrawals/:id/cancel', async (req, res) => {
    const body = parse(z.object({ reason: z.string().min(3) }), req.body);
    res.json(await hasad.cancelWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });

  // Mock Hasad simulator & integration monitor (demo tooling).
  const simulator = () => {
    if (!ctx.mockHasad) throw forbidden('Simulator is only available with the mock Hasad service');
    return ctx.mockHasad;
  };
  r.get('/hasad/simulator/customers', async (req, res) => {
    requirePerm(actorOf(req), 'hasad.simulate');
    res.json(await simulator().simulateCustomers());
  });
  r.post('/hasad/simulator/withdrawals', async (req, res) => {
    const actor = actorOf(req);
    requirePerm(actor, 'hasad.simulate');
    const body = parse(z.object({ customerId: z.string(), branchId: z.number().int(), weightMg: z.number().int().positive().optional() }), req.body);
    const [branch] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, body.branchId));
    const w = await simulator().simulateWithdrawalRequest({ customerId: body.customerId, branchCode: branch.hasadBranchCode!, weightMg: body.weightMg });
    await syncWithdrawals(ctx, true);
    res.json(w);
  });
  r.get('/hasad/integration-log', async (req, res) => {
    requirePerm(actorOf(req), 'hasad.simulate');
    res.json(ctx.mockHasad ? await ctx.mockHasad.recentCalls(80) : []);
  });

  // ─────────── purchases / expenses / transfers ───────────
  r.get('/purchases', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, from: zDay.optional(), to: zDay.optional(), q: z.string().optional() }), req.query);
    res.json(await purchases.listPurchases(ctx, actorOf(req), q));
  });
  r.get('/purchases/:id', async (req, res) => res.json(await purchases.getPurchase(ctx, actorOf(req), parse(zId, req.params.id))));
  r.post('/purchases', async (req, res) => {
    const line = z.object({
      productId: z.number().int(),
      grossWeightMg: z.number().int().positive(),
      netWeightMg: z.number().int().positive(),
      purchaseCost: z.number().int().positive(),
      makingCost: z.number().int().min(0),
      otherCost: z.number().int().min(0),
      sellingPrice: z.number().int().positive(),
    });
    const body = parse(
      z.object({ branchId: z.number().int().optional(), supplierId: z.number().int().optional(), supplierInvoiceNo: z.string().optional(), notes: z.string().optional(), lines: z.array(line).min(1) }),
      req.body,
    );
    res.json(await purchases.createPurchase(ctx, actorOf(req), body));
  });

  r.get('/expenses', async (req, res) => {
    const q = parse(
      z.object({ branchId: zOptId, from: zDay.optional(), to: zDay.optional(), category: z.string().optional(), status: z.string().optional(), q: z.string().optional() }),
      req.query,
    );
    res.json(await expenses.listExpenses(ctx, actorOf(req), q));
  });
  r.post('/expenses', async (req, res) => {
    const body = parse(
      z.object({ branchId: z.number().int().optional(), category: z.enum(EXPENSE_CATEGORIES), amount: z.number().positive(), expenseDate: zDay.optional(), description: z.string().min(2) }),
      req.body,
    );
    res.json(await expenses.createExpense(ctx, actorOf(req), body));
  });
  r.post('/expenses/:id/review', async (req, res) => {
    const body = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().optional() }), req.body);
    res.json(await expenses.reviewExpense(ctx, actorOf(req), parse(zId, req.params.id), body.decision, body.note));
  });

  r.get('/transfers', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, status: z.string().optional() }), req.query);
    res.json(await transfers.listTransfers(ctx, actorOf(req), q));
  });
  r.post('/transfers', async (req, res) => {
    const body = parse(
      z.object({ fromBranchId: z.number().int().optional(), toBranchId: z.number().int(), itemIds: z.array(z.number().int()).min(1), notes: z.string().optional() }),
      req.body,
    );
    res.json(await transfers.createTransfer(ctx, actorOf(req), body));
  });
  r.post('/transfers/:id/receive', async (req, res) => res.json(await transfers.receiveTransfer(ctx, actorOf(req), parse(zId, req.params.id))));

  // ─────────── dashboards, reports, audit, notifications ───────────
  r.get('/dashboard/branch', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, date: zDay.optional() }), req.query);
    res.json(await dashboard.branchDashboard(ctx, actorOf(req), q));
  });
  r.get('/dashboard/company', async (req, res) => {
    const q = parse(z.object({ from: zDay.optional(), to: zDay.optional() }), req.query);
    res.json(await dashboard.companyDashboard(ctx, actorOf(req), q));
  });
  const reportQuery = z.object({
    from: zDay.optional(),
    to: zDay.optional(),
    branchId: zOptId,
    userId: zOptId,
    status: z.string().optional(),
    q: z.string().optional(),
    group: z.enum(['branch', 'category', 'karat', 'cashier', 'day']).optional(),
    action: z.string().optional(),
  });
  r.get('/reports/:key', async (req, res) => {
    res.json(await reports.runReport(ctx, actorOf(req), String(req.params.key), parse(reportQuery, req.query)));
  });
  r.get('/audit', async (req, res) => {
    const q = parse(reportQuery.extend({ entityType: z.string().optional(), limit: z.coerce.number().int().optional() }), req.query);
    const data = await reports.listAudit(ctx, actorOf(req), q);
    res.json(data.map(({ sessionId, ...a }) => ({ ...a, sessionRef: sessionId ? sessions.sessionRef(sessionId) : null })));
  });
  r.get('/notifications', async (req, res) => res.json(await notificationsFor(ctx, actorOf(req))));

  // ─────────── demo tooling ───────────
  r.post('/demo/reset', async (req: Request, res: Response) => {
    const actor = actorOf(req);
    requirePerm(actor, 'settings.manage');
    await resetDemoData(ctx);
    res.clearCookie(config.cookieName, { path: '/' });
    res.json({ ok: true });
  });

  // Branch-scoped quick lookup used by the drill-down header.
  r.get('/branches/:id', async (req, res) => {
    const actor = actorOf(req);
    const id = parse(zId, req.params.id);
    branchScope(actor, id);
    const [b] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, id));
    const staff = await ctx.db.select({ id: t.users.id }).from(t.users).where(eq(t.users.branchId, id));
    res.json({ ...b, staffCount: staff.length });
  });
  return r;
}
