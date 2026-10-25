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
import { TWO_FACTOR_ROLES, WEBAUTHN_UV_VALUES, CASH_OR_BANK, ITEM_ORIGINS, PAYMENT_METHODS, SCRAP_KINDS, PURCHASE_CORRECTION_FIELDS, CHANGE_REASON_MAX, ap, isSettingKey, type RouteRule } from '@jerp/shared';
import type { Config } from './config';
import type { Ctx } from './core/context';
import { actorOf, parse, zId, zOptId, zDay } from './core/http';
import { pageQuerySchema } from './core/paging';
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
import * as printing from './modules/print/service';
import * as purchases from './modules/purchases/service';
import * as catalog from './modules/catalog/service';
import * as setup from './modules/setup/service';
import * as transfers from './modules/transfers/service';
import { attentionFor } from './modules/attention/service';
import * as dashboard from './modules/dashboard/service';
import * as reports from './modules/reports/service';
import * as branding from './modules/branding/service';
import { publicBranding } from './modules/branding/service';
import { LOGO_MAX_BYTES } from './modules/branding/image';
import * as branches from './modules/branches/service';
import * as ledger from './modules/ledger/service';
import * as passkeys from './modules/auth/passkeys';
import { relyingParty } from './auth/webauthn';
import * as backups from './modules/backups/status';
import * as scrap from './modules/scrap/service';
import * as scrapVoid from './modules/scrap/void';
import * as purchaseCorrections from './modules/purchases/corrections';
import * as funding from './modules/funding/service';
import * as supplierSettlements from './modules/supplier-settlements/service';
import * as pricing from './modules/pricing/service';
import * as openings from './modules/openings/service';
import { runIdempotent } from './core/idempotency';
import { log } from './core/logger';
import { defineRoutes } from './core/guard';
import { costRedaction } from './core/cost-redaction';
import { readiness } from './core/readiness';

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
/** DEC-1 (RAT-1, D-dec1-13): the optional reason and password of a rate edit (SEC-2 reason bounds). */
/** MIS-1: a void or a correction carries a reason and the password; the service checks both (422 / 403). */
const zConfirmation = z.object({ reason: z.string().max(2000).optional(), confirmPassword: z.string().max(128).optional() }).strict();
const zRateGuard = { reason: zText(CHANGE_REASON_MAX).optional(), confirmPassword: z.string().min(1).max(128).optional() };
// PRC-1: karats follow the allowed-karats setting (8–24), never a fixed list; the route checks the setting.
const zKarat = z.coerce.number().int().min(1).max(24);
/**
 * Scrap BUYING accepts any karat a customer brings (1–24); selling is still limited by allowedKarats. A JSON body sends
 * a number: no coercion (UX-1, D-ux1-3: `z.coerce` read `true` as karat 1 and `[21]` as 21).
 */
const zScrapKarat = z.number().int().min(1).max(24);
const zStatusList = z.preprocess((v) => (typeof v === 'string' && v ? v.split(',') : undefined), z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(20).optional());
const zBool = z.preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean());
const zQ = zText(100).optional();
const zPhone = zText(30).regex(/^[+\d\s()-]*$/);

