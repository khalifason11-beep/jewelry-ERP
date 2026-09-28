// HTTP surface. Routes only parse/validate input and delegate to services with the Actor;
// all authorization and branch isolation happen inside the services.
//
// Validation rules (security item 4): every body/query/params schema is `.strict()` (unknown
// fields are rejected), every number is an integer with explicit bounds, money and weights are
// non-negative, text has a maximum length, karats come from the allowed set.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { EXPENSE_CATEGORIES, KARATS, PAYMENT_METHODS, ap } from '@jerp/shared';
import type { Config } from './config';
import type { Ctx } from './core/context';
import { actorOf, parse, zId, zOptId, zDay } from './core/http';
import { forbidden, notFound } from './core/errors';
import { writeAudit } from './core/audit';
import { branchScope, isGlobal, requirePerm } from './authz';
import { clientIp, requireAuth } from './auth/middleware';
import { requireRecentReauth } from './auth/reauth';
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
import { settingsPatchSchema } from './modules/settings/schema';
import { notificationsFor } from './modules/notifications/service';
import { syncWithdrawals } from './modules/hasad/sync';
import { resetDemoData } from './seed/reset';
import { DEMO_PASSWORDS, USERS } from './seed/catalog';

// ───────── shared validators ─────────
/** 1 trillion SDG: far above any real amount, far below JS/bigint limits. */
const MAX_MONEY = 1_000_000_000_000;
/** 10 kg per piece (in milligrams). */
const MAX_WEIGHT_MG = 10_000_000;
const zMoney = z.number().int().min(0).max(MAX_MONEY);
const zPositiveMoney = z.number().int().min(1).max(MAX_MONEY);
const zWeightMg = z.number().int().min(1).max(MAX_WEIGHT_MG);
const zIdBody = z.number().int().positive().max(2_147_483_647);
const zText = (max: number) => z.string().trim().max(max);
const zKarat = z.coerce.number().int().refine((k) => (KARATS as readonly number[]).includes(k), 'Unsupported karat');
const zStatusList = z.preprocess((v) => (typeof v === 'string' && v ? v.split(',') : undefined), z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(20).optional());
const zBool = z.preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean());
const zQ = zText(100).optional();

