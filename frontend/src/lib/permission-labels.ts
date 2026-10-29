// UX-2: the short name of every permission, shown instead of its code (`sales.create`…). English keys, translated
// in i18n-ar.ts. Typed on the shared catalogue, so a new permission without a name does not compile.

import type { Permission } from '@jerp/shared';
import { tk } from './i18n';

export const PERMISSION_LABELS: Record<Permission, string> = {
  'scope.all_branches': tk('Every branch'),
  'pos.access': tk('Point of sale'),
  'sales.create': tk('Sell'),
  'sales.discount': tk('Give a discount'),
  'sales.view_own': tk('See own sales'),
  'sales.view': tk('See all sales'),
  'sales.void': tk('Cancel a sale'),
  'sales.reprint': tk('Reprint an invoice'),
  'inventory.view_available': tk('Search pieces for sale'),
  'inventory.view': tk('See the full stock'),
  'inventory.adjust': tk('Mark a piece damaged or returned'),
  'inventory.price_edit': tk('Change a piece’s price'),
  'inventory.transfer': tk('Send and receive transfers'),
  'catalog.create': tk('Add types, products and suppliers'),
  'catalog.manage': tk('Deactivate types and products'),
  'purchases.view': tk('See supplier orders'),
  'purchases.create': tk('Record a supplier order'),
  'purchases.settle': tk('Settle with a supplier in scrap'),
  'purchases.correct': tk('Correct a supplier order'),
  'dashboard.branch': tk('Branch home'),
  'dashboard.company': tk('Company home'),
  'reports.view': tk('Reports'),
  'profit.view': tk('See cost and profit'),
  'users.view': tk('See users'),
  'users.manage': tk('Manage users'),
  'sessions.view_own': tk('See own sessions'),
  'sessions.view': tk('See who is signed in'),
  'sessions.revoke': tk('Sign out another user'),
  'audit.view': tk('Audit log'),
  'settings.manage': tk('Settings and prices'),
  'branches.manage': tk('Manage branches'),
  'cash.view': tk('See the cash'),
  'cash.count': tk('Count the drawer'),
  'scrap.buy': tk('Buy scrap'),
  'scrap.buy_sellable': tk('Buy a piece from a customer'),
  'scrap.override': tk('Approve a scrap price'),
  'scrap.void': tk('Void a scrap purchase'),
  'backups.view': tk('See the backups'),
  'funding.view': tk('See what branches owe'),
  'funding.manage': tk('Record advances and repayments'),
  'opening.manage': tk('Opening balance'),
  'opening.correct': tk('Correct the opening balance'),
};

/** The name of a permission code; a code the catalogue does not know (a role added later) has a generic name. */
export const permissionLabel = (code: string): string => PERMISSION_LABELS[code as Permission] ?? tk('Other permission');
