// HTTP surface. Routes only parse/validate input and delegate to services with the Actor;
// all authorization and branch isolation happen inside the services.
//
// Validation rules (security item 4): every body/query/params schema is `.strict()` (unknown
// fields are rejected), every number is an integer with explicit bounds, money and weights are
// non-negative, text has a maximum length, karats come from the allowed set.

import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { EXPENSE_CATEGORIES, EXPENSE_PAYMENT_SOURCES, ITEM_ORIGINS, KARATS, PAYMENT_METHODS, SCRAP_KINDS, SCRAP_PAYMENT_METHODS, ap, isSettingKey, type RouteRule } from '@jerp/shared';
import type { Config } from './config';
import type { Ctx } from './core/context';
import { actorOf, parse, zId, zOptId, zDay } from './core/http';
import { badRequest, forbidden, notFound } from './core/errors';
import { writeAudit } from './core/audit';
import { branchScope, isGlobal, requirePerm } from './authz';
import { clientIp } from './auth/middleware';
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
import * as branding from './modules/branding/service';
import { publicBranding } from './modules/branding/service';
import { LOGO_MAX_BYTES } from './modules/branding/image';
import * as branches from './modules/branches/service';
import * as ledger from './modules/ledger/service';
import * as scrap from './modules/scrap/service';
import * as supplierSettlements from './modules/supplier-settlements/service';
import { runIdempotent } from './core/idempotency';
import { defineRoutes } from './core/guard';
import { costRedaction } from './core/cost-redaction';
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
const zPhone = zText(30).regex(/^[+\d\s()-]*$/);

