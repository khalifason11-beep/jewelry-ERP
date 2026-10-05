// The single, declarative access matrix of the HTTP API (deny by default).
//
// Every route the backend registers MUST appear here — registering an unknown route throws at
// startup, and a test fails for any rule without a registered route. The backend builds its
// central guard from this table, and the permission tests (allow / deny / cross-branch for every
// route and every role) are generated from it.
//
// scope:
//   public  — no session needed
//   self    — the caller's own account/session only
//   none    — shared reference data, no branch data
//   branch  — branch-bound users are confined to their own branch (derived from the session,
//             never from the request); global users may pass branchId
//   global  — company-wide; requires `scope.all_branches`

import type { Permission } from './permissions';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RouteScope = 'public' | 'self' | 'none' | 'branch' | 'global';

export interface RouteRule {
  method: HttpMethod;
  /** Express path relative to /api, e.g. "/sales/:id". */
  path: string;
  scope: RouteScope;
  /** Caller must hold ALL of these. */
  all?: Permission[];
  /** Caller must hold AT LEAST ONE of these. */
  any?: Permission[];
  /** Password re-confirmation within the re-auth window. */
  reauth?: boolean;
  /** Registered only in APP_MODE=demo. */
  demoOnly?: boolean;
  /** Destroys business data — only ever allowed in demo mode. */
  destructive?: boolean;
  /**
   * Creates or confirms a business record: the request must carry an `Idempotency-Key` header.
   * The same key + same body replays the first response; the same key + a different body is 422.
   */
  idempotent?: boolean;
  /**
   * Money route: the key is claimed and the result stored INSIDE the business transaction that also
   * writes the ledger (no reservation outside it). Implies `idempotent`.
   */
  idempotencyInTx?: boolean;
}

const r = (method: HttpMethod, path: string, scope: RouteScope, extra: Omit<RouteRule, 'method' | 'path' | 'scope'> = {}): RouteRule => ({
  method,
  path,
  scope,
  ...extra,
});

