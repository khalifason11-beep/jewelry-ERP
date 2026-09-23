// View models returned by the API (kept close to the backend service shapes).

export interface Branch {
  id: number;
  code: string;
  name: string;
  nameAr: string;
  city: string;
  address?: string | null;
  phone?: string | null;
  hasadBranchCode?: string | null;
}

export interface ItemRow {
  id: number;
  code: string;
  barcode: string;
  productId: number;
  productName: string;
  productNameAr: string;
  sku: string;
  categoryCode: string;
  categoryName: string;
  categoryNameAr: string;
  karat: number;
  grossWeightMg: number;
  netWeightMg: number;
  purchaseCost?: number;
  makingCost?: number;
  otherCost?: number;
  totalCost?: number;
  sellingPrice: number;
  branchId: number;
  branchCode: string;
  branchName: string;
  branchNameAr: string;
  status: string;
  reservationRef: string | null;
  reservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: number;
  code: string;
  name: string;
  nameAr: string;
}

export interface Withdrawal {
  id: number;
  externalId: string;
  hasadCustomerId: string;
  customerName: string;
  customerNameAr: string | null;
  customerPhone: string | null;
  customerNationalIdMasked: string | null;
  entitledWeightMg: number;
  entitlementKarat: number;
  branchId: number;
  branchName: string;
  branchNameAr: string;
  status: string;
  externalStatus: string;
  hasPickupCode: boolean;
  requestedAt: string;
  receivedAt: string;
  openedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  redemptionNumber: string | null;
  deliveredWeightMg: number | null;
  settlementDirection: string | null;
  settlementAmount: number | null;
  reservedCount: number;
  openedByName: string | null;
  completedByName: string | null;
}

export interface WithdrawalList {
  syncError: string | null;
  syncedAt: string;
  mode: 'MOCK' | 'LIVE';
  withdrawals: Withdrawal[];
}

export interface Settlement {
  entitledWeightMg: number;
  deliveredWeightMg: number;
  differenceMg: number;
  absDifferenceMg: number;
  direction: 'BRANCH_PAYS_CUSTOMER' | 'CUSTOMER_PAYS_BRANCH' | 'NONE';
  ratePerGram: number;
  amount: number;
  basis: 'NET_WEIGHT' | 'PURE_GOLD_EQUIVALENT';
  rateKarats: number[];
}

export interface Report {
  key: string;
  title: string;
  description: string;
  columns: { key: string; label: string; type: string; link?: string }[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
  notes?: string[];
  filters: { dateRange: boolean; branch: boolean; user: boolean; status?: string[] };
}