export function apiRouter(ctx: Ctx, config: Config): Router & { registered: RouteRule[] } {
  const r = Router();
  const demo = config.appMode === 'demo';
  // Every route is registered through the access matrix (deny by default, see core/guard.ts).
  const { route, registered } = defineRoutes(r, ctx, { demo });
  // Cost/profit fields never leave the server for callers without profit.view (decision Q15).
  r.use(costRedaction);

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
  route('POST', '/auth/login', async (req, res) => {
    const body = parse(z.object({ username: zText(64).min(1), password: z.string().min(1).max(128) }).strict(), req.body);
    const s = await auth.login(ctx, { ...body, userAgent: req.header('user-agent'), ip: clientIp(req) });
    await setSessionCookie(res, s.token);
    res.json(await auth.me(ctx, s.actor));
  });

  /** Public, non-sensitive app metadata for the login screen. Demo credentials only in demo mode. */
  route('GET', '/meta', async (_req, res) => {
    res.json({
      appMode: config.appMode,
      branding: publicBranding(await ctx.settings.get()),
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

  route('GET', '/health', async (_req, res) => {
    res.json(config.production ? { ok: true } : { ok: true, driver: ctx.handle.driver, hasad: ctx.hasad.mode, appMode: config.appMode });
  });


  // ─────────── own account ───────────
  route('GET', '/auth/me', async (req, res) => res.json(await auth.me(ctx, actorOf(req))));
  route('POST', '/auth/logout', async (req, res) => {
    await auth.logout(ctx, actorOf(req));
    res.clearCookie(config.cookieName, { path: '/', secure: config.cookieSecure, sameSite: 'lax', httpOnly: true });
    res.json({ ok: true });
  });
  route('POST', '/auth/change-password', async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }).strict(), req.body);
    const result = await auth.changePassword(ctx, actorOf(req), { ...body, userAgent: req.header('user-agent') });
    await setSessionCookie(res, result.token);
    const actor = (await sessions.loadActor(ctx.db, actorOf(req).userId, result.sessionId))!;
    res.json(await auth.me(ctx, actor));
  });
  route('POST', '/auth/reauth', async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1).max(128) }).strict(), req.body);
    res.json(await auth.reauthenticate(ctx, actorOf(req), body.password));
  });

  // ─────────── reference data ───────────
  route('GET', '/branches', async (req, res) => {
    const actor = actorOf(req);
    const all = await ctx.db.select().from(t.branches).orderBy(t.branches.id);
    res.json(isGlobal(actor) ? all : all.filter((b) => b.id === actor.branchId));
  });
  /** All branch names — needed as transfer destinations. Contains no business data. */
  route('GET', '/branches/directory', async (_req, res) => {
    res.json(await ctx.db.select({ id: t.branches.id, code: t.branches.code, name: t.branches.name, nameAr: t.branches.nameAr }).from(t.branches).orderBy(t.branches.id));
  });
  route('GET', '/categories', async (_req, res) => res.json(await inventory.listCategories(ctx)));
  route('GET', '/products', async (req, res) => res.json(await inventory.listProducts(ctx, actorOf(req))));
  route('GET', '/suppliers', async (req, res) => {
    requirePerm(actorOf(req), 'purchases.view');
    res.json(await purchases.listSuppliers(ctx));
  });
  route('GET', '/roles', async (req, res) => {
    requirePerm(actorOf(req), 'users.view');
    res.json(await users.listRoles(ctx));
  });
  route('GET', '/gold-rates', async (_req, res) => {
    res.json({ current: await ctx.settings.goldRates(), history: await ctx.settings.goldRateHistory() });
  });
  route('POST', '/gold-rates', async (req, res) => {
    const actor = actorOf(req);
    requirePerm(actor, 'settings.manage');
    const body = parse(
      z.object({ rates: z.partialRecord(z.enum(KARATS.map(String) as [string, ...string[]]), zPositiveMoney.max(100_000_000)) }).strict(),
      req.body,
    );
    const { inventory: inv } = await ctx.settings.get();
    const notAllowed = Object.keys(body.rates).find((k) => !inv.allowedKarats.includes(Number(k)));
    if (notAllowed) throw badRequest('Karat {karat} is not in the allowed karats', { karat: notAllowed });
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

  // ─────────── settings (typed registry, one row per key) ───────────
  route('GET', '/settings', async (_req, res) => {
    res.json({ settings: await ctx.settings.get(), versions: Object.fromEntries(Object.entries(await ctx.settings.meta()).map(([k, m]) => [k, m.version])) });
  });
  route('PUT', '/settings', async (req, res) => {
    const actor = actorOf(req);
    const body = parse(
      z
        .object({
          changes: z.record(z.string().regex(/^[a-zA-Z]+\.[a-zA-Z]+$/), z.unknown()).refine((c) => Object.keys(c).length > 0 && Object.keys(c).length <= 40, 'Between 1 and 40 changes'),
          reason: zText(500).optional(),
          expectedVersions: z.record(z.string(), z.number().int().min(0)).optional(),
        })
        .strict(),
      req.body,
    );
    if ('branding.logoAssetId' in body.changes) throw forbidden('Use the logo upload to change the logo');
    const result = await ctx.db.transaction(async (tx) => {
      const { settings, changed } = await ctx.settings.apply(tx, body.changes, {
        actor: { id: actor.userId, username: actor.username },
        reason: body.reason,
        expectedVersions: body.expectedVersions,
        allowDemoOnly: demo,
      });
      if (changed.length) {
        await writeAudit(tx, actor, {
          action: 'SETTINGS_CHANGED',
          entityType: 'settings',
          entityId: changed.map((c) => c.key).join(',').slice(0, 200),
          branchId: null,
          key: 'System settings changed: {sections}',
          params: { sections: ap.list(changed.map((c) => ap.enum(c.key))) },
          metadata: { changes: changed, reason: body.reason ?? null },
        });
      }
      return { settings, changed };
    });
    res.json({ settings: result.settings, changed: result.changed.map((c) => c.key), versions: Object.fromEntries(Object.entries(await ctx.settings.meta()).map(([k, m]) => [k, m.version])) });
  });
  route('GET', '/settings/history/:key', async (req, res) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-zA-Z]+\.[a-zA-Z]+$/) }).strict(), req.params);
    if (!isSettingKey(key)) throw notFound('Setting');
    res.json(await ctx.settings.history(ctx.db, key));
  });

  // ─────────── branding ───────────
  route('GET', '/branding/logo', async (_req, res) => {
    const logo = await branding.currentLogo(ctx);
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('Content-Disposition', 'inline; filename="logo"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', logo.etag);
    res.end(logo.bytes);
  });
  route(
    'POST',
    '/branding/logo',
    express.raw({ type: () => true, limit: LOGO_MAX_BYTES + 1024 }),
    async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(await branding.uploadLogo(ctx, actorOf(req), bytes, req.header('content-type')));
    },
  );
  route('DELETE', '/branding/logo', async (req, res) => res.json(await branding.clearLogo(ctx, actorOf(req))));

  // ─────────── branches (GM) ───────────
  const zBranchCode = z.string().regex(/^[A-Z]{2,6}$/);
  route('POST', '/branches', async (req, res) => {
    const body = parse(
      z
        .object({
          code: zBranchCode,
          name: zText(80).min(2),
          nameAr: zText(80).min(2),
          city: zText(60).min(2),
          address: zText(200).optional(),
          phone: zPhone.optional(),
          hasadBranchCode: z.string().regex(/^[A-Z0-9-]{2,30}$/).optional(),
        })
        .strict(),
      req.body,
    );
    res.json(await branches.createBranch(ctx, actorOf(req), body));
  });
  route('PATCH', '/branches/:id', async (req, res) => {
    const body = parse(
      z
        .object({ name: zText(80).min(2).optional(), nameAr: zText(80).min(2).optional(), city: zText(60).min(2).optional(), address: zText(200).optional(), phone: zPhone.optional(), isActive: z.boolean().optional() })
        .strict(),
      req.body,
    );
    res.json(await branches.updateBranch(ctx, actorOf(req), parse(zId, req.params.id), body));
  });

  // ─────────── sessions ───────────
  route('POST', '/sessions/heartbeat', async (_req, res) => res.json({ ok: true }));
  route('GET', '/sessions', async (req, res) => {
    const q = parse(z.object({ scope: z.enum(['active', 'recent']).default('active'), branchId: zOptId, mine: zBool.optional() }).strict(), req.query);
    res.json(await sessions.listSessions(ctx, actorOf(req), q));
  });
  route('POST', '/sessions/:key/revoke', async (req, res) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[0-9a-f]{16}$/) }).strict(), req.params);
    await sessions.revokeSession(ctx, actorOf(req), key);
    res.json({ ok: true });
  });

  // ─────────── users ───────────
  const zUsername = zText(40).min(3);
  const zFullName = zText(120).min(2);
  const zRoleCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
  route('GET', '/users', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }).strict(), req.query);
    res.json(await users.listUsers(ctx, actorOf(req), q));
  });
  route('POST', '/users', async (req, res) => {
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
    res.json(await users.createUser(ctx, actorOf(req), body));
  });
  route('PATCH', '/users/:id', async (req, res) => {
    const body = parse(
      z
        .object({ fullName: zFullName.optional(), fullNameAr: zText(120).optional(), phone: zPhone.optional(), roleCode: zRoleCode.optional(), branchId: zIdBody.nullable().optional() })
        .strict(),
      req.body,
    );
    const id = parse(zId, req.params.id);
    // Role/branch changes need a recent re-authentication (the rest of the profile does not).
    if (body.roleCode !== undefined || body.branchId !== undefined) await requireRecentReauth(ctx, req);
    res.json(await users.updateUser(ctx, actorOf(req), id, body));
  });
  route('POST', '/users/:id/reset-password', async (req, res) => {
    res.json(await users.resetPassword(ctx, actorOf(req), parse(zId, req.params.id)));
  });
  route('POST', '/users/:id/disable', async (req, res) => res.json(await users.setUserStatus(ctx, actorOf(req), parse(zId, req.params.id), 'DISABLED')));
  route('POST', '/users/:id/enable', async (req, res) => res.json(await users.setUserStatus(ctx, actorOf(req), parse(zId, req.params.id), 'ACTIVE')));
  route('POST', '/users/:id/unlock', async (req, res) => res.json(await users.unlockUser(ctx, actorOf(req), parse(zId, req.params.id))));

  // ─────────── inventory ───────────
  route('GET', '/inventory/items', async (req, res) => {
    const q = parse(
      z
        .object({
          branchId: zOptId,
          q: zQ,
          karat: zKarat.optional(),
          category: z.string().regex(/^[A-Z_]{2,30}$/).optional(),
          status: zStatusList,
          origin: z.enum(ITEM_ORIGINS).optional(),
          minWeightMg: z.coerce.number().int().min(0).max(MAX_WEIGHT_MG).optional(),
          maxWeightMg: z.coerce.number().int().min(0).max(MAX_WEIGHT_MG).optional(),
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
  route('GET', '/inventory/items/:id', async (req, res) => res.json(await inventory.getItemDetail(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/inventory/items/:id/price', async (req, res) => {
    const body = parse(z.object({ sellingPrice: zPositiveMoney, reason: zText(500).default('') }).strict(), req.body);
    res.json(await inventory.changePrice(ctx, actorOf(req), parse(zId, req.params.id), body.sellingPrice, body.reason));
  });
  route('POST', '/inventory/items/:id/adjust', async (req, res) => {
    const body = parse(z.object({ action: z.enum(['MARK_DAMAGED', 'RESTOCK', 'RETURN_TO_SUPPLIER']), reason: zText(500).min(3) }).strict(), req.body);
    res.json(await inventory.adjustItem(ctx, actorOf(req), parse(zId, req.params.id), body.action, body.reason));
  });

  // ─────────── sales ───────────
  route('POST', '/sales', async (req, res) => {
    const body = parse(
      z
        .object({
          branchId: zIdBody.optional(),
          items: z.array(z.object({ itemId: zIdBody, discount: zMoney.optional() }).strict()).min(1).max(50),
          paymentMethod: z.enum(PAYMENT_METHODS),
          // Hasad (D-4-6): the Hasad invoice number is required, the transaction reference optional.
          paymentRefInvoice: zText(80).min(1).optional(),
          paymentRefTransaction: zText(80).min(1).optional(),
          customerName: zText(120).optional(),
          customerPhone: zPhone.optional(),
        })
        .strict(),
      req.body,
    );
    const sale = await runIdempotent(ctx, req, res, (idem) => sales.createSale(ctx, actorOf(req), body, { idem }));
    res.json(await sales.getSale(ctx, actorOf(req), sale.id));
  });
  route('GET', '/sales', async (req, res) => {
    const q = parse(
      z
        .object({ from: zDay.optional(), to: zDay.optional(), branchId: zOptId, cashierId: zOptId, q: zQ, status: z.enum(['COMPLETED', 'VOIDED']).optional(), mine: zBool.optional() })
        .strict(),
      req.query,
    );
    res.json(await sales.listSales(ctx, actorOf(req), q));
  });
  route('GET', '/sales/:id', async (req, res) => res.json(await sales.getSale(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/sales/:id/void', async (req, res) => {
    const body = parse(z.object({ reason: zText(500).min(3) }).strict(), req.body);
    const id = parse(zId, req.params.id);
    res.json(await runIdempotent(ctx, req, res, (idem) => sales.voidSale(ctx, actorOf(req), id, body.reason, { idem })));
  });

  // ─────────── Hasad ───────────
  route('GET', '/hasad/withdrawals', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, status: zStatusList, q: zQ, from: zDay.optional(), to: zDay.optional() }).strict(), req.query);
    res.json(await hasad.listWithdrawals(ctx, actorOf(req), { ...q, status: q.status as never }));
  });
  route('GET', '/hasad/withdrawals/:id', async (req, res) => res.json(await hasad.getWithdrawal(ctx, actorOf(req), parse(zId, req.params.id))));
  route('GET', '/hasad/withdrawals/:id/candidates', async (req, res) => {
    const q = parse(z.object({ q: zQ, karat: zKarat.optional(), category: z.string().regex(/^[A-Z_]{2,30}$/).optional() }).strict(), req.query);
    res.json(await hasad.candidateItems(ctx, actorOf(req), parse(zId, req.params.id), q));
  });
  route('POST', '/hasad/withdrawals/:id/open', async (req, res) => {
    const body = parse(z.object({ verification: z.enum(['PICKUP_CODE', 'ID_DOCUMENT']), pickupCode: z.string().regex(/^\d{4,8}$/).optional() }).strict(), req.body);
    res.json(await hasad.openWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body));
  });
  route('POST', '/hasad/withdrawals/:id/items', async (req, res) => {
    const body = parse(z.object({ itemId: zIdBody }).strict(), req.body);
    res.json(await hasad.addItem(ctx, actorOf(req), parse(zId, req.params.id), body.itemId));
  });
  route('DELETE', '/hasad/withdrawals/:id/items/:itemId', async (req, res) => {
    res.json(await hasad.removeItem(ctx, actorOf(req), parse(zId, req.params.id), parse(zId, req.params.itemId)));
  });
  route('POST', '/hasad/withdrawals/:id/complete', async (req, res) => {
    const body = parse(
      z
        .object({
          // A Hasad delivery's price difference is settled in money, never "paid with Hasad".
          paymentMethod: z.enum(PAYMENT_METHODS).exclude(['HASAD']),
          customerAcknowledged: z.boolean(),
          expectedDirection: z.enum(['BRANCH_PAYS_CUSTOMER', 'CUSTOMER_PAYS_BRANCH', 'NONE']),
          expectedAmount: zMoney,
        })
        .strict(),
      req.body,
    );
    const id = parse(zId, req.params.id);
    res.json(await runIdempotent(ctx, req, res, (idem) => hasad.completeWithdrawal(ctx, actorOf(req), id, body, { idem })));
  });
  route('POST', '/hasad/withdrawals/:id/abort', async (req, res) => {
    const body = parse(z.object({ reason: zText(500).min(3).default('Customer left without completing') }).strict(), req.body);
    res.json(await hasad.abortRedemption(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });
  route('POST', '/hasad/withdrawals/:id/cancel', async (req, res) => {
    const body = parse(z.object({ reason: zText(500).min(3) }).strict(), req.body);
    res.json(await hasad.cancelWithdrawal(ctx, actorOf(req), parse(zId, req.params.id), body.reason));
  });

  // ─────────── purchases / expenses / transfers ───────────
  route('GET', '/purchases', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, from: zDay.optional(), to: zDay.optional(), q: zQ }).strict(), req.query);
    res.json(await purchases.listPurchases(ctx, actorOf(req), q));
  });
  route('GET', '/purchases/:id', async (req, res) => res.json(await purchases.getPurchase(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/purchases', async (req, res) => {
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
        .object({
          branchId: zIdBody.optional(),
          supplierId: zIdBody.optional(),
          supplierInvoiceNo: zText(60).optional(),
          notes: zText(1000).optional(),
          makingChargePaidFrom: z.enum(EXPENSE_PAYMENT_SOURCES).optional(),
          lines: z.array(line).min(1).max(200),
        })
        .strict(),
      req.body,
    );
    res.json(await runIdempotent(ctx, req, res, (idem) => purchases.createPurchase(ctx, actorOf(req), body, { idem })));
  });
  // Supplier settlement (D-4-5): broken-scrap weight and karat only. There is deliberately no
  // amount, payment method or account field: a settlement can never move CASH or BANK.
  route('POST', '/purchases/:id/settlements', async (req, res) => {
    const body = parse(z.object({ karat: zKarat, weightMg: zWeightMg, note: zText(500).optional() }).strict(), req.body);
    const id = parse(zId, req.params.id);
    res.json(await runIdempotent(ctx, req, res, (idem) => supplierSettlements.settleWithScrap(ctx, actorOf(req), id, body, { idem })));
  });

  // ─────────── scrap gold (Phase 4) ───────────
  route('GET', '/scrap-rates', async (req, res) => res.json(await scrap.scrapRatesView(ctx, actorOf(req))));
  route('POST', '/scrap-rates', async (req, res) => {
    const body = parse(z.object({ rates: z.array(z.object({ karat: zKarat, pricePerGram: zPositiveMoney }).strict()).min(1).max(KARATS.length) }).strict(), req.body);
    await scrap.setScrapRates(ctx, actorOf(req), Object.fromEntries(body.rates.map((r) => [r.karat, r.pricePerGram])));
    res.json(await scrap.scrapRatesView(ctx, actorOf(req)));
  });
  route('GET', '/scrap-purchases', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, from: zDay.optional(), to: zDay.optional(), kind: z.enum(SCRAP_KINDS).optional() }).strict(), req.query);
    res.json(await scrap.listScrapPurchases(ctx, actorOf(req), q));
  });
  route('POST', '/scrap-purchases', async (req, res) => {
    const body = parse(
      z
        .object({
          branchId: zIdBody.optional(),
          kind: z.enum(SCRAP_KINDS),
          // Any karat may be bought as broken scrap; sellable pieces are checked against the setting.
          karat: zKarat,
          grossWeightMg: zWeightMg,
          netWeightMg: zWeightMg,
          agreedRatePerGram: zPositiveMoney.optional(),
          paymentMethod: z.enum(SCRAP_PAYMENT_METHODS),
          productId: zIdBody.optional(),
          sellingPrice: zPositiveMoney.optional(),
          customerName: zText(120).optional(),
          customerPhone: zPhone.optional(),
          customerIdRef: zText(60).optional(),
          note: zText(500).optional(),
        })
        .strict()
        .refine((b) => b.netWeightMg <= b.grossWeightMg, { message: 'Net weight must not exceed gross weight', path: ['netWeightMg'] }),
      req.body,
    );
    res.json(await runIdempotent(ctx, req, res, (idem) => scrap.buyScrap(ctx, actorOf(req), body, { idem })));
  });
  route('GET', '/scrap-pool', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }).strict(), req.query);
    res.json(await scrap.poolView(ctx, actorOf(req), q));
  });

  route('GET', '/expenses', async (req, res) => {
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
  route('POST', '/expenses', async (req, res) => {
    const body = parse(
      z
        .object({
          branchId: zIdBody.optional(),
          category: z.enum(EXPENSE_CATEGORIES),
          amount: zPositiveMoney,
          expenseDate: zDay.optional(),
          description: zText(500).min(2),
          paidFrom: z.enum(EXPENSE_PAYMENT_SOURCES).optional(),
        })
        .strict(),
      req.body,
    );
    res.json(await runIdempotent(ctx, req, res, (idem) => expenses.createExpense(ctx, actorOf(req), body, { idem })));
  });
  route('POST', '/expenses/:id/review', async (req, res) => {
    const body = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: zText(500).optional(), paidFrom: z.enum(EXPENSE_PAYMENT_SOURCES).optional() }).strict(), req.body);
    const id = parse(zId, req.params.id);
    res.json(await runIdempotent(ctx, req, res, (idem) => expenses.reviewExpense(ctx, actorOf(req), id, body.decision, body.note, { idem, paidFrom: body.paidFrom })));
  });

  // ─────────── Cash: expected drawer balance, daily reconciliation, counted cash (Phase 2b) ───────────
  route('GET', '/cash/drawer', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }).strict(), req.query);
    res.json(await ledger.drawer(ctx, actorOf(req), q));
  });
  route('GET', '/cash/reconciliation', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, day: zDay.optional() }).strict(), req.query);
    res.json(await ledger.reconciliation(ctx, actorOf(req), q));
  });
  route('POST', '/cash/counts', async (req, res) => {
    const body = parse(z.object({ branchId: zIdBody.optional(), day: zDay, countedAmount: zMoney, note: zText(500).optional() }).strict(), req.body);
    res.json(await ledger.recordCount(ctx, actorOf(req), body));
  });

  route('GET', '/transfers', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, status: z.enum(['IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional() }).strict(), req.query);
    res.json(await transfers.listTransfers(ctx, actorOf(req), q));
  });
  route('POST', '/transfers', async (req, res) => {
    const body = parse(
      z.object({ fromBranchId: zIdBody.optional(), toBranchId: zIdBody, itemIds: z.array(zIdBody).min(1).max(500), notes: zText(1000).optional() }).strict(),
      req.body,
    );
    res.json(await transfers.createTransfer(ctx, actorOf(req), body));
  });
  route('POST', '/transfers/:id/receive', async (req, res) => res.json(await transfers.receiveTransfer(ctx, actorOf(req), parse(zId, req.params.id))));

  // ─────────── dashboards, reports, audit, notifications ───────────
  route('GET', '/dashboard/branch', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, date: zDay.optional() }).strict(), req.query);
    res.json(await dashboard.branchDashboard(ctx, actorOf(req), q));
  });
  route('GET', '/dashboard/company', async (req, res) => {
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
  route('GET', '/reports/:key', async (req, res) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-z-]{2,40}$/) }).strict(), req.params);
    res.json(await reports.runReport(ctx, actorOf(req), key, parse(reportQuery, req.query)));
  });
  route('GET', '/audit', async (req, res) => {
    const q = parse(reportQuery.extend({ entityType: z.string().regex(/^[a-z_]{2,40}$/).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() }), req.query);
    const data = await reports.listAudit(ctx, actorOf(req), q);
    res.json(data.map(({ sessionId, ...a }) => ({ ...a, sessionRef: sessionId ? sessions.sessionRef(sessionId) : null })));
  });
  route('GET', '/notifications', async (req, res) => res.json(await notificationsFor(ctx, actorOf(req))));

  // Branch-scoped quick lookup used by the drill-down header.
  route('GET', '/branches/:id', async (req, res) => {
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
    route('POST', '/demo/reset', async (req: Request, res: Response) => {
      await resetDemoData(ctx);
      res.clearCookie(config.cookieName, { path: '/' });
      res.json({ ok: true });
    });

    // Mock Hasad simulator & integration monitor.
    const simulator = () => {
      if (!ctx.mockHasad) throw forbidden('Simulator is only available with the mock Hasad service');
      return ctx.mockHasad;
    };
    route('GET', '/hasad/simulator/customers', async (req, res) => {
      requirePerm(actorOf(req), 'hasad.simulate');
      res.json(await simulator().simulateCustomers());
    });
    route('POST', '/hasad/simulator/withdrawals', async (req, res) => {
      const actor = actorOf(req);
      requirePerm(actor, 'hasad.simulate');
      const body = parse(z.object({ customerId: z.string().regex(/^[A-Z0-9-]{3,30}$/), branchId: zIdBody, weightMg: zWeightMg.optional() }).strict(), req.body);
      const [branch] = await ctx.db.select().from(t.branches).where(eq(t.branches.id, body.branchId));
      if (!branch?.hasadBranchCode) throw notFound('Branch');
      const w = await simulator().simulateWithdrawalRequest({ customerId: body.customerId, branchCode: branch.hasadBranchCode, weightMg: body.weightMg });
      await syncWithdrawals(ctx, true);
      res.json(w);
    });
    route('GET', '/hasad/integration-log', async (req, res) => {
      requirePerm(actorOf(req), 'hasad.simulate');
      res.json(ctx.mockHasad ? await ctx.mockHasad.recentCalls(80) : []);
    });
  }
  return Object.assign(r, { registered });
}
