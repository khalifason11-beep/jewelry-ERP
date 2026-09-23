// Mock implementation of the Hasad Gold API.
// Behaves like a remote system: its own storage, latency, state machine, error codes,
// optional simulated outage, and a log of every call it receives.

import { and, desc, eq, gte, inArray, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { HasadError, type HasadService } from '../HasadService';
import type {
  HasadCompletion,
  HasadEntitlement,
  HasadExternalStatus,
  HasadWithdrawal,
  ListWithdrawalsQuery,
} from '../types';
import { mockApiCalls, mockCustomers, mockWithdrawals } from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = PgDatabase<PgQueryResultHKT, any>;

export interface MockHasadOptions {
  /** Read at call time so settings changes apply immediately. */
  behaviour: () => Promise<{ latencyMs: number; simulateOutage: boolean }>;
  /** Minimum withdrawable balance, in mg. */
  minimumWithdrawalMg?: number;
}

const grams = (mg: number) => (mg / 1000).toFixed(3);
const toMg = (g: string) => Math.round(Number(g) * 1000);

type WithdrawalRow = typeof mockWithdrawals.$inferSelect;
type CustomerRow = typeof mockCustomers.$inferSelect;

export class MockHasadService implements HasadService {
  readonly mode = 'MOCK' as const;
  private readonly minimumWithdrawalMg: number;

  constructor(
    private readonly db: AnyDB,
    private readonly opts: MockHasadOptions,
  ) {
    this.minimumWithdrawalMg = opts.minimumWithdrawalMg ?? 1000;
  }

  // ───────── public API (the contract) ─────────

  listWithdrawals(query: ListWithdrawalsQuery = {}): Promise<HasadWithdrawal[]> {
    return this.call('GET /withdrawals', query, async () => {
      const where: SQL[] = [];
      if (query.branchCode) where.push(eq(mockWithdrawals.branchCode, query.branchCode));
      if (query.status?.length) where.push(inArray(mockWithdrawals.status, query.status));
      if (query.updatedSince) where.push(gte(mockWithdrawals.updatedAt, new Date(query.updatedSince)));
      const rows = await this.db
        .select()
        .from(mockWithdrawals)
        .innerJoin(mockCustomers, eq(mockCustomers.id, mockWithdrawals.customerId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(mockWithdrawals.requestedAt));
      return rows.map((r) => this.toDto(r.withdrawals, r.customers));
    });
  }

  getWithdrawal(withdrawalId: string): Promise<HasadWithdrawal> {
    return this.call(`GET /withdrawals/${withdrawalId}`, null, () => this.load(withdrawalId));
  }

  getCustomerEntitlement(customerId: string): Promise<HasadEntitlement> {
    return this.call(`GET /customers/${customerId}/entitlement`, null, async () => {
      const [c] = await this.db.select().from(mockCustomers).where(eq(mockCustomers.id, customerId));
      if (!c) throw new HasadError('NOT_FOUND', `Customer ${customerId} not found`);
      const withdrawable = c.balanceMg >= this.minimumWithdrawalMg ? c.balanceMg : 0;
      return {
        customer: this.customerDto(c),
        balanceGrams: grams(c.balanceMg),
        withdrawableGrams: grams(withdrawable),
        minimumWithdrawalGrams: grams(this.minimumWithdrawalMg),
        karat: c.karat,
        asOf: new Date().toISOString(),
      };
    });
  }

  markInProgress(withdrawalId: string, info: { branchCode: string; openedBy: string }): Promise<HasadWithdrawal> {
    return this.call(`POST /withdrawals/${withdrawalId}/in-progress`, info, async () => {
      const w = await this.row(withdrawalId);
      if (w.branchCode !== info.branchCode) throw new HasadError('REJECTED', 'Withdrawal is assigned to a different branch');
      this.assertStatus(w, ['READY_FOR_PICKUP', 'IN_PROGRESS']);
      return this.setStatus(withdrawalId, 'IN_PROGRESS');
    });
  }

  markReady(withdrawalId: string): Promise<HasadWithdrawal> {
    return this.call(`POST /withdrawals/${withdrawalId}/ready`, null, async () => {
      const w = await this.row(withdrawalId);
      this.assertStatus(w, ['READY_FOR_PICKUP', 'IN_PROGRESS']);
      return this.setStatus(withdrawalId, 'READY_FOR_PICKUP');
    });
  }

  completeWithdrawal(withdrawalId: string, completion: Omit<HasadCompletion, 'completedAt'>): Promise<HasadWithdrawal> {
    return this.call(`POST /withdrawals/${withdrawalId}/complete`, completion, async () => {
      const w = await this.row(withdrawalId);
      this.assertStatus(w, ['READY_FOR_PICKUP', 'IN_PROGRESS']);
      const [c] = await this.db.select().from(mockCustomers).where(eq(mockCustomers.id, w.customerId));
      const full: HasadCompletion = { ...completion, completedAt: new Date().toISOString() };
      await this.db
        .update(mockCustomers)
        .set({ balanceMg: Math.max(0, (c?.balanceMg ?? 0) - w.weightMg) })
        .where(eq(mockCustomers.id, w.customerId));
      await this.db
        .update(mockWithdrawals)
        .set({ status: 'COMPLETED', completion: full, updatedAt: new Date() })
        .where(eq(mockWithdrawals.id, withdrawalId));
      return this.load(withdrawalId);
    });
  }

  cancelWithdrawal(withdrawalId: string, reason: string): Promise<HasadWithdrawal> {
    return this.call(`POST /withdrawals/${withdrawalId}/cancel`, { reason }, async () => {
      const w = await this.row(withdrawalId);
      this.assertStatus(w, ['PENDING', 'READY_FOR_PICKUP', 'IN_PROGRESS']);
      await this.db
        .update(mockWithdrawals)
        .set({
          status: 'CANCELLED',
          cancellation: { reason, cancelledAt: new Date().toISOString(), source: 'ERP' },
          updatedAt: new Date(),
        })
        .where(eq(mockWithdrawals.id, withdrawalId));
      return this.load(withdrawalId);
    });
  }

  // ───────── simulator (demo tooling, NOT part of the contract) ─────────

  async simulateCustomers(): Promise<HasadEntitlement[]> {
    const rows = await this.db.select().from(mockCustomers).orderBy(mockCustomers.fullName);
    return rows.map((c) => ({
      customer: this.customerDto(c),
      balanceGrams: grams(c.balanceMg),
      withdrawableGrams: grams(c.balanceMg >= this.minimumWithdrawalMg ? c.balanceMg : 0),
      minimumWithdrawalGrams: grams(this.minimumWithdrawalMg),
      karat: c.karat,
      asOf: new Date().toISOString(),
    }));
  }

  /** Simulates a customer requesting a withdrawal in the Hasad app. */
  async simulateWithdrawalRequest(input: {
    customerId: string;
    branchCode: string;
    weightMg?: number;
  }): Promise<HasadWithdrawal> {
    const [c] = await this.db.select().from(mockCustomers).where(eq(mockCustomers.id, input.customerId));
    if (!c) throw new HasadError('NOT_FOUND', 'Customer not found');
    const weightMg = input.weightMg ?? c.balanceMg;
    if (weightMg < this.minimumWithdrawalMg) throw new HasadError('REJECTED', 'Below minimum withdrawal threshold');
    if (weightMg > c.balanceMg) throw new HasadError('REJECTED', 'Insufficient Hasad balance');
    const open = await this.db
      .select({ id: mockWithdrawals.id })
      .from(mockWithdrawals)
      .where(and(eq(mockWithdrawals.customerId, c.id), inArray(mockWithdrawals.status, ['PENDING', 'READY_FOR_PICKUP', 'IN_PROGRESS'])));
    if (open.length) throw new HasadError('REJECTED', `Customer already has an open withdrawal (${open[0].id})`);

    const id = await this.nextWithdrawalId();
    await this.db.insert(mockWithdrawals).values({
      id,
      customerId: c.id,
      weightMg,
      karat: c.karat,
      branchCode: input.branchCode,
      status: 'READY_FOR_PICKUP',
      pickupCode: String(100000 + Math.floor(Math.random() * 899999)),
      requestedAt: new Date(),
    });
    return this.load(id);
  }

  async recentCalls(limit = 50) {
    return this.db.select().from(mockApiCalls).orderBy(desc(mockApiCalls.id)).limit(limit);
  }

  // ───────── internals ─────────

  private async nextWithdrawalId(): Promise<string> {
    const rows = await this.db.select({ id: mockWithdrawals.id }).from(mockWithdrawals);
    const max = rows.reduce((m, r) => Math.max(m, Number(r.id.replace(/\D/g, '')) || 0), 10000);
    return `HG-${max + 1}`;
  }

  private async call<T>(operation: string, request: unknown, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const { latencyMs, simulateOutage } = await this.opts.behaviour();
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    const log = async (status: number, response: unknown) => {
      await this.db.insert(mockApiCalls).values({
        operation,
        request: (request ?? null) as object | null,
        responseStatus: status,
        response: summarize(response) as object | null,
        durationMs: Date.now() - started,
      });
    };
    if (simulateOutage) {
      await log(503, { error: 'Service Unavailable' });
      throw new HasadError('UNAVAILABLE', 'Hasad Gold service is unavailable (simulated outage)');
    }
    try {
      const result = await fn();
      await log(200, result);
      return result;
    } catch (e) {
      const err = e instanceof HasadError ? e : new HasadError('UNAVAILABLE', String(e));
      const status = { NOT_FOUND: 404, INVALID_STATE: 409, REJECTED: 422, UNAVAILABLE: 503 }[err.code];
      await log(status, { error: err.message });
      throw err;
    }
  }

  private async row(id: string): Promise<WithdrawalRow> {
    const [w] = await this.db.select().from(mockWithdrawals).where(eq(mockWithdrawals.id, id));
    if (!w) throw new HasadError('NOT_FOUND', `Withdrawal ${id} not found`);
    return w;
  }

  private async load(id: string): Promise<HasadWithdrawal> {
    const [r] = await this.db
      .select()
      .from(mockWithdrawals)
      .innerJoin(mockCustomers, eq(mockCustomers.id, mockWithdrawals.customerId))
      .where(eq(mockWithdrawals.id, id));
    if (!r) throw new HasadError('NOT_FOUND', `Withdrawal ${id} not found`);
    return this.toDto(r.withdrawals, r.customers);
  }

  private assertStatus(w: WithdrawalRow, allowed: HasadExternalStatus[]) {
    if (!allowed.includes(w.status as HasadExternalStatus)) {
      throw new HasadError('INVALID_STATE', `Withdrawal ${w.id} is ${w.status}`);
    }
  }

  private async setStatus(id: string, status: HasadExternalStatus) {
    await this.db.update(mockWithdrawals).set({ status, updatedAt: new Date() }).where(eq(mockWithdrawals.id, id));
    return this.load(id);
  }

  private customerDto(c: CustomerRow) {
    return {
      customerId: c.id,
      fullName: c.fullName,
      fullNameAr: c.fullNameAr ?? undefined,
      phone: c.phone ?? undefined,
      nationalIdMasked: c.nationalIdMasked ?? undefined,
    };
  }

  private toDto(w: WithdrawalRow, c: CustomerRow): HasadWithdrawal {
    return {
      withdrawalId: w.id,
      customer: this.customerDto(c),
      entitlement: { weightGrams: grams(w.weightMg), karat: w.karat },
      branchCode: w.branchCode,
      status: w.status as HasadExternalStatus,
      pickupCode: w.pickupCode ?? undefined,
      requestedAt: w.requestedAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
      completion: (w.completion as HasadCompletion | null) ?? undefined,
      cancellation: (w.cancellation as HasadWithdrawal['cancellation'] | null) ?? undefined,
    };
  }
}

function summarize(response: unknown): unknown {
  if (Array.isArray(response)) return { count: response.length };
  return response ?? null;
}

export { toMg as gramsStringToMg };
