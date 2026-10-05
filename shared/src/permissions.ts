// Permission catalogue and default role grants.
// Roles are stored in the database; these defaults are only used to seed them.
// Adding a role later = inserting a row + its grants, no code change.

export const PERMISSIONS = {
  // Scope
  'scope.all_branches': 'Access data of every branch',

  // POS & sales
  'pos.access': 'Open the point of sale',
  'sales.create': 'Create normal sales',
  'sales.discount': 'Apply discounts within the role limit',
  'sales.view_own': 'View own sales',
  'sales.view': 'View all sales in scope',
  'sales.void': 'Cancel (void) a completed sale',
  'sales.reprint': 'Reprint an invoice (marked COPY n and audited)',

  // Inventory
  'inventory.view_available': 'Search sellable inventory in own branch',
  'inventory.view': 'View full inventory, costs and lifecycle',
  'inventory.adjust': 'Mark items damaged / returned / restock',
  'inventory.price_edit': 'Change item selling price',
  'inventory.transfer': 'Send and receive inter-branch transfers',

  // Purchases
  'purchases.view': 'View purchases',
  'purchases.create': 'Record purchases (stock receipt)',

  // Hasad
  'hasad.process': 'Process Hasad withdrawals at the counter',
  'hasad.view': 'View Hasad withdrawals and redemptions',
  'hasad.cancel': 'Cancel a Hasad withdrawal request',
  'hasad.simulate': 'Use the mock Hasad simulator (demo only)',

  // Dashboards & reports
  'dashboard.branch': 'Branch dashboard',
  'dashboard.company': 'Company executive dashboard',
  'reports.view': 'Operational reports',
  'profit.view': 'See cost, acquisition cost and profit figures (General Manager only)',

  // Administration
  'users.view': 'View users',
  'users.manage': 'Create users, assign roles/branches, reset passwords, disable accounts',
  'sessions.view_own': 'View own session',
  'sessions.view': 'View active sessions in scope',
  'sessions.revoke': 'Terminate other users’ sessions',
  'audit.view': 'View the audit log',
  'settings.manage': 'Change system settings, branding, gold rates and demo tools',
  'branches.manage': 'Create and edit branches',
  'cash.view': 'See the expected cash in the drawer and the daily cash reconciliation',
  'cash.count': 'Record the counted cash of a business day',
  'cash.settle_hasad': 'Record a Hasad bank transfer received: moves the amount from the Hasad receivable to the bank',
  'scrap.buy': 'Buy scrap gold from customers at the counter (sellable pieces or broken scrap)',
  'scrap.override': 'Approve a scrap price beyond the allowed tolerance from the scrap buying rate',
  'purchases.settle': 'Record a supplier settlement paid with broken-scrap weight',
  'backups.view': 'See the age and status of the latest backup and restore drill',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ROLE_CODES = ['CASHIER', 'BRANCH_MANAGER', 'GENERAL_MANAGER'] as const;
export type SystemRoleCode = (typeof ROLE_CODES)[number];
/** Role codes are open-ended strings in the DB; system roles are the defaults. */
export type RoleCode = SystemRoleCode | (string & {});

const CASHIER: Permission[] = [
  'pos.access',
  'sales.create',
  'sales.discount',
  'sales.view_own',
  'inventory.view_available',
  'hasad.process',
  'sessions.view_own',
];

const BRANCH_MANAGER: Permission[] = [
  ...CASHIER,
  'sales.view',
  'sales.void',
  // Reprints are manager-only; a cashier prints once, right after the sale (D-print-5).
  'sales.reprint',
  'inventory.view',
  'inventory.adjust',
  'inventory.price_edit',
  'inventory.transfer',
  'purchases.view',
  'purchases.create',
  'hasad.view',
  // Cancelling a Hasad request is manager-only (decision Q14).
  'hasad.cancel',
  'dashboard.branch',
  'reports.view',
  // Expected cash and the daily reconciliation of the own branch (Phase 2b).
  'cash.view',
  'cash.count',
  // Phase 4: counter scrap purchases and supplier settlements with broken-scrap weight.
  'scrap.buy',
  'purchases.settle',
  // Hasad pays the branch by bank transfer: the manager records it (receivable → bank).
  'cash.settle_hasad',
  // No 'profit.view': cost, acquisition cost and profit are General Manager only (decision Q15).
  'users.view',
  'sessions.view',
  'audit.view',
];

const GENERAL_MANAGER: Permission[] = [
  ...(Object.keys(PERMISSIONS) as Permission[]),
];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleCode, Permission[]> = {
  CASHIER,
  BRANCH_MANAGER,
  GENERAL_MANAGER,
};

export const DEFAULT_ROLES: { code: SystemRoleCode; name: string; nameAr: string; description: string }[] = [
  { code: 'CASHIER', name: 'Cashier', nameAr: 'كاشير', description: 'Point of sale and Hasad counter operations for one branch' },
  { code: 'BRANCH_MANAGER', name: 'Branch Manager', nameAr: 'مدير فرع', description: 'Full operational control of one branch' },
  { code: 'GENERAL_MANAGER', name: 'General Manager', nameAr: 'المدير العام', description: 'Company-wide access and administration' },
];
