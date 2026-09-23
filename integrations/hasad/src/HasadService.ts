// The ONLY contract the ERP knows about Hasad Gold.
// Today: MockHasadService. Later: an HTTP implementation of the same interface.

import type {
  HasadCompletion,
  HasadEntitlement,
  HasadWithdrawal,
  ListWithdrawalsQuery,
} from './types';

export interface HasadService {
  /** Human-readable name of the implementation (shown in the UI integration badge). */
  readonly mode: 'MOCK' | 'LIVE';

  listWithdrawals(query?: ListWithdrawalsQuery): Promise<HasadWithdrawal[]>;
  getWithdrawal(withdrawalId: string): Promise<HasadWithdrawal>;
  getCustomerEntitlement(customerId: string): Promise<HasadEntitlement>;
  /** Tell Hasad the customer is at the counter (locks the request on the Hasad side). */
  markInProgress(withdrawalId: string, info: { branchCode: string; openedBy: string }): Promise<HasadWithdrawal>;
  /** Hand back to READY_FOR_PICKUP if the counter visit is aborted without completion. */
  markReady(withdrawalId: string): Promise<HasadWithdrawal>;
  completeWithdrawal(withdrawalId: string, completion: Omit<HasadCompletion, 'completedAt'>): Promise<HasadWithdrawal>;
  cancelWithdrawal(withdrawalId: string, reason: string): Promise<HasadWithdrawal>;
}

export type HasadErrorCode = 'UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_STATE' | 'REJECTED';

export class HasadError extends Error {
  constructor(
    public readonly code: HasadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HasadError';
  }
}
