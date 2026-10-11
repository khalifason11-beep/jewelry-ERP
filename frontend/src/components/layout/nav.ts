// The sidebar per role (UI-A1), as data so REH-1 can compare it with the approved mockups
// (docs/ux/mockups/gm-home.html, bm-home.html, cashier-home.html; ANALYSIS §4.1, D-ux-16).
//
// Built from permissions (a hidden link is never the only protection: the routes check them too):
//   General Manager: Home · Sales · Stock and gold · Suppliers · Money · Analysis · Administration — no POS (D-ux-7).
//   Branch manager:  Home · Selling (POS, Sales) · Stock and gold · Suppliers · Money · Analysis · Team.
//   Cashier:         Point of sale · My activity, always as icons.
// Only screens that exist: there is no Suppliers list page yet, so the Suppliers group holds "Supplier purchases" only.

import type { Permission } from '@jerp/shared';
import { tk } from '../../lib/i18n';

export type NavIcon =
  | 'home'
  | 'pos'
  | 'my-activity'
  | 'sales'
  | 'inventory'
  | 'transfers'
  | 'scrap'
  | 'catalog'
  | 'purchases'
  | 'cash'
  | 'branches'
  | 'reports'
  | 'users'
  | 'sessions'
  | 'audit'
  | 'settings';

export interface NavLinkDef {
  to: string;
  /** English label = translation key. */
  label: string;
  icon: NavIcon;
}
export interface NavGroupDef {
  /** English group title (translation key); null = no title (the Home link, the cashier's icons). */
  title: string | null;
  items: NavLinkDef[];
}

type Can = (p: Permission) => boolean;

/** The cashier sees only the counter: icons only, no expand (tokens.md, mockup `cashier-home`). */
export const isCounterOnly = (can: Can) => !can('dashboard.branch') && !can('dashboard.company');

export function navFor(can: Can): NavGroupDef[] {
  const gm = can('dashboard.company');
  if (isCounterOnly(can)) {
    return [
      {
        title: null,
        items: [
          ...(can('pos.access') ? [{ to: '/pos', label: tk('Point of Sale'), icon: 'pos' as const }] : []),
          ...(can('sales.view_own') ? [{ to: '/me', label: tk('My Activity'), icon: 'my-activity' as const }] : []),
        ],
      },
    ];
  }
  const groups: NavGroupDef[] = [
    { title: null, items: [{ to: gm ? '/overview' : '/dashboard', label: tk('Home'), icon: 'home' }] },
    {
      title: gm ? tk('Sales') : tk('Selling'),
      items: [
        ...(!gm && can('pos.access') ? [{ to: '/pos', label: tk('Point of Sale'), icon: 'pos' as const }] : []),
        ...(can('sales.view') ? [{ to: '/sales', label: tk('Sales'), icon: 'sales' as const }] : []),
      ],
    },
    {
      title: tk('Inventory & gold'),
      items: [
        ...(can('inventory.view') ? [{ to: '/inventory', label: tk('Inventory'), icon: 'inventory' as const }] : []),
        ...(can('inventory.transfer') && can('inventory.view') ? [{ to: '/transfers', label: tk('Transfers'), icon: 'transfers' as const }] : []),
        ...(can('scrap.buy') ? [{ to: '/scrap', label: tk('Scrap gold'), icon: 'scrap' as const }] : []),
        ...(can('catalog.create') ? [{ to: '/catalog', label: tk('Types & products'), icon: 'catalog' as const }] : []),
      ],
    },
    { title: tk('Suppliers'), items: can('purchases.view') ? [{ to: '/purchases', label: tk('Supplier purchases'), icon: 'purchases' }] : [] },
    { title: tk('Money'), items: can('cash.view') ? [{ to: '/cash', label: gm ? tk('Cash & reconciliation') : tk('Cash'), icon: 'cash' }] : [] },
    {
      title: tk('Analysis'),
      items: [
        ...(can('scope.all_branches') ? [{ to: '/branches', label: tk('Branches'), icon: 'branches' as const }] : []),
        ...(can('reports.view') ? [{ to: '/reports', label: tk('Reports'), icon: 'reports' as const }] : []),
      ],
    },
    {
      title: can('settings.manage') ? tk('Administration') : tk('Team'),
      items: [
        ...(can('users.view') ? [{ to: '/users', label: tk('Users'), icon: 'users' as const }] : []),
        ...(can('sessions.view') ? [{ to: '/sessions', label: tk('Active Users'), icon: 'sessions' as const }] : []),
        ...(can('audit.view') ? [{ to: '/audit', label: tk('Audit Log'), icon: 'audit' as const }] : []),
        ...(can('settings.manage') ? [{ to: '/settings', label: tk('Settings'), icon: 'settings' as const }] : []),
      ],
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}
