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
  r('GET', '/meta', 'public'),
  r('GET', '/health', 'public'),
  r('GET', '/branding/logo', 'public'),

  // ── own account / session
  r('GET', '/auth/me', 'self'),
  r('POST', '/auth/logout', 'self'),
  r('POST', '/auth/change-password', 'self'),
  r('POST', '/auth/reauth', 'self'),
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
  r('POST', '/sales', 'branch', { all: ['sales.create'], idempotent: true }),
  r('GET', '/sales', 'branch', { any: ['sales.view', 'sales.view_own'] }),
  r('GET', '/sales/:id', 'branch', { any: ['sales.view', 'sales.view_own'] }),
  r('POST', '/sales/:id/void', 'branch', { all: ['sales.void'], idempotent: true }),

  // ── Hasad Gold
  r('GET', '/hasad/withdrawals', 'branch', { any: ['hasad.process', 'hasad.view'] }),
  r('GET', '/hasad/withdrawals/:id', 'branch', { any: ['hasad.process', 'hasad.view'] }),
  r('GET', '/hasad/withdrawals/:id/candidates', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/open', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/items', 'branch', { all: ['hasad.process'] }),
  r('DELETE', '/hasad/withdrawals/:id/items/:itemId', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/complete', 'branch', { all: ['hasad.process'], idempotent: true }),
  r('POST', '/hasad/withdrawals/:id/abort', 'branch', { all: ['hasad.process'] }),
  r('POST', '/hasad/withdrawals/:id/cancel', 'branch', { all: ['hasad.cancel'] }),

  // ── purchases, expenses, transfers
  r('GET', '/purchases', 'branch', { all: ['purchases.view'] }),
  r('GET', '/purchases/:id', 'branch', { all: ['purchases.view'] }),
  r('POST', '/purchases', 'branch', { all: ['purchases.create'], idempotent: true }),
  r('GET', '/expenses', 'branch', { all: ['expenses.view'] }),
  r('POST', '/expenses', 'branch', { all: ['expenses.create'], idempotent: true }),
  r('POST', '/expenses/:id/review', 'branch', { all: ['expenses.approve'], idempotent: true }),
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