/** At most 20 crash reports per session per hour reach the log (a looping crash cannot flood it). */
const clientErrors = new Map<string, { n: number; since: number }>();
function clientErrorBudget(sessionId: string | number | null | undefined): boolean {
  const key = String(sessionId ?? 'none');
  const now = Date.now();
  const e = clientErrors.get(key);
  if (!e || now - e.since > 3600_000) {
    if (clientErrors.size > 5000) clientErrors.clear();
    clientErrors.set(key, { n: 1, since: now });
    return true;
  }
  e.n += 1;
  return e.n <= 20;
}

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
  // Pending sign-in (password accepted, second factor still to come): its own short-lived cookie,
  // read ONLY by the /auth/login/* second-step routes; it opens no other route (D-2fa-5).
  const pendingCookie = config.production ? '__Host-jerp_pending' : 'jerp_pending';
  const setPendingCookie = (res: Response, token: string) =>
    res.cookie(pendingCookie, token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', maxAge: passkeys.PENDING_TTL_MS });
  const clearPendingCookie = (res: Response) => res.clearCookie(pendingCookie, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' });
  const pendingToken = (req: Request): string | undefined => req.cookies?.[pendingCookie];
  const zWebauthnResponse = z.object({ id: z.string().min(1).max(1400), rawId: z.string().max(1400), type: z.literal('public-key') }).passthrough();

  /** CLN-3: a successful sign-in ends the session a leftover cookie of this browser pointed to (no orphan session). */
  const endReplacedSession = async (req: Request) => {
    if (req.sessionId) await sessions.endSession(ctx.db, req.sessionId, 'LOGGED_OUT', 'Replaced by a new sign-in in the same browser');
  };

  route('POST', '/auth/login', async (req, res) => {
    const body = parse(z.object({ username: zText(64).min(1), password: z.string().min(1).max(128) }).strict(), req.body);
    const r = await auth.login(ctx, { ...body, userAgent: req.header('user-agent'), ip: clientIp(req) });
    if (r.kind === 'PENDING') {
      setPendingCookie(res, r.token);
      res.json({ status: 'SECOND_FACTOR_REQUIRED', ...(await passkeys.pendingMethods(ctx, r.token)) });
      return;
    }
    clearPendingCookie(res);
    await endReplacedSession(req);
    await setSessionCookie(res, r.token);
    res.json(await auth.me(ctx, r.actor));
  });
  route('POST', '/auth/login/passkey/options', async (req, res) => {
    parse(z.object({}).strict(), req.body ?? {});
    res.json({ options: await passkeys.loginPasskeyOptions(ctx, pendingToken(req), relyingParty(config, req)) });
  });
  route('POST', '/auth/login/passkey/verify', async (req, res) => {
    const body = parse(z.object({ response: zWebauthnResponse }).strict(), req.body);
    const s = await passkeys.loginPasskeyVerify(ctx, pendingToken(req), body.response as never, { userAgent: req.header('user-agent'), ip: clientIp(req) });
    clearPendingCookie(res);
    await endReplacedSession(req);
    await setSessionCookie(res, s.token);
    res.json(await auth.me(ctx, s.actor));
  });
  route('POST', '/auth/login/recovery', async (req, res) => {
    const body = parse(z.object({ code: z.string().min(1).max(40) }).strict(), req.body);
    const s = await passkeys.loginRecoveryCode(ctx, pendingToken(req), body.code, { userAgent: req.header('user-agent'), ip: clientIp(req) });
    clearPendingCookie(res);
    await endReplacedSession(req);
    await setSessionCookie(res, s.token);
    res.json(await auth.me(ctx, s.actor));
  });
  route('POST', '/auth/login/cancel', async (req, res) => {
    await passkeys.cancelPending(ctx, pendingToken(req));
    clearPendingCookie(res);
    res.json({ ok: true });
  });

  /**
   * Public, before sign-in: ONLY the allow-list of publicBranding (company name, logo, sign-in tagline, both
   * languages; UI-A2, D-ui-14). No setting, account, mode or credential (REM-3).
   */
  route('GET', '/meta', async (_req, res) => {
    res.json({ branding: publicBranding(await ctx.settings.get()) });
  });

  // SAFE-1 readiness: the database answers, every migration of this release is applied, the append-only protections are
  // in place. 200 {ready:true} or 503 {ready:false}; what failed goes to the log only (core/readiness.ts).
  route('GET', '/ready', async (req, res) => {
    const r = await readiness(ctx);
    if (!r.ready) log.warn('not ready', { problems: r.problems, requestId: req.requestId });
    res.status(r.ready ? 200 : 503).json({ ready: r.ready });
  });

  route('GET', '/health', async (_req, res) => {
    // Backup ages and status only (D-2c-6). Always HTTP 200: a stale backup must not make the host
    // restart a healthy service; monitoring reads `backup.status`.
    const backup = await backups.backupHealth(ctx).catch(() => null);
    res.json(config.production ? { ok: true, backup } : { ok: true, driver: ctx.handle.driver, appMode: config.appMode, backup });
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

  // ─────────── passkeys, recovery codes, recent sign-ins (own account, Phase 2fa) ───────────
  route('POST', '/auth/reauth/passkey/options', async (req, res) => {
    parse(z.object({}).strict(), req.body ?? {});
    res.json({ options: await passkeys.stepUpOptions(ctx, actorOf(req), relyingParty(config, req)) });
  });
  route('POST', '/auth/reauth/passkey/verify', async (req, res) => {
    const body = parse(z.object({ response: zWebauthnResponse }).strict(), req.body);
    res.json(await passkeys.stepUpVerify(ctx, actorOf(req), body.response as never));
  });
  route('GET', '/auth/passkeys', async (req, res) => res.json(await passkeys.listPasskeys(ctx, actorOf(req))));
  route('POST', '/auth/passkeys/register/options', async (req, res) => {
    const body = parse(z.object({ nickname: zText(60).min(1) }).strict(), req.body);
    res.json({ options: await passkeys.registrationOptions(ctx, actorOf(req), body.nickname, relyingParty(config, req)) });
  });
  route('POST', '/auth/passkeys/register/verify', async (req, res) => {
    const body = parse(z.object({ response: zWebauthnResponse }).strict(), req.body);
    res.json(await passkeys.registrationVerify(ctx, actorOf(req), body.response as never));
  });
  route('DELETE', '/auth/passkeys/:id', async (req, res) => res.json(await passkeys.removePasskey(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/auth/recovery-codes', async (req, res) => {
    parse(z.object({}).strict(), req.body ?? {});
    res.json(await passkeys.generateRecoveryCodes(ctx, actorOf(req)));
  });
  route('POST', '/auth/recovery-codes/acknowledge', async (req, res) => res.json(await passkeys.acknowledgeRecoveryCodes(ctx, actorOf(req))));
  route('GET', '/auth/sign-ins', async (req, res) => res.json(await passkeys.recentSignIns(ctx, actorOf(req))));
  route('POST', '/auth/sign-ins/:id/dismiss', async (req, res) => res.json(await passkeys.dismissSignInAlert(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/auth/sign-ins/:id/not-me', async (req, res) => {
    const r = await passkeys.notMe(ctx, actorOf(req), parse(zId, req.params.id));
    res.clearCookie(config.cookieName, { path: '/', secure: config.cookieSecure, sameSite: 'lax', httpOnly: true });
    res.json(r);
  });
  route('PUT', '/security/second-factor', async (req, res) => {
    const body = parse(
      z.object({ userVerification: z.enum(WEBAUTHN_UV_VALUES).optional(), requiredRoles: z.array(z.enum(TWO_FACTOR_ROLES)).max(TWO_FACTOR_ROLES.length).optional(), reason: zText(500).optional() }).strict(),
      req.body,
    );
    res.json(await passkeys.updateSecondFactorPolicy(ctx, actorOf(req), body));
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
  // ── Catalog (CAT-0): item types (the UI says "Type"), products and suppliers.
  const zNames = { nameAr: zText(200), name: zText(200).nullish() };
  const zActiveQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional() }).strict();
  const zReason = z.object({ reason: zText(500) }).strict();
  route('GET', '/categories', async (req, res) => {
    const q = parse(zActiveQuery, req.query);
    res.json(await catalog.listCategories(ctx, actorOf(req), { includeInactive: q.includeInactive === 'true' }));
  });
  route('POST', '/categories', async (req, res) => {
    const body = parse(z.object(zNames).strict(), req.body);
    res.json(await runIdempotent(ctx, req, res, () => catalog.createCategory(ctx, actorOf(req), body)));
  });
  // CAT-1: the General Manager renames a type (sale lines keep their names: snapshots).
  route('POST', '/categories/:id/rename', async (req, res) => {
    const body = parse(z.object(zNames).strict(), req.body);
    res.json(await catalog.renameCategory(ctx, actorOf(req), parse(zId, req.params.id), body));
  });
  // CAT-1: descriptions already used (suggestions of the free-text field).
  route('GET', '/catalog/descriptions', async (req, res) => {
    const q = parse(z.object({ categoryId: zOptId, q: zQ }).strict(), req.query);
    res.json(await catalog.descriptionSuggestions(ctx, q));
  });
  route('POST', '/categories/:id/deactivate', async (req, res) => {
    const { reason } = parse(zReason, req.body);
    res.json(await catalog.setCategoryActive(ctx, actorOf(req), parse(zId, req.params.id), false, reason));
  });
  route('POST', '/categories/:id/reactivate', async (req, res) => {
    const { reason } = parse(zReason, req.body);
    res.json(await catalog.setCategoryActive(ctx, actorOf(req), parse(zId, req.params.id), true, reason));
  });
  route('GET', '/products', async (req, res) => {
    const q = parse(zActiveQuery.extend({ karat: z.coerce.number().int().min(1).max(24).optional() }), req.query);
    res.json(await catalog.listProducts(ctx, actorOf(req), { includeInactive: q.includeInactive === 'true', karat: q.karat }));
  });
  route('POST', '/products', async (req, res) => {
    const body = parse(z.object({ ...zNames, karat: z.number().int().min(1).max(24), categoryId: zIdBody }).strict(), req.body);
    res.json(await runIdempotent(ctx, req, res, () => catalog.createProduct(ctx, actorOf(req), body)));
  });
  route('POST', '/products/:id/deactivate', async (req, res) => {
    const { reason } = parse(zReason, req.body);
    res.json(await catalog.setProductActive(ctx, actorOf(req), parse(zId, req.params.id), false, reason));
  });
  route('POST', '/products/:id/reactivate', async (req, res) => {
    const { reason } = parse(zReason, req.body);
    res.json(await catalog.setProductActive(ctx, actorOf(req), parse(zId, req.params.id), true, reason));
  });
  route('GET', '/suppliers', async (_req, res) => res.json(await catalog.listSuppliers(ctx)));
  route('POST', '/suppliers', async (req, res) => {
    const body = parse(z.object({ ...zNames, phone: zPhone.nullish() }).strict(), req.body);
    res.json(await runIdempotent(ctx, req, res, () => catalog.createSupplier(ctx, actorOf(req), body)));
  });
  route('GET', '/roles', async (req, res) => {
    requirePerm(actorOf(req), 'users.view');
    res.json(await users.listRoles(ctx));
  });
  // PRC-1: the selling rates, NEW (supplier and opening pieces) and USED (sellable scrap), per allowed karat (D-prc1-2).
  route('GET', '/gold-rates', async (_req, res) => {
    res.json(await pricing.sellingRatesView(ctx));
  });
  route('POST', '/gold-rates', async (req, res) => {
    // Any karat the allowed-karats setting accepts (8–24); the service refuses one that is not allowed now.
    const zRates = z.record(z.string().regex(/^\d{1,2}$/), zPositiveMoney.max(100_000_000));
    // DEC-1 (RAT-1): a large change carries a reason (and, above the confirm threshold, the password again).
    const body = parse(z.object({ rates: zRates.optional(), usedRates: zRates.optional(), ...zRateGuard }).strict(), req.body);
    res.json(await pricing.setSellingRates(ctx, actorOf(req), { NEW: body.rates, USED: body.usedRates }, { reason: body.reason, confirmPassword: body.confirmPassword }));
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
  // UI-A2 (D-ui-12): the crash page shows the person only a reference id; the details go to the server log
  // (never to the database, never back to the browser). Capped in size and in number per session.
  route('POST', '/client-errors', async (req, res) => {
    const body = parse(
      z.object({ ref: z.string().regex(/^ERR-[A-Z0-9]{4,12}$/), path: zText(200), message: zText(500), stack: zText(4000).optional() }).strict(),
      req.body,
    );
    const actor = actorOf(req);
    if (clientErrorBudget(actor.sessionId)) log.warn('client render error', { ...body, userId: actor.userId, username: actor.username });
    res.json({ ok: true });
  });
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
          // CAT-0: filter by item type id (generated type codes such as T-001 are not filter keys).
          categoryId: zOptId,
          status: zStatusList,
          origin: z.enum(ITEM_ORIGINS).optional(),
          minWeightMg: z.coerce.number().int().min(0).max(MAX_WEIGHT_MG).optional(),
          maxWeightMg: z.coerce.number().int().min(0).max(MAX_WEIGHT_MG).optional(),
          targetWeightMg: z.coerce.number().int().min(0).max(MAX_WEIGHT_MG).optional(),
          ...pageQuerySchema(inventory.ITEM_SORT_KEYS),
        })
        .strict(),
      req.query,
    );
    // PRC-1 (D-prc1-7): the karat filter accepts the karats allowed in Settings, not a fixed list.
    if (q.karat != null && !(await ctx.settings.get()).inventory.allowedKarats.includes(q.karat)) throw badRequest('Invalid value for {field}', { field: 'karat' }, [{ path: 'karat', code: 'custom' }]);
    res.json(await inventory.pageItems(ctx, actorOf(req), { ...q, status: q.status as never }));
  });
  route('GET', '/inventory/items/:id', async (req, res) => res.json(await inventory.getItemDetail(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/inventory/items/:id/price', async (req, res) => {
    // SEC-2 (Q7): the reason is required.
    const body = parse(z.object({ sellingPrice: zPositiveMoney, reason: zText(500).min(3) }).strict(), req.body);
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
          // PRC-1 (D-prc1-4): listPrice = the price the cashier saw; computed prices are checked against it (409).
          items: z.array(z.object({ itemId: zIdBody, discount: zMoney.optional(), listPrice: zPositiveMoney.optional() }).strict()).min(1).max(50),
          paymentMethod: z.enum(PAYMENT_METHODS),
          // Hasad (D-4-6): the Hasad invoice number is required, the transaction reference optional.
          paymentRefInvoice: zText(80).min(1).optional(),
          paymentRefTransaction: zText(80).min(1).optional(),
          customerName: zText(120).optional(),
          customerPhone: zPhone.optional(),
          // SEC-2 (D-sec2-2): required by the service when a final price differs from the list price.
          priceChangeReason: zText(200).optional(),
          // FIX-2: after the duplicate-reference warning, the cashier confirms.
          confirmDuplicateReference: z.boolean().optional(),
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
        .object({
          from: zDay.optional(),
          to: zDay.optional(),
          branchId: zOptId,
          cashierId: zOptId,
          q: zQ,
          status: z.enum(['COMPLETED', 'VOIDED']).optional(),
          mine: zBool.optional(),
          ...pageQuerySchema(sales.SALE_SORT_KEYS),
        })
        .strict(),
      req.query,
    );
    res.json(await sales.pageSales(ctx, actorOf(req), q));
  });
  route('GET', '/sales/:id', async (req, res) => res.json(await sales.getSale(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/sales/:id/print', async (req, res) => {
    parse(z.object({}).strict(), req.body ?? {});
    res.json(await printing.printSale(ctx, actorOf(req), parse(zId, req.params.id)));
  });
  route('POST', '/sales/:id/void', async (req, res) => {
    const body = parse(z.object({ reason: zText(500).min(3) }).strict(), req.body);
    const id = parse(zId, req.params.id);
    // SEC-2 (D-sec2-1): above the General Manager's amount (0 = always), a fresh password confirmation first. The
    // refusal happens before the idempotency key is claimed, so the retry after the dialog uses the same key.
    const gate = await sales.voidNeedsReauth(ctx, actorOf(req), id);
    if (gate.needed) await requireRecentReauth(ctx, req);
    res.json(await runIdempotent(ctx, req, res, (idem) => sales.voidSale(ctx, actorOf(req), id, body.reason, { idem, ...(gate.needed ? { reauth: { threshold: gate.threshold } } : {}) })));
  });

  // ─────────── purchases / transfers ───────────
  route('GET', '/purchases', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, from: zDay.optional(), to: zDay.optional(), q: zQ, ...pageQuerySchema(purchases.PURCHASE_SORT_KEYS) }).strict(), req.query);
    res.json(await purchases.pagePurchases(ctx, actorOf(req), q));
  });
  route('GET', '/suppliers/:id/gold-owed', async (req, res) => res.json(await purchases.supplierOpenDebt(ctx, actorOf(req), parse(zId, req.params.id))));
  route('GET', '/purchases/:id', async (req, res) => res.json(await purchases.getPurchase(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/purchases', async (req, res) => {
    const line = z
      .object({
        // CAT-1: a type + karat (+ description), or a product (then its type and karat).
        productId: zIdBody.optional(),
        categoryId: zIdBody.optional(),
        karat: zScrapKarat.optional(),
        description: zText(120).optional(),
        grossWeightMg: zWeightMg,
        netWeightMg: zWeightMg,
        purchaseCost: zPositiveMoney,
        makingCost: zMoney,
        otherCost: zMoney,
        // PRC-1: FIXED_TAG only; with computed prices the service refuses it.
        sellingPrice: zPositiveMoney.optional(),
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
          // MKC-1: the making charge is paid by the owner from his personal account; no payment source is taken any more.
          makingChargeReference: zText(80).optional(),
          makingChargeTransferDate: zDay.optional(),
          confirmDuplicateReference: z.boolean().optional(),
          confirmOpenSupplierDebt: z.boolean().optional(),
          lines: z.array(line).min(1).max(200),
        })
        .strict(),
      req.body,
    );
    res.json(await runIdempotent(ctx, req, res, (idem) => purchases.createPurchase(ctx, actorOf(req), body, { idem })));
  });
  // MIS-1 (PUR-FIX): one piece's making cost (a number) or the order's transfer reference (a text); the reason's bounds are
  // checked by the service (422), the password by reauthenticate (403).
  route('POST', '/purchases/:id/corrections', async (req, res) => {
    const id = parse(zId, req.params.id);
    const body = parse(
      zConfirmation.extend({
        field: z.enum(PURCHASE_CORRECTION_FIELDS),
        purchaseItemId: zIdBody.optional(),
        newValue: z.union([z.number().int().min(0).max(MAX_MONEY), zText(80)]),
        confirmDuplicateReference: z.boolean().optional(),
      }),
      req.body,
    );
    res.json(await runIdempotent(ctx, req, res, (idem) => purchaseCorrections.correctPurchase(ctx, actorOf(req), id, body, { idem })));
  });
  // Supplier settlement (D-4-5): broken-scrap weight and karat only. There is deliberately no
  // amount, payment method or account field: a settlement can never move CASH or BANK.
  route('POST', '/purchases/:id/settlements', async (req, res) => {
    const body = parse(z.object({ karat: zScrapKarat, weightMg: zWeightMg, note: zText(500).optional() }).strict(), req.body);
    const id = parse(zId, req.params.id);
    res.json(await runIdempotent(ctx, req, res, (idem) => supplierSettlements.settleWithScrap(ctx, actorOf(req), id, body, { idem })));
  });

  // ─────────── scrap gold (Phase 4) ───────────
  route('GET', '/scrap-rates', async (req, res) => res.json(await scrap.scrapRatesView(ctx, actorOf(req))));
  route('POST', '/scrap-rates', async (req, res) => {
    const body = parse(z.object({ rates: z.array(z.object({ karat: zScrapKarat, pricePerGram: zPositiveMoney }).strict()).min(1).max(24), ...zRateGuard }).strict(), req.body);
    await scrap.setScrapRates(ctx, actorOf(req), Object.fromEntries(body.rates.map((r) => [r.karat, r.pricePerGram])), { reason: body.reason, confirmPassword: body.confirmPassword });
    res.json(await scrap.scrapRatesView(ctx, actorOf(req)));
  });
  route('GET', '/scrap-purchases', async (req, res) => {
    const q = parse(
      z.object({ branchId: zOptId, from: zDay.optional(), to: zDay.optional(), kind: z.enum(SCRAP_KINDS).optional(), status: z.enum(scrap.SCRAP_PURCHASE_STATUSES).optional(), q: zQ, ...pageQuerySchema(scrap.SCRAP_SORT_KEYS) }).strict(),
      req.query,
    );
    res.json(await scrap.listScrapPurchases(ctx, actorOf(req), q));
  });
  route('POST', '/scrap-purchases', async (req, res) => {
    const body = parse(
      z
        .object({
          branchId: zIdBody.optional(),
          kind: z.enum(SCRAP_KINDS),
          // Any karat 1–24 may be bought as broken scrap; sellable pieces are checked against the setting.
          karat: zScrapKarat,
          grossWeightMg: zWeightMg,
          netWeightMg: zWeightMg,
          agreedRatePerGram: zPositiveMoney.optional(),
          // CSH-2 (D-csh-7): the cash and bank parts, or one method for the whole amount; a bank part needs its reference.
          paymentMethod: z.enum(['CASH', 'BANK_TRANSFER']).optional(),
          cashAmount: z.number().int().min(0).max(MAX_MONEY).optional(),
          bankAmount: z.number().int().min(0).max(MAX_MONEY).optional(),
          bankReference: zText(80).optional(),
          productId: zIdBody.optional(),
          // CAT-1: a sellable piece's type and description (the product is optional).
          categoryId: zIdBody.optional(),
          description: zText(120).optional(),
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
  route('GET', '/scrap-purchases/:id', async (req, res) => res.json(await scrap.getScrapPurchase(ctx, actorOf(req), parse(zId, req.params.id))));
  // MIS-1 (SCR-VOID): the reason's bounds are checked by the service (422), the password by reauthenticate (403).
  route('POST', '/scrap-purchases/:id/void', async (req, res) => {
    const id = parse(zId, req.params.id);
    const body = parse(zConfirmation, req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => scrapVoid.voidScrapPurchase(ctx, actorOf(req), id, body, { idem })));
  });
  route('GET', '/scrap-pool', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }).strict(), req.query);
    res.json(await scrap.poolView(ctx, actorOf(req), q));
  });

  // ─────────── OPN-1: the opening balance of a branch (General Manager, `opening.manage`) ───────────
  const zOpeningLine = z
    .object({ categoryId: zId, description: z.string().max(1000).nullable().optional(), karat: zKarat, grossWeightMg: zWeightMg, netWeightMg: zWeightMg })
    .strict();
  const csvFile = (res: Response, file: { fileName: string; text: string }) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.text);
  };
  route('GET', '/openings', async (req, res) => res.json(await openings.listOpenings(ctx, actorOf(req))));
  route('POST', '/openings', async (req, res) => {
    const body = parse(z.object({ branchId: zId }).strict(), req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => openings.createOpening(ctx, actorOf(req), body, { idem })));
  });
  // Before /openings/:id, so "template.csv" is never read as an id.
  route('GET', '/openings/template.csv', async (req, res) => {
    requirePerm(actorOf(req), 'opening.manage');
    csvFile(res, { fileName: 'opening-template.csv', text: openings.openingTemplateCsv() });
  });
  route('GET', '/openings/:id', async (req, res) => {
    const q = parse(z.object({ ...pageQuerySchema(['lineNo']), q: zQ, karat: zKarat.optional(), categoryId: zOptId }).strict(), req.query);
    res.json(await openings.getOpening(ctx, actorOf(req), parse(zId, req.params.id), q));
  });
  route('GET', '/openings/:id/export', async (req, res) => csvFile(res, await openings.exportOpeningCsv(ctx, actorOf(req), parse(zId, req.params.id))));
  route('POST', '/openings/:id/lines', async (req, res) => {
    const id = parse(zId, req.params.id);
    const body = parse(zOpeningLine, req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => openings.addOpeningLine(ctx, actorOf(req), id, body, { idem })));
  });
  route('POST', '/openings/:id/lines/:lineId/remove', async (req, res) => {
    const id = parse(zId, req.params.id);
    const lineId = parse(zId, req.params.lineId);
    res.json(await runIdempotent(ctx, req, res, (idem) => openings.removeOpeningLine(ctx, actorOf(req), id, lineId, { idem })));
  });
  // The CSV file is the raw body (text/csv), read by a parser on THIS route only (plan §5: at most 1 MB, 5,000 rows),
  // ahead of the access rule and the Idempotency-Key check, whose hash then covers the file's bytes. The global JSON
  // limit stays 100 kB.
  r.post('/openings/:id/import', express.raw({ type: 'text/csv', limit: openings.OPENING_IMPORT_MAX_BYTES }));
  route('POST', '/openings/:id/import', async (req, res) => {
    const id = parse(zId, req.params.id);
    const { fileName } = parse(z.object({ fileName: zText(200).optional() }).strict(), req.query);
    if (!Buffer.isBuffer(req.body)) throw badRequest('Send the file as CSV (text/csv)');
    const bytes = req.body;
    res.json(await runIdempotent(ctx, req, res, (idem) => openings.importOpeningCsv(ctx, actorOf(req), id, { fileName: fileName ?? 'opening.csv', bytes }, { idem })));
  });
  route('POST', '/openings/:id/seal', async (req, res) => {
    const id = parse(zId, req.params.id);
    const body = parse(z.object({ confirmPassword: z.string().max(128).optional() }).strict(), req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => openings.sealOpening(ctx, actorOf(req), id, body, { idem })));
  });

  // ─────────── Cash: expected drawer balance, daily reconciliation, counted cash (Phase 2b) ───────────
  route('GET', '/backups/status', async (req, res) => res.json(await backups.backupStatusView(ctx, actorOf(req))));

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

  route('GET', '/cash/hasad-settlements', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }).strict(), req.query);
    res.json(await ledger.listHasadSettlements(ctx, actorOf(req), q));
  });
  // Hasad paid the branch by bank transfer: receivable → bank (amount only; never the drawer).
  route('POST', '/cash/hasad-settlements', async (req, res) => {
    const body = parse(z.object({ branchId: zIdBody.optional(), amount: zPositiveMoney, bankReference: zText(80).optional(), note: zText(500).optional() }).strict(), req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => ledger.settleHasadReceivable(ctx, actorOf(req), body, { idem })));
  });

  // ─────────── CSH-2: GM funding (advances, repayments, corrections) ───────────
  const zFunding = z
    .object({
      branchId: zIdBody,
      account: z.enum(CASH_OR_BANK),
      amount: zPositiveMoney,
      reason: zText(300).min(3),
      bankReference: zText(80).optional(),
      paidDirectlyToSeller: z.boolean().optional(),
      linkedRef: zText(40).optional(),
    })
    .strict();
  route('GET', '/funding', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, offset: z.coerce.number().int().min(0).max(1_000_000).optional() }).strict(), req.query);
    res.json(await funding.fundingView(ctx, actorOf(req), q));
  });
  route('POST', '/funding/advances', async (req, res) => {
    const body = parse(zFunding, req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => funding.recordAdvance(ctx, actorOf(req), body, { idem })));
  });
  route('POST', '/funding/repayments', async (req, res) => {
    const body = parse(zFunding, req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => funding.recordRepayment(ctx, actorOf(req), body, { idem })));
  });
  route('POST', '/funding/:id/correct', async (req, res) => {
    const id = parse(zId, req.params.id);
    const body = parse(z.object({ reason: zText(300).min(3) }).strict(), req.body);
    res.json(await runIdempotent(ctx, req, res, (idem) => funding.correctFunding(ctx, actorOf(req), id, body, { idem })));
  });

  route('GET', '/transfers', async (req, res) => {
    const q = parse(
      z
        .object({
          branchId: zOptId,
          status: z.enum(['IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional(),
          from: zDay.optional(),
          to: zDay.optional(),
          q: zQ,
          ...pageQuerySchema(transfers.TRANSFER_SORT_KEYS),
        })
        .strict(),
      req.query,
    );
    res.json(await transfers.listTransfers(ctx, actorOf(req), q));
  });
  route('POST', '/transfers', async (req, res) => {
    const body = parse(
      z
        .object({ fromBranchId: zIdBody.optional(), toBranchId: zIdBody, itemIds: z.array(zIdBody).min(1).max(500), courierName: zText(80).min(2), notes: zText(1000).optional() })
        .strict(),
      req.body,
    );
    // FIX-1 (D-fix-1): key claimed inside the transfer's transaction; a refusal consumes none.
    res.json(await runIdempotent(ctx, req, res, (idem) => transfers.createTransfer(ctx, actorOf(req), body, { idem })));
  });
  route('POST', '/transfers/:id/receive', async (req, res) => res.json(await transfers.receiveTransfer(ctx, actorOf(req), parse(zId, req.params.id))));

  // ─────────── dashboards, reports, audit, attention ───────────
  route('GET', '/dashboard/branch', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId, date: zDay.optional() }).strict(), req.query);
    res.json(await dashboard.branchDashboard(ctx, actorOf(req), q));
  });
  // UI-B (BE-1, D-ui-17): the attention list; a branch manager only for their own branch, a cashier not at all.
  route('GET', '/attention', async (req, res) => {
    const q = parse(z.object({ branchId: zOptId }).strict(), req.query);
    res.json(await attentionFor(ctx, actorOf(req), q));
  });
  route('GET', '/dashboard/company', async (req, res) => {
    const q = parse(z.object({ from: zDay.optional(), to: zDay.optional() }).strict(), req.query);
    res.json(await dashboard.companyDashboard(ctx, actorOf(req), q));
  });
  // RPT-2: the report rows' own order keys (the shared page walk sends back the key of page 1).
  const pageQueryFields = pageQuerySchema(['date', 'code'] as const);
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
    // RPT-2: with `page`, one page of the report's rows (the CSV export walks every page); without, the report.
    // A report's rows keep the report's order: `sort`/`dir` are accepted (the shared page walk sends them) and ignored.
    const { page, pageSize, asOfId, sort: _s, dir: _d, ...q } = parse(reportQuery.extend(pageQueryFields), req.query);
    res.json(page ? await reports.reportRowsPage(ctx, actorOf(req), key, { ...q, page, pageSize, asOfId }) : await reports.runReport(ctx, actorOf(req), key, q));
  });
  route('GET', '/audit', async (req, res) => {
    const q = parse(reportQuery.extend({ entityType: z.string().regex(/^[a-z_]{2,40}$/).optional(), ...pageQuerySchema(reports.AUDIT_SORT_KEYS) }), req.query);
    const data = await reports.pageAudit(ctx, actorOf(req), q);
    res.json({ ...data, rows: data.rows.map(({ sessionId, ...a }) => ({ ...a, sessionRef: sessionId ? sessions.sessionRef(sessionId) : null })) });
  });

  // First steps on an empty system (REM-3).
  route('GET', '/setup/status', async (req, res) => res.json(await setup.setupStatus(ctx, actorOf(req))));
  route('POST', '/setup/allowed-karats', async (req, res) => {
    const body = parse(z.object({ allowedKarats: z.array(z.number().int().min(8).max(24)).min(1).max(10) }).strict(), req.body);
    res.json(await setup.confirmAllowedKarats(ctx, actorOf(req), body.allowedKarats));
  });

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

  return Object.assign(r, { registered });
}
