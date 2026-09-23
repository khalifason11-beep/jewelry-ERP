// Wire-level types of the (future) Hasad Gold API, as the ERP expects to receive them.
// Deliberately shaped like an external API (string grams, external ids, ISO dates) so that
// the ERP-side adapter has to translate — exactly what it will do with the real API.

export type HasadExternalStatus =
  | 'PENDING' // accumulating / not yet approved by Hasad
  | 'READY_FOR_PICKUP' // approved, customer may visit the branch
  | 'IN_PROGRESS' // customer is at the branch counter
  | 'COMPLETED'
  | 'CANCELLED';

export interface HasadCustomer {
  customerId: string; // e.g. "HC-204518"
  fullName: string;
  fullNameAr?: string;
  phone?: string;
  nationalIdMasked?: string; // e.g. "***-***-4471"
}

export interface HasadWithdrawal {
  withdrawalId: string; // e.g. "HG-10025"
  customer: HasadCustomer;
  entitlement: {
    weightGrams: string; // "4.200"
    karat: number; // karat the grams are denominated in
  };
  branchCode: string; // Hasad's branch code, mapped to an ERP branch
  status: HasadExternalStatus;
  pickupCode?: string;
  requestedAt: string; // ISO-8601
  updatedAt: string;
  completion?: HasadCompletion;
  cancellation?: { reason: string; cancelledAt: string; source: 'ERP' | 'HASAD' };
}

export interface HasadCompletion {
  erpReference: string;
  branchCode: string;
  deliveredWeightGrams: string;
  items: { code: string; description: string; karat: number; netWeightGrams: string }[];
  settlement: {
    direction: 'BRANCH_PAYS_CUSTOMER' | 'CUSTOMER_PAYS_BRANCH' | 'NONE';
    weightGrams: string;
    amount: number;
    currency: string;
  };
  completedBy: string;
  completedAt: string;
}

export interface HasadEntitlement {
  customer: HasadCustomer;
  balanceGrams: string;
  withdrawableGrams: string;
  minimumWithdrawalGrams: string;
  karat: number;
  asOf: string;
}

export interface ListWithdrawalsQuery {
  branchCode?: string;
  status?: HasadExternalStatus[];
  updatedSince?: string;
}