export const ROUTE_MATRIX: readonly RouteRule[] = [
  // ── public
  r('POST', '/auth/login', 'public'),
  // Second step of sign-in (Phase 2fa): only usable with the short-lived pending-login cookie.
  r('POST', '/auth/login/passkey/options', 'public'),
  r('POST', '/auth/login/passkey/verify', 'public'),
  r('POST', '/auth/login/recovery', 'public'),
  r('POST', '/auth/login/cancel', 'public'),
  r('GET', '/meta', 'public'),
  r('GET', '/health', 'public'),
  r('GET', '/branding/logo', 'public'),

  // ── own account / session
  r('GET', '/auth/me', 'self'),
  r('POST', '/auth/logout', 'self'),
  r('POST', '/auth/change-password', 'self'),
  r('POST', '/auth/reauth', 'self'),
  // Passkeys and recovery codes (own account). Removing a passkey needs password + passkey step-up.
  r('POST', '/auth/reauth/passkey/options', 'self'),
  r('POST', '/auth/reauth/passkey/verify', 'self'),
  r('GET', '/auth/passkeys', 'self'),
  r('POST', '/auth/passkeys/register/options', 'self'),
  r('POST', '/auth/passkeys/register/verify', 'self'),
  r('DELETE', '/auth/passkeys/:id', 'self', { reauth: true }),
  r('POST', '/auth/recovery-codes', 'self'),
  r('POST', '/auth/recovery-codes/acknowledge', 'self'),
  r('GET', '/auth/sign-ins', 'self'),
  r('POST', '/auth/sign-ins/:id/dismiss', 'self'),
  r('POST', '/auth/sign-ins/:id/not-me', 'self'),
  // Second-factor policy (user verification, required roles): password + passkey step-up.
  r('PUT', '/security/second-factor', 'global', { all: ['settings.manage'], reauth: true }),
  r('POST', '/sessions/heartbeat', 'self'),
  r('GET', '/notifications', 'self'),

  // ── reference data
  r('GET', '/branches', 'none'),
  r('GET', '/branches/directory', 'none'),
  r('GET', '/categories', 'none'),
  r('GET', '/gold-rates', 'none'),
  r('GET', '/products', 'none', { all: ['purchases.create'] }),
  r('GET', '/suppliers', 'none', { all: ['purchases.view'] }),
  r('GET', '/roles', 'none', { all: ['users.view'] }),
  r('GET', '/branches/:id', 'branch'),

  // ── company administration (GM)
  r('POST', '/gold-rates', 'global', { all: ['settings.manage'], reauth: true }),
  r('GET', '/settings', 'global', { all: ['settings.manage'] }),
  r('PUT', '/settings', 'global', { all: ['settings.manage'], reauth: true }),
  r('GET', '/settings/history/:key', 'global', { all: ['settings.manage'] }),
  r('POST', '/branding/logo', 'global', { all: ['settings.manage'], reauth: true }),
  r('DELETE', '/branding/logo', 'global', { all: ['settings.manage'], reauth: true }),
  r('POST', '/branches', 'global', { all: ['branches.manage'], reauth: true }),
  r('PATCH', '/branches/:id', 'global', { all: ['branches.manage'], reauth: true }),

  // ── sessions & users
  r('GET', '/sessions', 'branch', { any: ['sessions.view_own', 'sessions.view'] }),
  r('POST', '/sessions/:key/revoke', 'branch', { all: ['sessions.revoke'] }),
  r('GET', '/users', 'branch', { all: ['users.view'] }),
  r('POST', '/users', 'branch', { all: ['users.manage'], reauth: true }),
  // Re-auth is required by the handler only when the role or branch changes.
  r('PATCH', '/users/:id', 'branch', { all: ['users.manage'] }),
  r('POST', '/users/:id/reset-password', 'branch', { all: ['users.manage'], reauth: true }),
  r('POST', '/users/:id/disable', 'branch', { all: ['users.manage'] }),
  r('POST', '/users/:id/enable', 'branch', { all: ['users.manage'] }),
  r('POST', '/users/:id/unlock', 'branch', { all: ['users.manage'] }),

  // ── inventory
  r('GET', '/inventory/items', 'branch', { any: ['inventory.view', 'inventory.view_available'] }),
  r('GET', '/inventory/items/:id', 'branch', { any: ['inventory.view', 'inventory.view_available'] }),
  r('POST', '/inventory/items/:id/price', 'branch', { all: ['inventory.price_edit'] }),
  r('POST', '/inventory/items/:id/adjust', 'branch', { all: ['inventory.adjust'], reauth: true }),

  // ── sales
  r('POST', '/sales', 'branch', { all: ['sales.create'], idempotent: true, idempotencyInTx: true }),
  r('GET', '/sales', 'branch', { any: ['sales.view', 'sales.view_own'] }),
  r('GET', '/sales/:id', 'branch', { any: ['sales.view', 'sales.view_own'] }),
  // Printing (D-print-5): the service decides original (cashier, same session, once) vs reprint (sales.reprint).
  r('POST', '/sales/:id/print', 'branch', { any: ['sales.view', 'sales.view_own'] }),
  r('POST', '/sales/:id/void', 'branch', { all: ['sales.void'], idempotent: true, idempotencyInTx: true }),

  // ── Hasad Gold
  r('GET', '/hasad/withdrawals', 'branch', { any: ['hasad.process', 'hasad.view'] }),
  r('GET', '/hasad/withdrawals/:id', 'branch', { any: ['hasad.process', 'hasad.view'] }),
  r('GET', '/hasad/withdrawals/:id/candidates', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/open', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/items', 'branch', { all: ['hasad.process'] }),
  r('DELETE', '/hasad/withdrawals/:id/items/:itemId', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/complete', 'branch', { all: ['hasad.process'], idempotent: true, idempotencyInTx: true }),
  r('POST', '/hasad/withdrawals/:id/abort', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/cancel', 'branch', { all: ['hasad.cancel'] }),

  // ── purchases, transfers
  r('GET', '/purchases', 'branch', { all: ['purchases.view'] }),
  r('GET', '/purchases/:id', 'branch', { all: ['purchases.view'] }),
  r('POST', '/purchases', 'branch', { all: ['purchases.create'], idempotent: true, idempotencyInTx: true }),
  // ── scrap gold and supplier settlement (Phase 4)
  r('GET', '/scrap-rates', 'none', { any: ['scrap.buy', 'settings.manage'] }),
  r('POST', '/scrap-rates', 'global', { all: ['settings.manage'], reauth: true }),
  r('GET', '/scrap-purchases', 'branch', { any: ['scrap.buy', 'purchases.view'] }),
  r('POST', '/scrap-purchases', 'branch', { all: ['scrap.buy'], idempotent: true, idempotencyInTx: true }),
  r('GET', '/scrap-pool', 'branch', { any: ['inventory.view', 'scrap.buy'] }),
  r('POST', '/purchases/:id/settlements', 'branch', { all: ['purchases.settle'], idempotent: true, idempotencyInTx: true }),
  // ── cash (Phase 2b): expected drawer balance, daily reconciliation, counted cash
  r('GET', '/cash/drawer', 'branch', { all: ['cash.view'] }),
  // Phase 2c: age and status of the latest backup / restore drill (no file names, no paths).
  r('GET', '/backups/status', 'global', { all: ['backups.view'] }),
  r('GET', '/cash/reconciliation', 'branch', { all: ['cash.view'] }),
  r('POST', '/cash/counts', 'branch', { all: ['cash.count'], idempotent: true }),
  // Hasad receivable settled by a bank transfer from Hasad (Phase 4 follow-up).
  r('GET', '/cash/hasad-settlements', 'branch', { all: ['cash.view'] }),
  r('POST', '/cash/hasad-settlements', 'branch', { all: ['cash.settle_hasad'], idempotent: true, idempotencyInTx: true }),
  r('GET', '/transfers', 'branch', { all: ['inventory.transfer'] }),
  r('POST', '/transfers', 'branch', { all: ['inventory.transfer'], idempotent: true }),
  r('POST', '/transfers/:id/receive', 'branch', { all: ['inventory.transfer'], idempotent: true }),

  // ── dashboards, reports, audit
  r('GET', '/dashboard/branch', 'branch', { all: ['dashboard.branch'] }),
  r('GET', '/dashboard/company', 'global', { all: ['dashboard.company'] }),
  r('GET', '/reports/:key', 'branch', { all: ['reports.view'] }),
  r('GET', '/audit', 'branch', { all: ['audit.view'] }),

  // ── demo tooling (never registered in production)
  r('POST', '/demo/reset', 'global', { all: ['settings.manage'], reauth: true, demoOnly: true, destructive: true }),
  r('GET', '/hasad/simulator/customers', 'global', { all: ['hasad.simulate'], demoOnly: true }),
  r('POST', '/hasad/simulator/withdrawals', 'global', { all: ['hasad.simulate'], demoOnly: true }),
  r('GET', '/hasad/integration-log', 'global', { all: ['hasad.simulate'], demoOnly: true }),
];

export const routeId = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

export function findRouteRule(method: string, path: string): RouteRule | undefined {
  return ROUTE_MATRIX.find((x) => x.method === method.toUpperCase() && x.path === path);
}

/** Does a set of permissions satisfy a rule's permission requirements? (Scope/auth checked separately.) */
export function permitsRule(rule: RouteRule, has: (p: Permission) => boolean): boolean {
  if (rule.all && !rule.all.every(has)) return false;
  if (rule.any && !rule.any.some(has)) return false;
  if (rule.scope === 'global' && !has('scope.all_branches')) return false;
  return true;
}
