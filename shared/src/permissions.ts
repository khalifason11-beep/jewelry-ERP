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

  // Catalog (CAT-0): item types, products and suppliers entered by people
  'catalog.create': 'Create item types, products and suppliers (also inline in the purchase forms)',
  'catalog.manage': 'Deactivate or reactivate item types and products',

  // Purchases
  'purchases.view': 'View purchases',
  'purchases.create': 'Record purchases (stock receipt)',


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
  // PRC-1 (D-prc1-6): the price is no longer typed, so the cashier may buy a sellable piece (not broken scrap).
  'scrap.buy_sellable': 'Buy a sellable piece from a customer at the counter (not broken scrap)',
  'purchases.settle': 'Record a supplier settlement paid with broken-scrap weight',
  'backups.view': 'See the age and status of the latest backup and restore drill',
  // CSH-2 (D-csh-5): the General Manager's advances to a branch and the branch's repayments. General Manager only.
  'funding.view': 'See what each branch owes the General Manager and the history of advances and repayments',
  'funding.manage': 'Record an advance to a branch, a repayment from a branch, or correct one of them',
  // MIS-1: correcting a mistake (reason and password asked again). General Manager only.
  'scrap.void': 'Void a scrap purchase made by mistake (reason and password; money, piece or pool weight reversed)',
  'purchases.correct': "Correct a supplier order's piece making cost or transfer reference (reason and password)",
  // OPN-1: the opening balance of a branch (once per branch, sealed with the password and a passkey). General Manager only.
  'opening.manage': 'Enter, import, review and seal the opening balance of a branch (once per branch)',
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
  'sessions.view_own',
  // PRC-1 (D-prc1-6): a sellable piece from a customer, at the scrap rate; every limit of the purchase still applies.
  'scrap.buy_sellable',
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
  // MKC-1 (client fact 5, Q9): creating a supplier order is General-Manager-only (no 'purchases.create' here).
  // CAT-0: a branch manager creates types, products and suppliers while recording stock; only the GM deactivates.
  'catalog.create',
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

/**
 * Permissions that only the General Manager may ever hold (D-csh-5, D-mkc-6, D-mis1-2): the funding of a branch, the creation of
 * supplier orders, voiding a scrap purchase and correcting a supplier order. No screen or API edits role grants; tests prove the defaults, the seed and the migrations never give
 * them to another role.
 */
export const GM_ONLY_PERMISSIONS = ['funding.view', 'funding.manage', 'purchases.create', 'scrap.void', 'purchases.correct', 'opening.manage'] as const satisfies readonly Permission[];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleCode, Permission[]> = {
  CASHIER,
  BRANCH_MANAGER,
  GENERAL_MANAGER,
};

export const DEFAULT_ROLES: { code: SystemRoleCode; name: string; nameAr: string; description: string }[] = [
  { code: 'CASHIER', name: 'Cashier', nameAr: 'كاشير', description: 'Point of sale for one branch' },
  { code: 'BRANCH_MANAGER', name: 'Branch Manager', nameAr: 'مدير فرع', description: 'Full operational control of one branch' },
  { code: 'GENERAL_MANAGER', name: 'General Manager', nameAr: 'المدير العام', description: 'Company-wide access and administration' },
];