export function apiRouter(ctx: Ctx, config: Config): Router {
  const r = Router();
  const demo = config.appMode === 'demo';

  const setSessionCookie = async (res: Response, token: string) => {
    const { security } = await ctx.settings.get();
    res.cookie(config.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: security.sessionAbsoluteHours * 3600_000,
    });
  };

  // ─────────── public ───────────
  r.post('/auth/login', async (req, res) => {
    const body = parse(z.object({ username: zText(64).min(1), password: z.string().min(1).max(128) }).strict(), req.body);
    const s = await auth.login(ctx, { ...body, userAgent: req.header('user-agent'), ip: clientIp(req) });
    await setSessionCookie(res, s.token);
    res.json(await auth.me(ctx, s.actor));
  });

  /** Public, non-sensitive app metadata for the login screen. Demo credentials only in demo mode. */
  r.get('/meta', async (_req, res) => {
    const { company } = await ctx.settings.get();
    res.json({
      appMode: config.appMode,
      company: { name: company.name, nameAr: company.nameAr },
      demoAccounts: demo
        ? USERS.filter((u) => ['general.manager', 'branch.manager.kh', 'cashier.kh.01', 'cashier.kh.02', 'branch.manager.omd', 'cashier.omd.01'].includes(u.username)).map((u) => ({
            username: u.username,
            password: DEMO_PASSWORDS[u.role],
            role: u.role,
            branch: u.branch,
          }))
        : [],
    });
  });

  r.get('/health', async (_req, res) => {
    res.json(config.production ? { ok: true } : { ok: true, driver: ctx.handle.driver, hasad: ctx.hasad.mode, appMode: config.appMode });
  });

  r.use(requireAuth);

  // ─────────── own account ───────────
  r.get('/auth/me', async (req, res) => res.json(await auth.me(ctx, actorOf(req))));
  r.post('/auth/logout', async (req, res) => {
    await auth.logout(ctx, actorOf(req));
    res.clearCookie(config.cookieName, { path: '/', secure: config.cookieSecure, sameSite: 'lax', httpOnly: true });
    res.json({ ok: true });
  });
  r.post('/auth/change-password', async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }).strict(), req.body);
    const result = await auth.changePassword(ctx, actorOf(req), { ...body, userAgent: req.header('user-agent') });
    await setSessionCookie(res, result.token);
    const actor = (await sessions.loadActor(ctx.db, actorOf(req).userId, result.sessionId))!;
    res.json(await auth.me(ctx, actor));
  });
  r.post('/auth/reauth', async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1).max(128) }).strict(), req.body);
    res.json(await auth.reauthenticate(ctx, actorOf(req), body.password));
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
    const body = parse(
      z.object({ rates: z.partialRecord(z.enum(KARATS.map(String) as [string, ...string[]]), zPositiveMoney.max(100_000_000)) }).strict(),
      req.body,
    );
    await requireRecentReauth(ctx, req);
    const before = await ctx.settings.goldRates();
    await ctx.db.transaction(async (tx) => {
      for (const [k, v] of Object.entries(body.rates) as [string, number][]) {
        const karat = Number(k);
        if (before[karat]?.pricePerGram === v) continue;
        await tx.insert(t.goldRates).values({ karat, pricePerGram: v, setBy: actor.userId });
        await writeAudit(tx, actor, {
          action: 'GOLD_RATE_CHANGED',
          entityType: 'gold_rate',
          entityId: `${karat}K`,
          branchId: null,
          key: '{karat} gold rate {from} → {to} per gram',
          params: { karat: ap.karat(karat), from: ap.money(before[karat]?.pricePerGram ?? 0), to: ap.money(v) },
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
    const patch = parse(settingsPatchSchema, req.body);
    if (patch.mockHasad && !demo) throw forbidden();
    await requireRecentReauth(ctx, req);
    const next = await ctx.db.transaction(async (tx) => {
      const s = await ctx.settings.update(tx, patch, actor.userId);
      await writeAudit(tx, actor, {
        action: 'SETTINGS_CHANGED',
        entityType: 'settings',
        entityId: Object.keys(patch).join(','),
        branchId: null,
        key: 'System settings changed: {sections}',
        params: { sections: ap.list(Object.keys(patch).map((k) => ap.enum(k))) },
        metadata: { patch },
      });
      return s;
    });
    res.json(next);
  });

  // ─────────── sessions ───────────
  r.post('/sessions/heartbeat', async (_req, res) => res.json({ ok: true }));
  r.get('/sessions', async (req, res) => {
    const q = parse(z.object({ scope: z.enum(['active', 'recent']).default('active'), branchId: zOptId, mine: zBool.optional() }).strict(), req.query);
    res.json(await sessions.listSessions(ctx, actorOf(req), q));
  });
  r.post('/sessions/:key/revoke', async (req, res) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[0-9a-f]{16}$/) }).strict(), req.params);
    await sessions.revokeSession(ctx, actorOf(req), key);
    res.json({ ok: true });
  });

  // ─────────── users ───────────
  const zUsername = zText(40).min(3);
  const zFullName = zText(120).min(2);
  const zPhone = zText(30).regex(/^[+\d\s()-]*$/);
  const zRoleCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
  r.get('/users', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }).strict(), req.query);
    res.json(await users.listUsers(ctx, actorOf(req), q));
  });
  r.post('/users', async (req, res) => {
    const body = parse(
      z
        .object({
          username: zUsername,
          fullName: zFullName,
          fullNameAr: zText(120).optional(),
          phone: zPhone.optional(),
          roleCode: zRoleCode,
          branchId: zIdBody.nullable().optional(),
          temporaryPassword: z.string().max(128).optional(),
        })
        .strict(),
      req.body,
    );
    requirePerm(actorOf(req), 'users.manage');
    await requireRecentReauth(ctx, req); // assigns a role
    res.json(await users.createUser(ctx, actorOf(req), body));
  });
  r.patch('/users/:id', async (req, res) => {
    const body = parse(
      z
        .object({ fullName: zFullName.optional(), fullNameAr: zText(120).optional(), phone: zPhone.optional(), roleCode: zRoleCode.optional(), branchId: zIdBody.nullable().optional() })
        .strict(),
      req.body,
    );
    const id = parse(zId, req.params.id);
    requirePerm(actorOf(req), 'users.manage');
    if (body.roleCode !== undefined || body.branchId !== undefined) await requireRecentReauth(ctx, req);
    res.json(await users.updateUser(ctx, actorOf(req), id, body));
  });
  r.post('/users/:id/reset-password', async (req, res) => {
    const id = parse(zId, req.params.id);
    requirePerm(actorOf(req), 'users.manage');
    await requireRecentReauth(ctx, req);
    res.json(await users.resetPassword(ctx, actorOf(req), id));
  });
  r.post('/users/:id/disable', async (req, res) => res.json(await users.setUserStatus(ctx, actorOf(req), parse(zId, req.params.id), 'DISABLED')));
  r.post('/users/:id/enable', async (req, res) => res.json(await users.setUserStatus(ctx, actorOf(req), parse(zId, req.params.id), 'ACTIVE')));
  r.post('/users/:id/unlock', async (req, res) => res.json(await users.unlockUser(ctx, actorOf(req), parse(zId, req.params.id))));

  // ─────────── inventory ───────────
  r.get('/inventory/items', async (req, res) => {
    const q = parse(
      z
        .object({
          branchId: zOptId,
          q: zQ,
          karat: zKarat.optional(),
          category: z.string().regex(/^[A-Z_]{2,30}$/).optional(),
          status: zStatusList,
          sort: z.enum(['code', 'weight', 'price', 'recent', 'closest']).optional(),
          targetWeightMg: z.coerce.number().int().min(0).max(MAX_WEIGHT_MG).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
          offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
        })
        .strict(),
      req.query,
    );
    res.json(await inventory.searchItems(ctx, actorOf(req), { ...q, status: q.status as never }));
  });
  r.get('/inventory/items/:id', async (req, res) => res.json(await inventory.getItemDetail(ctx, actorOf(req), parse(zId, req.params.id))));
  r.post('/inventory/items/:id/price', async (req, res) => {
    const body = parse(z.object({ sellingPrice: zPositiveMoney, reason: zText(500).default('') }).strict(), req.body);
    res.json(await inventory.changePrice(ctx, actorOf(req), parse(zId, req.params.id), body.sellingPrice, body.reason));
  });
  r.post('/inventory/items/:id/adjust', async (req, res) => {
    const body = parse(z.object({ action: z.enum(['MARK_DAMAGED', 'RESTOCK', 'RETURN_TO_SUPPLIER']), reason: zText(500).min(3) }).strict(), req.body);
    const id = parse(zId, req.params.id);
    requirePerm(actorOf(req), 'inventory.adjust');
    await requireRecentReauth(ctx, req);
    res.json(await inventory.adjustItem(ctx, actorOf(req), id, body.action, body.reason));
  });

  // ─────────── sales ───────────
  r.post('/sales', async (req, res) => {
    const body = parse(
      z
        .object({
          branchId: zIdBody.optional(),
          items: z.array(z.object({ itemId: zIdBody, discount: zMoney.optional() }).strict()).min(1).max(50),
          paymentMethod: z.enum(PAYMENT_METHODS),
          customerName: zText(120).optional(),
          customerPhone: zPhone.optional(),
        })
        .strict(),
      req.body,
    );
    const sale = await sales.createSale(ctx, actorOf(req), body);
    res.json(await sales.getSale(ctx, actorOf(req), sale.id));
  });
  r.get('/sales', async (req, res) => {
    const q = parse(
      z
        .object({ from: zDay.optional(), to: zDay.optional(), branchId: zOptId, cashierId: zOptId, q: zQ, status: z.enum(['COMPLETED', 'VOIDED']).optional(), mine: zBool.optional() })
        .strict(),
      req.query,
    );
    res.json(await sales.listSales(ctx, actorOf(req), q));
  });
  r.get('/sales/:id', async (req, res) => res.json(await sales.getSale(ctx, actorOf(req), parse(zId, req.params.id))));
  r.post('/sales/:id/void', async (req, res) => {
    const body = parse(z.object({ reason: zText(500).min(3) }).strict(), req.body);
    res.json(await sales.voidSale(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });

  // ─────────── Hasad ───────────
  r.get('/hasad/withdrawals', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, status: zStatusList, q: zQ, from: zDay.optional(), to: zDay.optional() }).strict(), req.query);
    res.json(await hasad.listWithdrawals(ctx, actorOf(req), { ...q, status: q.status as never }));
  });
  r.get('/hasad/withdrawals/:id', async (req, res) => res.json(await hasad.getWithdrawal(ctx, actorOf(req), parse(zId, req.params.id))));
  r.get('/hasad/withdrawals/:id/candidates', async (req, res) => {
    const q = parse(z.object({ q: zQ, karat: zKarat.optional(), category: z.string().regex(/^[A-Z_]{2,30}$/).optional() }).strict(), req.query);
    res.json(await hasad.candidateItems(ctx, actorOf(req), parse(zId, req.params.id), q));
  });
  r.post('/hasad/withdrawals/:id/open', async (req, res) => {
    const body = parse(z.object({ verification: z.enum(['PICKUP_CODE', 'ID_DOCUMENT']), pickupCode: z.string().regex(/^\d{4,8}$/).optional() }).strict(), req.body);
    res.json(await hasad.openWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body));
  });
  r.post('/hasad/withdrawals/:id/items', async (req, res) => {
    const body = parse(z.object({ itemId: zIdBody }).strict(), req.body);
    res.json(await hasad.addItem(ctx, actorOf(req), parse(zId, req.params.id), body.itemId));
  });
  r.delete('/hasad/withdrawals/:id/items/:itemId', async (req, res) => {
    res.json(await hasad.removeItem(ctx, actorOf(req), parse(zId, req.params.id), parse(zId, req.params.itemId)));
  });
  r.post('/hasad/withdrawals/:id/complete', async (req, res) => {
    const body = parse(
      z
        .object({
          paymentMethod: z.enum(PAYMENT_METHODS),
          customerAcknowledged: z.boolean(),
          expectedDirection: z.enum(['BRANCH_PAYS_CUSTOMER', 'CUSTOMER_PAYS_BRANCH', 'NONE']),
          expectedAmount: zMoney,
        })
        .strict(),
      req.body,
    );
    res.json(await hasad.completeWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body));
  });
  r.post('/hasad/withdrawals/:id/abort', async (req, res) => {
    const body = parse(z.object({ reason: zText(500).min(3).default('Customer left without completing') }).strict(), req.body);
    res.json(await hasad.abortRedemption(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });
  r.post('/hasad/withdrawals/:id/cancel', async (req, res) => {
    const body = parse(z.object({ reason: zText(500).min(3) }).strict(), req.body);
    res.json(await hasad.cancelWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });

  // ─────────── purchases / expenses / transfers ───────────
  r.get('/purchases', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, from: zDay.optional(), to: zDay.optional(), q: zQ }).strict(), req.query);
    res.json(await purchases.listPurchases(ctx, actorOf(req), q));
  });
  r.get('/purchases/:id', async (req, res) => res.json(await purchases.getPurchase(ctx, actorOf(req), parse(zId, req.params.id))));
  r.post('/purchases', async (req, res) => {
    const line = z
      .object({
        productId: zIdBody,
        grossWeightMg: zWeightMg,
        netWeightMg: zWeightMg,
        purchaseCost: zPositiveMoney,
        makingCost: zMoney,
        otherCost: zMoney,
        sellingPrice: zPositiveMoney,
      })
      .strict()
      .refine((l) => l.netWeightMg <= l.grossWeightMg, { message: 'Net weight must not exceed gross weight', path: ['netWeightMg'] });
    const body = parse(
      z
        .object({ branchId: zIdBody.optional(), supplierId: zIdBody.optional(), supplierInvoiceNo: zText(60).optional(), notes: zText(1000).optional(), lines: z.array(line).min(1).max(200) })
        .strict(),
      req.body,
    );
    res.json(await purchases.createPurchase(ctx, actorOf(req), body));
  });

  r.get('/expenses', async (req, res) => {
    const q = parse(
      z
        .object({
          branchId: zOptId,
          from: zDay.optional(),
          to: zDay.optional(),
          category: z.enum(EXPENSE_CATEGORIES).optional(),
          status: z.enum(['APPROVED', 'PENDING', 'REJECTED']).optional(),
          q: zQ,
        })
        .strict(),
      req.query,
    );
    res.json(await expenses.listExpenses(ctx, actorOf(req), q));
  });
  r.post('/expenses', async (req, res) => {
    const body = parse(
      z.object({ branchId: zIdBody.optional(), category: z.enum(EXPENSE_CATEGORIES), amount: zPositiveMoney, expenseDate: zDay.optional(), description: zText(500).min(2) }).strict(),
      req.body,
    );
    res.json(await expenses.createExpense(ctx, actorOf(req), body));
  });
  r.post('/expenses/:id/review', async (req, res) => {
    const body = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: zText(500).optional() }).strict(), req.body);
    res.json(await expenses.reviewExpense(ctx, actorOf(req), parse(zId, req.params.id), body.decision, body.note));
  });

  r.get('/transfers', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, status: z.enum(['IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional() }).strict(), req.query);
    res.json(await transfers.listTransfers(ctx, actorOf(req), q));
  });
  r.post('/transfers', async (req, res) => {
    const body = parse(
      z.object({ fromBranchId: zIdBody.optional(), toBranchId: zIdBody, itemIds: z.array(zIdBody).min(1).max(500), notes: zText(1000).optional() }).strict(),
      req.body,
    );
    res.json(await transfers.createTransfer(ctx, actorOf(req), body));
  });
  r.post('/transfers/:id/receive', async (req, res) => res.json(await transfers.receiveTransfer(ctx, actorOf(req), parse(zId, req.params.id))));

  // ─────────── dashboards, reports, audit, notifications ───────────
  r.get('/dashboard/branch', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, date: zDay.optional() }).strict(), req.query);
    res.json(await dashboard.branchDashboard(ctx, actorOf(req), q));
  });
  r.get('/dashboard/company', async (req, res) => {
    const q = parse(z.object({ from: zDay.optional(), to: zDay.optional() }).strict(), req.query);
    res.json(await dashboard.companyDashboard(ctx, actorOf(req), q));
  });
  const reportQuery = z
    .object({
      from: zDay.optional(),
      to: zDay.optional(),
      branchId: zOptId,
      userId: zOptId,
      status: z.string().regex(/^[A-Z_]{2,40}$/).optional(),
      q: zQ,
      group: z.enum(['branch', 'category', 'karat', 'cashier', 'day']).optional(),
      action: z.string().regex(/^[A-Z_,]{2,400}$/).optional(),
    })
    .strict();
  r.get('/reports/:key', async (req, res) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-z-]{2,40}$/) }).strict(), req.params);
    res.json(await reports.runReport(ctx, actorOf(req), key, parse(reportQuery, req.query)));
  });
  r.get('/audit', async (req, res) => {
    const q = parse(reportQuery.extend({ entityType: z.string().regex(/^[a-z_]{2,40}$/).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() }), req.query);
    const data = await reports.listAudit(ctx, actorOf(req), q);
    res.json(data.map(({ sessionId, ...a }) => ({ ...a, sessionRef: sessionId ? sessions.sessionRef(sessionId) : null })));
  });
  r.get('/notifications', async (req, res) => res.json(await notificationsFor(ctx, actorOf(req))));

  // Branch-scoped quick lookup used by the drill-down header.
  r.get('/branches/:id', async (req, res) => {
    const actor = actorOf(req);
    const id = parse(zId, req.params.id);
    branchScope(actor, id);
    const [b] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, id));
    if (!b) throw notFound('Branch');
    const staff = await ctx.db.select({ id: t.users.id }).from(t.users).where(eq(t.users.branchId, id));
    res.json({ ...b, staffCount: staff.length });
  });

  // ─────────── demo tooling: NOT registered in production (security item 2) ───────────
  if (demo) {
    r.post('/demo/reset', async (req: Request, res: Response) => {
      const actor = actorOf(req);
      requirePerm(actor, 'settings.manage');
      await resetDemoData(ctx);
      res.clearCookie(config.cookieName, { path: '/' });
      res.json({ ok: true });
    });

    // Mock Hasad simulator & integration monitor.
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
      const body = parse(z.object({ customerId: z.string().regex(/^[A-Z0-9-]{3,30}$/), branchId: zIdBody, weightMg: zWeightMg.optional() }).strict(), req.body);
      const [branch] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, body.branchId));
      if (!branch?.hasadBranchCode) throw notFound('Branch');
      const w = await simulator().simulateWithdrawalRequest({ customerId: body.customerId, branchCode: branch.hasadBranchCode, weightMg: body.weightMg });
      await syncWithdrawals(ctx, true);
      res.json(w);
    });
    r.get('/hasad/integration-log', async (req, res) => {
      requirePerm(actorOf(req), 'hasad.simulate');
      res.json(ctx.mockHasad ? await ctx.mockHasad.recentCalls(80) : []);
    });
  }
  return r;
}
